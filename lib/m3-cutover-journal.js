/** M3 server-only, append-only collection cutover journal.
 * An alias is NOT a browser-supplied collection name. This control plane cannot
 * grant mutation rights: readers must also verify a matching F03 schema/receipt
 * and the writer gateway must certify the resolved physical target.
 * Interrupted prepare/publish never falls back to the canonical collection.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {collectionIdentity} from './s02-identity.js';
import {markM3ResolvedBinding,assertM3VersionedBinding} from './m3-versioned-binding.js';
import {M3LogicalExclusion,assertM3LifecycleHolder} from './m3-logical-exclusion.js';

const KEY=/^[a-f0-9]{64}$/;
const PHYSICAL=/^vh2_[a-f0-9]{48}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=(code)=>Object.assign(new Error(code),{code,status:409});
const SAFE_PRE_APPEND=Symbol('M3_SAFE_PRE_APPEND_REFUSAL');
async function priv(p){const s=await fs.lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||(process.platform!=='win32'&&(s.mode&0o077)))throw fail('M3_JOURNAL_DIRECTORY_UNTRUSTED');}
async function flush(p){const f=await fs.open(p,'r');try{await f.sync();}finally{await f.close();}}
/** All transitions require preverified host-owned source & matching backend. */
export class M3CutoverJournal {
 constructor(ctx,{backend='qdrant',logicalKey}={}){
  if(!ctx?.userScopeId||!path.isAbsolute(ctx.vectorsPath??'')||!['qdrant','lancedb','vectra','milvus'].includes(backend)||!KEY.test(logicalKey??''))throw fail('M3_JOURNAL_SCOPE_INVALID');
  this.ctx=ctx;this.backend=backend;this.logicalKey=logicalKey;
  this.root=path.join(ctx.vectorsPath,'.similharity','m3-cutovers');
  this.dir=backend==='qdrant'?path.join(this.root,logicalKey):path.join(this.root,backend,logicalKey);
 }
 async setup(){await priv(this.ctx.vectorsPath);const parent=path.join(this.ctx.vectorsPath,'.similharity');
  for(const p of [parent,this.root,...(this.backend==='qdrant'?[]:[path.join(this.root,this.backend)]),this.dir]){await fs.mkdir(p,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});await priv(p);}}
 async events({allowLocked=false}={}){await this.setup();const names=await fs.readdir(this.dir);
  if(!allowLocked&&names.includes('transition.lock'))throw fail('M3_JOURNAL_TRANSITION_REVIEW_REQUIRED');const list=names.filter(n=>/^\d{8}\.json$/.test(n)).sort();
  if(names.some(n=>n!=='transition.lock'&&!/^\d{8}\.json$/.test(n)))throw fail('M3_JOURNAL_UNEXPECTED_ENTRY');
  if(list.length>1000)throw fail('M3_JOURNAL_LIMIT');
  const events=[];let prev='GENESIS';
  for(let i=0;i<list.length;i++){
   if(list[i]!==String(i+1).padStart(8,'0')+'.json')throw fail('M3_JOURNAL_GAP');
   const filename=path.join(this.dir,list[i]),s=await fs.lstat(filename);
   if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>8192||(process.platform!=='win32'&&(s.mode&0o077)))throw fail('M3_JOURNAL_ENTRY_UNTRUSTED');
   let record;try{record=JSON.parse(await fs.readFile(filename,'utf8'));}catch{throw fail('M3_JOURNAL_CORRUPT');}
   const {seal,...entry}=record;
   if(seal!==digest(entry)||entry.owner!==this.ctx.userScopeId||entry.backend!==this.backend||entry.logicalKey!==this.logicalKey||
      entry.sequence!==i+1||entry.previous!==prev||!['PREPARED','PUBLISHED','ABORTED'].includes(entry.state)||
      !PHYSICAL.test(entry.from??'')||!PHYSICAL.test(entry.to??'')||!UUID.test(entry.operationId??''))throw fail('M3_JOURNAL_CORRUPT');
   if(entry.state==='PREPARED'&&entry.from===entry.to)throw fail('M3_JOURNAL_INVALID_TARGET');
   if(i>0){const prior=events[i-1];if(prior.state==='PREPARED' &&
       (entry.state==='PREPARED'||entry.operationId!==prior.operationId||entry.from!==prior.from||entry.to!==prior.to))throw fail('M3_JOURNAL_BAD_TRANSITION');
     if(prior.state!=='PREPARED'&&entry.state!=='PREPARED')throw fail('M3_JOURNAL_BAD_TRANSITION');}
   prev=digest(entry);events.push(entry);
  }
  return events;
 }
 async resolve(binding,{allowLocked=false}={}){
  const computed=collectionIdentity({backend:this.backend,scope:binding?.scope,embedding:binding?.embedding});
  if(computed.key!==this.logicalKey||binding?.collection?.key!==this.logicalKey||binding?.collection?.physicalName!==computed.physicalName||
     binding?.scope?.userScopeId!==this.ctx.userScopeId)throw fail('M3_JOURNAL_BINDING_MISMATCH');
  const events=await this.events({allowLocked});let physicalName=computed.physicalName,generation=0;
  for(const e of events){if(e.state==='PREPARED')continue;
   if(e.state==='PUBLISHED'){if(e.from!==physicalName)throw fail('M3_JOURNAL_HISTORY_CONFLICT');physicalName=e.to;generation++;}
  }
  if(events.at(-1)?.state==='PREPARED')throw fail('M3_JOURNAL_TRANSITION_REVIEW_REQUIRED');
  return Object.freeze({logicalKey:this.logicalKey,physicalName,generation,
   canonicalName:computed.physicalName,pending:false,fromServerJournal:true});
 }
 /** Internal only: creating a routed binding requires a VERIFIED target-specific
  * provisioning receipt and fresh backend schema checks, not merely PUBLISHED.
  * M1 record writes have generation fencing; lifecycle collection writes
  * remain publicly blocked. This method itself cannot dispatch a write.
  */
 async resolveVersioned(binding,{verifyTarget}={}){
  const active=await this.resolve(binding);
  if(active.generation>0){
   if(typeof verifyTarget!=='function')throw fail('M3_TARGET_VERIFIER_REQUIRED');
   const evidence=await verifyTarget(active,binding);
   if(evidence?.verified!==true||evidence?.receiptVerified!==true||
      evidence?.schemaVerified!==true||evidence?.physicalName!==active.physicalName||
      evidence?.generation!==active.generation||evidence?.logicalKey!==active.logicalKey)
      throw fail('M3_TARGET_PROOF_INCOMPLETE');
  }
  return markM3ResolvedBinding(binding,active);
 }
 /** Fences a previously server-resolved alias before any physical dispatch. */
 async assertCurrentVersioned(binding,canonical){
  const recorded=assertM3VersionedBinding(binding);
  const active=await this.resolve(canonical);
  if(recorded.name!==active.physicalName||recorded.generation!==active.generation||
     recorded.key!==active.logicalKey)throw fail('M3_STALE_BINDING_GENERATION');
  return true;
 }
 async assertNoRetainedPhysicalLocks(names){
  // A previously-installed writer may have retained a physical F09c.10 lock
  // without the newer logical lock. Never cut over past that unresolved write.
  const root=path.join(this.ctx.vectorsPath,'.similharity','f09c10-writer-locks');
  let st;try{st=await fs.lstat(root);}catch(e){if(e.code==='ENOENT')return true;throw e;}
  if(!st.isDirectory()||st.isSymbolicLink()||(process.platform!=='win32'&&(st.mode&0o077)))
   throw fail('M3_PHYSICAL_LOCK_ROOT_UNTRUSTED');
  for(const name of names){
   if(!PHYSICAL.test(name))throw fail('M3_PHYSICAL_LOCK_TARGET_INVALID');
   const filename=path.join(root,'collection-'+digest([this.backend,name])+'.lock');
   try{await fs.lstat(filename);throw fail('M3_PHYSICAL_WRITER_LOCK_RETAINED');}
   catch(e){if(e.code!=='ENOENT')throw e;}
  }
  return true;
 }
 async lock(work,{holder=null}={}){
  if(holder!==null){
   assertM3LifecycleHolder(holder,this.ctx,this.backend,this.logicalKey);
   return this.localLock(work);
  }
  const logical=new M3LogicalExclusion(this.ctx,{backend:this.backend,logicalKey:this.logicalKey});
  const result=await logical.withExclusion({},async()=>{
   try{return await this.localLock(work);}catch(e){
    // An internal pre-append rejection cannot have changed the journal.
    if(e?.[SAFE_PRE_APPEND]===true)return {state:'FAILED',refusal:e};
    throw e;
   }
  });
  if(result?.state==='FAILED'&&result.refusal)throw result.refusal;
  return result;
 }
 async localLock(work){await this.setup();const filename=path.join(this.dir,'transition.lock');let f;
  try{f=await fs.open(filename,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw fail('M3_JOURNAL_LOCKED');throw e;}
  let finished=false,appendStarted=false;try{await f.writeFile(JSON.stringify({owner:this.ctx.userScopeId,logicalKey:this.logicalKey,pid:process.pid}));await f.sync();await flush(this.dir);
   const result=await work({beforeAppend:()=>{appendStarted=true;}});finished=true;return result;
  }catch(e){if(!appendStarted){finished=true;e[SAFE_PRE_APPEND]=true;}throw e;}finally{await f.close();if(finished){await fs.unlink(filename);await flush(this.dir);}}
 }
 async append(entry,prior){const e={sequence:prior.length+1,previous:prior.length?digest(prior.at(-1)):'GENESIS',
   owner:this.ctx.userScopeId,backend:this.backend,logicalKey:this.logicalKey,at:new Date().toISOString(),...entry};
  const filename=path.join(this.dir,String(e.sequence).padStart(8,'0')+'.json');
  const f=await fs.open(filename,'wx',0o600);try{await f.writeFile(JSON.stringify({...e,seal:digest(e)})+'\n');await f.sync();}finally{await f.close();}
  await flush(this.dir);return e;
 }
 /** Prepare requires target inventory/schema and owner evidence from a trusted caller.
  * Neither PREPARED nor PUBLISHED calls Qdrant or releases a physical lock.
  */
 async prepare(binding,{operationId,targetPhysicalName,backupDigest,proof,holder=null}={}){
  if(!UUID.test(operationId??'')||!PHYSICAL.test(targetPhysicalName??'')||!KEY.test(backupDigest??'')||
    proof?.verified!==true||proof?.exclusiveOwner!==true||proof?.schemaVerified!==true||
    proof?.inventoryVerified!==true||proof?.physicalName!==targetPhysicalName||proof?.logicalKey!==this.logicalKey)
    throw fail('M3_CUTOVER_EVIDENCE_REQUIRED');
  return this.lock(async({beforeAppend})=>{const old=await this.resolve(binding,{allowLocked:true}),prior=await this.events({allowLocked:true});
   await this.assertNoRetainedPhysicalLocks([old.physicalName,targetPhysicalName]);
   if(targetPhysicalName===old.physicalName)throw fail('M3_CUTOVER_SAME_TARGET');
   beforeAppend();const e=await this.append({state:'PREPARED',operationId,from:old.physicalName,to:targetPhysicalName,backupDigest,
    targetEvidenceDigest:digest(proof)},prior);return {operationId,state:e.state,from:e.from,to:e.to};},{holder});
 }
 /** A publish requires a fresh authoritative verification, independently from
  * the earlier plan. Once written, readers can select the new target only after
  * the rest of the versioned binding contract has been deployed/certified.
  */
 async publish(binding,{operationId,proof,holder=null}={}){
  if(proof?.verified!==true||proof?.exclusiveOwner!==true||proof?.schemaVerified!==true||proof?.inventoryVerified!==true)
   throw fail('M3_CUTOVER_EVIDENCE_REQUIRED');
  return this.lock(async({beforeAppend})=>{const events=await this.events({allowLocked:true}),p=events.at(-1);
   if(p?.state==='PREPARED')await this.assertNoRetainedPhysicalLocks([p.from,p.to]);
   if(p?.state!=='PREPARED'||p.operationId!==operationId||p.targetEvidenceDigest!==digest(proof)||
      p.to!==proof.physicalName||proof.logicalKey!==this.logicalKey)throw fail('M3_CUTOVER_NOT_PREPARED');
   const canonical=collectionIdentity({backend:this.backend,scope:binding.scope,embedding:binding.embedding});
   if(binding.collection.key!==this.logicalKey||binding.scope.userScopeId!==this.ctx.userScopeId||canonical.key!==this.logicalKey)
    throw fail('M3_CUTOVER_SCOPE_CHANGED');
   beforeAppend();const e=await this.append({state:'PUBLISHED',operationId,from:p.from,to:p.to,backupDigest:p.backupDigest,
    targetEvidenceDigest:p.targetEvidenceDigest},events);
   return {state:e.state,generation:events.filter(x=>x.state==='PUBLISHED').length+1,physicalName:e.to};
  },{holder});
 }
 /** Abort means no database write has been dispatched by THIS journal; it may
  * not be used to dismiss an ambiguous restore/write. Proof must be external. */
 async abort({operationId,dispatchNeverStarted=false}={}){
  if(dispatchNeverStarted!==true)throw fail('M3_ABORT_REQUIRES_NO_DISPATCH_PROOF');
  return this.lock(async({beforeAppend})=>{const events=await this.events({allowLocked:true}),p=events.at(-1);
   if(p?.state==='PREPARED')await this.assertNoRetainedPhysicalLocks([p.from,p.to]);
   if(p?.state!=='PREPARED'||p.operationId!==operationId)throw fail('M3_CUTOVER_NOT_PREPARED');
   beforeAppend();return this.append({state:'ABORTED',operationId,from:p.from,to:p.to,backupDigest:p.backupDigest,
    targetEvidenceDigest:p.targetEvidenceDigest},events);
  });
 }
}

/** Public read-side guard. Absence of journal means legacy canonical identity;
 * presence of unresolved or switched alias fails closed until all consumers
 * (S04/S05/F03/M1) share the same versioned binding contract. */
export async function guardM3CanonicalBinding(ctx,binding){
 if(!['qdrant','lancedb','vectra','milvus'].includes(binding?.backend))return binding;
 const j=new M3CutoverJournal(ctx,{backend:binding.backend,logicalKey:binding.collection.key});
 try{await fs.lstat(j.dir);}catch(e){if(e.code==='ENOENT')return binding;throw e;}
 const resolved=await j.resolve(binding);
 // Even a rollback to the canonical physical name advances the routing
 // generation. Legacy plans without a generation fence must stay blocked.
 if(resolved.generation!==0||resolved.physicalName!==binding.collection.physicalName)throw fail('M3_ALIAS_GATEWAY_INTEGRATION_REQUIRED');
 return binding;
}
