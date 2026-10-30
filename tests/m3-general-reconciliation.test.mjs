import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {M3Store} from '../lib/m3-collections.js';
import {inspectM3GeneralReconciliation} from '../lib/m3-general-reconciliation.js';
const KEY='a'.repeat(64);
async function fixture(action='delete'){
 const dir=await fs.mkdtemp(os.tmpdir()+'/m3v13-review-');await fs.chmod(dir,0o700);
 const ctx={userScopeId:'alice',vectorsPath:dir},id=randomUUID(),store=new M3Store(ctx);
 await store.write('operation',{schemaVersion:1,operationId:id,owner:'alice',action,backend:'qdrant',logicalKey:KEY});
 return {ctx,id,store,req:{s03:ctx,user:{admin:true,directories:{}}},cleanup:()=>fs.rm(dir,{recursive:true,force:true})};
}
test('general review never infers NOT_APPLIED from a missing claim',async()=>{
 const f=await fixture();try{
  const view=await inspectM3GeneralReconciliation(f.req,f.id,{store:()=>f.store});
  assert.equal(view.classification,'REVIEW_REQUIRED');assert.equal(view.physicalOutcome,'NOT_PROVEN');
  assert.equal(view.notAppliedProven,false);assert.equal(view.replayAllowed,false);
  assert.equal(view.physicalLockReleaseAuthorized,false);
 }finally{await f.cleanup();}
});
test('claimed operation without terminal audit remains unproven and owner/authentication is mandatory',async()=>{
 const f=await fixture();try{
  await f.store.claim(f.id);
  const view=await inspectM3GeneralReconciliation(f.req,f.id,{store:()=>f.store});
  assert.equal(view.claimed,true);assert.equal(view.classification,'REVIEW_REQUIRED');
  await assert.rejects(()=>inspectM3GeneralReconciliation({...f.req,user:{directories:{}}},f.id),
   {code:'M3_GENERAL_REVIEW_ADMIN_REQUIRED'});
  await assert.rejects(()=>inspectM3GeneralReconciliation({...f.req,s03:{...f.ctx,userScopeId:'bob'}},f.id));
 }finally{await f.cleanup();}
});
test('terminal audit with physical 404 and tombstone can be classified PROVEN_APPLIED for review, not replay',async()=>{
 const f=await fixture();try{
  const view=await inspectM3GeneralReconciliation(f.req,f.id,{store:()=>f.store,
   inspectAudit:async()=>({claimed:true,evidenceComplete:true,lastStage:'COMMITTED'}),
   ledgerCheckpoint:async()=>({digest:'c'.repeat(64)}),jobs:()=>({assertNoLease:async()=>true}),
   terminalProof:async()=>({proofHash:'b'.repeat(64),proof:{physicalState:'ABSENT_404',tombstoneState:'DELETED'}})});
  assert.equal(view.classification,'VERIFIED_APPLIED_REVIEW');assert.equal(view.physicalOutcome,'PROVEN_APPLIED');
  assert.equal(view.physicalLockReleaseAuthorized,false);assert.equal(view.notAppliedProven,false);
  assert.equal(view.replayAllowed,false);
 }finally{await f.cleanup();}
});
test('even terminal audit is REVIEW_REQUIRED when physical evidence is missing or a job still owns scope',async()=>{
 const f=await fixture();try{
  const d={store:()=>f.store,inspectAudit:async()=>({claimed:true,evidenceComplete:true,lastStage:'COMMITTED'}),
   ledgerCheckpoint:async()=>({digest:'c'.repeat(64)}),jobs:()=>({assertNoLease:async()=>true}),
   terminalProof:async()=>{throw Error('lost Qdrant connection');}};
  const view=await inspectM3GeneralReconciliation(f.req,f.id,d);
  assert.equal(view.physicalOutcome,'NOT_PROVEN');assert.equal(view.notAppliedProven,false);
  d.jobs=()=>({assertNoLease:async()=>{throw Error('active job');}});
  d.terminalProof=async()=>({proofHash:'b'.repeat(64),proof:{physicalState:'ABSENT_404',tombstoneState:'DELETED'}});
  const busy=await inspectM3GeneralReconciliation(f.req,f.id,d);
  assert.equal(busy.physicalOutcome,'NOT_PROVEN');assert.equal(busy.jobExclusionVerified,false);
 }finally{await f.cleanup();}
});
