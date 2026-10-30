/** M3 logical collection exclusion shared by ordinary S04/F03 writers and
 * lifecycle journal transitions. It is a same-host cooperative filesystem
 * boundary, NOT an external-writer/distributed lock or production certificate.
 * A failure after a lifecycle append or uncertain dispatch retains the gate.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const KEY=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digest=x=>createHash('sha256').update(x).digest('hex');
const bad=code=>Object.assign(new Error(code),{code,status:409});
async function privateDir(location){const st=await fs.lstat(location);
 if(!st.isDirectory()||st.isSymbolicLink()||(process.platform!=='win32'&&(st.mode&0o077)))throw bad('M3_EXCLUSION_UNTRUSTED_DIRECTORY');}
async function syncDirectory(location){const f=await fs.open(location,'r');try{await f.sync();}finally{await f.close();}}
export class M3LogicalExclusion {
 constructor(ctx,{backend='qdrant',logicalKey}={}){
  if(!ctx?.userScopeId||!path.isAbsolute(ctx.vectorsPath??'')||!['qdrant','milvus','lancedb','vectra'].includes(backend)||!KEY.test(logicalKey??''))
   throw bad('M3_EXCLUSION_SCOPE_INVALID');
  this.ctx=ctx;this.backend=backend;this.logicalKey=logicalKey;
  this.parent=path.join(ctx.vectorsPath,'.similharity');this.root=path.join(this.parent,'m3-logical-locks');
  this.file=path.join(this.root,`collection-${digest(JSON.stringify([backend,logicalKey]))}.lock`);
 }
 async setup(){await privateDir(this.ctx.vectorsPath);
  for(const p of [this.parent,this.root]){try{await fs.mkdir(p,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}await privateDir(p);}}
 /** Work returns a terminal outcome or throws. Exceptions retain the lock,
  * unless explicitly marked as a pre-dispatch/pre-append refusal by trusted
  * code via {state:'FAILED'}; browser callers cannot choose this classification.
  */
 async withExclusion({operationId=null}={},work){
  if(typeof work!=='function'||(operationId!==null&&!UUID.test(operationId)))throw bad('M3_EXCLUSION_REQUEST_INVALID');
  await this.setup();let fd;
  try{fd=await fs.open(this.file,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw bad('M3_LOGICAL_COLLECTION_BUSY');throw e;}
  const created=await fd.stat();let release=false;
  try{
   await fd.writeFile(JSON.stringify({schemaVersion:1,backend:this.backend,logicalKey:this.logicalKey,
    ownerHash:digest(this.ctx.userScopeId),operationId,pid:process.pid})+'\n');
   await fd.sync();await syncDirectory(this.root);
   const result=await work();
   release=result?.state!=='SUBMITTED'&&result?.state!=='UNCERTAIN'&&result?.state!=='BLOCKED_UNCERTAIN';
   return result;
  }finally{
   await fd.close();
   if(release){const current=await fs.lstat(this.file);
    if(!current.isFile()||current.isSymbolicLink()||current.ino!==created.ino||current.dev!==created.dev||
     (process.platform!=='win32'&&(current.mode&0o077)))throw bad('M3_EXCLUSION_LOCK_REPLACED');
    await fs.unlink(this.file);await syncDirectory(this.root);
   }
  }
 }
}

// Private object-identity attestation for a lifecycle transaction holding the
// logical exclusion lock. A caller cannot forge this by supplying a scope,
// operation ID or serialized token in an HTTP request.
const lifecycleHolders=new WeakMap();
/** Internal orchestration primitive: one physical lifecycle transaction owns
 * the logical lock until all journal transitions and readbacks finish.
 * A thrown/UNCERTAIN transaction retains the physical lock for adjudication.
 */
export async function withM3LifecycleExclusion(ctx,{backend='qdrant',logicalKey,operationId}={},work){
 if(typeof work!=='function'||!UUID.test(operationId??''))throw bad('M3_LIFECYCLE_WORK_INVALID');
 const exclusion=new M3LogicalExclusion(ctx,{backend,logicalKey});
 const result=await exclusion.withExclusion({operationId},async()=>{
  const holder=Object.freeze(Object.create(null));
  lifecycleHolders.set(holder,Object.freeze({ctx,backend,logicalKey,operationId}));
  try{return await work(holder);}finally{lifecycleHolders.delete(holder);}
 });
 return result;
}
export function assertM3LifecycleHolder(holder,ctx,backend,logicalKey){
 const record=holder&&typeof holder==='object'?lifecycleHolders.get(holder):null;
 if(!record||record.ctx!==ctx||record.backend!==backend||record.logicalKey!==logicalKey)
  throw bad('M3_LIFECYCLE_HOLDER_REQUIRED');
 return record;
}

/** Evidence-approved transfer of two retained M3 staging locks. Both old lock
 * paths remain occupied throughout: the exact old files are copied into a
 * forensic case and rewritten in place to the NEW one-use operation UUID.
 * This must be called only after independent physical-prefix proof and a
 * server-private administrator approval. No browser may supply lock paths.
 * A partial transfer or failed dispatch retains all locks and the admin fence.
 */
export async function withM3AdoptedStageLocks(ctx,{oldOperationId,newOperationId,keys,caseRoot,reviewId}={},work){
 if(process.platform==='win32'||!UUID.test(oldOperationId??'')||!UUID.test(newOperationId??'')||
  oldOperationId===newOperationId||!UUID.test(reviewId??'')||!Array.isArray(keys)||keys.length!==2||
  !keys.every(k=>KEY.test(k))||keys[0]===keys[1]||!path.isAbsolute(caseRoot??'')||typeof work!=='function')
  throw bad('M3_STAGE_TRANSFER_REQUEST_INVALID');
 const exclusions=keys.map(logicalKey=>new M3LogicalExclusion(ctx,{backend:'qdrant',logicalKey}));
 await Promise.all(exclusions.map(x=>x.setup()));
 const st=await fs.lstat(caseRoot);if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077))
  throw bad('M3_STAGE_TRANSFER_CASE_ROOT_UNTRUSTED');
 const guard=path.join(exclusions[0].root,'.stage-handoff.lock');let fence;
 try{fence=await fs.open(guard,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw bad('M3_STAGE_TRANSFER_BUSY');throw e;}
 let intent=false,complete=false;
 try{
  await fence.writeFile(JSON.stringify({oldOperationId,newOperationId,reviewId})+'\n');await fence.sync();await syncDirectory(exclusions[0].root);
  const original=[];
  for(const x of exclusions){
   const info=await fs.lstat(x.file);
   if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||(info.mode&0o077))throw bad('M3_STAGE_TRANSFER_LOCK_UNTRUSTED');
   const content=await fs.readFile(x.file,'utf8');let record;
   try{record=JSON.parse(content);}catch{throw bad('M3_STAGE_TRANSFER_LOCK_CORRUPT');}
   if(record.schemaVersion!==1||record.backend!=='qdrant'||record.logicalKey!==x.logicalKey||
    record.ownerHash!==digest(ctx.userScopeId)||record.operationId!==oldOperationId||
    !Number.isSafeInteger(record.pid)||record.pid<=0)throw bad('M3_STAGE_TRANSFER_LOCK_MISMATCH');
   if(record.pid===process.pid)throw bad('M3_STAGE_TRANSFER_ORIGINAL_STILL_RUNNING');
   try{process.kill(record.pid,0);throw bad('M3_STAGE_TRANSFER_ORIGINAL_STILL_RUNNING');}
   catch(e){if(e.code!=='ESRCH')throw bad('M3_STAGE_TRANSFER_PROCESS_UNVERIFIABLE');}
   original.push({x,info,record,content});
  }
  const caseDir=path.join(caseRoot,reviewId);await fs.mkdir(caseDir,{mode:0o700});await syncDirectory(caseRoot);
  const meta={schemaVersion:1,oldOperationId,newOperationId,reviewId,originalKeys:keys,createdAt:Date.now()};
  const mh=await fs.open(path.join(caseDir,'transfer-intent.json'),'wx',0o600);
  try{await mh.writeFile(JSON.stringify(meta)+'\n');await mh.sync();}finally{await mh.close();}await syncDirectory(caseDir);intent=true;
  for(let i=0;i<original.length;i++){
   const {x,info,record,content}=original[i];
   const forensic=await fs.open(path.join(caseDir,`previous-lock-${i}.json`),'wx',0o600);
   try{await forensic.writeFile(content);await forensic.sync();}finally{await forensic.close();}
   const current=await fs.lstat(x.file);
   if(current.ino!==info.ino||current.dev!==info.dev||current.size!==info.size)
    throw bad('M3_STAGE_TRANSFER_LOCK_CHANGED');
   const fd=await fs.open(x.file,'r+');try{
    const next={...record,operationId:newOperationId,pid:process.pid};
    await fd.truncate(0);await fd.writeFile(JSON.stringify(next)+'\n');await fd.sync();
   }finally{await fd.close();}
   await syncDirectory(x.root);
  }
  await syncDirectory(caseDir);
  const holders=exclusions.map(x=>{const holder=Object.freeze(Object.create(null));
   lifecycleHolders.set(holder,Object.freeze({ctx,backend:'qdrant',logicalKey:x.logicalKey,operationId:newOperationId}));return holder;});
  let result;
  try{result=await work(holders[0],holders[1]);}
  finally{holders.forEach(x=>lifecycleHolders.delete(x));}
  // Any exception intentionally retains newly claimed locks and the guard.
  if(result?.state!=='VERIFIED_STAGED')throw bad('M3_STAGE_TRANSFER_NOT_COMMITTED');
  for(const x of exclusions){const stored=await fs.lstat(x.file);
   const data=JSON.parse(await fs.readFile(x.file,'utf8'));
   if(!stored.isFile()||stored.isSymbolicLink()||data.operationId!==newOperationId||data.pid!==process.pid)
    throw bad('M3_STAGE_TRANSFER_NEW_LOCK_CHANGED');
   await fs.unlink(x.file);await syncDirectory(x.root);
  }
  const end=await fs.open(path.join(caseDir,'transfer-result.json'),'wx',0o600);
  try{await end.writeFile(JSON.stringify({newOperationId,disposition:'VERIFIED_STAGE_CONTINUED',oldOperationId})+'\n');await end.sync();}
  finally{await end.close();}await syncDirectory(caseDir);
  complete=true;return result;
 }finally{
  await fence.close();if(!intent||complete){await fs.unlink(guard);await syncDirectory(exclusions[0].root);}
 }
}
