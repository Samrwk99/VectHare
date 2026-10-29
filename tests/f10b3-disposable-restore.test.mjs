import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {captureDisposableLocal,captureDisposableQdrant,F10B2_CONSENT} from '../lib/f10b2-physical-capture.js';
import {stageF10b3DisposableRestore,verifyF10b3Staging,F10B3_CONSENT} from '../lib/f10b3-disposable-restore.js';
const disposable=b=>`vh_f09c${b==='lancedb'?'7':b==='vectra'?'8':'6'}_disposable_${'a'.repeat(32)}`;
const fixture=async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'f10b3-'));
 await fs.chmod(root,0o700);
 const backup=path.join(root,'backup'),parent=path.join(root,'parent'),stage=path.join(root,'stage');
 for(const p of [backup,parent,stage])await fs.mkdir(p,{mode:0o700});
 return {root,backup,parent,stage,cleanup:()=>fs.rm(root,{recursive:true,force:true})};};
async function captureLocal(x,backend='vectra'){
 const source=path.join(x.parent,disposable(backend));await fs.mkdir(source,{mode:0o700});
 await fs.mkdir(path.join(source,'nested'),{mode:0o700});
 await fs.writeFile(path.join(source,'nested','binary'),Uint8Array.from([0,1,2,255]),{mode:0o600});
 await fs.writeFile(path.join(source,'index.json'),JSON.stringify({count:1,backend}),{mode:0o600});
 return captureDisposableLocal({backend,disposableName:disposable(backend),backupRoot:x.backup,
  disposableParent:x.parent,operatorDeclaredQuiescent:true,consent:F10B2_CONSENT});
}
const restore=(x,id,changes={})=>stageF10b3DisposableRestore({id,backupRoot:x.backup,restoreRoot:x.stage,consent:F10B3_CONSENT,...changes});
for(const backend of ['lancedb','vectra']){
 test(`F10b3 ${backend} reconstructs byte-exact files in new INERT directory`,async()=>{
  const x=await fixture();try{
   const snapshot=await captureLocal(x,backend),r=await restore(x,snapshot.id);
   assert.equal(r.backend,backend);assert.equal(r.restoredIntoRunningBackend,false);
   assert.deepEqual(await fs.readFile(path.join(r.location,'database','nested','binary')),Buffer.from([0,1,2,255]));
   assert.equal((await verifyF10b3Staging({restoreRoot:x.stage,id:r.id})).stagingIntegrityVerified,true);
   assert.equal((await fs.readdir(x.stage)).length,1);
  }finally{await x.cleanup();}
 });
 test(`F10b3 ${backend} never overwrites existing source or staging data`,async()=>{
  const x=await fixture();try{
   const snapshot=await captureLocal(x,backend);const r1=await restore(x,snapshot.id);const r2=await restore(x,snapshot.id);
   assert.notEqual(r1.location,r2.location);
   assert.equal((await fs.readFile(path.join(x.parent,disposable(backend),'index.json'),'utf8')).includes(backend),true);
  }finally{await x.cleanup();}
 });
 test(`F10b3 ${backend} detects staging modification`,async()=>{
  const x=await fixture();try{
   const snap=await captureLocal(x,backend),r=await restore(x,snap.id);
   await fs.writeFile(path.join(r.location,'database','index.json'),'corrupted');
   await assert.rejects(verifyF10b3Staging({restoreRoot:x.stage,id:r.id}),/F10B3_STAGING_TAMPERED/);
  }finally{await x.cleanup();}
 });
 test(`F10b3 ${backend} detects changed backup before staging`,async()=>{
  const x=await fixture();try{
   const snap=await captureLocal(x,backend);
   await fs.writeFile(path.join(snap.location,'data','index.json'),'corrupted');
   await assert.rejects(restore(x,snap.id),/F10B2_CAPTURE_TAMPERED/);
   assert.deepEqual(await fs.readdir(x.stage),[]);
  }finally{await x.cleanup();}
 });
}
test('F10b3 Qdrant archives are staged only, NEVER uploaded or restored',async()=>{
 const x=await fixture();try{
  const calls=[];const fetch=async(u,opt)=>{const route=new URL(u).pathname;calls.push([opt.method,route]);
   if(opt.method==='POST')return Response.json({status:'ok',result:{name:'s.snapshot'}});
   if(route.endsWith('/s.snapshot'))return new Response(Uint8Array.from([1,2,3,4]));
   return Response.json({status:'ok',result:{status:'green'}});
  };
  const snap=await captureDisposableQdrant({backend:'qdrant',disposableName:disposable('qdrant'),backupRoot:x.backup,
   endpoint:'http://127.0.0.1:6333/',consent:F10B2_CONSENT},fetch);
  const count=calls.length;const r=await restore(x,snap.id);
  assert.equal(calls.length,count);assert.equal(r.backend,'qdrant');
  assert.equal(r.restoredIntoRunningBackend,false);
  assert.deepEqual(await fs.readFile(path.join(r.location,'snapshot.bin')),Buffer.from([1,2,3,4]));
  assert.equal((await verifyF10b3Staging({restoreRoot:x.stage,id:r.id})).productionCertified,false);
 }finally{await x.cleanup();}
});
test('F10b3 consent required and no stage is created',async()=>{
 const x=await fixture();try{const snap=await captureLocal(x);
  await assert.rejects(restore(x,snap.id,{consent:'NO'}),/F10B3_CONSENT_REQUIRED/);
  assert.deepEqual(await fs.readdir(x.stage),[]);
 }finally{await x.cleanup();}
});
test('F10b3 refuses overlapping backup and restore roots',async()=>{
 const x=await fixture();try{const snap=await captureLocal(x);
  await assert.rejects(restore(x,snap.id,{restoreRoot:x.backup}),/F10B3_OVERLAPPING_ROOTS/);
  await assert.rejects(restore(x,snap.id,{restoreRoot:path.join(x.backup,'child')}),/F10B3_OVERLAPPING_ROOTS/);
 }finally{await x.cleanup();}
});
test('F10b3 refuses symlink staging root',async()=>{
 const x=await fixture();try{const snap=await captureLocal(x),link=path.join(x.root,'link');await fs.symlink(x.stage,link);
  await assert.rejects(restore(x,snap.id,{restoreRoot:link}),/F10B3_PATH_SYMLINK/);
 }finally{await x.cleanup();}
});
test('F10b3 refuses malicious UUID',async()=>{
 const x=await fixture();try{
  await assert.rejects(restore(x,'../../etc/passwd'),/F10B3_ID_INVALID/);
 }finally{await x.cleanup();}
});
test('F10b3 refuses symlink added to staged content',async()=>{
 const x=await fixture();try{const snap=await captureLocal(x),r=await restore(x,snap.id);
  await fs.symlink('/etc/passwd',path.join(r.location,'database','bad'));
  await assert.rejects(verifyF10b3Staging({restoreRoot:x.stage,id:r.id}),/F10B3_UNTRUSTED_FILE/);
 }finally{await x.cleanup();}
});
test('F10b3 refuses modified stage receipt flags',async()=>{
 const x=await fixture();try{const snap=await captureLocal(x),r=await restore(x,snap.id);
  const file=path.join(r.location,'restore-receipt.json');const receipt=JSON.parse(await fs.readFile(file));
  receipt.restoredIntoRunningBackend=true;await fs.writeFile(file,JSON.stringify(receipt));
  await assert.rejects(verifyF10b3Staging({restoreRoot:x.stage,id:r.id}),/F10B3_RECEIPT_INVALID/);
 }finally{await x.cleanup();}
});
test('F10b3 refuses additional unexpected files in staged output',async()=>{
 const x=await fixture();try{const snap=await captureLocal(x),r=await restore(x,snap.id);
  await fs.writeFile(path.join(r.location,'extra'),'unwanted',{mode:0o600});
  await assert.rejects(verifyF10b3Staging({restoreRoot:x.stage,id:r.id}),/F10B3_STAGING_TAMPERED/);
 }finally{await x.cleanup();}
});
test('F10b3 staging CLI refuses unsafe arguments and does not modify source',async()=>{
 const x=await fixture();try{const {spawnSync}=await import('node:child_process');
  const tool=new URL('../tools/f10b3-admin-restore.mjs',import.meta.url).pathname;
  const result=spawnSync(process.execPath,[tool,'--action','stage','--backup-root',x.backup,
   '--restore-root',x.stage,'--capture-id','bad','--confirm','wrong'],{encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/F10B3_CLI_INVALID_ARGUMENTS/);
  assert.deepEqual(await fs.readdir(x.stage),[]);
 }finally{await x.cleanup();}
});
