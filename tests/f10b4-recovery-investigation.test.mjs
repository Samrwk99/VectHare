import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {F10b4RecoveryInvestigation} from '../lib/f10b4-recovery-investigation.js';
const sha=x=>createHash('sha256').update(x).digest('hex');
const key='a'.repeat(64),backend='qdrant',name='vh_f10b4_probe';
async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'f10b4-'));
 await fs.chmod(root,0o700);
 const vectorsPath=path.join(root,'vectors'),base=path.join(vectorsPath,'.similharity'),owner='test-'+randomUUID();
 await fs.mkdir(base,{recursive:true,mode:0o700});
 for(const dir of ['s04-operations','f09b4-managed','f09c10-writer-locks'])await fs.mkdir(path.join(base,dir),{mode:0o700});
 const id=randomUUID();
 const plan={operationId:id,backend,collectionKey:key,physicalCollectionName:name,
  scope:{userScopeId:owner},action:'update'};
 const receipt={schemaVersion:4,operationId:id,owner,plan,state:'UNCERTAIN',history:[{state:'PREPARED'},{state:'SUBMITTED'},{state:'UNCERTAIN'}]};
 const entryId=randomUUID();
 const managed={schemaVersion:1,owner,sourceId:'source',collectionKey:key,records:{
  [entryId]:{recordId:entryId,contentHash:'b'.repeat(64),revision:2,operationId:id,state:'WRITE_PENDING'}}};
 const lockName='collection-'+sha(JSON.stringify([backend,name]))+'.lock';
 const lockFile=path.join(base,'f09c10-writer-locks',lockName);
 async function write(dir,file,doc){const data=JSON.stringify(doc);await fs.writeFile(path.join(base,dir,file),JSON.stringify({...doc,checksum:sha(data)})+'\n',{mode:0o600});}
 async function putLock(){await fs.writeFile(lockFile,JSON.stringify({schemaVersion:1,backend,physicalNameHash:sha(name),pid:process.pid})+'\n',{mode:0o600});}
 await write('s04-operations',id+'.json',receipt);await write('f09b4-managed',key+'.json',managed);await putLock();
 return {root,base,vectorsPath,owner,id,receipt,managed,entryId,lockFile,write,putLock,
  inspector:new F10b4RecoveryInvestigation({vectorsPath,userScopeId:owner,backend,physicalCollectionName:name,collectionKey:key})};
}
async function use(fn){const f=await fixture();try{await fn(f);}finally{await fs.rm(f.root,{recursive:true,force:true});}}
test('F10b.4: unresolved receipt, pending managed entry, and lock yield read-only BLOCKED case',()=>use(async f=>{
 const before=await fs.readFile(f.lockFile);
 const result=await f.inspector.inspect(f.id);
 assert.equal(result.classification,'UNRESOLVED_MUTATION_BLOCKED');
 assert.equal(result.operations.length,1);assert.equal(result.operations[0].state,'UNCERTAIN');
 assert.equal(result.managed.pending,1);assert.equal(result.lockPresent,true);
 assert.equal(result.liveUnlockAllowed,false);assert.equal(result.operationReplayAllowed,false);
 assert.deepEqual(await fs.readFile(f.lockFile),before);
}));
test('F10b.4: staging a case requires explicit consent and preserves every live file',()=>use(async f=>{
 await assert.rejects(()=>f.inspector.stageCase(),{code:'F10B4_CONSENT_REQUIRED'});
 const raw=await fs.readFile(path.join(f.base,'s04-operations',f.id+'.json'));
 const c=await f.inspector.stageCase({confirm:'REVIEW_ONLY_NO_UNLOCK_NO_REPLAY'});
 const verified=await f.inspector.verifyCase(c.id);
 assert.equal(verified.locallyIntegrityChecked,true);assert.equal(verified.independentlyAttested,false);
 assert.equal(verified.liveUnlockAllowed,false);
 assert.deepEqual(await fs.readFile(path.join(f.base,'s04-operations',f.id+'.json')),raw);
 await fs.lstat(f.lockFile);
}));
test('F10b.4: captured forensic artifact detects corruption',()=>use(async f=>{
 const {id}=await f.inspector.stageCase({confirm:'REVIEW_ONLY_NO_UNLOCK_NO_REPLAY'});
 const p=path.join(f.base,'f10b4-investigations',id+'.json');
 const doc=JSON.parse(await fs.readFile(p));doc.evidence.classification='NO_RETAINED_LOCK_OBSERVED';
 await fs.writeFile(p,JSON.stringify(doc),{mode:0o600});
 await assert.rejects(()=>f.inspector.verifyCase(id),{code:'F10B4_CASE_TAMPERED'});
}));
test('F10b.4: cross-user review cannot verify a case',()=>use(async f=>{
 const {id}=await f.inspector.stageCase({confirm:'REVIEW_ONLY_NO_UNLOCK_NO_REPLAY'});
 const other=new F10b4RecoveryInvestigation({vectorsPath:f.vectorsPath,userScopeId:'other',backend,
  physicalCollectionName:name,collectionKey:key});
 await assert.rejects(()=>other.verifyCase(id),{code:'F10B4_CASE_TAMPERED'});
 await assert.rejects(()=>other.inspect(),{code:'F10B4_RECEIPT_INVALID'});
}));
test('F10b.4: checksum mismatch is refused, even for terminal receipts',()=>use(async f=>{
 const p=path.join(f.base,'s04-operations',f.id+'.json');const doc=JSON.parse(await fs.readFile(p));
 doc.state='VERIFIED';await fs.writeFile(p,JSON.stringify(doc),{mode:0o600});
 await assert.rejects(()=>f.inspector.inspect(),{code:'F10B4_RECEIPT_INVALID'});
}));
test('F10b.4: changed collection binding is a hard failure',()=>use(async f=>{
 f.receipt.plan.physicalCollectionName='different';
 await f.write('s04-operations',f.id+'.json',f.receipt);
 await assert.rejects(()=>f.inspector.inspect(),{code:'F10B4_COLLECTION_BINDING_CONFLICT'});
}));
test('F10b.4: missing pending intent receipt cannot be administratively resolved',()=>use(async f=>{
 await fs.unlink(path.join(f.base,'s04-operations',f.id+'.json'));
 await assert.rejects(()=>f.inspector.inspect(),{code:'F10B4_INTENT_WITHOUT_RECEIPT'});
}));
test('F10b.4: symlinked or untrusted runtime state refused',()=>use(async f=>{
 const original=path.join(f.base,'s04-operations',f.id+'.json');
 const other=path.join(f.base,'s04-operations',randomUUID()+'.json');
 await fs.symlink(original,other);
 await assert.rejects(()=>f.inspector.inspect(),{code:'F10B4_FILE_UNTRUSTED'});
 await fs.unlink(other);await fs.chmod(f.base,0o755);
 await assert.rejects(()=>f.inspector.inspect(),{code:'F10B4_DIRECTORY_UNTRUSTED'});
}));
test('F10b.4: malformed and replaced writer lock are not removed',()=>use(async f=>{
 await fs.writeFile(f.lockFile,'{}',{mode:0o600});
 await assert.rejects(()=>f.inspector.inspect(),{code:'F10B4_LOCK_INVALID'});
 await fs.unlink(f.lockFile);await fs.symlink('/etc/passwd',f.lockFile);
 await assert.rejects(()=>f.inspector.inspect(),{code:'F10B4_FILE_UNTRUSTED'});
}));
test('F10b.4: PREPARED and SUBMITTED are blocked, including when a lock is absent',()=>use(async f=>{
 await fs.unlink(f.lockFile);
 for(const state of ['PREPARED','SUBMITTED']){
  f.receipt.state=state;await f.write('s04-operations',f.id+'.json',f.receipt);
  const inspected=await f.inspector.inspect();
  assert.equal(inspected.classification,'UNRESOLVED_MUTATION_BLOCKED');
  assert.equal(inspected.lockPresent,false);
 }
}));
test('F10b.4: even terminal VERIFIED with retained lock needs host review',()=>use(async f=>{
 f.receipt.state='VERIFIED';await f.write('s04-operations',f.id+'.json',f.receipt);
 f.managed.records[f.entryId].state='ACTIVE';f.managed.records[f.entryId].operationId=null;
 await f.write('f09b4-managed',key+'.json',f.managed);
 let res=await f.inspector.inspect();assert.equal(res.classification,'RETAINED_LOCK_REQUIRES_HOST_REVIEW');
 await fs.unlink(f.lockFile);
 res=await f.inspector.inspect();assert.equal(res.classification,'NO_RETAINED_LOCK_OBSERVED');
 assert.equal(res.liveUnlockAllowed,false);
}));
test('F10b.4: inconsistent managed intent and scope rejection',()=>use(async f=>{
 f.managed.records[f.entryId].operationId=randomUUID();
 await f.write('f09b4-managed',key+'.json',f.managed);
 await assert.rejects(()=>f.inspector.inspect(),{code:'F10B4_INTENT_WITHOUT_RECEIPT'});
 await assert.rejects(()=>f.inspector.inspect('../'),{code:'F10B4_OPERATION_INVALID'});
}));
test('F10b.4: unexpected ledger files, temporary files and malformed case IDs denied',()=>use(async f=>{
 await assert.rejects(()=>f.inspector.verifyCase('../etc'),{code:'F10B4_CASE_ID_INVALID'});
 await fs.writeFile(path.join(f.base,'s04-operations','.tmp-deadbeef'),'x',{mode:0o600});
 await assert.rejects(()=>f.inspector.inspect(),{code:'F10B4_TRANSIENT_STATE'});
}));
test('F10b.4: initial inspection never creates a case or runtime files',()=>use(async f=>{
 const entries=await fs.readdir(f.base);await f.inspector.inspect();
 assert.deepEqual(await fs.readdir(f.base),entries);
}));
