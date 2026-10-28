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

test('F09b3 request gateway allows exact explicit local pilot shape but never normal writes',async()=>{
 const URL='/api/plugins/similharity/v2/workflows/chat-sync-pilot-apply';
 const b={...base,embedding:{...base.embedding,source:'transformers'},
  sourceRevisionFingerprint:'a'.repeat(64),experimentalConsent:'I ACCEPT LOCAL CHAT SYNC PILOT'};
 assert.equal(inspectVectorRequest(URL,{method:'POST',body:JSON.stringify(b)}).allowed,true);
 for(const forged of [{...b,text:'bad'},{...b,vector:[1,2,3]},
   {...b,operationId:one},{...b,ownerId:'bob'},
   {...b,embedding:{...b.embedding,source:'webllm'}},{...b,configId:'default'},
   {...b,experimentalConsent:'not consent'}])
  assert.throws(()=>inspectVectorRequest(URL,{method:'POST',body:JSON.stringify(forged)}),VectorOperationDenied);
 for(const pluginBackend of ['lancedb','vectra','milvus']){
  const x={...b,backend:pluginBackend,configId:'default'};
  assert.equal(inspectVectorRequest(URL,{method:'POST',body:JSON.stringify(x)}).allowed,true);
 }
 const outcome={success:true,experimental:true,status:'VERIFIED',applied:1,remaining:0,productionWritesEnabled:false};
 let request;const result=await f09b3ApplyOneChatSync(b,{},async(url,init)=>{request={url,init};return {ok:true,json:async()=>outcome};});
 assert.equal(result.applied,1);assert.equal(request.init.headers['X-VectHare-F09b3-Pilot'],'1');
 await assert.rejects(f09b3ApplyOneChatSync(b,{},async()=>({ok:true,json:async()=>({...outcome,productionWritesEnabled:true})})),/UNVERIFIED/);
});

test('F09b4 gateway/client allow only exact verified message operations and never legacy deletion',async()=>{
 const URL='/api/plugins/similharity/v2/workflows/chat-lifecycle-pilot';
 const b={...base,embedding:{...base.embedding,source:'transformers'},sourceRevisionFingerprint:'a'.repeat(64),
  messageIndex:1,action:'delete',experimentalConsent:'I ACCEPT EXACT MESSAGE VECTOR DELETE PILOT'};
 assert.equal(inspectVectorRequest(URL,{method:'POST',body:JSON.stringify(b)}).allowed,true);
 for(const extra of [{recordId:one},{ownerId:'bob'},{vector:[1,2,3]},{messageIndex:-1},
  {experimentalConsent:'yes'},{operationId:one},{configId:'default'},{source:{...base.source,path:'/tmp'}}]){
  assert.throws(()=>inspectVectorRequest(URL,{method:'POST',body:JSON.stringify({...b,...extra})}),VectorOperationDenied);
 }
 const ok={success:true,experimental:true,status:'VERIFIED',action:'delete',recordId:one,
  operationId:two,productionWritesEnabled:false,retryable:false};
 const response=await f09b4LifecyclePilot(b,{},async()=>({ok:true,status:200,json:async()=>ok}));
 assert.equal(response.status,'VERIFIED');
 await assert.rejects(f09b4LifecyclePilot(b,{},async()=>({ok:true,status:200,json:async()=>({...ok,productionWritesEnabled:true})})),/UNVERIFIED/);
 const inspection={...b,action:'inspect',operationId:two};delete inspection.experimentalConsent;
 assert.equal(inspectVectorRequest(URL,{method:'POST',body:JSON.stringify(inspection)}).allowed,true);
 const receipt=await f09b4LifecyclePilot(inspection,{},async()=>({ok:true,status:200,json:async()=>({...ok,status:'RECEIPT_INSPECTED',state:'UNCERTAIN',readbackObservation:'RECORD_ABSENT_NOT_FINAL_PROOF'})}));
 assert.equal(receipt.state,'UNCERTAIN');
});

test('F09b4 managed orphan requests cannot supply records and require explicit consent',async()=>{
 const URL='/api/plugins/similharity/v2/workflows/chat-orphan-pilot';
 const b={...base,embedding:{...base.embedding,source:'transformers'},mode:'preview'};
 assert.equal(inspectVectorRequest(URL,{method:'POST',body:JSON.stringify(b)}).allowed,true);
 const ok={success:true,experimental:true,status:'MANAGED_ORPHAN_PREVIEW',sourceVerified:true,
  sourceRevisionFingerprint:'a'.repeat(64),registryFingerprint:'b'.repeat(64),
  orphanCount:1,pendingCount:0,tombstoneCount:0,orphans:[{index:0,revision:1,recordId:one,textPreview:'hello'}],completeBackendInventory:false,
  legacyOrphansNotDiscoverable:true,productionWritesEnabled:false,retryable:false};
 assert.equal((await f09b4ManagedOrphanPilot(b,{},async()=>({ok:true,status:200,json:async()=>ok}))).orphanCount,1);
 const del={...b,mode:'delete',orphanIndex:0,sourceRevisionFingerprint:ok.sourceRevisionFingerprint,
  registryFingerprint:ok.registryFingerprint,experimentalConsent:'I ACCEPT VERIFIED MANAGED ORPHAN DELETE PILOT'};
 assert.equal(inspectVectorRequest(URL,{method:'POST',body:JSON.stringify(del)}).allowed,true);
 for(const bad of [{recordId:one},{ownerId:'bob'},{vector:[1,2,3]},
  {experimentalConsent:'no'},{orphanIndex:-1},{registryFingerprint:'bad'}]){
  assert.throws(()=>inspectVectorRequest(URL,{method:'POST',body:JSON.stringify({...del,...bad})}),VectorOperationDenied);
 }
 const verified={success:true,experimental:true,status:'VERIFIED',action:'managed-orphan-delete',
  recordId:one,operationId:two,productionWritesEnabled:false,retryable:false};
 assert.equal((await f09b4ManagedOrphanPilot(del,{},async()=>({ok:true,status:200,json:async()=>verified}))).status,'VERIFIED');
 await assert.rejects(f09b4ManagedOrphanPilot(del,{},async()=>({ok:true,status:200,json:async()=>({...verified,productionWritesEnabled:true})})),/UNVERIFIED/);
});
