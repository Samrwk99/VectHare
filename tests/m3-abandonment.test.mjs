import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {M3Store} from '../lib/m3-collections.js';
import {M3LogicalExclusion} from '../lib/m3-logical-exclusion.js';
import {M3_ABANDON_CONFIRM,abandonM3UncertainOperation,inspectM3Abandonment} from '../lib/m3-abandonment.js';
const H=x=>createHash('sha256').update(x).digest('hex'),KEY='a'.repeat(64);
async function setup(running=false){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'m3-abandon-'));await fs.chmod(dir,0o700);
 const ctx={userScopeId:'alice',vectorsPath:dir},id=randomUUID(),store=new M3Store(ctx);
 const adminRoot=path.join(dir,'admin');await fs.mkdir(adminRoot,{mode:0o700});
 await store.write('operation',{schemaVersion:1,owner:'alice',operationId:id,backend:'qdrant',action:'restore',logicalKey:KEY});
 const lock=new M3LogicalExclusion(ctx,{logicalKey:KEY});await lock.setup();
 await fs.writeFile(lock.file,JSON.stringify({schemaVersion:1,backend:'qdrant',logicalKey:KEY,
  operationId:id,ownerHash:createHash('sha256').update('alice').digest('hex'),pid:running?process.pid:999999999})+'\n',{mode:0o600});
 const report={operationId:id,classification:'REVIEW_REQUIRED',physicalOutcome:'NOT_PROVEN',
  claimed:true,replayAllowed:false,evidenceHash:'b'.repeat(64)};
 const deps={store:()=>store,inspectGeneral:async()=>report},req={s03:ctx,user:{admin:true,directories:{}}};
 const approval={schemaVersion:1,operationId:id,reviewId:randomUUID(),confirmation:M3_ABANDON_CONFIRM,
  approved:true,decision:'ABANDON',evidenceHash:report.evidenceHash};
 await fs.writeFile(path.join(adminRoot,`m3-abandon-${id}.json`),JSON.stringify(approval)+'\n',{mode:0o600});
 return {req,id,lock,adminRoot,report,deps,close:()=>fs.rm(dir,{recursive:true,force:true})};
}
test('unknown outcome can only be abandoned with immutable admin proof and retained physical lock',async()=>{
 const f=await setup();try{
  const done=await abandonM3UncertainOperation(f.req,f.id,{deps:f.deps,adminRoot:f.adminRoot});
  assert.equal(done.disposition,'ABANDONED_UNCERTAIN_LOCK_RETAINED');
  assert.equal(done.lockReleaseAuthorized,false);assert.equal(done.replayAllowed,false);
  await fs.stat(f.lock.file);
  const saved=await inspectM3Abandonment(f.req,f.id);
  assert.equal(saved.physicalOutcome,'NOT_PROVEN');
  await assert.rejects(()=>abandonM3UncertainOperation(f.req,f.id,{deps:f.deps,adminRoot:f.adminRoot}));
 }finally{await f.close();}
});
test('running process, changed proof and non-admin cannot abandon',async()=>{
 const f=await setup(true);try{
  await assert.rejects(()=>abandonM3UncertainOperation(f.req,f.id,{deps:f.deps,adminRoot:f.adminRoot}));
  await assert.rejects(()=>abandonM3UncertainOperation({...f.req,user:{directories:{}}},f.id,{deps:f.deps,adminRoot:f.adminRoot}));
  const v=JSON.parse(await fs.readFile(f.lock.file,'utf8'));
  v.pid=999999999;await fs.writeFile(f.lock.file,JSON.stringify(v)+'\n');
  f.report.evidenceHash='c'.repeat(64);
  await assert.rejects(()=>abandonM3UncertainOperation(f.req,f.id,{deps:f.deps,adminRoot:f.adminRoot}),
   {code:'M3_ABANDON_EVIDENCE_CHANGED'});
 }finally{await f.close();}
});
