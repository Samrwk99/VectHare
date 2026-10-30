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
import {executeM3TrustedDecommission} from '../lib/m3-decommission-transaction.js';
import {CollectionRegistry} from '../lib/s02-registry.js';
import {executeM3Collection} from '../lib/m3-collections.js';
const H=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const scope={userScopeId:'alice',collectionId:'a',type:'chat',sourceId:'chat-a',branchId:'branch'};
const embedding={source:'transformers',model:'fixture',dimension:3,metric:'cosine'};
const source={kind:'chat',avatar:'a.png',chatFile:'a'};
const collection=collectionIdentity({backend:'qdrant',scope,embedding});
const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',scope,embedding,
 collection:{key:collection.key,physicalName:collection.physicalName}};
const indexes=Object.fromEntries(['userScopeId','collectionId','type','sourceId','branchId','recordId','physicalId'].map(k=>[k,{data_type:'keyword'}]));
async function fx({failWrite=false,allowCanonical=true,failDelete=false}={}){
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
 let target=null,created=false,points=[],writeCount=0,canonicalReadable=true,deleted=false,deleteCalls=0;
 const transport={_request:async(method,url,body)=>{
  if(url.startsWith(`/collections/${collection.physicalName}`)){
   if(!allowCanonical)throw Error('ORIGINAL_UNEXPECTED_PHYSICAL_IO');
   if(!canonicalReadable||deleted)throw Object.assign(new Error('offline'),{httpStatus:404});
   if(method==='DELETE'){deleteCalls++;if(failDelete)throw Error('INJECTED_QDRANT_DISPATCH_LOST');deleted=true;return {result:true};}
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
  makeCanonicalUnavailable:()=>{canonicalReadable=false;},deleteCalls:()=>deleteCalls,
  cleanup:()=>fs.rm(dir,{recursive:true,force:true})};
}


async function withDeleteTicket(f){
 const s02=new CollectionRegistry(path.join(f.ctx.vectorsPath,'.similharity'));
 await s02.reserve({backend:'qdrant',scope,embedding});
 const operationId=randomUUID();
 await f.store.write('operation',{schemaVersion:1,operationId,owner:f.ctx.userScopeId,
  action:'delete',backend:'qdrant',logicalKey:collection.key,physicalName:collection.physicalName,
  source,configId:'default',backupId:f.backup.backupId,sourceFingerprint:f.backup.savedSourceFingerprint,
  inventoryDigest:f.backup.inventory.digest,managedFingerprint:f.backup.managed.fingerprint,
  phase:'PLANNED',createdAt:Date.now(),expiresAt:Date.now()+300000,executionAllowed:false});
 return {s02,operationId};
}
test('M3f owned canonical decommission writes terminal S02 tombstone only after physical absence',async()=>{
 const f=await fx();try{
  const {s02,operationId}=await withDeleteTicket(f);
  const result=await executeM3TrustedDecommission(f.req,operationId,f.deps);
  assert.equal(result.state,'VERIFIED');assert.equal(result.physicalAbsent,true);
  assert.equal(result.registryTombstoned,true);assert.equal(f.deleteCalls(),1);
  assert.equal((await inspectM3LifecycleRecovery(f.ctx,operationId)).lastStage,'COMMITTED');
  const entry=await s02.lookup({backend:'qdrant',scope,embedding});
  assert.equal(entry.status,'DELETED');assert.equal(entry.deletion.operationId,operationId);
  await assert.rejects(()=>s02.reserve({backend:'qdrant',scope,embedding}),
   {code:'S02_COLLECTION_TOMBSTONED'});
  const receipt=await f.store.read('deletion',operationId);
  assert.equal(receipt.verifiedPhysicalAbsent,true);
  await assert.rejects(()=>executeM3TrustedDecommission(f.req,operationId,f.deps));
  assert.equal(f.deleteCalls(),1,'never execute a second physical DELETE');
 }finally{await f.cleanup();}
});
test('M3f unknown delete dispatch outcome retains logical lock and does not tombstone',async()=>{
 const f=await fx({failDelete:true});try{
  const {s02,operationId}=await withDeleteTicket(f);
  await assert.rejects(()=>executeM3TrustedDecommission(f.req,operationId,f.deps),
   /INJECTED_QDRANT_DISPATCH_LOST/);
  assert.equal(f.deleteCalls(),1);
  assert.equal((await inspectM3LifecycleRecovery(f.ctx,operationId)).lastStage,'DISPATCH_PENDING');
  assert.equal((await s02.lookup({backend:'qdrant',scope,embedding})).status,'RESERVED_NOT_ACTIVE');
  await assert.rejects(()=>executeM3TrustedDecommission(f.req,operationId,f.deps),
   {code:'M3_LOGICAL_COLLECTION_BUSY'});
  assert.equal(f.deleteCalls(),1);
 }finally{await f.cleanup();}
});
test('M3f stale inventory refuses before claim and performs no physical deletion',async()=>{
 const f=await fx();try{
  const {s02,operationId}=await withDeleteTicket(f);
  const modified={...f.deps,inventory:async()=>({complete:true,exclusiveOwner:true,rows:[],count:0,digest:H([])})};
  await assert.rejects(()=>executeM3TrustedDecommission(f.req,operationId,modified),
   {code:'M3_DELETE_PHYSICAL_INVENTORY_CHANGED'});
  assert.equal(f.deleteCalls(),0);
  assert.equal((await s02.lookup({backend:'qdrant',scope,embedding})).status,'RESERVED_NOT_ACTIVE');
  const result=await executeM3TrustedDecommission(f.req,operationId,f.deps);
  assert.equal(result.state,'VERIFIED','safe preflight refusals do not consume operation');
 }finally{await f.cleanup();}
});
test('M3v4 browser-facing owned delete dispatches only a verified confirmed plan',async()=>{
 const f=await fx();try{
  const {operationId}=await withDeleteTicket(f);
  f.req.body={operationId,confirmation:'DELETE OWNED COLLECTION'};
  const response=await executeM3Collection(f.req,f.deps);
  assert.equal(response.state,'VERIFIED');assert.equal(response.enabled,true);
  assert.equal(response.validationStatus,'AWAITING_MANUAL_TEST');
  assert.equal(f.deleteCalls(),1);
  await assert.rejects(()=>executeM3Collection(f.req,f.deps));
  assert.equal(f.deleteCalls(),1);
 }finally{await f.cleanup();}
});

test('M3v12 cross-model virtual canonical requires terminal source-selection proof plus Qdrant 404',async()=>{
 const {markM3ResolvedBinding}=await import('../lib/m3-versioned-binding.js');
 const {attestM3RetainedGenerations}=await import('../lib/m3-decommission-transaction.js');
 const f=await fx();try{
  const target='vh2_'+'e'.repeat(48),op=randomUUID(),journal=new M3CutoverJournal(f.ctx,{logicalKey:collection.key});
  const proof={verified:true,exclusiveOwner:true,schemaVerified:true,inventoryVerified:true,
   physicalName:target,logicalKey:collection.key};
  await journal.prepare(binding,{operationId:op,targetPhysicalName:target,backupDigest:'a'.repeat(64),proof});
  await journal.publish(binding,{operationId:op,proof});
  const alias=markM3ResolvedBinding(binding,{logicalKey:collection.key,canonicalName:collection.physicalName,
   physicalName:target,generation:1});
  let lookups=0;
  const transport={_request:async(method,url)=>{
   assert.equal(method,'GET');assert.equal(url,`/collections/${collection.physicalName}`);lookups++;
   throw Object.assign(new Error('not found'),{httpStatus:404});
  }};
  // Remove the canonical backup: this represents the reserved but never
  // provisioned canonical name used by cross-model staged activation.
  await fs.unlink(f.store.file('backup',f.backup.backupId));
  await assert.rejects(()=>attestM3RetainedGenerations(f.ctx,binding,alias,transport,f.store,{
   sourceSelection:async()=>null}),{code:'M3_DELETE_RETAINED_BACKUP_REQUIRED'});
  const result=await attestM3RetainedGenerations(f.ctx,binding,alias,transport,f.store,{
   sourceSelection:async()=>({toLogicalKey:collection.key,generation:1})});
  assert.equal(result[0].classification,'UNPROVISIONED_CANONICAL_ABSENT');
  assert.equal(result[0].retained,false);assert.equal(lookups,1);
  await assert.rejects(()=>attestM3RetainedGenerations(f.ctx,binding,alias,{
   _request:async()=>({result:{}})},f.store,{
   sourceSelection:async()=>({toLogicalKey:collection.key,generation:1})
  }),{code:'M3_DELETE_VIRTUAL_CANONICAL_PRESENT'});
 }finally{await f.cleanup();}
});
