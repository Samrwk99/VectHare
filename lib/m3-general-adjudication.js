/** M3 guarded administrator adjudication of PROVEN_APPLIED lifecycle outcomes.
 * No browser supplies a verdict, lock path, physical name, or proof. An
 * externally approved server-private file binds the independent proof hash.
 * Ambiguous, in-flight and NOT_APPLIED guesses are never eligible.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants as FS} from 'node:fs';
import {createHash} from 'node:crypto';
import {M3Store} from './m3-collections.js';
import {M3LogicalExclusion} from './m3-logical-exclusion.js';
import {inspectM3GeneralReconciliation} from './m3-general-reconciliation.js';
const hash=x=>createHash('sha256').update(x).digest('hex');
const digest=x=>hash(JSON.stringify(x));
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^[0-9a-f]{64}$/;
const fail=code=>Object.assign(new Error(code),{code,status:409});
export const M3_GENERAL_CONFIRM='QUARANTINE PROVEN APPLIED M3 LOCKS';
async function privateDir(p){const st=await fs.lstat(p);
 if(!st.isDirectory()||st.isSymbolicLink()||(process.platform!=='win32'&&(st.mode&0o077)))throw fail('M3_ADJUDICATION_STORAGE_UNTRUSTED');}
async function syncDir(p){if(process.platform==='win32')return;const h=await fs.open(p,'r');try{await h.sync();}finally{await h.close();}}
async function safeFile(p){const before=await fs.lstat(p);
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size<2||before.size>16384||
  (process.platform!=='win32'&&(before.mode&0o077)))throw fail('M3_ADJUDICATION_FILE_UNTRUSTED');
 const h=await fs.open(p,FS.O_RDONLY|(FS.O_NOFOLLOW??0));try{
  const st=await h.stat();if(st.ino!==before.ino||st.dev!==before.dev||st.size!==before.size)throw fail('M3_ADJUDICATION_FILE_CHANGED');
  const bytes=await h.readFile(),after=await h.stat();if(bytes.length!==st.size||after.mtimeMs!==st.mtimeMs)throw fail('M3_ADJUDICATION_FILE_CHANGED');
  let data;try{data=JSON.parse(bytes.toString());}catch{throw fail('M3_ADJUDICATION_FILE_CORRUPT');}
  return {data,digest:hash(bytes),ino:st.ino,dev:st.dev};
 }finally{await h.close();}}
async function writeOnce(p,body){const fd=await fs.open(p,'wx',0o600);
 try{await fd.writeFile(JSON.stringify({...body,seal:digest(body)})+'\n');await fd.sync();}finally{await fd.close();}
 await syncDir(path.dirname(p));}
function requireAdmin(req){if(!req?.s03?.userScopeId||!req.user?.directories||
 !(req.user.admin===true||req.user.profile?.admin===true))throw fail('M3_ADJUDICATION_ADMIN_REQUIRED');
 if(process.platform==='win32')throw fail('M3_ADJUDICATION_PLATFORM_NOT_ATTESTED');return req.s03;}
function dead(pid){if(!Number.isSafeInteger(pid)||pid<=0)throw fail('M3_ADJUDICATION_PROCESS_UNVERIFIABLE');
 if(pid===process.pid)throw fail('M3_ADJUDICATION_PROCESS_STILL_RUNNING');
 try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')return true;throw fail('M3_ADJUDICATION_PROCESS_UNVERIFIABLE');}
 throw fail('M3_ADJUDICATION_PROCESS_STILL_RUNNING');}
async function readLocks(ctx,id,keys){const result=[];
 for(const key of keys){const exclusion=new M3LogicalExclusion(ctx,{backend:'qdrant',logicalKey:key});
  await privateDir(exclusion.root);const file=await safeFile(exclusion.file),v=file.data;
  if(v.schemaVersion!==1||v.backend!=='qdrant'||v.logicalKey!==key||v.operationId!==id||
   v.ownerHash!==hash(ctx.userScopeId))throw fail('M3_ADJUDICATION_LOCK_NOT_BOUND');
  dead(v.pid);result.push({...file,file:exclusion.file,key});}
 return result;}
/** Proof is not generated from request arguments. All physical, ledger,
 * journal and registry checks are delegated to the independent live inspector.
 */
export async function inspectM3ProvenAdjudication(req,id,deps={}){
 const ctx=requireAdmin(req);if(!UUID.test(id??''))throw fail('M3_ADJUDICATION_OPERATION_INVALID');
 const store=deps.store?.(ctx)??new M3Store(ctx),ticket=await store.read('operation',id);
 if(ticket.owner!==ctx.userScopeId||!['restore','empty','rebuild'].includes(ticket.action)||
  ticket.backend!=='qdrant'||!KEY.test(ticket.logicalKey??''))throw fail('M3_ADJUDICATION_OPERATION_INELIGIBLE');
 const report=await (deps.inspectGeneral??inspectM3GeneralReconciliation)(req,id,deps);
 if(report.classification!=='VERIFIED_APPLIED_REVIEW'||report.physicalOutcome!=='PROVEN_APPLIED'||
  report.completedAudit!==true||report.jobExclusionVerified!==true||!KEY.test(report.ledgerDigest??'')||
  !KEY.test(report.physicalFingerprint??'')||report.replayAllowed!==false)
  throw fail('M3_ADJUDICATION_OUTCOME_NOT_PROVEN');
 const keys=[ticket.logicalKey];
 if(ticket.action==='rebuild'){
  if(!KEY.test(ticket.targetLogicalKey??'')||ticket.targetLogicalKey===ticket.logicalKey)
   throw fail('M3_ADJUDICATION_TARGET_UNVERIFIED');
  keys.push(ticket.targetLogicalKey);
 }
 const locks=await readLocks(ctx,id,keys);
 const core={schemaVersion:1,operationId:id,ownerScopeHash:hash(ctx.userScopeId),
  action:ticket.action,logicalKeys:keys,evidenceHash:report.evidenceHash,
  physicalFingerprint:report.physicalFingerprint,
  lockDigests:locks.map(x=>x.digest),disposition:'PROVEN_APPLIED',replayAllowed:false};
 return {...core,proofHash:digest(core),eligible:true,requiresPrivateApproval:true,
  validationStatus:'AWAITING_MANUAL_TEST'};
}
/** Requires operator-created file in an admin-owned directory:
 * m3-general-review-<originalOperationId>.json with schemaVersion, original
 * id, reviewId (fresh UUID), confirmation, approved=true, proofHash, decision.
 * No HTTP body can approve a disposition or supply a filesystem path.
 */
export async function quarantineM3ProvenLocks(req,id,{deps={},adminRoot}={}){
 const ctx=requireAdmin(req),root=adminRoot??process.env.SIMILHARITY_SERVER_CONFIG_DIR;
 if(!path.isAbsolute(root??''))throw fail('M3_ADJUDICATION_PRIVATE_APPROVAL_REQUIRED');
 await privateDir(root);
 const approval=(await safeFile(path.join(root,`m3-general-review-${id}.json`))).data;
 if(approval.schemaVersion!==1||approval.operationId!==id||!UUID.test(approval.reviewId??'')||
  approval.confirmation!==M3_GENERAL_CONFIRM||approval.approved!==true||
  approval.decision!=='PROVEN_APPLIED'||!KEY.test(approval.proofHash??''))
  throw fail('M3_ADJUDICATION_APPROVAL_INVALID');
 const before=await inspectM3ProvenAdjudication(req,id,deps);
 if(before.proofHash!==approval.proofHash)throw fail('M3_ADJUDICATION_PROOF_CHANGED');
 const parent=path.join(ctx.vectorsPath,'.similharity'),cases=path.join(parent,'m3-general-adjudications');
 await privateDir(parent);await fs.mkdir(cases,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});await privateDir(cases);
 let fence;const guard=path.join(cases,'.administrator.lock');
 try{fence=await fs.open(guard,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw fail('M3_ADJUDICATION_BUSY');throw e;}
 let intent=false,complete=false;
 try{
  await fence.writeFile(JSON.stringify({operationId:id,reviewId:approval.reviewId})+'\n');await fence.sync();await syncDir(cases);
  const again=await inspectM3ProvenAdjudication(req,id,deps);
  if(again.proofHash!==before.proofHash)throw fail('M3_ADJUDICATION_PROOF_CHANGED');
  const folder=path.join(cases,approval.reviewId);await fs.mkdir(folder,{mode:0o700});await syncDir(cases);
  await writeOnce(path.join(folder,'intent.json'),{schemaVersion:1,operationId:id,reviewId:approval.reviewId,
   proofHash:before.proofHash,decision:'PROVEN_APPLIED',replayAllowed:false});intent=true;
  for(let n=0;n<before.logicalKeys.length;n++){
   const lk=before.logicalKeys[n],f=new M3LogicalExclusion(ctx,{backend:'qdrant',logicalKey:lk});
   const observed=await safeFile(f.file);
   if(observed.digest!==before.lockDigests[n]||observed.data.operationId!==id)
    throw fail('M3_ADJUDICATION_LOCK_CHANGED');
   await fs.rename(f.file,path.join(folder,`quarantined-lock-${n}.json`));
   await syncDir(path.dirname(f.file));await syncDir(folder);
  }
  await writeOnce(path.join(folder,'result.json'),{schemaVersion:1,operationId:id,reviewId:approval.reviewId,
   proofHash:before.proofHash,disposition:'PROVEN_APPLIED_LOCKS_QUARANTINED',replayAllowed:false});
  complete=true;
  return {operationId:id,reviewId:approval.reviewId,disposition:'PROVEN_APPLIED_LOCKS_QUARANTINED',
   originalOperationReplayed:false,validationStatus:'AWAITING_MANUAL_TEST'};
 }finally{
  await fence.close();
  // Keep fence forever after a crash/ambiguous partial quarantine; a human
  // must inspect forensic files and cannot silently repeat the same action.
  if(!intent||complete){await fs.unlink(guard);await syncDir(cases);}
 }
}
