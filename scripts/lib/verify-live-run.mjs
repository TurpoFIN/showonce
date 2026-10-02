/** Validate application evidence before recording. This is consistency checking,
 * not cryptographic attestation of an external provider. Never treats fixture
 * results or mere connectivity status as a completed live run.
 */
import assert from 'node:assert/strict';
function receipt(value,provider){assert.equal(value?.provider,provider,`Missing ${provider} success receipt`);assert.ok(typeof value.model==='string'&&value.model.length>0,'Receipt needs model identifier');assert.ok(Number.isFinite(Date.parse(value.receivedAt)),'Receipt needs receive timestamp');return value}
export function verifyLiveRun(state,{versionId}={}){
 assert.equal(state.browserLocal===true,false,'Browser-local fixture state cannot be a live demo');
 const version=state.versions?.find(v=>v.id===versionId)||state.versions?.filter(v=>v.mode==='live'&&v.status==='published').at(-1);
 assert.ok(version,'No published live rule is available');assert.equal(version.mode,'live');assert.equal(version.status,'published');
 receipt(version.generationReceipt,'wandb-inference');
 assert.ok(version.trainingEvidence?.length>=2,'At least two TRAIN observations are required');
 for(const t of version.trainingEvidence){assert.equal(t.labelSource,'human-reviewed');receipt(t.receipt,'nvidia-cosmos');assert.match(t.contentDigest||'',/^[a-f0-9]{64}$/)}
 const evaluation=state.evaluations?.find(e=>e.id===version.evaluationId&&e.versionId===version.id);
 assert.ok(evaluation,'Published version lacks its pinned evaluation');assert.equal(evaluation.mode,'live');assert.equal(evaluation.source,'nvidia-cosmos-live');assert.equal(evaluation.status,'completed');
 assert.ok(evaluation.metrics.total>=2);assert.equal(evaluation.metrics.correct,evaluation.metrics.total);assert.equal(evaluation.metrics.unknown,0);assert.equal(evaluation.ruleDigest,version.ruleDigest);assert.equal(evaluation.holdoutDigest,version.holdoutDigest);
 const clips=state.clips||[];const train=version.trainingClipIds.map(id=>clips.find(c=>c.id===id));const held=evaluation.results.map(r=>clips.find(c=>c.id===r.clipId));
 for(const c of [...train,...held]){assert.ok(c,'Referenced corpus clip is missing');assert.equal(c.mode,'live');assert.equal(c.source,'vast-index');assert.equal(c.labelSource,'human-reviewed');assert.equal(c.reviewed,true);assert.ok(c.originalVideo,'Original parent identity missing')}
 assert.ok(train.some(c=>c.label===true)&&train.some(c=>c.label===false),'TRAIN needs positive and negative evidence');assert.ok(held.some(c=>c.label===true)&&held.some(c=>c.label===false),'HOLDOUT needs positive and negative evidence');
 const parents=new Set(train.map(c=>c.originalVideo));assert.ok(held.every(c=>!parents.has(c.originalVideo)),'Parent video leaks from TRAIN into HOLDOUT');
 for(const r of evaluation.results){assert.equal(r.correct,true);receipt(r.receipt,'nvidia-cosmos')}
 const events=state.ledger?.filter(e=>e.versionId===version.id&&e.source==='nvidia-cosmos-live');assert.ok(events?.length,'No genuine live replay receipt exists');assert.ok(events.some(e=>e.decision==='detected'),'No detected live replay event is available');
 for(const e of events){receipt(e.receipt,'nvidia-cosmos');assert.match(e.evidence?.contentDigest||'',/^[a-f0-9]{64}$/);assert.equal(e.ruleDigest,version.ruleDigest)}
 assert.ok(state.audit?.some(a=>a.action==='vast.search'&&a.source==='vast-index'),'No VAST retrieval audit exists');
 return {version,evaluation,events,train,held,summary:{versionId:version.id,eventName:version.eventName,trainingCount:train.length,holdoutCount:held.length,replayCount:events.length,wandbModel:version.generationReceipt.model,cosmosModels:[...new Set(evaluation.results.map(r=>r.receipt.model))],holdoutPreviouslyEvaluated:!!evaluation.previouslyEvaluatedHoldout}};
}
