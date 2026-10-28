/** F10: evidence-preserving, bounded source-attested v2 capture.
 * No complete-inventory claim: two traversals and per-ID verification cannot
 * establish an atomic database snapshot in the presence of external writers.
 * This module NEVER restores, drops, migrates, or mutates vector collections.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {resolveF02Binding,executeF02ScopedRead} from './f02-public-reads.js';

const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const sha=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RECORDS=300,MAX_PAGES=16,PAGE_LIMIT=50,MAX_BYTES=8*1024*1024;
const BACKENDS=new Set(['qdrant','lancedb','vectra','milvus']);
export class F10CaptureError extends Error {
 constructor(code,status=409){super(code);this.code=code;this.status=status;}
}
export function validateF10Request(body,operation){
 const allowed=['backend','source','embedding','configId',...(operation==='capture'?['confirmCapture']:['captureId'])];
 if(!obj(body)||Object.keys(body).some(k=>!allowed.includes(k))||!BACKENDS.has(body.backend)||
    !obj(body.source)||!obj(body.embedding)||
    !['chat','group-chat','lorebook'].includes(body.source.kind)||
    (body.configId!==undefined&&!['local','default'].includes(body.configId))||
    (body.configId==='local'&&body.backend!=='qdrant'))
  throw new F10CaptureError('F10_REQUEST_INVALID',400);
 const keys=body.source.kind==='chat'?['kind','avatar','chatFile']:
   body.source.kind==='group-chat'?['kind','groupId','chatFile']:['kind','name'];
 if(Object.keys(body.source).some(k=>!keys.includes(k))||keys.some(k=>typeof body.source[k]!=='string'||
    !body.source[k]||body.source[k].length>220)||
    Object.keys(body.embedding).some(k=>!['source','model','dimension','metric'].includes(k)))
  throw new F10CaptureError('F10_SCOPE_FORBIDDEN',403);
 if(operation==='capture'&&body.confirmCapture!=='I UNDERSTAND THIS IS NOT A VERIFIED FULL BACKUP')
  throw new F10CaptureError('F10_EXPLICIT_CONSENT_REQUIRED',403);
 if(operation!=='capture'&&!UUID.test(body.captureId||''))throw new F10CaptureError('F10_CAPTURE_ID_INVALID',400);
 return body;
}
function record(row){
 if(!obj(row)||!UUID.test(row.recordId||'')||!Number.isSafeInteger(row.revision)||row.revision<1||
  typeof row.text!=='string'||!obj(row.metadata)||!Array.isArray(row.vector)||
  !row.vector.length||row.vector.some(v=>typeof v!=='number'||!Number.isFinite(v))||
  typeof row.textHash!=='string'||typeof row.vectorHash!=='string'||typeof row.metadataHash!=='string')
  throw new F10CaptureError('F10_RECORD_EVIDENCE_MISSING');
 return {recordId:row.recordId,revision:row.revision,text:row.text,textHash:row.textHash,
  metadata:row.metadata,metadataHash:row.metadataHash,vector:row.vector,vectorHash:row.vectorHash};
}
function orderedDigest(rows){return sha(rows.map(record).sort((a,b)=>a.recordId.localeCompare(b.recordId)));}
async function walk(read,body){
 let cursor=null;const cursors=new Set(),ids=new Set(),records=[];
 for(let pageNumber=1;pageNumber<=MAX_PAGES;pageNumber++){
  const page=await read({...body,page:{limit:PAGE_LIMIT,cursor,includeVectors:true}},'list');
  if(!obj(page)||!Array.isArray(page.items)||typeof page.hasMore!=='boolean'||page.items.length>PAGE_LIMIT)
   throw new F10CaptureError('F10_PAGE_INVALID');
  if(page.hasMore&&(!page.items.length||page.nextCursor===null||page.nextCursor===undefined))
   throw new F10CaptureError('F10_PAGE_STALLED');
  for(const item of page.items){
   const checked=record(item);
   if(ids.has(checked.recordId))throw new F10CaptureError('F10_DUPLICATE_ID');
   ids.add(checked.recordId);records.push(checked);
   if(records.length>MAX_RECORDS)throw new F10CaptureError('F10_CAPTURE_BOUNDED');
  }
  if(!page.hasMore)return {records,pages:pageNumber};
  const key=JSON.stringify(page.nextCursor);
  if(cursors.has(key)||key===JSON.stringify(cursor))throw new F10CaptureError('F10_CURSOR_LOOP');
  cursors.add(key);cursor=page.nextCursor;
 }
 throw new F10CaptureError('F10_PAGE_LIMIT');
}
/** Captures two bounded scans and confirms every listed record by stable UUID.
 * Not atomic, never an authoritative inventory. */
export async function collectF10Evidence(body,read){
 if(typeof read!=='function')throw new F10CaptureError('F10_READ_REQUIRED');
 const first=await walk(read,body),second=await walk(read,body);
 if(orderedDigest(first.records)!==orderedDigest(second.records))throw new F10CaptureError('F10_COLLECTION_CHANGED');
 const rows=second.records.sort((a,b)=>a.recordId.localeCompare(b.recordId));
 for(const expected of rows){
  const actual=await read({...body,recordId:expected.recordId},'get');
  if(!actual||orderedDigest([actual])!==orderedDigest([expected]))throw new F10CaptureError('F10_READBACK_CHANGED');
 }
 return {records:rows,recordCount:rows.length,firstPassPages:first.pages,secondPassPages:second.pages,
  evidenceDigest:orderedDigest(rows),twoPassAgreement:true,perRecordReadback:true,
  traversalCompletedWithinBounds:true,snapshotConsistency:'UNPROVEN',
  authoritativeInventory:false,verifiedFullBackup:false,migrationAllowed:false,restoreAllowed:false};
}
async function privateDirectory(dir,{strictPermissions=true}={}){
 const stat=await fs.lstat(dir);
 if(!stat.isDirectory()||stat.isSymbolicLink()||(strictPermissions&&process.platform!=='win32'&&(stat.mode&0o077)))
  throw new F10CaptureError('F10_UNTRUSTED_DIRECTORY');
}
export class F10CaptureStore {
 constructor(context){
  if(!context?.userScopeId||!path.isAbsolute(context?.vectorsPath||''))
   throw new F10CaptureError('F10_TRUSTED_CONTEXT_REQUIRED',403);
  this.context=context;this.root=path.join(context.vectorsPath,'.similharity','f10-captures');
 }
 async setup(){
  // The SillyTavern-host-verified vectors directory may have ordinary host
  // permissions; our *new* capture subdirectories must remain 0700.
  await privateDirectory(this.context.vectorsPath,{strictPermissions:false});
  const parent=path.dirname(this.root);
  for(const dir of [parent,this.root]){
   try{await fs.mkdir(dir,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
   await privateDirectory(dir);
  }
 }
 filename(id){if(!UUID.test(id||''))throw new F10CaptureError('F10_CAPTURE_ID_INVALID',400);
  return path.join(this.root,id.toLowerCase()+'.json');}
 async save(binding,evidence){
  await this.setup();
  const id=randomUUID(),doc={schemaVersion:10,mode:'F10_NONAUTHORITATIVE_EVIDENCE_CAPTURE',
   captureId:id,userScopeId:this.context.userScopeId,collectionKey:binding.collection.key,
   backend:binding.backend,embedding:binding.embedding,evidence};
  const serialized=JSON.stringify(doc),checksum=sha(serialized);
  if(Buffer.byteLength(serialized)>MAX_BYTES)throw new F10CaptureError('F10_CAPTURE_TOO_LARGE');
  const h=await fs.open(this.filename(id),'wx',0o600);
  try{await h.writeFile(JSON.stringify({...doc,checksum})+'\n');await h.sync();}finally{await h.close();}
  // Windows does not support opening a directory handle in the same way as POSIX.
  if(process.platform!=='win32'){
   const directory=await fs.open(this.root,'r');try{await directory.sync();}finally{await directory.close();}
  }
  return {captureId:id,checksum};
 }
 async read(binding,id){
  await this.setup();
  const filename=this.filename(id),st=await fs.lstat(filename);
  if(!st.isFile()||st.isSymbolicLink()||st.size>MAX_BYTES+2048||
    (process.platform!=='win32'&&(st.mode&0o077)))throw new F10CaptureError('F10_CAPTURE_UNTRUSTED');
  let saved;try{saved=JSON.parse(await fs.readFile(filename,'utf8'));}catch{throw new F10CaptureError('F10_CAPTURE_CORRUPT');}
  const {checksum,...doc}=saved||{};
  if(doc.schemaVersion!==10||doc.mode!=='F10_NONAUTHORITATIVE_EVIDENCE_CAPTURE'||
    doc.captureId!==id.toLowerCase()||doc.userScopeId!==this.context.userScopeId||
    doc.collectionKey!==binding.collection.key||doc.backend!==binding.backend||
    JSON.stringify(doc.embedding)!==JSON.stringify(binding.embedding)||
    !/^[0-9a-f]{64}$/.test(checksum||'')||sha(JSON.stringify(doc))!==checksum||
    !obj(doc.evidence)||!Array.isArray(doc.evidence.records)||
    doc.evidence.recordCount!==doc.evidence.records.length||doc.evidence.recordCount>MAX_RECORDS||
    doc.evidence.evidenceDigest!==orderedDigest(doc.evidence.records)||
    doc.evidence.authoritativeInventory!==false||doc.evidence.verifiedFullBackup!==false||
    doc.evidence.restoreAllowed!==false||doc.evidence.migrationAllowed!==false||
    doc.evidence.snapshotConsistency!=='UNPROVEN')throw new F10CaptureError('F10_CAPTURE_CORRUPT');
  return {...doc,checksum};
 }
}
function code(err){return /^[A-Z0-9_]{3,90}$/.test(err?.code||'')?err.code:'F10_CAPTURE_UNAVAILABLE';}
export function registerF10Routes(router,{backendPool,createVectra,readScoped=executeF02ScopedRead,resolveBinding=resolveF02Binding}={}){
 if(!backendPool||typeof readScoped!=='function'||typeof resolveBinding!=='function')throw Error('F10_DEPENDENCIES_REQUIRED');
 const handler=operation=>async(req,res)=>{
  try{
   const body=validateF10Request(req.body,operation);
   if(!req?.s03?.userScopeId)throw new F10CaptureError('F10_AUTH_REQUIRED',403);
   // ALWAYS re-attest the saved source and derive the physical namespace server-side.
   const {binding}=await resolveBinding(req,body,{reserve:false});
   const store=new F10CaptureStore(req.s03);
   if(operation==='capture'){
    const read=(data,op)=>readScoped(req,data,op,{backendPool,createVectra});
    // Consent is HTTP-only. It must not leak into the strict F02 read request.
    const readBody={backend:body.backend,source:body.source,embedding:body.embedding,
      ...(body.configId!==undefined?{configId:body.configId}:{})};
    const evidence=await collectF10Evidence(readBody,read);
    const {captureId,checksum}=await store.save(binding,evidence);
    return res.json({success:true,captureId,checksum,recordCount:evidence.recordCount,
     twoPassAgreement:true,perRecordReadback:true,scopeVerified:true,
     authoritativeInventory:false,snapshotConsistency:'UNPROVEN',verifiedFullBackup:false,
     migrationAllowed:false,restoreAllowed:false,productionWritesEnabled:false});
   }
   const saved=await store.read(binding,body.captureId);
   if(operation==='status')return res.json({success:true,captureId:saved.captureId,checksum:saved.checksum,
    recordCount:saved.evidence.recordCount,scopeVerified:true,captureIntegrityVerified:true,
    authoritativeInventory:false,snapshotConsistency:'UNPROVEN',verifiedFullBackup:false,
    migrationAllowed:false,restoreAllowed:false,productionWritesEnabled:false});
   return res.json({success:true,captureId:saved.captureId,checksum:saved.checksum,
    captureIntegrityVerified:true,scopeVerified:true,exportKind:'NONAUTHORITATIVE_RECORD_EVIDENCE_ONLY',
    authoritativeInventory:false,verifiedFullBackup:false,snapshotConsistency:'UNPROVEN',
    migrationAllowed:false,restoreAllowed:false,productionWritesEnabled:false,
    data:{schemaVersion:10,captureId:saved.captureId,backend:saved.backend,embedding:saved.embedding,
     records:saved.evidence.records,recordCount:saved.evidence.recordCount,evidenceDigest:saved.evidence.evidenceDigest}});
  }catch(error){return res.status(Number.isInteger(error?.status)?error.status:409)
   .json({success:false,code:code(error),authoritativeInventory:false,productionWritesEnabled:false});}
 };
 router.post('/v2/recovery/capture',handler('capture'));
 router.post('/v2/recovery/status',handler('status'));
 router.post('/v2/recovery/download',handler('download'));
}
