import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {M3Store} from '../lib/m3-collections.js';
import {M3LogicalExclusion} from '../lib/m3-logical-exclusion.js';
import {inspectM3ProvenAdjudication,quarantineM3ProvenLocks,M3_GENERAL_CONFIRM} from '../lib/m3-general-adjudication.js';
const H=x=>createHash('sha256').update(x).digest('hex'),KEY='a'.repeat(64);
async function fixture({running=false,action='empty'}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'m3-adjud-'));await fs.chmod(dir,0o700);
 const ctx={userScopeId:'alice',vectorsPath:dir},id=randomUUID(),store=new M3Store(ctx);
 const adminRoot=path.join(dir,'admin');await fs.mkdir(adminRoot,{mode:0o700});
 await store.write('operation',{schemaVersion:1,operationId:id,owner:'alice',action,backend:'qdrant',logicalKey:KEY});
 const lock=new M3LogicalExclusion(ctx,{logicalKey:KEY});await lock.setup();
 await fs.writeFile(lock.file,JSON.stringify({schemaVersion:1,backend:'qdrant',logicalKey:KEY,
  ownerHash:H(ctx.userScopeId),operationId:id,pid:running?process.pid:999999999})+'\n',{mode:0o600});
 const req={s03:ctx,user:{directories:{},admin:true}};
 const evidence={classification:'VERIFIED_APPLIED_REVIEW',physicalOutcome:'PROVEN_APPLIED',
  completedAudit:true,jobExclusionVerified:true,ledgerDigest:'b'.repeat(64),
  physicalFingerprint:'c'.repeat(64),evidenceHash:'d'.repeat(64),replayAllowed:false};
 const deps={store:()=>store,inspectGeneral:async()=>evidence};
 return {ctx,id,req,adminRoot,deps,lock,evidence,close:()=>fs.rm(dir,{force:true,recursive:true})};
}
test('proven terminal operation needs out-of-band admin approval and retains forensic lock',async()=>{
 const f=await fixture();try{
  const proof=await inspectM3ProvenAdjudication(f.req,f.id,f.deps);
  assert.equal(proof.eligible,true);assert.equal(proof.replayAllowed,false);
  await assert.rejects(()=>quarantineM3ProvenLocks(f.req,f.id,{deps:f.deps,adminRoot:f.adminRoot}));
  await fs.writeFile(path.join(f.adminRoot,`m3-general-review-${f.id}.json`),JSON.stringify({
   schemaVersion:1,operationId:f.id,reviewId:randomUUID(),confirmation:M3_GENERAL_CONFIRM,
   approved:true,decision:'PROVEN_APPLIED',proofHash:proof.proofHash})+'\n',{mode:0o600});
  const result=await quarantineM3ProvenLocks(f.req,f.id,{deps:f.deps,adminRoot:f.adminRoot});
  assert.equal(result.disposition,'PROVEN_APPLIED_LOCKS_QUARANTINED');
  await assert.rejects(()=>fs.stat(f.lock.file),{code:'ENOENT'});
  const cases=await fs.readdir(path.join(f.ctx.vectorsPath,'.similharity','m3-general-adjudications'));
  assert.equal(cases.length,1);
  await assert.rejects(()=>quarantineM3ProvenLocks(f.req,f.id,{deps:f.deps,adminRoot:f.adminRoot}));
 }finally{await f.close();}
});
test('live PID, ambiguous outcome, non-admin and wrong approval are refused',async()=>{
 const f=await fixture({running:true});try{
  await assert.rejects(()=>inspectM3ProvenAdjudication(f.req,f.id,f.deps),{code:'M3_ADJUDICATION_PROCESS_STILL_RUNNING'});
  await assert.rejects(()=>inspectM3ProvenAdjudication({...f.req,user:{directories:{}}},f.id,f.deps),
   {code:'M3_ADJUDICATION_ADMIN_REQUIRED'});
  const dead=await fs.readFile(f.lock.file,'utf8');await fs.writeFile(f.lock.file,dead.replace(String(process.pid),'999999999'));
  f.evidence.physicalOutcome='NOT_PROVEN';
  await assert.rejects(()=>inspectM3ProvenAdjudication(f.req,f.id,f.deps),{code:'M3_ADJUDICATION_OUTCOME_NOT_PROVEN'});
 }finally{await f.close();}
});
