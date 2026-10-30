import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {collectionIdentity} from '../lib/s02-identity.js';
import {M3CutoverJournal} from '../lib/m3-cutover-journal.js';
import {runtimeWriterBoundary} from '../lib/f09c10-runtime-boundary.js';
import {M3LogicalExclusion} from '../lib/m3-logical-exclusion.js';
const scope={userScopeId:'alice',collectionId:'a',type:'chat',sourceId:'chat-a',branchId:'branch'};
const embedding={source:'transformers',model:'fixture',dimension:3,metric:'cosine'};
const id=collectionIdentity({backend:'qdrant',scope,embedding});
const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',scope,embedding,
 collection:{key:id.key,physicalName:id.physicalName}};
const target='vh2_'+'b'.repeat(48);
const proof={verified:true,exclusiveOwner:true,schemaVerified:true,inventoryVerified:true,logicalKey:id.key,physicalName:target};
async function fixture(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'m3-exclusion-'));await fs.chmod(dir,0o700);
 return {ctx:{userScopeId:'alice',vectorsPath:dir},cleanup:()=>fs.rm(dir,{recursive:true,force:true})};}
const plan=()=>({scope,backend:'qdrant',collectionKey:id.key,physicalCollectionName:id.physicalName,operationId:randomUUID()});
test('normal physical writer excludes M3 prepare for the same logical collection',async()=>{
 const f=await fixture();try{
  const p=plan(),boundary=await runtimeWriterBoundary(f.ctx,p),j=new M3CutoverJournal(f.ctx,{logicalKey:id.key});
  let unblock;const pending=new Promise(r=>unblock=r);let entered;
  const started=new Promise(r=>entered=r);
  const running=boundary.withWriteBoundary(p,async()=>{entered();await pending;return {state:'VERIFIED'};});
  await started;
  await assert.rejects(()=>j.prepare(binding,{operationId:randomUUID(),targetPhysicalName:target,
   backupDigest:'c'.repeat(64),proof}),{code:'M3_LOGICAL_COLLECTION_BUSY'});
  assert.deepEqual(await j.events(),[]);
  unblock();assert.equal((await running).state,'VERIFIED');
  assert.equal((await j.prepare(binding,{operationId:randomUUID(),targetPhysicalName:target,
   backupDigest:'c'.repeat(64),proof})).state,'PREPARED');
 }finally{await f.cleanup();}
});
test('M3 in-flight transition excludes physical writers, without changing the current binding',async()=>{
 const f=await fixture();try{
  const j=new M3CutoverJournal(f.ctx,{logicalKey:id.key});
  let unblock;const pending=new Promise(r=>unblock=r);let entered;
  const started=new Promise(r=>entered=r);
  const running=j.lock(async()=>{entered();await pending;return {state:'PREPARED'};});
  await started;const p=plan(),boundary=await runtimeWriterBoundary(f.ctx,p);
  await assert.rejects(()=>boundary.withWriteBoundary(p,async()=>({state:'VERIFIED'})),{code:'F09C5_WRITER_BUSY'});
  unblock();await running;
  assert.equal((await boundary.withWriteBoundary(p,async()=>({state:'VERIFIED'}))).state,'VERIFIED');
 }finally{await f.cleanup();}
});
test('uncertain physical write retains the logical lock against both writers and journal transitions',async()=>{
 const f=await fixture();try{
  const p=plan(),boundary=await runtimeWriterBoundary(f.ctx,p),j=new M3CutoverJournal(f.ctx,{logicalKey:id.key});
  assert.equal((await boundary.withWriteBoundary(p,async()=>({state:'UNCERTAIN'}))).state,'UNCERTAIN');
  const b=await runtimeWriterBoundary(f.ctx,plan());
  await assert.rejects(()=>b.withWriteBoundary(plan(),async()=>({state:'VERIFIED'})),{code:'F09C5_WRITER_BUSY'});
  await assert.rejects(()=>j.prepare(binding,{operationId:randomUUID(),targetPhysicalName:target,
   backupDigest:'c'.repeat(64),proof}),{code:'M3_LOGICAL_COLLECTION_BUSY'});
  const lock=new M3LogicalExclusion(f.ctx,{logicalKey:id.key});
  assert.ok((await fs.stat(lock.file)).isFile());
 }finally{await f.cleanup();}
});
test('different logical collections retain independent exclusion domains',async()=>{
 const f=await fixture();try{
  const p=plan(),boundary=await runtimeWriterBoundary(f.ctx,p);
  const other='f'.repeat(64),ex=new M3LogicalExclusion(f.ctx,{logicalKey:other});
  let unblock;const pending=new Promise(r=>unblock=r);let entered;
  const started=new Promise(r=>entered=r);
  const held=boundary.withWriteBoundary(p,async()=>{entered();await pending;return {state:'VERIFIED'};});
  await started;assert.equal((await ex.withExclusion({},async()=>({state:'VERIFIED'}))).state,'VERIFIED');
  unblock();await held;
 }finally{await f.cleanup();}
});
test('an older retained physical writer lock prevents M3 journal publication even without logical gate',async()=>{
 const f=await fixture();try{
  const j=new M3CutoverJournal(f.ctx,{logicalKey:id.key});
  const lockRoot=path.join(f.ctx.vectorsPath,'.similharity','f09c10-writer-locks');
  await fs.mkdir(lockRoot,{recursive:true,mode:0o700});
  const {createHash}=await import('node:crypto');
  const name='collection-'+createHash('sha256').update(JSON.stringify(['qdrant',id.physicalName])).digest('hex')+'.lock';
  await fs.writeFile(path.join(lockRoot,name),'UNRECONCILED',{flag:'wx',mode:0o600});
  await assert.rejects(()=>j.prepare(binding,{operationId:randomUUID(),targetPhysicalName:target,
   backupDigest:'c'.repeat(64),proof}),{code:'M3_PHYSICAL_WRITER_LOCK_RETAINED'});
  assert.deepEqual(await j.events(),[]);
  await fs.unlink(path.join(lockRoot,name));
  await j.prepare(binding,{operationId:randomUUID(),targetPhysicalName:target,
   backupDigest:'c'.repeat(64),proof});
 }finally{await f.cleanup();}
});
