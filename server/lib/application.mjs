import { createHash, randomUUID } from 'node:crypto';
import { fixtures, DEMO_WARNING, LIVE_WARNING, FIXTURE_SOURCE, baselineRule, correctedRule, fixtureDecision, computeMetrics, holdoutDigest, digest } from './fixtures.mjs';
import { assert, AppError, publicError } from './errors.mjs';
import { runOperationContext, operationPhase, assertNotCancelled, cancellationError, CANCELLATION_MESSAGE } from './operation-context.mjs';
import { addAudit, initialState } from './store.mjs';
import { SOURCES } from './integrations.mjs';

function requiredMode(mode) { assert(mode === 'demo' || mode === 'live', 400, 'INVALID_MODE', 'Choose demo or live mode explicitly.'); return mode; }
function requireVersion(state, id) {
  const version = state.versions.find(v => v.id === id);
  assert(version, 404, 'VERSION_NOT_FOUND', 'Event version was not found.');
  assert(version.rule && typeof version.rule === 'object' && !Array.isArray(version.rule) && digest(version.rule) === version.ruleDigest, 409, 'RULE_CHANGED', 'The stored rule no longer matches its recorded digest. Restore the original evidence or create a new experiment.');
  return version;
}
function validatedEvaluation(state, version, evaluation) {
  assert(evaluation?.status === 'completed' && evaluation.versionId === version.id && evaluation.mode === version.mode,
    409, 'EVALUATION_REQUIRED', 'Evaluate this exact version on the frozen holdout before publishing.');
  const holdout = version.mode === 'demo' ? fixtures.filter(c => c.split === 'HOLDOUT') : state.liveHoldout?.clips;
  assert(holdout?.length > 0 && holdoutDigest(holdout) === version.holdoutDigest,
    409, 'HOLDOUT_CHANGED', 'The current frozen holdout no longer matches this version.');
  assert(evaluation.ruleDigest === version.ruleDigest && evaluation.holdoutDigest === version.holdoutDigest,
    409, 'EVALUATION_MISMATCH', 'The evaluation does not match this exact rule and holdout.');
  const results = evaluation.results;
  assert(Array.isArray(results) && results.length === holdout.length && new Set(results.map(r => r?.clipId)).size === holdout.length,
    409, 'EVALUATION_MISMATCH', 'Evaluation rows must cover every frozen holdout clip exactly once.');
  for (const clip of holdout) {
    const row = results.find(r => r?.clipId === clip.id);
    assert(row && typeof clip.label === 'boolean' && row.expected === clip.label &&
      [true, false, null].includes(row.predicted) && row.correct === (row.predicted === clip.label),
      409, 'EVALUATION_MISMATCH', 'Evaluation rows no longer match frozen labels and decisions.');
    if (version.mode === 'live') {
      assert(clip.labelSource === 'human-reviewed' && clip.reviewed === true && clip.labelEventName === version.eventName,
        409, 'LABEL_INTENT_MISMATCH', 'Frozen human-review labels do not match this event criterion.');
    }
  }
  const metrics = computeMetrics(results);
  assert(Object.entries(metrics).every(([key, value]) => evaluation.metrics?.[key] === value),
    409, 'EVALUATION_MISMATCH', 'Evaluation summary no longer matches its individual decisions.');
  return metrics;
}
function trainingSelection(all, ids, eventName) {
  assert(Array.isArray(ids) && ids.length > 0 && ids.length <= 30 && new Set(ids).size === ids.length, 400, 'INVALID_TRAINING_SELECTION', 'Select one or more distinct TRAIN clips.');
  return ids.map(id => {
    const clip = all.find(c => c.id === id);
    assert(clip?.split === 'TRAIN', 400, 'HOLDOUT_LEAKAGE_BLOCKED', 'Only TRAIN clips may be used for rule generation or correction. HOLDOUT and REPLAY are excluded.');
    assert(typeof clip.label === 'boolean', 400, 'LABEL_REQUIRED', 'Every training clip needs an explicit label.');
    if (clip.mode === 'live') {
      assert(clip.labelSource === 'human-reviewed' && clip.reviewed === true, 400, 'HUMAN_REVIEW_REQUIRED', 'Live training labels must be explicitly reviewed and confirmed by a person. AI proposals cannot train a release-eligible rule.');
      assert(clip.labelEventName === eventName, 400, 'LABEL_INTENT_MISMATCH', 'TRAIN labels were reviewed for a different event criterion. Re-review them for the exact event before generating or correcting.');
    }
    return clip;
  });
}
function pinObservation(clip, observation) {
  assert(typeof observation.contentDigest === 'string' && /^[a-f0-9]{64}$/.test(observation.contentDigest), 502, 'EVIDENCE_DIGEST_REQUIRED', 'A live observation must identify the exact consumed video bytes.');
  assert(!clip.contentDigest || clip.contentDigest === observation.contentDigest, 409, 'EVIDENCE_CHANGED', 'The video bytes differ from the clip first consumed by this experiment. No changed evidence was admitted.');
  if (!clip.contentDigest) { clip.contentDigest = observation.contentDigest; clip.contentPinnedAt = new Date().toISOString(); }
}
function labelDistribution(clips) { return clips.some(c => c.label === true) && clips.some(c => c.label === false); }
export class Application {
  constructor({ store, integrations }) { this.store = store; this.integrations = integrations; this.busy = false; this.operation = null; this.operationController = null; }
  state() {
    const s = structuredClone(this.store.data);
    const frozenDigests = new Map((s.liveHoldout?.clips ?? []).map(clip => [clip.id, clip.contentDigest]));
    const clips = [...structuredClone(fixtures), ...s.liveClips.map(({ segmentSource, ...clip }) =>
      frozenDigests.has(clip.id) ? { ...clip, contentDigest: frozenDigests.get(clip.id) } : clip)];
    return { app: { name: 'ShowOnce', schemaVersion: 1, description: 'Teach an observable video event. Evaluate a frozen holdout. Publish a versioned rule.' },
      mode: s.mode, fixtures: { clips: structuredClone(fixtures), holdoutDigest: holdoutDigest(fixtures), source: FIXTURE_SOURCE, warning: DEMO_WARNING },
      clips, versions: s.versions, evaluations: s.evaluations, ledger: s.ledger, audit: s.audit,
      liveHoldout: s.liveHoldout ? { digest: s.liveHoldout.digest, frozenAt: s.liveHoldout.frozenAt, clipIds: s.liveHoldout.clips.map(c => c.id), parentVideoIds: s.liveHoldout.parentVideoIds } : null,
      reingestJobs: s.reingestJobs, readiness: this.integrations.readiness(), readinessChecking: !!this.integrations.checking, busy: this.busy, operation: this.operation ? structuredClone(this.operation) : null };
  }
  async runOperation(type, action, { cancellable = true } = {}) {
    assert(!this.busy, 409, 'OPERATION_IN_PROGRESS', 'Another operation is running. Wait for it to finish before trying again.');
    const controller = new AbortController();
    const startedAt = new Date().toISOString();
    const operation = { id: `op-${randomUUID()}`, type, status: 'running', phase: 'Validating request',
      startedAt, updatedAt: startedAt, finishedAt: null, cancellable };
    this.busy = true; this.operation = operation; this.operationController = controller;
    try {
      const result = await runOperationContext({ signal: controller.signal, onPhase: phase => {
        operation.phase = phase; operation.updatedAt = new Date().toISOString();
      } }, action);
      operation.status = 'succeeded'; operation.phase = 'Completed'; operation.cancellable = false;
      operation.updatedAt = operation.finishedAt = new Date().toISOString();
      this.busy = false;
      return { state: this.state(), result };
    } catch (error) {
      const failure = controller.signal.aborted ? cancellationError() : error;
      operation.status = controller.signal.aborted ? 'cancelled' : 'failed';
      operation.phase = controller.signal.aborted ? 'Cancelled locally; upstream outcome may differ' : 'Failed';
      operation.error = publicError(failure).body.error;
      operation.updatedAt = operation.finishedAt = new Date().toISOString();
      operation.cancellable = false;
      throw failure;
    } finally {
      this.busy = false; this.operationController = null;
    }
  }
  async mutate(type, action) {
    return this.runOperation(type, () => this.store.transaction(async draft => {
      assertNotCancelled();
      const result = await action(draft);
      // No await separates this final cancellation check from disabling cancellation.
      // Once false is observable, the atomic store commit must be allowed to finish.
      assertNotCancelled();
      this.operation.cancellable = false;
      operationPhase('Saving local result');
      return result;
    }));
  }
  async cancel({ operationId } = {}) {
    assert(typeof operationId === 'string' && operationId === this.operation?.id, 409, 'STALE_OPERATION', 'The requested operation is no longer current. Refresh workspace state.');
    assert(this.busy && ['running', 'cancelling'].includes(this.operation.status), 409, 'OPERATION_NOT_RUNNING', 'This operation has already finished. Refresh workspace state.');
    if (this.operation.status === 'cancelling') return { state: this.state(), result: { operationId, status: 'cancelling', message: CANCELLATION_MESSAGE } };
    assert(this.operation.cancellable, 409, 'OPERATION_NOT_CANCELLABLE', 'This operation is committing or changes an external index and cannot be cancelled safely. Wait for its recorded outcome.');
    this.operation.status = 'cancelling'; this.operation.cancellable = false;
    this.operation.phase = 'Cancelling local request; upstream work may continue'; this.operation.updatedAt = new Date().toISOString();
    this.operationController.abort();
    return { state: this.state(), result: { operationId, status: 'cancelling', message: CANCELLATION_MESSAGE } };
  }
  async generate({ mode, eventName = 'Roadway stop', trainingClipIds } = {}) {
    requiredMode(mode);
    assert(typeof eventName === 'string' && eventName.trim().length >= 2 && eventName.trim().length <= 100, 400, 'INVALID_EVENT_NAME', 'Event name must contain 2 to 100 characters.');
    eventName = eventName.trim();
    return this.mutate('generate', async s => {
      const all = mode === 'demo' ? fixtures : s.liveClips;
      const ids = trainingClipIds ?? (mode === 'demo' ? ['train-positive-01'] : all.filter(c => c.split === 'TRAIN').map(c => c.id));
      const train = trainingSelection(all, ids, eventName);
      assert(train.some(c => c.label), 400, 'POSITIVE_REQUIRED', 'Choose at least one positive training example.');
      let rule = correctedRule(baselineRule(), train); let trace = null; let trainingEvidence = null;
      if (mode === 'live') {
        assert(labelDistribution(train), 400, 'NEGATIVE_REQUIRED', 'Live generation requires human-labeled positive and hard-negative TRAIN examples.');
        this.requireLiveHoldout(s, eventName);
        const observations = await this.trainingObservations(train, eventName);
        trainingEvidence = observations;
        operationPhase('Generating rule with W&B');
        trace = await this.integrations.generateRule({ eventName, observations });
        rule = trace.rule;
        await this.freezeHoldout(s);
        addAudit(s, 'cosmos.training_observations', { clipIds: train.map(c => c.id), datasetSplit: 'TRAIN' }, 'nvidia-cosmos');
        addAudit(s, 'wandb.generate_rule', { clipIds: train.map(c => c.id), model: trace.model, usage: trace.usage, receipt: trace.receipt ?? null, datasetSplit: 'TRAIN', holdoutSent: false }, 'wandb-inference');
      }
      const revision = ++s.counters.version;
      const version = { id: `v${revision}`, name: `v${revision}`, eventName: eventName.trim(), revision, parentId: null,
        mode, source: mode === 'demo' ? FIXTURE_SOURCE : 'cosmos+wandb-live', status: 'draft', rule, ruleDigest: digest(rule),
        createdAt: new Date().toISOString(), trainingClipIds: train.map(c => c.id), trainingEvidence, generationReceipt: trace?.receipt ?? null, evaluationId: null,
        holdoutDigest: mode === 'demo' ? holdoutDigest(fixtures) : s.liveHoldout.digest,
        disclaimer: mode === 'demo' ? DEMO_WARNING : LIVE_WARNING };
      s.versions.push(version); s.mode = mode;
      addAudit(s, 'rule.generated', { versionId: version.id, trainingClipIds: version.trainingClipIds, holdoutSent: false }, version.source);
      return version;
    });
  }
  requireLiveHoldout(s, eventName) {
    const holdout = s.liveHoldout?.clips ?? s.liveClips.filter(c => c.split === 'HOLDOUT');
    assert(holdout.every(c => c.labelSource === 'human-reviewed' && c.reviewed === true), 400, 'HUMAN_REVIEW_REQUIRED', 'Every HOLDOUT label must be explicitly reviewed and confirmed by a person before freezing.');
    assert(holdout.every(c => c.labelEventName === eventName), 400, 'LABEL_INTENT_MISMATCH', 'HOLDOUT labels were reviewed for a different event criterion. Build a separately reviewed holdout for the exact event.');
    assert(holdout.length >= 2 && labelDistribution(holdout), 400, 'HOLDOUT_REQUIRED', 'Before generating, label at least two HOLDOUT clips including a positive and negative, from parent videos absent from TRAIN.');
    const trainingParents = new Set(s.liveClips.filter(c => c.split === 'TRAIN').map(c => c.originalVideo));
    assert(!holdout.some(c => trainingParents.has(c.originalVideo)), 400, 'PARENT_VIDEO_LEAKAGE', 'A parent video cannot appear in both TRAIN and HOLDOUT.');
  }
  async freezeHoldout(s) {
    if (s.liveHoldout) return;
    const clips = structuredClone(s.liveClips.filter(c => c.split === 'HOLDOUT'));
    for (const [index, clip] of clips.entries()) {
      operationPhase(`Freezing HOLDOUT clip ${index + 1} of ${clips.length}`);
      // Read-only bytes are hashed, never sent to the rule generator.
      const bytes = await this.integrations.media(clip);
      clip.contentDigest = createHash('sha256').update(bytes).digest('hex');
    }
    s.liveHoldout = { clips, digest: holdoutDigest(clips), frozenAt: new Date().toISOString(), parentVideoIds: [...new Set(clips.map(c => c.originalVideo))] };
    addAudit(s, 'holdout.frozen', { clipIds: clips.map(c => c.id), digest: s.liveHoldout.digest, splitKey: 'original_video', labels: 'human-reviewed-attestation' }, 'live-human-labels');
  }
  async trainingObservations(clips, eventName) {
    const observations = [];
    for (const [index, clip] of clips.entries()) {
      operationPhase(`Observing TRAIN clip ${index + 1} of ${clips.length}`);
      const observation = await this.integrations.observe(clip, null, { eventName });
      pinObservation(clip, observation);
      observations.push({ clipId: clip.id, split: 'TRAIN', label: clip.label, labelSource: clip.labelSource, labelEventName: clip.labelEventName, observation: observation.summary, contentDigest: observation.contentDigest ?? null, receipt: observation.receipt ?? null, evidence: observation.evidence });
    }
    return observations;
  }
  async evaluate({ mode, versionId } = {}) {
    requiredMode(mode);
    return this.mutate('evaluate', async s => {
      const version = requireVersion(s, versionId);
      assert(version.mode === mode, 400, 'MODE_MISMATCH', 'Choose the same mode used to generate this rule.');
      assert(version.status !== 'published', 409, 'PUBLISHED_IMMUTABLE', 'Published versions are immutable. Create a new corrected version to evaluate changes.');
      const existing = s.evaluations.find(e => e.versionId === version.id);
      if (existing) { validatedEvaluation(s, version, existing); return existing; }
      const holdout = mode === 'demo' ? fixtures.filter(c => c.split === 'HOLDOUT') : s.liveHoldout?.clips;
      assert(holdout?.length > 0, 409, 'HOLDOUT_REQUIRED', 'A frozen holdout is required.');
      if (mode === 'live') {
        assert(holdout.every(c => c.labelSource === 'human-reviewed' && c.reviewed === true), 409, 'HUMAN_REVIEW_REQUIRED', 'Every frozen holdout label must carry an explicit independent human-review attestation.');
        assert(holdout.every(c => c.labelEventName === version.eventName), 409, 'LABEL_INTENT_MISMATCH', 'The frozen HOLDOUT labels do not match this rule event criterion.');
      }
      assert(holdoutDigest(holdout) === version.holdoutDigest, 409, 'HOLDOUT_CHANGED', 'Holdout digest mismatch. Evaluation stopped to protect the frozen split.');
      const results = [];
      for (const [index, clip] of holdout.entries()) {
        operationPhase(`Evaluating HOLDOUT clip ${index + 1} of ${holdout.length}`);
        // The expected label never enters a model request.
        const decision = mode === 'demo' ? fixtureDecision(clip, version.rule) : await this.integrations.observe(clip, version.rule);
        results.push({ clipId: clip.id, expected: clip.label, expectedSource: mode === 'demo' ? 'authored-fixture' : 'human-reviewed',
          predicted: decision.predicted, correct: decision.predicted === clip.label, reason: decision.reason ?? decision.summary,
          model: decision.model ?? null, receipt: decision.receipt ?? null, evidence: decision.evidence, source: mode === 'demo' ? FIXTURE_SOURCE : 'nvidia-cosmos-live' });
      }
      const evaluation = { id: `eval-${++s.counters.evaluation}`, versionId, mode, source: mode === 'demo' ? FIXTURE_SOURCE : 'nvidia-cosmos-live',
        status: 'completed', createdAt: new Date().toISOString(), holdoutDigest: version.holdoutDigest, ruleDigest: version.ruleDigest,
        metrics: computeMetrics(results), results, previouslyEvaluatedHoldout: s.evaluations.some(e => e.holdoutDigest === version.holdoutDigest),
        disclaimer: mode === 'demo' ? DEMO_WARNING : LIVE_WARNING };
      s.evaluations.push(evaluation); version.status = 'evaluated'; version.evaluationId = evaluation.id;
      addAudit(s, 'holdout.evaluated', { versionId, evaluationId: evaluation.id, holdoutDigest: version.holdoutDigest, labelsSentToModel: false }, evaluation.source);
      return evaluation;
    });
  }
  async correct({ mode, versionId, trainingClipIds, feedback = '' } = {}) {
    requiredMode(mode);
    assert(typeof feedback === 'string' && [...feedback].length <= 1000, 400, 'INVALID_FEEDBACK', 'Observable correction feedback must contain no more than 1000 characters.');
    return this.mutate('correct', async s => {
      const previous = requireVersion(s, versionId);
      assert(previous.mode === mode, 400, 'MODE_MISMATCH', 'Choose the same mode as the source rule.');
      assert(previous.evaluationId, 409, 'EVALUATE_FIRST', 'Evaluate the source version before creating a correction.');
      const all = mode === 'demo' ? fixtures : s.liveClips;
      const selected = trainingSelection(all, trainingClipIds, previous.eventName);
      assert(selected.some(c => c.label === false), 400, 'HARD_NEGATIVE_REQUIRED', 'Select a human-labeled hard-negative TRAIN example.');
      const allIds = [...new Set([...previous.trainingClipIds, ...trainingClipIds])];
      const train = trainingSelection(all, allIds, previous.eventName);
      let rule = mode === 'demo' ? correctedRule(previous.rule, selected) : null; let trainingEvidence = null; let generationReceipt = null;
      if (mode === 'live') {
        this.requireLiveHoldout(s, previous.eventName);
        const observations = await this.trainingObservations(train, previous.eventName);
        trainingEvidence = observations;
        operationPhase('Correcting rule with W&B');
        const result = await this.integrations.generateRule({ eventName: previous.eventName, observations, previousRule: previous.rule, feedback: feedback.trim() });
        rule = result.rule; generationReceipt = result.receipt ?? null;
        addAudit(s, 'wandb.train_only_correction', { model: result.model, usage: result.usage, receipt: result.receipt ?? null, trainingClipIds: allIds, holdoutSent: false, evaluationsSent: false }, 'wandb-inference');
      }
      const revision = ++s.counters.version;
      const version = { id: `v${revision}`, name: `v${revision}`, eventName: previous.eventName, revision, parentId: previous.id,
        mode, source: mode === 'demo' ? FIXTURE_SOURCE : 'cosmos+wandb-live', status: 'draft', rule, ruleDigest: digest(rule),
        createdAt: new Date().toISOString(), trainingClipIds: allIds, trainingEvidence, generationReceipt, correctionClipIds: trainingClipIds, correctionFeedback: feedback.trim(), evaluationId: null,
        holdoutDigest: previous.holdoutDigest, disclaimer: mode === 'demo' ? DEMO_WARNING : LIVE_WARNING };
      s.versions.push(version);
      addAudit(s, 'rule.corrected', { versionId: version.id, parentId: previous.id, trainingClipIds, holdoutSent: false }, version.source);
      return version;
    });
  }
  async publish({ versionId } = {}) {
    return this.mutate('publish', s => {
      const version = requireVersion(s, versionId);
      const alreadyPublished = version.status === 'published';
      const evaluation = s.evaluations.find(e => e.id === version.evaluationId && e.versionId === version.id);
      assert(['evaluated', 'published'].includes(version.status) && evaluation?.status === 'completed', 409, 'EVALUATION_REQUIRED', 'Evaluate this exact version on the frozen holdout before publishing.');
      const metrics = validatedEvaluation(s, version, evaluation);
      assert(metrics.unknown === 0, 409, 'UNRESOLVED_ABSTENTIONS', 'Resolve uncertain holdout observations before publishing. No deployment was made.');
      assert(metrics.total > 0 && metrics.correct === metrics.total && metrics.falsePositives === 0 && metrics.falseNegatives === 0,
        409, 'HOLDOUT_CHECK_FAILED', 'Every labeled holdout case must agree before publication. Correct the rule using TRAIN examples, then evaluate the new version.');
      if (alreadyPublished) return version;
      version.status = 'published'; version.publishedAt = new Date().toISOString();
      version.publicationScope = version.mode === 'demo' ? 'local-demo-only' : 'local-replay-only';
      addAudit(s, 'version.published', { versionId, scope: version.publicationScope, evaluationId: evaluation.id, sourceLabel: version.source }, version.source);
      return version;
    });
  }
  async replay({ versionId } = {}) {
    return this.mutate('replay', async s => {
      const version = requireVersion(s, versionId);
      assert(version.status === 'published', 409, 'PUBLISH_REQUIRED', 'Publish an evaluated version before replaying it.');
      const metrics = validatedEvaluation(s, version, s.evaluations.find(e => e.id === version.evaluationId));
      assert(metrics.unknown === 0 && metrics.total > 0 && metrics.correct === metrics.total, 409, 'HOLDOUT_CHECK_FAILED', 'The published version no longer has a passing complete evaluation. Replay was blocked.');
      const clips = (version.mode === 'demo' ? fixtures : s.liveClips).filter(c => c.split === 'REPLAY');
      assert(clips.length > 0, 409, 'REPLAY_CLIPS_REQUIRED', 'Assign a new indexed video to REPLAY first.');
      const created = []; let deduplicated = 0;
      for (const [index, clip] of clips.entries()) {
        operationPhase(`Replaying clip ${index + 1} of ${clips.length}`);
        if (s.ledger.some(e => e.versionId === version.id && e.clipId === clip.id)) { deduplicated++; continue; }
        const decision = version.mode === 'demo' ? fixtureDecision(clip, version.rule) : await this.integrations.observe(clip, version.rule);
        if (version.mode === 'live') pinObservation(clip, decision);
        const item = { id: `event-${++s.counters.ledger}`, versionId, clipId: clip.id, eventName: version.eventName,
          decision: decision.predicted === null ? 'uncertain' : decision.predicted ? 'detected' : 'not_detected',
          timestamp: new Date().toISOString(), source: version.mode === 'demo' ? FIXTURE_SOURCE : 'nvidia-cosmos-live',
          model: decision.model ?? null, receipt: decision.receipt ?? null, evidence: decision.evidence, ruleSnapshot: structuredClone(version.rule), ruleDigest: version.ruleDigest,
          disclaimer: version.mode === 'demo' ? DEMO_WARNING : 'Model observation, subject to human review. No operational alert was sent.' };
        s.ledger.push(item); created.push(item);
      }
      addAudit(s, 'replay.completed', { versionId, created: created.length, deduplicated }, version.source);
      return { events: created, deduplicated };
    });
  }
  async discover({ query } = {}) {
    assert(typeof query === 'string' && query.trim().length >= 3 && query.length <= 500, 400, 'INVALID_QUERY', 'Search query must contain 3 to 500 characters.');
    return this.mutate('discover', async s => {
      operationPhase('Searching the existing VAST index');
      const clips = await this.integrations.search(query.trim());
      for (const clip of clips) {
        // Never rewrite labels, a frozen clip, or an already selected parent using search results.
        const existing = s.liveClips.find(c => c.id === clip.id);
        if (!existing) s.liveClips.push(clip);
        else if (!s.liveHoldout?.parentVideoIds.includes(clip.originalVideo)) {
          existing.caption = clip.caption; existing.similarity = clip.similarity;
          existing.evidence = clip.evidence; existing.indexRefreshedAt = new Date().toISOString();
        }
      }
      const diagnostics = this.integrations.lastSearchDiagnostics ?? null;
      addAudit(s, 'vast.search', { query: query.trim(), resultCount: clips.length, diagnostics, topK: 30, llmTopN: 0 }, 'vast-index');
      return { count: clips.length, clipIds: clips.map(c => c.id), diagnostics, warnings: diagnostics && (diagnostics.unresolvedParents || diagnostics.conflictingParents) ? ['Some segments were excluded because parent-video identity could not be verified.'] : [], note: 'Search similarity is retrieval relevance, not event probability. Watch and label the clips before using them.' };
    });
  }
  async label({ clipId, split, label, labelSource, reviewed = false, eventName } = {}) {
    assert(['TRAIN', 'HOLDOUT', 'REPLAY'].includes(split), 400, 'INVALID_SPLIT', 'Choose TRAIN, HOLDOUT or REPLAY.');
    assert(split === 'REPLAY' || typeof label === 'boolean', 400, 'INVALID_LABEL', 'A positive or negative label is required.');
    assert(['human-reviewed', 'ai-proposed'].includes(labelSource), 400, 'LABEL_PROVENANCE_REQUIRED', 'Provide labelSource as human-reviewed or ai-proposed explicitly.');
    assert(labelSource !== 'human-reviewed' || reviewed === true, 400, 'HUMAN_REVIEW_REQUIRED', 'Human-reviewed labels require reviewed:true after independent clip review.');
    if (labelSource === 'human-reviewed' && split !== 'REPLAY') assert(typeof eventName === 'string' && eventName.trim().length >= 2 && eventName.trim().length <= 100, 400, 'LABEL_EVENT_REQUIRED', 'Human-reviewed TRAIN/HOLDOUT labels require the exact eventName or observable criterion, 2 to 100 characters.');
    if (eventName !== undefined) assert(typeof eventName === 'string' && eventName.trim().length >= 2 && eventName.trim().length <= 100, 400, 'INVALID_EVENT_NAME', 'Label eventName must contain 2 to 100 characters.');
    return this.mutate('label', s => {
      const clip = s.liveClips.find(c => c.id === clipId);
      assert(clip, 404, 'CLIP_NOT_FOUND', 'Discover a VAST clip before assigning a label.');
      assert(!s.liveHoldout || split !== 'HOLDOUT', 409, 'HOLDOUT_FROZEN', 'HOLDOUT membership and labels are frozen after rule generation. Reset the live experiment to build a new split.');
      assert(!s.liveHoldout?.parentVideoIds.includes(clip.originalVideo), 409, 'HOLDOUT_FROZEN', 'This entire parent video belongs to the frozen HOLDOUT and cannot be changed or used for training.');
      assert(!s.versions.some(v => v.trainingClipIds.includes(clipId)) && !s.ledger.some(e => e.clipId === clipId), 409, 'CLIP_LOCKED', 'This clip is already used by a version or replay and cannot be relabeled.');
      assert(!s.liveClips.some(c => c.id !== clipId && c.originalVideo === clip.originalVideo && c.split !== 'UNASSIGNED' && c.split !== split),
        409, 'PARENT_VIDEO_LEAKAGE', 'All segments from the same parent video must stay in one split.');
      clip.split = split; clip.label = split === 'REPLAY' ? null : label; clip.labelSource = labelSource; clip.labelEventName = eventName?.trim() ?? null; clip.reviewed = labelSource === 'human-reviewed' && reviewed === true; clip.reviewAttestation = clip.reviewed ? 'explicit-user-attestation' : null; clip.labeledAt = new Date().toISOString();
      addAudit(s, 'clip.labeled', { clipId, split, label: clip.label, labelSource, labelEventName: clip.labelEventName, reviewed: clip.reviewed, splitKey: 'original_video' }, labelSource);
      return { clipId, split, label: clip.label, labelSource, labelEventName: clip.labelEventName, reviewed: clip.reviewed };
    });
  }
  async check() {
    const readiness = await this.integrations.check();
    return { state: this.state(), result: readiness };
  }
  async reingest({ clipId, customPrompt, confirm } = {}) {
    assert(confirm === true, 400, 'CONFIRMATION_REQUIRED', 'Confirm re-ingest of the selected existing parent video, one chunk, the exact custom prompt, and preserved original metadata.');
    assert(typeof customPrompt === 'string' && customPrompt.length > 0 && [...customPrompt].length <= 800, 400, 'INVALID_PROMPT', 'Re-ingest prompt must contain 1 to 800 characters.');
    return this.runOperation('reingest', async () => {
      const attemptId = `attempt-${randomUUID()}`;
      let clip;
      operationPhase('Recording re-ingest attempt before provider submission');
      await this.store.transaction(s => {
        clip = s.liveClips.find(c => c.id === clipId);
        assert(clip, 404, 'CLIP_NOT_FOUND', 'Select a previously discovered indexed video.');
        assert(clip.split === 'TRAIN', 409, 'TRAIN_ONLY_REINGEST', 'Re-ingest is restricted to an explicitly selected TRAIN video.');
        assert(!s.liveHoldout?.parentVideoIds.includes(clip.originalVideo), 409, 'HOLDOUT_FROZEN', 'A frozen HOLDOUT video cannot be re-ingested.');
        assert(!s.reingestJobs.some(j => j.originalVideo === clip.originalVideo && !['completed', 'failed', 'cancelled', 'not_started'].includes(j.status)),
          409, 'REINGEST_IN_PROGRESS', 'A re-ingest attempt for this video is pending or its outcome is unknown. Reconcile it against the VAST dashboard before another submission.');
        clip = structuredClone(clip);
        s.reingestJobs.push({ attemptId, jobId: null, clipId, originalVideo: clip.originalVideo, chunkCount: 1, customPrompt,
          metadataMode: 'preserve-original', status: 'submitting', requiresReconciliation: true,
          startedAt: new Date().toISOString(), source: 'vast-dataengine', contract: SOURCES.reingest });
        addAudit(s, 'vast.reingest_attempt_recorded', { attemptId, clipId, chunkCount: 1, promptLength: [...customPrompt].length }, 'vast-dataengine');
      });
      operationPhase('Submitting noncancellable re-ingest request');
      let result;
      try { result = await this.integrations.reingest(clip, customPrompt); }
      catch (error) {
        const rejected = [400,401,403,404,409,422].includes(error.upstreamStatus) ||
          ['INVALID_PROMPT','INVALID_REINGEST_SOURCE','INTEGRATION_NOT_CONFIGURED','INVALID_CONFIGURATION'].includes(error.code);
        try {
          await this.store.transaction(s => {
            const attempt = s.reingestJobs.find(j => j.attemptId === attemptId);
            Object.assign(attempt, { status: rejected ? 'failed' : 'unknown', requiresReconciliation: !rejected,
              checkedAt: new Date().toISOString(), error: { code: rejected ? error.code : 'REINGEST_OUTCOME_UNKNOWN',
                message: rejected ? 'Provider submission was rejected.' : 'Provider outcome is unknown. Check the VAST dashboard before any retry.' } });
            addAudit(s, 'vast.reingest_submission_outcome', { attemptId, status: attempt.status, requiresReconciliation: attempt.requiresReconciliation }, 'vast-dataengine');
          });
        } catch {
          throw new AppError(500, 'REINGEST_TRACKING_ERROR', 'The recorded re-ingest attempt may still be running. Tracking could not be updated; verify the VAST dashboard before any retry.');
        }
        if (rejected) throw error;
        throw new AppError(502, 'REINGEST_OUTCOME_UNKNOWN', 'Re-ingest outcome is unknown and its local attempt was preserved. It may still be running. Reconcile the VAST dashboard result before any new submission; no automatic retry was made.');
      }
      operationPhase('Recording provider re-ingest job');
      try {
        return await this.store.transaction(s => {
          const attempt = s.reingestJobs.find(j => j.attemptId === attemptId);
          Object.assign(attempt, result, { status: 'queued', requiresReconciliation: false, checkedAt: new Date().toISOString() });
          addAudit(s, 'vast.reingest_started', { attemptId, jobId: attempt.jobId, clipId, chunkCount: 1 }, 'vast-dataengine');
          return structuredClone(attempt);
        });
      } catch {
        throw new AppError(500, 'REINGEST_TRACKING_ERROR', 'VAST returned a re-ingest job but local tracking could not be updated. The durable attempt remains pending. Verify the VAST dashboard before any retry.');
      }
    }, { cancellable: false });
  }
  async reconcileReingest({ attemptId, confirmedStatus, jobId, confirmed } = {}) {
    assert(confirmed === true, 400, 'CONFIRMATION_REQUIRED', 'Confirm that you checked this attempt against the VAST dashboard before reconciling it.');
    assert(typeof attemptId === 'string' && /^attempt-[A-Za-z0-9-]+$/.test(attemptId), 400, 'INVALID_ATTEMPT_ID', 'Select a recorded re-ingest attempt.');
    assert(['not_started','failed','completed','running'].includes(confirmedStatus), 400, 'INVALID_RECONCILIATION_STATUS', 'Choose the outcome confirmed in the VAST dashboard.');
    assert(confirmedStatus !== 'running' || (typeof jobId === 'string' && /^[A-Za-z0-9_-]+$/.test(jobId)), 400, 'JOB_ID_REQUIRED', 'A confirmed running job requires the exact VAST dashboard job ID.');
    if (jobId !== undefined) assert(typeof jobId === 'string' && /^[A-Za-z0-9_-]+$/.test(jobId), 400, 'INVALID_JOB_ID', 'Invalid VAST job ID.');
    return this.mutate('reconcileReingest', s => {
      operationPhase('Recording explicit dashboard reconciliation');
      const attempt = s.reingestJobs.find(j => j.attemptId === attemptId);
      assert(attempt, 404, 'ATTEMPT_NOT_FOUND', 'Re-ingest attempt was not found.');
      assert(attempt.requiresReconciliation, 409, 'RECONCILIATION_NOT_REQUIRED', 'This attempt already has a known tracked outcome.');
      if (jobId) assert(!s.reingestJobs.some(j => j.attemptId !== attemptId && j.jobId === jobId), 409, 'JOB_ALREADY_TRACKED', 'That provider job already belongs to another recorded attempt.');
      Object.assign(attempt, { status: confirmedStatus, ...(jobId ? { jobId } : {}), requiresReconciliation: false, error: null,
        reconciliation: { source: 'explicit-user-dashboard-attestation', confirmedAt: new Date().toISOString(), confirmedStatus } });
      addAudit(s, 'vast.reingest_reconciled', { attemptId, confirmedStatus, jobId: attempt.jobId }, 'human-reviewed');
      return structuredClone(attempt);
    });
  }
  async reingestStatus(jobId) {
    assert(/^[A-Za-z0-9_-]+$/.test(jobId), 400, 'INVALID_JOB_ID', 'Invalid re-ingest job ID.');
    return this.mutate('reingestStatus', async s => {
      const job = s.reingestJobs.find(j => j.jobId === jobId);
      assert(job, 404, 'JOB_NOT_FOUND', 'This job was not started by this workspace.');
      operationPhase('Checking VAST re-ingest status');
      const status = await this.integrations.reingestStatus(jobId);
      Object.assign(job, status, { checkedAt: new Date().toISOString() });
      if (job.status === 'completed') {
        // A completed job alone is not proof that the changed captions are searchable.
        job.verification = 'Re-ingest reports complete. Run discovery again and inspect the updated indexed captions.';
      }
      return job;
    });
  }
  async reset({ mode = 'demo' } = {}) {
    requiredMode(mode);
    return this.mutate('reset', s => {
      const keep = initialState();
      keep.reingestJobs = s.reingestJobs; // Durable external attempts must survive local experiment reset.
      // Reset is deliberately local. It never deletes VAST clips or cancels upstream jobs.
      Object.assign(s, keep, { mode });
      addAudit(s, 'workspace.reset', { externalDataChanged: false }, 'local');
      return { reset: true, externalDataChanged: false };
    });
  }
  async media(id) {
    const s = this.store.data;
    const clip = s.liveHoldout?.clips.find(c => c.id === id) ?? s.liveClips.find(c => c.id === id);
    assert(clip, 404, 'CLIP_NOT_FOUND', 'Clip was not discovered in this workspace.');
    const digests = new Set([clip.contentDigest, ...s.ledger.filter(e => e.clipId === id).map(e => e.evidence?.contentDigest),
      ...s.versions.flatMap(v => (v.trainingEvidence ?? []).filter(e => e.clipId === id).map(e => e.contentDigest ?? e.evidence?.contentDigest))].filter(Boolean));
    assert(digests.size <= 1, 409, 'EVIDENCE_DIGEST_CONFLICT', 'Recorded versions disagree about the TRAIN or replay video bytes. Playback is blocked rather than selecting the wrong evidence.');
    const contentDigest = [...digests][0];
    return this.integrations.media(contentDigest ? { ...clip, contentDigest } : clip);
  }
}
