import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {collectionIdentity} from '../lib/s02-identity.js';
import {requireReadBinding} from '../lib/s05-contract.js';
import {M3CutoverJournal} from '../lib/m3-cutover-journal.js';
import {assertM3VersionedBinding} from '../lib/m3-versioned-binding.js';
const scope={userScopeId:'alice',collectionId:'a',type:'chat',sourceId:'chat-a',branchId:'branch'};
const embedding={source:'transformers',model:'fixture',dimension:3,metric:'cosine'};
const id=collectionIdentity({backend:'qdrant',scope,embedding});
const canonical={authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',scope,embedding,
 collection:{key:id.key,physicalName:id.physicalName}};
const target='vh2_'+'d'.repeat(48),proof={verified:true,exclusiveOwner:true,schemaVerified:true,
 inventoryVerified:true,physicalName:target,logicalKey:id.key};
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'m3-version-'));
 await fs.chmod(root,0o700);return {ctx:{userScopeId:'alice',vectorsPath:root},close:()=>fs.rm(root,{recursive:true,force:true})};}
test('M3 read adapter rejects plain-object forged alias even with correct logical key',()=>{
 assert.throws(()=>requireReadBinding({...canonical,collection:{key:id.key,physicalName:target,generation:1}}),
  {code:'M3_VERSIONED_BINDING_NOT_ATTESTED'});
});
test('M3 server journal cannot route alias without target-specific schema and receipt evidence',async()=>{
 const f=await fixture();try{const j=new M3CutoverJournal(f.ctx,{logicalKey:id.key});const op=randomUUID();
 await j.prepare(canonical,{operationId:op,targetPhysicalName:target,backupDigest:'c'.repeat(64),proof});
 await j.publish(canonical,{operationId:op,proof});
 await assert.rejects(()=>j.resolveVersioned(canonical),{code:'M3_TARGET_VERIFIER_REQUIRED'});
 await assert.rejects(()=>j.resolveVersioned(canonical,{verifyTarget:async()=>({verified:true,schemaVerified:true,physicalName:target,generation:1,logicalKey:id.key})}),{code:'M3_TARGET_PROOF_INCOMPLETE'});
 const routed=await j.resolveVersioned(canonical,{verifyTarget:async()=>({verified:true,schemaVerified:true,receiptVerified:true,physicalName:target,generation:1,logicalKey:id.key})});
 assert.equal(requireReadBinding(routed).physicalName,target);
 assert.equal(assertM3VersionedBinding(routed).generation,1);
 await j.assertCurrentVersioned(routed,canonical);
 // A new generation invalidates all previously-resolved bindings before dispatch.
 const reverse={...proof,physicalName:id.physicalName};const op2=randomUUID();
 await j.prepare(canonical,{operationId:op2,targetPhysicalName:id.physicalName,backupDigest:'d'.repeat(64),proof:reverse});
 await assert.rejects(()=>j.assertCurrentVersioned(routed,canonical),{code:'M3_JOURNAL_TRANSITION_REVIEW_REQUIRED'});
 await j.publish(canonical,{operationId:op2,proof:reverse});
 await assert.rejects(()=>j.assertCurrentVersioned(routed,canonical),{code:'M3_STALE_BINDING_GENERATION'});
 }finally{await f.close();}
});
test('M3 physical alias is included in a trusted S04 plan but cannot be forged from an input field',async()=>{
 const {planMutation}=await import('../lib/s04-contract.js');
 const f=await fixture();try{const j=new M3CutoverJournal(f.ctx,{logicalKey:id.key});const op=randomUUID();
 await j.prepare(canonical,{operationId:op,targetPhysicalName:target,backupDigest:'e'.repeat(64),proof});
 await j.publish(canonical,{operationId:op,proof});
 const routed=await j.resolveVersioned(canonical,{verifyTarget:async a=>({verified:true,
 receiptVerified:true,schemaVerified:true,physicalName:a.physicalName,generation:a.generation,logicalKey:a.logicalKey})});
 const payload={backend:'qdrant',scope,embedding,action:'insert',recordId:randomUUID(),operationId:randomUUID(),
  text:'saved content',vector:[1,2,3],metadata:{label:'test'}};
 const p=planMutation(f.ctx,payload,{trustedBinding:routed});
 assert.equal(p.physicalCollectionName,target);assert.equal(p.routingGeneration,1);
 const defaultPlan=planMutation(f.ctx,payload);
 assert.equal(defaultPlan.physicalCollectionName,id.physicalName);
 assert.equal(defaultPlan.routingGeneration,undefined);
 assert.throws(()=>planMutation(f.ctx,payload,{trustedBinding:{...routed}}),{code:'M3_VERSIONED_BINDING_NOT_ATTESTED'});
 }finally{await f.close();}
});
test('M3 S04 refuses an aliased mutation without a live generation-fencing callback',async()=>{
 const {planMutation}=await import('../lib/s04-contract.js');
 const {MutationEngine}=await import('../lib/s04-engine.js');
 const {OperationLedger}=await import('../lib/s04-ledger.js');
 const f=await fixture();try{const j=new M3CutoverJournal(f.ctx,{logicalKey:id.key});const op=randomUUID();
 await j.prepare(canonical,{operationId:op,targetPhysicalName:target,backupDigest:'e'.repeat(64),proof});
 await j.publish(canonical,{operationId:op,proof});
 const routed=await j.resolveVersioned(canonical,{verifyTarget:async a=>({verified:true,
 receiptVerified:true,schemaVerified:true,physicalName:a.physicalName,generation:a.generation,logicalKey:a.logicalKey})});
 const payload={text:'saved content',vector:[1,2,3],metadata:{label:'test'}};
 const plan=planMutation(f.ctx,{backend:'qdrant',scope,embedding,action:'insert',recordId:randomUUID(),operationId:randomUUID(),
 expectedRevision:0,...payload},{trustedBinding:routed});
 let invoked=0;
 const adapter={getRecord:async()=>{invoked++;return null;},insertRecord:async()=>{invoked++;},
 updateRecord:async()=>{invoked++;},deleteRecord:async()=>{invoked++;}};
 const ledger=new OperationLedger(f.ctx);
 const eng=new MutationEngine({ledger,adapter,atomicOnly:false,trustedBinding:routed,
 authorize:async()=>({authorized:true,ownerVerified:true,mutationContractVerified:true,
 collectionKey:id.key,backend:'qdrant'})});
 await assert.rejects(()=>eng.execute(plan,payload),{code:'M3_FRESH_BINDING_FENCE_REQUIRED'});
 assert.equal(invoked,0);
 await assert.rejects(()=>ledger.read(plan.operationId),{code:'ENOENT'});
 }finally{await f.close();}
});
