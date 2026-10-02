#!/usr/bin/env node
/** One-command workshop launch. Uses only the existing exported environment.
 * Does not load/write .env, source config, install packages, create credentials,
 * enable CI, bind publicly, or execute model inference.
 */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from '../server/index.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const providerNames={vast:'VAST',cosmos:'NVIDIA Cosmos',wandb:'Weights & Biases'};
export async function launchWorkshop({env=process.env,log=console.log,fetchImpl=globalThis.fetch,port=Number(env.SHOWONCE_WORKSHOP_PORT||3000),dataFile=env.SHOWONCE_DATA_FILE||path.join(root,'server/.data/state.json'),nodeVersion=process.versions.node}={}){
 if(Number(nodeVersion.split('.')[0])<22)throw Object.assign(new Error('Node.js 22 or later is required.'),{code:'NODE_VERSION'});
 if(!Number.isInteger(port)||port<0||port>65535)throw Object.assign(new Error('SHOWONCE_WORKSHOP_PORT must be a valid port.'),{code:'INVALID_PORT'});
 const runtime=await createServer({env,fetchImpl,dataFile});
 await new Promise((resolve,reject)=>{runtime.server.once('error',reject);runtime.server.listen(port,'127.0.0.1',()=>{runtime.server.off('error',reject);resolve()})});
 const url=`http://127.0.0.1:${runtime.server.address().port}/?mode=live`;
 log('ShowOnce workshop launch');
 log('Using existing exported configuration only. No credentials are displayed, copied, created, or saved.');
 log(`Open in the workshop VM browser: ${url}`);
 log('Loopback only. Use an existing authenticated preview only after confirming its access gate.');
 const missing=runtime.integrations.readiness().filter(r=>!r.configured).map(r=>providerNames[r.id]||'Provider');
 if(missing.length)log(`Missing inherited configuration: ${missing.join(', ')}. Use the assigned VM shell with its existing team environment; do not paste secrets into the browser.`);
 if(env.COSMOS3_REASON_URL&&!env.GPU_BEARER_TOKEN)log('Cosmos GPU bearer is absent. The official workshop deployment requires its existing GPU_BEARER_TOKEN; endpoint configuration alone does not establish access.');
 log('Checking provider connectivity and model catalogs. No model inference is executed by this launch check.');
 const readinessPromise=(async()=>{
  try{
   const readiness=await runtime.integrations.check();
   for(const r of readiness)log(`${providerNames[r.id]||'Provider'}: ${['ready','error','not_configured','configured_unverified'].includes(r.status)?r.status:'unknown'}`);
   // Generic self-hosted Cosmos may not require authentication, but this launcher
   // targets the official workshop deployment, whose GPU bearer is required.
   const workshopRequirementsMet=!!env.GPU_BEARER_TOKEN;
   const ready=workshopRequirementsMet&&readiness.length===3&&readiness.every(r=>r.status==='ready');
   log(ready?'Connectivity checks passed. Review real footage and human labels before generating a live rule.':'Live setup needs attention. Open Provider connections for safe details; keep this server running.');
   log('A connectivity check is not successful inference or a completed live experiment.');
   return {ready,readiness,workshopRequirementsMet};
  }catch{
   // Never echo provider errors, URLs, or environment values from a startup failure.
   log('Provider readiness could not be established. The local UI remains available; inspect Provider connections.');
   return {ready:false,readiness:runtime.integrations.readiness()};
  }
 })();
 return {...runtime,url,readinessPromise};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const runtime=await launchWorkshop();
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>runtime.server.close(()=>process.exit(0)));
  await runtime.readinessPromise;
 }catch(error){
  const messages={EADDRINUSE:'Port is already in use. Stop your previous ShowOnce server or choose SHOWONCE_WORKSHOP_PORT for this launch.',EACCES:'The local port could not be opened. Choose an unprivileged port.',NODE_VERSION:'Node.js 22 or later is required. Use the workshop-provided Node runtime.',INVALID_PORT:'SHOWONCE_WORKSHOP_PORT must be a valid integer port.',INVALID_PROVIDER_TIMEOUT:'SHOWONCE_PROVIDER_TIMEOUT_MS must be an integer from 5000 through 300000 milliseconds.',STORE_UNREADABLE:'Saved local state is unreadable. Preserve it and restore a valid workspace before restarting.'};
  process.stderr.write(`ShowOnce could not start. ${messages[error.code]||'Check the local runtime and workspace permissions. No credentials were printed.'}\n`);
  process.exitCode=1;
 }
}
