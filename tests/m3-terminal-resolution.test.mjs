import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {M3Store} from '../lib/m3-collections.js';
import {M3ExecutionAudit} from '../lib/m3-execution-audit.js';
import {M3LogicalExclusion,withM3LifecycleExclusion} from '../lib/m3-logical-exclusion.js';
import {CollectionRegistry} from '../lib/s02-registry.js';
import {collectionIdentity} from '../lib/s02-identity.js';
import {inspectM3TerminalProof,quarantineM3TerminalLock,M3_TERMINAL_CONFIRM} from '../lib/m3-terminal-resolution.js';
const H=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const scope={userScopeId:'alice',collectionId:'a',type:'chat',sourceId:'chat-a',branchId:'b'};
const embedding={source:'transformers',model:'unit-fixture',dimension:3,metric:'cosine'};
const canonical=collectionIdentity({backend:'qdrant',scope,embedding});
async function fixture({terminal=true,absent=true,dead=true,admin=true,tombstone=true}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'m3v6-admin-'));await fs.chmod(dir,0o700);
 const adminRoot=path.join(dir,'admin');await fs.mkdir(adminRoot,{mode:0o700});
 const ctx={userScopeId:'alice',vectorsPath:dir},req={s03:ctx,user:{admin,directories:{}},body:{}};
 const operationId=randomUUID(),backupId=randomUUID(),store=new M3Store(ctx);
 const backup={schemaVersion:1,owner:'alice',backupId,backend:'qdrant',scope,embedding,logicalKey:canonical.key,
  physicalName:canonical.physicalName,inventory:{rows:[],count:0,digest:H([]),complete:true,exclusiveOwner:true}};
 const ticket={operationId,owner:'alice',backend:'qdrant',action:'delete',logicalKey:canonical.key,
  physicalName:canonical.physicalName,backupId,inventoryDigest:backup.inventory.digest};
 await store.write('backup',backup);await store.write('operation',ticket);
 const s02=new CollectionRegistry(path.join(dir,'.similharity'));await s02.reserve({backend:'qdrant',scope,embedding});
 if(tombstone)await s02.tombstone({backend:'qdrant',scope,embedding},{operationId,backupId,physicalAbsent:true});
 await store.write('deletion',{owner:'alice',operationId,backupId,logicalKey:canonical.key,
  physicalName:canonical.physicalName,inventoryDigest:backup.inventory.digest,
  verifiedPhysicalAbsent:true,registryTombstoned:true});
 await withM3LifecycleExclusion(ctx,{logicalKey:canonical.key,operationId},async holder=>{
  await store.claim(operationId);
  const audit=new M3ExecutionAudit(ctx,{operationId,logicalKey:canonical.key,action:'delete'});
  for(const stage of ['CLAIMED','DISPATCH_PENDING','PHYSICAL_VERIFIED',...(terminal?['COMMITTED']:[])])
   await audit.checkpoint(holder,stage);
  return {state:'VERIFIED'};
 });
 const logical=new M3LogicalExclusion(ctx,{logicalKey:canonical.key});
 const lock={schemaVersion:1,backend:'qdrant',logicalKey:canonical.key,
  ownerHash:createHash('sha256').update('alice').digest('hex'),operationId,
  pid:dead?2147483600:process.pid};
 await fs.writeFile(logical.file,JSON.stringify(lock)+'\n',{mode:0o600});
 const transport={_request:async()=>{if(absent)throw Object.assign(new Error('not found'),{httpStatus:404});
  return {result:{}};}};
 const deps={store:()=>store,s02:()=>s02,jobs:()=>({assertNoLease:async()=>true}),transport:async()=>transport,
  ledgerCheckpoint:async()=>({digest:H([])})};
 const cleanup=()=>fs.rm(dir,{force:true,recursive:true});
 return {req,ctx,store,deps,operationId,adminRoot,logical,cleanup};
}
async function approve(f,proofHash,reviewId=randomUUID()){
 const approval={schemaVersion:1,operationId:f.operationId,reviewId,confirmation:M3_TERMINAL_CONFIRM,
  adminApproved:true,quiescent:true,proofHash};
 await fs.writeFile(path.join(f.adminRoot,`m3-terminal-review-${f.operationId}.json`),JSON.stringify(approval)+'\n',{mode:0o600});
 return reviewId;
}
test('M3v6 terminal deletion requires server-owned approval and quarantines only the exact abandoned lock',async()=>{
 const f=await fixture();try{
  const proof=await inspectM3TerminalProof(f.req,f.operationId,f.deps);
  assert.match(proof.proofHash,/^[a-f0-9]{64}$/);
  await assert.rejects(()=>quarantineM3TerminalLock(f.req,f.operationId,{deps:f.deps,adminRoot:f.adminRoot}),{code:'ENOENT'});
  const reviewId=await approve(f,proof.proofHash);
  const result=await quarantineM3TerminalLock(f.req,f.operationId,{deps:f.deps,adminRoot:f.adminRoot});
  assert.equal(result.disposition,'QUARANTINED_COMMITTED_DELETE_LOCK');assert.equal(result.mutationReplayed,false);
  await assert.rejects(()=>fs.lstat(f.logical.file),{code:'ENOENT'});
  assert.equal((await fs.readdir(path.join(f.ctx.vectorsPath,'.similharity','m3-terminal-resolutions',reviewId))).length,3);
  await assert.rejects(()=>quarantineM3TerminalLock(f.req,f.operationId,{deps:f.deps,adminRoot:f.adminRoot}));
 }finally{await f.cleanup();}
});
test('M3v6 refuses incomplete lifecycle audit or running owner PID',async()=>{
 for(const o of [{terminal:false},{dead:false}]){const f=await fixture(o);try{
  await assert.rejects(()=>inspectM3TerminalProof(f.req,f.operationId,f.deps),
   {code:o.terminal===false?'M3_RESOLUTION_NOT_TERMINAL':'M3_RESOLUTION_PROCESS_RUNNING'});
 }finally{await f.cleanup();}}
});
test('M3v6 refuses missing S02 tombstone, live Qdrant collection, non-admin and changed review evidence',async()=>{
 for(const o of [{tombstone:false},{absent:false},{admin:false}]){const f=await fixture(o);try{
  await assert.rejects(()=>inspectM3TerminalProof(f.req,f.operationId,f.deps));
 }finally{await f.cleanup();}}
 const f=await fixture();try{
  const proof=await inspectM3TerminalProof(f.req,f.operationId,f.deps);
  await approve(f,'a'.repeat(64));
  await assert.rejects(()=>quarantineM3TerminalLock(f.req,f.operationId,{deps:f.deps,adminRoot:f.adminRoot}),
   {code:'M3_RESOLUTION_EVIDENCE_CHANGED'});
  assert.equal((await fs.lstat(f.logical.file)).isFile(),true);
  assert.equal(proof.proof.physicalState,'ABSENT_404');
 }finally{await f.cleanup();}
});
