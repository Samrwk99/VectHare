import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {M3Store} from '../lib/m3-collections.js';
import {M3PhysicalProgress,inspectM3PhysicalProgress} from '../lib/m3-physical-progress.js';
const KEY='a'.repeat(64),NAME='vh2_'+'b'.repeat(48),DIGEST='c'.repeat(64);
async function fixture(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'m3v13-physical-'));await fs.chmod(dir,0o700);
 const ctx={userScopeId:'alice',vectorsPath:dir},operationId=randomUUID();
 const db=new M3Store(ctx);await db.write('operation',{schemaVersion:1,owner:'alice',operationId,logicalKey:KEY,
  action:'rebuild',backend:'qdrant',expectedCount:70});
 const req={s03:ctx,user:{directories:{}}};
 const p=new M3PhysicalProgress(ctx,operationId);
 return {ctx,req,p,operationId,dir,cleanup:()=>fs.rm(dir,{recursive:true,force:true})};
}
test('durable physical checkpoints bind each readback to the immutable staging target and remain read-only',async()=>{
 const f=await fixture();try{
  for(let i=0;i<3;i++)await f.p.recordVerified({index:i,physicalName:NAME,targetBackupId:f.operationId,
   manifestDigest:DIGEST,chunkDigest:String(i).repeat(64),recordCount:i===2?6:32});
  const view=await inspectM3PhysicalProgress(f.req,f.operationId);
  assert.equal(view.verifiedRecordCount,70);assert.equal(view.verifiedChunks,3);
  assert.equal(view.state,'WRITE_CHUNKS_READBACK_VERIFIED');
  assert.equal(view.automaticReplayAuthorized,false);assert.equal(view.physicalLockReleaseAuthorized,false);
  await assert.rejects(()=>f.p.recordVerified({index:3,physicalName:NAME,targetBackupId:f.operationId,
   manifestDigest:'d'.repeat(64),chunkDigest:DIGEST,recordCount:1}),{code:'M3_PHYSICAL_PROGRESS_BINDING_CHANGED'});
  await assert.rejects(()=>f.p.recordVerified({index:0,physicalName:NAME,targetBackupId:f.operationId,
   manifestDigest:DIGEST,chunkDigest:DIGEST,recordCount:1}),{code:'M3_PHYSICAL_PROGRESS_OUT_OF_ORDER'});
 }finally{await f.cleanup();}
});
test('forged owners and modified checkpoint evidence are refused',async()=>{
 const f=await fixture();try{
  await f.p.recordVerified({index:0,physicalName:NAME,targetBackupId:f.operationId,
   manifestDigest:DIGEST,chunkDigest:DIGEST,recordCount:32});
  await assert.rejects(()=>inspectM3PhysicalProgress({...f.req,s03:{...f.ctx,userScopeId:'bob'}},f.operationId));
  const file=path.join(f.p.root,'00000.json');const doc=JSON.parse(await fs.readFile(file,'utf8'));doc.recordCount=20;
  await fs.writeFile(file,JSON.stringify(doc));
  await assert.rejects(()=>inspectM3PhysicalProgress(f.req,f.operationId),{code:'M3_PHYSICAL_PROGRESS_ENTRY_CORRUPT'});
 }finally{await f.cleanup();}
});
test('physical stage progress never infers whether an uncheckpointed dispatch ran',async()=>{
 const f=await fixture();try{
  const before=await inspectM3PhysicalProgress(f.req,f.operationId);
  assert.equal(before.state,'PARTIAL_OR_NOT_STARTED');assert.equal(before.verifiedChunks,0);
  await f.p.recordVerified({index:0,physicalName:NAME,targetBackupId:f.operationId,
   manifestDigest:DIGEST,chunkDigest:DIGEST,recordCount:32});
  const after=await inspectM3PhysicalProgress(f.req,f.operationId);
  assert.equal(after.state,'PARTIAL_OR_NOT_STARTED');assert.equal(after.verifiedRecordCount,32);
  assert.equal(after.automaticReplayAuthorized,false);
 }finally{await f.cleanup();}
});
