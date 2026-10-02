import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../index.mjs';
import { Store, initialState } from '../lib/store.mjs';

function rawRequest(url, { method = 'GET', headers, body } = {}) {
  // Fetch deliberately overwrites Host. Use the HTTP client to exercise actual
  // browser/reverse-proxy Host values without depending on DNS resolution.
  return new Promise((resolve, reject) => {
    const req=http.request(url,{method,headers},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);
      res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
    });
    req.on('error',reject);req.end(body);
  });
}
async function setup(t, env = {}) {
  const dir=await mkdtemp(path.join(tmpdir(),'showonce-test-'));
  await writeFile(path.join(dir,'index.html'),'<!doctype html><title>ShowOnce</title>');
  await writeFile(path.join(dir,'sample.mp4'),Buffer.from('0123456789'));
  const {server,application}=await createServer({store:new Store(null),env,staticRoot:dir});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  return {base:`http://127.0.0.1:${server.address().port}`,application};
}
test('HTTP server delivers public files, ranges, state, and mutation envelopes',async t=>{
  const {base}=await setup(t);
  assert.equal((await fetch(base)).status,200);
  const range=await fetch(`${base}/sample.mp4`,{headers:{Range:'bytes=2-5'}});
  assert.equal(range.status,206);assert.equal(await range.text(),'2345');assert.equal(range.headers.get('content-range'),'bytes 2-5/10');
  const state=await (await fetch(`${base}/api/state`)).json();assert.equal(state.clips.length,10);assert.equal(state.versions.length,0);
  const out=await(await fetch(`${base}/api/generate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'demo',eventName:'Roadway stop'})})).json();
  assert.equal(out.result.id,'v1');assert.equal(out.state.versions.length,1);assert.equal(out.state.busy,false);
});
test('HTTP boundary blocks unknown origin, non-JSON mutation, hidden files, invalid range, and unknown assets',async t=>{
  const {base}=await setup(t);
  assert.equal((await fetch(`${base}/api/state`,{headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(`${base}/api/generate`,{method:'POST',body:'{}'})).status,415);
  assert.equal((await fetch(`${base}/.env`)).status,404);
  assert.equal((await fetch(`${base}/missing.js`)).status,404);
  assert.equal((await fetch(`${base}/sample.mp4`,{headers:{Range:'bytes=99-100'}})).status,416);
  assert.equal((await fetch(`${base}/api/unknown`)).status,404);
});
test('HTTP host guard blocks DNS rebinding even with matching same-origin headers or no Origin', async t => {
  const {base,application}=await setup(t);
  for (const headers of [{Host:'attacker.example'}, {Host:'attacker.example',Origin:'http://attacker.example'}]) {
    const response=await rawRequest(`${base}/api/state`,{headers});
    assert.equal(response.status,403);assert.equal((await response.json()).error.code,'HOST_NOT_ALLOWED');
  }
  const mutation=await rawRequest(`${base}/api/generate`,{method:'POST',headers:{Host:'attacker.example',Origin:'http://attacker.example','Content-Type':'application/json'},body:JSON.stringify({mode:'demo'})});
  assert.equal(mutation.status,403);assert.equal(application.state().versions.length,0);
  assert.equal((await rawRequest(`${base}/api/health`,{headers:{Host:'localhost'}})).status,200);
});
test('HTTP host guard admits an explicitly configured authenticated preview origin', async t => {
  const {base}=await setup(t,{SHOWONCE_ALLOWED_ORIGINS:'https://preview.example'});
  const response=await rawRequest(`${base}/api/health`,{headers:{Host:'preview.example',Origin:'https://preview.example'}});
  assert.equal(response.status,200);assert.equal(response.headers.get('access-control-allow-origin'),'https://preview.example');
  assert.equal((await rawRequest(`${base}/api/health`,{headers:{Host:'other.example'}})).status,403);
});
test('live evidence supports seeking and HEAD while verifying the complete pinned video before each range', async t => {
  const {base,application}=await setup(t,{INGRESS_URL:'https://vast.example',VAST_API_TOKEN:'test-token'});
  let bytes=Buffer.from('0123456789');
  application.integrations.fetch=async()=>new Response(bytes);
  application.store.data.liveClips.push({id:'live-range',mode:'live',split:'REPLAY',segmentSource:'s3://segments/range.mp4',
    contentDigest:createHash('sha256').update(bytes).digest('hex')});
  for (const [range,expected,contentRange] of [['bytes=2-5','2345','bytes 2-5/10'],['bytes=-3','789','bytes 7-9/10'],['bytes=7-','789','bytes 7-9/10']]) {
    const response=await fetch(`${base}/api/media/live-range`,{headers:{Range:range}});
    assert.equal(response.status,206);assert.equal(await response.text(),expected);assert.equal(response.headers.get('content-range'),contentRange);
    assert.equal(response.headers.get('accept-ranges'),'bytes');assert.equal(response.headers.get('cache-control'),'private, no-store');
  }
  const head=await fetch(`${base}/api/media/live-range`,{method:'HEAD',headers:{Range:'bytes=2-5'}});
  assert.equal(head.status,206);assert.equal(head.headers.get('content-length'),'4');assert.equal(await head.text(),'');
  for (const range of ['bytes=99-100','bytes=5-2','bytes=-0','bytes=0-1,4-5']) {
    const response=await fetch(`${base}/api/media/live-range`,{headers:{Range:range}});
    assert.equal(response.status,416);assert.equal(response.headers.get('content-range'),'bytes */10');
  }
  bytes=Buffer.from('xxxx456789');
  const changed=await fetch(`${base}/api/media/live-range`,{headers:{Range:'bytes=4-9'}});
  assert.equal(changed.status,409);assert.equal((await changed.json()).error.code,'EVIDENCE_CHANGED');
});
test('durable store survives restart and does not silently reset corrupt data',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'showonce-store-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'state.json');const store=await new Store(file).load();
  await store.transaction(s=>{s.mode='live';});
  assert.equal((await new Store(file).load()).data.mode,'live');
  await writeFile(file,'broken');await assert.rejects(new Store(file).load(),e=>e.code==='STORE_UNREADABLE');
});
test('HTTP operation polling and cancellation preserve busy across a concurrent readiness check',async t=>{
  const {base,application}=await setup(t);let release,entered=false;
  application.integrations.search=async()=>{entered=true;await new Promise(resolve=>{release=resolve;});return [];};
  const post=(route,data)=>fetch(`${base}${route}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const running=post('/api/discover',{query:'observable event'});
  while(!entered)await new Promise(resolve=>setImmediate(resolve));
  const state=await(await fetch(`${base}/api/state`)).json();assert.equal(state.busy,true);assert.equal(state.operation.status,'running');
  const checked=await(await post('/api/check',{})).json();assert.equal(checked.state.busy,true);assert.equal(checked.state.operation.id,state.operation.id);
  const cancelling=await(await post('/api/cancel',{operationId:state.operation.id})).json();assert.equal(cancelling.state.busy,true);assert.equal(cancelling.result.status,'cancelling');
  release();const failed=await running;assert.equal(failed.status,409);assert.equal((await failed.json()).error.code,'OPERATION_CANCELLED');
  const final=await(await fetch(`${base}/api/state`)).json();assert.equal(final.busy,false);assert.equal(final.operation.status,'cancelled');
});
test('disconnecting the request does not cancel a provider operation; polling recovers the completed result',async t=>{
  const {base,application}=await setup(t);let release,entered=false;
  application.integrations.search=async()=>{entered=true;await new Promise(resolve=>{release=resolve;});return [];};
  const controller=new AbortController();
  const pending=fetch(`${base}/api/discover`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'observable event'}),signal:controller.signal});
  const lostResponse=assert.rejects(pending,error=>error.name==='AbortError');
  while(!entered)await new Promise(resolve=>setImmediate(resolve));controller.abort();await lostResponse;
  let state=await(await fetch(`${base}/api/state`)).json();assert.equal(state.operation.status,'running');assert.equal(state.busy,true);
  release();
  for(let i=0;i<100&&state.busy;i++){await new Promise(resolve=>setImmediate(resolve));state=await(await fetch(`${base}/api/state`)).json();}
  assert.equal(state.operation.status,'succeeded');assert.equal(state.busy,false);
});

test('structurally corrupt JSON state fails at startup without silently replacing experiments', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'showonce-corrupt-store-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'state.json');
  const mutations = [
    s => { delete s.liveClips; }, s => { s.evaluations = {}; }, s => { s.mode = 'unknown'; },
    s => { s.counters.version = -1; }, s => { s.counters.evaluation = 0.5; },
    s => { s.liveHoldout = {clips:[],digest:'x'}; }, s => { s.versions = [null]; },
    s => { s.versions = [{id:'v1'},{id:'v1'}]; },
  ];
  for (const mutate of mutations) {
    const state=initialState();mutate(state);await writeFile(file,JSON.stringify(state));
    await assert.rejects(new Store(file).load(),e=>e.code==='STORE_UNREADABLE');
  }
});
