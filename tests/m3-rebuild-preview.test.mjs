import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {previewM3ModelRebuild} from '../lib/m3-rebuild-preview.js';
import {M3Store} from '../lib/m3-collections.js';
import {collectionIdentity,contentFingerprint,recordIdentity} from '../lib/s02-identity.js';
import {savedRecordIdentity} from '../lib/m1-saved-records.js';
const H=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const scope={userScopeId:'alice',collectionId:'a',type:'chat',sourceId:'chat-a',branchId:'branch'};
const source={kind:'chat',avatar:'a.png',chatFile:'a'};
const oldProfile={source:'transformers',model:'old',dimension:3,metric:'cosine'};
const newProfile={source:'transformers',model:'new',dimension:4,metric:'cosine'};
const oldIdentity=collectionIdentity({backend:'qdrant',scope,embedding:oldProfile});
const targetIdentity=collectionIdentity({backend:'qdrant',scope,embedding:newProfile});
const oldBinding={authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',scope,
 embedding:oldProfile,collection:{key:oldIdentity.key,physicalName:oldIdentity.physicalName}};
const targetBinding={authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',scope,
 embedding:newProfile,collection:{key:targetIdentity.key,physicalName:targetIdentity.physicalName}};
const msg={recordId:randomUUID(),text:'source-authored text'};
msg.contentHash=contentFingerprint(msg.text);
const {recordId}=savedRecordIdentity({userScopeId:'alice'},oldBinding,msg);
const physicalId=recordIdentity(scope,recordId).physicalId;
const metadata={vecthareRecordV2:{schemaVersion:2,recordId,identity:{userScopeId:'alice',sourceId:scope.sourceId,sourceEntryId:msg.recordId},contentHash:msg.contentHash,revision:1}};
const point={id:physicalId,vector:[1,0,0],payload:{...scope,recordId,physicalId,
 revision:1,text:msg.text,textHash:msg.contentHash,metadata,metadataHash:H(metadata),
 embedding:oldProfile,vectorHash:H([1,0,0]),vectorReference:[1,0,0]}};
const selector={backend:'qdrant',source,backupId:null};
async function fixture(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'m3-rebuild-'));await fs.chmod(dir,0o700);
 const ctx={userScopeId:'alice',vectorsPath:dir};
 const req={s03:ctx,user:{directories:{}},body:{...selector}};
 const row=structuredClone(point),rows=[row],fingerprint='b'.repeat(64);
 const managed={fingerprint:'f'.repeat(64),records:{[recordId]:{state:'ACTIVE',recordId,revision:1,contentHash:msg.contentHash}}};
 const backup={schemaVersion:1,backupId:randomUUID(),owner:'alice',backend:'qdrant',
  logicalKey:oldIdentity.key,physicalName:oldIdentity.physicalName,scope,embedding:oldProfile,source,
  configId:'default',sourceId:scope.sourceId,savedSourceFingerprint:fingerprint,
  managed,operationCheckpoint:{count:0,digest:H([])},
  inventory:{rows,count:1,digest:H(rows),complete:true,exclusiveOwner:true}};
 req.body.backupId=backup.backupId;
 const store=new M3Store(ctx);await store.write('backup',backup);
 const snapshot={sourceId:scope.sourceId,fileHash:fingerprint,messages:[msg]};
 const profile={configured:true,profile:oldProfile};
 const staged={configured:true,profile:newProfile};
 const deps={store:()=>store,getProfile:async()=>profile,getStagedProfile:async()=>staged,bind:async()=>({binding:targetBinding}),
  readSnapshot:async()=>structuredClone(snapshot),jobs:()=>({assertNoLease:async()=>true}),
  registry:()=>({read:async()=>structuredClone(managed)}),
  ledgerCheckpoint:async()=>({count:0,digest:H([])}),
  transport:async()=>({_request:async()=>{throw Error('no physical IO in fixture');}}),
  inventory:async()=>({rows:structuredClone(rows),digest:H(rows),count:1,complete:true,exclusiveOwner:true})};
 return {req,deps,backup,profile,staged,rows,snapshot,managed,cleanup:()=>fs.rm(dir,{recursive:true,force:true})};
}
test('M3.5 source-attested rebuild preview identifies DISTINCT target without dispatch',async()=>{
 const f=await fixture();try{
  const result=await previewM3ModelRebuild(f.req,f.deps);
  assert.equal(result.mode,'PREVIEW');assert.equal(result.enabled,false);
  assert.equal(result.recordsToReembed,1);assert.equal(result.tombstonesToPreserve,0);
  assert.equal(result.oldLogicalKey,oldIdentity.key);assert.equal(result.newLogicalKey,targetIdentity.key);
  assert.equal(result.reasonCode,'M3_REBUILD_ATOMIC_PROFILE_SWITCH_UNIMPLEMENTED');
  assert.equal(Object.keys(result).some(k=>['vectors','texts','credentials','physicalName'].includes(k)),false);
 }finally{await f.cleanup();}
});
test('M3.5 refuses same profile, stale saved source and changed registry or vector inventory',async()=>{
 const f=await fixture();try{
  f.staged.profile=oldProfile;
  await assert.rejects(()=>previewM3ModelRebuild(f.req,f.deps),{code:'M3_REBUILD_DISTINCT_PROFILE_REQUIRED'});
  f.staged.profile=newProfile;f.snapshot.fileHash='a'.repeat(64);
  await assert.rejects(()=>previewM3ModelRebuild(f.req,f.deps),{code:'M3_REBUILD_SOURCE_CHANGED'});
  f.snapshot.fileHash=f.backup.savedSourceFingerprint;f.managed.fingerprint='2'.repeat(64);
  await assert.rejects(()=>previewM3ModelRebuild(f.req,f.deps),{code:'M3_REBUILD_MANAGED_REGISTRY_CHANGED'});
  f.managed.fingerprint='f'.repeat(64);f.rows[0].payload.textHash='forged';
  await assert.rejects(()=>previewM3ModelRebuild(f.req,f.deps),{code:'M3_REBUILD_ORIGINAL_INVENTORY_CHANGED'});
 }finally{await f.cleanup();}
});
test('M3.5 rejects invented user content, duplicate stable IDs and browser injection',async()=>{
 const f=await fixture();try{
  f.snapshot.messages[0].text='different message';
  f.snapshot.messages[0].contentHash=contentFingerprint('different message');
  await assert.rejects(()=>previewM3ModelRebuild(f.req,f.deps),{code:'M3_REBUILD_SOURCE_PROVENANCE_MISMATCH'});
  f.snapshot.messages=[msg,msg];
  await assert.rejects(()=>previewM3ModelRebuild(f.req,f.deps),{code:'M3_REBUILD_DUPLICATE_SOURCE_ID'});
  f.req.body.owner='bob';
  await assert.rejects(()=>previewM3ModelRebuild(f.req,f.deps),{code:'M3_REBUILD_PREVIEW_SELECTOR_INVALID'});
 }finally{await f.cleanup();}
});
