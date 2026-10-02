import test from 'node:test';
import assert from 'node:assert/strict';
import {launchWorkshop} from '../scripts/workshop.mjs';
const close=server=>new Promise(resolve=>server.close(resolve));
test('workshop starts on loopback in live mode with inherited env only and no provider configuration',async()=>{
 const logs=[];let requests=0;const runtime=await launchWorkshop({env:{HOST:'0.0.0.0',UNRELATED_SECRET:'DO_NOT_PRINT_THIS'},port:0,dataFile:null,log:s=>logs.push(s),fetchImpl:async()=>{requests++;throw new Error('unexpected network')}});
 try{
  assert.equal(runtime.server.address().address,'127.0.0.1');assert.match(runtime.url,/\?mode=live$/);
  const ready=await runtime.readinessPromise;assert.equal(ready.ready,false);assert.equal(requests,0);
  const state=await (await fetch(runtime.url.replace('/?mode=live','/api/state'))).json();assert.equal(state.versions.length,0);
  assert.ok(!logs.join('\n').includes('DO_NOT_PRINT_THIS'));assert.ok(logs.some(s=>s.includes('not_configured')));
 }finally{await close(runtime.server)}
});
test('workshop redacts upstream failures and keeps local UI available',async()=>{
 const logs=[];const secret='TEST_SECRET_DO_NOT_LOG';
 const runtime=await launchWorkshop({env:{WANDB_API_KEY:secret},port:0,dataFile:null,log:s=>logs.push(s),fetchImpl:async()=>new Response(JSON.stringify({error:secret}),{status:401,headers:{'content-type':'application/json'}})});
 try{const result=await runtime.readinessPromise;assert.equal(result.ready,false);assert.ok(logs.some(s=>s==='Weights & Biases: error'));assert.ok(!logs.join('\n').includes(secret));assert.equal((await fetch(runtime.url)).status,200)}finally{await close(runtime.server)}
});
test('workshop rejects invalid runtime and port before opening a server',async()=>{
 await assert.rejects(launchWorkshop({env:{},nodeVersion:'20.1.0',port:0}),e=>e.code==='NODE_VERSION');
 await assert.rejects(launchWorkshop({env:{},port:70000}),e=>e.code==='INVALID_PORT');
});

test('workshop reports missing inherited configuration without echoing endpoint or credentials',async()=>{
 const logs=[];const runtime=await launchWorkshop({env:{COSMOS3_REASON_URL:'https://private-provider.example'},port:0,dataFile:null,log:s=>logs.push(s),fetchImpl:async()=>new Response(JSON.stringify({data:[{id:'test-model'}]}))});
 try{await runtime.readinessPromise;assert.ok(logs.some(s=>s.includes('Missing inherited configuration: VAST, Weights & Biases')));assert.ok(logs.some(s=>s.includes('GPU bearer is absent')));assert.ok(!logs.join('\n').includes('private-provider.example'));}finally{await close(runtime.server)}
});
test('workshop preserves the original listener when its port is already occupied',async()=>{
 const first=await launchWorkshop({env:{},port:0,dataFile:null,log:()=>{}});
 try{await assert.rejects(launchWorkshop({env:{},port:first.server.address().port,dataFile:null,log:()=>{}}),e=>e.code==='EADDRINUSE');assert.equal((await fetch(first.url)).status,200);}finally{await close(first.server)}
});

test('workshop does not report ready without the official GPU bearer even if generic endpoints answer',async()=>{
 const env={INGRESS_URL:'https://vast.example',VAST_API_TOKEN:'test-vast',COSMOS3_REASON_URL:'https://cosmos.example',WANDB_API_KEY:'test-wandb',WANDB_MODEL:'test-text-model'};
 const fetchImpl=async()=>new Response(JSON.stringify({data:[{id:'test-text-model'}]}),{headers:{'content-type':'application/json'}});
 const logs=[];const runtime=await launchWorkshop({env,port:0,dataFile:null,log:s=>logs.push(s),fetchImpl});
 try{const result=await runtime.readinessPromise;assert.equal(result.readiness.every(r=>r.status==='ready'),true);assert.equal(result.ready,false);assert.equal(result.workshopRequirementsMet,false);assert.ok(!logs.includes('Connectivity checks passed. Review real footage and human labels before generating a live rule.'));}finally{await close(runtime.server)}
 const authorized=await launchWorkshop({env:{...env,GPU_BEARER_TOKEN:'test-existing-workshop-bearer'},port:0,dataFile:null,log:()=>{},fetchImpl});
 try{const result=await authorized.readinessPromise;assert.equal(result.ready,true);assert.equal(result.workshopRequirementsMet,true);}finally{await close(authorized.server)}
});
