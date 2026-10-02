import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../index.mjs';
import { Store } from '../lib/store.mjs';

async function setup(t) {
  const dir=await mkdtemp(path.join(tmpdir(),'showonce-test-'));
  await writeFile(path.join(dir,'index.html'),'<!doctype html><title>ShowOnce</title>');
  await writeFile(path.join(dir,'sample.mp4'),Buffer.from('0123456789'));
  const {server,application}=await createServer({store:new Store(null),env:{},staticRoot:dir});
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
test('durable store survives restart and does not silently reset corrupt data',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'showonce-store-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'state.json');const store=await new Store(file).load();
  await store.transaction(s=>{s.mode='live';});
  assert.equal((await new Store(file).load()).data.mode,'live');
  await writeFile(file,'broken');await assert.rejects(new Store(file).load(),e=>e.code==='STORE_UNREADABLE');
});
