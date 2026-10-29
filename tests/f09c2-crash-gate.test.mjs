/** F09c.2: a persisted SUBMITTED intent is not a certified atomic ACK.
 * All backends here are disposable simulated adapters; no live CAS claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {OperationLedger} from '../lib/s04-ledger.js';
import {planMutation} from '../lib/s04-contract.js';
import {MutationEngine} from '../lib/s04-engine.js';
const scope={userScopeId:'alice',collectionId:'chat_memory',sourceId:'saved-chat',type:'chat'};
const embedding={source:'transformers',model:'fixture',dimension:3,metric:'dot'};
const vector=[0.1,0.2,0.3];
const body={text:'crash proof',vector};
const approved=p=>({authorized:true,ownerVerified:true,mutationContractVerified:true,atomicBackendCertified:true,externalWriterScopeAttested:true,collectionKey:p.collectionKey,backend:p.backend});
const testRoot=async fn=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'f09c2-'));try{await fn({userScopeId:'alice',vectorsPath:root});}finally{await fs.rm(root,{recursive:true,force:true});}};
const plan=(ctx,action,opts={})=>planMutation(ctx,{backend:'qdrant',scope,embedding,action,recordId:randomUUID(),operationId:randomUUID(),expectedRevision:action==='insert'?0:1,...opts});
const row=(p,payload)=>({recordId:p.recordId,physicalId:p.physicalId,scope:p.scope,revision:p.targetRevision,textHash:p.textHash,vectorHash:p.vectorHash,metadataHash:p.metadataHash,vector:payload?.vector??vector});
function adapter(getRecord,atomicCompareAndMutate=async()=>{throw Error('should not run');}){
 return {getRecord,atomicCompareAndMutate,insertRecord:async()=>{throw Error('legacy insert');},updateRecord:async()=>{throw Error('legacy update');},deleteRecord:async()=>{throw Error('legacy delete');}};
}
test('crash after dispatch leaves SUBMITTED: matching insert readback cannot certify it',()=>testRoot(async ctx=>{
 const p=plan(ctx,'insert',{...body});
 const ledger=new OperationLedger(ctx);
 await ledger.writeNew(p);await ledger.advance(p.operationId,'SUBMITTED');
 const engine=new MutationEngine({ledger,adapter:adapter(async()=>row(p,body)),authorize:approved});
 const seen=await engine.reconcile(p.operationId,{expectedVector:body.vector});
 assert.equal(seen.state,'SUBMITTED');assert.equal(seen.reason,'F09C_MANUAL_RECOVERY_REQUIRED');
 assert.equal((await ledger.read(p.operationId)).state,'SUBMITTED');
}));
test('crash after dispatch leaves SUBMITTED: absent deleted record is not proof of ACK',()=>testRoot(async ctx=>{
 const p=plan(ctx,'delete');
 const ledger=new OperationLedger(ctx);
 await ledger.writeNew(p);await ledger.advance(p.operationId,'SUBMITTED');
 const engine=new MutationEngine({ledger,adapter:adapter(async()=>null),authorize:approved});
 assert.equal((await engine.reconcile(p.operationId)).state,'SUBMITTED');
 assert.equal((await ledger.read(p.operationId)).state,'SUBMITTED');
}));
test('caller cannot forge atomic ACK with a boolean or string',()=>testRoot(async ctx=>{
 const p=plan(ctx,'insert',{...body});
 const ledger=new OperationLedger(ctx);
 await ledger.writeNew(p);await ledger.advance(p.operationId,'SUBMITTED');
 const engine=new MutationEngine({ledger,adapter:adapter(async()=>row(p,body)),authorize:approved});
 assert.equal((await engine._reconcileUnderLock(p.operationId,{expectedVector:vector,atomicDispatchAcknowledged:true})).state,'SUBMITTED');
 assert.equal((await engine._reconcileUnderLock(p.operationId,{expectedVector:vector,atomicDispatchAcknowledged:'ACK_THIS_INVOCATION'})).state,'SUBMITTED');
}));
test('confirmed atomic dispatch in same invocation can still be readback-verified',()=>testRoot(async ctx=>{
 const p=plan(ctx,'insert',{...body}),records=new Map();
 const engine=new MutationEngine({ledger:new OperationLedger(ctx),authorize:approved,adapter:adapter(
  async q=>records.get(q.physicalId)??null,
  async(q,payload)=>{records.set(q.physicalId,row(q,payload));return {applied:true};}
 )});
 assert.equal((await engine.execute(p,body)).state,'VERIFIED');
 assert.equal((await engine.reconcile(p.operationId)).state,'VERIFIED');
}));
test('timeout UNCERTAIN remains unresolved even with matching later readback',()=>testRoot(async ctx=>{
 const p=plan(ctx,'insert',{...body}),records=new Map();
 const engine=new MutationEngine({ledger:new OperationLedger(ctx),authorize:approved,adapter:adapter(
  async q=>records.get(q.physicalId)??null,
  async(q,payload)=>{records.set(q.physicalId,row(q,payload));throw Error('ack lost');}
 )});
 assert.equal((await engine.execute(p,body)).state,'UNCERTAIN');
 const check=await engine.reconcile(p.operationId);
 assert.equal(check.state,'UNCERTAIN');assert.equal(check.reason,'F09C_MANUAL_RECOVERY_REQUIRED');
}));
