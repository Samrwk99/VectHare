import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {F10b4RecoveryInvestigation} from '../lib/f10b4-recovery-investigation.js';
import {F10b9AdministrativeResolution,F10B9_CONSENT} from '../lib/f10b9-admin-resolution.js';
import {CooperativeWriterBoundary} from '../lib/f09c5-writer-boundary.js';
const sha=x=>createHash('sha256').update(x).digest('hex');
async function fixture({state='VERIFIED',pid=999999,legacy=false,managedPending=false}={}){
 const vectorsPath=await fs.mkdtemp(path.join(os.tmpdir(),'f10b9-'));await fs.chmod(vectorsPath,0o700);
 const base=path.join(vectorsPath,'.similharity');await fs.mkdir(base,{mode:0o700});
 for(const dir of ['s04-operations','f09b4-managed','f09c10-writer-locks'])await fs.mkdir(path.join(base,dir),{mode:0o700});
 const backend='qdrant',physicalCollectionName='f10b9_disposable',collectionKey='a'.repeat(64),userScopeId='user-'+randomUUID();
 const operationId=randomUUID(),recordId=randomUUID();
 const plan={operationId,backend,collectionKey,physicalCollectionName,scope:{userScopeId},action:'insert'};
 const receipt={schemaVersion:4,owner:userScopeId,operationId,plan,state,history:[{state:'PREPARED'},{state}]};
 const write=async(d,name,v)=>fs.writeFile(path.join(base,d,name),JSON.stringify({...v,checksum:sha(JSON.stringify(v))})+'\n',{mode:0o600});
 await write('s04-operations',operationId+'.json',receipt);
 const managed={schemaVersion:1,owner:userScopeId,sourceId:'sample',collectionKey,records:managedPending?{
  [recordId]:{recordId,contentHash:'c'.repeat(64),revision:1,operationId,state:'WRITE_PENDING'}}:{}};
 await write('f09b4-managed',collectionKey+'.json',managed);
 const lock=path.join(base,'f09c10-writer-locks','collection-'+sha(JSON.stringify([backend,physicalCollectionName]))+'.lock');
 const doc={schemaVersion:1,backend,physicalNameHash:sha(physicalCollectionName),pid,...(!legacy?{
  operationId,collectionKey,ownerHash:sha(userScopeId)}:{})};
 await fs.writeFile(lock,JSON.stringify(doc)+'\n',{mode:0o600});
 const config={vectorsPath,userScopeId,backend,physicalCollectionName,collectionKey};
 const investigator=new F10b4RecoveryInvestigation(config),admin=new F10b9AdministrativeResolution(config);
 return {vectorsPath,base,config,investigator,admin,lock,operationId,receipt,write,doc,managed};
}
async function use(opts,fn){const f=await fixture(opts);try{await fn(f);}finally{await fs.rm(f.vectorsPath,{force:true,recursive:true});}}
async function stage(f){return f.investigator.stageCase({confirm:'REVIEW_ONLY_NO_UNLOCK_NO_REPLAY'});}
const release=(f,id,extra={})=>f.admin.releaseTerminalLock({caseId:id,quiescent:true,confirm:F10B9_CONSENT,...extra});
async function refused(opts,code,mutate=async()=>{}){await use(opts,async f=>{
 const c=await stage(f);await mutate(f,c);
 await assert.rejects(()=>release(f,c.id),e=>e.code===code);
 await fs.lstat(f.lock);
});}
test('F10b.9: deceased owner + exact terminal receipt quarantines lock, never mutates ledger or replays',()=>use({},async f=>{
 const c=await stage(f),originalReceipt=await fs.readFile(path.join(f.base,'s04-operations',f.operationId+'.json'));
 const r=await release(f,c.id);assert.equal(r.disposition,'QUARANTINED_TERMINAL_LOCK_ONLY');assert.equal(r.replayAllowed,false);
 await assert.rejects(()=>fs.lstat(f.lock),{code:'ENOENT'});
 const archived=path.join(f.base,'f10b9-terminal-releases',c.id,'retained-lock.json');
 assert.deepEqual(JSON.parse(await fs.readFile(archived,'utf8')),f.doc);
 assert.deepEqual(await fs.readFile(path.join(f.base,'s04-operations',f.operationId+'.json')),originalReceipt);
 assert.equal((await f.investigator.inspect()).classification,'NO_RETAINED_LOCK_OBSERVED');
 const boundary=new CooperativeWriterBoundary({root:path.dirname(f.lock),backend:'qdrant',physicalName:'f10b9_disposable'});
 assert.equal((await boundary.withWriteBoundary({backend:'qdrant',physicalCollectionName:'f10b9_disposable',collectionKey:f.config.collectionKey},async()=>({state:'VERIFIED'}))).state,'VERIFIED');
 await assert.rejects(()=>release(f,c.id),e=>e.code==='F10B9_PENDING_OR_CHANGED_STATE');
}));
test('F10b.9: FAILED terminal also eligible, but no mutation-state modification',()=>use({state:'FAILED'},async f=>{
 const c=await stage(f);assert.equal((await release(f,c.id)).disposition,'QUARANTINED_TERMINAL_LOCK_ONLY');
 assert.equal((await f.investigator.inspect()).operations[0].state,'FAILED');
}));
test('F10b.9: UNCERTAIN state never releases',()=>refused({state:'UNCERTAIN'},'F10B9_PENDING_OR_CHANGED_STATE'));
test('F10b.9: SUBMITTED state never releases',()=>refused({state:'SUBMITTED'},'F10B9_PENDING_OR_CHANGED_STATE'));
test('F10b.9: PREPARED state never releases',()=>refused({state:'PREPARED'},'F10B9_PENDING_OR_CHANGED_STATE'));
test('F10b.9: pending managed intent never releases',()=>refused({managedPending:true},'F10B9_PENDING_OR_CHANGED_STATE'));
test('F10b.9: older lock lacks operation binding and never releases',()=>refused({legacy:true},'F10B9_LOCK_NOT_ATTESTED'));
test('F10b.9: still running process never releases',()=>refused({pid:process.pid},'F10B9_PROCESS_STILL_RUNNING'));
test('F10b.9: wrong operator consent never releases',()=>use({},async f=>{
 const c=await stage(f);await assert.rejects(()=>release(f,c.id,{quiescent:false}),{code:'F10B9_EXPLICIT_HOST_CONSENT_REQUIRED'});
 await fs.lstat(f.lock);
}));
test('F10b.9: case mismatch after receipt changes never releases',()=>refused({},'F10B9_PENDING_OR_CHANGED_STATE',async f=>{
 f.receipt.state='FAILED';await f.write('s04-operations',f.operationId+'.json',f.receipt);
}));
test('F10b.9: corrupt evidence cannot release',()=>refused({},'F10B4_CASE_TAMPERED',async(f,c)=>{
 const p=path.join(f.base,'f10b4-investigations',c.id+'.json');const obj=JSON.parse(await fs.readFile(p));obj.evidence.classification='MALICIOUS';
 await fs.writeFile(p,JSON.stringify(obj),{mode:0o600});
}));
test('F10b.9: symlinked lock rejected and remains',()=>use({},async f=>{
 const c=await stage(f),copy=f.lock+'.old';await fs.rename(f.lock,copy);await fs.symlink(copy,f.lock);
 await assert.rejects(()=>release(f,c.id),e=>e.code==='F10B4_FILE_UNTRUSTED');
 assert.equal((await fs.lstat(f.lock)).isSymbolicLink(),true);
}));
test('F10b.9: PID cannot be altered after case staging',()=>refused({},'F10B9_PENDING_OR_CHANGED_STATE',async f=>{
 f.doc.pid=process.pid;await fs.writeFile(f.lock,JSON.stringify(f.doc)+'\n',{mode:0o600});
}));
test('F10b.9: new S04 writer lock binds operation UUID, owner and collection without text',()=>use({},async f=>{
 await fs.unlink(f.lock);
 const boundary=new CooperativeWriterBoundary({root:path.dirname(f.lock),backend:'qdrant',physicalName:'f10b9_disposable'});
 await boundary.withWriteBoundary({backend:'qdrant',physicalCollectionName:'f10b9_disposable',
  collectionKey:f.config.collectionKey,operationId:f.operationId,scope:{userScopeId:f.config.userScopeId}},async()=>{
  const raw=await fs.readFile(f.lock,'utf8'),lock=JSON.parse(raw);
  assert.equal(lock.operationId,f.operationId);assert.equal(lock.ownerHash,sha(f.config.userScopeId));
  assert.equal(lock.collectionKey,f.config.collectionKey);assert.equal(raw.includes(f.config.userScopeId),false);
  return {state:'UNCERTAIN'};
 });
 assert.equal((await f.investigator.inspect()).classification,'RETAINED_LOCK_REQUIRES_HOST_REVIEW');
}));
