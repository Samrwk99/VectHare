import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {M3Store} from '../lib/m3-collections.js';
import {M3ExecutionAudit,inspectM3LifecycleRecovery} from '../lib/m3-execution-audit.js';
import {withM3LifecycleExclusion} from '../lib/m3-logical-exclusion.js';
const key='e'.repeat(64);
async function fixture(action='delete'){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'m3g-audit-'));await fs.chmod(root,0o700);
 const ctx={vectorsPath:root,userScopeId:'alice'},operationId=randomUUID(),store=new M3Store(ctx);
 await store.write('operation',{owner:'alice',operationId,logicalKey:key,action,backend:'qdrant',createdAt:Date.now()});
 return {ctx,operationId,store,audit:new M3ExecutionAudit(ctx,{operationId,logicalKey:key,action}),
  cleanup:()=>fs.rm(root,{recursive:true,force:true})};
}
test('M3g lifecycle audit requires the server-held logical lease and a durable claim',async()=>{
 const f=await fixture();try{
  await assert.rejects(()=>f.audit.checkpoint({},'CLAIMED'),{code:'M3_LIFECYCLE_HOLDER_REQUIRED'});
  await withM3LifecycleExclusion(f.ctx,{logicalKey:key,operationId:f.operationId},async holder=>{
   await assert.rejects(()=>f.audit.checkpoint(holder,'CLAIMED'),{code:'M3_AUDIT_CLAIM_REQUIRED'});
   await f.store.claim(f.operationId);
   await f.audit.checkpoint(holder,'CLAIMED');
   await f.audit.checkpoint(holder,'DISPATCH_PENDING');
   await assert.rejects(()=>f.audit.checkpoint(holder,'COMMITTED'),{code:'M3_AUDIT_INVALID_STAGE'});
   return {state:'VERIFIED'};
  });
  assert.deepEqual((await f.audit.events()).map(e=>e.stage),['CLAIMED','DISPATCH_PENDING']);
  const evidence=await inspectM3LifecycleRecovery(f.ctx,f.operationId);
  assert.equal(evidence.lastStage,'DISPATCH_PENDING');assert.equal(evidence.classification,'REVIEW_REQUIRED');
  assert.equal(evidence.automaticReplayAuthorized,false);assert.equal(evidence.physicalLockReleaseAuthorized,false);
 }finally{await f.cleanup();}
});
test('M3g inspection distinguishes never-claimed plans and crashes between claim and first event',async()=>{
 const f=await fixture('restore');try{
  const untouched=await inspectM3LifecycleRecovery(f.ctx,f.operationId);
  assert.equal(untouched.classification,'NOT_DISPATCHED_BY_THIS_CLAIM');
  assert.equal(untouched.automaticReplayAuthorized,false);
  await f.store.claim(f.operationId);
  const ambiguous=await inspectM3LifecycleRecovery(f.ctx,f.operationId);
  assert.equal(ambiguous.claimed,true);assert.equal(ambiguous.eventCount,0);
  assert.equal(ambiguous.classification,'REVIEW_REQUIRED');
 }finally{await f.cleanup();}
});
test('M3g audit rejects a missing or corrupted chained event rather than pretending completion',async()=>{
 const f=await fixture('rollback');try{
  await withM3LifecycleExclusion(f.ctx,{logicalKey:key,operationId:f.operationId},async holder=>{
   await f.store.claim(f.operationId);
   await f.audit.checkpoint(holder,'CLAIMED');
   await f.audit.checkpoint(holder,'DISPATCH_PENDING');
   await f.audit.checkpoint(holder,'PHYSICAL_VERIFIED',{detail:{digest:'hidden'}});
   await f.audit.checkpoint(holder,'JOURNAL_PUBLISHED');
   await f.audit.checkpoint(holder,'COMMITTED');
   return {state:'VERIFIED'};
  });
  const evidence=await inspectM3LifecycleRecovery(f.ctx,f.operationId);
  assert.equal(evidence.evidenceComplete,true);
  assert.equal(evidence.physicalLockReleaseAuthorized,false);
  const file=path.join(f.audit.dir,'00003.json');
  const altered=JSON.parse(await fs.readFile(file,'utf8'));altered.stage='COMMITTED';
  await fs.writeFile(file,JSON.stringify(altered)+'\n');
  await assert.rejects(()=>inspectM3LifecycleRecovery(f.ctx,f.operationId),{code:'M3_AUDIT_CORRUPT'});
 }finally{await f.cleanup();}
});
test('M3g audit refuses foreign owner and corrupted operation claim',async()=>{
 const f=await fixture();try{
  await f.store.claim(f.operationId);
  const marker=path.join(f.store.root,`claimed-${f.operationId}.json`);
  await fs.writeFile(marker,'{"owner":"mallory"}\n');
  await assert.rejects(()=>inspectM3LifecycleRecovery(f.ctx,f.operationId),{code:'M3_AUDIT_CLAIM_CORRUPT'});
  await assert.rejects(()=>inspectM3LifecycleRecovery({...f.ctx,userScopeId:'mallory'},f.operationId));
 }finally{await f.cleanup();}
});
