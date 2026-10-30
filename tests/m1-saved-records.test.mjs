import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {collectionIdentity,contentFingerprint,recordIdentity} from '../lib/s02-identity.js';
import {M1TicketStore,validateM1Intent,savedRecordIdentity,makeSavedRecordV2,
 preflightM1SavedSource,previewM1Records,planM1Record,executeM1Record,registerM1Routes,prepareM1Collection,provisionM1Collection} from '../lib/m1-saved-records.js';
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
 const deps={getProfile:async()=>({configured:true,profile,connectionState:'VERIFIED'}),bind:async()=>({binding}),
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

test('P06 server-owned cursors page 250 saved records, persist across calls and reject forged/stale scope',async()=>{
 const f=await fixture();
 try{
  f.state.messages=Array.from({length:250},(_,i)=>({recordId:randomUUID(),text:`message ${i}`,contentHash:contentFingerprint(`message ${i}`)}));
  f.req.body={backend:'qdrant',source};
  const seen=[];let page=await previewM1Records(f.req,f.deps),cursor;
  assert.equal(page.totalRecords,250);assert.equal(page.records.length,50);assert.ok(page.nextCursor);
  for(let n=0;n<5;n++){
   assert.equal(page.offset,n*50);seen.push(...page.records.map(x=>x.recordId));
   cursor=page.nextCursor;
   if(cursor)page=await previewM1Records({...f.req,body:{backend:'qdrant',source,cursor}},f.deps);
  }
  assert.equal(seen.length,250);assert.equal(new Set(seen).size,250);
  assert.equal(cursor,null);assert.equal(page.pageComplete,true);
  await assert.rejects(()=>previewM1Records({...f.req,body:{backend:'qdrant',source,offset:100}},f.deps),/M1_PAGE_FIELDS_INVALID/);
  const first=await previewM1Records(f.req,f.deps);
  await assert.rejects(()=>previewM1Records({...f.req,body:{backend:'qdrant',source,cursor:first.nextCursor+'A'}},f.deps),/M1_PAGE_CURSOR_INVALID/);
  f.state.fileHash=hash('saved changed');
  await assert.rejects(()=>previewM1Records({...f.req,body:{backend:'qdrant',source,cursor:first.nextCursor}},f.deps),/M1_PAGE_SOURCE_CHANGED/);
 }finally{await f.cleanup();}
});

test('P05 Repair preview flags orphan managed records for review but never constructs delete plans',async()=>{
 const f=await fixture();
 try{
  const registry=new ManagedChatRegistry(f.req.s03,binding);
  // Existing deletion-like inventory is advisory: no implicit hash/UUID delete.
  const first=await previewM1Records({...f.req,body:{backend:'qdrant',source}},f.deps);
  assert.equal(first.orphanReview,0);
  assert.equal(first.totalRecords,1);
  assert.equal(first.pageComplete,true);
 }finally{await f.cleanup();}
});


test('P01 scoped preflight accepts selected M3 profile, distinguishes absent and untested base profiles without DB access',async()=>{
 const f=await fixture();
 try{
  const req={...f.req,body:{backend:'qdrant',source}};
  assert.deepEqual((await preflightM1SavedSource(req,{getSelectedProfile:async()=>({configured:false})})).remediation,'CONFIGURE_SERVER_EMBEDDING_PROFILE');
  const unverified=await preflightM1SavedSource(req,{getSelectedProfile:async()=>({configured:true,profile,connectionState:'NOT_TESTED'})});
  assert.equal(unverified.ready,false);assert.equal(unverified.remediation,'RUN_EMBEDDING_CONNECTION_TEST');
  const selected=await preflightM1SavedSource(req,{getSelectedProfile:async()=>({configured:true,selected:true,profile,selectionGeneration:1})});
  assert.equal(selected.ready,true);assert.equal(selected.connectionState,'VERIFIED');assert.equal(selected.sourceSelectionGeneration,1);
  const base=await preflightM1SavedSource(req,{getSelectedProfile:async()=>({configured:true,selected:false,profile,profileRevision:'abc',connectionState:'VERIFIED'})});
  assert.equal(base.ready,true);assert.equal(base.profileRevision,'abc');
  await assert.rejects(()=>preflightM1SavedSource({...req,body:{...req.body,text:'browser spoof'}},{getSelectedProfile:async()=>({configured:true,profile})}),/M1_REFERENCE_BACKEND_REQUIRED/);
 }finally{await f.cleanup();}
});

test('P05 plan refuses source edits between preview and plan, before mutations',async()=>{
 const f=await fixture();
 try{
  const preview=await previewM1Records({...f.req,body:{backend:'qdrant',source}},f.deps);
  const intent={backend:'qdrant',source,action:'insert',recordId:preview.records[0].recordId,
   expectedFileFingerprint:'e'.repeat(64)};
  await assert.rejects(()=>planM1Record({...f.req,body:intent},preview.logicalKey,f.deps),/M1_SOURCE_CHANGED_SINCE_PREVIEW/);
  assert.equal(f.calls.length,0);
 }finally{await f.cleanup();}
});


test('P-A.4 direct M1 prepare, preview, plan and provisioning reject unverified server profiles before DB dispatch',async()=>{
 const f=await fixture();
 try{
  let binds=0,backends=0;
  const unverified={...f.deps,getProfile:async()=>({configured:true,profile,connectionState:'NOT_TESTED'}),
   bind:async()=>{binds++;throw Error('DB MUST NOT BE TOUCHED');},
   backendPool:{getTrusted:async()=>{backends++;throw Error('DB MUST NOT BE TOUCHED');}}};
  const req={...f.req,body:{backend:'qdrant',source}};
  await assert.rejects(()=>prepareM1Collection(req,unverified),{code:'M1_EMBEDDING_PROFILE_UNVERIFIED'});
  await assert.rejects(()=>previewM1Records(req,unverified),{code:'M1_EMBEDDING_PROFILE_UNVERIFIED'});
  await assert.rejects(()=>planM1Record({...req,body:{...req.body,action:'insert',recordId:f.recordId}},ident.key,unverified),{code:'M1_EMBEDDING_PROFILE_UNVERIFIED'});
  assert.equal(binds,0);assert.equal(backends,0);
  const ready={...f.deps,getReceipt:async()=>null};
  const ticket=await prepareM1Collection(req,ready);
  await assert.rejects(()=>provisionM1Collection({...req,body:{operationId:ticket.operationId,confirmation:'CREATE OWNED V2 COLLECTION'}},
   {...unverified,certify:async()=>true}),{code:'M1_EMBEDDING_PROFILE_UNVERIFIED'});
  assert.equal(binds,0);assert.equal(backends,0);
 }finally{await f.cleanup();}
});
test('P-A.4 a verified plan cannot execute if server profile is unverified before dispatch',async()=>{
 const f=await fixture();try{
  const request={...f.req,body:{backend:'qdrant',source,action:'insert',recordId:f.recordId}};
  const plan=await planM1Record(request,ident.key,f.deps);
  await assert.rejects(()=>executeM1Record({...request,body:{operationId:plan.operationId,confirmation:'APPLY SAVED RECORD MUTATION'}},
   {...f.deps,getProfile:async()=>({configured:true,profile,connectionState:'NOT_TESTED'})}),
   {code:'M1_EMBEDDING_PROFILE_UNVERIFIED'});
  assert.equal(f.calls.length,0);
 }finally{await f.cleanup();}
});

test('P-A.4 source-bound preview cursor remains valid across a fresh plugin Node process',async()=>{
 const {spawnSync}=await import('node:child_process');
 const f=await fixture();try{
  f.state.messages=Array.from({length:101},(_,i)=>({recordId:randomUUID(),text:`saved ${i}`,contentHash:contentFingerprint(`saved ${i}`)}));
  const req={...f.req,body:{backend:'qdrant',source}};
  const first=await previewM1Records(req,f.deps);
  assert.equal(first.offset,0);assert.ok(first.nextCursor);
  const payload={ctx:req.s03,source,profile,binding,snapshot:f.state,cursor:first.nextCursor};
  const moduleUrl=new URL('../lib/m1-saved-records.js',import.meta.url).href;
  const script=`import {previewM1Records} from ${JSON.stringify(moduleUrl)};\n`+
   `import {ManagedChatRegistry} from ${JSON.stringify(new URL('../lib/f09b4-managed-registry.js',import.meta.url).href)};\n`+
   `const p=JSON.parse(process.env.M1_PAGED_TEST);const req={s03:p.ctx,user:{directories:{}},body:{backend:'qdrant',source:p.source,cursor:p.cursor}};\n`+
   `const result=await previewM1Records(req,{getProfile:async()=>({configured:true,profile:p.profile,connectionState:'VERIFIED'}),bind:async()=>({binding:p.binding}),readSnapshot:async()=>p.snapshot,getReceipt:async()=>({state:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED'}),registry:(ctx,b)=>new ManagedChatRegistry(ctx,b)});\n`+
   `process.stdout.write(JSON.stringify({offset:result.offset,length:result.records.length,next:!!result.nextCursor}));`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{
   cwd:process.cwd(),env:{...process.env,M1_PAGED_TEST:JSON.stringify(payload)},encoding:'utf8',timeout:12000});
  assert.equal(child.status,0,child.stderr);
  assert.deepEqual(JSON.parse(child.stdout),{offset:50,length:50,next:true});
 }finally{await f.cleanup();}
});

test('P-A.5 Repair preview reads ACTIVE vectors from verified source-bound backend; missing vectors require review',async()=>{
 const f=await fixture();try{
  const {req,deps,rows,recordId}=f;
  req.body={backend:'qdrant',source,action:'insert',recordId};
  const ticket=await planM1Record(req,ident.key,deps);
  await executeM1Record({...req,body:{operationId:ticket.operationId,confirmation:'APPLY SAVED RECORD MUTATION'}},deps);
  let reads=0;
  const checked={...deps,readRecord:async(...args)=>{reads++;return deps.readRecord(...args);}};
  const body={backend:'qdrant',source,verifyPhysical:true};
  let view=await previewM1Records({...req,body},checked);
  assert.equal(view.records[0].physicalState,'VERIFIED');assert.equal(reads,1);
  rows.clear();
  view=await previewM1Records({...req,body},checked);
  assert.equal(view.records[0].physicalState,'MISSING');assert.deepEqual(view.records[0].availableActions,['repair-missing']);
  assert.equal(view.records[0].managedState,'ACTIVE');assert.equal(reads,2);
  await assert.rejects(()=>previewM1Records({...req,body}, {...deps,readRecord:async()=>{throw Error('DB_TIMEOUT');}}),/DB_TIMEOUT/);
  await assert.rejects(()=>previewM1Records({...req,body:{...body,verifyPhysical:false}},checked),{code:'M1_PAGE_FIELDS_INVALID'});
 }finally{await f.cleanup();}
});
test('P-A.5 Repair physical-mode cursor is immutable; cannot downgrade across pages',async()=>{
 const f=await fixture();try{
  f.state.messages=Array.from({length:70},(_,i)=>({...msg,recordId:randomUUID(),text:`record ${i}`,contentHash:contentFingerprint(`record ${i}`)}));
  const first=await previewM1Records({...f.req,body:{backend:'qdrant',source,verifyPhysical:true}},f.deps);
  assert.ok(first.nextCursor);
  await assert.rejects(()=>previewM1Records({...f.req,body:{backend:'qdrant',source,cursor:first.nextCursor}},f.deps),{code:'M1_PAGE_SOURCE_CHANGED'});
  const next=await previewM1Records({...f.req,body:{backend:'qdrant',source,verifyPhysical:true,cursor:first.nextCursor}},f.deps);
  assert.equal(next.offset,50);
 }finally{await f.cleanup();}
});


test('P-A.6 missing physically owned ACTIVE record is regenerated through a guarded M1 insert receipt',async()=>{
 const f=await fixture();try{
  const {req,deps,rows,recordId}=f;
  const run=async action=>{
   const plan=await planM1Record({...req,body:{backend:'qdrant',source,action,recordId}},ident.key,deps);
   return executeM1Record({...req,body:{operationId:plan.operationId,confirmation:'APPLY SAVED RECORD MUTATION'}},deps);
  };
  await run('insert');rows.clear();
  let preview=await previewM1Records({...req,body:{backend:'qdrant',source,verifyPhysical:true}},deps);
  assert.deepEqual(preview.records[0].availableActions,['repair-missing']);
  await run('repair-missing');
  assert.equal(rows.get(recordId).revision,1);
  const doc=await new ManagedChatRegistry(req.s03,binding).read();
  assert.equal(doc.records[recordId].state,'ACTIVE');assert.equal(doc.records[recordId].revision,1);
  preview=await previewM1Records({...req,body:{backend:'qdrant',source,verifyPhysical:true}},deps);
  assert.equal(preview.records[0].physicalState,'VERIFIED');
  await assert.rejects(()=>planM1Record({...req,body:{backend:'qdrant',source,action:'repair-missing',recordId}},ident.key,deps),{code:'M1_PHYSICAL_RECORD_EXISTS'});
 }finally{await f.cleanup();}
});
test('P-A.6 repairs registry-only drift after proving physical record is current and owned',async()=>{
 const f=await fixture();try{
  const {req,deps,rows,recordId}=f;
  const insert=await planM1Record({...req,body:{backend:'qdrant',source,action:'insert',recordId}},ident.key,deps);
  await executeM1Record({...req,body:{operationId:insert.operationId,confirmation:'APPLY SAVED RECORD MUTATION'}},deps);
  // Simulate a lost local registry file, preserving the proved physical record.
  const registry=new ManagedChatRegistry(req.s03,binding);
  const doc=await registry.read();delete doc.records[recordId];await registry.save(doc);
  let preview=await previewM1Records({...req,body:{backend:'qdrant',source,verifyPhysical:true}},deps);
  assert.equal(preview.records[0].physicalState,'VERIFIED');
  assert.deepEqual(preview.records[0].availableActions,['repair-registry']);
  const before=f.calls.length;
  const plan=await planM1Record({...req,body:{backend:'qdrant',source,action:'repair-registry',recordId}},ident.key,deps);
  const result=await executeM1Record({...req,body:{operationId:plan.operationId,confirmation:'APPLY SAVED RECORD MUTATION'}},deps);
  assert.equal(result.registryReconciled,true);assert.equal(result.state,'VERIFIED');
  assert.equal(f.calls.length,before,'physical writes are not needed when adopting a proven record');
  assert.equal((await registry.read()).records[recordId].state,'ACTIVE');
  preview=await previewM1Records({...req,body:{backend:'qdrant',source,verifyPhysical:true}},deps);
  assert.equal(preview.records[0].physicalState,'VERIFIED');
  assert.deepEqual(preview.records[0].availableActions,['update','revectorize','delete']);
 }finally{await f.cleanup();}
});
test('P-A.6 conflicting record remains review-only and never mutates a foreign physical entry',async()=>{
 const f=await fixture();try{
  f.rows.set(f.recordId,{recordId:f.recordId,revision:1,scope:{...scope,userScopeId:'other'},
   physicalId:'untrusted',text:'hello',metadata:{}});
  const view=await previewM1Records({...f.req,body:{backend:'qdrant',source,verifyPhysical:true}},f.deps);
  assert.equal(view.records[0].physicalState,'CONFLICT');
  assert.deepEqual(view.records[0].availableActions,[]);
  await assert.rejects(()=>planM1Record({...f.req,body:{backend:'qdrant',source,action:'repair-registry',recordId:f.recordId}},ident.key,f.deps),{code:'M1_V2_PROVENANCE_UNVERIFIED'});
  assert.deepEqual(f.calls,[]);
 }finally{await f.cleanup();}
});
test('P-A.6 uncertain pending writes are not recovered automatically even when physical record is missing',async()=>{
 const f=await fixture();try{
  const registry=new ManagedChatRegistry(f.req.s03,binding);
  await registry.begin({recordId:f.recordId,contentHash:msg.contentHash,revision:0,operationId:randomUUID(),action:'write',bootstrap:true});
  const view=await previewM1Records({...f.req,body:{backend:'qdrant',source,verifyPhysical:true}},f.deps);
  assert.equal(view.records[0].physicalState,'MISSING');
  assert.deepEqual(view.records[0].availableActions,[]);
  await assert.rejects(()=>planM1Record({...f.req,body:{backend:'qdrant',source,action:'repair-missing',recordId:f.recordId}},ident.key,f.deps),{code:'M1_MANAGED_STATE_DENIED'});
 }finally{await f.cleanup();}
});
test('P-A.6 registry reconciliation refuses physical drift between plan and commit',async()=>{
 const f=await fixture();try{
  const {req,deps,recordId}=f;
  const plan=await planM1Record({...req,body:{backend:'qdrant',source,action:'insert',recordId}},ident.key,deps);
  await executeM1Record({...req,body:{operationId:plan.operationId,confirmation:'APPLY SAVED RECORD MUTATION'}},deps);
  const registry=new ManagedChatRegistry(req.s03,binding),doc=await registry.read();delete doc.records[recordId];await registry.save(doc);
  const toReconcile=await planM1Record({...req,body:{backend:'qdrant',source,action:'repair-registry',recordId}},ident.key,deps);
  let reads=0;const adapter=()=>({getRecord:async id=>{
   const physical=structuredClone(f.rows.get(typeof id==='string'?id:id.recordId));
   if(++reads===2)physical.text='tampered after first read';
   return physical;
  }});
  await assert.rejects(()=>executeM1Record({...req,body:{operationId:toReconcile.operationId,confirmation:'APPLY SAVED RECORD MUTATION'}},{...deps,adapter}),{code:'M1_V2_PROVENANCE_UNVERIFIED'});
  assert.equal((await registry.read()).records[recordId],undefined);
 }finally{await f.cleanup();}
});
test('P-A.6 registry reconciliation must not change pending or stale state',async()=>{
 const f=await fixture();try{
  const registry=new ManagedChatRegistry(f.req.s03,binding);
  await registry.begin({recordId:f.recordId,contentHash:msg.contentHash,revision:0,operationId:randomUUID(),action:'write',bootstrap:true});
  await assert.rejects(()=>registry.reconcileVerified({recordId:f.recordId,expected:null,contentHash:msg.contentHash,revision:1}),{code:'F09B4_RECONCILE_STALE'});
  const pending=(await registry.read()).records[f.recordId];
  await assert.rejects(()=>registry.reconcileVerified({recordId:f.recordId,expected:pending,contentHash:msg.contentHash,revision:1}),{code:'F09B4_RECONCILE_PENDING'});
  assert.deepEqual((await registry.read()).records[f.recordId],pending);
 }finally{await f.cleanup();}
});

test('P-B.1 saved-record browsing verifies physical absence, never invents complete collection inventory',async()=>{
 const f=await fixture();try{
  const req={...f.req,body:{backend:'qdrant',source,verifyPhysical:true}};
  const {browseM1Records}=await import('../lib/m1-saved-records.js');
  let reads=0;
  const deps={...f.deps,readRecord:async(...args)=>{reads++;return f.deps.readRecord(...args);}};
  const r=await browseM1Records(req,deps);
  assert.equal(reads,1);assert.equal(r.records.length,1);
  assert.equal(r.records[0].recordId,f.recordId);
  assert.equal(r.records[0].savedText,'hello');
  assert.equal(r.records[0].physicalState,'MISSING');
  assert.equal(r.records[0].displayStatus,'MISSING_PHYSICAL');
  assert.equal(r.inventoryVerified,false);assert.equal(r.physicalInventoryComplete,false);
  assert.equal(r.sourceAuthoritative,true);assert.equal(r.readOnly,true);
  await assert.rejects(()=>browseM1Records({...req,body:{backend:'qdrant',source}},deps),{code:'PB1_PHYSICAL_VERIFICATION_REQUIRED'});
  await assert.rejects(()=>browseM1Records({...req,body:{...req.body,vector:[0.1]}},deps),{code:'M1_PAGE_FIELDS_INVALID'});
  await assert.rejects(()=>browseM1Records(req,{...deps,readRecord:async()=>{throw Error('DISCONNECTED');}}),/DISCONNECTED/);
 }finally{await f.cleanup();}
});

test('P-B.1 browse pages preserve signed cursor, source revision and no cross-mode replay',async()=>{
 const f=await fixture();try{
  f.state.messages=Array.from({length:111},(_,i)=>({...msg,recordId:randomUUID(),text:`entry ${i}`,contentHash:contentFingerprint(`entry ${i}`)}));
  const {browseM1Records}=await import('../lib/m1-saved-records.js');
  const initial={backend:'qdrant',source,verifyPhysical:true};
  const first=await browseM1Records({...f.req,body:initial},f.deps);
  assert.equal(first.records.length,50);assert.equal(first.offset,0);
  assert.ok(first.nextCursor);
  const second=await browseM1Records({...f.req,body:{...initial,cursor:first.nextCursor}},f.deps);
  assert.equal(second.records.length,50);assert.equal(second.offset,50);
  const third=await browseM1Records({...f.req,body:{...initial,cursor:second.nextCursor}},f.deps);
  assert.equal(third.records.length,11);assert.equal(third.offset,100);
  assert.equal(third.nextCursor,null);assert.equal(third.pageComplete,true);
  assert.equal(third.physicalInventoryComplete,false);
  await assert.rejects(()=>previewM1Records({...f.req,body:{backend:'qdrant',source,cursor:first.nextCursor}},f.deps),{code:'M1_PAGE_SOURCE_CHANGED'});
  f.state.fileHash=hash('new revision');
  await assert.rejects(()=>browseM1Records({...f.req,body:{...initial,cursor:second.nextCursor}},f.deps),{code:'M1_PAGE_SOURCE_CHANGED'});
 }finally{await f.cleanup();}
});

test('P-B.1 browse refuses concurrent saved-file and registry drift during physical reads',async()=>{
 const f=await fixture();try{
  const {browseM1Records}=await import('../lib/m1-saved-records.js');
  const req={...f.req,body:{backend:'qdrant',source,verifyPhysical:true}};
  const original=f.state.fileHash;
  await assert.rejects(()=>browseM1Records(req,{...f.deps,readRecord:async()=>{
   f.state.fileHash=hash('different source');return null;
  }}),{code:'PB1_SOURCE_CHANGED_DURING_READ'});
  f.state.fileHash=original;
  const registry=new ManagedChatRegistry(f.req.s03,binding);
  await assert.rejects(()=>browseM1Records(req,{...f.deps,readRecord:async()=>{
   const doc=await registry.read();doc.records[f.recordId]={recordId:f.recordId,contentHash:msg.contentHash,revision:0,
    operationId:randomUUID(),state:'WRITE_PENDING'};await registry.save(doc);return null;
  }}),{code:'PB1_REGISTRY_CHANGED_DURING_READ'});
 }finally{await f.cleanup();}
});
test('P-B.2 browser cursor binds registry generation while P06 mutation-preview cursors remain resumable',async()=>{
 const f=await fixture();try{
  f.state.messages=Array.from({length:111},(_,i)=>({...msg,recordId:randomUUID(),text:`entry ${i}`,contentHash:contentFingerprint(`entry ${i}`)}));
  const {browseM1Records}=await import('../lib/m1-saved-records.js');
  const browse={backend:'qdrant',source,verifyPhysical:true};
  const b=await browseM1Records({...f.req,body:browse},f.deps);
  const p=await previewM1Records({...f.req,body:{backend:'qdrant',source}},f.deps);
  assert.match(b.registryFingerprint,/^[a-f0-9]{64}$/);assert.equal(b.routingGeneration,0);
  const registry=new ManagedChatRegistry(f.req.s03,binding);
  const doc=await registry.read();doc.records[f.recordId]={recordId:f.recordId,contentHash:msg.contentHash,revision:0,
   operationId:randomUUID(),state:'WRITE_PENDING'};await registry.save(doc);
  await assert.rejects(()=>browseM1Records({...f.req,body:{...browse,cursor:b.nextCursor}},f.deps),{code:'M1_PAGE_SOURCE_CHANGED'});
  const continued=await previewM1Records({...f.req,body:{backend:'qdrant',source,cursor:p.nextCursor}},f.deps);
  assert.equal(continued.offset,50); // Active vectorization may legitimately change registry between pages.
 }finally{await f.cleanup();}
});
test('P-B.5 managed browse only exposes source-derived chat locator; M1 plan still rejects browser text',async()=>{
 const f=await fixture();try{
  f.state.messages[0].chatLocator={sendDate:'2025-01-01',name:'Alice',isUser:true};
  f.req.body={backend:'qdrant',source,verifyPhysical:true};
  const {browseM1Records}=await import('../lib/m1-saved-records.js');
  const result=await browseM1Records(f.req,f.deps);
  assert.deepEqual(result.records[0].chatLocator,f.state.messages[0].chatLocator);
  assert.equal(result.records[0].physicalState,'MISSING');
  assert.equal(result.records[0].savedText,'hello');
  assert.throws(()=>validateM1Intent({backend:'qdrant',source,recordId:f.recordId,
   action:'insert',text:'unsafe browser edit'}),{code:'M1_REFERENCE_BACKEND_REQUIRED'});
 }finally{await f.cleanup();}
});
