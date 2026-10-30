import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {collectionIdentity,contentFingerprint,recordIdentity} from '../lib/s02-identity.js';
import {M1TicketStore,validateM1Intent,savedRecordIdentity,makeSavedRecordV2,
 previewM1Records,planM1Record,executeM1Record,registerM1Routes,prepareM1Collection,provisionM1Collection} from '../lib/m1-saved-records.js';
import {ManagedChatRegistry} from '../lib/f09b4-managed-registry.js';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const profile={source:'transformers',model:'fixture',dimension:3,metric:'cosine'};
const source={kind:'chat',avatar:'alice.png',chatFile:'chat-1'};
const scope={userScopeId:'alice',collectionId:'chat-1',type:'chat',sourceId:'chat-1'};
const ident=collectionIdentity({backend:'qdrant',scope,embedding:profile});
const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',scope,embedding:profile,
 collection:{key:ident.key,physicalName:ident.physicalName}};
const msg={recordId:'eabb4525-29cc-8bbc-af01-22decd92ae77',text:'hello',contentHash:contentFingerprint('hello')};
async function fixture(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'m1-record-'));await fs.chmod(dir,0o700);
 const req={s03:{userScopeId:'alice',vectorsPath:dir},user:{directories:{}},body:null};
 const state={messages:[{...msg}],fileHash:hash('saved-chat'),sourceId:scope.sourceId,sourceKind:'chat'};
 const rows=new Map(),calls=[];
 const deps={getProfile:async()=>({configured:true,profile}),bind:async()=>({binding}),
  readSnapshot:async()=>structuredClone(state),getReceipt:async()=>({state:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED'}),
  readRecord:async(_req,_binding,id)=>structuredClone(rows.get(id)??null),
  tickets:ctx=>new M1TicketStore(ctx),registry:(ctx,b)=>new ManagedChatRegistry(ctx,b),
  certify:async()=>true,transport:async()=>({}),verifySchema:async()=>true,embed:async()=>[0.2,0.4,0.6],
  adapter:()=>({getRecord:async id=>structuredClone(rows.get(typeof id==='string'?id:id.recordId)??null)}),
  engine:()=>({execute:async(plan,payload)=>{
   calls.push(plan.action);
   if(plan.action==='delete')rows.delete(plan.recordId);
   else rows.set(plan.recordId,{recordId:plan.recordId,physicalId:recordIdentity(scope,plan.recordId).physicalId,
    scope,revision:plan.targetRevision,text:payload.text,metadata:payload.metadata,vector:payload.vector});
   return {state:'VERIFIED'};
  }})};
 return {dir,req,state,rows,calls,deps,recordId:savedRecordIdentity(req.s03,binding,msg).recordId,
 cleanup:()=>fs.rm(dir,{recursive:true,force:true})};
}
test('M1 intent refuses user-controlled metadata/text/owners/paths and local Milvus selector',()=>{
 const intent={backend:'qdrant',source,action:'insert',recordId:randomUUID()};
 assert.equal(validateM1Intent(intent),intent);
 for(const extra of [{vector:[1,2,3]},{text:'injected'},{physicalName:'foreign'},{embedding:profile},{ownerId:'bob'}])
  assert.throws(()=>validateM1Intent({...intent,...extra}));
 assert.equal(validateM1Intent({...intent,backend:'milvus'}).backend,'milvus');
 assert.throws(()=>validateM1Intent({...intent,backend:'milvus',configId:'local'}),{code:'M1_REFERENCE_BACKEND_REQUIRED'});
 assert.throws(()=>validateM1Intent({...intent,source:{...source,filepath:'/private'}}));
});
test('M1 source-scoped preview, insert, update, revectorize, delete and explicit restore',async()=>{
 const f=await fixture();try{
  const {req,deps,recordId,rows,state}=f;
  req.body={backend:'qdrant',source};
  const preview=await previewM1Records(req,deps);
  assert.equal(preview.records[0].recordId,recordId);
  assert.deepEqual(preview.records[0].availableActions,['insert']);
  async function execute(action){
   req.body={backend:'qdrant',source,action,recordId};
   const plan=await planM1Record(req,ident.key,deps);
   assert.equal(plan.executionAllowed,false);
   req.body={operationId:plan.operationId,confirmation:'APPLY SAVED RECORD MUTATION'};
   const result=await executeM1Record(req,deps);
   assert.equal(result.state,'VERIFIED');
   await assert.rejects(()=>executeM1Record(req,deps),{code:'M1_TICKET_ALREADY_CONSUMED'});
  }
  await execute('insert');
  assert.equal(rows.get(recordId).metadata.vecthareRecordV2.schemaVersion,2);
  assert.equal(rows.get(recordId).metadata.vecthareRecordV2.recordId,recordId);
  assert.equal(rows.get(recordId).revision,1);
  state.messages[0].text='updated';state.messages[0].contentHash=contentFingerprint('updated');state.fileHash=hash('chat-updated');
  await execute('update');assert.equal(rows.get(recordId).revision,2);
  await execute('revectorize');assert.equal(rows.get(recordId).revision,3);
  await execute('delete');assert.equal(rows.size,0);
  const deleted=await new ManagedChatRegistry(req.s03,binding).read();
  assert.equal(deleted.records[recordId].state,'DELETED');
  req.body={backend:'qdrant',source,action:'insert',recordId};
  await assert.rejects(()=>planM1Record(req,ident.key,deps),{code:'M1_MANAGED_STATE_DENIED'});
  await execute('restore');assert.equal(rows.get(recordId).revision,1);
  assert.equal((await new ManagedChatRegistry(req.s03,binding).read()).records[recordId].state,'ACTIVE');
  assert.deepEqual(f.calls,['insert','update','update','delete','insert']);
 }finally{await f.cleanup();}
});
test('M1 rejects stale files, user scope, unauthorized sources, and blocks before dispatch',async()=>{
 const f=await fixture();try{
  const {req,deps,recordId,state,calls}=f;
  req.body={backend:'qdrant',source,action:'insert',recordId};
  const ticket=await planM1Record(req,ident.key,deps);
  state.fileHash=hash('changed');
  req.body={operationId:ticket.operationId,confirmation:'APPLY SAVED RECORD MUTATION'};
  await assert.rejects(()=>executeM1Record(req,deps),{code:'M1_STALE_PLAN_OR_PROFILE'});
  assert.equal(calls.length,0);
  req.body={backend:'qdrant',source,action:'insert',recordId};
  const again=await planM1Record(req,ident.key,deps);
  req.body={operationId:again.operationId,confirmation:'APPLY SAVED RECORD MUTATION'};
  await assert.rejects(()=>executeM1Record(req,{...deps,certify:async()=>false}),{code:'M1_CODE_GATE_REFUSED'});
  assert.equal(calls.length,0);
  req.s03.userScopeId='bob';
  await assert.rejects(()=>executeM1Record(req,deps),{code:'M1_TICKET_INVALID'});
 }finally{await f.cleanup();}
});
test('M1 plan cannot target foreign logical binding or arbitrary UUID',async()=>{
 const f=await fixture();try{
  f.req.body={backend:'qdrant',source,action:'insert',recordId:f.recordId};
  await assert.rejects(()=>planM1Record(f.req,'a'.repeat(64),f.deps),{code:'M1_COLLECTION_BINDING_MISMATCH'});
  await assert.rejects(()=>planM1Record(f.req,ident.key,{...f.deps,readSnapshot:async()=>({...f.state,messages:[]})}),
   {code:'M1_RECORD_NOT_SAVED'});
 }finally{await f.cleanup();}
});
test('M1 route registry preserves M0 legacy denials and returns sanitized response',async()=>{
 const router={post(p,fn){this['POST '+p]=fn;},get(p,fn){this['GET '+p]=fn;}};
 registerM1Routes(router,{});
 assert.ok(router['POST /v2/mutations/execute']);
 let r;const res={status(x){this.code=x;return this;},json(x){r={httpStatus:this.code??200,...x};return this;}};
 await router['POST /v2/mutations/execute']({body:{ownerId:'bob'}},res);
 assert.equal(r.success,false);assert.equal(r.executionAllowed,false);
});

test('M1 S04 real engine runs durable plan/lock/readback/registry transaction (disposable adapter)',async()=>{
 const f=await fixture();try{
  const {req,recordId}=f,physical=new Map();
  const adapter={
   async getRecord(p){return structuredClone(physical.get(typeof p==='string'?p:p.recordId)??null);},
   async insertRecord(p,payload){physical.set(p.recordId,{
    recordId:p.recordId,physicalId:p.physicalId,scope:p.scope,revision:p.targetRevision,
    text:payload.text,textHash:contentFingerprint(payload.text),vector:payload.vector,vectorReference:payload.vector,
    vectorHash:hash(payload.vector),metadata:payload.metadata,metadataHash:hash(payload.metadata)
   });},
   async updateRecord(p,payload){return this.insertRecord(p,payload);},
   async deleteRecord(p){physical.delete(p.recordId);}
  };
  // The production service does not receive these injected test dependencies.
  const deps={...f.deps,readRecord:async(_req,_binding,id)=>adapter.getRecord(id),adapter:()=>adapter};
  delete deps.engine;
  req.body={backend:'qdrant',source,action:'insert',recordId};
  const ticket=await planM1Record(req,ident.key,deps);
  req.body={operationId:ticket.operationId,confirmation:'APPLY SAVED RECORD MUTATION'};
  const result=await executeM1Record(req,deps);
  assert.equal(result.state,'VERIFIED');
  const receipt=JSON.parse(await fs.readFile(path.join(f.dir,'.similharity','s04-operations',ticket.operationId+'.json')));
  assert.equal(receipt.state,'VERIFIED');
  assert.deepEqual(receipt.history.map(h=>h.state),['PREPARED','SUBMITTED','VERIFIED']);
  assert.equal((await new ManagedChatRegistry(req.s03,binding).read()).records[recordId].state,'ACTIVE');
  req.body={backend:'qdrant',source,action:'delete',recordId};
  const second=await planM1Record(req,ident.key,deps);
  req.body={operationId:second.operationId,confirmation:'APPLY SAVED RECORD MUTATION'};
  assert.equal((await executeM1Record(req,deps)).state,'VERIFIED');
  assert.equal(physical.size,0);
  assert.equal((await new ManagedChatRegistry(req.s03,binding).read()).records[recordId].state,'DELETED');
 }finally{await f.cleanup();}
});
test('M1 injected post-dispatch ambiguity remains UNCERTAIN, never replayed or auto-cleared',async()=>{
 const f=await fixture();try{
  const {req,recordId}=f;let attempts=0;
  const adapter={async getRecord(){return null;},async insertRecord(){attempts++;throw Error('ack lost');},
   async updateRecord(){throw Error('unexpected');},async deleteRecord(){throw Error('unexpected');}};
  const deps={...f.deps,adapter:()=>adapter};delete deps.engine;
  req.body={backend:'qdrant',source,action:'insert',recordId};
  const ticket=await planM1Record(req,ident.key,deps);
  req.body={operationId:ticket.operationId,confirmation:'APPLY SAVED RECORD MUTATION'};
  const outcome=await executeM1Record(req,deps);
  assert.equal(outcome.state,'UNCERTAIN');assert.equal(outcome.manualRecoveryRequired,true);
  assert.equal(attempts,1);
  await assert.rejects(()=>executeM1Record(req,deps),{code:'M1_TICKET_ALREADY_CONSUMED'});
  assert.equal(attempts,1);
  const receipt=JSON.parse(await fs.readFile(path.join(f.dir,'.similharity','s04-operations',ticket.operationId+'.json')));
  assert.equal(receipt.state,'UNCERTAIN');
  const managed=await new ManagedChatRegistry(req.s03,binding).read();
  assert.equal(managed.records[recordId].state,'WRITE_PENDING');
 }finally{await f.cleanup();}
});

test('M1 real-host acceptance is admin-held and version-/operation-specific; no forged client evidence',async()=>{
 const {readM1HostEvidence}=await import('../lib/m1-saved-records.js');
 const {capabilityMatrix}=await import('../lib/m0-capabilities.js');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'m1-admin-'));await fs.chmod(root,0o700);
 try{
  assert.equal(await readM1HostEvidence('insert',{root,currentHostVersion:'st-1'}),null);
  const evidence={backend:'qdrant',operation:'insert',hostVersion:'st-1',realHostAccepted:true,
   disposableBackendAccepted:true,testRunId:'acceptance-2026-test',contractProbePassed:true,
   writerExclusivityAccepted:true};
  const file=path.join(root,'m1-real-host-acceptance.json');
  await fs.writeFile(file,JSON.stringify({schemaVersion:1,backend:'qdrant',hostVersion:'st-1',
   operations:{insert:evidence}}),{mode:0o600});
  assert.equal(await readM1HostEvidence('delete',{root,currentHostVersion:'st-1'}),null);
  assert.equal(await readM1HostEvidence('insert',{root,currentHostVersion:'st-2'}),null);
  const trusted=await readM1HostEvidence('insert',{root,currentHostVersion:'st-1'});
  const cells=capabilityMatrix({hostVersion:'st-1',evidenceByOperation:{'qdrant:insert':trusted}});
  assert.equal(cells.filter(c=>c.mode==='ENABLED').length,1);
  assert.equal(cells.find(c=>c.backend==='qdrant'&&c.operation==='insert').enabled,true);
  assert.equal(cells.find(c=>c.backend==='milvus'&&c.operation==='insert').enabled,false);
  await fs.chmod(file,0o644);
  assert.equal(await readM1HostEvidence('insert',{root,currentHostVersion:'st-1'}),null);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('M1 owned collection bootstrap makes server-only plan, refuses stale or uncertified requests',async()=>{
 const f=await fixture();try{
  const deps={...f.deps,getReceipt:async()=>null};
  f.req.body={backend:'qdrant',source};
  const plan=await prepareM1Collection(f.req,deps);
  assert.equal(plan.action,'provision');assert.equal(plan.logicalKey,ident.key);
  assert.equal(plan.executionAllowed,false);
  f.req.body={operationId:plan.operationId,confirmation:'CREATE OWNED V2 COLLECTION'};
  await assert.rejects(()=>provisionM1Collection(f.req,{...deps,certify:async()=>false}),{code:'M1_CODE_GATE_REFUSED'});
  f.state.fileHash=hash('edited-after-plan');
  await assert.rejects(()=>provisionM1Collection(f.req,deps),{code:'M1_STALE_PROVISION_SOURCE'});
 }finally{await f.cleanup();}
});
test('M1 collection bootstrap invokes guarded F03 provision, persists receipt and rejects repeat',async()=>{
 const f=await fixture();try{
  let provisioned=0;
  const deps={...f.deps,getReceipt:async()=>null,
   backendPool:{getTrusted:async()=>({})},
   provisionBackend:async(backend,_conn,actual)=>{
    assert.equal(backend,'qdrant');assert.equal(actual.collection.key,ident.key);
    provisioned++;return {status:'PROVISIONED_SOURCE_BOUND_UNCERTIFIED',physicalName:actual.collection.physicalName};
   }};
  f.req.body={backend:'qdrant',source};
  const plan=await prepareM1Collection(f.req,deps);
  f.req.body={operationId:plan.operationId,confirmation:'CREATE OWNED V2 COLLECTION'};
  const result=await provisionM1Collection(f.req,deps);
  assert.equal(result.receiptState,'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED');
  assert.equal(result.productionWritesEnabled,false);
  assert.equal(provisioned,1);
  const read=JSON.parse(await fs.readFile(path.join(f.dir,'.similharity','f03-provisions',ident.key+'.json'),'utf8'));
  assert.equal(read.state,'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED');
  await assert.rejects(()=>provisionM1Collection(f.req,deps),{code:'M1_TICKET_ALREADY_CONSUMED'});
  assert.equal(provisioned,1);
 }finally{await f.cleanup();}
});
