import test from 'node:test';
import assert from 'node:assert/strict';
import { Application } from '../lib/application.mjs';
import { Store } from '../lib/store.mjs';
import { Integrations } from '../lib/integrations.mjs';
import { AppError } from '../lib/errors.mjs';
import { runOperationContext } from '../lib/operation-context.mjs';

const env={INGRESS_URL:'https://vast.test',VAST_API_TOKEN:'private-token'};
const response=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const pause=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function until(check) { for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setImmediate(r));}throw new Error('condition not reached'); }
const code=expected=>error=>error.code===expected;
function demo(integrations=new Integrations({env:{}}),store=new Store(null)){return new Application({store,integrations});}
function abortable(signal,gate){return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});gate?.then(resolve);});}

test('operation success and failure publish safe lifecycle metadata',async()=>{
  const app=demo();assert.equal(app.state().operation,null);
  const output=await app.generate({mode:'demo',eventName:'Roadway stop'});
  assert.equal(output.state.operation.type,'generate');assert.equal(output.state.operation.status,'succeeded');
  assert.equal(output.state.operation.cancellable,false);assert.equal(output.state.busy,false);assert.ok(output.state.operation.finishedAt);
  await assert.rejects(app.publish({versionId:'v1'}),code('EVALUATION_REQUIRED'));
  assert.equal(app.state().operation.status,'failed');assert.equal(app.state().operation.error.code,'EVALUATION_REQUIRED');
});
test('cancel aborts an in-flight provider request, rolls back state, and rejects stale operation IDs',async()=>{
  let providerSignal;
  const integration=new Integrations({env,fetchImpl:async(_url,options)=>{providerSignal=options.signal;return abortable(options.signal);}});
  const app=demo(integration);const before=JSON.stringify(app.store.data);
  const running=app.discover({query:'private query must not appear in operation status'});
  const failure=assert.rejects(running,code('OPERATION_CANCELLED'));
  await until(()=>providerSignal);
  const active=app.state().operation;assert.equal(active.type,'discover');assert.equal(active.status,'running');assert.equal(app.state().busy,true);
  assert.ok(!JSON.stringify(active).includes('private query'));
  await assert.rejects(app.cancel({operationId:'stale'}),code('STALE_OPERATION'));
  const cancel=await app.cancel({operationId:active.id});assert.equal(cancel.result.status,'cancelling');assert.match(cancel.result.message,/incur charges/);
  assert.equal(providerSignal.aborted,true);
  await failure;
  assert.equal(app.state().operation.status,'cancelled');assert.equal(app.state().busy,false);assert.equal(JSON.stringify(app.store.data),before);
  await assert.rejects(app.cancel({operationId:active.id}),code('OPERATION_NOT_RUNNING'));
});
test('cancelling an operation does not abort a separate readiness check',async()=>{
  const searchEntered=pause(),checkEntered=pause(),finishCheck=pause();let checkSignal;
  const integration=new Integrations({env,fetchImpl:async(url,options)=>{
    if(url.endsWith('/search')){searchEntered.resolve();return abortable(options.signal);}
    checkSignal=options.signal;checkEntered.resolve();await finishCheck.promise;return response({username:'test'});
  }});
  const app=demo(integration);const running=app.discover({query:'observable event'});const failed=assert.rejects(running,code('OPERATION_CANCELLED'));
  await searchEntered.promise;
  const checking=app.check();await checkEntered.promise;
  assert.equal(app.state().readinessChecking,true);assert.equal(app.state().busy,true);
  await app.cancel({operationId:app.state().operation.id});await failed;
  assert.equal(checkSignal.aborted,false);finishCheck.resolve();const check=await checking;
  assert.equal(check.result.find(r=>r.id==='vast').status,'ready');assert.equal(app.state().readinessChecking,false);
});
test('cancellation before commit rolls back even when a mock provider ignores its signal',async()=>{
  const entered=pause(),release=pause();
  const integrations={readiness:()=>[],search:async()=>{entered.resolve();await release.promise;return [{id:'new-clip'}];}};
  const app=demo(integrations);const running=app.discover({query:'observable event'});const failed=assert.rejects(running,code('OPERATION_CANCELLED'));
  await entered.promise;await app.cancel({operationId:app.state().operation.id});release.resolve();await failed;
  assert.equal(app.state().clips.some(c=>c.id==='new-clip'),false);
});
test('commit phase disables cancellation before the store writes data',async()=>{
  const entered=pause(),release=pause();
  class CommitPauseStore extends Store {
    transaction(action){return super.transaction(async draft=>{const result=await action(draft);entered.resolve();await release.promise;return result;});}
  }
  const app=demo(undefined,new CommitPauseStore(null));const running=app.generate({mode:'demo',eventName:'Roadway stop'});
  await entered.promise;
  assert.equal(app.state().operation.phase,'Saving local result');assert.equal(app.state().operation.cancellable,false);
  await assert.rejects(app.cancel({operationId:app.state().operation.id}),code('OPERATION_NOT_CANCELLABLE'));
  release.resolve();await running;assert.equal(app.state().versions.length,1);assert.equal(app.state().operation.status,'succeeded');
});
test('provider timeout is bounded, defaults to 120 seconds, and external errors remain redacted',async()=>{
  assert.equal(new Integrations({env:{}}).timeoutMs,120000);
  assert.equal(new Integrations({env:{SHOWONCE_PROVIDER_TIMEOUT_MS:'300000'}}).timeoutMs,300000);
  for(const value of ['4999','300001','bad','12.5'])assert.throws(()=>new Integrations({env:{SHOWONCE_PROVIDER_TIMEOUT_MS:value}}),code('INVALID_PROVIDER_TIMEOUT'));
  const integration=new Integrations({env,fetchImpl:async()=>{throw new Error('https://secret.example?token=private-token');}});
  await assert.rejects(integration.search('hello'),e=>e.code==='UPSTREAM_UNAVAILABLE'&&!e.message.includes('private-token')&&!e.message.includes('secret.example'));
});
test('an already cancelled context cannot issue a provider request',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  const integration=new Integrations({env,fetchImpl:async()=>{calls++;return response({results:[]});}});
  await assert.rejects(runOperationContext({signal:controller.signal},()=>integration.search('hello')),code('OPERATION_CANCELLED'));
  assert.equal(calls,0);
});
test('TRAIN media verifies all recorded content digests and rejects conflicting versions',async()=>{
  let requested;
  const integration={readiness:()=>[],media:async clip=>{requested=clip;return Buffer.from('clip');}};
  const app=demo(integration);app.store.data.liveClips.push({id:'train-clip',mode:'live'});
  app.store.data.versions.push({trainingEvidence:[{clipId:'train-clip',contentDigest:'a'.repeat(64)}]});
  await app.media('train-clip');assert.equal(requested.contentDigest,'a'.repeat(64));
  app.store.data.versions.push({trainingEvidence:[{clipId:'train-clip',contentDigest:'b'.repeat(64)}]});
  await assert.rejects(app.media('train-clip'),code('EVIDENCE_DIGEST_CONFLICT'));
});
function reingestApp(integrations,store){const app=demo(integrations,store);app.store.data.liveClips.push({id:'train-clip',mode:'live',split:'TRAIN',originalVideo:'s3://videos/parent.mp4'});return app;}
test('re-ingest records a durable attempt before submission, is noncancellable, and preserves unknown outcomes across reset',async()=>{
  const entered=pause(),release=pause();let calls=0,app;
  const integration={readiness:()=>[],reingest:async()=>{calls++;assert.equal(app.store.data.reingestJobs.length,1);entered.resolve();await release.promise;throw new AppError(503,'UPSTREAM_TIMEOUT','Safe timeout');}};
  app=reingestApp(integration);
  const pending=app.reingest({clipId:'train-clip',customPrompt:'Describe visible actions.',confirm:true});
  const failed=assert.rejects(pending,code('REINGEST_OUTCOME_UNKNOWN'));
  await entered.promise;assert.equal(app.state().operation.cancellable,false);
  await assert.rejects(app.cancel({operationId:app.state().operation.id}),code('OPERATION_NOT_CANCELLABLE'));
  release.resolve();await failed;
  const attempt=app.store.data.reingestJobs[0];assert.equal(attempt.status,'unknown');assert.equal(attempt.requiresReconciliation,true);
  await assert.rejects(app.reingest({clipId:'train-clip',customPrompt:'Describe visible actions.',confirm:true}),code('REINGEST_IN_PROGRESS'));assert.equal(calls,1);
  await app.reset();assert.equal(app.store.data.reingestJobs[0].attemptId,attempt.attemptId);
  await assert.rejects(app.reconcileReingest({attemptId:attempt.attemptId,confirmedStatus:'not_started'}),code('CONFIRMATION_REQUIRED'));
  await app.reconcileReingest({attemptId:attempt.attemptId,confirmedStatus:'not_started',confirmed:true});
  assert.equal(app.store.data.reingestJobs[0].status,'not_started');assert.equal(app.store.data.reingestJobs[0].requiresReconciliation,false);
});
test('successful re-ingest keeps its attempt identity and exact provider job',async()=>{
  const app=reingestApp({readiness:()=>[],reingest:async()=>({jobId:'job-123',selectedChunks:1,copiedSegments:2})});
  const result=await app.reingest({clipId:'train-clip',customPrompt:'Describe visible actions.',confirm:true});
  assert.match(result.result.attemptId,/^attempt-/);assert.equal(result.result.jobId,'job-123');assert.equal(result.result.status,'queued');
  assert.equal(result.state.operation.status,'succeeded');
});
test('provider deadline aborts exactly one request with a helpful redacted timeout',async()=>{
  let calls=0;
  const integration=new Integrations({env:{...env,SHOWONCE_PROVIDER_TIMEOUT_MS:'5000'},fetchImpl:async(_url,options)=>{
    calls++;const keepAlive=setInterval(()=>{},100);
    try{return await abortable(options.signal);}finally{clearInterval(keepAlive);}
  }});
  await assert.rejects(integration.search('private search text'),error=>error.code==='UPSTREAM_TIMEOUT'&&error.message.includes('5-second')&&error.message.includes('No inference or mutation was automatically retried')&&!error.message.includes('private search')&&!error.message.includes('private-token'));
  assert.equal(calls,1);
});
