#!/usr/bin/env node
/** Read-only capture of an ALREADY COMPLETED genuine live run.
 * Never resets, labels, generates, evaluates, publishes, replays, or runs inference.
 * Requires Playwright/Chromium and ffprobe; see docs/LIVE_RUN.md.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import {
  ACTION_TIMEOUT_MS, CAPTURE_DEADLINE_MS, allowedCaptureRequest, assertVideoDuration,
  liveStoryboard, recordingEvidence, recordingTarget, srtTime,
} from './lib/live-recording.mjs';

const exec = promisify(execFile);
const baseURL = recordingTarget(process.env.LIVE_BASE_URL);
async function readState() {
  const response = await fetch(`${baseURL}/api/state`, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  assert.ok(response.ok, 'Live server is unavailable.');
  return response.json();
}
const initial = recordingEvidence(await readState(), { versionId: process.env.LIVE_VERSION_ID });
const { proof } = initial;
// Verify recording tools before opening a browser or creating a capture directory.
try { await exec('ffprobe', ['-version'], { timeout: 10_000 }); }
catch { throw new Error('ffprobe is required to verify the actual video duration. Install FFmpeg in the authorized recording environment first.'); }
const { chromium } = await import('playwright');
const root = path.resolve(process.env.LIVE_RECORD_DIR || 'artifacts/live');
await mkdir(root, { recursive: true });
const out = await mkdtemp(path.join(root, 'capture-'));
const browser = await chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
});
let context, page, video, captureClosed = false, deadline;
const errors = [], blockedRequests = [], failedResponses = [], captions = [];
let started, sequence = 0;
const elapsed = () => (Date.now() - started) / 1000;
try {
  context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, deviceScaleFactor: 1,
    recordVideo: { dir: out, size: { width: 1440, height: 1080 } }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  context.setDefaultTimeout(ACTION_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(ACTION_TIMEOUT_MS);
  await context.route('**/*', route => {
    const request = route.request();
    if (allowedCaptureRequest(request.url(), request.method(), baseURL)) return route.continue();
    blockedRequests.push({ method: request.method(), reason: 'Only GET requests to the local server are permitted.' });
    return route.abort('blockedbyclient');
  });
  page = await context.newPage();
  video = page.video();
  started = Date.now();
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.status() >= 400) failedResponses.push({ status: response.status(), resourceType: response.request().resourceType() });
  });
  async function showClip(id) {
    // Attribute equality avoids inserting server IDs into CSS selector syntax.
    await page.locator('[data-action="clip"]').evaluateAll((buttons, clipId) => {
      const button = buttons.find(button => button.dataset.id === clipId);
      if (!button) throw new Error('The verified clip is unavailable in the current UI.');
      button.click();
    }, id);
    const player = page.locator('#evidence-video');
    await player.scrollIntoViewIfNeeded();
    await player.evaluate(video => { video.currentTime = 0; return video.play(); });
    await page.waitForFunction(() => {
      const video = document.querySelector('#evidence-video');
      return video && !video.error && video.currentTime > 0.15;
    });
  }
  async function selectRecordedId(action, id) {
    await page.locator(`[data-action="${action}"]`).evaluateAll((buttons, recordedId) => {
      const button = buttons.find(button => button.dataset.id === recordedId);
      if (!button) throw new Error('The verified record is unavailable in the current UI.');
      button.click();
    }, id);
  }
  const setupScene = {
    'live-overview': async () => {
      await page.goto(`${baseURL}/?mode=live`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Teach your cameras what matters.' }).waitFor();
      // Direct live startup does not open the connections dialog.
      await page.getByRole('button', { name: 'Rule versions', exact: true }).click();
      await selectRecordedId('select-version', proof.version.id);
      assert.match(await page.locator('.fixture-tag').innerText(), /^LIVE CORPUS/);
    },
    positive: () => showClip(proof.train.find(clip => clip.label).id),
    negative: () => showClip(proof.train.find(clip => !clip.label).id),
    rule: () => page.locator('.rule-body').scrollIntoViewIfNeeded(),
    evaluation: () => page.locator('.scoreboard').scrollIntoViewIfNeeded(),
    'holdout-evidence': () => showClip(proof.held[0].id),
    ledger: () => page.locator('#ledger').scrollIntoViewIfNeeded(),
    'replay-video': async () => {
      await selectRecordedId('evidence', proof.events.find(event => event.decision === 'detected').id);
      await page.locator('.evidence-detail video').evaluate(video => video.play());
      await page.waitForFunction(() => {
        const video = document.querySelector('.evidence-detail video');
        return video && !video.error && video.readyState >= 2 && !video.paused;
      });
    },
    receipt: () => page.locator('.provider-receipt').scrollIntoViewIfNeeded(),
    audit: async () => {
      await page.getByRole('button', { name: 'Back to studio', exact: true }).click();
      await page.getByRole('button', { name: 'Activity log', exact: true }).click();
    },
    providers: async () => {
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await page.getByRole('button', { name: 'Provider connections', exact: true }).click();
    },
    closing: async () => {
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await page.locator('#workspace').scrollIntoViewIfNeeded();
    },
  };
  const capture = async () => {
    for (const scene of liveStoryboard(proof)) {
      await setupScene[scene.id]();
      const start = elapsed();
      await page.screenshot({ path: path.join(out, `${String(++sequence).padStart(2, '0')}-${scene.id}.png`), fullPage: false });
      await page.waitForTimeout(scene.seconds * 1000);
      captions.push({ start, end: elapsed(), text: scene.text });
    }
    assert.deepEqual(errors, [], 'Browser JavaScript errors block release.');
    assert.deepEqual(blockedRequests, [], 'A non-read-only or external request was attempted during capture.');
    assert.deepEqual(failedResponses, [], 'A resource failed to load during capture.');
    const final = recordingEvidence(await readState(), { versionId: proof.version.id });
    assert.equal(final.fingerprint, initial.fingerprint, 'The experiment changed during capture; record again after it is stable.');
  };
  await Promise.race([
    capture(),
    new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Capture exceeded its 170-second budget. No completed video will be published.')), CAPTURE_DEADLINE_MS); }),
  ]);
  clearTimeout(deadline);
  await context.close();
  captureClosed = true;
  const rawPath = await video.path();
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', rawPath], { timeout: 10_000 });
  const durationSeconds = assertVideoDuration(Number(stdout.trim()));
  await writeFile(path.join(out, 'live-captions.srt'), captions.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text}\n`).join('\n'));
  await writeFile(path.join(out, 'live-evidence.json'), JSON.stringify(initial.exported, null, 2));
  await writeFile(path.join(out, 'live-recording-report.json'), JSON.stringify({ status: 'passed', recordedAt: new Date().toISOString(),
    captureType: 'inspection-of-completed-live-run', newInferenceDuringCapture: false, ...proof.summary,
    durationSeconds, maxDurationSeconds: 180, javascriptErrors: errors, blockedRequests, failedResponses,
    evidenceFingerprint: initial.fingerprint,
    disclaimer: 'Application receipts were validated for internal consistency. This is not independent cryptographic attestation or production accuracy.',
  }, null, 2));
  await rename(rawPath, path.join(out, 'showonce-live.webm'));
  console.log(`Completed read-only capture (${durationSeconds.toFixed(1)}s): ${out}`);
  console.log('Inspect the video and private evidence before sharing. No new inference ran during capture.');
} catch (error) {
  clearTimeout(deadline);
  if (page && !captureClosed) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
  if (context && !captureClosed) await context.close().catch(() => {});
  captureClosed = true;
  if (video) await video.path().then(file => rename(file, path.join(out, 'failed-capture.webm'))).catch(() => {});
  // A filesystem failure during finalization must not leave a success label.
  await rename(path.join(out, 'showonce-live.webm'), path.join(out, 'failed-capture.webm')).catch(() => {});
  await rm(path.join(out, 'live-recording-report.json'), { force: true }).catch(() => {});
  await writeFile(path.join(out, 'failure.json'), JSON.stringify({ status: 'failed', message: error.message, javascriptErrors: errors,
    blockedRequests, failedResponses, disclaimer: 'Incomplete capture. Do not use as a completed live recording.' }, null, 2));
  throw error;
} finally {
  clearTimeout(deadline);
  if (context && !captureClosed) await context.close().catch(() => {});
  await browser.close();
}
