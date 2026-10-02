/** Pure UI helpers shared with tests. Never turns a lost HTTP response into a retry. */
export const operationActive=state=>!!state?.busy||['running','cancelling'].includes(state?.operation?.status);
export function versionContext(state,versionId){
 const version=state?.versions?.find(v=>v.id===versionId);
 if(!version)return null;
 return {versionId:version.id,mode:version.mode,clipId:version.trainingClipIds?.[0]||state.clips?.find(c=>c.mode===version.mode&&c.split==='TRAIN')?.id};
}
export function evidenceExport(state,{exportedAt=new Date().toISOString()}={}){
 const omit=new Set(['password','apikey','api_key','authorization','token','access_token','secret','cookie','segmentsource','endpoint','baseurl']);
 const clean=value=>Array.isArray(value)?value.map(clean):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!omit.has(key.toLowerCase())).map(([key,v])=>[key,clean(v)])):value;
 return clean({schemaVersion:state.app?.schemaVersion||1,exportedAt,mode:state.mode,browserLocal:!!state.browserLocal,
  warning:'Private experiment evidence. Review real corpus context before sharing. Fixture agreement is not model accuracy.',
  disclaimer:state.fixtures?.warning,clips:state.clips||state.fixtures?.clips||[],liveHoldout:state.liveHoldout||null,
  versions:state.versions||[],evaluations:state.evaluations||[],ledger:state.ledger||[],audit:state.audit||[],
  readiness:(state.readiness||[]).map(({id,name,status,configured,detail,checkedAt,selectedModel})=>({id,name,status,configured,detail,checkedAt,selectedModel})),
  operation:state.operation||null,reingestJobs:state.reingestJobs||[]});
}

/** Compare recorded facts only: never infer a prediction from the rule text. */
export function versionComparison(state, versionId) {
 const version=state?.versions?.find(v=>v.id===versionId);
 const parent=state?.versions?.find(v=>v.id===version?.parentId&&v.mode===version.mode);
 if(!version||!parent)return null;
 const before=parent.rule||{},after=version.rule||{};
 const changes=[];
 if(before.definition!==after.definition)changes.push({label:'Definition',before:before.definition||'Not specified',after:after.definition||'Not specified'});
 for(const key of new Set([...Object.keys(before.thresholds||{}),...Object.keys(after.thresholds||{})])) {
  const previous=before.thresholds?.[key],next=after.thresholds?.[key];
  if(JSON.stringify(previous)!==JSON.stringify(next))changes.push({label:({minDurationSec:'Minimum duration (seconds)',maxSpeedMps:'Maximum motion (m/s)',travelLaneOnly:'Travel lane required'})[key]||key,before:previous??'Not specified',after:next??'Not specified'});
 }
 for(const key of ['include','exclude']){
  const old=before[key]||[],next=after[key]||[];
  for(const value of next.filter(v=>!old.includes(v)))changes.push({label:key==='exclude'?'Added exclusion':'Added requirement',before:'—',after:value});
  for(const value of old.filter(v=>!next.includes(v)))changes.push({label:key==='exclude'?'Removed exclusion':'Removed requirement',before:value,after:'—'});
 }
 const previousEvaluation=state.evaluations?.filter(e=>e.versionId===parent.id).at(-1);
 const evaluation=state.evaluations?.filter(e=>e.versionId===version.id).at(-1);
 const digestMatches=!!evaluation?.holdoutDigest&&evaluation.holdoutDigest===previousEvaluation?.holdoutDigest;
 const previousRows=previousEvaluation?.results||[],rows=evaluation?.results||[];
 const sameRows=rows.length>0&&rows.length===previousRows.length&&new Set(rows.map(r=>r.clipId)).size===rows.length&&rows.every(r=>previousRows.some(p=>p.clipId===r.clipId&&p.expected===r.expected));
 const comparable=digestMatches&&sameRows;
 const decisions=comparable?rows.map(row=>({clipId:row.clipId,before:previousRows.find(r=>r.clipId===row.clipId),after:row})):[];
 return {parent,version,changes,previousEvaluation,evaluation,comparable,decisions,changedDecisions:decisions.filter(d=>d.before.predicted!==d.after.predicted),addedTrainingClipIds:(version.trainingClipIds||[]).filter(id=>!parent.trainingClipIds?.includes(id))};
}
