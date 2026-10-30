import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {collectionIdentity,recordIdentity,contentFingerprint} from '../lib/s02-identity.js';
import {issueM3TargetReceipt,verifyM3TargetReceipt,verifyM3PhysicalTarget} from '../lib/m3-target-receipts.js';
import {M3Store} from '../lib/m3-collections.js';
const H=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const scope={userScopeId:'alice',collectionId:'a',type:'chat',sourceId:'chat-a',branchId:'branch'};
const embedding={source:'transformers',model:'fixture',dimension:3,metric:'cosine'};
const identity=collectionIdentity({backend:'qdrant',scope,embedding});
const recordId=randomUUID(),physicalId=recordIdentity(scope,recordId).physicalId,vector=[1,0,0],
 text='sample',meta={some:'value'};
const point={id:physicalId,vector,payload:{...scope,recordId,physicalId,revision:1,text,textHash:contentFingerprint(text),metadata:meta,
 metadataHash:H(meta),embedding,vectorHash:H(vector),vectorReference:vector}};
const target='vh2_'+'a'.repeat(48);
const backup={schemaVersion:1,backupId:randomUUID(),backend:'qdrant',owner:'alice',
 logicalKey:identity.key,physicalName:identity.physicalName,scope,embedding,
 savedSourceFingerprint:'c'.repeat(64),inventory:{rows:[point],count:1,complete:true,exclusiveOwner:true,digest:H([point])}};
const indexes=Object.fromEntries(['userScopeId','collectionId','type','sourceId','branchId','recordId','physicalId'].map(x=>[x,{data_type:'keyword'}]));
async function fx(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'m3-receipt-'));await fs.chmod(dir,0o700);
 const ctx={vectorsPath:dir,userScopeId:'alice'};let rows=[structuredClone(point)],schema={size:3,distance:'Cosine'},schemaIndexes=structuredClone(indexes);
 const transport={_request:async(method,url,body)=>{
  assert.ok(url.startsWith('/collections/'+target));
  if(method==='GET')return {result:{config:{params:{vectors:schema}},payload_schema:schemaIndexes}};
  if(method==='POST')return {result:{points:structuredClone(rows),next_page_offset:null}};
  throw Error('WRITE_NOT_ALLOWED');}};
 return {ctx,transport,mutateRows:next=>{rows=next;},mutateIndexes:next=>{schemaIndexes=next;},
  close:()=>fs.rm(dir,{recursive:true,force:true})};}
test('M3 target attestation reads every physical row and issues a one-use immutable receipt',async()=>{
 const f=await fx();try{const op=randomUUID();const out=await issueM3TargetReceipt(f.ctx,{transport:f.transport,
 backup,operationId:op,targetPhysicalName:target,generation:1});
 assert.equal(out.receiptVerified,true);assert.equal(out.productionCertified,false);
 const active={logicalKey:identity.key,physicalName:target,generation:1};
 const proof=await verifyM3TargetReceipt(f.ctx,{transport:f.transport,backup,operationId:op,active});
 assert.equal(proof.inventoryVerified,true);assert.equal(proof.count,1);
 await assert.rejects(()=>issueM3TargetReceipt(f.ctx,{transport:f.transport,
  backup,operationId:op,targetPhysicalName:target,generation:1}),{code:'EEXIST'});
 await assert.rejects(()=>verifyM3TargetReceipt(f.ctx,{transport:f.transport,backup,operationId:op,
  active:{...active,generation:2}}),{code:'M3_TARGET_RECEIPT_BINDING_MISMATCH'});
 }finally{await f.close();}
});
test('M3 target verification refuses a foreign row, unindexed schema, altered vector or untrusted stored receipt',async()=>{
 const f=await fx();try{
 await assert.rejects(()=>verifyM3PhysicalTarget(f.transport,{...backup,owner:'bob'},target),{code:'M3_TARGET_BACKUP_UNVERIFIED'});
 f.mutateRows([{...point,payload:{...point.payload,userScopeId:'bob'}}]);
 await assert.rejects(()=>verifyM3PhysicalTarget(f.transport,backup,target),{code:'M3_TARGET_INVENTORY_MISMATCH'});
 f.mutateRows([{...point,vector:[0,1,0]}]);
 await assert.rejects(()=>verifyM3PhysicalTarget(f.transport,backup,target),{code:'M3_TARGET_INVENTORY_MISMATCH'});
 f.mutateRows([point]);f.mutateIndexes({});
 await assert.rejects(()=>verifyM3PhysicalTarget(f.transport,backup,target),{code:'M3_TARGET_INDEX_UNVERIFIED'});
 f.mutateIndexes(indexes);
 const op=randomUUID();await issueM3TargetReceipt(f.ctx,{transport:f.transport,
  backup,operationId:op,targetPhysicalName:target,generation:1});
 const store=new M3Store(f.ctx);await fs.writeFile(store.file('target',op),'{}');
 await assert.rejects(()=>verifyM3TargetReceipt(f.ctx,{transport:f.transport,backup,operationId:op,
  active:{logicalKey:identity.key,physicalName:target,generation:1}}),{code:'M3_DOCUMENT_CORRUPT'});
 }finally{await f.close();}
});
test('M3 end-to-end journal read requires matching backup digest, immutable receipt, and fresh Qdrant inventory',async()=>{
 const {M3CutoverJournal}=await import('../lib/m3-cutover-journal.js');
 const {resolveM3VerifiedTarget}=await import('../lib/m3-target-receipts.js');
 const {requireReadBinding}=await import('../lib/s05-contract.js');
 const f=await fx();try{
  const canonical={authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',scope,embedding,
   collection:{key:identity.key,physicalName:identity.physicalName}};
  const op=randomUUID(),j=new M3CutoverJournal(f.ctx,{logicalKey:identity.key});
  await issueM3TargetReceipt(f.ctx,{transport:f.transport,backup,operationId:op,targetPhysicalName:target,generation:1});
  const proof={verified:true,exclusiveOwner:true,schemaVerified:true,inventoryVerified:true,
   physicalName:target,logicalKey:identity.key};
  await j.prepare(canonical,{operationId:op,targetPhysicalName:target,backupDigest:H(backup),proof});
  await assert.rejects(()=>resolveM3VerifiedTarget(f.ctx,canonical,{transport:f.transport,backup}),
   {code:'M3_TARGET_JOURNAL_BACKUP_MISMATCH'});
  await j.publish(canonical,{operationId:op,proof});
  const routed=await resolveM3VerifiedTarget(f.ctx,canonical,{transport:f.transport,backup});
  assert.equal(requireReadBinding(routed).physicalName,target);
  f.mutateRows([]);
  await assert.rejects(()=>resolveM3VerifiedTarget(f.ctx,canonical,{transport:f.transport,backup}),
   {code:'M3_TARGET_INVENTORY_MISMATCH'});
 }finally{await f.close();}
});
test('M3 read binder discovers backup only from the verified journal and target receipt',async()=>{
 const {M3CutoverJournal}=await import('../lib/m3-cutover-journal.js');
 const {resolveM3ReadBinding}=await import('../lib/m3-target-receipts.js');
 const f=await fx();try{
  const canonical={authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',scope,embedding,
   collection:{key:identity.key,physicalName:identity.physicalName}};
  assert.equal((await resolveM3ReadBinding(f.ctx,canonical,{transport:f.transport})).collection.physicalName,identity.physicalName);
  const op=randomUUID(),journal=new M3CutoverJournal(f.ctx,{logicalKey:identity.key});
  await new M3Store(f.ctx).write('backup',backup);
  await issueM3TargetReceipt(f.ctx,{transport:f.transport,backup,operationId:op,targetPhysicalName:target,generation:1});
  const proof={verified:true,exclusiveOwner:true,schemaVerified:true,inventoryVerified:true,physicalName:target,logicalKey:identity.key};
  await journal.prepare(canonical,{operationId:op,targetPhysicalName:target,backupDigest:H(backup),proof});
  await assert.rejects(()=>resolveM3ReadBinding(f.ctx,canonical,{transport:f.transport}),{code:'M3_JOURNAL_TRANSITION_REVIEW_REQUIRED'});
  await journal.publish(canonical,{operationId:op,proof});
  const routed=await resolveM3ReadBinding(f.ctx,canonical,{transport:f.transport});
  assert.equal(routed.collection.physicalName,target);assert.equal(routed.collection.generation,1);
  f.mutateRows([]);
  await assert.rejects(()=>resolveM3ReadBinding(f.ctx,canonical,{transport:f.transport}),{code:'M3_TARGET_INVENTORY_MISMATCH'});
 }finally{await f.close();}
});
