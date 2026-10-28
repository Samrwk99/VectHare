import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {collectF10Evidence,F10CaptureError,F10CaptureStore,registerF10Routes,validateF10Request} from '../lib/f10-recovery-capture.js';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const embedding={source:'transformers',model:'test',dimension:3,metric:'cosine'};
const body={backend:'qdrant',source:{kind:'chat',avatar:'Nina.png',chatFile:'one'},embedding,configId:'local',confirmCapture:'I UNDERSTAND THIS IS NOT A VERIFIED FULL BACKUP'};
const id=randomUUID();
const record={recordId:id,revision:1,text:'memory',textHash:digest('memory'),metadata:{tag:'test'},metadataHash:digest({tag:'test'}),vector:[1,0,0],vectorHash:digest([1,0,0])};
const readMock=async({page,recordId},operation)=>operation==='get'?recordId===id?record:null:
 {items:page.cursor===null?[record]:[],hasMore:false,nextCursor:null};
async function fixture(callback){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'f10-recovery-'));
 try{const vectors=path.join(root,'vectors');await fs.mkdir(vectors,{mode:0o700});
  const binding={backend:'qdrant',embedding,collection:{key:'a'.repeat(64)}};
  const context={userScopeId:'alice',vectorsPath:vectors};
  return await callback({root,vectors,binding,context});
 }finally{await fs.rm(root,{force:true,recursive:true});}
}
test('F10 double walk plus per-UUID readback produces bounded NON-authoritative evidence',async()=>{
 const evidence=await collectF10Evidence(body,readMock);
 assert.equal(evidence.recordCount,1);assert.equal(evidence.twoPassAgreement,true);
 assert.equal(evidence.authoritativeInventory,false);assert.equal(evidence.verifiedFullBackup,false);
 assert.equal(evidence.migrationAllowed,false);assert.equal(evidence.snapshotConsistency,'UNPROVEN');
});
test('F10 refuses changing pages, disappeared get, duplicate IDs, cursor loops, and oversized traversal',async()=>{
 let calls=0;
 await assert.rejects(()=>collectF10Evidence(body,async(o,op)=>{
  if(op==='get')return record;
  return {items:++calls===1?[record]:[],hasMore:false,nextCursor:null};
 }),e=>e.code==='F10_COLLECTION_CHANGED');
 await assert.rejects(()=>collectF10Evidence(body,async(o,op)=>op==='get'?null:
  {items:[record],hasMore:false,nextCursor:null}),e=>e.code==='F10_READBACK_CHANGED');
 await assert.rejects(()=>collectF10Evidence(body,async()=>
  ({items:[record,record],hasMore:false,nextCursor:null})),e=>e.code==='F10_DUPLICATE_ID');
 await assert.rejects(()=>collectF10Evidence(body,async()=>
  ({items:[record],hasMore:true,nextCursor:'same'})),e=>e.code==='F10_DUPLICATE_ID'||e.code==='F10_CURSOR_LOOP');
 await assert.rejects(()=>collectF10Evidence(body,async()=>
  ({items:[],hasMore:true,nextCursor:1})),e=>e.code==='F10_PAGE_STALLED');
});
test('F10 strict request shape rejects owner fields, arbitrary collection and silent capture',()=>{
 for(const changed of [{...body,userScopeId:'victim'},{...body,physicalName:'legacy'},
  {...body,confirmCapture:false},{...body,source:{...body.source,owner:'victim'}},
  {...body,embedding:{...body.embedding,apiKey:'secret'}}])
  assert.throws(()=>validateF10Request(changed,'capture'),F10CaptureError);
 assert.throws(()=>validateF10Request({...body,captureId:'bad'},'status'),F10CaptureError);
});
test('F10 private capture store hashes, re-reads, detects tampering and denies other user or collection',()=>fixture(async({context,binding,vectors})=>{
 const evidence=await collectF10Evidence(body,readMock);
 const store=new F10CaptureStore(context),{captureId}=await store.save(binding,evidence);
 const found=await store.read(binding,captureId);
 assert.equal(found.evidence.records[0].text,'memory');
 await assert.rejects(()=>store.read({...binding,collection:{key:'b'.repeat(64)}},captureId),e=>e.code==='F10_CAPTURE_CORRUPT');
 await assert.rejects(()=>new F10CaptureStore({...context,userScopeId:'bob'}).read(binding,captureId),e=>e.code==='F10_CAPTURE_CORRUPT');
 const file=path.join(vectors,'.similharity','f10-captures',captureId+'.json');
 const original=await fs.readFile(file,'utf8');
 await fs.writeFile(file,original.replace('memory','malicious'));
 await assert.rejects(()=>store.read(binding,captureId),e=>e.code==='F10_CAPTURE_CORRUPT');
}));
test('F10 router ties capture, receipt and download to fresh source binding and never restores',()=>fixture(async({context,binding})=>{
 const routes=new Map(),router={post:(p,handler)=>routes.set(p,handler)},requests=[];
 registerF10Routes(router,{backendPool:{get(){}},resolveBinding:async(req,b)=>{
  requests.push({user:req.s03.userScopeId,source:b.source.chatFile});
  if(req.s03.userScopeId!=='alice'||b.source.chatFile!=='one')throw new F10CaptureError('F10_WRONG_SOURCE',403);
  return {binding};
 },readScoped:async(req,b,op)=>readMock(b,op)});
 const invoke=async(url,reqBody,ctx=context)=>{
  const res={statusCode:200,status(n){this.statusCode=n;return this;},json(result){this.body=result;return this;}};
  await routes.get(url)({s03:ctx,body:reqBody},res);return res;
 };
 const made=await invoke('/v2/recovery/capture',body);
 assert.equal(made.statusCode,200);assert.equal(made.body.authoritativeInventory,false);
 const next={backend:body.backend,source:body.source,embedding,configId:'local',captureId:made.body.captureId};
 const status=await invoke('/v2/recovery/status',next);
 assert.equal(status.body.captureIntegrityVerified,true);
 const downloaded=await invoke('/v2/recovery/download',next);
 assert.equal(downloaded.body.data.records.length,1);
 assert.equal(downloaded.body.restoreAllowed,false);
 const wrong=await invoke('/v2/recovery/download',{...next,source:{...body.source,chatFile:'branch'}});
 assert.equal(wrong.statusCode,403);
 const other=await invoke('/v2/recovery/status',next,{...context,userScopeId:'bob'});
 assert.equal(other.statusCode,403);
 assert.equal(requests.length,5);
}));

test('F10 real F02 source attestation + Qdrant strict read adapter captures only owned records',async()=>{
 const {registerF02Routes}=await import('../lib/f02-public-reads.js');
 const {recordIdentity,contentFingerprint}=await import('../lib/s02-identity.js');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'f10-host-'));
 try{
  const vectors=path.join(root,'vectors'),chats=path.join(root,'chats'),characters=path.join(root,'characters');
  const worlds=path.join(root,'worlds'),groups=path.join(root,'groups'),groupChats=path.join(root,'groupChats');
  for(const d of [vectors,path.join(chats,'Nina'),characters,worlds,groups,groupChats])await fs.mkdir(d,{recursive:true,mode:0o700});
  await fs.writeFile(path.join(characters,'Nina.png'),'avatar');
  await fs.writeFile(path.join(chats,'Nina','one.jsonl'),JSON.stringify({chat_metadata:{integrity:'safe'}})+'\n');
  const req={s03:{userScopeId:'alice',vectorsPath:vectors},user:{profile:{handle:'alice'},
   directories:{root,vectors,chats,characters,worlds,groups,groupChats}}};
  const handlers=new Map(),router={post:(url,fn)=>handlers.set(url,fn)};
  let row=null,postCount=0;
  const backend={async _request(method,url,payload){
   if(method==='GET')return {result:{config:{params:{vectors:{size:3,distance:'Cosine'}}}}};
   if(url.endsWith('/points/scroll')){
    postCount++;
    const filtered=row&&payload.filter.must.every(x=>row[x.key]===x.match.value);
    return {result:{points:filtered?[{id:row.physicalId,payload:row,
     vector:payload.with_vector?row.vector:undefined}]:[],next_page_offset:null}};
   }
   throw Error('unexpected backend route');
  }};
  const pool={get:async()=>backend};
  registerF02Routes(router,{backendPool:pool});registerF10Routes(router,{backendPool:pool});
  const invoke=async(url,form)=>{
   const res={statusCode:200,status(n){this.statusCode=n;return this;},json(x){this.body=x;return this;}};
   await handlers.get(url)({...req,body:form},res);return res;
  };
  const {confirmCapture,...bindBody}=body;
  const bind=await invoke('/v2/reads/bind',bindBody);
  assert.equal(bind.statusCode,200,JSON.stringify(bind.body));
  // Resolve the server-attested source scope; no physical scope is provided by the client.
  const {resolveF02Binding}=await import('../lib/f02-public-reads.js');
  const {binding}=await resolveF02Binding(req,bindBody);
  const identity=recordIdentity(binding.scope,id);
  row={...binding.scope,branchId:binding.scope.branchId??'',recordId:id,physicalId:identity.physicalId,
   revision:1,text:'safe test',textHash:contentFingerprint('safe test'),
   vector:[1,0,0],vectorHash:digest([1,0,0]),metadata:{tag:'test'},metadataHash:digest({tag:'test'}),embedding};
  const result=await invoke('/v2/recovery/capture',body);
  assert.equal(result.statusCode,200,JSON.stringify(result.body));
  assert.equal(result.body.recordCount,1);
  assert.ok(postCount>=3); // two pages + exact per-record readback
  const download=await invoke('/v2/recovery/download',{...bindBody,captureId:result.body.captureId});
  assert.equal(download.statusCode,200);assert.equal(download.body.data.records[0].recordId,id);
  await fs.rm(path.join(chats,'Nina','one.jsonl'));
  const refused=await invoke('/v2/recovery/download',{...bindBody,captureId:result.body.captureId});
  assert.ok(refused.statusCode>=400);assert.notEqual(refused.body.success,true);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
