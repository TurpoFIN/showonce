/** Authored consistency-test evidence only. No provider service or real footage. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyLiveRun } from '../scripts/lib/verify-live-run.mjs';
import { computeMetrics, digest, holdoutDigest } from '../server/lib/fixtures.mjs';

function make() {
  const eventName = 'Unit test event';
  const receipt = provider => ({ provider, model: 'test-only-model', receivedAt: '2026-10-02T19:00:00Z' });
  const clips = [['t1', 'TRAIN', true], ['t2', 'TRAIN', false], ['h1', 'HOLDOUT', true], ['h2', 'HOLDOUT', false], ['r1', 'REPLAY', null]]
    .map(([id, split, label]) => ({ id, split, label, mode: 'live', source: 'vast-index',
      originalVideo: `s3://unit-test/${id}`, labelSource: 'human-reviewed', reviewed: true,
      labelEventName: eventName, contentDigest: digest(id), duration: 12, videoUrl: `/api/media/${id}` }));
  const observation = (clip, predicted) => ({
    receipt: { ...receipt('nvidia-cosmos'), videoContentDigest: clip.contentDigest, reportedDecision: predicted ?? null, temporalAbstention: false },
    evidence: { clipId: clip.id, contentDigest: clip.contentDigest, url: `${clip.videoUrl}#t=1,4`, startSec: 1, endSec: 4 },
  });
  const train = clips.filter(c => c.split === 'TRAIN');
  const held = clips.filter(c => c.split === 'HOLDOUT');
  const rule = { definition: 'An observable unit-test event occurs.', include: ['Visible action'], exclude: ['No visible action'], thresholds: { minDurationSec: 0 } };
  const version = { id: 'v1', mode: 'live', source: 'cosmos+wandb-live', status: 'published', publicationScope: 'local-replay-only', eventName,
    rule, ruleDigest: digest(rule), holdoutDigest: holdoutDigest(held), evaluationId: 'e1', trainingClipIds: train.map(c => c.id),
    generationReceipt: { ...receipt('wandb-inference'), trainingVideoContentDigests: train.map(c => c.contentDigest) },
    trainingEvidence: train.map(c => ({ clipId: c.id, split: 'TRAIN', label: c.label, labelSource: c.labelSource,
      labelEventName: eventName, contentDigest: c.contentDigest, ...observation(c) })) };
  const results = held.map(c => ({ clipId: c.id, correct: true, expected: c.label, predicted: c.label,
    source: 'nvidia-cosmos-live', expectedSource: 'human-reviewed', ...observation(c, c.label) }));
  return { clips, versions: [version], liveHoldout: { clipIds: held.map(c => c.id), parentVideoIds: held.map(c => c.originalVideo), digest: version.holdoutDigest },
    evaluations: [{ id: 'e1', versionId: 'v1', mode: 'live', source: 'nvidia-cosmos-live', status: 'completed',
      ruleDigest: version.ruleDigest, holdoutDigest: version.holdoutDigest, metrics: computeMetrics(results), results }],
    ledger: [{ id: 'event-1', clipId: 'r1', versionId: 'v1', eventName, decision: 'detected', source: 'nvidia-cosmos-live',
      ruleDigest: version.ruleDigest, ruleSnapshot: structuredClone(rule), ...observation(clips.at(-1), true) }],
    audit: [{ action: 'vast.search', source: 'vast-index' }] };
}

const refuses = mutation => { const state = make(); mutation(state); assert.throws(() => verifyLiveRun(state)); };
test('live-recording gate accepts internally consistent mocked receipts (not actual provider verification)', () => {
  const proof = verifyLiveRun(make());
  assert.equal(proof.summary.holdoutCount, 2);
  assert.equal(proof.summary.replayCount, 1);
});
test('live-recording gate refuses fixtures, missing receipts and wrong human-review intent', () => {
  for (const mutation of [
    s => { s.browserLocal = true; },
    s => { s.clips[2].labelSource = 'ai-proposed'; },
    s => { s.clips[2].reviewed = false; },
    s => { s.clips[2].labelEventName = 'Different event'; },
    s => { s.versions[0].trainingEvidence[0].labelEventName = 'Different event'; },
    s => { s.versions[0].generationReceipt = null; },
    s => { s.clips[2].originalVideo = s.clips[0].originalVideo; },
  ]) refuses(mutation);
});
test('live-recording gate recomputes rule bytes, frozen membership, labels and complete evaluation metrics', () => {
  for (const mutation of [
    s => { s.versions[0].rule.definition = 'Changed but still using the saved hash'; },
    s => { s.liveHoldout = null; },
    s => { s.liveHoldout.clipIds.pop(); },
    s => { s.liveHoldout.clipIds[1] = s.liveHoldout.clipIds[0]; },
    s => { s.liveHoldout.parentVideoIds.pop(); },
    s => { s.liveHoldout.digest = 'a'.repeat(64); },
    s => { s.clips[2].label = false; },
    s => { s.clips[2].contentDigest = 'a'.repeat(64); },
    s => { s.evaluations[0].metrics.correct = 999; },
    s => { s.evaluations[0].metrics.falsePositives = 1; },
    s => { s.evaluations[0].results.pop(); },
    s => { s.evaluations[0].results[1] = structuredClone(s.evaluations[0].results[0]); },
    s => { s.evaluations[0].results[0].expected = false; },
    s => { s.evaluations[0].results[0].predicted = false; },
    s => { s.evaluations[0].results[0].predicted = 'true'; },
  ]) refuses(mutation);
});
test('live-recording gate links every TRAIN observation and provider receipt to the consumed evidence', () => {
  for (const mutation of [
    s => { s.versions[0].trainingEvidence.pop(); },
    s => { s.versions[0].trainingEvidence[1] = structuredClone(s.versions[0].trainingEvidence[0]); },
    s => { s.versions[0].trainingEvidence[0].label = false; },
    s => { s.versions[0].trainingEvidence[0].receipt.videoContentDigest = 'a'.repeat(64); },
    s => { s.versions[0].generationReceipt.trainingVideoContentDigests.pop(); },
    s => { s.evaluations[0].results[0].receipt.videoContentDigest = 'a'.repeat(64); },
    s => { s.evaluations[0].results[0].evidence.clipId = 'h2'; },
    s => { s.evaluations[0].results[0].evidence.contentDigest = 'a'.repeat(64); },
    s => { s.evaluations[0].results[0].evidence.url = '/api/media/another-clip'; },
    s => { s.evaluations[0].results[0].evidence.endSec = 100; },
    s => { s.evaluations[0].results[0].receipt.reportedDecision = false; },
    s => { s.evaluations[0].results[0].receipt.temporalAbstention = true; },
  ]) refuses(mutation);
});
test('live-recording gate rejects replay leakage, duplicate events and corrupt snapshots or decisions', () => {
  for (const mutation of [
    s => { s.clips[4].originalVideo = s.clips[0].originalVideo; },
    s => { s.clips[4].originalVideo = s.clips[2].originalVideo; },
    s => { s.clips[4].split = 'TRAIN'; },
    s => { s.clips[4].label = true; },
    s => { s.ledger.push({ ...s.ledger[0], id: 'event-2' }); },
    s => { s.ledger[0].ruleSnapshot.definition = 'Changed snapshot'; },
    s => { s.ledger[0].receipt.reportedDecision = false; },
    s => { s.ledger[0].source = 'synthetic-fixture'; },
    s => { s.ledger[0].evidence.contentDigest = 'a'.repeat(64); },
    s => { s.ledger[0].eventName = 'Another event'; },
  ]) refuses(mutation);
});
test('live-recording gate enforces temporal abstention even if all saved decisions agree', () => {
  const state = make();
  const version = state.versions[0];
  version.rule.thresholds.minDurationSec = 8;
  version.ruleDigest = digest(version.rule);
  state.evaluations[0].ruleDigest = version.ruleDigest;
  state.ledger[0].ruleDigest = version.ruleDigest;
  state.ledger[0].ruleSnapshot = structuredClone(version.rule);
  assert.throws(() => verifyLiveRun(state), /duration and abstention disagree/);
});
