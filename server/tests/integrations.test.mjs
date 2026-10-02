import test from 'node:test';
import assert from 'node:assert/strict';
import { Integrations, parseModelJson, validateRule, selectTextModel } from '../lib/integrations.mjs';
import { baselineRule } from '../lib/fixtures.mjs';

const env = { INGRESS_URL:'https://vast.example', VAST_API_TOKEN:'secret-token', COSMOS3_REASON_URL:'http://cosmos.example:8001',
  GPU_BEARER_TOKEN:'secret-gpu-token', WANDB_API_KEY:'secret-wandb-key', WANDB_MODEL:'test-model', WANDB_TEAM:'team', WANDB_PROJECT:'project' };
const clip = { id:'live-1', mode:'live', segmentSource:'s3://segments/a.mp4', originalVideo:'s3://videos/parent.mp4', videoUrl:'/api/media/live-1', duration:12 };
function response(value, status = 200) { return new Response(JSON.stringify(value), {status,headers:{'content-type':'application/json'}}); }
test('VAST search uses exact documented no-synthesis contract and normalizes only indexed S3 sources', async () => {
  const calls=[];
  const client = new Integrations({env,fetchImpl:async (url, options) => {
    calls.push({url,options});
    return response({results:[{source:clip.segmentSource,original_video:clip.originalVideo,reasoning_content:'Visible car stops',similarity_score:0.7},
      {source:'https://evil.example/private',original_video:clip.originalVideo}, {source:'s3://segments/orphan.mp4'}]});
  }});
  const results = await client.search('stopped in travel lane');
  assert.equal(calls[0].url,'https://vast.example/api/v1/search');
  const body=JSON.parse(calls[0].options.body); assert.equal(body.top_k,30); assert.equal(body.llm_top_n,0);
  assert.equal(calls[0].options.headers.Authorization,'Bearer secret-token');
  assert.equal(results.length,1); assert.match(results[0].videoUrl,/^\/api\/media\/live-/);
  assert.equal(results[0].label,null); assert.equal(results[0].split,'UNASSIGNED');
  assert.ok(!JSON.stringify(results).includes('secret-token'));
});
test('Cosmos discovers model, downloads server-side video, and passes documented video_url data URI', async () => {
  const calls=[];
  const client = new Integrations({env,fetchImpl:async (url, options) => {
    calls.push({url,options});
    if(url.endsWith('/v1/models')) return response({data:[{id:'nvidia/cosmos-test'}]});
    if(url.includes('/videos/stream?')) return new Response(new Uint8Array([0,1,2,3]),{headers:{'content-type':'video/mp4'}});
    return response({choices:[{message:{content:JSON.stringify({predicted:true,summary:'Vehicle remains stationary in the travel lane',startSec:2,endSec:11})}}]});
  }});
  const result=await client.observe(clip,baselineRule());
  assert.equal(result.predicted,true); assert.equal(result.model,'nvidia/cosmos-test');
  assert.equal(calls.length,3);
  const payload=JSON.parse(calls[2].options.body);
  assert.equal(payload.model,'nvidia/cosmos-test');
  assert.equal(payload.messages[0].content[0].type,'video_url');
  assert.equal(payload.messages[0].content[0].video_url.url,'data:video/mp4;base64,AAECAw==');
  assert.ok(!JSON.stringify(result).includes('secret-'));
});
test('W&B inference uses explicit model, server-side key, project header, strict structured rule validation', async () => {
  let request;
  const client = new Integrations({env,fetchImpl:async(url,options) => {if(url.endsWith('/models'))return response({data:[{id:'test-model'}]});request={url,options};return response({id:'chatcmpl-test',model:'test-model',choices:[{message:{content:JSON.stringify(baselineRule())}}],usage:{prompt_tokens:40,completion_tokens:100}});}});
  const output=await client.generateRule({eventName:'Roadway stop',observations:[{clipId:'train-positive',split:'TRAIN',label:true,observation:'stationary car'}]});
  assert.equal(request.url,'https://api.inference.wandb.ai/v1/chat/completions');
  assert.equal(request.options.headers['OpenAI-Project'],'team/project');
  assert.equal(JSON.parse(request.options.body).model,'test-model');
  assert.equal(output.usage.promptTokens,40); assert.ok(!JSON.stringify(output).includes('secret-'));
});
test('re-ingest enforces existing video, one chunk, exact prompt, and preserves unspecified metadata', async () => {
  let request;
  const client=new Integrations({env,fetchImpl:async(url,options)=>{request={url,options};return response({job_id:'job-abc',selected_chunks:1,copied_segments:2});}});
  await client.reingest(clip,'Observe travel-lane occupancy and visible stationary duration.');
  assert.equal(request.url,'https://vast.example/api/v1/dashboard/reingest');
  assert.deepEqual(JSON.parse(request.options.body),{original_video:clip.originalVideo,chunk_count:1,custom_prompt:'Observe travel-lane occupancy and visible stationary duration.'});
  await assert.rejects(client.reingest(clip,'a'.repeat(801)),e=>e.code==='INVALID_PROMPT');
  await assert.rejects(client.reingest({...clip,originalVideo:'https://example.com/new.mp4'},'Describe'),e=>e.code==='INVALID_REINGEST_SOURCE');
});
test('provider errors and readiness never disclose secrets or signed URLs', async () => {
  const client=new Integrations({env,fetchImpl:async()=>{throw new Error('failed https://vast.example?token=secret-token password=secret-password');}});
  await assert.rejects(client.media(clip),e=>e.code==='UPSTREAM_UNAVAILABLE'&&!e.message.includes('secret'));
  const config=JSON.stringify(client.readiness()); assert.ok(!config.includes('secret-')); assert.ok(!config.includes('vast.example'));
});
test('W&B model discovery distinguishes configured credentials from a verified explicit model', async () => {
  const client=new Integrations({env:{WANDB_API_KEY:'secret',WANDB_MODEL:'missing-model'},fetchImpl:async()=>response({data:[{id:'actual-text-model',input_modalities:['text'],output_modalities:['text']}]})});
  assert.equal(client.readiness().find(x=>x.id==='wandb').status,'configured_unverified');
  await assert.rejects(client.generateRule({eventName:'stop',observations:[]}),e=>e.code==='MODEL_NOT_LISTED'&&e.message.includes('actual-text-model'));
});
test('model JSON handling rejects malformed outputs and invalid rule thresholds', () => {
  assert.deepEqual(parseModelJson('```json\n{"ok":true}\n```'),{ok:true});
  assert.throws(()=>parseModelJson('I think yes'),e=>e.code==='INVALID_MODEL_RESPONSE');
  assert.throws(()=>validateRule({...baselineRule(),thresholds:{minDurationSec:-1}}),e=>e.code==='INVALID_RULE');
});
test('frozen evidence content hash rejects changed upstream video bytes', async () => {
  const client=new Integrations({env,fetchImpl:async()=>new Response(Buffer.from('changed-video'),{headers:{'content-type':'video/mp4'}})});
  await assert.rejects(client.media({...clip,contentDigest:'wrong-hash'}),e=>e.code==='EVIDENCE_CHANGED');
});
test('VAST username/password session refreshes once after an expired-token 401', async () => {
  let logins=0, searches=0;
  const client=new Integrations({env:{INGRESS_URL:'https://vast.example',USERNAME:'team-test',PASSWORD:'secret-password'},fetchImpl:async(url)=>{
    if(url.endsWith('/auth/login')) return response({access_token:`secret-token-${++logins}`});
    searches++; if(searches===1)return response({detail:'expired'},401);
    return response({results:[]});
  }});
  assert.deepEqual(await client.search('travel lane'),[]);
  assert.equal(logins,2);assert.equal(searches,2);
});

test('VAST resolves missing segment parent from exact chunk preview mapping without metadata guesses', async () => {
  const calls=[];
  const client=new Integrations({env,fetchImpl:async(url)=>{calls.push(url);return response({results:[{source:clip.segmentSource,reasoning_content:'Person lifts a package'}],chunk_results:[{preview_source:clip.segmentSource,original_video:clip.originalVideo}]});}});
  const results=await client.search('package pickup');
  assert.equal(results.length,1);assert.equal(results[0].originalVideo,clip.originalVideo);assert.equal(results[0].parentResolution,'chunk-preview');assert.equal(calls.length,1);
});
test('VAST resolves missing segment parent through exact source metadata and preserves isolation identity', async () => {
  const calls=[];
  const client=new Integrations({env,fetchImpl:async(url)=>{
    calls.push(url);
    if(url.includes('/videos/metadata?')) {assert.equal(new URL(url).searchParams.get('source'),clip.segmentSource);return response({source:clip.segmentSource,original_video:clip.originalVideo,camera_id:'cam-2',start_sec:10,end_sec:22});}
    return response({results:[{source:clip.segmentSource,reasoning_content:'Person lifts a package'}],chunk_results:[]});
  }});
  const results=await client.search('package pickup');
  assert.equal(results.length,1);assert.equal(results[0].originalVideo,clip.originalVideo);assert.equal(results[0].parentResolution,'segment-metadata');assert.equal(results[0].duration,12);assert.equal(calls.length,2);
  assert.equal(client.lastSearchDiagnostics.metadataLookups,1);
});
test('VAST refuses unresolved or conflicting parent identity instead of guessing from segment path', async () => {
  const unresolved=new Integrations({env,fetchImpl:async(url)=>response(url.includes('/metadata?')?{source:clip.segmentSource}:{results:[{source:clip.segmentSource}]})});
  await assert.rejects(unresolved.search('package pickup'),e=>e.code==='PARENT_VIDEO_UNRESOLVED');
  const conflicting=new Integrations({env,fetchImpl:async()=>response({results:[{source:clip.segmentSource,original_video:clip.originalVideo}],chunk_results:[{preview_source:clip.segmentSource,original_video:'s3://other/parent.mp4'}]})});
  await assert.rejects(conflicting.search('package pickup'),e=>e.code==='PARENT_VIDEO_UNRESOLVED');
});
test('W&B chooses an actual text-capable catalog ID deterministically, and rejects unknown modalities', async () => {
  const catalog={data:[{id:'zeta-chat',input_modalities:['text'],output_modalities:['text']},{id:'alpha-chat',input_modalities:['text'],output_modalities:['text']},{id:'embed-only',input_modalities:['text'],output_modalities:['embedding']}]};
  assert.equal(selectTextModel(catalog).id,'alpha-chat');
  assert.equal(selectTextModel({data:[{id:'meta-llama/Llama-3.3-70B-Instruct'}]}).id,'meta-llama/Llama-3.3-70B-Instruct');
  assert.throws(()=>selectTextModel({data:[{id:'unknown-vendor-model'},{id:'vendor/embed-1'}]}),e=>e.code==='TEXT_MODEL_UNRESOLVED'&&e.message.includes('unknown-vendor-model'));
  const client=new Integrations({env:{WANDB_API_KEY:'key'},fetchImpl:async()=>response(catalog)});
  assert.equal(await client.wandbModel(),'alpha-chat');assert.equal(client.readiness().find(r=>r.id==='wandb').selectedModel,'alpha-chat');
});
test('generic pickup versus repositioning uses user intent and generic rule schema without forced roadway thresholds', async () => {
  const requests=[];
  const genericRule={definition:'A person lifts a package off its support and carries it away.',include:['Object leaves supporting surface','Object is carried away'],exclude:['Repositioning on the same surface'],thresholds:{minDurationSec:0}};
  const client=new Integrations({env:{...env,COSMOS3_REASON_MODEL:'cosmos-test'},fetchImpl:async(url,options)=>{
    requests.push({url,options});
    if(url.endsWith('/models'))return response({data:[{id:'test-model'}]});
    if(url.includes('/videos/stream?'))return new Response(Buffer.from('mock-video'));
    if(url.includes('cosmos.example'))return response({id:'cosmos-observation-1',model:'cosmos-test',usage:{prompt_tokens:10,completion_tokens:15},choices:[{message:{content:JSON.stringify({summary:'Person lifts the package then carries it away from the shelf',startSec:2,endSec:5})}}]});
    return response({id:'wandb-rule-1',model:'test-model',choices:[{message:{content:JSON.stringify(genericRule)}}],usage:{prompt_tokens:40,completion_tokens:70}});
  }});
  const observation=await client.observe(clip,null,{eventName:'Pick up and carry a package'});
  const vision=JSON.parse(requests.find(r=>r.url.includes('cosmos.example')).options.body);
  assert.match(vision.messages[0].content[1].text,/Pick up and carry a package/);
  assert.ok(!vision.messages[0].content[1].text.includes('roadway'));
  assert.equal(vision.response_format.type,'json_schema');assert.equal(vision.media_io_kwargs.video.fps,4);
  const output=await client.generateRule({eventName:'Pick up and carry a package',observations:[{clipId:'train-pickup',split:'TRAIN',label:true,observation:observation.summary,contentDigest:observation.contentDigest},{clipId:'train-reposition',split:'TRAIN',label:false,observation:'Package slides across the same shelf'}],feedback:'Require the object to leave its support.'});
  assert.deepEqual(output.rule.thresholds,{minDurationSec:0});assert.equal(output.rule.definition,genericRule.definition);
  assert.equal(observation.receipt.responseId,'cosmos-observation-1');assert.equal(output.receipt.responseId,'wandb-rule-1');
  assert.match(observation.receipt.videoContentDigest,/^[a-f0-9]{64}$/);assert.equal(output.receipt.trainingVideoContentDigests.length,1);
  const allReceipts=JSON.stringify([observation.receipt,output.receipt]);assert.ok(!allReceipts.includes('secret-'));assert.ok(!allReceipts.includes('data:video'));assert.ok(!allReceipts.includes('s3://'));
});
test('Cosmos abstains on positive evidence shorter than the explicit duration rule', async () => {
  const client=new Integrations({env:{...env,COSMOS3_REASON_MODEL:'cosmos-test'},fetchImpl:async(url)=>{
    if(url.includes('/videos/stream?'))return new Response(Buffer.from('mock-video'));
    return response({id:'cosmos-short-window',choices:[{message:{content:JSON.stringify({predicted:true,summary:'Visible stationary object',startSec:2,endSec:3})}}]});
  }});
  const result=await client.observe(clip,{definition:'Object remains stationary for eight seconds',include:[],exclude:[],thresholds:{minDurationSec:8}});
  assert.equal(result.predicted,null);assert.equal(result.receipt.reportedDecision,true);assert.equal(result.receipt.temporalAbstention,true);
  assert.match(result.summary,/shorter than/);
  const instant=await client.observe(clip,{definition:'Object is lifted from the surface',include:[],exclude:[],thresholds:{minDurationSec:0}});
  assert.equal(instant.predicted,true);
});
