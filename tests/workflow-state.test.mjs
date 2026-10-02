import test from 'node:test';
import assert from 'node:assert/strict';
import {operationActive,versionContext,evidenceExport} from '../public/workflow-state.js';
test('reloaded UI recognizes running and cancelling server work',()=>{
 assert.equal(operationActive({busy:true}),true);assert.equal(operationActive({operation:{status:'running'}}),true);assert.equal(operationActive({operation:{status:'cancelling'}}),true);assert.equal(operationActive({busy:false,operation:{status:'succeeded'}}),false);
});
test('mixed-mode version inspection selects its mode and training evidence together',()=>{
 const s={versions:[{id:'demo',mode:'demo',trainingClipIds:['train-positive-01']},{id:'live',mode:'live',trainingClipIds:['live-a']}],clips:[]};
 assert.deepEqual(versionContext(s,'live'),{versionId:'live',mode:'live',clipId:'live-a'});assert.equal(versionContext(s,'missing'),null);
});
test('export retains human labels, parent splits, receipts and frozen holdout while removing credential fields',()=>{
 const out=evidenceExport({app:{schemaVersion:1},mode:'live',clips:[{id:'c1',split:'HOLDOUT',label:false,labelSource:'human-reviewed',reviewed:true,originalVideo:'s3://corpus/original.mp4',segmentSource:'private-internal-segment',password:'secret'}],liveHoldout:{digest:'digest',parentVideoIds:['s3://corpus/original.mp4']},versions:[{id:'v1',generationReceipt:{provider:'wandb-inference',responseId:'r1',usage:{promptTokens:42},apiKey:'secret'}}],readiness:[{id:'wandb',status:'ready',authorization:'secret'}]},{exportedAt:'2026-10-02T00:00:00Z'});
 assert.equal(out.clips[0].labelSource,'human-reviewed');assert.equal(out.liveHoldout.digest,'digest');assert.equal(out.versions[0].generationReceipt.usage.promptTokens,42);assert.ok(!JSON.stringify(out).includes('secret'));assert.equal(out.clips[0].segmentSource,undefined);
});

import {versionComparison} from '../public/workflow-state.js';
import {createBrowserDemo} from '../public/browser-demo.js';
import {readFile} from 'node:fs/promises';
const fixtures=JSON.parse(await readFile(new URL('../public/fixture-data.json',import.meta.url),'utf8'));
test('teaching proof compares saved parent decisions on distinct holdout clips',async()=>{
 const request=createBrowserDemo(fixtures,{storage:null});
 let out=await request('/api/generate');const baseline=out.result;
 await request('/api/evaluate',{versionId:baseline.id});
 out=await request('/api/correct',{versionId:baseline.id,trainingClipIds:['train-negative-01','train-negative-02']});
 const corrected=out.result;
 const pending=versionComparison(out.state,corrected.id);
 assert.equal(pending.comparable,false);assert.equal(pending.evaluation,undefined);assert.equal(pending.decisions.length,0);
 assert.deepEqual(pending.addedTrainingClipIds,['train-negative-01','train-negative-02']);
 assert.ok(pending.changes.some(c=>c.label==='Maximum motion (m/s)'&&c.before===1.5&&c.after===.5));
 assert.ok(pending.changes.some(c=>c.label==='Travel lane required'&&c.before===false&&c.after===true));
 out=await request('/api/evaluate',{versionId:corrected.id});
 const proof=versionComparison(out.state,corrected.id);
 assert.equal(proof.comparable,true);assert.equal(proof.decisions.length,6);
 assert.deepEqual(proof.changedDecisions.map(d=>d.clipId),['holdout-02','holdout-03']);
 assert.ok(proof.changedDecisions.every(d=>d.before.predicted===true&&d.after.predicted===false&&d.after.correct));
 assert.ok(proof.changedDecisions.every(d=>!corrected.trainingClipIds.includes(d.clipId)));
 assert.equal(proof.previousEvaluation.metrics.correct,4);assert.equal(proof.evaluation.metrics.correct,6);
 assert.equal(versionComparison(out.state,baseline.id),null);
 const unsafe=structuredClone(out.state);unsafe.evaluations.at(-1).holdoutDigest='changed';
 assert.equal(versionComparison(unsafe,corrected.id).comparable,false);
 const changedLabels=structuredClone(out.state);changedLabels.evaluations.at(-1).results[0].expected=false;
 assert.equal(versionComparison(changedLabels,corrected.id).comparable,false);
 const changedMembership=structuredClone(out.state);changedMembership.evaluations.at(-1).results.pop();
 assert.equal(versionComparison(changedMembership,corrected.id).comparable,false);
});
test('a partial lesson shows the remaining false alert instead of claiming all fixed',async()=>{
 const request=createBrowserDemo(fixtures,{storage:null});
 let out=await request('/api/generate');const first=out.result.id;await request('/api/evaluate',{versionId:first});
 out=await request('/api/correct',{versionId:first,trainingClipIds:['train-negative-01']});const second=out.result.id;
 out=await request('/api/evaluate',{versionId:second});const proof=versionComparison(out.state,second);
 assert.equal(proof.changedDecisions.length,1);assert.equal(proof.evaluation.metrics.correct,5);
 assert.equal(proof.evaluation.metrics.falsePositives,1);
 assert.ok(!proof.changes.some(c=>c.label==='Maximum motion (m/s)'));
 await assert.rejects(request('/api/publish',{versionId:second}),/Every labeled holdout/);
});
test('live comparisons never cross execution modes or invent unseen results',()=>{
 const state={versions:[{id:'d',mode:'demo'},{id:'l',mode:'live',parentId:'d'}],evaluations:[]};
 assert.equal(versionComparison(state,'l'),null);
 assert.equal(versionComparison(state,'missing'),null);
});

import {replayOutcome} from '../public/workflow-state.js';
test('replay presentation uses persisted returned records for the exact requested version',()=>{
 const state={clips:[{id:'clip-a',split:'REPLAY'}],ledger:[
  {id:'old-event',versionId:'v1',clipId:'clip-a',decision:'detected'},
  {id:'event-2',versionId:'v2',clipId:'clip-a',decision:'not_detected'},
 ]};
 const outcome=replayOutcome(state,{events:[{id:'event-2',decision:'detected'}]},'v2');
 assert.equal(outcome.detected.length,0);assert.equal(outcome.notDetected.length,1);
 assert.equal(outcome.events[0].decision,'not_detected','The saved record wins over unsaved response content');
 assert.equal(replayOutcome(state,{events:[{id:'old-event'}]},'v2'),null);
 assert.equal(replayOutcome(state,{events:[{id:'invented'}]},'v2'),null);
 assert.equal(replayOutcome(state,{events:[]},'v2'),null);
});
test('deduplicated replay reopens the original record without crossing rule versions',()=>{
 const state={clips:[{id:'replay',split:'REPLAY'},{id:'train',split:'TRAIN'}],ledger:[
  {id:'first',versionId:'v1',clipId:'replay',decision:'detected'},
  {id:'training',versionId:'v1',clipId:'train',decision:'detected'},
  {id:'newer',versionId:'v2',clipId:'replay',decision:'detected'},
 ]};
 const outcome=replayOutcome(state,{events:[],deduplicated:1},'v1');
 assert.equal(outcome.reused,true);assert.equal(outcome.events.length,1);assert.equal(outcome.events[0].id,'first');
});
test('negative and uncertain replay outcomes never become detected alerts',()=>{
 const state={ledger:[{id:'no',versionId:'v',decision:'not_detected'},{id:'unknown',versionId:'v',decision:'uncertain'},{id:'absent',versionId:'v'}]};
 const result=replayOutcome(state,{events:state.ledger},'v');
 assert.equal(result.detected.length,0);assert.equal(result.notDetected.length,1);assert.equal(result.needsReview.length,2);
});
test('mixed replay batches include preserved detections alongside newly recorded negatives',()=>{
 const state={clips:[{id:'existing',split:'REPLAY'},{id:'new',split:'REPLAY'}],ledger:[
  {id:'original',versionId:'v1',clipId:'existing',decision:'detected'},
  {id:'new-record',versionId:'v1',clipId:'new',decision:'not_detected'},
  {id:'other-version',versionId:'v2',clipId:'existing',decision:'detected'},
 ]};
 const outcome=replayOutcome(state,{events:[{id:'new-record'}],deduplicated:1},'v1');
 assert.equal(outcome.reused,false);assert.equal(outcome.detected.length,1);assert.equal(outcome.notDetected.length,1);
 assert.deepEqual(outcome.events.map(event=>event.id),['original','new-record']);
});
