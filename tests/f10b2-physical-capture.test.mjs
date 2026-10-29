import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {captureDisposableLocal,captureDisposableQdrant,verifyF10b2Capture,validateF10b2Input,
 assessMilvusF10b2,F10B2_CONSENT} from '../lib/f10b2-physical-capture.js';
const mk=async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'f10b2-test-'));await fs.chmod(root,0o700);
 const local=path.join(root,'local'),backup=path.join(root,'backup');await fs.mkdir(local,{mode:0o700});await fs.mkdir(backup,{mode:0o700});
 return {root,local,backup,cleanup:()=>fs.rm(root,{recursive:true,force:true})};};
const name=(backend)=>backend==='lancedb'?'vh_f09c7_disposable_'+'a'.repeat(32):backend==='vectra'?'vh_f09c8_disposable_'+'a'.repeat(32):'vh_f09c6_disposable_'+'a'.repeat(32);
const localArgs=(x,backend)=>({backend,disposableName:name(backend),disposableParent:x.local,backupRoot:x.backup,consent:F10B2_CONSENT,operatorDeclaredQuiescent:true});
test('F10b2 refuses absent consent, production names, other backends',()=>{
 assert.throws(()=>validateF10b2Input({backend:'lancedb',disposableName:name('lancedb'),backupRoot:'/tmp'}),/F10B2_CONSENT_REQUIRED/);
 assert.throws(()=>validateF10b2Input({backend:'lancedb',disposableName:'actual_database',backupRoot:'/tmp',consent:F10B2_CONSENT}),/F10B2_NOT_DISPOSABLE/);
 assert.throws(()=>validateF10b2Input({backend:'milvus',disposableName:name('qdrant'),backupRoot:'/tmp',consent:F10B2_CONSENT}),/F10B2_NOT_DISPOSABLE/);
});
for(const backend of ['lancedb','vectra']){
 test(`F10b2 ${backend} copies and verifies nested disposable files under lock`,async()=>{
  const x=await mk();try{
   const source=path.join(x.local,name(backend));await fs.mkdir(source,{mode:0o700});
   await fs.mkdir(path.join(source,'nested'),{mode:0o700});
   await fs.writeFile(path.join(source,'nested','data.bin'),Buffer.from([0,1,2,3,4]),{mode:0o600});
   await fs.writeFile(path.join(source,'index.json'),'{"records":1}',{mode:0o600});
   const out=await captureDisposableLocal(localArgs(x,backend));
   assert.equal(out.files,2);assert.equal(out.productionCertified,false);
   assert.equal((await verifyF10b2Capture({backupRoot:x.backup,id:out.id})).integrityVerified,true);
   assert.equal((await fs.readdir(path.join(x.local,'writer-locks'))).length,0);
  }finally{await x.cleanup();}
 });
 test(`F10b2 ${backend} rejects links and does not mark them as backup`,async()=>{
  const x=await mk();try{
   const source=path.join(x.local,name(backend));await fs.mkdir(source,{mode:0o700});
   await fs.symlink('/etc/passwd',path.join(source,'link'));
   await assert.rejects(captureDisposableLocal(localArgs(x,backend)),/F10B2_SYMLINK_REFUSED/);
  }finally{await x.cleanup();}
 });
}
test('F10b2 rejects overlapping source and backup folders',async()=>{
 const x=await mk();try{
  const source=path.join(x.local,name('vectra'));await fs.mkdir(source,{mode:0o700});await fs.writeFile(path.join(source,'a'),'hello',{mode:0o600});
  await assert.rejects(captureDisposableLocal({...localArgs(x,'vectra'),backupRoot:source}),/F10B2_OVERLAPPING_ROOTS/);
 }finally{await x.cleanup();}
});
test('F10b2 refuses backup tampering',async()=>{
 const x=await mk();try{
  const source=path.join(x.local,name('lancedb'));await fs.mkdir(source,{mode:0o700});await fs.writeFile(path.join(source,'a'),'hello',{mode:0o600});
  const result=await captureDisposableLocal(localArgs(x,'lancedb'));
  await fs.writeFile(path.join(result.location,'data','a'),'tampered',{mode:0o600});
  await assert.rejects(verifyF10b2Capture({backupRoot:x.backup,id:result.id}),/F10B2_CAPTURE_TAMPERED/);
 }finally{await x.cleanup();}
});
test('F10b2 rejects symlink backup root',async()=>{
 const x=await mk();try{
  const source=path.join(x.local,name('vectra'));await fs.mkdir(source,{mode:0o700});await fs.writeFile(path.join(source,'a'),'hello',{mode:0o600});
  const symlink=path.join(x.root,'link');await fs.symlink(x.backup,symlink);
  await assert.rejects(captureDisposableLocal({...localArgs(x,'vectra'),backupRoot:symlink}),/F10B2_PATH_SYMLINK/);
 }finally{await x.cleanup();}
});
test('F10b2 Qdrant native snapshot writes hashed private file without RESTORE',async()=>{
 const x=await mk();try{
  const requests=[];
  const mock=async(url,opts)=>{
   const route=new URL(url).pathname;requests.push([opts.method,route]);
   if(opts.method==='GET'&&route.endsWith(name('qdrant')))return Response.json({result:{status:'green'},status:'ok'});
   if(opts.method==='POST'&&route.endsWith('/snapshots'))return Response.json({result:{name:'snap-01.snapshot'},status:'ok'});
   if(opts.method==='GET'&&route.endsWith('/snap-01.snapshot'))return new Response(Uint8Array.from([8,7,6,5]),{status:200});
   throw Error('unexpected route');
  };
  const out=await captureDisposableQdrant({backend:'qdrant',disposableName:name('qdrant'),backupRoot:x.backup,
   endpoint:'http://127.0.0.1:6333/',consent:F10B2_CONSENT},mock);
  assert.equal(out.bytes,4);assert.equal(out.productionCertified,false);
  assert.deepEqual(requests.map(x=>x[0]),['GET','POST','GET']);
  const verified=await verifyF10b2Capture({backupRoot:x.backup,id:out.id});assert.equal(verified.integrityVerified,true);
 }finally{await x.cleanup();}
});
test('F10b2 Qdrant blocks remote endpoint before fetch',async()=>{
 const x=await mk();try{let called=false;
  await assert.rejects(captureDisposableQdrant({backend:'qdrant',disposableName:name('qdrant'),backupRoot:x.backup,
   endpoint:'https://example.com/',consent:F10B2_CONSENT},async()=>{called=true;}),/F10B2_QDRANT_LOOPBACK_REQUIRED/);
  assert.equal(called,false);
 }finally{await x.cleanup();}
});
test('F10b2 Qdrant never attempts snapshot on missing fixture',async()=>{
 const x=await mk();try{const verbs=[];
  await assert.rejects(captureDisposableQdrant({backend:'qdrant',disposableName:name('qdrant'),backupRoot:x.backup,
   endpoint:'http://127.0.0.1:6333/',consent:F10B2_CONSENT},async(_url,opts)=>{verbs.push(opts.method);return new Response('',{status:404});}),/F10B2_QDRANT_HTTP_ERROR/);
  assert.deepEqual(verbs,['GET']);
 }finally{await x.cleanup();}
});
test('F10b2 Milvus does not claim a complete collection backup',()=>{
 const status=assessMilvusF10b2();assert.equal(status.snapshotImplemented,false);assert.equal(status.productionCertified,false);
});
test('F10b2 refuses active cooperating lock without touching source',async()=>{
 const x=await mk();try{
  const source=path.join(x.local,name('vectra'));await fs.mkdir(source,{mode:0o700});await fs.writeFile(path.join(source,'a'),'hello',{mode:0o600});
  const first=await captureDisposableLocal(localArgs(x,'vectra'));
  const lockdir=path.join(x.local,'writer-locks');
  // A real orphan lock is enough: the boundary does not steal it.
  const old=await fs.readdir(lockdir);assert.deepEqual(old,[]);
  const key=await import('../lib/f09c5-writer-boundary.js');
  const gate=new key.CooperativeWriterBoundary({root:lockdir,backend:'vectra',physicalName:name('vectra')});
  await assert.rejects(gate.withWriteBoundary({backend:'vectra',physicalCollectionName:name('vectra'),collectionKey:'a'.repeat(64)},async()=>{throw Error('INTERRUPTED');}),/INTERRUPTED/);
  await assert.rejects(captureDisposableLocal(localArgs(x,'vectra')),e=>e.code==='F09C5_WRITER_BUSY');
  assert.equal((await verifyF10b2Capture({backupRoot:x.backup,id:first.id})).integrityVerified,true);
 }finally{await x.cleanup();}
});
test('F10b2 Qdrant refuses unsafe returned archive names and never downloads',async()=>{
 const x=await mk();try{
  const req=[];
  const request=async(url,options)=>{
   req.push([options.method,new URL(url).pathname]);
   if(options.method==='GET')return Response.json({status:'ok',result:{status:'green'}});
   return Response.json({status:'ok',result:{name:'../../secrets'}});
  };
  await assert.rejects(captureDisposableQdrant({backend:'qdrant',disposableName:name('qdrant'),backupRoot:x.backup,
   endpoint:'http://127.0.0.1:6333/',consent:F10B2_CONSENT},request),/F10B2_QDRANT_SNAPSHOT_RESPONSE_INVALID/);
  assert.deepEqual(req.map(x=>x[0]),['GET','POST']);
 }finally{await x.cleanup();}
});
test('F10b2 Qdrant archive tampering is detected',async()=>{
 const x=await mk();try{
  const request=async(url,options)=>{
   if(options.method==='POST')return Response.json({status:'ok',result:{name:'snapshot.dat'}});
   if(new URL(url).pathname.endsWith('/snapshot.dat'))return new Response('original');
   return Response.json({status:'ok',result:{status:'green'}});
  };
  const out=await captureDisposableQdrant({backend:'qdrant',disposableName:name('qdrant'),backupRoot:x.backup,
   endpoint:'http://127.0.0.1:6333/',consent:F10B2_CONSENT},request);
  await fs.writeFile(path.join(out.location,'snapshot.bin'),'modified',{mode:0o600});
  await assert.rejects(verifyF10b2Capture({backupRoot:x.backup,id:out.id}),/F10B2_CAPTURE_TAMPERED/);
 }finally{await x.cleanup();}
});
test('F10b2 Qdrant snapshot HTTP redirect is not followed',async()=>{
 const x=await mk();try{let sent=0;
  const request=async(_url,options)=>{sent++;
   if(options.method==='GET')return Response.json({status:'ok',result:{status:'green'}});
   return new Response(null,{status:302,headers:{location:'http://example.org/steal'}});
  };
  await assert.rejects(captureDisposableQdrant({backend:'qdrant',disposableName:name('qdrant'),backupRoot:x.backup,
   endpoint:'http://127.0.0.1:6333/',consent:F10B2_CONSENT},request),/F10B2_QDRANT_HTTP_ERROR/);
  assert.equal(sent,2);
 }finally{await x.cleanup();}
});
