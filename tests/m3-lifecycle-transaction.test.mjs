import {inspectM3LifecycleRecovery} from '../lib/m3-execution-audit.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {collectionIdentity,recordIdentity,contentFingerprint} from '../lib/s02-identity.js';
import {executeM3TrustedRestore,m3QdrantSmokeQueries} from '../lib/m3-lifecycle-transaction.js';
import {M3Store,executeM3Collection} from '../lib/m3-collections.js';
import {resolveM3ReadBinding} from '../lib/m3-target-receipts.js';
import {M3CutoverJournal} from '../lib/m3-cutover-journal.js';
const H=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const scope={userScopeId:'alice',collectionId:'a',type:'chat',sourceId:'chat-a',branchId:'branch'};
const embedding={source:'transformers',model:'fixture',dimension:3,metric:'cosine'};
const source={kind:'chat',avatar:'a.png',chatFile:'a'};
const collection=collectionIdentity({backend:'qdrant',scope,embedding});
const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',scope,embedding,
 collection:{key:collection.key,physicalName:collection.physicalName}};
const indexes=Object.fromEntries(['userScopeId','collectionId','type','sourceId','branchId','recordId','physicalId'].map(k=>[k,{data_type:'keyword'}]));
async function fx({failWrite=false}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'m3e-lifecycle-'));await fs.chmod(dir,0o700);
 const ctx={userScopeId:'alice',vectorsPath:dir},req={s03:ctx,user:{directories:{}},body:{}};
 const recordId=randomUUID(),physicalId=recordIdentity(scope,recordId).physicalId,text='restored sample';
 const hash=contentFingerprint(text),vec=[1,0,0];
 const meta={vecthareRecordV2:{schemaVersion:2,recordId,identity:{userScopeId:'alice',sourceId:scope.sourceId},contentHash:hash,revision:1}};
 const point={id:physicalId,vector:vec,payload:{...scope,recordId,physicalId,revision:1,text,textHash:hash,
  metadata:meta,metadataHash:H(meta),embedding,vectorHash:H(vec),vectorReference:vec}};
 const rows=[point],managed={records:{[recordId]:{state:'ACTIVE',recordId,contentHash:hash,revision:1}},fingerprint:'d'.repeat(64)};
 const backup={schemaVersion:1,backupId:randomUUID(),owner:'alice',backend:'qdrant',logicalKey:collection.key,
  physicalName:collection.physicalName,scope,embedding,source,configId:'default',sourceId:scope.sourceId,
  savedSourceFingerprint:'b'.repeat(64),managed,operationCheckpoint:{count:0,digest:H([])},
  inventory:{rows,count:1,digest:H(rows),complete:true,exclusiveOwner:true}};
 const operationId=randomUUID(),ticket={schemaVersion:1,operationId,owner:'alice',action:'restore',backend:'qdrant',
  source,configId:'default',backupId:backup.backupId,logicalKey:collection.key,physicalName:collection.physicalName,
  sourceFingerprint:backup.savedSourceFingerprint,inventoryDigest:backup.inventory.digest,
  managedFingerprint:managed.fingerprint,createdAt:Date.now(),expiresAt:Date.now()+200000};
 const store=new M3Store(ctx);await store.write('backup',backup);await store.write('operation',ticket);
 let target=null,created=false,points=[],writeCount=0;
 const transport={_request:async(method,url,body)=>{
  if(url===`/collections/${collection.physicalName}`)throw Error('ORIGINAL_UNEXPECTED_PHYSICAL_IO');
  const match=url.match(/^\/collections\/(vh2_[a-f0-9]{48})(.*)$/);
  assert.ok(match,'target must be Qdrant collection');target=match[1];const suffix=match[2];
  if(method==='GET'&&suffix===''){
   if(!created)throw Object.assign(new Error('not found'),{httpStatus:404});
   return {result:{config:{params:{vectors:{size:3,distance:'Cosine'}}},payload_schema:indexes}};
  }
  if(method==='PUT'&&suffix===''){
   if(created)throw Error('SECOND_CREATE');created=true;return {result:true};
  }
  if(method==='PUT'&&suffix.startsWith('/index'))return {result:true};
  if(method==='PUT'&&suffix==='/points?wait=true'){
   writeCount++;
   if(failWrite)throw Error('INJECTED_LOST_QDRANT_RESPONSE');
   points.push(...structuredClone(body.points));return {result:{status:'completed'}};
  }
  if(method==='POST'&&suffix==='/points/scroll')return {result:{points:structuredClone(points),next_page_offset:null}};
  if(method==='POST'&&suffix==='/points/query')return {result:{points:structuredClone(points)}};
  throw Error('UNEXPECTED_REQUEST:'+method+':'+url);
 }};
 const deps={transport:async()=>transport,getProfile:async()=>({configured:true,profile:embedding,connectionState:'VERIFIED'}),
  bind:async()=>({binding}),receipt:async()=>({state:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED'}),
  jobs:()=>({assertNoLease:async()=>true}),readSnapshot:async()=>({fileHash:backup.savedSourceFingerprint,sourceId:scope.sourceId}),
  registry:()=>({read:async()=>managed}),ledgerCheckpoint:async()=>backup.operationCheckpoint,
  inventory:async()=>({rows,digest:H(rows),count:1,complete:true,exclusiveOwner:true})};
 return {ctx,req,store,backup,operationId,transport,deps,addPoint:p=>points.push(p),readCount:()=>writeCount,target:()=>target,
  cleanup:()=>fs.rm(dir,{recursive:true,force:true})};
}
test('M3e restore holds one logical lock, claims one operation, verifies target and publishes read-safe alias',async()=>{
 const f=await fx();try{
  f.req.body={operationId:f.operationId,confirmation:'RESTORE TO FRESH COLLECTION'};
  const outcome=await executeM3Collection(f.req,f.deps);
  assert.equal(outcome.validationStatus,'AWAITING_MANUAL_TEST');
  assert.equal(outcome.enabled,true);assert.equal(outcome.state,'VERIFIED');assert.equal(outcome.generation,1);assert.equal(outcome.restoredCount,1);
  assert.equal(f.readCount(),1);assert.equal(outcome.productionCertified,false);
  const evidence=await inspectM3LifecycleRecovery(f.ctx,f.operationId);
  assert.equal(evidence.lastStage,'COMMITTED');assert.equal(evidence.evidenceComplete,true);
  const routed=await resolveM3ReadBinding(f.ctx,binding,{transport:f.transport});
  assert.equal(routed.collection.physicalName,f.target());
  const journal=new M3CutoverJournal(f.ctx,{logicalKey:collection.key});
  assert.deepEqual((await journal.events()).map(x=>x.state),['PREPARED','PUBLISHED']);
  await assert.rejects(()=>executeM3TrustedRestore(f.req,f.operationId,f.deps),{code:'M3_RESTORE_STALE_GENERATION'});
  assert.equal(f.readCount(),1,'repeat must not submit another write');
 }finally{await f.cleanup();}
});
test('M3e lost target dispatch outcome retains logical lock and refuses retry',async()=>{
 const f=await fx({failWrite:true});try{
  await assert.rejects(()=>executeM3TrustedRestore(f.req,f.operationId,f.deps),/INJECTED_LOST_QDRANT_RESPONSE/);
  assert.equal(f.readCount(),1);
  assert.equal((await inspectM3LifecycleRecovery(f.ctx,f.operationId)).lastStage,'DISPATCH_PENDING');
  await assert.rejects(()=>executeM3TrustedRestore(f.req,f.operationId,f.deps),{code:'M3_LOGICAL_COLLECTION_BUSY'});
  assert.equal(f.readCount(),1,'a claimed uncertain write cannot dispatch twice');
 }finally{await f.cleanup();}
});
test('M3e fixed smoke queries reject a missing saved record',async()=>{
 const f=await fx();try{
  await assert.rejects(()=>m3QdrantSmokeQueries({_request:async()=>({result:{points:[]}})},f.backup,
   'vh2_'+'f'.repeat(48)),{code:'M3_SMOKE_QUERY_FAILED'});
 }finally{await f.cleanup();}
});
test('M3e published target is consumable by M1 preview and record planning through server proof only',async()=>{
 const {previewM1Records,planM1Record,M1TicketStore,savedRecordIdentity}=await import('../lib/m1-saved-records.js');
 const f=await fx();try{
  await executeM3TrustedRestore(f.req,f.operationId,f.deps);
  const msg={recordId:randomUUID(),text:'new message',contentHash:contentFingerprint('new message')};
  const m1deps={getProfile:f.deps.getProfile,bind:f.deps.bind,transport:f.deps.transport,
   getReceipt:f.deps.receipt,readSnapshot:async()=>({sourceId:scope.sourceId,fileHash:f.backup.savedSourceFingerprint,
    sourceKind:'chat',messages:[msg]}),registry:()=>({read:async()=>({records:{}})}),
   readRecord:async(_req,routed)=>{assert.equal(routed.collection.physicalName,f.target());
    assert.equal(routed.collection.generation,1);return null;},
   tickets:ctx=>new M1TicketStore(ctx)};
  f.req.body={backend:'qdrant',source};
  const preview=await previewM1Records(f.req,m1deps);
  assert.equal(preview.records.length,1);
  const id=savedRecordIdentity(f.ctx,binding,msg).recordId;
  f.req.body={backend:'qdrant',source,action:'insert',recordId:id};
  const plan=await planM1Record(f.req,collection.key,m1deps);
  const ticket=await new M1TicketStore(f.ctx).peek(plan.operationId);
  assert.equal(ticket.physicalName,f.target());assert.equal(ticket.routingGeneration,1);
  assert.equal(plan.executionAllowed,false);
 }finally{await f.cleanup();}
});
test('M3e routed M1 write uses S04 durable generation fence, ledger and shared lock',async()=>{
 const {planM1Record,executeM1Record,M1TicketStore,savedRecordIdentity}=await import('../lib/m1-saved-records.js');
 const {ManagedChatRegistry}=await import('../lib/f09b4-managed-registry.js');
 const f=await fx();try{
  await executeM3TrustedRestore(f.req,f.operationId,f.deps);
  const msg={recordId:randomUUID(),text:'hello new versioned collection',
   contentHash:contentFingerprint('hello new versioned collection')};
  const physical=new Map(),adapter={
   async getRecord(p){return structuredClone(physical.get(typeof p==='string'?p:p.recordId)??null);},
   async insertRecord(p,payload){physical.set(p.recordId,{
    recordId:p.recordId,physicalId:p.physicalId,scope:p.scope,revision:p.targetRevision,
    text:payload.text,textHash:contentFingerprint(payload.text),vector:payload.vector,vectorReference:payload.vector,
    vectorHash:H(payload.vector),metadata:payload.metadata,metadataHash:H(payload.metadata)});},
   async updateRecord(){throw Error('NOT_EXPECTED');},async deleteRecord(){throw Error('NOT_EXPECTED');}
  };
  const deps={getProfile:f.deps.getProfile,bind:f.deps.bind,transport:f.deps.transport,
   getReceipt:f.deps.receipt,readSnapshot:async()=>({sourceId:scope.sourceId,fileHash:f.backup.savedSourceFingerprint,
    sourceKind:'chat',messages:[msg]}),registry:(ctx,b)=>new ManagedChatRegistry(ctx,b),
   readRecord:async(_req,b,id)=>{assert.equal(b.collection.physicalName,f.target());return adapter.getRecord(id);},
   tickets:ctx=>new M1TicketStore(ctx),certify:async()=>true,verifySchema:async()=>true,
   adapter:()=>adapter,embed:async()=>[0.2,0.4,0.6]};
  const id=savedRecordIdentity(f.ctx,binding,msg).recordId;
  f.req.body={backend:'qdrant',source,action:'insert',recordId:id};
  const plan=await planM1Record(f.req,collection.key,deps);
  f.req.body={operationId:plan.operationId,confirmation:'APPLY SAVED RECORD MUTATION'};
  const result=await executeM1Record(f.req,deps);
  assert.equal(result.state,'VERIFIED');assert.equal(physical.size,1);
  const receipt=JSON.parse(await fs.readFile(path.join(f.ctx.vectorsPath,'.similharity',
   's04-operations',plan.operationId+'.json'),'utf8'));
  assert.equal(receipt.plan.routingGeneration,1);
  assert.equal(receipt.plan.physicalCollectionName,f.target());
  assert.equal(receipt.state,'VERIFIED');
 }finally{await f.cleanup();}
});
test('M3e mutated target still resolves only with exact managed registry and verified generation-bound S04 receipt',async()=>{
 const {ManagedChatRegistry}=await import('../lib/f09b4-managed-registry.js');
 const {M1TicketStore,planM1Record,executeM1Record,savedRecordIdentity}=await import('../lib/m1-saved-records.js');
 const f=await fx();try{
  await executeM3TrustedRestore(f.req,f.operationId,f.deps);
  const first=f.backup.inventory.rows[0],firstId=first.payload.recordId;
  const managed=new ManagedChatRegistry(f.ctx,binding);
  await managed.setup();await managed.save({...managed.empty(),records:{
   [firstId]:{recordId:firstId,contentHash:first.payload.textHash,revision:1,operationId:null,state:'ACTIVE'}}});
  const msg={recordId:randomUUID(),text:'added record',contentHash:contentFingerprint('added record')};
  const inserted=new Map(),adapter={async getRecord(p){return structuredClone(inserted.get(typeof p==='string'?p:p.recordId)??null);},
   async insertRecord(plan,payload){
   const vector=payload.vector,metadata=payload.metadata;
   const row={recordId:plan.recordId,physicalId:plan.physicalId,scope:plan.scope,
    revision:plan.targetRevision,text:payload.text,textHash:contentFingerprint(payload.text),
    vector,vectorReference:vector,vectorHash:H(vector),metadata,metadataHash:H(metadata)};
   inserted.set(plan.recordId,row);
   f.addPoint({id:plan.physicalId,vector,payload:{schemaVersion:2,...scope,recordId:plan.recordId,
    physicalId:plan.physicalId,revision:plan.targetRevision,text:payload.text,
    textHash:contentFingerprint(payload.text),metadata,metadataHash:H(metadata),
    embedding,vectorHash:H(vector),vectorReference:vector}});
  },async updateRecord(){throw Error('unexpected');},async deleteRecord(){throw Error('unexpected');}};
  const deps={getProfile:f.deps.getProfile,bind:f.deps.bind,transport:f.deps.transport,
   getReceipt:f.deps.receipt,readSnapshot:async()=>({sourceId:scope.sourceId,fileHash:f.backup.savedSourceFingerprint,
    sourceKind:'chat',messages:[msg]}),registry:(ctx,b)=>new ManagedChatRegistry(ctx,b),
   readRecord:async()=>null,tickets:ctx=>new M1TicketStore(ctx),certify:async()=>true,
   verifySchema:async()=>true,adapter:()=>adapter,embed:async()=>[0.2,0.4,0.6]};
  const id=savedRecordIdentity(f.ctx,binding,msg).recordId;
  f.req.body={backend:'qdrant',source,action:'insert',recordId:id};
  const p=await planM1Record(f.req,collection.key,deps);
  f.req.body={operationId:p.operationId,confirmation:'APPLY SAVED RECORD MUTATION'};
  assert.equal((await executeM1Record(f.req,deps)).state,'VERIFIED');
  const now=await resolveM3ReadBinding(f.ctx,binding,{transport:f.transport});
  assert.equal(now.collection.physicalName,f.target());
  // Removing the durable S04 receipt cannot turn into an accepted evolution.
  await fs.rm(path.join(f.ctx.vectorsPath,'.similharity','s04-operations',p.operationId+'.json'));
  await assert.rejects(()=>resolveM3ReadBinding(f.ctx,binding,{transport:f.transport}),
   {code:'M3_TARGET_EVOLUTION_RECEIPT_MISSING'});
 }finally{await f.cleanup();}
});
test('M3e source changed before the one-way claim rejects safely without dispatch',async()=>{
 const f=await fx();try{
  const deps={...f.deps,readSnapshot:async()=>({sourceId:scope.sourceId,fileHash:'f'.repeat(64)})};
  await assert.rejects(()=>executeM3TrustedRestore(f.req,f.operationId,deps),{code:'M3_RESTORE_SOURCE_CHANGED'});
  assert.equal(f.readCount(),0);
  // Before the claim a legitimate later retry can still pass the full proof.
  const outcome=await executeM3TrustedRestore(f.req,f.operationId,f.deps);
  assert.equal(outcome.state,'VERIFIED');assert.equal(f.readCount(),1);
 }finally{await f.cleanup();}
});
test('M3e forged lifecycle holder cannot bypass the shared logical lock',async()=>{
 const {assertM3LifecycleHolder}=await import('../lib/m3-logical-exclusion.js');
 const f=await fx();try{
  assert.throws(()=>assertM3LifecycleHolder(Object.freeze({operationId:f.operationId}),f.ctx,'qdrant',collection.key),
   {code:'M3_LIFECYCLE_HOLDER_REQUIRED'});
 }finally{await f.cleanup();}
});
