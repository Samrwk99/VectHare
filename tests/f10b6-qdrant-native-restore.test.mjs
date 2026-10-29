import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {captureDisposableQdrant,F10B2_CONSENT} from '../lib/f10b2-physical-capture.js';
import {stageF10b3DisposableRestore,F10B3_CONSENT} from '../lib/f10b3-disposable-restore.js';
import {runF10b6QdrantRestore,F10B6_CONSENT} from '../lib/f10b6-qdrant-native-restore.js';
const source='vh_f09c6_disposable_'+'a'.repeat(32),endpoint='http://127.0.0.1:6333/';
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'f10b6-'));await fs.chmod(root,0o700);const o={root};for(const name of ['backup','restore','evidence','locks']){o[name]=path.join(root,name);await fs.mkdir(o[name],{mode:0o700});}o.cleanup=()=>fs.rm(root,{recursive:true,force:true});return o;}
function fakeQdrant({alter=false,uploadStatus=200,failUpload=false,pretendExists=false,alterSource=false,failScroll=false}={}){
 const points=[{id:1,vector:[0.1,0.2],payload:{owner:'fixture',message:'test'}},{id:2,vector:[0.2,0.3],payload:{nested:{b:2,a:1}}}];
 const collections=new Map([[source,structuredClone(points)]]);const calls=[];let capturedName=null;
 const fetch=async(url,opt={})=>{
  const parsed=new URL(url),route=parsed.pathname,method=opt.method||'GET';calls.push({method,route,options:opt});
  if(method==='GET'&&route==='/collections/'+source)return Response.json({status:'ok',result:{status:'green'}});
  if(method==='POST'&&route==='/collections/'+source+'/snapshots')return Response.json({status:'ok',result:{name:'fixture.snapshot'}});
  if(method==='GET'&&route.endsWith('/snapshots/fixture.snapshot'))return new Response(Uint8Array.from([1,2,3,4,5]));
  const m=/^\/collections\/(vh_[A-Za-z0-9_]+)(?:\/points\/scroll|\/snapshots\/upload)?$/.exec(route);
  if(m){const collection=m[1];
   if(method==='GET')return collections.has(collection)||pretendExists?Response.json({status:'ok',result:{status:'green'}}):Response.json({status:'error',result:null},{status:404});
   if(method==='POST'&&route.endsWith('/points/scroll')){
    if(failScroll)return Response.json({status:'error',result:null},{status:500});
    return Response.json({status:'ok',result:{points:structuredClone(collections.get(collection)||[]),next_page_offset:null}});
   }
   if(method==='POST'&&route.endsWith('/snapshots/upload')){
    capturedName=collection;
    assert.equal(parsed.searchParams.get('priority'),'snapshot');assert.equal(parsed.searchParams.get('wait'),'true');
    assert.match(parsed.searchParams.get('checksum'),/^[0-9a-f]{64}$/);
    assert.ok(opt.body instanceof FormData);
    if(failUpload)throw Error('timeout');
    if(uploadStatus!==200)return Response.json({status:'error',result:false},{status:uploadStatus});
    const copy=structuredClone(points);if(alter)copy[0].payload.message='changed';collections.set(collection,copy);
    if(alterSource)collections.get(source)[0].payload.message='changed';
    return Response.json({status:'ok',result:true});
   }
  }
  throw Error('unexpected route '+method+' '+route);
 };
 return {fetch,calls,collections,getDestination:()=>capturedName};
}
async function ready(x,f){const backup=await captureDisposableQdrant({backend:'qdrant',disposableName:source,backupRoot:x.backup,endpoint,consent:F10B2_CONSENT},f.fetch);const stage=await stageF10b3DisposableRestore({backupRoot:x.backup,restoreRoot:x.restore,id:backup.id,consent:F10B3_CONSENT});return {backup,stage};}
const options=(x,b,s,extra={})=>({backupRoot:x.backup,restoreRoot:x.restore,evidenceRoot:x.evidence,lockRoot:x.locks,captureId:b.id,stagingId:s.id,endpoint,consent:F10B6_CONSENT,operatorDeclaredQuiescent:true,operatorDeclaredSingleNode:true,...extra});
test('F10b6 restores into a fresh generated Qdrant collection and verifies full inventory',async()=>{const x=await fixture();try{const f=fakeQdrant(),{backup,stage}=await ready(x,f);const result=await runF10b6QdrantRestore(options(x,backup,stage),f.fetch);assert.equal(result.points,2);assert.match(result.destination,/^vh_f10b6_disposable_[a-f0-9]{32}$/);assert.equal(result.nativeRestoreObserved,true);assert.equal(result.productionCertified,false);assert.equal(result.inventoryDigest.length,64);assert.ok(f.collections.has(source));assert.ok(f.collections.has(result.destination));const receipt=JSON.parse(await fs.readFile(path.join(result.evidenceLocation,'receipt.json')));assert.equal(receipt.state,'VERIFIED');assert.equal((await fs.readdir(x.locks)).length,0);}finally{await x.cleanup();}});
test('F10b6 refuses missing operator consent before remote mutation',async()=>{const x=await fixture();try{const f=fakeQdrant(),{backup,stage}=await ready(x,f),n=f.calls.length;await assert.rejects(runF10b6QdrantRestore(options(x,backup,stage,{consent:'no'}),f.fetch),/F10B6_CONSENT_REQUIRED/);assert.equal(f.calls.length,n);}finally{await x.cleanup();}});
test('F10b6 refuses remote endpoint',async()=>{const x=await fixture();try{const f=fakeQdrant(),{backup,stage}=await ready(x,f);await assert.rejects(runF10b6QdrantRestore(options(x,backup,stage,{endpoint:'http://qdrant.example:6333/'}),f.fetch),/F10B6_LOOPBACK_ONLY/);}finally{await x.cleanup();}});
test('F10b6 refuses changed staged archive before any upload',async()=>{const x=await fixture();try{const f=fakeQdrant(),{backup,stage}=await ready(x,f);await fs.writeFile(path.join(stage.location,'snapshot.bin'),'changed');await assert.rejects(runF10b6QdrantRestore(options(x,backup,stage),f.fetch),/F10B3_STAGING_TAMPERED/);assert.equal(f.getDestination(),null);}finally{await x.cleanup();}});
test('F10b6 retains the cooperating lock on upload timeout and never retries',async()=>{const x=await fixture();try{const f=fakeQdrant({failUpload:true}),{backup,stage}=await ready(x,f);await assert.rejects(runF10b6QdrantRestore(options(x,backup,stage),f.fetch),/F10B6_UPLOAD_UNCERTAIN/);assert.equal(f.calls.filter(c=>c.route.endsWith('/snapshots/upload')).length,1);assert.equal((await fs.readdir(x.locks)).filter(v=>v.endsWith('.lock')).length,1);const ev=(await fs.readdir(x.evidence))[0];const receipt=JSON.parse(await fs.readFile(path.join(x.evidence,ev,'receipt.json')));assert.equal(receipt.state,'UNCERTAIN_REQUIRES_MANUAL_REVIEW');}finally{await x.cleanup();}});
test('F10b6 detects restored payload drift and retains lock',async()=>{const x=await fixture();try{const f=fakeQdrant({alter:true}),{backup,stage}=await ready(x,f);await assert.rejects(runF10b6QdrantRestore(options(x,backup,stage),f.fetch),/F10B6_INVENTORY_MISMATCH/);assert.equal((await fs.readdir(x.locks)).filter(v=>v.endsWith('.lock')).length,1);}finally{await x.cleanup();}});
test('F10b6 detects source changing across restore',async()=>{const x=await fixture();try{const f=fakeQdrant({alterSource:true}),{backup,stage}=await ready(x,f);await assert.rejects(runF10b6QdrantRestore(options(x,backup,stage),f.fetch),/F10B6_SOURCE_CHANGED/);assert.equal((await fs.readdir(x.locks)).filter(v=>v.endsWith('.lock')).length,1);}finally{await x.cleanup();}});
test('F10b6 fails closed when destination already exists without uploading',async()=>{const x=await fixture();try{const f=fakeQdrant({pretendExists:true}),{backup,stage}=await ready(x,f);await assert.rejects(runF10b6QdrantRestore(options(x,backup,stage),f.fetch),/F10B6_DEST_EXISTS/);assert.equal(f.getDestination(),null);assert.deepEqual((await fs.readdir(x.locks)).filter(v=>v.endsWith('.lock')),[]);}finally{await x.cleanup();}});
test('F10b6 rejects ambiguous missing-collection preflight',async()=>{const x=await fixture();try{const f=fakeQdrant(),{backup,stage}=await ready(x,f);const transport=async(url,opt)=>{if((opt?.method||'GET')==='GET'&&url.includes('vh_f10b6_disposable_'))return Response.json({status:'bad',result:null},{status:404});return f.fetch(url,opt);};await assert.rejects(runF10b6QdrantRestore(options(x,backup,stage),transport),/F10B6_PREFLIGHT_AMBIGUOUS/);assert.equal(f.getDestination(),null);}finally{await x.cleanup();}});
test('F10b6 rejects malformed or ambiguous source inventory before upload',async()=>{const x=await fixture();try{const f=fakeQdrant({failScroll:true}),{backup,stage}=await ready(x,f);await assert.rejects(runF10b6QdrantRestore(options(x,backup,stage),f.fetch),/F10B6_HTTP_500/);assert.equal(f.getDestination(),null);}finally{await x.cleanup();}});
test('F10b6 refuses untrusted evidence directory symlink',async()=>{const x=await fixture();try{const f=fakeQdrant(),{backup,stage}=await ready(x,f);const link=path.join(x.root,'link');await fs.symlink(x.evidence,link);await assert.rejects(runF10b6QdrantRestore(options(x,backup,stage,{evidenceRoot:link}),f.fetch),/F10B6_SYMLINK_PATH/);assert.equal(f.getDestination(),null);}finally{await x.cleanup();}});
test('F10b6 operator quiescence is mandatory',async()=>{const x=await fixture();try{const f=fakeQdrant(),{backup,stage}=await ready(x,f);await assert.rejects(runF10b6QdrantRestore(options(x,backup,stage,{operatorDeclaredQuiescent:false}),f.fetch),/F10B6_QUIESCENCE_REQUIRED/);assert.equal(f.getDestination(),null);}finally{await x.cleanup();}});

test('F10b6 requires explicitly confirmed disposable single-node host',async()=>{const x=await fixture();try{const f=fakeQdrant(),{backup,stage}=await ready(x,f);await assert.rejects(runF10b6QdrantRestore(options(x,backup,stage,{operatorDeclaredSingleNode:false}),f.fetch),/F10B6_SINGLE_NODE_CONFIRMATION_REQUIRED/);assert.equal(f.getDestination(),null);}finally{await x.cleanup();}});
