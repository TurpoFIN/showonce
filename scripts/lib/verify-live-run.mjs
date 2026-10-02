/** Validate application evidence before recording. This is consistency checking,
 * not cryptographic attestation of an external provider. Never treats fixture
 * results or mere connectivity status as a completed live run.
 */
import assert from 'node:assert/strict';
import { computeMetrics, digest, holdoutDigest } from '../../server/lib/fixtures.mjs';

function receipt(value, provider) {
  assert.equal(value?.provider, provider, `Missing ${provider} success receipt`);
  assert.ok(typeof value.model === 'string' && value.model.length > 0, 'Receipt needs model identifier');
  assert.ok(Number.isFinite(Date.parse(value.receivedAt)), 'Receipt needs receive timestamp');
  return value;
}
function uniqueIds(values, message) {
  assert.ok(Array.isArray(values) && values.length > 0 && values.every(v => typeof v === 'string' && v), message);
  assert.equal(new Set(values).size, values.length, message);
  return values;
}
function sameIds(actual, expected, message) {
  uniqueIds(actual, message);
  uniqueIds(expected, message);
  assert.deepEqual([...actual].sort(), [...expected].sort(), message);
}
function corpusClip(clip, split, eventName) {
  assert.ok(clip, 'Referenced corpus clip is missing');
  assert.equal(clip.mode, 'live');
  assert.equal(clip.source, 'vast-index');
  assert.equal(clip.split, split, `Referenced clip must belong to ${split}`);
  assert.match(clip.originalVideo || '', /^s3:\/\/[^\s?#]+$/, 'Original parent identity missing');
  assert.match(clip.contentDigest || '', /^[a-f0-9]{64}$/, 'Corpus clip is missing its pinned video hash');
  if (split !== 'REPLAY') {
    assert.equal(clip.labelSource, 'human-reviewed');
    assert.equal(clip.reviewed, true);
    assert.equal(clip.labelEventName, eventName, 'Human review must match this exact event criterion');
    assert.equal(typeof clip.label, 'boolean');
  } else assert.equal(clip.label, null, 'REPLAY must not carry ground-truth labels');
  return clip;
}
function videoEvidence(value, clip, { predicted, rule } = {}) {
  const proof = receipt(value.receipt, 'nvidia-cosmos');
  assert.equal(proof.videoContentDigest, clip.contentDigest, 'Receipt does not match pinned video bytes');
  const evidence = value.evidence;
  assert.equal(evidence?.clipId, clip.id, 'Evidence points to another clip');
  assert.equal(evidence?.contentDigest, clip.contentDigest, 'Evidence does not match pinned video bytes');
  assert.ok(typeof evidence.url === 'string' && evidence.url.split('#')[0] === clip.videoUrl, 'Evidence URL does not identify its corpus clip');
  assert.ok(Number.isFinite(evidence.startSec) && Number.isFinite(evidence.endSec) && evidence.startSec >= 0 && evidence.endSec >= evidence.startSec,
    'Evidence interval is invalid');
  if (Number.isFinite(clip.duration)) assert.ok(evidence.endSec <= clip.duration + 0.1, 'Evidence lies outside the clip');
  if (value.model != null) assert.equal(value.model, proof.model, 'Recorded model differs from its receipt');
  if (predicted !== undefined) {
    assert.ok([true, false, null].includes(proof.reportedDecision), 'Receipt lacks its original model decision');
    assert.equal(typeof proof.temporalAbstention, 'boolean', 'Receipt lacks temporal-abstention status');
    assert.equal(predicted, proof.temporalAbstention ? null : proof.reportedDecision, 'Decision differs from its receipt');
    const insufficient = proof.reportedDecision === true && rule.thresholds.minDurationSec > 0 &&
      evidence.endSec - evidence.startSec + 0.05 < rule.thresholds.minDurationSec;
    assert.equal(proof.temporalAbstention, insufficient, 'Evidence duration and abstention disagree');
  }
}

export function verifyLiveRun(state, { versionId } = {}) {
  assert.notEqual(state.browserLocal, true, 'Browser-local fixture state cannot be a live demo');
  const version = versionId ? state.versions?.find(v => v.id === versionId) :
    state.versions?.filter(v => v.mode === 'live' && v.status === 'published').at(-1);
  if (versionId) assert.ok(version, 'Requested live version was not found; no alternative version was selected');
  assert.ok(version, 'No published live rule is available');
  assert.equal(version.mode, 'live');
  assert.equal(version.source, 'cosmos+wandb-live');
  assert.equal(version.status, 'published');
  assert.equal(version.publicationScope, 'local-replay-only');
  assert.ok(version.rule && typeof version.rule === 'object' && !Array.isArray(version.rule), 'Published rule is missing');
  assert.equal(digest(version.rule), version.ruleDigest, 'Published rule bytes differ from their recorded digest');
  assert.ok(Number.isFinite(version.rule.thresholds?.minDurationSec) && version.rule.thresholds.minDurationSec >= 0,
    'Rule has no valid minimum duration');
  receipt(version.generationReceipt, 'wandb-inference');

  const clips = state.clips || [];
  uniqueIds(clips.map(c => c?.id), 'Corpus clip IDs must be unique');
  const byId = new Map(clips.map(c => [c.id, c]));
  uniqueIds(version.trainingClipIds, 'TRAIN selection must contain unique clips');
  const train = version.trainingClipIds.map(id => corpusClip(byId.get(id), 'TRAIN', version.eventName));
  assert.ok(train.some(c => c.label === true) && train.some(c => c.label === false), 'TRAIN needs positive and negative evidence');
  sameIds(version.trainingEvidence?.map(t => t?.clipId), version.trainingClipIds, 'TRAIN observations must cover the selected clips exactly once');
  for (const observation of version.trainingEvidence) {
    const clip = byId.get(observation.clipId);
    assert.equal(observation.split, 'TRAIN');
    assert.equal(observation.labelSource, 'human-reviewed');
    assert.equal(observation.labelEventName, version.eventName, 'TRAIN observation has a different event criterion');
    assert.equal(observation.label, clip.label, 'TRAIN observation has a different human label');
    assert.equal(observation.contentDigest, clip.contentDigest, 'TRAIN observation has different video bytes');
    videoEvidence(observation, clip);
  }
  assert.deepEqual([...(version.generationReceipt.trainingVideoContentDigests || [])].sort(),
    version.trainingEvidence.map(t => t.contentDigest).sort(), 'W&B receipt does not cover the consumed TRAIN video bytes');

  const frozen = state.liveHoldout;
  assert.ok(frozen, 'Frozen HOLDOUT is missing');
  uniqueIds(frozen.clipIds, 'Frozen HOLDOUT IDs must be unique');
  const held = frozen.clipIds.map(id => corpusClip(byId.get(id), 'HOLDOUT', version.eventName));
  assert.ok(held.some(c => c.label === true) && held.some(c => c.label === false), 'HOLDOUT needs positive and negative evidence');
  assert.equal(frozen.digest, version.holdoutDigest, 'Frozen HOLDOUT digest differs from this version');
  assert.equal(holdoutDigest(held), version.holdoutDigest, 'Frozen HOLDOUT labels, membership, parents or video bytes changed');
  sameIds(frozen.parentVideoIds, [...new Set(held.map(c => c.originalVideo))], 'Frozen HOLDOUT parent list is inconsistent');
  const trainParents = new Set(train.map(c => c.originalVideo));
  assert.ok(held.every(c => !trainParents.has(c.originalVideo)), 'Parent video leaks from TRAIN into HOLDOUT');

  const evaluation = state.evaluations?.find(e => e.id === version.evaluationId && e.versionId === version.id);
  assert.ok(evaluation, 'Published version lacks its pinned evaluation');
  assert.equal(evaluation.mode, 'live');
  assert.equal(evaluation.source, 'nvidia-cosmos-live');
  assert.equal(evaluation.status, 'completed');
  assert.equal(evaluation.ruleDigest, version.ruleDigest);
  assert.equal(evaluation.holdoutDigest, version.holdoutDigest);
  sameIds(evaluation.results?.map(r => r?.clipId), frozen.clipIds, 'Evaluation must cover every frozen HOLDOUT clip exactly once');
  for (const row of evaluation.results) {
    const clip = byId.get(row.clipId);
    assert.equal(row.source, 'nvidia-cosmos-live');
    assert.equal(row.expectedSource, 'human-reviewed');
    assert.equal(row.expected, clip.label, 'Evaluation expected label differs from human review');
    assert.ok([true, false, null].includes(row.predicted), 'Evaluation contains an invalid prediction');
    assert.equal(row.correct, row.predicted === clip.label, 'Evaluation agreement differs from its decisions');
    videoEvidence(row, clip, { predicted: row.predicted, rule: version.rule });
  }
  const metrics = computeMetrics(evaluation.results);
  for (const [key, value] of Object.entries(metrics)) assert.equal(evaluation.metrics?.[key], value, `Saved ${key} differs from recomputed evaluation`);
  assert.equal(metrics.correct, metrics.total, 'Every HOLDOUT prediction must agree before recording');
  assert.equal(metrics.unknown, 0, 'Unresolved abstentions block recording');

  const events = state.ledger?.filter(e => e.versionId === version.id) || [];
  assert.ok(events.length, 'No genuine live replay receipt exists');
  uniqueIds(events.map(e => e.id), 'Replay event IDs must be unique');
  uniqueIds(events.map(e => e.clipId), 'Replay must be deduplicated for this version');
  assert.ok(events.some(e => e.decision === 'detected'), 'No detected live replay event is available');
  const usedParents = new Set([...trainParents, ...frozen.parentVideoIds]);
  for (const event of events) {
    const clip = corpusClip(byId.get(event.clipId), 'REPLAY', version.eventName);
    assert.ok(!usedParents.has(clip.originalVideo), 'Replay parent video leaks from TRAIN or HOLDOUT');
    assert.equal(event.source, 'nvidia-cosmos-live');
    assert.equal(event.eventName, version.eventName);
    assert.equal(event.ruleDigest, version.ruleDigest);
    assert.equal(digest(event.ruleSnapshot), version.ruleDigest, 'Replay rule snapshot differs from the published rule');
    assert.ok(['detected', 'not_detected', 'uncertain'].includes(event.decision), 'Replay has an invalid decision');
    const predicted = event.decision === 'uncertain' ? null : event.decision === 'detected';
    videoEvidence(event, clip, { predicted, rule: version.rule });
  }
  assert.ok(state.audit?.some(a => a.action === 'vast.search' && a.source === 'vast-index'), 'No VAST retrieval audit exists');
  return { version, evaluation, events, train, held, summary: {
    versionId: version.id, eventName: version.eventName, trainingCount: train.length, holdoutCount: held.length,
    replayCount: events.length, wandbModel: version.generationReceipt.model,
    cosmosModels: [...new Set(evaluation.results.map(r => r.receipt.model))],
    holdoutPreviouslyEvaluated: !!evaluation.previouslyEvaluatedHoldout,
  } };
}
