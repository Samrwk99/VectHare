/** F10b.9: deliberately narrow offline administrator release for an abandoned
 * cooperating-writer lock whose *bound S04 operation* is durably terminal.
 * This NEVER resolves SUBMITTED, UNCERTAIN or PREPARED, never replays a write,
 * never edits a receipt/tombstone, and never claims backend authority.
 * Host quiescence remains an operator responsibility and requires acceptance.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants as C} from 'node:fs';
import {createHash} from 'node:crypto';
import {F10b4RecoveryInvestigation} from './f10b4-recovery-investigation.js';
const sha=v=>createHash('sha256').update(v).digest('hex');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX=/^[0-9a-f]{64}$/;
const MAGIC='F10B9_RELEASE_ONLY_TERMINAL_ABANDONED_LOCK_NO_REPLAY';
const deny=code=>{const err=new Error(code);err.code=code;throw err;};
async function privateDir(p){const st=await fs.lstat(p);if(!st.isDirectory()||st.isSymbolicLink()||
  (process.platform!=='win32'&&(st.mode&0o077)))deny('F10B9_UNTRUSTED_DIRECTORY');}
async function syncDir(p){if(process.platform==='win32')return;const h=await fs.open(p,'r');try{await h.sync();}finally{await h.close();}}
async function readLock(p){const before=await fs.lstat(p);
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>4096||
  (process.platform!=='win32'&&(before.mode&0o077)))deny('F10B9_UNTRUSTED_LOCK');
 const fd=await fs.open(p,C.O_RDONLY|(C.O_NOFOLLOW??0));try{const st=await fd.stat();
  if(st.dev!==before.dev||st.ino!==before.ino||st.size!==before.size)deny('F10B9_LOCK_CHANGED');
  const bytes=await fd.readFile();const after=await fd.stat();
  if(bytes.length!==st.size||after.size!==st.size||after.mtimeMs!==st.mtimeMs)deny('F10B9_LOCK_CHANGED');
  let doc;try{doc=JSON.parse(bytes.toString('utf8'));}catch{deny('F10B9_LOCK_INVALID');}
  return {doc,digest:sha(bytes),dev:st.dev,ino:st.ino};
 }finally{await fd.close();}}
function requireDead(pid){
 if(!Number.isSafeInteger(pid)||pid<1)deny('F10B9_PID_INVALID');
 if(pid===process.pid)deny('F10B9_PROCESS_STILL_RUNNING');
 try{process.kill(pid,0);deny('F10B9_PROCESS_STILL_RUNNING');}catch(e){
  if(e.code==='ESRCH')return;
  if(e.code==='F10B9_PROCESS_STILL_RUNNING')throw e;
  deny('F10B9_PID_UNVERIFIABLE');
 }
}
async function putExclusive(dir,name,obj){const destination=path.join(dir,name);const row={...obj,checksum:sha(JSON.stringify(obj))};
 const fd=await fs.open(destination,'wx',0o600);
 try{await fd.writeFile(JSON.stringify(row)+'\n');await fd.sync();}finally{await fd.close();}
 await syncDir(dir);
}
export class F10b9AdministrativeResolution {
 constructor(config){this.investigator=new F10b4RecoveryInvestigation(config);
  this.owner=config.userScopeId;this.backend=config.backend;this.name=config.physicalCollectionName;
  this.key=config.collectionKey;this.root=path.resolve(config.vectorsPath);}
 async releaseTerminalLock({caseId,confirm,quiescent}={}){
  if(!UUID.test(caseId||''))deny('F10B9_CASE_INVALID');
  if(confirm!==MAGIC||quiescent!==true)deny('F10B9_EXPLICIT_HOST_CONSENT_REQUIRED');
  if(process.platform==='win32')deny('F10B9_POSIX_HOST_ONLY_UNTESTED');
  // One administrator owns this review while it runs; a crashed release must
  // never be silently retried. Preserve a separate attempt log on uncertainty.
  await privateDir(this.root);
  const parent=path.join(this.root,'.similharity');await privateDir(parent);
  const locks=path.join(parent,'f09c10-writer-locks');await privateDir(locks);
  const label='collection-'+sha(JSON.stringify([this.backend,this.name]))+'.lock';
  const lock=path.join(locks,label);
  const adminLock=path.join(locks,'.f10b9-admin.lock');
  let fd;
  try{fd=await fs.open(adminLock,'wx',0o600);}catch(e){
   if(e.code==='EEXIST')deny('F10B9_ADMIN_BUSY');throw e;}
  let intentPersisted=false, resultPersisted=false;
  try {
   await fd.writeFile('F10B9_ADMIN_ACTIVE\n');await fd.sync();await syncDir(locks);
   const prior=await this.investigator.verifyCase(caseId);
   if(!prior.locallyIntegrityChecked||prior.liveUnlockAllowed!==false)deny('F10B9_CASE_INVALID');
   const baseline=await this.investigator.inspect();
   if(baseline.evidenceDigest!==prior.evidenceDigest||baseline.classification!=='RETAINED_LOCK_REQUIRES_HOST_REVIEW'||
    baseline.managed.pending!==0||baseline.operations.some(x=>!['VERIFIED','FAILED'].includes(x.state)))
    deny('F10B9_PENDING_OR_CHANGED_STATE');
   const original=await readLock(lock),d=original.doc;
   // Old unbound locks and F03/diagnostic locks cannot be released by this tool.
   if(d.schemaVersion!==1||d.backend!==this.backend||d.physicalNameHash!==sha(this.name)||
    d.collectionKey!==this.key||d.ownerHash!==sha(this.owner)||
    !UUID.test(d.operationId||'')||!Number.isSafeInteger(d.pid)||d.pid<1||
    original.digest!==baseline.lockDigest)deny('F10B9_LOCK_NOT_ATTESTED');
   const terminal=baseline.operations.find(x=>x.operationId===d.operationId);
   if(!terminal||!['VERIFIED','FAILED'].includes(terminal.state))deny('F10B9_OPERATION_NOT_TERMINAL');
   requireDead(d.pid);
   // Repeat the investigation after PID validation. The held collection lock
   // prevents cooperating writers from starting a new mutation at this point.
   if((await this.investigator.inspect()).evidenceDigest!==baseline.evidenceDigest)
    deny('F10B9_SOURCE_CHANGED');
   const cases=path.join(parent,'f10b9-terminal-releases');
   try{await fs.mkdir(cases,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
   await privateDir(cases);
   const destination=path.join(cases,caseId);
   // mkdir is exclusive; prevents duplicate replay of the same case ID.
   await fs.mkdir(destination,{mode:0o700});await syncDir(cases);
   await putExclusive(destination,'intent.json',{schemaVersion:1,caseId,collectionKey:this.key,
    backend:this.backend,physicalNameHash:sha(this.name),operationId:d.operationId,
    terminalState:terminal.state,evidenceDigest:baseline.evidenceDigest,
    lockDigest:original.digest,action:'QUARANTINE_TERMINAL_ONLY',replayAllowed:false});
   intentPersisted=true;
   const rightBefore=await readLock(lock);
   if(rightBefore.dev!==original.dev||rightBefore.ino!==original.ino||rightBefore.digest!==original.digest||
    (await this.investigator.inspect()).evidenceDigest!==baseline.evidenceDigest)deny('F10B9_SOURCE_CHANGED');
   // Atomic same-filesystem rename, never deletion. Retain a forensic lock copy.
   await fs.rename(lock,path.join(destination,'retained-lock.json'));
   await syncDir(locks);await syncDir(destination);
   await putExclusive(destination,'result.json',{schemaVersion:1,caseId,
    originalLockDigest:original.digest,originalEvidenceDigest:baseline.evidenceDigest,
    disposition:'QUARANTINED_TERMINAL_LOCK_ONLY',replayAllowed:false,
    stateModified:false,productionCertified:false});
   resultPersisted=true;
   return {caseId,disposition:'QUARANTINED_TERMINAL_LOCK_ONLY',operationId:d.operationId,
    replayAllowed:false,productionCertified:false,hostAttestationOperatorSupplied:true};
  }finally{
   await fd.close();
   // If the on-disk intent exists, a subsequent crash or partial rename must
   // retain the admin fence for independent investigation, not auto-retry.
   if(!intentPersisted||resultPersisted){
    const st=await fs.lstat(adminLock);
    if(!st.isSymbolicLink()&&st.isFile())await fs.unlink(adminLock);
    await syncDir(locks);
   }
  }
 }
}
export const F10B9_CONSENT=MAGIC;
