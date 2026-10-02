import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the actual UI templates and event handlers in a network-free VM.
// These are interface contract tests, not browser rendering or sponsor execution.
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const intent='A person picks up an item and removes it from the shelf';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const warehouse={id:'vast-warehouse-train',mode:'live',split:'TRAIN',label:false,reviewed:true,labelSource:'human-reviewed',title:'Repositioning an item',duration:3.5,originalVideo:'s3://corpus/warehouse.mp4',videoUrl:'/api/media/vast-warehouse-train'};
function harness(){
 const actions=[],modals=[],toasts=[],fields={};let click;
 const context=vm.createContext({
  document:{addEventListener:(name,handler)=>{if(name==='click')click=handler}},
  state:{versions:[],clips:[warehouse],evaluations:[],ledger:[],readiness:[]},mode:'live',busy:null,
  modalName:null,modalRevision:0,liveEventName:intent,corpusQuery:'',
  esc:escape,icon:()=>'',assetUrl:value=>value,clipUrl:c=>c?.videoUrl,poster:()=>'',fmtTime:String,
  clips:()=>context.state.clips,training:()=>context.state.clips.filter(c=>c.split==='TRAIN'),
  currentVersion:()=>context.state.versions.at(-1),currentEval:()=>context.state.evaluations.at(-1),
  $:selector=>fields[selector],$$:()=>[],toast:(...args)=>toasts.push(args),
  openModal:(...args)=>modals.push(args),saveLiveIntent:value=>{context.liveEventName=value.trim()},
  action:async(...args)=>{actions.push(args)},request:async()=>({result:{clips:[warehouse]}}),
 });
 vm.runInContext(source.slice(source.indexOf('function connections('),source.indexOf("document.addEventListener('keydown',")),context);
 return {context,fields,actions,modals,toasts,click:async(name,id)=>click({target:{closest:()=>({dataset:{action:name,id},disabled:false})}})};
}
test('live discovery uses the operator event instead of an implicit road query',async()=>{
 const h=harness(),queries=[];
 h.fields['#corpus-query']={value:''};h.fields['#discover-results']={innerHTML:''};
 h.fields['#live-event-name']={value:intent};
 h.context.request=async(path,data)=>{queries.push({path,data});return {result:{clips:[warehouse]}}};
 await h.click('discover');
 assert.equal(queries[0].path,'/api/discover');assert.equal(queries[0].data.query,intent);
 assert.equal(h.fields['#corpus-query'].value,intent);
 assert.match(h.fields['#discover-results'].innerHTML,/Repositioning an item/);
 h.fields['#corpus-query'].value='worker in warehouse aisle';await h.click('discover');
 assert.equal(queries[1].data.query,'worker in warehouse aisle');
});
test('empty live discovery is explained locally without submitting a provider query',async()=>{
 const h=harness();let requests=0;
 h.context.liveEventName='';h.fields['#corpus-query']={value:' '};h.fields['#discover-results']={innerHTML:'Existing evidence'};
 h.context.request=async()=>{requests++};await h.click('discover');
 assert.equal(requests,0);assert.equal(h.fields['#discover-results'].innerHTML,'Existing evidence');
 assert.match(h.toasts.at(-1)[0],/Describe the event/);
});
test('live label review accepts short warehouse footage and preserves exact human criterion',async()=>{
 const h=harness();await h.click('label-live',warehouse.id);
 const body=h.modals.at(-1)[3];assert.match(body,/3\.5 seconds/);assert.match(body,/removes it from the shelf/);
 assert.doesNotMatch(body,/travel lane|highway|8 seconds|eight seconds/i);
 h.fields['#label-reviewed']={checked:true};h.fields['#label-split']={value:'TRAIN'};h.fields['#label-value']={value:'false'};
 await h.click('save-label',warehouse.id);
 const [name,path,data]=h.actions.at(-1);assert.equal(name,'label');assert.equal(path,'/api/label');
 assert.equal(data.clipId,warehouse.id);assert.equal(data.eventName,intent);assert.equal(data.label,false);
 assert.equal(data.labelSource,'human-reviewed');assert.equal(data.reviewed,true);
});
test('live generation and correction preserve a generic event without injected time or road thresholds',async()=>{
 const h=harness();h.fields['#event-name']={value:intent};await h.click('confirm-generate');
 assert.equal(h.actions.at(-1)[2].eventName,intent);assert.equal(h.actions.at(-1)[2].mode,'live');
 assert.deepEqual(Object.keys(h.actions.at(-1)[2]).sort(),['eventName','mode']);
 h.context.state.versions=[{id:'live-v1',mode:'live',eventName:intent,trainingClipIds:['vast-positive']}];
 h.context.state.evaluations=[{versionId:'live-v1',results:[]}];
 await h.click('correct');const body=h.modals.at(-1)[3];
 assert.match(body,/Repositioning an item/);assert.match(body,/HOLDOUT labels and predictions stay out/);
 assert.doesNotMatch(body,/travel lane|highway|8 seconds|0\.5 m\/s/i);
 h.context.$$=()=>[{value:warehouse.id}];h.fields['#correction-feedback']={value:'Ignore repositioning on the same shelf. Count removal.'};
 await h.click('confirm-correct');const payload=h.actions.at(-1)[2];
 assert.equal(payload.versionId,'live-v1');assert.equal(payload.feedback,h.fields['#correction-feedback'].value);
 assert.deepEqual(Array.from(payload.trainingClipIds),[warehouse.id]);
 assert.equal(payload.mode,'live');assert.equal(payload.thresholds,undefined);
});
test('generic live rule and evidence templates do not invent a traffic event when optional text is absent',()=>{
 const h=harness();
 vm.runInContext(source.slice(source.indexOf('function renderRule('),source.indexOf('function bindVideo(')),h.context);
 const rendered=vm.runInContext("renderRule({mode:'live',rule:{},trainingClipIds:[]})",h.context);
 assert.doesNotMatch(rendered,/vehicle|travel lane|stationary/i);
 h.context.state.ledger=[{id:'event-live',clipId:warehouse.id,versionId:'live-v1',eventName:intent,source:'nvidia-cosmos',evidence:{startSec:0,endSec:3.5},ruleSnapshot:{definition:intent}}];
 vm.runInContext("showEvidence('event-live')",h.context);
 assert.match(h.modals.at(-1)[3],/removes it from the shelf/);
 assert.doesNotMatch(h.modals.at(-1)[3],/Vehicle stationary|travel lane|Synthetic clip/i);
});
