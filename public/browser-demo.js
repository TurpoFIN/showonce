/** Isolated, browser-local product demonstration. NO network inference or sponsor calls.
 * This intentionally mirrors the demo-only server contract. Live mode is server-only.
 */
const STORAGE_KEY='showonce.browser-demo.v1';
const clone=v=>structuredClone(v);
const now=()=>new Date().toISOString();
const empty=()=>({schemaVersion:1,versions:[],evaluations:[],ledger:[],audit:[],counters:{version:0,evaluation:0,ledger:0,audit:0}});
export function createBrowserDemo(fixtures,{storage=globalThis.localStorage}={}){
 let saved;try{saved=JSON.parse(storage?.getItem(STORAGE_KEY)||'null')}catch{}
 let db=saved?.schemaVersion===1&&Array.isArray(saved.versions)&&Array.isArray(saved.evaluations)&&Array.isArray(saved.ledger)?saved:empty();
 const source='synthetic-fixture';
 const audit=(action,details={})=>db.audit.push({id:`audit-${++db.counters.audit}`,action,source,timestamp:now(),...details});
 const persist=()=>{try{storage?.setItem(STORAGE_KEY,JSON.stringify(db))}catch{}};
 const state=()=>({app:{name:'ShowOnce',schemaVersion:1,execution:'browser-local-demo'},mode:'demo',browserLocal:true,fixtures:{clips:clone(fixtures.clips),holdoutDigest:fixtures.holdoutDigest,source,warning:fixtures.warning},clips:clone(fixtures.clips),versions:clone(db.versions),evaluations:clone(db.evaluations),ledger:clone(db.ledger),audit:clone(db.audit),readiness:[{id:'vast',name:'VAST Data',status:'not_configured',configured:false,detail:'Indexed video retrieval and reingestion. Run the Node server to connect your authorized workshop environment.'},{id:'cosmos',name:'NVIDIA Cosmos',status:'not_configured',configured:false,detail:'Video reasoning and evidence. Browser-local demo never executes an inference call.'},{id:'wandb',name:'Weights & Biases',status:'not_configured',configured:false,detail:'TRAIN-only rule generation. Configure W&B Inference on the Node server.'}],liveHoldout:null,reingestJobs:[],busy:false});
 const version=id=>{const v=db.versions.find(v=>v.id===id);if(!v)throw new Error('Choose an existing demo rule version.');return v};
 const select=ids=>{if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length)throw new Error('Choose distinct TRAIN examples.');return ids.map(id=>{const c=fixtures.clips.find(c=>c.id===id);if(c?.split!=='TRAIN')throw new Error('Only TRAIN examples can generate or correct a rule.');return c})};
 const decision=(c,r)=>{const f=c.features,t=r.thresholds;const predicted=f.visible&&(f.observedDurationSec??f.stoppedDurationSec)>=t.minDurationSec&&f.speedMps<=t.maxSpeedMps&&(!t.travelLaneOnly||f.lane==='travel_lane');return {predicted,reason:`Authored fixture: ${f.lane}, ${f.speedMps} m/s, ${f.observedDurationSec??f.stoppedDurationSec}s observation. Deterministic rule comparison; no model was run.`,evidence:clone(c.evidence)}};
 const makeVersion=(rule,train,parent=null)=>{const revision=++db.counters.version;const v={id:`v${revision}`,name:`v${revision}`,eventName:parent?.eventName||'Stopped vehicle in travel lane',revision,parentId:parent?.id||null,mode:'demo',source,status:'draft',rule,createdAt:now(),trainingClipIds:train.map(c=>c.id),evaluationId:null,holdoutDigest:fixtures.holdoutDigest,disclaimer:fixtures.warning};db.versions.push(v);return v};
 return async function request(path,input={}){
  if(path==='/api/state')return state();
  if(path!=='/api/reset'&&db.versions.some(v=>v.holdoutDigest!==fixtures.holdoutDigest))throw new Error('The bundled fixture set has changed. Export existing evidence and reset the local workspace before starting a new check.');
  if(input.mode==='live'||['/api/discover','/api/label','/api/reingest'].includes(path))throw new Error('This is the browser-local fixture demo. Live providers require the Node server with your authorized server-side credentials. See the repository setup guide.');
  if(path==='/api/check')return {state:state(),result:state().readiness};
  let result;
  if(path==='/api/generate'){
   const train=select(input.trainingClipIds||['train-positive-01']);if(!train.some(c=>c.label))throw new Error('A positive TRAIN example is required.');
   result=makeVersion(clone(fixtures.baselineRule),train);result.eventName=input.eventName||result.eventName;audit('rule.generated',{versionId:result.id,trainingClipIds:result.trainingClipIds,holdoutSent:false});
  }else if(path==='/api/evaluate'){
   const v=version(input.versionId);if(v.status==='published')throw new Error('Published versions are immutable. Their evaluation is pinned.');
   result=db.evaluations.find(e=>e.versionId===v.id);
   if(!result){const rows=fixtures.clips.filter(c=>c.split==='HOLDOUT').map(c=>{const d=decision(c,v.rule);return {clipId:c.id,expected:c.label,expectedSource:'authored-fixture',...d,correct:d.predicted===c.label,source}});const tp=rows.filter(r=>r.expected&&r.predicted).length,fp=rows.filter(r=>!r.expected&&r.predicted).length,fn=rows.filter(r=>r.expected&&!r.predicted).length;const correct=rows.filter(r=>r.correct).length;
    result={id:`eval-${++db.counters.evaluation}`,versionId:v.id,mode:'demo',source,status:'completed',createdAt:now(),holdoutDigest:fixtures.holdoutDigest,metrics:{total:rows.length,correct,falsePositives:fp,falseNegatives:fn,unknown:0,agreement:correct/rows.length,precision:tp/(tp+fp)||0,recall:tp/(tp+fn)||0},results:rows,previouslyEvaluatedHoldout:db.evaluations.length>0,disclaimer:fixtures.warning};db.evaluations.push(result);v.status='evaluated';v.evaluationId=result.id;audit('holdout.evaluated',{versionId:v.id,evaluationId:result.id,source:'browser-local-fixture',labelsSentToModel:false});}
  }else if(path==='/api/correct'){
   const prev=version(input.versionId);if(!prev.evaluationId)throw new Error('Evaluate the first version before correcting.');const selected=select(input.trainingClipIds);if(!selected.some(c=>!c.label))throw new Error('Choose a hard-negative TRAIN example.');
   const r=clone(prev.rule);if(selected.some(c=>c.scenario==='shoulder'))r.thresholds.travelLaneOnly=true;if(selected.some(c=>c.scenario==='slow_traffic'))r.thresholds.maxSpeedMps=.5;
   r.definition=`A visible vehicle remains ${r.thresholds.maxSpeedMps<=.5?'stationary':'stopped or nearly stopped'}${r.thresholds.travelLaneOnly?' in a travel lane':''} for at least ${r.thresholds.minDurationSec} seconds.`;
   r.include=['Vehicle visible throughout the observation',`At least ${r.thresholds.minDurationSec} seconds at or below ${r.thresholds.maxSpeedMps} m/s`];if(r.thresholds.travelLaneOnly)r.include.push('Vehicle occupies an active travel lane');r.exclude=['Brief pauses under 8 seconds','Fast-moving vehicles'];if(r.thresholds.travelLaneOnly)r.exclude.push('Vehicles stopped on the shoulder');if(r.thresholds.maxSpeedMps<=.5)r.exclude.push('Slow-moving traffic that continues to advance');
   result=makeVersion(r,select([...new Set([...prev.trainingClipIds,...input.trainingClipIds])]),prev);audit('rule.corrected',{versionId:result.id,parentId:prev.id,trainingClipIds:input.trainingClipIds,holdoutSent:false});
  }else if(path==='/api/publish'){
   const v=version(input.versionId);const evaluation=db.evaluations.find(e=>e.id===v.evaluationId&&e.versionId===v.id);if(!evaluation)throw new Error('Evaluate this exact version before publishing.');if(evaluation.metrics.correct!==evaluation.metrics.total||evaluation.metrics.unknown)throw new Error('Every labeled holdout case must agree before this version can be published.');v.status='published';v.publishedAt=now();v.publicationScope='browser-local-demo-only';result=v;audit('version.published',{versionId:v.id,scope:v.publicationScope});
  }else if(path==='/api/replay'){
   const v=version(input.versionId);if(v.status!=='published')throw new Error('Publish an evaluated version before replaying.');const events=[];let deduplicated=0;
   for(const c of fixtures.clips.filter(c=>c.split==='REPLAY')){if(db.ledger.some(e=>e.versionId===v.id&&e.clipId===c.id)){deduplicated++;continue}const d=decision(c,v.rule);const e={id:`event-${++db.counters.ledger}`,versionId:v.id,clipId:c.id,eventName:v.eventName,decision:d.predicted?'detected':'not_detected',timestamp:now(),source,evidence:d.evidence,ruleSnapshot:clone(v.rule),disclaimer:fixtures.warning};db.ledger.push(e);events.push(e)}result={events,deduplicated};audit('replay.completed',{versionId:v.id,created:events.length,deduplicated});
  }else if(path==='/api/reset'){db=empty();audit('workspace.reset',{externalDataChanged:false});result={reset:true,externalDataChanged:false};}
  else throw new Error('This action is not available in the browser-local demo.');
  persist();return {state:state(),result:clone(result)};
 };
}
