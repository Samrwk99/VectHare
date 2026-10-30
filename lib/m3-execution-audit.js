/** M3g durable lifecycle event trail for server-internal transactions.
 * Records never grant permission to dispatch, clear a retained lock, or mark
 * acceptance. The independent M3 O_EXCL claim is still the replay boundary.
 * A missing event after claim is an ambiguous crash boundary, NOT no-op proof.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assertM3LifecycleHolder} from './m3-logical-exclusion.js';
import {M3Store} from './m3-collections.js';
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const KEY=/^[a-f0-9]{64}$/;
const error=code=>Object.assign(new Error(code),{code,status:409});
const sequences={
 restore:['CLAIMED','DISPATCH_PENDING','PHYSICAL_VERIFIED','JOURNAL_PUBLISHED','COMMITTED'],
 rollback:['CLAIMED','DISPATCH_PENDING','PHYSICAL_VERIFIED','JOURNAL_PUBLISHED','COMMITTED'],
 delete:['CLAIMED','DISPATCH_PENDING','PHYSICAL_VERIFIED','COMMITTED'],
 empty:['CLAIMED','DISPATCH_PENDING','PHYSICAL_VERIFIED','JOURNAL_PUBLISHED','COMMITTED'],
 rebuild:['CLAIMED','DISPATCH_PENDING','PHYSICAL_VERIFIED','COMMITTED'],
 'activate-rebuild':['CLAIMED','DISPATCH_PENDING','PHYSICAL_VERIFIED','JOURNAL_PUBLISHED','COMMITTED'],
};
async function privateDirectory(dir){const st=await fs.lstat(dir);
 if(!st.isDirectory()||st.isSymbolicLink()||(process.platform!=='win32'&&(st.mode&0o077)))throw error('M3_AUDIT_DIRECTORY_UNTRUSTED');}
async function flushDir(dir){const fd=await fs.open(dir,'r');try{await fd.sync();}finally{await fd.close();}}
export class M3ExecutionAudit {
 constructor(ctx,{operationId,logicalKey,action,backend='qdrant'}={}){
  if(!ctx?.userScopeId||!path.isAbsolute(ctx.vectorsPath??'')||!UUID.test(operationId??'')||
     !KEY.test(logicalKey??'')||!['qdrant','lancedb','vectra','milvus'].includes(backend)||!Object.hasOwn(sequences,action))throw error('M3_AUDIT_SCOPE_INVALID');
  this.ctx=ctx;this.operationId=operationId;this.logicalKey=logicalKey;this.action=action;this.backend=backend;
  this.parent=path.join(ctx.vectorsPath,'.similharity');
  this.root=path.join(this.parent,'m3-execution-audit');
  this.dir=path.join(this.root,operationId);
 }
 async setup(){await privateDirectory(this.ctx.vectorsPath);
  for(const d of [this.parent,this.root,this.dir]){
   await fs.mkdir(d,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});await privateDirectory(d);
  }
 }
 async events(){await this.setup();const names=await fs.readdir(this.dir);
  if(names.some(n=>!/^\d{5}\.json$/.test(n))||names.length>16)throw error('M3_AUDIT_UNEXPECTED_ENTRY');
  const ordered=names.sort(),out=[];let prev='GENESIS';
  for(let i=0;i<ordered.length;i++){
   if(ordered[i]!==String(i+1).padStart(5,'0')+'.json')throw error('M3_AUDIT_GAP');
   const filepath=path.join(this.dir,ordered[i]),st=await fs.lstat(filepath);
   if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>4096||
      (process.platform!=='win32'&&(st.mode&0o077)))throw error('M3_AUDIT_ENTRY_UNTRUSTED');
   let stored;try{stored=JSON.parse(await fs.readFile(filepath,'utf8'));}catch{throw error('M3_AUDIT_CORRUPT');}
   const {seal,...ev}=stored;
   if(seal!==sha(ev)||ev.schemaVersion!==1||ev.owner!==this.ctx.userScopeId||
      ev.operationId!==this.operationId||ev.logicalKey!==this.logicalKey||ev.action!==this.action||
      (ev.backend??'qdrant')!==this.backend||
      ev.sequence!==i+1||ev.previous!==prev||ev.stage!==sequences[this.action][i]||
      !Number.isSafeInteger(ev.at)||ev.at<0||
      (ev.detailDigest!==null&&!KEY.test(ev.detailDigest??'')))throw error('M3_AUDIT_CORRUPT');
   prev=sha(ev);out.push(ev);
  }
  return out;
 }
 /** The holder is a private non-serializable object minted *only* under
  * withM3LifecycleExclusion. This API is never exposed to HTTP. */
 async checkpoint(holder,stage,{detail=null}={}){
  assertM3LifecycleHolder(holder,this.ctx,this.backend,this.logicalKey);
  const current=await this.events(),index=current.length;
  if(sequences[this.action][index]!==stage)throw error('M3_AUDIT_INVALID_STAGE');
  if(index===0){ // A durable one-use claim must precede audit creation.
   const claim=path.join(this.parent,'m3-lifecycle',`claimed-${this.operationId}.json`);
   let st;try{st=await fs.lstat(claim);}catch{throw error('M3_AUDIT_CLAIM_REQUIRED');}
   if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)throw error('M3_AUDIT_CLAIM_UNTRUSTED');
  }
  const ev={schemaVersion:1,owner:this.ctx.userScopeId,operationId:this.operationId,
   logicalKey:this.logicalKey,action:this.action,backend:this.backend,sequence:index+1,stage,previous:index?sha(current.at(-1)):'GENESIS',
   detailDigest:detail===null?null:sha(detail),at:Date.now()};
  const name=String(index+1).padStart(5,'0')+'.json',fd=await fs.open(path.join(this.dir,name),'wx',0o600);
  try{await fd.writeFile(JSON.stringify({...ev,seal:sha(ev)})+'\n');await fd.sync();}finally{await fd.close();}
  await flushDir(this.dir);return ev;
 }
}
/** Read-only investigation. A claimed operation with no events remains
 * REVIEW_REQUIRED. A terminal audit never by itself releases a physical lock;
 * ledger, registry, physical inventory and live process must be examined. */
export async function inspectM3LifecycleRecovery(ctx,operationId,{store=null}={}){
 if(!UUID.test(operationId??''))throw error('M3_AUDIT_OPERATION_INVALID');
 const db=store??new M3Store(ctx),ticket=await db.read('operation',operationId);
 if(ticket.owner!==ctx.userScopeId||!KEY.test(ticket.logicalKey??'')||!Object.hasOwn(sequences,ticket.action))
  throw error('M3_AUDIT_TICKET_UNTRUSTED');
 const audit=new M3ExecutionAudit(ctx,{operationId,logicalKey:ticket.logicalKey,action:ticket.action,backend:ticket.backend??'qdrant'});
 const ev=await audit.events();
 const claim=path.join(db.root,`claimed-${operationId}.json`);
 let isClaimed=false;try{const st=await fs.lstat(claim);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)
  throw error('M3_AUDIT_CLAIM_UNTRUSTED');const saved=JSON.parse(await fs.readFile(claim,'utf8'));
  if(saved.owner!==ctx.userScopeId||saved.operationId!==operationId||saved.checksum!==sha(ticket))throw error('M3_AUDIT_CLAIM_CORRUPT');
  isClaimed=true;
 }catch(e){if(e.code!=='ENOENT')throw e;}
 if(!isClaimed&&ev.length)throw error('M3_AUDIT_ORPHANED_EVENTS');
 const last=ev.at(-1)?.stage??null;
 return Object.freeze({operationId,action:ticket.action,logicalKey:ticket.logicalKey,
  claimed:isClaimed,lastStage:last,eventCount:ev.length,
  classification:isClaimed?'REVIEW_REQUIRED':'NOT_DISPATCHED_BY_THIS_CLAIM',
  physicalLockReleaseAuthorized:false,automaticReplayAuthorized:false,
  evidenceComplete:ev.length===sequences[ticket.action].length});
}
