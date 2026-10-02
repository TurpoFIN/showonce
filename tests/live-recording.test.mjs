import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ACTION_TIMEOUT_MS, CAPTURE_DEADLINE_MS, MAX_VIDEO_SECONDS, allowedCaptureRequest,
  assertVideoDuration, liveStoryboard, recordingEvidence, recordingTarget, srtTime,
} from '../scripts/lib/live-recording.mjs';

test('capture accepts loopback origins and refuses remote, credentialed, or proxy destinations', () => {
  assert.equal(recordingTarget(), 'http://127.0.0.1:3000');
  assert.equal(recordingTarget('http://localhost:3001/'), 'http://localhost:3001');
  for (const url of ['https://example.com', 'http://127.0.0.1.evil.test', 'http://user:secret@localhost:3000',
    'http://localhost:3000/?token=secret', 'http://localhost:3000/#live', 'http://localhost:3000/proxy/3000/', 'invalid']) {
    assert.throws(() => recordingTarget(url));
  }
});

test('capture policy allows local GET only, including ranged media, and blocks all mutations and external traffic', () => {
  const origin = recordingTarget();
  for (const pathname of ['/', '/api/state', '/api/media/clip-a', '/app.js']) {
    assert.equal(allowedCaptureRequest(`${origin}${pathname}`, 'GET', origin), true);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    assert.equal(allowedCaptureRequest(`${origin}/api/replay`, method, origin), false);
  }
  assert.equal(allowedCaptureRequest('https://provider.example/video', 'GET', origin), false);
  assert.equal(allowedCaptureRequest('http://127.0.0.1:3001/api/state', 'GET', origin), false);
  assert.equal(allowedCaptureRequest('data:text/html,test', 'GET', origin), false);
});

test('capture refuses in-flight state and cannot treat a fixture workspace as live evidence', () => {
  for (const state of [{ busy: true }, { operation: { status: 'running' } }, { operation: { status: 'cancelling' } }]) {
    assert.throws(() => recordingEvidence(state), /active server operation/);
  }
  assert.throws(() => recordingEvidence({ reingestJobs: [{ status: 'running' }] }), /re-ingest/);
  assert.throws(() => recordingEvidence({ browserLocal: true }), /fixture state/);
});

test('live storyboard leaves time for navigation and keeps genuine-run limitations visible', () => {
  const proof = { summary: { wandbModel: 'test-model-id', holdoutCount: 4, holdoutPreviouslyEvaluated: false } };
  const scenes = liveStoryboard(proof);
  assert.equal(new Set(scenes.map(scene => scene.id)).size, scenes.length);
  assert.equal(scenes.reduce((sum, scene) => sum + scene.seconds, 0), 125);
  assert.ok(CAPTURE_DEADLINE_MS / 1000 < MAX_VIDEO_SECONDS);
  assert.ok(ACTION_TIMEOUT_MS <= 10_000);
  assert.ok(scenes.some(scene => scene.text.includes('does not imply fresh inference')));
  assert.ok(scenes.some(scene => scene.text.includes('not production accuracy')));
  assert.ok(scenes.some(scene => scene.text.includes('application receipts')));
  proof.summary.holdoutPreviouslyEvaluated = true;
  assert.ok(liveStoryboard(proof).some(scene => scene.text.includes('regression comparison')));
});

test('actual video duration must be finite, positive, and within the contest limit', () => {
  assert.equal(assertVideoDuration(179.99), 179.99);
  assert.equal(assertVideoDuration(180), 180);
  for (const value of [0, -1, 180.001, Infinity, NaN]) assert.throws(() => assertVideoDuration(value));
  assert.equal(srtTime(65.123), '00:01:05,123');
});

test('recorder verifies stable evidence and real duration before assigning the completed filename', async () => {
  const source = await readFile(new URL('../scripts/record-live.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("serviceWorkers: 'block'"));
  assert.ok(source.includes('final.fingerprint, initial.fingerprint'));
  assert.ok(source.includes('failed-capture.webm'));
  assert.ok(source.indexOf('assertVideoDuration(Number(stdout.trim()))') < source.indexOf("'showonce-live.webm'"));
  assert.ok(source.includes('mkdtemp('));
  assert.ok(!/method:\s*['"]POST['"]/.test(source));
});
