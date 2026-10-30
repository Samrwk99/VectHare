import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {M2JobStore,previewM2Job,createM2Job,resumeM2Job,pauseM2Job,cancelM2Job,
 stepM2Job,getM2Job,m2EvidenceBundle,reviewM2Adjudication,registerM2Routes} from '../lib/m2-jobs.js';
const id1=randomUUID(),id2=randomUUID(),source={kind:'chat',avatar:'a.png',chatFile:'c1'};
const key='a'.repeat(64),hash='b'.repeat(64);
async function fixture(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'m2-jobs-'));await fs.chmod(dir,0o700);
 const root=path.join(dir,'admin');await fs.mkdir(root,{mode:0o700});
 const req={s03:{userScopeId:'alice',vectorsPath:dir},user:{directories:{},profile:{admin:true}},body:{}};
 const state={fingerprint:hash,rows:[{recordId:id1,contentHash:hash,managedState:'UNTRACKED',availableActions:['insert']},
  {recordId:id2,contentHash:hash,managedState:'UNTRACKED',availableActions:['insert']}],dispatches:[],plans:[]};
 const deps={adminRoot:root,certify:async()=>true,
  preview:async()=>({logicalKey:key,fileFingerprint:state.fingerprint,completeSavedSource:true,records:state.rows}),
  plan:async(_req,_key)=>{const operationId=randomUUID();state.plans.push(operationId);return {operationId,recordId:_req.body.recordId,logicalKey:key};},
  execute:async req=>{state.dispatches.push(req.body.operationId);return {operationId:req.body.operationId,state:'VERIFIED'};}};
 return {dir,root,req,deps,state,cleanup:()=>fs.rm(dir,{recursive:true,force:true})};
}
const intent={backend:'qdrant',source,mode:'vectorize-current',maxEmbeddings:2,maxItems:2};
async function create(f,body=intent){f.req.body={intent:body,confirmation:'CREATE BOUNDED SAVED-SOURCE JOB'};return createM2Job(f.req,f.deps);}
test('M2 persistent bounded queue checkpointed one record per step',async()=>{
 const f=await fixture();try{
  f.req.body=intent;const p=await previewM2Job(f.req,f.deps);assert.equal(p.counts.eligible,2);
  const job=await create(f);assert.equal(job.state,'PAUSED');
  await resumeM2Job(f.req,job.jobId,f.deps);
  const one=await stepM2Job(f.req,job.jobId,f.deps);assert.equal(one.completed,1);assert.equal(one.state,'READY');
  // A fresh store instance rehydrates from disk with durable checkpoint.
  const fresh=new M2JobStore(f.req.s03);assert.equal((await fresh.read(job.jobId)).cursor,1);
  await new Promise(resolve=>setTimeout(resolve,520));
  const two=await stepM2Job(f.req,job.jobId,f.deps);
  assert.equal(two.state,'COMPLETED');assert.equal(two.completed,2);assert.equal(f.state.dispatches.length,2);
  await assert.rejects(()=>stepM2Job(f.req,job.jobId,f.deps),{code:'M2_JOB_NOT_READY'});
 }finally{await f.cleanup();}
});
test('M2 source changes and uncertified host pause before any dispatch claim',async()=>{
 const f=await fixture();try{
  const job=await create(f);await resumeM2Job(f.req,job.jobId,f.deps);
  f.state.fingerprint='c'.repeat(64);
  assert.equal((await stepM2Job(f.req,job.jobId,f.deps)).state,'PAUSED');
  assert.deepEqual(f.state.dispatches,[]);
  await resumeM2Job(f.req,job.jobId,f.deps);
  f.state.fingerprint=hash;
  const blocked=await stepM2Job(f.req,job.jobId,{...f.deps,certify:async()=>false});
  assert.equal(blocked.state,'PAUSED');assert.equal(blocked.dispatched,0);
 }finally{await f.cleanup();}
});
test('M2 dispatch uncertainty remains blocked, cannot resume or replay, evidence bound to job',async()=>{
 const f=await fixture();try{
  const job=await create(f);await resumeM2Job(f.req,job.jobId,f.deps);
  const result=await stepM2Job(f.req,job.jobId,{...f.deps,execute:async req=>{f.state.dispatches.push(req.body.operationId);throw Error('ACK LOST');}});
  assert.equal(result.state,'BLOCKED_UNCERTAIN');assert.equal(result.items[0].state,'UNCERTAIN');
  assert.equal(result.dispatched,1);
  await assert.rejects(()=>resumeM2Job(f.req,job.jobId,f.deps),{code:'M2_UNCERTAIN_REVIEW_REQUIRED'});
  await assert.rejects(()=>stepM2Job(f.req,job.jobId,f.deps),{code:'M2_JOB_NOT_READY'});
  const evidence=await m2EvidenceBundle(f.req,job.jobId,f.deps);assert.equal(evidence.reviewState,'REVIEW_REQUIRED');
  assert.equal(evidence.uncertain.operationId,result.items[0].operationId);
  f.req.body={decision:'NOT_APPLIED'};
  await assert.rejects(()=>reviewM2Adjudication(f.req,job.jobId,f.deps),{code:'M2_REVIEW_BODY_FORBIDDEN'});
  assert.equal(f.state.dispatches.length,1);
 }finally{await f.cleanup();}
});
test('M2 selected IDs and budgets refuse injection and excess work',async()=>{
 const f=await fixture();try{
  for(const extra of [{vector:[1,2,3]},{ownerId:'bob'},{physicalName:'other'},{text:'hijack'}]){
   f.req.body={...intent,...extra};await assert.rejects(()=>previewM2Job(f.req,f.deps),{code:'M2_BODY_FIELDS_FORBIDDEN'});
  }
  f.req.body={...intent,maxItems:1};await assert.rejects(()=>previewM2Job(f.req,f.deps),{code:'M2_JOB_BUDGET_EXCEEDED'});
  f.req.body={...intent,mode:'vectorize-selected',selectedIds:[randomUUID()]};
  await assert.rejects(()=>previewM2Job(f.req,f.deps),{code:'M2_SELECTED_RECORD_NOT_SAVED'});
  f.req.body={...intent,mode:'vectorize-selected',selectedIds:[id2]};
  assert.deepEqual((await previewM2Job(f.req,f.deps)).items.map(i=>i.recordId),[id2]);
 }finally{await f.cleanup();}
});
test('M2 job modifications, explicit pause/cancel and lock quarantine',async()=>{
 const f=await fixture();try{
  const job=await create(f);
  await resumeM2Job(f.req,job.jobId,f.deps);assert.equal((await pauseM2Job(f.req,job.jobId,f.deps)).state,'PAUSED');
  const store=new M2JobStore(f.req.s03);await store.setup();await fs.mkdir(store.lockDir(job.jobId),{mode:0o700});
  assert.equal((await getM2Job(f.req,job.jobId,f.deps)).lockRequiresReview,true);
  await assert.rejects(()=>resumeM2Job(f.req,job.jobId,f.deps),{code:'M2_JOB_LOCKED_REVIEW_REQUIRED'});
  await fs.rmdir(store.lockDir(job.jobId));
  assert.equal((await cancelM2Job(f.req,job.jobId,f.deps)).state,'CANCELLED');
  await assert.rejects(()=>resumeM2Job(f.req,job.jobId,f.deps),{code:'M2_RESUME_STATE_DENIED'});
 }finally{await f.cleanup();}
});
test('M2 registry routes available, and no generic write route unblocked',()=>{
 const routes={post(p,fn){this['POST '+p]=fn;},get(p,fn){this['GET '+p]=fn;}};
 registerM2Routes(routes);
 for(const r of ['POST /v2/m2/jobs/preview','POST /v2/m2/jobs/create','POST /v2/m2/jobs/:jobId/step',
   'GET /v2/m2/jobs/:jobId/evidence','POST /v2/m2/jobs/:jobId/review'])assert.equal(typeof routes[r],'function');
 assert.equal(routes['POST /v2/operations/submit'],undefined);
});
test('M2 collection lease blocks competing jobs, releases only after safe cancellation',async()=>{
 const f=await fixture();try{
  const first=await create(f);await assert.rejects(()=>create(f),{code:'M2_COLLECTION_JOB_EXCLUDED'});
  await cancelM2Job(f.req,first.jobId,f.deps);
  const second=await create(f);assert.notEqual(second.jobId,first.jobId);
  assert.equal(second.state,'PAUSED');
 }finally{await f.cleanup();}
});
test('M2 changed-record revectorization uses managed source hashes',async()=>{
 const f=await fixture();try{
  f.state.rows=[{...f.state.rows[0],managedState:'ACTIVE',changed:true,availableActions:['update','revectorize']},
   {...f.state.rows[1],managedState:'ACTIVE',changed:false,availableActions:['update','revectorize']}];
  f.req.body={backend:'qdrant',source,mode:'revectorize-changed',maxItems:2};
  const preview=await previewM2Job(f.req,f.deps);
  assert.equal(preview.items.length,1);assert.equal(preview.items[0].action,'revectorize');
 }finally{await f.cleanup();}
});
test('M2 administrator approval is private, evidence-bound, one use and never clears uncertain operation',async()=>{
 const f=await fixture();try{
  const job=await create(f);await resumeM2Job(f.req,job.jobId,f.deps);
  await stepM2Job(f.req,job.jobId,{...f.deps,execute:async()=>{throw Error('LOST');}});
  const bundle=await m2EvidenceBundle(f.req,job.jobId,f.deps);
  const approval={schemaVersion:1,jobId:job.jobId,ownerScopeHash:bundle.ownerScopeHash,evidenceHash:bundle.evidenceHash,
   reviewId:randomUUID(),decision:'APPLIED',backupVerified:true,backendEvidenceFingerprint:'c'.repeat(64),
   authoritativeEvidenceVerified:true,adminApproved:true};
  await fs.writeFile(path.join(f.root,`m2-review-${job.jobId}.json`),JSON.stringify(approval),{mode:0o600});
  f.req.body={};
  const r=await reviewM2Adjudication(f.req,job.jobId,f.deps);assert.equal(r.lockQuarantined,true);
  assert.equal((await getM2Job(f.req,job.jobId,f.deps)).state,'BLOCKED_UNCERTAIN');
  await assert.rejects(()=>reviewM2Adjudication(f.req,job.jobId,f.deps),{code:'M2_ADMIN_PROOF_INSUFFICIENT'});
  assert.equal((await new M2JobStore(f.req.s03).read(job.jobId)).decisions.length,1);
 }finally{await f.cleanup();}
});
test('M2 simulated process death after durable DISPATCHING never executes the claimed item',async()=>{
 const f=await fixture();try{
  const job=await create(f);await resumeM2Job(f.req,job.jobId,f.deps);
  const store=new M2JobStore(f.req.s03);const record=await store.read(job.jobId);
  record.items[0].state='DISPATCHING';record.items[0].operationId=randomUUID();record.dispatched=1;
  await store.persist(record);
  assert.equal((await getM2Job(f.req,job.jobId,f.deps)).state,'BLOCKED_UNCERTAIN');
  await assert.rejects(()=>stepM2Job(f.req,job.jobId,f.deps),{code:'M2_UNCERTAIN_REVIEW_REQUIRED'});
  const evidence=await m2EvidenceBundle(f.req,job.jobId,f.deps);
  assert.equal(evidence.items[0].state,'DISPATCHING');
  assert.deepEqual(f.state.dispatches,[]);
 }finally{await f.cleanup();}
});
