/** Local HTTP CONTRACT tests only. All providers, media bytes, decisions and
 * receipts in this file are authored test doubles. No sponsor service runs,
 * no real video is interpreted, and these results do not verify sponsor access.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../server/index.mjs';
import { Store } from '../server/lib/store.mjs';
import { Integrations } from '../server/lib/integrations.mjs';
import { verifyLiveRun } from '../scripts/lib/verify-live-run.mjs';
import { evidenceExport, versionContext } from '../public/workflow-state.js';

const rule = { definition:'A person lifts a package and carries it away from the support.', include:['Package leaves its support','Person carries package away'], exclude:['Repositioning on the same surface'], thresholds:{minDurationSec:0} };
const eventName = 'Person carries package away';
const cases = [
  {key:'train-positive',parent:'train-p'}, {key:'train-negative',parent:'train-n'},
  {key:'holdout-positive',parent:'holdout-p'}, {key:'holdout-negative',parent:'holdout-n'},
  {key:'replay-positive',parent:'replay-p'}, {key:'holdout-sibling',parent:'holdout-p'},
];
const source = key => `s3://local-contract-segments/${key}.mp4`;
const parent = key => `s3://local-contract-originals/${key}.mp4`;
async function listen(server) { await new Promise(r=>server.listen(0,'127.0.0.1',r)); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise(r=>server.close(r)); }
async function setup(t, options = {}) {
  const calls = []; const behavior = {expireFirstSearch:false,expireMedia:false,cosmosError:null,wandbDelay:0,...options}; let logins=0;
  const upstream = http.createServer(async(req,res)=>{
    const url = new URL(req.url,'http://localhost'); let raw=''; for await(const chunk of req) raw+=chunk;
    const body = raw ? JSON.parse(raw) : null; calls.push({path:url.pathname,query:Object.fromEntries(url.searchParams),headers:req.headers,body});
    const json = (value,status=200) => {res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(url.pathname==='/vast/api/v1/auth/login') return json({access_token:`local-contract-token-${++logins}`});
    if(url.pathname==='/vast/api/v1/auth/me') return json({username:'local-contract-user'});
    if(url.pathname==='/vast/api/v1/search') {
      if(behavior.expireFirstSearch && req.headers.authorization==='Bearer local-contract-token-1') return json({detail:'expired'},401);
      return json({results:cases.map((c,i)=>({source:source(c.key),filename:c.key,reasoning_content:'Authored local contract-test caption',start_sec:100,end_sec:112,...(i===0?{original_video:parent(c.parent)}:{})})),chunk_results:[{preview_source:source(cases[1].key),original_video:parent(cases[1].parent)}]});
    }
    if(url.pathname==='/vast/api/v1/videos/metadata') { const c=cases.find(c=>source(c.key)===url.searchParams.get('source'));return json(c?{source:source(c.key),original_video:parent(c.parent),start_sec:100,end_sec:112}:{}); }
    if(url.pathname==='/vast/api/v1/videos/stream') {
      if(behavior.expireMedia && url.searchParams.get('token')==='local-contract-token-1') return json({detail:'expired'},401);
      res.writeHead(200,{'Content-Type':'video/mp4'}); return res.end(Buffer.from(`LOCAL_CONTRACT_BYTES:${url.searchParams.get('source')}`));
    }
    if(url.pathname==='/cosmos/v1/models') return json({data:[{id:'nvidia/local-contract-cosmos'}]});
    if(url.pathname==='/cosmos/v1/chat/completions') {
      if(behavior.cosmosError) return json({detail:'local-contract-secret-must-not-leak'},behavior.cosmosError);
      const content=body.messages[0].content;const media=Buffer.from(content[0].video_url.url.split(',')[1],'base64').toString();
      const observation={summary:media.includes('positive')?'A person carries a package away.':'The package remains on its support.',startSec:1,endSec:4,...(body.response_format.json_schema.name==='event_decision'?{predicted:media.includes('positive')}:{})};
      return json({id:`contract-cosmos-${calls.length}`,model:'nvidia/local-contract-cosmos',choices:[{message:{content:JSON.stringify(observation)}}],usage:{prompt_tokens:5,completion_tokens:8}});
    }
    if(url.pathname==='/wandb/v1/models') return json({data:[{id:'local-contract-embedding',input_modalities:['text'],output_modalities:['embedding']},{id:'local-contract-chat',input_modalities:['text'],output_modalities:['text']}]});
    if(url.pathname==='/wandb/v1/chat/completions') {
      if(behavior.wandbDelay) await new Promise(r=>setTimeout(r,behavior.wandbDelay));
      if(res.destroyed) return;
      return json({id:`contract-wandb-${calls.length}`,model:'local-contract-chat',choices:[{message:{content:JSON.stringify(rule)}}]});
    }
    json({error:'Local contract route missing'},404);
  });
  const upstreamBase=await listen(upstream);
  t.after(()=>close(upstream));
  const env={INGRESS_URL:`${upstreamBase}/vast`,USERNAME:'local-contract-user',PASSWORD:'test-password',COSMOS3_REASON_URL:`${upstreamBase}/cosmos`,WANDB_BASE_URL:`${upstreamBase}/wandb/v1`,WANDB_API_KEY:'local-contract-wandb-key',WANDB_TEAM:'test-team',WANDB_PROJECT:'test-project'};
  const integrations=new Integrations({env,timeoutMs:options.timeoutMs??5000});
  const {server,application}=await createServer({store:new Store(null),integrations,env:{}});
  const base=await listen(server);
  t.after(()=>close(server));
  const api=async(path,data)=>{const res=await fetch(`${base}/api/${path}`,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return {status:res.status,data:await res.json()};};
  return {api,base,application,integrations,calls,behavior,logins:()=>logins};
}
async function labelSet(api) {
  const discovered=await api('discover',{query:'Person picks up a package'});assert.equal(discovered.status,200);
  const rows=discovered.data.state.clips.filter(c=>c.mode==='live');const byKey=Object.fromEntries(rows.map(c=>[c.title,c]));
  for(const [key,split,label] of [['train-positive','TRAIN',true],['train-negative','TRAIN',false],['holdout-positive','HOLDOUT',true],['holdout-negative','HOLDOUT',false],['replay-positive','REPLAY',null]]) {
    const out=await api('label',{clipId:byKey[key].id,split,label,eventName,labelSource:'human-reviewed',reviewed:true});assert.equal(out.status,200,JSON.stringify(out.data));
  }
  return byKey;
}

test('local HTTP contract only: discovery, reviewed splits, real adapters, evaluate, publish and replay',async t=>{
  const {api,base,calls,logins}=await setup(t,{expireFirstSearch:true});const clips=await labelSet(api);
  assert.equal(logins(),2,'Search401 must refresh the username/password session once');
  assert.equal(clips['train-positive'].parentResolution,'segment-hit');assert.equal(clips['train-negative'].parentResolution,'chunk-preview');assert.equal(clips['holdout-positive'].parentResolution,'segment-metadata');
  assert.equal(clips['holdout-positive'].duration,12);
  const wrongParent=await api('label',{clipId:clips['holdout-sibling'].id,split:'TRAIN',label:false,eventName,labelSource:'human-reviewed',reviewed:true});assert.equal(wrongParent.data.error.code,'PARENT_VIDEO_LEAKAGE');
  const missingReview=await api('label',{clipId:clips['train-positive'].id,split:'TRAIN',label:true,eventName,labelSource:'human-reviewed'});assert.equal(missingReview.data.error.code,'HUMAN_REVIEW_REQUIRED');
  const missingCriterion=await api('label',{clipId:clips['train-positive'].id,split:'TRAIN',label:true,labelSource:'human-reviewed',reviewed:true});assert.equal(missingCriterion.data.error.code,'LABEL_EVENT_REQUIRED');
  const wrongCriterion=await api('generate',{mode:'live',eventName:'A completely different observable action'});assert.equal(wrongCriterion.data.error.code,'LABEL_INTENT_MISMATCH');
  assert.equal(calls.filter(c=>c.path==='/cosmos/v1/chat/completions').length,0,'Mismatched label intent must stop before paid inference');
  const media=await fetch(`${base}${clips['train-positive'].videoUrl}`);assert.equal(media.status,200);assert.match(await media.text(),/LOCAL_CONTRACT_BYTES/);
  const checked=await api('check',{});assert.equal(checked.status,200);assert.ok(checked.data.result.every(r=>r.status==='ready'));
  const generated=await api('generate',{mode:'live',eventName});assert.equal(generated.status,200,JSON.stringify(generated.data));const versionId=generated.data.result.id;
  assert.deepEqual(generated.data.result.rule.thresholds,{minDurationSec:0});assert.equal(generated.data.result.generationReceipt.model,'local-contract-chat');
  const freeze=await api('label',{clipId:clips['holdout-positive'].id,split:'HOLDOUT',label:false,eventName,labelSource:'human-reviewed',reviewed:true});assert.equal(freeze.data.error.code,'HOLDOUT_FROZEN');
  const evaluated=await api('evaluate',{mode:'live',versionId});assert.equal(evaluated.status,200);assert.equal(evaluated.data.result.metrics.correct,2);assert.equal(evaluated.data.result.metrics.unknown,0);
  const evaluatedAgain=await api('evaluate',{mode:'live',versionId});assert.equal(evaluatedAgain.data.result.id,evaluated.data.result.id);
  const published=await api('publish',{versionId});assert.equal(published.status,200);assert.equal(published.data.result.publicationScope,'local-replay-only');
  const replay=await api('replay',{versionId});assert.equal(replay.status,200);assert.equal(replay.data.result.events[0].decision,'detected');assert.match(replay.data.result.events[0].evidence.contentDigest,/^[a-f0-9]{64}$/);
  const replayAgain=await api('replay',{versionId});assert.equal(replayAgain.data.result.events.length,0);assert.equal(replayAgain.data.result.deduplicated,1);
  assert.equal(verifyLiveRun(replayAgain.data.state).summary.holdoutCount,2,'Consistency check only; all provider receipts here are test doubles');
  assert.throws(()=>verifyLiveRun(replayAgain.data.state,{versionId:'missing-explicit-version'}),/Requested live version/);
  const exported=evidenceExport(replayAgain.data.state);
  assert.equal(verifyLiveRun(exported).summary.versionId,versionId,'The user export must retain enough split provenance for the same consistency check');
  assert.equal(exported.clips.find(c=>c.id===clips['holdout-positive'].id).originalVideo,parent('holdout-p'));
  assert.equal(exported.clips.find(c=>c.id===clips['holdout-positive'].id).labelEventName,eventName);
  assert.equal(exported.liveHoldout.digest,generated.data.result.holdoutDigest);
  const demoVersion=await api('generate',{mode:'demo',eventName:'Demo event'});assert.equal(demoVersion.status,200);
  assert.deepEqual(versionContext(demoVersion.data.state,versionId),{versionId,mode:'live',clipId:clips['train-positive'].id});
  const payload=JSON.parse(calls.find(c=>c.path==='/wandb/v1/chat/completions').body.messages[1].content);assert.equal(payload.trainingExamples.length,2);assert.ok(payload.trainingExamples.every(c=>c.split==='TRAIN'));
  for(const c of Object.values(clips).filter(c=>c.title.startsWith('holdout')))assert.ok(!JSON.stringify(payload).includes(c.id));
  for(const c of calls.filter(c=>c.path==='/cosmos/v1/chat/completions')){assert.equal(c.body.messages[0].content[0].type,'video_url');assert.equal(c.body.response_format.type,'json_schema');assert.equal(c.body.media_io_kwargs.video.fps,4);}
  const wb=calls.find(c=>c.path==='/wandb/v1/chat/completions');assert.equal(wb.headers['openai-project'],'test-team/test-project');
  const serialized=JSON.stringify(replayAgain.data.state);for(const secret of ['test-password','local-contract-token-','local-contract-wandb-key','data:video'])assert.ok(!serialized.includes(secret));
});

test('local HTTP contract only: media401 refreshes cached username/password token',async t=>{
  const {api,base,logins,behavior}=await setup(t);const discovered=await api('discover',{query:'package pickup'});assert.equal(discovered.status,200);assert.equal(logins(),1);
  behavior.expireMedia=true;const clip=discovered.data.state.clips.find(c=>c.mode==='live');const media=await fetch(`${base}${clip.videoUrl}`);
  assert.equal(media.status,200,'An expired video session should refresh once, exactly like search');assert.match(await media.text(),/LOCAL_CONTRACT_BYTES/);assert.equal(logins(),2);
});

test('local HTTP contract only: upstream failure is sanitized and leaves generation retryable',async t=>{
  const {api,behavior}=await setup(t);await labelSet(api);behavior.cosmosError=503;
  const failed=await api('generate',{mode:'live',eventName});assert.equal(failed.status,503);assert.equal(failed.data.error.code,'UPSTREAM_ERROR');assert.ok(!JSON.stringify(failed.data).includes('local-contract-secret'));
  const state=await api('state');assert.equal(state.data.versions.length,0);assert.equal(state.data.liveHoldout,null);assert.equal(state.data.busy,false);
  behavior.cosmosError=null;assert.equal((await api('generate',{mode:'live',eventName})).status,200);
});

test('local HTTP contract only: slow inference times out, rolls back, and supports a retry',async t=>{
  const {api,behavior}=await setup(t,{timeoutMs:5000});await labelSet(api);behavior.wandbDelay=5250;
  const failed=await api('generate',{mode:'live',eventName});assert.equal(failed.status,503);assert.equal(failed.data.error.code,'UPSTREAM_TIMEOUT');
  const state=await api('state');assert.equal(state.data.versions.length,0);assert.equal(state.data.liveHoldout,null);assert.equal(state.data.busy,false);
  behavior.wandbDelay=0;assert.equal((await api('generate',{mode:'live',eventName})).status,200);
});
