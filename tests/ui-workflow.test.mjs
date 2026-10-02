import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createBrowserDemo} from '../public/browser-demo.js';
import {operationActive,versionContext,evidenceExport,versionComparison} from '../public/workflow-state.js';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const fixtures=JSON.parse(await readFile(new URL('../public/fixture-data.json',import.meta.url),'utf8'));
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Network-free interface integration: actual click handlers, mutation coordinator,
// template renderers, and browser-local adapter. No browser/media/layout claim.
async function studio(){
 const storage=new Map(),requests=[],notices=[],roots={'#app':{innerHTML:''},'#modal-root':{innerHTML:''}};
 const adapter=createBrowserDemo(fixtures,{storage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)}});
 let click,keydown;
 const control={focus(){},scrollIntoView(){}};
 const context=vm.createContext({
  state:await adapter('/api/state'),mode:'demo',busy:null,selectedClipId:'train-positive-01',selectedVersionId:null,
  modalName:null,modalRevision:0,priorFocus:null,pollTimer:null,localRequestInFlight:false,pendingAction:null,recovering:false,cancelPending:false,
  localTransport:true,corpusQuery:'',liveEventName:'',operationActive,versionContext,evidenceExport,versionComparison,
  document:{activeElement:control,hidden:false,addEventListener:(name,fn)=>{if(name==='click')click=fn;if(name==='keydown')keydown=fn}},
  $:selector=>roots[selector]||control,
  $$:selector=>selector==='input[name="training-correction"]:checked'?[...roots['#modal-root'].innerHTML.matchAll(/<input\b[^>]*name="training-correction"[^>]*>/g)].filter(([tag])=>tag.includes(' checked')&&!tag.includes(' disabled')).map(([tag])=>({value:/value="([^"]+)"/.exec(tag)[1]})):[],
  icon:()=>'',esc,assetUrl:value=>value,bindVideo:()=>{},toast:(message,error)=>notices.push({message,error}),
  request:async(path,data)=>{requests.push(path);return adapter(path,data)},requestAnimationFrame:fn=>fn(),setTimeout:()=>0,clearTimeout:()=>{},Date,
 });
 const selection=source.slice(source.indexOf('const clips='),source.indexOf('function toast('));
 const runtime=source.slice(source.indexOf('function closeRequestModal('),source.indexOf('\nconst disabled='));
 const views=source.slice(source.indexOf('const disabled='),source.indexOf('function bindVideo('));
 const dialogs=source.slice(source.indexOf('function openModal('),source.indexOf('async function boot('));
 vm.runInContext(selection+runtime+views+dialogs,context);
 context.operationMarkup=()=>'';context.updateRuntimeUI=()=>{};
 vm.runInContext('render()',context);
 const clickAction=async(name,id)=>{
  const markup=roots['#modal-root'].innerHTML||roots['#app'].innerHTML;
  const tag=[...markup.matchAll(/<(button|a)\b[^>]*>/g)].map(m=>m[0]).find(tag=>tag.includes(`data-action="${name}"`)&&(!id||tag.includes(`data-id="${id}"`)));
  assert.ok(tag,`${name} must be present in the current interface`);
  await click({target:{closest:()=>({dataset:{action:name,id},disabled:/\sdisabled(?:\s|>)/.test(tag)})}});
 };
 return {context,roots,requests,notices,click:clickAction,escape:()=>keydown({key:'Escape'}),saved:()=>createBrowserDemo(fixtures,{storage:{getItem:key=>storage.get(key)}})('/api/state')};
}
test('rendered interface completes the synthetic teaching, comparison, publication and deduplicated evidence loop',async()=>{
 const ui=await studio();
 assert.match(ui.roots['#app'].innerHTML,/Ready to teach/);
 await ui.click('publish');assert.equal(ui.requests.length,0,'Disabled publication cannot submit');
 await ui.click('generate');assert.equal(ui.context.state.versions.length,1);
 await ui.click('evaluate');assert.equal(ui.context.state.evaluations[0].metrics.correct,4);
 assert.match(ui.roots['#app'].innerHTML,/Inspect the near-misses/);
 await ui.click('publish');assert.equal(ui.context.state.versions[0].status,'evaluated');
 await ui.click('inspect-clip','holdout-02');assert.equal(ui.context.selectedClipId,'holdout-02');
 await ui.click('correct');assert.match(ui.roots['#modal-root'].innerHTML,/train-negative-01\.mp4/);
 ui.escape();assert.equal(ui.context.modalName,null);assert.equal(ui.context.state.versions.length,1);
 await ui.click('correct');await ui.click('confirm-correct');assert.equal(ui.context.state.versions.length,2);
 assert.equal(ui.context.modalName,null);assert.match(ui.roots['#app'].innerHTML,/The result is not known yet/);
 await ui.click('evaluate');assert.equal(ui.context.state.evaluations.at(-1).metrics.correct,6);
 assert.match(ui.roots['#app'].innerHTML,/2 predictions changed; 4 unchanged/);
 await ui.click('evaluate');assert.equal(ui.context.state.evaluations.length,2,'Repeated evaluation uses the saved result');
 await ui.click('publish');await ui.click('replay');await ui.click('replay');
 assert.equal(ui.context.state.ledger.length,1);assert.match(ui.notices.at(-1).message,/already has an event/);
 await ui.click('evidence',ui.context.state.ledger[0].id);
 assert.match(ui.roots['#modal-root'].innerHTML,/No sponsor inference was executed/);
 await ui.click('close');await ui.click('versions');await ui.click('select-version','v1');
 assert.equal(ui.context.selectedVersionId,'v1');assert.match(ui.roots['#app'].innerHTML,/Inspect the near-misses/);
 await ui.click('versions');await ui.click('select-version','v2');
 assert.equal(ui.context.selectedVersionId,'v2');assert.match(ui.roots['#app'].innerHTML,/Same footage\. Two saved decisions/);
 const saved=await ui.saved();assert.equal(saved.versions.length,2);assert.equal(saved.ledger.length,1);
 assert.equal(saved.versions[1].status,'published');assert.deepEqual(saved.evaluations.map(e=>e.metrics.correct),[4,6]);
});
test('canceling reset preserves the experiment; confirming reset produces a clean usable studio',async()=>{
 const ui=await studio();await ui.click('generate');await ui.click('versions');await ui.click('reset-confirm');
 await ui.click('close');assert.equal(ui.context.state.versions.length,1);
 await ui.click('versions');await ui.click('reset-confirm');await ui.click('reset');
 assert.equal(ui.context.state.versions.length,0);assert.equal(ui.context.state.ledger.length,0);
 assert.equal(ui.context.modalName,null);assert.match(ui.roots['#app'].innerHTML,/Ready to teach/);
 await ui.click('generate');assert.equal(ui.context.state.versions.length,1);
});
