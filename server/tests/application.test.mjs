import test from 'node:test';
import { createHash } from 'node:crypto';
import { AppError } from '../lib/errors.mjs';
import assert from 'node:assert/strict';
import { Application } from '../lib/application.mjs';
import { Store } from '../lib/store.mjs';
import { Integrations } from '../lib/integrations.mjs';
import { correctedRule, baselineRule, fixtures } from '../lib/fixtures.mjs';

function demo() { return new Application({ store: new Store(null), integrations: new Integrations({ env: {} }) }); }
function errorCode(code) { return e => e.code === code; }
async function firstEvaluation(app) {
  const generated = await app.generate({ mode:'demo', eventName:'Roadway stop' });
  return app.evaluate({ mode:'demo', versionId: generated.result.id });
}
test('demo loop computes real deterministic fixture agreement and publishes an evidence-linked deduplicated replay', async () => {
  const app = demo();
  const first = await firstEvaluation(app);
  assert.equal(first.result.metrics.correct, 4); assert.equal(first.result.metrics.falsePositives, 2);
  assert.equal(first.result.source, 'synthetic-fixture'); assert.match(first.result.disclaimer, /not measured model accuracy/);
  const next = await app.correct({ mode:'demo', versionId:'v1', trainingClipIds:['train-negative-01','train-negative-02'] });
  assert.equal(next.result.parentId, 'v1'); assert.equal(next.result.status, 'draft');
  const evaluated = await app.evaluate({ mode:'demo', versionId:'v2' });
  assert.equal(evaluated.result.metrics.correct, 6);
  assert.equal(evaluated.result.holdoutDigest, first.result.holdoutDigest);
  assert.equal(evaluated.result.previouslyEvaluatedHoldout, true);
  const published = await app.publish({ versionId:'v2' });
  assert.equal(published.result.publicationScope, 'local-demo-only');
  const replay = await app.replay({ versionId:'v2' });
  assert.equal(replay.result.events.length, 1);
  assert.equal(replay.result.events[0].decision, 'detected');
  assert.deepEqual(replay.result.events[0].ruleSnapshot, next.result.rule);
  assert.match(replay.result.events[0].evidence.url, /replay-01\.mp4/);
  const again = await app.replay({ versionId:'v2' });
  assert.equal(again.result.events.length, 0); assert.equal(again.result.deduplicated, 1);
  assert.equal(app.state().ledger.length, 1);
});
test('state machine blocks unpublished replay, unevaluated publication, mode mixing, and frozen-version evaluation', async () => {
  const app = demo(); await app.generate({ mode:'demo', eventName:'Roadway stop' });
  await assert.rejects(app.publish({ versionId:'v1' }), errorCode('EVALUATION_REQUIRED'));
  await assert.rejects(app.replay({ versionId:'v1' }), errorCode('PUBLISH_REQUIRED'));
  await assert.rejects(app.evaluate({ mode:'live', versionId:'v1' }), errorCode('MODE_MISMATCH'));
  await app.evaluate({ mode:'demo', versionId:'v1' });
  await assert.rejects(app.publish({ versionId:'v1' }), errorCode('HOLDOUT_CHECK_FAILED'));
  await app.correct({ mode:'demo', versionId:'v1', trainingClipIds:['train-negative-01','train-negative-02'] });
  await app.evaluate({ mode:'demo', versionId:'v2' }); await app.publish({ versionId:'v2' });
  await assert.rejects(app.evaluate({ mode:'demo', versionId:'v2' }), errorCode('PUBLISHED_IMMUTABLE'));
  assert.equal(app.state().evaluations.length, 2);
});
test('correction rejects holdout and replay clips without mutating versions', async () => {
  const app = demo(); await firstEvaluation(app);
  for (const id of ['holdout-02','replay-01','missing']) await assert.rejects(app.correct({ mode:'demo', versionId:'v1', trainingClipIds:[id] }), errorCode('HOLDOUT_LEAKAGE_BLOCKED'));
  assert.equal(app.state().versions.length, 1);
  assert.equal(app.state().versions[0].rule.thresholds.travelLaneOnly, false);
});
test('duplicate evaluation is idempotent and holdout corruption is detected', async () => {
  const app = demo(); const first = await firstEvaluation(app);
  const next = await app.evaluate({ mode:'demo', versionId:'v1' });
  assert.equal(first.result.id, next.result.id); assert.equal(app.state().evaluations.length, 1);
  await app.correct({ mode:'demo', versionId:'v1', trainingClipIds:['train-negative-01'] });
  app.store.data.versions[1].holdoutDigest = 'invalid';
  await assert.rejects(app.evaluate({ mode:'demo', versionId:'v2' }), errorCode('HOLDOUT_CHANGED'));
});
test('live mode never falls back to demo without credentials or labeled corpus', async () => {
  const app = demo();
  await assert.rejects(app.generate({ mode:'live', eventName:'Roadway stop' }), errorCode('INVALID_TRAINING_SELECTION'));
  await assert.rejects(app.discover({ query:'stopped vehicle' }), errorCode('INTEGRATION_NOT_CONFIGURED'));
  assert.equal(app.state().versions.length, 0); assert.equal(app.state().readiness.every(r => r.status === 'not_configured'), true);
});
function liveClip(id, parent) {
  return { id, mode:'live', split:'UNASSIGNED', label:null, title:id, source:'vast-index', originalVideo:parent,
    segmentSource:`s3://segments/${id}.mp4`, videoUrl:`/api/media/${id}`, duration:12,
    evidence:{clipId:id,url:`/api/media/${id}`,startSec:0,endSec:12,summary:'indexed'} };
}
function live() {
  const calls = [];
  const integrations = {
    readiness: () => [],
    media: async () => Buffer.from('test-video-bytes'),
    observe: async (clip, rule) => { calls.push({ operation:'observe', clipId:clip.id, rule }); return { predicted: clip.id.includes('positive'), summary:`Observed ${clip.id}`, contentDigest:createHash('sha256').update('test-video-bytes').digest('hex'), evidence:clip.evidence }; },
    generateRule: async payload => { calls.push({ operation:'generateRule', payload }); return { rule:correctedRule(baselineRule(), fixtures), model:'mock-contract-test', usage:{} }; },
    reingest: async () => ({ jobId:'job-1' }),
  };
  const app = new Application({ store:new Store(null), integrations });
  app.store.data.liveClips = [
    liveClip('train-positive','s3://videos/train-positive.mp4'), liveClip('train-negative','s3://videos/train-negative.mp4'),
    liveClip('holdout-positive','s3://videos/holdout-positive.mp4'), liveClip('holdout-negative','s3://videos/holdout-negative.mp4'),
    liveClip('holdout-sibling','s3://videos/holdout-positive.mp4'), liveClip('replay-positive','s3://videos/replay.mp4'),
  ];
  return {app,calls,integrations};
}
async function prepareLive(app,eventName='Roadway stop') {
  for (const [clipId,split,label] of [['train-positive','TRAIN',true],['train-negative','TRAIN',false],['holdout-positive','HOLDOUT',true],['holdout-negative','HOLDOUT',false],['replay-positive','REPLAY',null]]) await app.label({clipId,split,label,labelSource:'human-reviewed',reviewed:true,eventName});
}
test('human labels are frozen by parent video and excluded from inference prompts', async () => {
  const {app,calls} = live(); await prepareLive(app);
  await assert.rejects(app.label({clipId:'holdout-sibling',split:'TRAIN',label:false,labelSource:'human-reviewed',reviewed:true,eventName:'Roadway stop'}), errorCode('PARENT_VIDEO_LEAKAGE'));
  await app.generate({mode:'live',eventName:'Roadway stop'});
  assert.ok(app.state().liveHoldout.digest);
  const held = app.state().clips.filter(c => c.mode === 'live' && c.split === 'HOLDOUT');
  assert.ok(held.every(c => /^[a-f0-9]{64}$/.test(c.contentDigest)), 'Public evidence must retain frozen HOLDOUT video hashes');
  assert.ok(held.every(c => !('segmentSource' in c)), 'Public evidence must not disclose upstream media source fields');
  await assert.rejects(app.label({clipId:'holdout-sibling',split:'TRAIN',label:false,labelSource:'human-reviewed',reviewed:true,eventName:'Roadway stop'}), errorCode('HOLDOUT_FROZEN'));
  await assert.rejects(app.label({clipId:'holdout-negative',split:'HOLDOUT',label:true,labelSource:'human-reviewed',reviewed:true,eventName:'Roadway stop'}), errorCode('HOLDOUT_FROZEN'));
  await assert.rejects(app.reingest({clipId:'holdout-positive',customPrompt:'Describe stops',confirm:true}), errorCode('TRAIN_ONLY_REINGEST'));
  await app.evaluate({mode:'live',versionId:'v1'});
  await app.correct({mode:'live',versionId:'v1',trainingClipIds:['train-negative'],feedback:'Ignore vehicles on the shoulder; require visual stationarity.'});
  const generations = calls.filter(c => c.operation === 'generateRule');
  assert.equal(generations.length, 2);
  assert.equal(generations[1].payload.feedback, 'Ignore vehicles on the shoulder; require visual stationarity.');
  for(const call of generations) {
    assert.ok(call.payload.observations.every(o => o.split === 'TRAIN'));
    assert.ok(!JSON.stringify(call.payload).includes('holdout-'));
  }
  assert.equal(app.state().versions[1].holdoutDigest, app.state().versions[0].holdoutDigest);
});
test('live abstention is explicit and blocks publication', async () => {
  const {app,integrations} = live(); await prepareLive(app);
  await app.generate({mode:'live',eventName:'Roadway stop'});
  integrations.observe = async clip => ({predicted:null,summary:'Occluded, cannot tell',evidence:clip.evidence});
  const out = await app.evaluate({mode:'live',versionId:'v1'});
  assert.equal(out.result.metrics.unknown, 2); assert.equal(out.result.metrics.correct, 0);
  await assert.rejects(app.publish({versionId:'v1'}), errorCode('UNRESOLVED_ABSTENTIONS'));
});
test('reset clears only local state, preserving integration configuration', async () => {
  const app = demo(); await firstEvaluation(app);
  await app.reset({mode:'demo'});
  assert.equal(app.state().versions.length, 0); assert.equal(app.state().clips.length, 10);
  assert.equal(app.state().audit[0].externalDataChanged, false);
});
test('failed generation rolls back all state and a concurrent mutation is rejected', async () => {
  const {app,integrations}=live();await prepareLive(app);
  let unblock;const gate=new Promise(resolve=>{unblock=resolve;});
  integrations.generateRule=async()=>{await gate;throw new Error('upstream failed');};
  const pending=app.generate({mode:'live',eventName:'Roadway stop'});
  await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(app.reset({mode:'demo'}),errorCode('OPERATION_IN_PROGRESS'));
  unblock();await assert.rejects(pending,/upstream failed/);
  assert.equal(app.state().versions.length,0);assert.equal(app.state().liveHoldout,null);assert.equal(app.state().busy,false);
});

test('correction rejects oversized feedback before any operation', async () => {
  const app=demo();await firstEvaluation(app);
  await assert.rejects(app.correct({mode:'demo',versionId:'v1',trainingClipIds:['train-negative-01'],feedback:'a'.repeat(1001)}),errorCode('INVALID_FEEDBACK'));
  assert.equal(app.state().versions.length,1);
});
test('live publication blocks a completed evaluation with a false positive', async () => {
  const {app,integrations}=live();await prepareLive(app);
  await app.generate({mode:'live',eventName:'Roadway stop'});
  integrations.observe=async clip=>({predicted:true,summary:'Model positive decision',evidence:clip.evidence});
  const out=await app.evaluate({mode:'live',versionId:'v1'});
  assert.equal(out.result.metrics.falsePositives,1);
  await assert.rejects(app.publish({versionId:'v1'}),errorCode('HOLDOUT_CHECK_FAILED'));
  assert.equal(app.state().versions[0].status,'evaluated');
});

test('fixture speeds and evidence windows match authored video overlays', () => {
  for (const clip of fixtures) {
    assert.equal(clip.evidence.endSec-clip.evidence.startSec,clip.features.observedDurationSec);
    if (clip.scenario==='slow_traffic') {
      assert.equal(clip.features.speedMps,1.3);assert.equal(clip.features.stoppedDurationSec,0);assert.equal(clip.evidence.startSec,0);assert.equal(clip.evidence.endSec,12);
    } else if (clip.scenario==='moving') {
      assert.equal(clip.features.speedMps,4);assert.equal(clip.features.stoppedDurationSec,0);
    } else {assert.equal(clip.features.speedMps,0);}
  }
  const h4=fixtures.find(c=>c.id==='holdout-04');assert.equal(h4.evidence.startSec,3.5);assert.equal(h4.evidence.endSec,12);
  const h5=fixtures.find(c=>c.id==='holdout-05');assert.equal(h5.evidence.startSec,4);assert.equal(h5.evidence.endSec,7);
});

test('AI-proposed labels are stored distinctly and blocked until explicit human review', async () => {
  const {app}=live();
  await assert.rejects(app.label({clipId:'train-positive',split:'TRAIN',label:true}),errorCode('LABEL_PROVENANCE_REQUIRED'));
  await assert.rejects(app.label({clipId:'train-positive',split:'TRAIN',label:true,labelSource:'human-reviewed'}),errorCode('HUMAN_REVIEW_REQUIRED'));
  await prepareLive(app,'Package pickup');
  await app.label({clipId:'train-negative',split:'TRAIN',label:false,labelSource:'ai-proposed'});
  assert.equal(app.state().clips.find(c=>c.id==='train-negative').reviewed,false);
  await assert.rejects(app.generate({mode:'live',eventName:'Package pickup'}),errorCode('HUMAN_REVIEW_REQUIRED'));
  await app.label({clipId:'train-negative',split:'TRAIN',label:false,labelSource:'human-reviewed',reviewed:true,eventName:'Package pickup'});
  await app.label({clipId:'holdout-negative',split:'HOLDOUT',label:false,labelSource:'ai-proposed'});
  await assert.rejects(app.generate({mode:'live',eventName:'Package pickup'}),errorCode('HUMAN_REVIEW_REQUIRED'));
  await app.label({clipId:'holdout-negative',split:'HOLDOUT',label:false,labelSource:'human-reviewed',reviewed:true,eventName:'Package pickup'});
  const result=await app.generate({mode:'live',eventName:'Package pickup'});
  assert.equal(result.result.status,'draft');
});

test('human labels require and retain the exact event criterion; changed intent is rejected before inference',async()=>{
  const {app,calls}=live();
  await assert.rejects(app.label({clipId:'train-positive',split:'TRAIN',label:true,labelSource:'human-reviewed',reviewed:true}),errorCode('LABEL_EVENT_REQUIRED'));
  await prepareLive(app,'Package pickup');
  assert.equal(app.state().clips.find(c=>c.id==='train-positive').labelEventName,'Package pickup');
  await assert.rejects(app.generate({mode:'live',eventName:'Package repositioning'}),errorCode('LABEL_INTENT_MISMATCH'));assert.equal(calls.length,0);
  await app.label({clipId:'holdout-negative',split:'HOLDOUT',label:false,labelSource:'human-reviewed',reviewed:true,eventName:'Package repositioning'});
  await assert.rejects(app.generate({mode:'live',eventName:'Package pickup'}),errorCode('LABEL_INTENT_MISMATCH'));assert.equal(calls.length,0);
});
test('TRAIN and REPLAY clips are pinned on first consumption; later correction and cross-version replay reject changed bytes',async()=>{
  const {app,integrations,calls}=live();await prepareLive(app);
  let bytes='test-video-bytes';
  integrations.observe=async(clip,rule)=>{
    const hash=createHash('sha256').update(bytes).digest('hex');
    if(clip.contentDigest && clip.contentDigest!==hash)throw new AppError(409,'EVIDENCE_CHANGED','Pinned bytes changed');
    calls.push({operation:'observe',clipId:clip.id});
    return {predicted:clip.id.includes('positive'),summary:'Observed clip',contentDigest:hash,evidence:clip.evidence};
  };
  await app.generate({mode:'live',eventName:'Roadway stop'});await app.evaluate({mode:'live',versionId:'v1'});await app.publish({versionId:'v1'});await app.replay({versionId:'v1'});
  assert.match(app.state().clips.find(c=>c.id==='train-positive').contentDigest,/^[a-f0-9]{64}$/);
  assert.match(app.state().clips.find(c=>c.id==='replay-positive').contentDigest,/^[a-f0-9]{64}$/);
  const before=calls.filter(c=>c.operation==='generateRule').length;bytes='changed-video';
  await assert.rejects(app.correct({mode:'live',versionId:'v1',trainingClipIds:['train-negative']}),errorCode('EVIDENCE_CHANGED'));
  assert.equal(calls.filter(c=>c.operation==='generateRule').length,before);
  bytes='test-video-bytes';
  await app.correct({mode:'live',versionId:'v1',trainingClipIds:['train-negative']});
  await app.evaluate({mode:'live',versionId:'v2'});await app.publish({versionId:'v2'});
  bytes='changed-video';
  await assert.rejects(app.replay({versionId:'v2'}),errorCode('EVIDENCE_CHANGED'));
  assert.equal(app.state().ledger.length,1);
});

async function passingDemo() {
  const app = demo();
  await app.generate({mode:'demo', trainingClipIds:['train-positive-01','train-negative-01','train-negative-02']});
  await app.evaluate({mode:'demo', versionId:'v1'});
  return app;
}
test('actual rule bytes are checked before evaluation, correction, publication and replay', async () => {
  for (const action of ['evaluate','correct','publish','replay']) {
    const app = await passingDemo();
    if (action === 'replay') await app.publish({versionId:'v1'});
    app.store.data.versions[0].rule.thresholds.minDurationSec = 1;
    await assert.rejects(app[action]({mode:'demo',versionId:'v1',trainingClipIds:['train-negative-01']}), errorCode('RULE_CHANGED'));
    assert.equal(app.state().ledger.length, 0);
  }
});
test('publication recomputes scores and rejects altered, missing, duplicate or relabeled evaluation rows', async () => {
  const mutations = [
    e => { e.metrics.correct = 999; },
    e => { e.results.pop(); },
    e => { e.results[0] = null; },
    e => { e.results[1] = structuredClone(e.results[0]); },
    e => { e.results[0].expected = !e.results[0].expected; },
    e => { e.results[0].predicted = !e.results[0].predicted; },
    e => { e.results[0].predicted = 'true'; },
    e => { e.mode = 'live'; },
  ];
  for (const mutate of mutations) {
    const app = await passingDemo(); mutate(app.store.data.evaluations[0]);
    await assert.rejects(app.publish({versionId:'v1'}), e => ['EVALUATION_MISMATCH','EVALUATION_REQUIRED'].includes(e.code));
    assert.equal(app.state().versions[0].status, 'evaluated');
  }
});
test('idempotent evaluation, publication and replay still validate their saved evidence', async () => {
  for (const action of ['evaluate','publish','replay']) {
    const app = await passingDemo();
    if (action !== 'evaluate') await app.publish({versionId:'v1'});
    app.store.data.evaluations[0].results[0].correct = false;
    await assert.rejects(app[action]({mode:'demo',versionId:'v1'}), errorCode('EVALUATION_MISMATCH'));
    assert.equal(app.state().ledger.length, 0);
  }
});
test('live publication rechecks frozen membership and event review intent', async () => {
  for (const mutation of ['membership','intent']) {
    const {app}=live(); await prepareLive(app);
    await app.generate({mode:'live',eventName:'Roadway stop'}); await app.evaluate({mode:'live',versionId:'v1'});
    if (mutation === 'membership') app.store.data.liveHoldout.clips.pop();
    else app.store.data.liveHoldout.clips[0].labelEventName='Different event';
    await assert.rejects(app.publish({versionId:'v1'}), errorCode(mutation === 'membership' ? 'HOLDOUT_CHANGED' : 'LABEL_INTENT_MISMATCH'));
  }
});
