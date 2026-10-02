import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createBrowserDemo} from '../public/browser-demo.js';
import {versionComparison} from '../public/workflow-state.js';
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const fixtures=JSON.parse(await readFile(new URL('../public/fixture-data.json',import.meta.url),'utf8'));
// Run the real template functions with recorded state, without a browser or network.
function view(state,{mode='demo'}={}){let modal;const context=vm.createContext({state,mode,versionComparison,
 esc:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
 icon:()=>'',clips:()=>state.clips,training:()=>state.clips.filter(c=>c.split==='TRAIN'),poster:c=>c?.posterUrl||'',clipUrl:c=>c.videoUrl,
 currentVersion:()=>state.versions.at(-1),currentEval:()=>state.evaluations.filter(e=>e.versionId===state.versions.at(-1)?.id).at(-1),openModal:(...args)=>{modal=args}});
 vm.runInContext(source.slice(source.indexOf('function showCorrection()'),source.indexOf('\nfunction showEvidence')),context);
 return {proof:()=>vm.runInContext('renderLearningProof(state.versions.at(-1),state.evaluations.filter(e=>e.versionId===state.versions.at(-1).id).at(-1))',context),correction:()=>{vm.runInContext('showCorrection()',context);return modal}};
}
test('real teaching templates render only recorded results and distinct TRAIN correction footage',async()=>{
 const request=createBrowserDemo(fixtures,{storage:null});let out=await request('/api/generate');const first=out.result.id;
 out=await request('/api/evaluate',{versionId:first});
 const baseline=view(out.state);assert.match(baseline.proof(),/Inspect the near-misses/);assert.match(baseline.proof(),/data-action="inspect-clip" data-id="holdout-02"/);
 const modal=baseline.correction();assert.match(modal[3],/train-negative-01.mp4/);assert.match(modal[3],/train-negative-02.mp4/);assert.doesNotMatch(modal[3],/holdout-0[1-6]\.mp4/);assert.match(modal[3],/no model is being trained or called/);
 out=await request('/api/correct',{versionId:first,trainingClipIds:['train-negative-01','train-negative-02']});const second=out.result.id;
 const pending=view(out.state).proof();assert.match(pending,/The result is not known yet/);assert.doesNotMatch(pending,/Two saved decisions/);
 out=await request('/api/evaluate',{versionId:second});const rendered=view(out.state).proof();
 assert.match(rendered,/Same footage. Two saved decisions/);assert.match(rendered,/2 predictions changed; 4 unchanged/);assert.match(rendered,/Synthetic fixture agreement only/);assert.match(rendered,/v1 EVENT/);assert.match(rendered,/v2 NO EVENT/);
 assert.match(rendered,/data-action="inspect-clip" data-id="holdout-03"/);
 out.state.versions.at(-1).rule.definition='<script>alert(1)</script>';
 assert.doesNotMatch(view(out.state).proof(),/<script>/);assert.match(view(out.state).proof(),/&lt;script&gt;/);
});

test('partial teaching keeps the remaining wrong decision visible and avoids repeating a learned fixture lesson',async()=>{
 const request=createBrowserDemo(fixtures,{storage:null});let out=await request('/api/generate');const first=out.result.id;
 await request('/api/evaluate',{versionId:first});
 out=await request('/api/correct',{versionId:first,trainingClipIds:['train-negative-01']});const second=out.result.id;
 out=await request('/api/evaluate',{versionId:second});
 const partial=view(out.state),proof=partial.proof(),modal=partial.correction();
 assert.match(proof,/1 prediction changed; 5 unchanged/);
 assert.match(proof,/Remaining holdout disagreements/);
 assert.match(proof,/1 disagreement<\/span>/);
 assert.match(proof,/data-action="inspect-clip" data-id="holdout-03"/);
 assert.match(modal[3],/value="train-negative-01" disabled/);
 assert.match(modal[3],/value="train-negative-02" checked/);
 assert.match(modal[3],/ALREADY INCLUDED/);
 out=await request('/api/correct',{versionId:second,trainingClipIds:['train-negative-02']});
 out=await request('/api/evaluate',{versionId:out.result.id});
 assert.doesNotMatch(view(out.state).proof(),/Remaining holdout disagreements/);
 assert.match(view(out.state).correction()[4],/data-action="confirm-correct" disabled/);
});
test('missing live counterexamples explain the next step instead of offering an empty correction',()=>{
 const state={clips:[],versions:[{id:'v1',mode:'live',trainingClipIds:[]}],evaluations:[{id:'e1',versionId:'v1',results:[]}]};
 const modal=view(state,{mode:'live'}).correction();
 assert.match(modal[3],/No negative TRAIN examples are available/);
 assert.match(modal[3],/data-action="connections"/);
 assert.match(modal[4],/data-action="confirm-correct" disabled/);
 assert.doesNotMatch(modal[3],/no model is being trained or called/);
});
test('uncertain holdout predictions stay visibly unresolved rather than being described as confirmed false alerts',()=>{
 const state={clips:[],versions:[{id:'v1',mode:'live'}],evaluations:[{id:'e1',versionId:'v1',results:[{clipId:'held',expected:false,predicted:null,correct:false}]}]};
 const proof=view(state,{mode:'live'}).proof();
 assert.match(proof,/UNCERTAIN/);assert.match(proof,/not confirmed false alerts/);
});
