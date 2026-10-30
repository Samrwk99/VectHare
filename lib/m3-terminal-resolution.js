/** M3 administrator-only, evidence-bound quarantine of a *terminal, already
 * committed* collection-delete logical lock. This is not uncertainty
 * adjudication, not a replay, and never authorizes a new physical write.
 * Pending, submitted, or otherwise ambiguous operations remain locked.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants as C} from 'node:fs';
import {createHash} from 'node:crypto';
import {M3Store,m3LedgerCheckpoint} from './m3-collections.js';
import {inspectM3LifecycleRecovery} from './m3-execution-audit.js';
import {M2JobStore} from './m2-jobs.js';
import {CollectionRegistry} from './s02-registry.js';
import {M3LogicalExclusion} from './m3-logical-exclusion.js';
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const hash=x=>createHash('sha256').update(x).digest('hex');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^[a-f0-9]{64}$/;
const error=code=>Object.assign(new Error(code),{code,status:409});
export const M3_TERMINAL_CONFIRM='QUARANTINE VERIFIED TERMINAL COLLECTION LOCK';
async function priv(p){const st=await fs.lstat(p);
 if(!st.isDirectory()||st.isSymbolicLink()||(process.platform!=='win32'&&(st.mode&0o077)))throw error('M3_RESOLUTION_DIRECTORY_UNTRUSTED');}
async function sync(p){if(process.platform==='win32')return;const fd=await fs.open(p,'r');try{await fd.sync();}finally{await fd.close();}}
async function readSafe(file,max=8192){const before=await fs.lstat(file);
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>max||before.size<2||
    (process.platform!=='win32'&&(before.mode&0o077)))throw error('M3_RESOLUTION_FILE_UNTRUSTED');
 const fd=await fs.open(file,C.O_RDONLY|(C.O_NOFOLLOW??0));try{const st=await fd.stat();
  if(st.ino!==before.ino||st.dev!==before.dev||st.size!==before.size)throw error('M3_RESOLUTION_FILE_CHANGED');
  const bytes=await fd.readFile(),after=await fd.stat();
  if(bytes.length!==st.size||after.mtimeMs!==st.mtimeMs)throw error('M3_RESOLUTION_FILE_CHANGED');
  let data;try{data=JSON.parse(bytes.toString());}catch{throw error('M3_RESOLUTION_FILE_CORRUPT');}
  return {data,digest:hash(bytes),ino:st.ino,dev:st.dev};
 }finally{await fd.close();}}
function processNotAlive(pid){if(!Number.isSafeInteger(pid)||pid<1)throw error('M3_RESOLUTION_PID_UNTRUSTED');
 if(pid===process.pid)throw error('M3_RESOLUTION_PROCESS_RUNNING');
 try{process.kill(pid,0);throw error('M3_RESOLUTION_PROCESS_RUNNING');}catch(e){
  if(e.code==='ESRCH')return;throw error(e.code==='M3_RESOLUTION_PROCESS_RUNNING'?e.code:'M3_RESOLUTION_PID_UNVERIFIABLE');
 }}
async function writeExclusive(dir,name,value){const copy={...value},fd=await fs.open(path.join(dir,name),'wx',0o600);
 try{await fd.writeFile(JSON.stringify({...copy,checksum:sha(copy)})+'\n');await fd.sync();}finally{await fd.close();}await sync(dir);}
function authenticated(req){if(!req?.s03?.userScopeId||!req.user?.directories||
 (req.user?.profile?.admin!==true&&req.user?.admin!==true))throw error('M3_RESOLUTION_HOST_ADMIN_REQUIRED');
 if(process.platform==='win32')throw error('M3_RESOLUTION_POSIX_ONLY');return req.s03;}
/** An administrator cannot approve a lock by self-asserted physical state.
 * Only an independently committed deletion with a real Qdrant 404 qualifies.
 * A delete whose response was lost or audit is incomplete is NOT eligible.
 */
export async function inspectM3TerminalProof(req,operationId,deps={}){
 const ctx=authenticated(req);if(!UUID.test(operationId??''))throw error('M3_RESOLUTION_OPERATION_INVALID');
 const store=deps.store?.(ctx)??new M3Store(ctx),ticket=await store.read('operation',operationId);
 if(ticket.owner!==ctx.userScopeId||ticket.backend!=='qdrant'||ticket.action!=='delete'||!KEY.test(ticket.logicalKey??''))
  throw error('M3_RESOLUTION_ACTION_NOT_ELIGIBLE');
 const audit=await inspectM3LifecycleRecovery(ctx,operationId,{store});
 if(!audit.claimed||!audit.evidenceComplete||audit.lastStage!=='COMMITTED')throw error('M3_RESOLUTION_NOT_TERMINAL');
 const backup=await store.read('backup',ticket.backupId),deletion=await store.read('deletion',operationId);
 if(backup.owner!==ctx.userScopeId||backup.logicalKey!==ticket.logicalKey||backup.physicalName!==ticket.physicalName||
  backup.inventory?.digest!==sha(backup.inventory?.rows)||backup.inventory?.digest!==ticket.inventoryDigest||
  backup.inventory?.complete!==true||backup.inventory?.exclusiveOwner!==true||
  deletion.owner!==ctx.userScopeId||deletion.backupId!==backup.backupId||
  deletion.logicalKey!==ticket.logicalKey||deletion.physicalName!==ticket.physicalName||
  deletion.registryTombstoned!==true||deletion.verifiedPhysicalAbsent!==true||
  deletion.inventoryDigest!==backup.inventory.digest)
  throw error('M3_RESOLUTION_COMPLETION_EVIDENCE_INVALID');
 const s02=deps.s02?.(ctx)??new CollectionRegistry(path.join(ctx.vectorsPath,'.similharity'));
 const current=await s02.lookup({backend:'qdrant',scope:backup.scope,embedding:backup.embedding});
 if(current?.status!=='DELETED'||current.key!==ticket.logicalKey||current.physicalName!==(ticket.canonicalPhysicalName??ticket.physicalName))
  throw error('M3_RESOLUTION_TOMBSTONE_MISSING');
 const jobs=deps.jobs?.(ctx)??new M2JobStore(ctx);
 await jobs.assertNoLease(ticket.logicalKey);
 const ledger=await m3LedgerCheckpoint(ctx,ticket.logicalKey,deps);
 if(!KEY.test(ledger.digest??''))throw error('M3_RESOLUTION_LEDGER_UNVERIFIED');
 const transport=deps.transport?await deps.transport(req,ticket):
  (typeof deps.backendPool?.getTrusted==='function'?await deps.backendPool.getTrusted(ctx,'qdrant',ticket.configId):null);
 if(typeof transport?._request!=='function')throw error('M3_RESOLUTION_BACKEND_UNAVAILABLE');
 try{await transport._request('GET',`/collections/${ticket.physicalName}`);
  throw error('M3_RESOLUTION_PHYSICAL_STILL_PRESENT');
 }catch(e){if(e?.httpStatus!==404)throw e;}
 const logical=new M3LogicalExclusion(ctx,{backend:'qdrant',logicalKey:ticket.logicalKey});
 await priv(ctx.vectorsPath);await priv(path.join(ctx.vectorsPath,'.similharity'));
 await priv(logical.root);
 const lock=await readSafe(logical.file);
 if(lock.data.schemaVersion!==1||lock.data.backend!=='qdrant'||lock.data.logicalKey!==ticket.logicalKey||
  lock.data.ownerHash!==hash(ctx.userScopeId)||lock.data.operationId!==operationId)
  throw error('M3_RESOLUTION_LOCK_UNBOUND');
 processNotAlive(lock.data.pid);
 const proof={schemaVersion:1,operationId,logicalKey:ticket.logicalKey,ownerScopeHash:hash(ctx.userScopeId),
  action:'delete',auditStage:audit.lastStage,auditEventCount:audit.eventCount,backupDigest:sha(backup),
  deletionDigest:sha(deletion),ledgerDigest:ledger.digest,lockDigest:lock.digest,
  physicalState:'ABSENT_404',tombstoneState:'DELETED',processState:'PID_ABSENT'};
 return {proof,proofHash:sha(proof),lock};
}
/** Requires an explicit server-private approval document bound to the fresh
 * evidence hash. Never accepts the outcome/evidence/physical name via HTTP.
 * On any failure after the durable attempt starts the review fence remains.
 */
export async function quarantineM3TerminalLock(req,operationId,{deps={},adminRoot}={}){
 const ctx=authenticated(req);
 const root=adminRoot??process.env.SIMILHARITY_SERVER_CONFIG_DIR;
 if(!path.isAbsolute(root??''))throw error('M3_RESOLUTION_PRIVATE_APPROVAL_REQUIRED');
 await priv(root);
 const approvalFile=path.join(root,`m3-terminal-review-${operationId}.json`);
 const approval=(await readSafe(approvalFile)).data;
 if(approval.schemaVersion!==1||approval.operationId!==operationId||!UUID.test(approval.reviewId??'')||
  approval.confirmation!==M3_TERMINAL_CONFIRM||approval.adminApproved!==true||approval.quiescent!==true||
  typeof approval.proofHash!=='string'||!KEY.test(approval.proofHash))throw error('M3_RESOLUTION_APPROVAL_INVALID');
 const before=await inspectM3TerminalProof(req,operationId,deps);
 if(before.proofHash!==approval.proofHash)throw error('M3_RESOLUTION_EVIDENCE_CHANGED');
 const lockPath=new M3LogicalExclusion(ctx,{logicalKey:before.proof.logicalKey}).file;
 const parent=path.join(ctx.vectorsPath,'.similharity'),cases=path.join(parent,'m3-terminal-resolutions');
 await fs.mkdir(cases,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});await priv(cases);
 const adminFence=path.join(cases,'.admin.lock');let fence;
 try{fence=await fs.open(adminFence,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw error('M3_RESOLUTION_ADMIN_BUSY');throw e;}
 let intent=false,done=false;
 try{
  await fence.writeFile(JSON.stringify({operationId,reviewId:approval.reviewId})+'\n');await fence.sync();await sync(cases);
  const again=await inspectM3TerminalProof(req,operationId,deps);
  if(again.proofHash!==before.proofHash||again.lock.ino!==before.lock.ino||again.lock.dev!==before.lock.dev)
   throw error('M3_RESOLUTION_EVIDENCE_CHANGED');
  const destination=path.join(cases,approval.reviewId);await fs.mkdir(destination,{mode:0o700});await sync(cases);
  await writeExclusive(destination,'intent.json',{schemaVersion:1,operationId,reviewId:approval.reviewId,
   proofHash:before.proofHash,lockDigest:before.lock.digest,replayAllowed:false});intent=true;
  // Retain the actual lock file for forensic review. No speculative replay.
  const last=await readSafe(lockPath);
  if(last.digest!==before.lock.digest||last.ino!==before.lock.ino||last.dev!==before.lock.dev)
   throw error('M3_RESOLUTION_LOCK_CHANGED');
  await fs.rename(lockPath,path.join(destination,'quarantined-lock.json'));
  await sync(path.dirname(lockPath));await sync(destination);
  await writeExclusive(destination,'result.json',{schemaVersion:1,operationId,reviewId:approval.reviewId,
   disposition:'QUARANTINED_COMMITTED_DELETE_LOCK',proofHash:before.proofHash,replayAllowed:false});
  done=true;
  return {operationId,reviewId:approval.reviewId,disposition:'QUARANTINED_COMMITTED_DELETE_LOCK',
   replayAllowed:false,mutationReplayed:false,productionCertified:false};
 }finally{
  await fence.close();
  // On a crash/ambiguity after attempt intent, leave the admin fence and
  // review folder untouched. Never automatically perform the rename again.
  if(!intent||done){const st=await fs.lstat(adminFence);if(st.isFile()&&!st.isSymbolicLink())await fs.unlink(adminFence);await sync(cases);}
 }
}
