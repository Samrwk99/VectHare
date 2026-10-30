import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {validateF09bSyncPlan,f09bPreviewChatSync,f09b3ApplyOneChatSync,f09b4LifecyclePilot,f09b4ManagedOrphanPilot,renderF09bChatSyncPreview} from '../utils/f09b-sync-preview.js';
const base={backend:'qdrant',configId:'local',source:{kind:'chat',avatar:'Nina.png',chatFile:'one'},
 embedding:{source:'webllm',model:'m',dimension:3,metric:'cosine'}};
const one=randomUUID(),two=randomUUID();
const reply={success:true,status:'READ_ONLY_SYNC_PLAN',sourceVerified:true,
 sourceRevisionFingerprint:'a'.repeat(64),recordIdentity:'V2_STABLE_HOST_MESSAGE_UUID',
 productionWritesEnabled:false,automaticMutationsEnabled:false,completeInventory:false,deletionsPlanned:false,
 sourceMessagesChecked:2,actions:[{recordId:one,action:'CREATE_PENDING_EMBEDDING',expectedRevision:0},
 {recordId:two,action:'IN_SYNC',expectedRevision:3}],counts:{create:1,update:0,inSync:1}};
const URI='/api/plugins/similharity/v2/workflows/chat-sync-plan';
test('F09b sync route gateway is read-only with exact selector and no owner/text input',()=>{
 assert.equal(inspectVectorRequest(URI,{method:'POST',body:JSON.stringify(base)}).allowed,true);
 for(const b of [{...base,userScopeId:'attacker'},{...base,text:'content from browser'},
  {...base,source:{...base.source,path:'/etc/shadow'}},{...base,recordId:one},
  {...base,embedding:{...base.embedding,apiKey:'secret'}}])
  assert.throws(()=>inspectVectorRequest(URI,{method:'POST',body:JSON.stringify(b)}),VectorOperationDenied);
 assert.throws(()=>inspectVectorRequest(URI,{method:'GET'}),VectorOperationDenied);
});
test('F09b sync client requires explicit no-write contract, counts and UUID revisions',async()=>{
 let called;
 const out=await f09bPreviewChatSync(base,{},async(url,init)=>{called={url,init};return {ok:true,json:async()=>reply};});
 assert.equal(out.counts.create,1);assert.equal(called.url,URI);assert.equal(called.init.credentials,'same-origin');
 for(const bad of [{productionWritesEnabled:true},{automaticMutationsEnabled:true},
  {completeInventory:true},{deletionsPlanned:true},{sourceVerified:false},
  {counts:{create:2,update:0,inSync:1}},
  {actions:[{recordId:'numeric-hash',action:'CREATE_PENDING_EMBEDDING',expectedRevision:0}]}])
  assert.throws(()=>validateF09bSyncPlan({...reply,...bad}));
});
test('F09b sync panel is inert on render and does not auto-save or write',()=>{
 const calls=[];const root={querySelector:()=>null,prepend(){calls.push('append')}};
 const doc={createTextNode:value=>({textContent:value}),createElement:tag=>({tag,append(){},addEventListener(e){calls.push(e);},setAttribute(){}})};
 assert.equal(renderF09bChatSyncPreview(root,()=>({}),doc),true);
 assert.deepEqual(calls,['click','click','click','click','click','click','click','click','append']);
});

test('M0 F09b3 legacy pilot is blocked across backends, without network dispatch',async()=>{
 const url='/api/plugins/similharity/v2/workflows/chat-sync-pilot-apply';
 const valid={...base,embedding:{...base.embedding,source:'transformers'},sourceRevisionFingerprint:'a'.repeat(64),
  experimentalConsent:'I ACCEPT LOCAL CHAT SYNC PILOT'};
 for(const backend of ['qdrant','lancedb','vectra','milvus']){
  const body={...valid,backend,configId:backend==='qdrant'?'local':'default'};
  assert.throws(()=>inspectVectorRequest(url,{method:'POST',body:JSON.stringify(body)}),VectorOperationDenied);
 }
 let calls=0;await assert.rejects(()=>f09b3ApplyOneChatSync(valid,{},async()=>{calls++;return {ok:true};}),VectorOperationDenied);
 assert.equal(calls,0);
});

test('M0 F09b4 chat lifecycle pilot is blocked, including read-then-delete aliases',async()=>{
 const url='/api/plugins/similharity/v2/workflows/chat-lifecycle-pilot';
 const valid={...base,embedding:{...base.embedding,source:'transformers'},sourceRevisionFingerprint:'a'.repeat(64),
  messageIndex:1,action:'delete',experimentalConsent:'I ACCEPT EXACT MESSAGE VECTOR DELETE PILOT'};
 assert.throws(()=>inspectVectorRequest(url,{method:'POST',body:JSON.stringify(valid)}),VectorOperationDenied);
 let calls=0;await assert.rejects(()=>f09b4LifecyclePilot(valid,{},async()=>{calls++;return {ok:true};}),VectorOperationDenied);
 assert.equal(calls,0);
});

test('M0 F09b4 managed orphan operation is blocked until M5 gateway migration',async()=>{
 const url='/api/plugins/similharity/v2/workflows/chat-orphan-pilot';
 const valid={...base,embedding:{...base.embedding,source:'transformers'},mode:'preview'};
 assert.throws(()=>inspectVectorRequest(url,{method:'POST',body:JSON.stringify(valid)}),VectorOperationDenied);
 let calls=0;await assert.rejects(()=>f09b4ManagedOrphanPilot(valid,{},async()=>{calls++;return {ok:true};}),VectorOperationDenied);
 assert.equal(calls,0);
});
