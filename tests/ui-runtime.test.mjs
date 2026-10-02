import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {operationActive} from '../public/workflow-state.js';
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const runtime=source.slice(source.indexOf('function closeRequestModal('),source.indexOf('\nconst disabled='));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}};
function harness({request,localTransport=true}={}){
 const calls=[],frames=[];
 const context=vm.createContext({
  state:{versions:[{id:'v1',mode:'demo'}],evaluations:[],operation:null},mode:'demo',selectedVersionId:'v1',
  pollTimer:null,clearTimeout:()=>{},setTimeout:()=>calls.push('poll'),document:{hidden:false},
  busy:null,pendingAction:null,recovering:false,cancelPending:false,localRequestInFlight:false,
  modalName:'correct',modalRevision:1,localTransport,operationActive,request,
  render:()=>calls.push('render'),schedulePoll:()=>calls.push('poll'),updateRuntimeUI:()=>{},
  toast:message=>calls.push(message),currentEval:()=>null,
  closeModal:()=>{if(context.modalName){calls.push(`close:${context.modalName}`);context.modalName=null;context.modalRevision++}},
  $:selector=>({focus:()=>calls.push(`focus:${selector}`)}),requestAnimationFrame:fn=>frames.push(fn),Date,
 });
 vm.runInContext(runtime,context);
 return {context,calls,frames,action:()=>vm.runInContext("action('correct','/api/correct',{versionId:'v1'},'Correction saved.')",context)};
}
const corrected=()=>({result:{id:'v2'},state:{versions:[{id:'v1',mode:'demo'},{id:'v2',mode:'demo'}],evaluations:[],operation:{id:'op2',type:'correct',status:'succeeded'}}});
test('normal correction selects its version, dismisses only its own dialog and focuses testing',async()=>{
 const pending=deferred(),h=harness({request:()=>pending.promise});const work=h.action();
 assert.equal(h.context.pendingAction.modalRevision,1);pending.resolve(corrected());await work;
 assert.equal(h.context.selectedVersionId,'v2');assert.equal(h.context.modalName,null);
 assert.deepEqual(h.calls.filter(c=>c.startsWith('close:')),['close:correct']);
 h.frames.forEach(fn=>fn());assert.ok(h.calls.includes('focus:[data-action="evaluate"]:not(:disabled)'));
});
test('a late correction preserves a newer dialog, even when it has the same name',async()=>{
 for(const nextDialog of ['versions','correct']){
  const pending=deferred(),h=harness({request:()=>pending.promise});const work=h.action();
  h.context.modalName=nextDialog;h.context.modalRevision=3;
  pending.resolve(corrected());await work;h.frames.forEach(fn=>fn());
  assert.equal(h.context.modalName,nextDialog);assert.equal(h.context.selectedVersionId,'v2');
  assert.equal(h.calls.some(c=>c.startsWith('close:')||c.startsWith('focus:')),false);
 }
});
test('a late correction never changes a newer mode or version selection',async()=>{
 const pending=deferred(),h=harness({request:()=>pending.promise});const work=h.action();
 h.context.mode='live';h.context.selectedVersionId='live-3';h.context.modalName=null;h.context.modalRevision=2;
 pending.resolve(corrected());await work;h.frames.forEach(fn=>fn());
 assert.equal(h.context.mode,'live');assert.equal(h.context.selectedVersionId,'live-3');
 assert.equal(h.calls.some(c=>c.startsWith('focus:')),false);
});
test('a dialog opened before the focus animation frame keeps keyboard focus',async()=>{
 const h=harness({request:async()=>corrected()});await h.action();
 h.context.modalName='versions';h.context.modalRevision++;
 h.frames.forEach(fn=>fn());assert.equal(h.calls.some(c=>c.startsWith('focus:')),false);
});
test('response recovery retains newer navigation and never resubmits the correction',async()=>{
 const pending=deferred(),requests=[];
 const h=harness({localTransport:null,request:async path=>{requests.push(path);if(path==='/api/state')return corrected().state;return pending.promise}});
 const work=h.action();h.context.modalName='audit';h.context.modalRevision=2;pending.reject(new Error('Connection lost'));await work;
 assert.deepEqual(requests,['/api/correct','/api/state']);assert.equal(h.context.modalName,'audit');
 assert.equal(h.context.selectedVersionId,'v2');assert.equal(h.context.pendingAction,null);
 assert.equal(h.calls.some(c=>c.startsWith('close:')||c.startsWith('focus:')),false);
});
test('an interrupted request tracks saved running work while leaving a newer dialog alone',async()=>{
 const pending=deferred(),requests=[];
 const running={...corrected().state,operation:{id:'op2',type:'correct',status:'running'}};
 const h=harness({localTransport:null,request:async path=>{requests.push(path);if(path==='/api/state')return running;return pending.promise}});
 const work=h.action();h.context.modalName='versions';h.context.modalRevision=2;pending.reject(new Error('Connection lost'));await work;
 assert.deepEqual(requests,['/api/correct','/api/state']);assert.equal(h.context.modalName,'versions');
 assert.equal(h.context.busy,'correct');assert.ok(h.context.pendingAction);assert.ok(h.calls.includes('poll'));
 h.context.state=corrected().state;vm.runInContext('finishPendingFromState()',h.context);
 assert.equal(h.context.modalName,'versions');assert.equal(h.context.pendingAction,null);
});

test('repeat clicks while a correction is pending do not duplicate the request',async()=>{
 const pending=deferred();let count=0;
 const h=harness({request:()=>{count++;return pending.promise}}),work=h.action();
 await h.action();assert.equal(count,1);pending.resolve(corrected());await work;
 assert.equal(count,1);
});
test('closing a pending correction is respected when its saved result arrives',async()=>{
 const pending=deferred(),h=harness({request:()=>pending.promise}),work=h.action();
 h.context.closeModal();pending.resolve(corrected());await work;h.frames.forEach(fn=>fn());
 assert.equal(h.context.modalName,null);assert.equal(h.context.selectedVersionId,'v2');
 assert.equal(h.calls.filter(c=>c.startsWith('close:')).length,1);
 assert.equal(h.calls.some(c=>c.startsWith('focus:')),false);
});

const clickHandler=source.slice(source.indexOf("document.addEventListener('click',async"),source.indexOf("document.addEventListener('keydown',"));
test('readiness verification neither reopens a dismissed dialog nor replaces its in-progress form',async()=>{
 for(const dismiss of [false,true]){
  const pending=deferred(),calls=[];let click;
  const button={disabled:false,innerHTML:'Verify connections',dataset:{action:'check-connections'}};
  const context=vm.createContext({document:{addEventListener:(_name,fn)=>{click=fn}},state:{},busy:null,
   modalName:'connections',request:()=>pending.promise,operationActive,icon:()=>'',
   render:()=>calls.push('render'),updateRuntimeUI:()=>calls.push('update-readiness'),schedulePoll:()=>{},toast:()=>{},
   connections:()=>calls.push('replace-dialog')});
  vm.runInContext(clickHandler,context);
  const work=click({target:{closest:()=>button}});assert.equal(button.disabled,true);
  if(dismiss)context.modalName=null;
  pending.resolve({state:{readiness:[{id:'vast',status:'ready'}]}});await work;
  assert.equal(context.modalName,dismiss?null:'connections');assert.equal(button.disabled,false);
  assert.deepEqual(calls,['render','update-readiness']);
 }
});
test('replacing a dialog keeps the original return-focus target',()=>{
 const dialogs=source.slice(source.indexOf('function openModal('),source.indexOf('function connections('));
 const calls=[],original={isConnected:true,focus:()=>calls.push('original-focus')},modalControl={isConnected:false};
 const context=vm.createContext({modalName:null,modalRevision:0,priorFocus:null,document:{activeElement:original},
  $$:()=>[],$:()=>({innerHTML:'',focus:()=>{}}),icon:()=>'',setTimeout:()=>{}});
 vm.runInContext(dialogs,context);vm.runInContext("openModal('versions','Versions','','')",context);
 context.document.activeElement=modalControl;vm.runInContext("openModal('reset','Reset','','')",context);
 assert.equal(context.modalRevision,2);assert.equal(context.priorFocus,original);
 vm.runInContext('closeModal()',context);assert.equal(context.modalRevision,3);
 assert.deepEqual(calls,['original-focus']);
});

test('cancelling reloaded server work reaches a terminal state and restores usable controls',async()=>{
 const requests=[];
 const running={versions:[],evaluations:[],busy:true,operation:{id:'op-reloaded',type:'generate',status:'running',cancellable:true}};
 const cancelling={...running,operation:{...running.operation,status:'cancelling',cancellable:false}};
 const cancelled={...running,busy:false,operation:{...running.operation,status:'cancelled',cancellable:false}};
 const h=harness({localTransport:null,request:async path=>{requests.push(path);return path==='/api/cancel'?{state:cancelling}:cancelled}});
 h.context.state=running;h.context.busy='generate';h.context.modalName='cancel-operation';let click;
 h.context.document.addEventListener=(_name,fn)=>{click=fn};vm.runInContext(clickHandler,h.context);
 await click({target:{closest:()=>({dataset:{action:'confirm-cancel'}})}});
 assert.equal(h.context.state.operation.status,'cancelling');assert.equal(h.context.cancelPending,true);
 await vm.runInContext('refreshRecordedState()',h.context);
 assert.equal(h.context.state.operation.status,'cancelled');assert.equal(h.context.busy,null);
 assert.equal(h.context.cancelPending,false);assert.equal(h.context.pendingAction,null);
 assert.deepEqual(requests,['/api/cancel','/api/state']);
});
test('a cancellation racing completed work refreshes state without cancelling twice or dismissing newer navigation',async()=>{
 const pending=deferred(),requests=[];
 const h=harness({localTransport:null,request:async path=>{requests.push(path);return path==='/api/cancel'?pending.promise:corrected().state}});
 h.context.state={...corrected().state,busy:true,operation:{id:'op2',type:'correct',status:'running',cancellable:true}};
 h.context.busy='correct';h.context.modalName='cancel-operation';let click;
 h.context.document.addEventListener=(_name,fn)=>{click=fn};vm.runInContext(clickHandler,h.context);
 const work=click({target:{closest:()=>({dataset:{action:'confirm-cancel'}})}});
 h.context.modalName='audit';h.context.modalRevision++;
 pending.reject(new Error('This operation has already finished.'));await work;
 assert.equal(h.context.busy,null);assert.equal(h.context.cancelPending,false);assert.equal(h.context.modalName,'audit');
 assert.deepEqual(requests,['/api/cancel','/api/state']);
});
test('network loss blocks repeated mutation until recorded state is recovered',async()=>{
 let recovered=false;const requests=[];
 const h=harness({localTransport:null,request:async path=>{requests.push(path);if(recovered&&path==='/api/state')return corrected().state;throw new Error('Offline')}});
 await h.action();assert.equal(h.context.recovering,true);assert.equal(h.context.busy,'recovering');
 await h.action();assert.deepEqual(requests,['/api/correct','/api/state']);
 recovered=true;await vm.runInContext('refreshRecordedState()',h.context);
 assert.equal(h.context.recovering,false);assert.equal(h.context.busy,null);assert.equal(h.context.selectedVersionId,'v2');
 assert.deepEqual(requests,['/api/correct','/api/state','/api/state']);
});

test('late replay presentation respects newer modal, mode, version, and clip navigation',async()=>{
 for(const navigate of [null,'modal','dismissed-modal','mode','version','clip']){
  const pending=deferred(),presented=[],focused=[];let click;
  const context=vm.createContext({document:{addEventListener:(_name,fn)=>{click=fn}},
   state:{},mode:'demo',selectedClipId:'train-positive',selectedVersionId:'v2',modalName:null,modalRevision:0,
   currentVersion:()=>({id:context.selectedVersionId}),action:()=>pending.promise,
   showReplayResult:(...args)=>presented.push(args),$:selector=>({focus:()=>focused.push(selector)})});
  vm.runInContext(clickHandler,context);
  const work=click({target:{closest:()=>({dataset:{action:'replay'}})}});
  if(navigate==='modal'){context.modalName='versions';context.modalRevision++;}
  if(navigate==='dismissed-modal')context.modalRevision+=2;
  if(navigate==='mode')context.mode='live';
  if(navigate==='version')context.selectedVersionId='v1';
  if(navigate==='clip')context.selectedClipId='holdout-02';
  pending.resolve({result:{events:[{id:'saved-event'}]}});await work;
  assert.equal(presented.length,navigate?0:1,`${navigate||'unchanged'} navigation`);
  assert.equal(focused.length,navigate?0:1);
  if(!navigate)assert.equal(presented[0][1],'v2');
 }
});
test('automatic replay presentation restores focus to a connected new control after rendering',async()=>{
 let click;const focused=[],root={innerHTML:''},oldButton={isConnected:false};
 const context=vm.createContext({document:{activeElement:oldButton,addEventListener:(_name,fn)=>{click=fn}},
  state:{},mode:'demo',selectedClipId:'clip',modalName:null,modalRevision:0,priorFocus:null,
  currentVersion:()=>({id:'v2'}),action:async()=>({result:{events:[{id:'saved'}]}}),
  $$:()=>[],icon:()=>'',setTimeout:()=>{},
 });
 const newButton={isConnected:true,focus:()=>{focused.push('new-replay-control');context.document.activeElement=newButton}};
 context.$=selector=>selector==='#modal-root'?root:newButton;
 const dialogs=source.slice(source.indexOf('function openModal('),source.indexOf('function connections('));
 vm.runInContext(dialogs,context);context.showReplayResult=()=>vm.runInContext("openModal('evidence','Recorded event','','')",context);
 vm.runInContext(clickHandler,context);
 await click({target:{closest:()=>({dataset:{action:'replay'}})}});
 assert.equal(context.priorFocus,newButton);assert.equal(context.modalName,'evidence');
 vm.runInContext('closeModal()',context);assert.equal(context.document.activeElement,newButton);
 assert.deepEqual(focused,['new-replay-control','new-replay-control']);
});
