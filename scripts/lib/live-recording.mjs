/** Read-only capture policy. Pure helpers are tested without fabricating a recording. */
import assert from 'node:assert/strict';
import { digest } from '../../server/lib/fixtures.mjs';
import { evidenceExport, operationActive } from '../../public/workflow-state.js';
import { verifyLiveRun } from './verify-live-run.mjs';

export const MAX_VIDEO_SECONDS = 180;
export const CAPTURE_DEADLINE_MS = 170_000;
export const ACTION_TIMEOUT_MS = 10_000;

export function recordingTarget(value = 'http://127.0.0.1:3000') {
  let url;
  try { url = new URL(value); } catch { throw new Error('LIVE_BASE_URL must be a loopback HTTP origin.'); }
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
  'Use the authorized live server on loopback, without credentials, paths, or query parameters.');
  return url.origin;
}

export function allowedCaptureRequest(url, method, origin) {
  if (method !== 'GET') return false;
  try { return new URL(url).origin === origin; } catch { return false; }
}

export function recordingEvidence(state, options = {}) {
  assert.ok(!operationActive(state), 'Wait for the active server operation to finish before recording.');
  assert.ok(!(state.reingestJobs || []).some(j => ['queued', 'pending', 'running', 'processing'].includes(j.status)),
    'Wait for active re-ingest jobs to finish before recording.');
  const proof = verifyLiveRun(state, options);
  const exported = evidenceExport(state);
  verifyLiveRun(exported, { versionId: proof.version.id });
  // Connectivity timestamps may refresh while we inspect an immutable run.
  const { exportedAt, readiness, operation, ...stableEvidence } = exported;
  return { proof, exported, fingerprint: digest(stableEvidence) };
}

export function assertVideoDuration(seconds) {
  assert.ok(Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_VIDEO_SECONDS,
    'The captured video must have a verified duration greater than zero and at most 180 seconds.');
  return seconds;
}

export function srtTime(seconds) {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

export function liveStoryboard(proof) {
  return [
    { id: 'live-overview', seconds: 10, text: 'ShowOnce — a recorded genuine live experiment.\nThis film inspects completed provider results; it does not imply fresh inference.' },
    { id: 'positive', seconds: 10, text: 'Real VAST corpus footage: the human-reviewed positive TRAIN example.\nThe event definition is based on visible evidence.' },
    { id: 'negative', seconds: 10, text: 'The hard-negative TRAIN example establishes the boundary.\nIts label was explicitly reviewed, separately from model predictions.' },
    { id: 'rule', seconds: 12, text: `W&B generated this explicit version from TRAIN observations.\nModel: ${proof.summary.wandbModel}` },
    { id: 'evaluation', seconds: 12, text: `${proof.summary.holdoutCount} human-reviewed HOLDOUT clips, separated by parent video.\n${proof.summary.holdoutPreviouslyEvaluated ? 'This reused set is a regression comparison, not unseen validation.' : 'This is a tiny illustrative evaluation, not production accuracy.'}` },
    { id: 'holdout-evidence', seconds: 10, text: 'Inspect the real holdout footage and stored Cosmos decision.\nExpected human labels were not sent in the prediction prompt.' },
    { id: 'ledger', seconds: 10, text: 'The published rule produced an evidence-linked live replay record.\nThe ledger preserves its exact version and decision.' },
    { id: 'replay-video', seconds: 12, text: 'Actual replay footage and its original evidence interval.\nThe result retains the published rule snapshot.' },
    { id: 'receipt', seconds: 12, text: 'Provider receipt: model, response ID when returned, timestamp, and video hash.\nThese are application receipts, not cryptographic provider attestations.' },
    { id: 'audit', seconds: 10, text: 'The audit trail preserves genuine retrieval, rule generation, and evaluation.\nNo synthetic fixture result is used in this recording.' },
    { id: 'providers', seconds: 9, text: 'VAST supplies indexed evidence. Cosmos observes video. W&B generates the rule.\nCredentials stay on the server; no operational alert was dispatched.' },
    { id: 'closing', seconds: 8, text: 'Teach the event. Test its boundary. Keep the proof.\nA real small-scale experiment, with explicit limits.' },
  ];
}
