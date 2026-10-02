import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixtures, baselineRule, holdoutDigest, DEMO_WARNING } from '../server/lib/fixtures.mjs';
import { createBrowserDemo } from '../public/browser-demo.js';
const data=JSON.parse(await readFile(new URL('../public/fixture-data.json',import.meta.url)));
test('public fixture data matches the canonical server definitions',()=>{
 assert.deepEqual(data.clips,fixtures);
 assert.deepEqual(data.baselineRule,baselineRule());
 assert.equal(data.holdoutDigest,holdoutDigest(fixtures));
 assert.equal(data.warning,DEMO_WARNING);
});
test('every fixture has bundled video and poster bytes',async()=>{
 for(const c of fixtures){
  const video=await readFile(new URL(`../public/clips/${c.id}.mp4`,import.meta.url));
  const poster=await readFile(new URL(`../public/clips/${c.id}.jpg`,import.meta.url));
  assert.equal(video.subarray(4,8).toString(),'ftyp');
  assert.equal(poster[0],0xff);assert.equal(poster[1],0xd8);
  assert.ok(c.evidence.startSec>=0&&c.evidence.endSec<=c.duration&&c.evidence.endSec>c.evidence.startSec);
 }
});
test('browser demo round-trip preserves versions without accepting live capability',async()=>{
 const values=new Map();const storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
 const req=createBrowserDemo(data,{storage});await req('/api/generate',{mode:'demo'});
 const restored=createBrowserDemo(data,{storage});const state=await restored('/api/state');
 assert.equal(state.versions.length,1);assert.equal(state.browserLocal,true);assert.equal(state.readiness.some(r=>r.configured),false);
});
