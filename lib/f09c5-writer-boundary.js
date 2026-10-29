/** F09c.5: cooperative, same-host writer gate for a trusted physical collection.
 * An exclusive filesystem lock serializes ONLY cooperating writers sharing this
 * lock directory. It does not enforce DB permissions, block direct network
 * writes, certify atomicity or authorize production. No stale lock auto-steal.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {OperationError} from './s04-contract.js';
const sha=value=>createHash('sha256').update(value).digest('hex');
const NAME=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BACKENDS=new Set(['qdrant','lancedb','milvus','standard','vectra']);
const fail=(code,message)=>new OperationError(code,message);
async function syncDirectory(location){const handle=await fs.open(location,'r');try{await handle.sync();}finally{await handle.close();}}
async function privateDirectory(location){
 const st=await fs.lstat(location);
 if(!st.isDirectory()||st.isSymbolicLink()||(process.platform!=='win32'&&(st.mode&0o077)))
  throw fail('F09C5_UNTRUSTED_DIRECTORY','Writer gate directory must be private and nonsymlinked');
}
/** Trusted host constructs this; never use client-supplied backend/physicalName. */
export class CooperativeWriterBoundary {
 constructor({root,backend,physicalName}) {
  if(typeof root!=='string'||!path.isAbsolute(root)||!BACKENDS.has(backend)||typeof physicalName!=='string'||!NAME.test(physicalName))
   throw fail('F09C5_BINDING_INVALID','Absolute host lock root and validated physical collection binding required');
  this.root=path.resolve(root);this.backend=backend;this.physicalName=physicalName;
  this.key=sha(JSON.stringify([backend,physicalName]));
  Object.freeze(this);
 }
 async setup(){
  // Parent must already be provisioned and private by the administrator; do
  // not implicitly create or follow a symlink supplied by an untrusted user.
  await privateDirectory(path.dirname(this.root));
  try {await fs.mkdir(this.root,{mode:0o700});} catch(e){if(e.code!=='EEXIST')throw e;}
  await privateDirectory(this.root);
 }
 async withWriteBoundary(plan,work){
  if(typeof work!=='function'||plan?.backend!==this.backend||plan?.physicalCollectionName!==this.physicalName||
    !/^[a-f0-9]{64}$/.test(plan?.collectionKey||''))
   throw fail('F09C5_SCOPE_MISMATCH','The requested plan does not match the trusted collection boundary');
  await this.setup();
  const lock=path.join(this.root,'collection-'+this.key+'.lock');
  // O_EXCL is atomic across cooperating processes on a filesystem that
  // implements it. No PID takeover, time-based expiry or hidden retry.
  let fd;
  try{fd=await fs.open(lock,'wx',0o600);}catch(e){
   if(e.code==='EEXIST')throw fail('F09C5_WRITER_BUSY','Another cooperating writer holds the collection');
   throw e;
  }
  const heldStat=await fd.stat();
  let complete=false;
  try{
   await fd.writeFile(JSON.stringify({schemaVersion:1,backend:this.backend,
     physicalNameHash:sha(this.physicalName),pid:process.pid,
     // Optional binding: older/diagnostic locks without this cannot be administratively released.
     operationId:UUID.test(plan.operationId||'')?plan.operationId.toLowerCase():null,
     collectionKey:plan.collectionKey,
     ownerHash:typeof plan.scope?.userScopeId==='string'?sha(plan.scope.userScopeId):null})+'\n');
   await fd.sync();
   await syncDirectory(this.root); // persist lock directory entry before dispatch
   const result=await work();complete=result?.state!=='UNCERTAIN' && result?.state!=='SUBMITTED';return result;
  }finally{
   try{await fd.close();}catch{}
   // When work throws *after* dispatch, preserve the lock. The operator must
   // investigate uncertain mutation state rather than allowing a new writer.
   if(complete){
    // Never unlink someone else's replacement lock if the lock path changes.
    const stat=await fs.lstat(lock);
    if(stat.isSymbolicLink()||!stat.isFile()||stat.ino!==heldStat.ino||stat.dev!==heldStat.dev||
       (process.platform!=='win32'&&(stat.mode&0o077)))
      throw fail('F09C5_LOCK_REPLACED','Unexpected lock entry after dispatch');
    await fs.unlink(lock);await syncDirectory(this.root);
   }
  }
 }
}
/** Reports restrictions only. It deliberately cannot issue a permission or
 * create a deployment attestation, even if every checkbox is asserted. */
export function assessWriterBoundary({networkWriteIsolation=false,localWriteIsolation=false,
 credentialExclusivity=false,legacyRoutesMediated=false,crashRecoveryVerified=false,
 realHostRacesVerified=false}={}) {
 const claims={networkWriteIsolation,localWriteIsolation,credentialExclusivity,
   legacyRoutesMediated,crashRecoveryVerified,realHostRacesVerified};
 return Object.freeze({claims:Object.freeze(claims),cooperatingProcessSerialization:'LOCAL_FILESYSTEM_CANDIDATE',
  externalWritersBlocked:false,productionPermission:false,certified:false,
  requiredIndependentEvidence:Object.keys(claims).filter(k=>claims[k]!==true)});
}
