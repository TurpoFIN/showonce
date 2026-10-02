import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createBrowserDemo} from '../public/browser-demo.js';
const fixtures=JSON.parse(await readFile(new URL('../public/fixture-data.json',import.meta.url)));
const create=()=>createBrowserDemo(fixtures,{storage:{getItem:()=>null,setItem:()=>{}}});
test('browser demo completes teach/test/correct/publish/replay with explicit fixture provenance',async()=>{
 const req=create();const initial=await req('/api/state');assert.equal(initial.browserLocal,true);assert.equal(initial.readiness.filter(s=>s.status==='ready').length,0);
 const v1=(await req('/api/generate',{mode:'demo'})).result;
 const e1=(await req('/api/evaluate',{versionId:v1.id})).result;assert.equal(e1.metrics.correct,4);await assert.rejects(req('/api/publish',{versionId:v1.id}),/Every labeled/);
 const v2=(await req('/api/correct',{versionId:v1.id,trainingClipIds:['train-negative-01','train-negative-02']})).result;
 const e2=(await req('/api/evaluate',{versionId:v2.id})).result;assert.equal(e2.metrics.correct,6);assert.equal(e2.previouslyEvaluatedHoldout,true);
 await req('/api/publish',{versionId:v2.id});const replay=await req('/api/replay',{versionId:v2.id});assert.equal(replay.result.events.length,1);assert.equal(replay.result.events[0].source,'synthetic-fixture');
 const dedup=await req('/api/replay',{versionId:v2.id});assert.equal(dedup.result.deduplicated,1);assert.equal(dedup.state.ledger.length,1);
});
test('browser demo rejects leakage, untested publication and live execution',async()=>{
 const req=create();const v1=(await req('/api/generate',{mode:'demo'})).result;
 await assert.rejects(req('/api/publish',{versionId:v1.id}),/Evaluate/);
 await assert.rejects(req('/api/replay',{versionId:v1.id}),/Publish/);
 await req('/api/evaluate',{versionId:v1.id});
 await assert.rejects(req('/api/correct',{versionId:v1.id,trainingClipIds:['holdout-02']}),/Only TRAIN/);
 await assert.rejects(req('/api/generate',{mode:'live'}),/Node server/);
 await assert.rejects(req('/api/discover',{query:'test'}),/Node server/);
});
test('browser demo reset is isolated and preserves no versions or ledger',async()=>{const req=create();await req('/api/generate',{mode:'demo'});const out=await req('/api/reset',{});assert.equal(out.state.versions.length,0);assert.equal(out.state.ledger.length,0);assert.equal(out.result.externalDataChanged,false)});
