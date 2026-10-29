/** F10b.10 - read-only, administrator-supplied cross-stage backup/restore evidence gate.
 * No backend IO, production promotion, lock release, mutation replay or restore calls.
 * Self-reported evidence with local SHA256 integrity is NOT independent host attestation.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants as C} from 'node:fs';
import {createHash} from 'node:crypto';

const sha=x=>createHash('sha256').update(x).digest('hex');
const HASH=/^[a-f0-9]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=c=>Object.assign(new Error(c),{code:c});
export const F10B10_BACKENDS=Object.freeze(['qdrant','lancedb','vectra','milvus']);
export const F10B10_KINDS=Object.freeze(['control_plane','native_backup','native_restore','source_inventory',
 'restored_inventory','cooperative_writer','crash_restart','scope_isolation','rollback','quiescence']);
const MAX_FILE=2*1024*1024,MAX_DIR_FILES=18,MAX_ROWS=100000;
const safeName=s=>typeof s==='string'&&s.length<121&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(s)&&s!=='.'&&s!=='..';
async function readPrivate(file){
 const st=await fs.lstat(file);
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size<2||st.size>MAX_FILE||
   (process.platform!=='win32'&&(st.mode&0o077)!==0))throw fail('F10B10_UNTRUSTED_FILE');
 const h=await fs.open(file,C.O_RDONLY|(C.O_NOFOLLOW??0));
 try {const a=await h.stat();if(a.dev!==st.dev||a.ino!==st.ino||a.nlink!==1||a.size!==st.size)throw fail('F10B10_CHANGED_FILE');
  const bytes=await h.readFile(),b=await h.stat();
  if(a.size!==bytes.length||a.size!==b.size||a.mtimeMs!==b.mtimeMs)throw fail('F10B10_CHANGED_FILE');return bytes;
 }finally{await h.close();}
}
async function privateDir(dir){const st=await fs.lstat(dir);
 if(!st.isDirectory()||st.isSymbolicLink()||(process.platform!=='win32'&&(st.mode&0o077)!==0))throw fail('F10B10_UNTRUSTED_DIRECTORY');}
async function checkAncestors(dir){let p=path.parse(dir).root;
 for(const segment of path.relative(p,dir).split(path.sep).filter(Boolean)){
  p=path.join(p,segment);const st=await fs.lstat(p);
  if(!st.isDirectory()||st.isSymbolicLink())throw fail('F10B10_UNTRUSTED_ANCESTOR');
 }}
function json(bytes){try{const obj=JSON.parse(bytes.toString('utf8'));
 if(!obj||typeof obj!=='object'||Array.isArray(obj))throw Error('bad');return obj;
 }catch{throw fail('F10B10_BAD_JSON');}}
function inventory(bytes,backend,runId,backupId){const doc=json(bytes);
 if(doc.schemaVersion!==1||doc.backend!==backend||doc.runId!==runId||doc.backupId!==backupId||!Array.isArray(doc.records)||doc.records.length>MAX_ROWS)
  throw fail('F10B10_INVALID_INVENTORY');
 const ids=new Set(),rows=[];
 for(const row of doc.records){
  if(!row||!safeName(row.id)||!Number.isSafeInteger(row.revision)||row.revision<0||
   !HASH.test(row.vectorSha256||'')||!HASH.test(row.metadataSha256||'')||ids.has(row.id))throw fail('F10B10_INVALID_INVENTORY');
  ids.add(row.id);rows.push([row.id,row.revision,row.vectorSha256,row.metadataSha256]);
 }
 rows.sort((a,b)=>a[0].localeCompare(b[0]));return {count:rows.length,digest:sha(JSON.stringify(rows))};
}
function validBuild(build){return build&&typeof build.pluginVersion==='string'&&
 /^3\.2\.10-s10\.\d+-f10b10$/.test(build.pluginVersion)&&
 /^2\.2\.0-alpha\.s11\.\d+-f10b10$/.test(build.extensionVersion||'')&&HASH.test(build.pluginSourceFingerprint||'');}
function validateManifest(doc,backend,build){
 if(doc.schemaVersion!==1||doc.checkpoint!=='F10b.10'||doc.backend!==backend||doc.environment!=='DISPOSABLE_HOST_ONLY'||
  !UUID.test(doc.runId||'')||doc.pluginVersion!==build.pluginVersion||doc.extensionVersion!==build.extensionVersion||
  doc.pluginSourceFingerprint!==build.pluginSourceFingerprint||!safeName(doc.sourceCollection)||!safeName(doc.restoredCollection)||
  doc.sourceCollection===doc.restoredCollection||!UUID.test(doc.backupId||'')||
  doc.cooperatingWritersOnly!==true||doc.productionActivationRequested!==false||
  doc.uncertainOperationsReplayed!==false||doc.uncertainLocksForceReleased!==false||
  doc.unrelatedDirectWritersProtected!==false||!Array.isArray(doc.artifacts)||doc.artifacts.length>MAX_DIR_FILES)
  throw fail('F10B10_INVALID_MANIFEST');
 const kinds=new Set(),names=new Set();
 for(const artifact of doc.artifacts){if(!artifact||!F10B10_KINDS.includes(artifact.kind)||
  !safeName(artifact.file)||!HASH.test(artifact.sha256||'')||artifact.result!=='PASS'||
  kinds.has(artifact.kind)||names.has(artifact.file))throw fail('F10B10_INVALID_MANIFEST');
  kinds.add(artifact.kind);names.add(artifact.file);
 }
 return {kinds,names};
}
function linkedReceipt(bytes,kind,manifest){const d=json(bytes);
 if(d.schemaVersion!==1||d.kind!==kind||d.backend!==manifest.backend||d.runId!==manifest.runId||
  d.backupId!==manifest.backupId||d.sourceCollection!==manifest.sourceCollection||
  d.restoredCollection!==manifest.restoredCollection||d.result!=='PASS'||
  d.uncertainOrPendingOperations!==false||d.retainedLockReleasedWithoutTerminalReceipt!==false)
  throw fail('F10B10_RECEIPT_MISMATCH');
 return d;
}
/** Never returns certified=true, even when all supplied host evidence validates. */
export async function assessF10b10({evidenceRoot,build}={}){
 if(!validBuild(build))throw fail('F10B10_BUILD_INVALID');
 if(typeof evidenceRoot!=='string'||!path.isAbsolute(evidenceRoot)||path.resolve(evidenceRoot)!==evidenceRoot||
 evidenceRoot===path.parse(evidenceRoot).root)throw fail('F10B10_ROOT_INVALID');
 await checkAncestors(evidenceRoot);await privateDir(evidenceRoot);
 const results={};
 for(const backend of F10B10_BACKENDS){const dir=path.join(evidenceRoot,backend);
  try{await privateDir(dir);}catch(e){if(e.code==='ENOENT'){
   results[backend]={status:'BLOCKED_NO_HOST_EVIDENCE',productionCertified:false};continue;}throw e;}
  const found=await fs.readdir(dir);
  if(!found.length){results[backend]={status:'BLOCKED_NO_HOST_EVIDENCE',productionCertified:false};continue;}
  if(found.length>MAX_DIR_FILES+1||!found.includes('manifest.json'))throw fail('F10B10_UNEXPECTED_FILES');
  const manifest=json(await readPrivate(path.join(dir,'manifest.json')));
  const {kinds,names}=validateManifest(manifest,backend,build);
  if(found.length!==names.size+1||found.some(n=>n!=='manifest.json'&&!names.has(n)))throw fail('F10B10_UNEXPECTED_FILES');
  const contents=new Map();
  for(const row of manifest.artifacts){const bytes=await readPrivate(path.join(dir,row.file));
   if(sha(bytes)!==row.sha256)throw fail('F10B10_TAMPERED_ARTIFACT');contents.set(row.kind,bytes);}
  const missing=F10B10_KINDS.filter(k=>!kinds.has(k));
  let inventoryMatch=false,count=0;
  if(contents.has('source_inventory')&&contents.has('restored_inventory')){
   const before=inventory(contents.get('source_inventory'),backend,manifest.runId,manifest.backupId);
   const after=inventory(contents.get('restored_inventory'),backend,manifest.runId,manifest.backupId);
   inventoryMatch=before.digest===after.digest&&before.count===after.count;count=before.count;
  }
  for(const kind of F10B10_KINDS.filter(k=>!k.endsWith('_inventory'))){
   if(contents.has(kind))linkedReceipt(contents.get(kind),kind,manifest);
  }
  results[backend]={status:missing.length?'BLOCKED_INCOMPLETE_EVIDENCE':
   !inventoryMatch?'BLOCKED_INVENTORY_MISMATCH':'READY_FOR_INDEPENDENT_REVIEW',
   missing,inventoryMatch,inventoryCount:count,productionCertified:false,
   selfReportedEvidence:true,hostRunId:manifest.runId};
 }
 const ready=F10B10_BACKENDS.filter(b=>results[b].status==='READY_FOR_INDEPENDENT_REVIEW');
 return {checkpoint:'F10b.10',reviewReady:ready,results,
  overall:'NO_GO_PRODUCTION',independentHostAttestation:false,
  productionCertified:false,productionRestoreEnabled:false,productionMutationsEnabled:false,
  automaticSyncEnabled:false,uncertainReceiptReconciliationAllowed:false,lockForceReleaseAllowed:false,
  next:'REAL_HOST_BACKEND_ACCEPTANCE_INDEPENDENT_REVIEW_UNCERTAIN_OPERATION_RECOVERY'};
}
