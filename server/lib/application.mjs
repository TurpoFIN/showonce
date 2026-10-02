import { createHash } from 'node:crypto';
import { fixtures, DEMO_WARNING, LIVE_WARNING, FIXTURE_SOURCE, baselineRule, correctedRule, fixtureDecision, computeMetrics, holdoutDigest, digest } from './fixtures.mjs';
import { assert, AppError } from './errors.mjs';
import { addAudit, initialState } from './store.mjs';
import { SOURCES } from './integrations.mjs';

function requiredMode(mode) { assert(mode === 'demo' || mode === 'live', 400, 'INVALID_MODE', 'Choose demo or live mode explicitly.'); return mode; }
function requireVersion(state, id) {
  const version = state.versions.find(v => v.id === id);
  assert(version, 404, 'VERSION_NOT_FOUND', 'Event version was not found.'); return version;
}
function trainingSelection(all, ids) {
  assert(Array.isArray(ids) && ids.length > 0 && ids.length <= 30 && new Set(ids).size === ids.length, 400, 'INVALID_TRAINING_SELECTION', 'Select one or more distinct TRAIN clips.');
  return ids.map(id => {
    const clip = all.find(c => c.id === id);
    assert(clip?.split === 'TRAIN', 400, 'HOLDOUT_LEAKAGE_BLOCKED', 'Only TRAIN clips may be used for rule generation or correction. HOLDOUT and REPLAY are excluded.');
    assert(typeof clip.label === 'boolean', 400, 'LABEL_REQUIRED', 'Every training clip needs an explicit label.');
    if (clip.mode === 'live') assert(clip.labelSource === 'human-reviewed' && clip.reviewed === true, 400, 'HUMAN_REVIEW_REQUIRED', 'Live training labels must be explicitly reviewed and confirmed by a person. AI proposals cannot train a release-eligible rule.');
    return clip;
  });
}
function labelDistribution(clips) { return clips.some(c => c.label === true) && clips.some(c => c.label === false); }
export class Application {
  constructor({ store, integrations }) { this.store = store; this.integrations = integrations; this.busy = false; }
  state() {
    const s = structuredClone(this.store.data);
    const clips = [...structuredClone(fixtures), ...s.liveClips.map(({ segmentSource, ...clip }) => clip)];
    return { app: { name: 'ShowOnce', schemaVersion: 1, description: 'Teach an observable video event. Evaluate a frozen holdout. Publish a versioned rule.' },
      mode: s.mode, fixtures: { clips: structuredClone(fixtures), holdoutDigest: holdoutDigest(fixtures), source: FIXTURE_SOURCE, warning: DEMO_WARNING },
      clips, versions: s.versions, evaluations: s.evaluations, ledger: s.ledger, audit: s.audit,
      liveHoldout: s.liveHoldout ? { digest: s.liveHoldout.digest, frozenAt: s.liveHoldout.frozenAt, clipIds: s.liveHoldout.clips.map(c => c.id), parentVideoIds: s.liveHoldout.parentVideoIds } : null,
      reingestJobs: s.reingestJobs, readiness: this.integrations.readiness(), busy: this.busy };
  }
  async mutate(action) {
    assert(!this.busy, 409, 'OPERATION_IN_PROGRESS', 'Another operation is running. Wait for it to finish before trying again.');
    this.busy = true;
    try {
      const result = await this.store.transaction(action);
      this.busy = false;
      return { state: this.state(), result };
    } finally { this.busy = false; }
  }
  async generate({ mode, eventName = 'Roadway stop', trainingClipIds } = {}) {
    requiredMode(mode);
    assert(typeof eventName === 'string' && eventName.trim().length >= 2 && eventName.trim().length <= 100, 400, 'INVALID_EVENT_NAME', 'Event name must contain 2 to 100 characters.');
    return this.mutate(async s => {
      const all = mode === 'demo' ? fixtures : s.liveClips;
      const ids = trainingClipIds ?? (mode === 'demo' ? ['train-positive-01'] : all.filter(c => c.split === 'TRAIN').map(c => c.id));
      const train = trainingSelection(all, ids);
      assert(train.some(c => c.label), 400, 'POSITIVE_REQUIRED', 'Choose at least one positive training example.');
      let rule = correctedRule(baselineRule(), train); let trace = null; let trainingEvidence = null;
      if (mode === 'live') {
        assert(labelDistribution(train), 400, 'NEGATIVE_REQUIRED', 'Live generation requires human-labeled positive and hard-negative TRAIN examples.');
        this.requireLiveHoldout(s);
        const observations = await this.trainingObservations(train, eventName);
        trainingEvidence = observations;
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
  requireLiveHoldout(s) {
    if (s.liveHoldout) return;
    const holdout = s.liveClips.filter(c => c.split === 'HOLDOUT');
    assert(holdout.every(c => c.labelSource === 'human-reviewed' && c.reviewed === true), 400, 'HUMAN_REVIEW_REQUIRED', 'Every HOLDOUT label must be explicitly reviewed and confirmed by a person before freezing.');
    assert(holdout.length >= 2 && labelDistribution(holdout), 400, 'HOLDOUT_REQUIRED', 'Before generating, label at least two HOLDOUT clips including a positive and negative, from parent videos absent from TRAIN.');
    const trainingParents = new Set(s.liveClips.filter(c => c.split === 'TRAIN').map(c => c.originalVideo));
    assert(!holdout.some(c => trainingParents.has(c.originalVideo)), 400, 'PARENT_VIDEO_LEAKAGE', 'A parent video cannot appear in both TRAIN and HOLDOUT.');
  }
  async freezeHoldout(s) {
    if (s.liveHoldout) return;
    const clips = structuredClone(s.liveClips.filter(c => c.split === 'HOLDOUT'));
    for (const clip of clips) {
      // Read-only bytes are hashed, never sent to the rule generator.
      const bytes = await this.integrations.media(clip);
      clip.contentDigest = createHash('sha256').update(bytes).digest('hex');
    }
    s.liveHoldout = { clips, digest: holdoutDigest(clips), frozenAt: new Date().toISOString(), parentVideoIds: [...new Set(clips.map(c => c.originalVideo))] };
    addAudit(s, 'holdout.frozen', { clipIds: clips.map(c => c.id), digest: s.liveHoldout.digest, splitKey: 'original_video', labels: 'human-reviewed-attestation' }, 'live-human-labels');
  }
  async trainingObservations(clips, eventName) {
    const observations = [];
    for (const clip of clips) {
      const observation = await this.integrations.observe(clip, null, { eventName });
      observations.push({ clipId: clip.id, split: 'TRAIN', label: clip.label, labelSource: clip.labelSource, observation: observation.summary, contentDigest: observation.contentDigest ?? null, receipt: observation.receipt ?? null, evidence: observation.evidence });
    }
    return observations;
  }
  async evaluate({ mode, versionId } = {}) {
    requiredMode(mode);
    return this.mutate(async s => {
      const version = requireVersion(s, versionId);
      assert(version.mode === mode, 400, 'MODE_MISMATCH', 'Choose the same mode used to generate this rule.');
      assert(version.status !== 'published', 409, 'PUBLISHED_IMMUTABLE', 'Published versions are immutable. Create a new corrected version to evaluate changes.');
      const existing = s.evaluations.find(e => e.versionId === version.id);
      if (existing) return existing;
      const holdout = mode === 'demo' ? fixtures.filter(c => c.split === 'HOLDOUT') : s.liveHoldout?.clips;
      assert(holdout?.length > 0, 409, 'HOLDOUT_REQUIRED', 'A frozen holdout is required.');
      if (mode === 'live') assert(holdout.every(c => c.labelSource === 'human-reviewed' && c.reviewed === true), 409, 'HUMAN_REVIEW_REQUIRED', 'Every frozen holdout label must carry an explicit independent human-review attestation.');
      assert(holdoutDigest(holdout) === version.holdoutDigest, 409, 'HOLDOUT_CHANGED', 'Holdout digest mismatch. Evaluation stopped to protect the frozen split.');
      const results = [];
      for (const clip of holdout) {
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
    return this.mutate(async s => {
      const previous = requireVersion(s, versionId);
      assert(previous.mode === mode, 400, 'MODE_MISMATCH', 'Choose the same mode as the source rule.');
      assert(previous.evaluationId, 409, 'EVALUATE_FIRST', 'Evaluate the source version before creating a correction.');
      const all = mode === 'demo' ? fixtures : s.liveClips;
      const selected = trainingSelection(all, trainingClipIds);
      assert(selected.some(c => c.label === false), 400, 'HARD_NEGATIVE_REQUIRED', 'Select a human-labeled hard-negative TRAIN example.');
      const allIds = [...new Set([...previous.trainingClipIds, ...trainingClipIds])];
      const train = trainingSelection(all, allIds);
      let rule = mode === 'demo' ? correctedRule(previous.rule, selected) : null; let trainingEvidence = null; let generationReceipt = null;
      if (mode === 'live') {
        const observations = await this.trainingObservations(train, previous.eventName);
        trainingEvidence = observations;
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
    return this.mutate(s => {
      const version = requireVersion(s, versionId);
      if (version.status === 'published') return version;
      const evaluation = s.evaluations.find(e => e.id === version.evaluationId && e.versionId === version.id);
      assert(version.status === 'evaluated' && evaluation?.status === 'completed', 409, 'EVALUATION_REQUIRED', 'Evaluate this exact version on the frozen holdout before publishing.');
      assert(evaluation.ruleDigest === version.ruleDigest && evaluation.holdoutDigest === version.holdoutDigest, 409, 'EVALUATION_MISMATCH', 'The evaluation does not match this exact rule and holdout.');
      assert(evaluation.metrics.unknown === 0, 409, 'UNRESOLVED_ABSTENTIONS', 'Resolve uncertain holdout observations before publishing. No deployment was made.');
      assert(evaluation.metrics.total > 0 && evaluation.metrics.correct === evaluation.metrics.total && evaluation.metrics.falsePositives === 0 && evaluation.metrics.falseNegatives === 0,
        409, 'HOLDOUT_CHECK_FAILED', 'Every labeled holdout case must agree before publication. Correct the rule using TRAIN examples, then evaluate the new version.');
      version.status = 'published'; version.publishedAt = new Date().toISOString();
      version.publicationScope = version.mode === 'demo' ? 'local-demo-only' : 'local-replay-only';
      addAudit(s, 'version.published', { versionId, scope: version.publicationScope, evaluationId: evaluation.id, sourceLabel: version.source }, version.source);
      return version;
    });
  }
  async replay({ versionId } = {}) {
    return this.mutate(async s => {
      const version = requireVersion(s, versionId);
      assert(version.status === 'published', 409, 'PUBLISH_REQUIRED', 'Publish an evaluated version before replaying it.');
      const clips = (version.mode === 'demo' ? fixtures : s.liveClips).filter(c => c.split === 'REPLAY');
      assert(clips.length > 0, 409, 'REPLAY_CLIPS_REQUIRED', 'Assign a new indexed video to REPLAY first.');
      const created = []; let deduplicated = 0;
      for (const clip of clips) {
        if (s.ledger.some(e => e.versionId === version.id && e.clipId === clip.id)) { deduplicated++; continue; }
        const decision = version.mode === 'demo' ? fixtureDecision(clip, version.rule) : await this.integrations.observe(clip, version.rule);
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
    return this.mutate(async s => {
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
  async label({ clipId, split, label, labelSource, reviewed = false } = {}) {
    assert(['TRAIN', 'HOLDOUT', 'REPLAY'].includes(split), 400, 'INVALID_SPLIT', 'Choose TRAIN, HOLDOUT or REPLAY.');
    assert(split === 'REPLAY' || typeof label === 'boolean', 400, 'INVALID_LABEL', 'A positive or negative label is required.');
    assert(['human-reviewed', 'ai-proposed'].includes(labelSource), 400, 'LABEL_PROVENANCE_REQUIRED', 'Provide labelSource as human-reviewed or ai-proposed explicitly.');
    assert(labelSource !== 'human-reviewed' || reviewed === true, 400, 'HUMAN_REVIEW_REQUIRED', 'Human-reviewed labels require reviewed:true after independent clip review.');
    return this.mutate(s => {
      const clip = s.liveClips.find(c => c.id === clipId);
      assert(clip, 404, 'CLIP_NOT_FOUND', 'Discover a VAST clip before assigning a label.');
      assert(!s.liveHoldout || split !== 'HOLDOUT', 409, 'HOLDOUT_FROZEN', 'HOLDOUT membership and labels are frozen after rule generation. Reset the live experiment to build a new split.');
      assert(!s.liveHoldout?.parentVideoIds.includes(clip.originalVideo), 409, 'HOLDOUT_FROZEN', 'This entire parent video belongs to the frozen HOLDOUT and cannot be changed or used for training.');
      assert(!s.versions.some(v => v.trainingClipIds.includes(clipId)) && !s.ledger.some(e => e.clipId === clipId), 409, 'CLIP_LOCKED', 'This clip is already used by a version or replay and cannot be relabeled.');
      assert(!s.liveClips.some(c => c.id !== clipId && c.originalVideo === clip.originalVideo && c.split !== 'UNASSIGNED' && c.split !== split),
        409, 'PARENT_VIDEO_LEAKAGE', 'All segments from the same parent video must stay in one split.');
      clip.split = split; clip.label = split === 'REPLAY' ? null : label; clip.labelSource = labelSource; clip.reviewed = labelSource === 'human-reviewed' && reviewed === true; clip.reviewAttestation = clip.reviewed ? 'explicit-user-attestation' : null; clip.labeledAt = new Date().toISOString();
      addAudit(s, 'clip.labeled', { clipId, split, label: clip.label, labelSource, reviewed: clip.reviewed, splitKey: 'original_video' }, labelSource);
      return { clipId, split, label: clip.label, labelSource, reviewed: clip.reviewed };
    });
  }
  async check() {
    const readiness = await this.integrations.check();
    return { state: this.state(), result: readiness };
  }
  async reingest({ clipId, customPrompt, confirm } = {}) {
    assert(confirm === true, 400, 'CONFIRMATION_REQUIRED', 'Confirm re-ingest of the selected existing parent video, one chunk, the exact custom prompt, and preserved original metadata.');
    return this.mutate(async s => {
      const clip = s.liveClips.find(c => c.id === clipId);
      assert(clip, 404, 'CLIP_NOT_FOUND', 'Select a previously discovered indexed video.');
      assert(clip.split === 'TRAIN', 409, 'TRAIN_ONLY_REINGEST', 'Re-ingest is restricted to an explicitly selected TRAIN video.');
      assert(!s.liveHoldout?.parentVideoIds.includes(clip.originalVideo), 409, 'HOLDOUT_FROZEN', 'A frozen HOLDOUT video cannot be re-ingested.');
      assert(!s.reingestJobs.some(j => j.originalVideo === clip.originalVideo && !['completed', 'failed', 'cancelled'].includes(j.status)),
        409, 'REINGEST_IN_PROGRESS', 'A re-ingest request for this video is already pending. Check its status before starting another.');
      const result = await this.integrations.reingest(clip, customPrompt);
      const job = { ...result, clipId, originalVideo: clip.originalVideo, chunkCount: 1, customPrompt, metadataMode: 'preserve-original',
        status: 'queued', startedAt: new Date().toISOString(), source: 'vast-dataengine', contract: SOURCES.reingest };
      s.reingestJobs.push(job);
      addAudit(s, 'vast.reingest_started', { jobId: job.jobId, clipId, chunkCount: 1, promptLength: [...customPrompt].length }, 'vast-dataengine');
      return job;
    });
  }
  async reingestStatus(jobId) {
    assert(/^[A-Za-z0-9_-]+$/.test(jobId), 400, 'INVALID_JOB_ID', 'Invalid re-ingest job ID.');
    return this.mutate(async s => {
      const job = s.reingestJobs.find(j => j.jobId === jobId);
      assert(job, 404, 'JOB_NOT_FOUND', 'This job was not started by this workspace.');
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
    return this.mutate(s => {
      const keep = initialState();
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
    const replayDigest = s.ledger.find(e => e.clipId === id)?.evidence?.contentDigest;
    return this.integrations.media(replayDigest ? { ...clip, contentDigest: replayDigest } : clip);
  }
}
