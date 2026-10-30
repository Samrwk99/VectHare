import {inspectM3LifecycleRecovery} from '../lib/m3-execution-audit.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {collectionIdentity,recordIdentity,contentFingerprint} from '../lib/s02-identity.js';
import {executeM3TrustedRestore,m3QdrantSmokeQueries} from '../lib/m3-lifecycle-transaction.js';
import {M3Store} from '../lib/m3-collections.js';
import {resolveM3ReadBinding} from '../lib/m3-target-receipts.js';
import {M3CutoverJournal} from '../lib/m3-cutover-journal.js';
import {planM3TrustedRollback,executeM3TrustedRollback} from '../lib/m3-rollback-transaction.js';
import {planM3Rollback,executeM3Collection} from '../lib/m3-collections.js';
const H=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const scope={userScopeId:'alice',collectionId:'a',type:'chat',sourceId:'chat-a',branchId:'branch'};
const embedding={source:'transformers',model:'fixture',dimension:3,metric:'cosine'};
const source={kind:'chat',avatar:'a.png',chatFile:'a'};
const collection=collectionIdentity({backend:'qdrant',scope,embedding});
const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',scope,embedding,
 collection:{key:collection.key,physicalName:collection.physicalName}};
const indexes=Object.fromEntries(['userScopeId','collectionId','type','sourceId','branchId','recordId','physicalId'].map(k=>[k,{data_type:'keyword'}]));
async function fx({failWrite=false,allowCanonical=false}={}){
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
 let target=null,created=false,points=[],writeCount=0,canonicalReadable=true;
 const transport={_request:async(method,url,body)=>{
  if(url.startsWith(`/collections/${collection.physicalName}`)){
   if(!allowCanonical)throw Error('ORIGINAL_UNEXPECTED_PHYSICAL_IO');
   if(!canonicalReadable)throw Object.assign(new Error('offline'),{httpStatus:404});
   const suffix=url.slice(`/collections/${collection.physicalName}`.length);
   if(method==='GET'&&suffix==='')return {result:{config:{params:{vectors:{size:3,distance:'Cosine'}}},payload_schema:indexes}};
   if(method==='POST'&&suffix==='/points/scroll')return {result:{points:structuredClone(rows),next_page_offset:null}};
   if(method==='POST'&&suffix==='/points/query')return {result:{points:structuredClone(rows)}};
   throw Error('CANONICAL_READ_ONLY');
  }
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
 const deps={transport:async()=>transport,getProfile:async()=>({configured:true,profile:embedding}),
  bind:async()=>({binding}),receipt:async()=>({state:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED'}),
  jobs:()=>({assertNoLease:async()=>true}),readSnapshot:async()=>({fileHash:backup.savedSourceFingerprint,sourceId:scope.sourceId}),
  registry:()=>({read:async()=>managed}),ledgerCheckpoint:async()=>backup.operationCheckpoint,
  inventory:async()=>({rows,digest:H(rows),count:1,complete:true,exclusiveOwner:true})};
 return {ctx,req,store,backup,operationId,transport,deps,addPoint:p=>points.push(p),readCount:()=>writeCount,target:()=>target,
  makeCanonicalUnavailable:()=>{canonicalReadable=false;},
  cleanup:()=>fs.rm(dir,{recursive:true,force:true})};
}

test('M3f private rollback is a one-shot, generation-2 verified transition, retains both physical collections',async()=>{
 const f=await fx({allowCanonical:true});try{
  const restored=await executeM3TrustedRestore(f.req,f.operationId,f.deps);
  assert.equal(restored.generation,1);
  f.req.body={restoreOperationId:f.operationId};
  const planned=await planM3Rollback(f.req,f.deps);
  assert.equal(planned.executionAllowed,true);
  f.req.body={operationId:planned.operationId,confirmation:'ROLL BACK UNCHANGED COLLECTION'};
  const done=await executeM3Collection(f.req,f.deps);
  assert.equal(done.enabled,true);
  assert.equal(done.state,'VERIFIED');assert.equal(done.generation,2);
  assert.equal(done.physicalName,collection.physicalName);
  assert.equal(done.originalCollectionRetained,true);assert.equal(done.restoredCollectionRetained,true);
  const journal=new M3CutoverJournal(f.ctx,{logicalKey:collection.key});
  assert.deepEqual((await journal.events()).map(x=>x.state),['PREPARED','PUBLISHED','PREPARED','PUBLISHED']);
  const routed=await resolveM3ReadBinding(f.ctx,binding,{transport:f.transport});
  assert.equal(routed.collection.physicalName,collection.physicalName);
  assert.equal(routed.collection.generation,2,'canonical name must still be fenced at generation two');
  await assert.rejects(()=>executeM3TrustedRollback(f.req,planned.operationId,f.deps),
   {code:'M3_ROLLBACK_HISTORY_NOT_SINGLE_RESTORE'});
 }finally{await f.cleanup();}
});
test('M3f refuses rollback if published collection changed after restore',async()=>{
 const f=await fx({allowCanonical:true});try{
  await executeM3TrustedRestore(f.req,f.operationId,f.deps);
  f.addPoint({id:randomUUID(),vector:[0.2,0.5,0.3],payload:{userScopeId:'mallory'}});
  await assert.rejects(()=>planM3TrustedRollback(f.req,f.operationId,f.deps),
   {code:'M3_TARGET_INVENTORY_MISMATCH'});
  const journal=new M3CutoverJournal(f.ctx,{logicalKey:collection.key});
  assert.equal((await journal.resolve(binding)).generation,1);
 }finally{await f.cleanup();}
});
test('M3f source divergence refuses before claim and releases logical lock',async()=>{
 const f=await fx({allowCanonical:true});try{
  await executeM3TrustedRestore(f.req,f.operationId,f.deps);
  const plan=await planM3TrustedRollback(f.req,f.operationId,f.deps);
  const changed={...f.deps,readSnapshot:async()=>({fileHash:'f'.repeat(64),sourceId:scope.sourceId})};
  await assert.rejects(()=>executeM3TrustedRollback(f.req,plan.operationId,changed),
   {code:'M3_ROLLBACK_SAVED_SOURCE_CHANGED'});
  const result=await executeM3TrustedRollback(f.req,plan.operationId,f.deps);
  assert.equal(result.state,'VERIFIED','preclaim refusal must not consume ticket or retain lock');
  assert.equal((await inspectM3LifecycleRecovery(f.ctx,plan.operationId)).lastStage,'COMMITTED');
 }finally{await f.cleanup();}
});
test('M3f post-claim physical loss retains lock and forbids replay',async()=>{
 const f=await fx({allowCanonical:true});try{
  await executeM3TrustedRestore(f.req,f.operationId,f.deps);
  const plan=await planM3TrustedRollback(f.req,f.operationId,f.deps);
  let count=0;
  const flaky={...f.deps,smoke:async()=>{if(++count===1)throw Error('INJECTED_UNCERTAIN_READ');return {verified:true,version:'test'};}};
  await assert.rejects(()=>executeM3TrustedRollback(f.req,plan.operationId,flaky),/INJECTED_UNCERTAIN_READ/);
  assert.equal((await inspectM3LifecycleRecovery(f.ctx,plan.operationId)).lastStage,'DISPATCH_PENDING');
  await assert.rejects(()=>executeM3TrustedRollback(f.req,plan.operationId,f.deps),
   {code:'M3_LOGICAL_COLLECTION_BUSY'});
  const journal=new M3CutoverJournal(f.ctx,{logicalKey:collection.key});
  assert.equal((await journal.resolve(binding)).generation,1);
 }finally{await f.cleanup();}
});
test('M3f rollback cannot be requested without host ownership or a valid restore',async()=>{
 const f=await fx({allowCanonical:true});try{
  await assert.rejects(()=>planM3TrustedRollback({s03:{userScopeId:'mallory'},user:{directories:{}}},
   f.operationId,f.deps),{code:'M3_HOST_STORAGE_REQUIRED'});
  await assert.rejects(()=>planM3TrustedRollback(f.req,randomUUID(),f.deps));
 }finally{await f.cleanup();}
});
