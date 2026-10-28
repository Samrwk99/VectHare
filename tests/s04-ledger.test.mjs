import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {OperationLedger} from '../lib/s04-ledger.js';
import {planMutation} from '../lib/s04-contract.js';
import {ctx, sample} from './s04-contract.test.mjs';
async function fixture(fn){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'s04-ledger-'));try{const c={userScopeId:'alice',vectorsPath:dir};await fn(new OperationLedger(c),c,dir);}finally{await fs.rm(dir,{force:true,recursive:true});}}
const err=(fn,code)=>assert.rejects(fn,e=>e.code===code);
test('S04 ledger persists private, hashed receipts after new instance and enforces legal transitions',async()=>fixture(async(ledger,c,dir)=>{
 const p=planMutation(c,sample());await ledger.writeNew(p);
 const l2=new OperationLedger(c);assert.equal((await l2.read(p.operationId)).state,'PREPARED');
 await err(()=>ledger.writeNew(p),'EEXIST');
 await ledger.advance(p.operationId,'SUBMITTED');await ledger.advance(p.operationId,'UNCERTAIN',{code:'TIMEOUT'});
 await l2.advance(p.operationId,'VERIFIED');
 await err(()=>ledger.advance(p.operationId,'FAILED'),'S04_TRANSITION_DENIED');
 const stat=await fs.stat(ledger.location(p.operationId));assert.equal(stat.mode & 0o077,0);
 const disk=await fs.readFile(ledger.location(p.operationId),'utf8');assert.ok(!disk.includes('hello'));
}));
test('S04 ledger detects tampered receipts and rejects wrong user or symlink',async()=>fixture(async(ledger,c,dir)=>{
 const p=planMutation(c,sample());await ledger.writeNew(p);
 const filename=ledger.location(p.operationId);let text=await fs.readFile(filename,'utf8');
 await fs.writeFile(filename,text.replace('PREPARED','VERIFIED'));
 await err(()=>ledger.read(p.operationId),'S04_LEDGER_CORRUPT');
 await fs.writeFile(filename,text);
 const other=new OperationLedger({userScopeId:'bob',vectorsPath:dir});
 await err(()=>other.read(p.operationId),'S04_LEDGER_CORRUPT');
 await fs.unlink(filename);await fs.symlink('/etc/hosts',filename);
 await err(()=>ledger.read(p.operationId),'S04_LEDGER_UNTRUSTED');
}));
test('S04 lock refuses competing processes and never performs operation twice',async()=>fixture(async(ledger,c)=>{
 const p=planMutation(c,sample());
 await ledger.withRecordLock(p,async()=>{
  await err(()=>new OperationLedger(c).withRecordLock(p,async()=>{}),'S04_OPERATION_BUSY');
 });
 await ledger.writeNew(p);
 await err(()=>ledger.writeNew(p),'EEXIST');
}));
