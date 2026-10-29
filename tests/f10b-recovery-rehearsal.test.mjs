import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {F10bRecoveryRehearsal} from '../lib/f10b-recovery-rehearsal.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'f10b-'));
 await fs.chmod(root,0o700);
 const vectors=path.join(root,'vectors');await fs.mkdir(vectors,{mode:0o700});
 const parent=path.join(vectors,'.similharity');await fs.mkdir(parent,{mode:0o700});
 const owner='user-'+randomUUID();
 const id=randomUUID(),key='a'.repeat(64);
 const ledger=path.join(parent,'s04-operations'),managed=path.join(parent,'f09b4-managed');
 await fs.mkdir(ledger,{mode:0o700});await fs.mkdir(managed,{mode:0o700});
 async function write(dir,name,doc){const v=JSON.stringify(doc);await fs.writeFile(path.join(dir,name),JSON.stringify({...doc,checksum:hash(v)})+'\n',{mode:0o600});}
 const receipt={schemaVersion:4,operationId:id,owner,plan:{operationId:id,scope:{userScopeId:owner}},state:'VERIFIED',history:[{state:'VERIFIED'}]};
 const tombstoneId=randomUUID();
 const registry={schemaVersion:1,owner,sourceId:'sample',collectionKey:key,records:{[tombstoneId]:{recordId:tombstoneId,contentHash:'b'.repeat(64),revision:1,operationId:null,state:'DELETED'}}};
 await write(ledger,id+'.json',receipt);await write(managed,key+'.json',registry);
 const ctx={vectorsPath:vectors,userScopeId:owner};
 return {root,parent,ledger,managed,id,key,receipt,registry,write,ctx,recovery:new F10bRecoveryRehearsal(ctx)};
}
async function use(fn){const f=await fixture();try{await fn(f);}finally{await fs.rm(f.root,{recursive:true,force:true});}}
test('F10b captures and verifies trusted local control-plane state',()=>use(async f=>{
 const r=await f.recovery.capture();assert.equal(r.files,2);assert.equal(r.liveRestoreAllowed,false);
 const check=await f.recovery.verify(r.id);assert.equal(check.manifest.files.length,2);
 const rehearsal=await f.recovery.rehearse(r.id);
 assert.equal(rehearsal.rehearsalVerified,true);assert.equal(rehearsal.liveRestoreAllowed,false);
 const existing=JSON.parse(await fs.readFile(path.join(f.managed,f.key+'.json')));
 assert.equal(Object.values(existing.records)[0].state,'DELETED');
}));
test('F10b refuses an active cooperative writer lock',()=>use(async f=>{
 const locks=path.join(f.parent,'f09c10-writer-locks');await fs.mkdir(locks,{mode:0o700});
 await fs.writeFile(path.join(locks,'collection-test.lock'),'test',{mode:0o600});
 await assert.rejects(f.recovery.capture(),{code:'F10B_WRITER_LOCK_PRESENT'});
}));
test('F10b rejects UNCERTAIN receipts; no lock clearing',()=>use(async f=>{
 await f.write(f.ledger,f.id+'.json',{...f.receipt,state:'UNCERTAIN'});
 await assert.rejects(f.recovery.capture(),{code:'F10B_PENDING_OPERATION'});
}));
test('F10b rejects pending managed records',()=>use(async f=>{
 const id=Object.keys(f.registry.records)[0];f.registry.records[id].state='DELETE_PENDING';
 await f.write(f.managed,f.key+'.json',f.registry);
 await assert.rejects(f.recovery.capture(),{code:'F10B_PENDING_MANAGED_RECORD'});
}));
test('F10b rejects untrusted symlink state entries',()=>use(async f=>{
 await fs.symlink(path.join(f.ledger,f.id+'.json'),path.join(f.ledger,randomUUID()+'.json'));
 await assert.rejects(f.recovery.capture(),{code:'F10B_FILE_UNTRUSTED'});
}));
test('F10b refuses stale lock and temporary registry writes',()=>use(async f=>{
 await fs.mkdir(path.join(f.managed,'.lock-'+f.key),{mode:0o700});
 await assert.rejects(f.recovery.capture(),{code:'F10B_STATE_IN_PROGRESS'});
}));
test('F10b verifies saved file hashes and rejects corruption',()=>use(async f=>{
 const r=await f.recovery.capture();
 const file=path.join(f.parent,'f10b-rehearsals',r.id,'s04-operations',f.id+'.json');
 await fs.writeFile(file,'{}',{mode:0o600});
 await assert.rejects(f.recovery.verify(r.id));
}));
test('F10b rejects injected extra files and manifest path traversal',()=>use(async f=>{
 const r=await f.recovery.capture(),dir=path.join(f.parent,'f10b-rehearsals',r.id);
 await fs.writeFile(path.join(dir,'unexpected.txt'),'x',{mode:0o600});
 await assert.rejects(f.recovery.verify(r.id),{code:'F10B_UNEXPECTED_CAPTURE_ENTRY'});
 await fs.rm(path.join(dir,'unexpected.txt'));
 const mpath=path.join(dir,'manifest.json');const m=JSON.parse(await fs.readFile(mpath));
 m.files[0].relative='../secrets';m.captureDigest=hash(JSON.stringify(m.files));
 await fs.writeFile(mpath,JSON.stringify(m),{mode:0o600});
 await assert.rejects(f.recovery.verify(r.id),{code:'F10B_MANIFEST_INVALID'});
}));
test('F10b refuses cross-user capture verification',()=>use(async f=>{
 const r=await f.recovery.capture();
 const other=new F10bRecoveryRehearsal({...f.ctx,userScopeId:'other-user'});
 await assert.rejects(other.verify(r.id),{code:'F10B_MANIFEST_INVALID'});
}));
test('F10b rejects malformed IDs and unexpected receipts',()=>use(async f=>{
 await assert.rejects(f.recovery.verify('../a'),{code:'F10B_ID_INVALID'});
 await fs.writeFile(path.join(f.ledger,'unexpected.txt'),'not a receipt',{mode:0o600});
 await assert.rejects(f.recovery.capture(),{code:'F10B_UNEXPECTED_STATE_ENTRY'});
}));
test('F10b refuses tampered source checksum',()=>use(async f=>{
 const file=path.join(f.ledger,f.id+'.json');
 const doc=JSON.parse(await fs.readFile(file));doc.state='FAILED';
 await fs.writeFile(file,JSON.stringify(doc),{mode:0o600});
 await assert.rejects(f.recovery.capture(),{code:'F10B_STATE_CORRUPT'});
}));
test('F10b private staging never writes to original source registry',()=>use(async f=>{
 const r=await f.recovery.capture();
 const a=await fs.readFile(path.join(f.managed,f.key+'.json'));
 const b=await f.recovery.rehearse(r.id);
 assert.ok(b.stagingDirectory.startsWith(path.join(f.parent,'f10b-rehearsals')));
 assert.deepEqual(await fs.readFile(path.join(f.managed,f.key+'.json')),a);
}));
test('F10b includes a validated initialized S02 collection registry',()=>use(async f=>{
 await fs.writeFile(path.join(f.parent,'s02-collection-registry.json'),JSON.stringify({schemaVersion:2,entries:[]})+'\n',{mode:0o600});
 await fs.writeFile(path.join(f.parent,'s02-registry.initialized'),'',{mode:0o600});
 const r=await f.recovery.capture();assert.equal(r.files,4);
 const verified=await f.recovery.verify(r.id);
 assert.ok(verified.bytes.has('s02-registry/s02-collection-registry.json'));
 assert.ok(verified.bytes.has('s02-registry/s02-registry.initialized'));
 assert.equal((await f.recovery.rehearse(r.id)).stagedFiles,4);
}));
test('F10b rejects an initialized S02 registry with missing collection map',()=>use(async f=>{
 await fs.writeFile(path.join(f.parent,'s02-registry.initialized'),'',{mode:0o600});
 await assert.rejects(f.recovery.capture(),{code:'F10B_REGISTRY_INCOMPLETE'});
}));
test('F10b refuses forged S02 mapping rather than backing it up',()=>use(async f=>{
 await fs.writeFile(path.join(f.parent,'s02-collection-registry.json'),JSON.stringify({schemaVersion:2,entries:[{status:'RESERVED_NOT_ACTIVE',key:'a'.repeat(64),physicalName:'vh2_'+'1'.repeat(48),backend:'qdrant'}]})+'\n',{mode:0o600});
 await fs.writeFile(path.join(f.parent,'s02-registry.initialized'),'',{mode:0o600});
 await assert.rejects(f.recovery.capture(),{code:'F10B_REGISTRY_INVALID'});
}));
