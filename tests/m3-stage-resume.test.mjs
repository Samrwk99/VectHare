import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {M3Store} from '../lib/m3-collections.js';
import {M3PhysicalProgress} from '../lib/m3-physical-progress.js';
import {M3LogicalExclusion} from '../lib/m3-logical-exclusion.js';
import {inspectM3StageContinuation} from '../lib/m3-stage-continuation.js';
import {continueM3VerifiedStage,M3_STAGE_RESUME_CONFIRM} from '../lib/m3-stage-resume.js';
const H=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const A='a'.repeat(64),B='b'.repeat(64);
async function create(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'m3-resume-'));await fs.chmod(dir,0o700);
 const ctx={userScopeId:'alice',vectorsPath:dir},store=new M3Store(ctx),id=randomUUID(),oldBackupId=randomUUID(),targetId=randomUUID();
 const model={dimension:2,metric:'cosine',source:'local',model:'new'},oldModel={...model,model:'old'},source={kind:'lorebook',name:'test'};
 const rows=Array.from({length:40},(_,i)=>({id:randomUUID(),vector:[i+1,2],payload:{recordId:randomUUID(),index:i}})).sort((x,y)=>x.id.localeCompare(y.id));
 const manifest=H(rows),name='vh2_'+H(['m3-fresh-restore',targetId,id]).slice(0,48),adminRoot=path.join(dir,'admin');
 await fs.mkdir(adminRoot,{mode:0o700});
 await store.write('operation',{schemaVersion:1,owner:'alice',operationId:id,backupId:oldBackupId,action:'rebuild',
  backend:'qdrant',logicalKey:A,targetLogicalKey:B,expectedCount:40,source,configId:'default',
  sourceFingerprint:'saved',targetProfileHash:H(model)});
 await store.write('backup',{schemaVersion:1,owner:'alice',backupId:oldBackupId,logicalKey:A,
  physicalName:'original',embedding:oldModel});
 const empty={schemaVersion:1,owner:'alice',sourceId:'src',collectionKey:B,records:{}};
 await store.write('backup',{schemaVersion:1,owner:'alice',backupId:targetId,derivedFromBackupId:oldBackupId,
  logicalKey:B,physicalName:'vh2_'+'a'.repeat(48),purpose:'M3_NEW_MODEL_STAGED_NO_CUTOVER',
  sourceId:'src',scope:{userScopeId:'alice',sourceId:'src'},embedding:model,
  managed:{records:empty.records,fingerprint:H(empty)},inventory:{rows,count:40,digest:manifest}});
 await store.claim(id);
 await new M3PhysicalProgress(ctx,id).recordVerified({index:0,physicalName:name,targetBackupId:targetId,
  manifestDigest:manifest,chunkDigest:H(rows.slice(0,32)),recordCount:32});
 const locks=[new M3LogicalExclusion(ctx,{logicalKey:A}),new M3LogicalExclusion(ctx,{logicalKey:B})];
 for(const lock of locks){await lock.setup();await fs.writeFile(lock.file,JSON.stringify({schemaVersion:1,backend:'qdrant',
  logicalKey:lock.logicalKey,ownerHash:createHash('sha256').update(ctx.userScopeId).digest('hex'),
  operationId:id,pid:999999999})+'\n',{mode:0o600});}
 let points=rows.slice(0,32).map(x=>structuredClone(x));let dispatches=0;
 const registry={...empty,fingerprint:H(empty)};
 const managed={empty:()=>structuredClone(empty),read:async()=>structuredClone(registry),
  lock:async fn=>fn(),save:async doc=>{Object.assign(registry,doc,{fingerprint:H(doc)});}};
 const req={s03:ctx,user:{directories:{},admin:true}};
 const deps={store:()=>store,jobs:()=>({assertNoLease:async()=>true}),ledgerCheckpoint:async()=>({digest:'d'.repeat(64)}),audit:async()=>({claimed:true,lastStage:'DISPATCH_PENDING'}),
  readSnapshot:async()=>({fileHash:'saved',sourceId:'src'}),getStagedProfile:async()=>({profile:model}),
  getProfile:async()=>({configured:true,profile:oldModel}),targetRegistry:()=>managed,
  assertManaged:()=>true,
  verifyPhysical:async()=>({inventoryVerified:true,schemaVerified:true,inventoryDigest:manifest}),
  smoke:async()=>({verified:true,version:'test'}),issueReceipt:async()=>({receiptVerified:true}),
  transport:async()=>({_request:async(method,url,body)=>{
   if(method==='GET')return {result:{config:{params:{vectors:{size:2,distance:'Cosine'}}}}};
   if(method==='PUT'&&url.endsWith('/points?wait=true')){
    dispatches++;points.push(...structuredClone(body.points));return {result:{status:'completed'}};
   }
   if(method==='POST'&&url.endsWith('/points/scroll'))return {result:{points,next_page_offset:null}};
   if(method==='POST'&&url.endsWith('/points'))return {result:points.filter(p=>body.ids.includes(p.id))};
   throw Error(`unexpected ${method} ${url}`);
  }})};
 const proof=await inspectM3StageContinuation(req,id,deps);
 const reviewId=randomUUID();await fs.writeFile(path.join(adminRoot,`m3-stage-resume-${id}.json`),JSON.stringify({
  schemaVersion:1,operationId:id,reviewId,confirmation:M3_STAGE_RESUME_CONFIRM,approved:true,
  proofHash:proof.proofHash})+'\n',{mode:0o600});
 return {ctx,id,req,adminRoot,deps,rows,locks,getDispatches:()=>dispatches,
  setPoints:xs=>points=xs,close:()=>fs.rm(dir,{recursive:true,force:true})};
}
test('administrator-approved prefix continuation writes only missing points under new operation',async()=>{
 const f=await create();try{
  const out=await continueM3VerifiedStage(f.req,f.id,{deps:f.deps,adminRoot:f.adminRoot});
  assert.equal(out.state,'VERIFIED_STAGED');assert.notEqual(out.operationId,f.id);
  assert.equal(out.previousOperationId,f.id);assert.equal(f.getDispatches(),1);
  assert.equal(out.recordCount,40);assert.equal(out.originalOperationReplayed,false);
  for(const lock of f.locks)await assert.rejects(()=>fs.stat(lock.file),{code:'ENOENT'});
  const store=f.deps.store();const stage=await store.read('stage',out.operationId);
  assert.equal(stage.operationId,out.operationId);
  const p=new M3PhysicalProgress(f.ctx,out.operationId);
  assert.equal((await p.list()).length,2);
  await assert.rejects(()=>continueM3VerifiedStage(f.req,f.id,{deps:f.deps,adminRoot:f.adminRoot}));
 }finally{await f.close();}
});
test('new stage dispatch failure retains both transferred locks and refuses retry',async()=>{
 const f=await create();try{
  f.deps.transport=async()=>({_request:async(method,url,body)=>{
   if(method==='GET')return {result:{config:{params:{vectors:{size:2,distance:'Cosine'}}}}};
   if(method==='POST'&&url.endsWith('/points/scroll'))return {result:{points:f.rows.slice(0,32),next_page_offset:null}};
   if(method==='PUT')throw Error('lost write response');
   throw Error('unexpected');
  }});
  await assert.rejects(()=>continueM3VerifiedStage(f.req,f.id,{deps:f.deps,adminRoot:f.adminRoot}),/lost write response/);
  for(const lock of f.locks){const data=JSON.parse(await fs.readFile(lock.file,'utf8'));
   assert.notEqual(data.operationId,f.id);assert.equal(data.pid,process.pid);}
  await assert.rejects(()=>continueM3VerifiedStage(f.req,f.id,{deps:f.deps,adminRoot:f.adminRoot}));
 }finally{await f.close();}
});
test('changed physical frontier refuses prior to transfer and physical write',async()=>{
 const f=await create();try{
  f.setPoints(f.rows.slice(0,33));
  await assert.rejects(()=>continueM3VerifiedStage(f.req,f.id,{deps:f.deps,adminRoot:f.adminRoot}),
   {code:'M3_CONTINUATION_UNACCOUNTED_POINTS'});
  for(const lock of f.locks){const data=JSON.parse(await fs.readFile(lock.file,'utf8'));
   assert.equal(data.operationId,f.id);}
  assert.equal(f.getDispatches(),0);
 }finally{await f.close();}
});

test('adopted original and target locks exclude a second cooperating process during final verification',async()=>{
 const f=await create();try{
  f.deps.verifyPhysical=async()=>{
   for(const lock of f.locks)await assert.rejects(
    ()=>lock.withExclusion({operationId:randomUUID()},async()=>({state:'VERIFIED'})),
    {code:'M3_LOGICAL_COLLECTION_BUSY'});
   return {inventoryVerified:true,schemaVerified:true,inventoryDigest:H(f.rows)};
  };
  const result=await continueM3VerifiedStage(f.req,f.id,{deps:f.deps,adminRoot:f.adminRoot});
  assert.equal(result.state,'VERIFIED_STAGED');
 }finally{await f.close();}
});

test('original process still alive prevents any lock transfer or write',async()=>{
 const f=await create();try{
  for(const lock of f.locks){const doc=JSON.parse(await fs.readFile(lock.file,'utf8'));
   doc.pid=process.pid;await fs.writeFile(lock.file,JSON.stringify(doc)+'\n');}
  await assert.rejects(()=>continueM3VerifiedStage(f.req,f.id,{deps:f.deps,adminRoot:f.adminRoot}));
  for(const lock of f.locks){const doc=JSON.parse(await fs.readFile(lock.file,'utf8'));
   assert.equal(doc.operationId,f.id);assert.equal(doc.pid,process.pid);}
  assert.equal(f.getDispatches(),0);
 }finally{await f.close();}
});
