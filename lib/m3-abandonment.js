/** M3 administrator ABANDON disposition. An ambiguous operation is NOT
 * declared NOT_APPLIED, replayed, or unlocked. Its physical lock remains
 * present indefinitely while an immutable, checksum-bound decision is stored.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {M3Store} from './m3-collections.js';
import {M3LogicalExclusion} from './m3-logical-exclusion.js';
import {inspectM3GeneralReconciliation} from './m3-general-reconciliation.js';
const H=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[0-9a-f]{12}$/i;
const KEY=/^[a-f0-9]{64}$/;
const fail=code=>Object.assign(new Error(code),{code,status:409});
export const M3_ABANDON_CONFIRM='ABANDON UNCERTAIN M3 OPERATION AND RETAIN LOCK';
function auth(req){if(!req?.s03?.userScopeId||!req.user?.directories||
 !(req.user.admin===true||req.user.profile?.admin===true))throw fail('M3_ABANDON_ADMIN_REQUIRED');return req.s03;}
async function dir(p){const st=await fs.lstat(p);if(!st.isDirectory()||st.isSymbolicLink()||
 (process.platform!=='win32'&&(st.mode&0o077)))throw fail('M3_ABANDON_STORAGE_UNTRUSTED');}
async function sync(p){if(process.platform==='win32')return;const f=await fs.open(p,'r');try{await f.sync();}finally{await f.close();}}
async function read(p){const st=await fs.lstat(p);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||
 st.size<2||st.size>16384||(process.platform!=='win32'&&(st.mode&0o077)))throw fail('M3_ABANDON_FILE_UNTRUSTED');
 let data;try{data=JSON.parse(await fs.readFile(p,'utf8'));}catch{throw fail('M3_ABANDON_FILE_CORRUPT');}
 return data;}
/** Confirm actual retained lock, dead process and that the unresolved audit
 * still requires review. Nothing here authorizes guessing NOT_APPLIED.
 */
async function proof(req,id,deps={}){
 const ctx=auth(req);if(!UUID.test(id??''))throw fail('M3_ABANDON_OPERATION_INVALID');
 const store=deps.store?.(ctx)??new M3Store(ctx),ticket=await store.read('operation',id);
 if(ticket.owner!==ctx.userScopeId||ticket.backend!=='qdrant'||
  !['restore','empty','rebuild','delete','rollback','activate-rebuild'].includes(ticket.action))
  throw fail('M3_ABANDON_OPERATION_UNSUPPORTED');
 const report=await (deps.inspectGeneral??inspectM3GeneralReconciliation)(req,id,deps);
 if(report.classification!=='REVIEW_REQUIRED'||report.physicalOutcome!=='NOT_PROVEN'||
  report.claimed!==true||report.replayAllowed!==false||!KEY.test(report.evidenceHash??''))
  throw fail('M3_ABANDON_NOT_UNCERTAIN');
 const lock=new M3LogicalExclusion(ctx,{backend:'qdrant',logicalKey:ticket.logicalKey});
 const item=await read(lock.file),want=createHash('sha256').update(ctx.userScopeId).digest('hex');
 if(item.schemaVersion!==1||item.operationId!==id||item.ownerHash!==want||
  item.logicalKey!==ticket.logicalKey||item.backend!=='qdrant'||
  !Number.isSafeInteger(item.pid)||item.pid<1)throw fail('M3_ABANDON_LOCK_UNBOUND');
 if(item.pid===process.pid)throw fail('M3_ABANDON_PROCESS_RUNNING');
 try{process.kill(item.pid,0);throw fail('M3_ABANDON_PROCESS_RUNNING');}
 catch(e){if(e.code!=='ESRCH')throw fail('M3_ABANDON_PROCESS_UNVERIFIABLE');}
 return {ctx,ticket,report,lock,lockHash:H(item)};
}
export async function abandonM3UncertainOperation(req,id,{deps={},adminRoot}={}){
 const ctx=auth(req),root=adminRoot??process.env.SIMILHARITY_SERVER_CONFIG_DIR;
 if(!path.isAbsolute(root??''))throw fail('M3_ABANDON_PRIVATE_APPROVAL_REQUIRED');await dir(root);
 const approval=await read(path.join(root,`m3-abandon-${id}.json`));
 if(approval.schemaVersion!==1||approval.operationId!==id||!UUID.test(approval.reviewId??'')||
  approval.confirmation!==M3_ABANDON_CONFIRM||approval.approved!==true||approval.decision!=='ABANDON'||
  !KEY.test(approval.evidenceHash??''))throw fail('M3_ABANDON_APPROVAL_INVALID');
 const before=await proof(req,id,deps);
 if(before.report.evidenceHash!==approval.evidenceHash)throw fail('M3_ABANDON_EVIDENCE_CHANGED');
 const parent=path.join(ctx.vectorsPath,'.similharity'),folder=path.join(parent,'m3-abandoned');
 await dir(parent);await fs.mkdir(folder,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});await dir(folder);
 const guard=path.join(folder,'.admin.lock');let fd;
 try{fd=await fs.open(guard,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw fail('M3_ABANDON_BUSY');throw e;}
 try{
  await fd.writeFile(JSON.stringify({operationId:id,reviewId:approval.reviewId})+'\n');await fd.sync();await sync(folder);
  const again=await proof(req,id,deps);
  if(again.report.evidenceHash!==before.report.evidenceHash||again.lockHash!==before.lockHash)
   throw fail('M3_ABANDON_EVIDENCE_CHANGED');
  const body={schemaVersion:1,owner:ctx.userScopeId,operationId:id,reviewId:approval.reviewId,
   decision:'ABANDON',evidenceHash:before.report.evidenceHash,lockHash:before.lockHash,
   previous:'GENESIS',at:Date.now(),physicalOutcome:'NOT_PROVEN',replayAllowed:false,
   lockReleaseAuthorized:false};
  const target=path.join(folder,`${id}.json`),output=await fs.open(target,'wx',0o600);
  try{await output.writeFile(JSON.stringify({...body,seal:H(body)})+'\n');await output.sync();}finally{await output.close();}
  await sync(folder);
  return {operationId:id,reviewId:approval.reviewId,disposition:'ABANDONED_UNCERTAIN_LOCK_RETAINED',
   physicalOutcome:'NOT_PROVEN',replayAllowed:false,lockReleaseAuthorized:false,
   validationStatus:'AWAITING_MANUAL_TEST'};
 }finally{await fd.close();await fs.unlink(guard);await sync(folder);}
}
export async function inspectM3Abandonment(req,id){
 const ctx=auth(req);if(!UUID.test(id??''))throw fail('M3_ABANDON_OPERATION_INVALID');
 const doc=await read(path.join(ctx.vectorsPath,'.similharity','m3-abandoned',`${id}.json`));
 const {seal,...body}=doc;
 if(seal!==H(body)||body.owner!==ctx.userScopeId||body.operationId!==id||
  body.disposition!==undefined||body.decision!=='ABANDON'||body.lockReleaseAuthorized!==false||
  body.replayAllowed!==false||body.previous!=='GENESIS')throw fail('M3_ABANDON_RECORD_CORRUPT');
 return {operationId:id,reviewId:body.reviewId,disposition:'ABANDONED_UNCERTAIN_LOCK_RETAINED',
  physicalOutcome:'NOT_PROVEN',replayAllowed:false,lockReleaseAuthorized:false};
}
