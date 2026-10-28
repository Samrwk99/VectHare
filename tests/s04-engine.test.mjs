import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomUUID,createHash} from 'node:crypto';
import {OperationLedger} from '../lib/s04-ledger.js';import {planMutation} from '../lib/s04-contract.js';import {MutationEngine} from '../lib/s04-engine.js';
import {sample} from './s04-contract.test.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
async function fixture(fn){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'s04-engine-'));try{const ctx={userScopeId:'alice',vectorsPath:dir};const records=new Map();let writes=0,failWrite=false,failRead=false;
 const backend={async getRecord(p){if(failRead)throw Error('read failure');return records.get(p.physicalId)??null;},
  async insertRecord(p,payload){writes++;records.set(p.physicalId,item(p,payload));if(failWrite)throw Error('lost response');},
  async updateRecord(p,payload){writes++;records.set(p.physicalId,{...item(p,payload),vector:payload.vector??records.get(p.physicalId)?.vector});if(failWrite)throw Error('lost response');},
  async deleteRecord(p){writes++;records.delete(p.physicalId);if(failWrite)throw Error('lost response');}};
 const authorize=async p=>({authorized:true,ownerVerified:true,mutationContractVerified:true,collectionKey:p.collectionKey,backend:p.backend});
 const ledger=new OperationLedger(ctx),engine=new MutationEngine({ledger,adapter:backend,authorize});
 await fn({ctx,ledger,engine,backend,records,authorize,getWrites:()=>writes,setFailWrite:v=>failWrite=v,setFailRead:v=>failRead=v});
 }finally{await fs.rm(dir,{recursive:true,force:true});}}
function item(p,payload){return {recordId:p.recordId,physicalId:p.physicalId,scope:p.scope,revision:p.targetRevision,textHash:p.textHash,vectorHash:p.vectorHash,metadataHash:p.metadataHash,vector:payload?.vector??[.1,.2,.3]};}
function plan(c,action,changes={}){return planMutation(c,{...sample(action),operationId:randomUUID(),...changes});}
test('S04 engine inserts, updates and deletes using independent mock-backend readback',async()=>fixture(async f=>{
 const p=plan(f.ctx,'insert');const done=await f.engine.execute(p,{text:'hello',vector:[.1,.2,.3],metadata:{tag:'safe'}});
 assert.equal(done.state,'VERIFIED');assert.equal(f.getWrites(),1);
 const up=plan(f.ctx,'update');assert.equal((await f.engine.execute(up,{text:'changed',vector:[.3,.2,.1]})).state,'VERIFIED');
 const del=plan(f.ctx,'delete',{expectedRevision:2});assert.equal((await f.engine.execute(del,null)).state,'VERIFIED');
 assert.equal(f.getWrites(),3);assert.equal(f.records.size,0);
}));
test('S04 rejects authorization or altered payload before persisting/dispatching',async()=>fixture(async f=>{
 const p=plan(f.ctx,'insert');
 await assert.rejects(()=>f.engine.execute(p,{text:'wrong',vector:[.1,.2,.3]}),e=>e.code==='S04_PLAN_INVALID');
 const denied=new MutationEngine({ledger:f.ledger,adapter:f.backend,authorize:async()=>({authorized:false})});
 await assert.rejects(()=>denied.execute(p,{text:'hello',vector:[.1,.2,.3],metadata:{tag:'safe'}}),e=>e.code==='S04_AUTHORIZATION_NOT_ATTESTED');
 assert.equal(f.getWrites(),0);
}));
test('S04 stale revision is failed before mutation, and replay never repeats write',async()=>fixture(async f=>{
 const p=plan(f.ctx,'insert');const payload={text:'hello',vector:[.1,.2,.3],metadata:{tag:'safe'}};
 assert.equal((await f.engine.execute(p,payload)).state,'VERIFIED');
 await assert.rejects(()=>f.engine.execute(p,payload));assert.equal(f.getWrites(),1);
 const stale=plan(f.ctx,'delete',{expectedRevision:2});await assert.rejects(()=>f.engine.execute(stale,null),e=>e.code==='S04_REVISION_OR_OWNER_MISMATCH');
 assert.equal((await f.ledger.read(stale.operationId)).state,'FAILED');assert.equal(f.getWrites(),1);
}));
test('S04 lost response is UNCERTAIN and only readback reconciliation may verify',async()=>fixture(async f=>{
 f.setFailWrite(true);const p=plan(f.ctx,'insert');const payload={text:'hello',vector:[.1,.2,.3],metadata:{tag:'safe'}};
 const outcome=await f.engine.execute(p,payload);assert.equal(outcome.state,'UNCERTAIN');assert.equal(f.getWrites(),1);
 f.setFailWrite(false);assert.equal((await f.engine.reconcile(p.operationId)).state,'VERIFIED');assert.equal(f.getWrites(),1);
}));
test('S04 backend readback error leaves uncertainty, no auto retry',async()=>fixture(async f=>{
 const p=plan(f.ctx,'insert');const payload={text:'hello',vector:[.1,.2,.3],metadata:{tag:'safe'}};
 f.setFailWrite(true);await f.engine.execute(p,payload);f.setFailRead(true);
 assert.equal((await f.engine.reconcile(p.operationId)).state,'UNCERTAIN');assert.equal(f.getWrites(),1);
}));
test('S04 revalidation denies forged physical point identity and protected payload keys',async()=>fixture(async f=>{
 const p=plan(f.ctx,'insert'),payload={text:'hello',vector:[.1,.2,.3],metadata:{tag:'safe'}};
 await assert.rejects(()=>f.engine.execute({...p,physicalId:'attacker-point'},payload),e=>e.code==='S04_PLAN_INVALID');
 await assert.rejects(()=>f.engine.execute(p,{...payload,ownerId:'spoof'}),e=>e.code==='S04_PLAN_INVALID');
 assert.equal(f.getWrites(),0);
}));
test('S04 mismatched owner at readback stays UNCERTAIN, never falsely VERIFIED',async()=>fixture(async f=>{
 const p=plan(f.ctx,'insert'),payload={text:'hello',vector:[.1,.2,.3],metadata:{tag:'safe'}};
 f.backend.insertRecord=async()=>{f.records.set(p.physicalId,{...item(p,payload),scope:{...p.scope,sourceId:'other'}});};
 const result=await f.engine.execute(p,payload);
 assert.equal(result.state,'UNCERTAIN');assert.equal(result.reason,'OWNER_MISMATCH');
 assert.equal((await f.ledger.read(p.operationId)).state,'UNCERTAIN');
}));
test('S04 metadata revision succeeds only with verified metadata fingerprint',async()=>fixture(async f=>{
 const p=plan(f.ctx,'insert');await f.engine.execute(p,{text:'hello',vector:[.1,.2,.3],metadata:{tag:'safe'}});
 const metadata=plan(f.ctx,'metadata');assert.equal((await f.engine.execute(metadata,{metadata:{tag:'new'}})).state,'VERIFIED');
 assert.equal(f.records.get(p.physicalId).revision,2);
}));
test('S04 record identity collision across two branches is prevented',async()=>fixture(async f=>{
 const p=plan(f.ctx,'insert'),b=plan(f.ctx,'insert',{scope:{...sample().scope,branchId:'branchD'}});
 assert.notEqual(p.physicalId,b.physicalId);assert.notEqual(p.collectionKey,b.collectionKey);
 assert.equal((await f.engine.execute(p,{text:'hello',vector:[.1,.2,.3],metadata:{tag:'safe'}})).state,'VERIFIED');
 assert.equal((await f.engine.execute(b,{text:'hello',vector:[.1,.2,.3],metadata:{tag:'safe'}})).state,'VERIFIED');
 assert.equal(f.records.size,2);
}));
