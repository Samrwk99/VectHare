/** F09b.4 completion: durable, per-user, source-bound managed-record registry.
 * This is evidence only for records managed by the v2 pilot. It never scans
 * physical collections and cannot assert completeness for legacy vectors.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const digest=x=>createHash('sha256').update(x).digest('hex');
const BAD=/^[a-f0-9]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const err=(code)=>Object.assign(new Error(code),{code,status:409});
const privateDir=async p=>{
 const st=await fs.lstat(p);
 if(!st.isDirectory()||st.isSymbolicLink()||(process.platform!=='win32'&&(st.mode&0o077)))throw err('F09B4_REGISTRY_UNTRUSTED');
};
const syncDir=async p=>{const fd=await fs.open(p,'r');try{await fd.sync();}finally{await fd.close();}};
export class ManagedChatRegistry {
 constructor(ctx,binding){
  if(!ctx?.vectorsPath||!path.isAbsolute(ctx.vectorsPath)||!ctx.userScopeId||
     !BAD.test(binding?.collection?.key||'')||binding.scope?.userScopeId!==ctx.userScopeId||
     typeof binding.scope?.sourceId!=='string')throw err('F09B4_REGISTRY_SCOPE_INVALID');
  this.ctx=ctx;this.binding=binding;
  this.root=path.join(ctx.vectorsPath,'.similharity','f09b4-managed');
  this.file=path.join(this.root,binding.collection.key+'.json');
 }
 async setup(){
  await privateDir(this.ctx.vectorsPath);
  const parent=path.dirname(this.root);
  for(const p of [parent,this.root]){
   try{await fs.mkdir(p,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
   await privateDir(p);
  }
 }
 empty(){return {schemaVersion:1,owner:this.ctx.userScopeId,
  sourceId:this.binding.scope.sourceId,collectionKey:this.binding.collection.key,records:{}};}
 async read(){
  await this.setup();let raw;
  try{const st=await fs.lstat(this.file);
   if(!st.isFile()||st.isSymbolicLink()||st.nlink>1||(process.platform!=='win32'&&(st.mode&0o077))||st.size>16*1024*1024)throw err('F09B4_REGISTRY_UNTRUSTED');
   raw=await fs.readFile(this.file,'utf8');
  }catch(e){if(e.code==='ENOENT')return {...this.empty(),fingerprint:digest(JSON.stringify(this.empty()))};throw e;}
  let doc;try{doc=JSON.parse(raw);}catch{throw err('F09B4_REGISTRY_CORRUPT');}
  const {checksum,...data}=doc;
  if(checksum!==digest(JSON.stringify(data))||data.schemaVersion!==1||data.owner!==this.ctx.userScopeId||
    data.sourceId!==this.binding.scope.sourceId||data.collectionKey!==this.binding.collection.key||
    !data.records||typeof data.records!=='object'||Array.isArray(data.records)||
    Object.entries(data.records).some(([id,v])=>!UUID.test(id)||!v||v.recordId!==id||
      !['ACTIVE','WRITE_PENDING','DELETE_PENDING','DELETED'].includes(v.state)||
      !BAD.test(v.contentHash||'')||!Number.isSafeInteger(v.revision)||v.revision<0||
      (v.operationId!==null&&!UUID.test(v.operationId||''))))throw err('F09B4_REGISTRY_CORRUPT');
  return {...data,fingerprint:digest(JSON.stringify(data))};
 }
 async lock(fn){
  await this.setup();const directory=path.join(this.root,'.lock-'+this.binding.collection.key);
  try{await fs.mkdir(directory,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw err('F09B4_REGISTRY_BUSY');throw e;}
  try{return await fn();}finally{await fs.rmdir(directory);}
 }
 async save(doc){
  const {fingerprint,...data}=doc;
  if(Object.keys(data.records).length>20000)throw err('F09B4_REGISTRY_LIMIT');
  const serialized=JSON.stringify(data),bytes=Buffer.byteLength(serialized);
  if(bytes>16*1024*1024)throw err('F09B4_REGISTRY_LIMIT');
  const tmp=path.join(this.root,'.tmp-'+randomUUID());
  try{const fd=await fs.open(tmp,'wx',0o600);
   try{await fd.writeFile(JSON.stringify({...data,checksum:digest(serialized)})+'\n');await fd.sync();}finally{await fd.close();}
   await fs.rename(tmp,this.file);await syncDir(this.root);
  }finally{await fs.rm(tmp,{force:true});}
 }
 async begin({recordId,contentHash,revision,operationId,action,bootstrap=false,restore=false}){
  if(!UUID.test(recordId)||!BAD.test(contentHash)||!Number.isSafeInteger(revision)||revision<0||!UUID.test(operationId)||
   !['write','delete'].includes(action))throw err('F09B4_MANAGED_INTENT_INVALID');
  return this.lock(async()=>{
   const doc=await this.read(),existing=doc.records[recordId];
   if(existing&&existing.state!=='ACTIVE'&&!(restore&&action==='write'&&existing.state==='DELETED'))throw err('F09B4_MANAGED_INTENT_BLOCKED');
   if(existing&&(existing.revision!==revision||existing.contentHash!==contentHash))throw err('F09B4_MANAGED_RECORD_CHANGED');
   if(!existing&&!bootstrap&&revision!==0)throw err('F09B4_MANAGED_RECORD_UNTRACKED');
   doc.records[recordId]={recordId,contentHash,revision,operationId,
     state:action==='delete'?'DELETE_PENDING':'WRITE_PENDING'};
   await this.save(doc);return doc.records[recordId];
  });
 }
 async finish({recordId,operationId,action,contentHash,revision}){
  return this.lock(async()=>{
   const doc=await this.read(),entry=doc.records[recordId];
   if(!entry||entry.operationId!==operationId||
     entry.state!==(action==='delete'?'DELETE_PENDING':'WRITE_PENDING'))throw err('F09B4_MANAGED_INTENT_MISMATCH');
   doc.records[recordId]={recordId,operationId:null,contentHash,revision,
     state:action==='delete'?'DELETED':'ACTIVE'};
   await this.save(doc);return doc.records[recordId];
  });
 }
 /** Reconcile an already physically verified, source-current record with
  * the durable registry. This is a compare-and-set (no pending-state override),
  * never a physical insert, and cannot adopt a foreign record: callers must
  * first attest the V2 physical owner, selected embedding and content. */
 async reconcileVerified({recordId,expected,contentHash,revision}){
  if(!UUID.test(recordId)||!BAD.test(contentHash)||!Number.isSafeInteger(revision)||revision<1)
   throw err('F09B4_RECONCILE_INVALID');
  return this.lock(async()=>{
   const doc=await this.read(),current=doc.records[recordId]??null;
   if(JSON.stringify(current)!==JSON.stringify(expected??null))throw err('F09B4_RECONCILE_STALE');
   if(current&&!['ACTIVE','DELETED'].includes(current.state))throw err('F09B4_RECONCILE_PENDING');
   doc.records[recordId]={recordId,contentHash,revision,operationId:null,state:'ACTIVE'};
   await this.save(doc);
   return doc.records[recordId];
  });
 }
 async guard(recordId){const doc=await this.read();const entry=doc.records[recordId];
  if(entry&&entry.state!=='ACTIVE')throw err('F09B4_MANAGED_INTENT_BLOCKED');return entry??null;
 }
}
