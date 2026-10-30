import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {collectionIdentity} from '../lib/s02-identity.js';
import {M3CutoverJournal,guardM3CanonicalBinding} from '../lib/m3-cutover-journal.js';
const scope={userScopeId:'alice',collectionId:'a',type:'chat',sourceId:'chat-a',branchId:'branch'};
const embedding={source:'transformers',model:'fixture',dimension:3,metric:'cosine'};
const collection=collectionIdentity({backend:'qdrant',scope,embedding});
const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',scope,embedding,
 collection:{key:collection.key,physicalName:collection.physicalName}};
const target='vh2_'+'f'.repeat(48),proof={verified:true,exclusiveOwner:true,schemaVerified:true,
 inventoryVerified:true,physicalName:target,logicalKey:collection.key};
async function fixture(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'m3-journal-'));
 await fs.chmod(dir,0o700);const parent=path.join(dir,'.similharity');await fs.mkdir(parent,{mode:0o700});
 const ctx={userScopeId:'alice',vectorsPath:dir};return {ctx,j:new M3CutoverJournal(ctx,{logicalKey:collection.key}),
 cleanup:()=>fs.rm(dir,{recursive:true,force:true})};}
test('M3 canonical binding is unchanged when journal absent',async()=>{
 const f=await fixture();try{assert.equal(await guardM3CanonicalBinding(f.ctx,binding),binding);
 assert.equal((await f.j.resolve(binding)).physicalName,collection.physicalName);}finally{await f.cleanup();}
});
test('M3 prepare makes all public reads fail closed; publish resolves to verified target without fallback',async()=>{
 const f=await fixture();try{const operationId=randomUUID();
 await assert.rejects(()=>f.j.prepare(binding,{operationId,targetPhysicalName:target,backupDigest:'a'.repeat(64),proof:{...proof,verified:false}}),{code:'M3_CUTOVER_EVIDENCE_REQUIRED'});
 await f.j.prepare(binding,{operationId,targetPhysicalName:target,backupDigest:'a'.repeat(64),proof});
 await assert.rejects(()=>guardM3CanonicalBinding(f.ctx,binding),{code:'M3_JOURNAL_TRANSITION_REVIEW_REQUIRED'});
 await assert.rejects(()=>f.j.publish(binding,{operationId:randomUUID(),proof}),{code:'M3_CUTOVER_NOT_PREPARED'});
 // A rejected preflight has NOT appended anything and must not quarantine.
 const result=await f.j.publish(binding,{operationId,proof});
 assert.equal(result.state,'PUBLISHED');
 }finally{await f.cleanup();}
});
test('M3 valid publish yields generation + active physical target and rejects old canonical readers',async()=>{
 const f=await fixture();try{const operationId=randomUUID();
 await f.j.prepare(binding,{operationId,targetPhysicalName:target,backupDigest:'a'.repeat(64),proof});
 const out=await f.j.publish(binding,{operationId,proof});assert.equal(out.state,'PUBLISHED');
 const active=await f.j.resolve(binding);assert.equal(active.generation,1);assert.equal(active.physicalName,target);
 await assert.rejects(()=>guardM3CanonicalBinding(f.ctx,binding),{code:'M3_ALIAS_GATEWAY_INTEGRATION_REQUIRED'});
 // Original immutable S02 key remains bound; no browser-selected alias was allowed.
 assert.equal(active.logicalKey,collection.key);
 }finally{await f.cleanup();}
});
test('M3 aborted transition only with explicit no-dispatch proof, preserves canonical binding',async()=>{
 const f=await fixture();try{const operationId=randomUUID();
 await f.j.prepare(binding,{operationId,targetPhysicalName:target,backupDigest:'a'.repeat(64),proof});
 await assert.rejects(()=>f.j.abort({operationId}),{code:'M3_ABORT_REQUIRES_NO_DISPATCH_PROOF'});
 await f.j.abort({operationId,dispatchNeverStarted:true});
 assert.equal((await f.j.resolve(binding)).physicalName,collection.physicalName);
 assert.equal(await guardM3CanonicalBinding(f.ctx,binding),binding);
 }finally{await f.cleanup();}
});
test('M3 detects a corrupted journal rather than guessing a physical collection',async()=>{
 const f=await fixture();try{const operationId=randomUUID();
 await f.j.prepare(binding,{operationId,targetPhysicalName:target,backupDigest:'a'.repeat(64),proof});
 await fs.writeFile(path.join(f.j.dir,'00000001.json'),'{}');
 await assert.rejects(()=>f.j.resolve(binding),{code:'M3_JOURNAL_CORRUPT'});
 }finally{await f.cleanup();}
});
test('M3 explicit rollback is a new verified generation, never a silent pointer rewind',async()=>{
 const f=await fixture();try{
  const a=randomUUID(),b=randomUUID();
  await f.j.prepare(binding,{operationId:a,targetPhysicalName:target,backupDigest:'a'.repeat(64),proof});
  await f.j.publish(binding,{operationId:a,proof});
  const reverse={...proof,physicalName:collection.physicalName};
  await f.j.prepare(binding,{operationId:b,targetPhysicalName:collection.physicalName,
   backupDigest:'b'.repeat(64),proof:reverse});
  await assert.rejects(()=>f.j.resolve(binding),{code:'M3_JOURNAL_TRANSITION_REVIEW_REQUIRED'});
  const rolled=await f.j.publish(binding,{operationId:b,proof:reverse});
  assert.equal(rolled.generation,2);
  assert.equal((await f.j.resolve(binding)).physicalName,collection.physicalName);
  await assert.rejects(()=>guardM3CanonicalBinding(f.ctx,binding),{code:'M3_ALIAS_GATEWAY_INTEGRATION_REQUIRED'});
  assert.equal((await f.j.events()).length,4);
 }finally{await f.cleanup();}
});
