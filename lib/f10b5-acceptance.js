/** F10b.5 — administrator-only, read-only HOST RECOVERY EVIDENCE ASSESSMENT.
 * This module NEVER connects to a backend, invokes restore, deletes locks,
 * promotes receipts, or grants permissions. All local host evidence is
 * self-reported and hash-checked, NOT independently authenticated.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants as C} from 'node:fs';
import {createHash} from 'node:crypto';

const sha=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{const e=new Error(code);e.code=code;return e;};
const HASH=/^[a-f0-9]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BACKENDS=Object.freeze(['qdrant','lancedb','vectra','milvus']);
const KINDS=Object.freeze(['control_plane_capture','physical_native_backup','native_disposable_restore',
 'source_inventory','restored_inventory','cooperating_writers','crash_uncertainty',
 'restart_persistence','scope_isolation','rollback_rehearsal','quiescence_review']);
const MAX_FILES=40,MAX_FILE=2*1024*1024;
export const F10B5_REQUIRED_EVIDENCE=KINDS;
export const F10B5_BACKENDS=BACKENDS;
function safeName(s){return typeof s==='string'&&s.length>=1&&s.length<=120&&
 /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(s)&&s!=='.'&&s!=='..';}
async function verifyAncestors(dir){
 let current=path.parse(dir).root;
 for(const component of path.relative(current,dir).split(path.sep).filter(Boolean)){
  current=path.join(current,component);
  const st=await fs.lstat(current);
  if(!st.isDirectory()||st.isSymbolicLink())throw fail('F10B5_ANCESTOR_UNTRUSTED');
 }
}
async function secureDir(dir){const st=await fs.lstat(dir);
 if(!st.isDirectory()||st.isSymbolicLink()||(process.platform!=='win32'&&(st.mode&0o077)!==0))throw fail('F10B5_DIRECTORY_UNTRUSTED');
}
async function secureRead(file){const st=await fs.lstat(file);
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size<1||st.size>MAX_FILE||
 (process.platform!=='win32'&&(st.mode&0o077)!==0))throw fail('F10B5_FILE_UNTRUSTED');
 const h=await fs.open(file,C.O_RDONLY|(C.O_NOFOLLOW??0));
 try{const begin=await h.stat();if(begin.ino!==st.ino||begin.dev!==st.dev||begin.size!==st.size||begin.nlink!==1)throw fail('F10B5_SOURCE_CHANGED');
  const buf=await h.readFile(),end=await h.stat();
  if(end.size!==begin.size||end.mtimeMs!==begin.mtimeMs||buf.length!==begin.size)throw fail('F10B5_SOURCE_CHANGED');
  return buf;
 }finally{await h.close();}
}
function json(buf){let o;try{o=JSON.parse(buf.toString('utf8'));}catch{throw fail('F10B5_INVALID_JSON');}
 if(!o||typeof o!=='object'||Array.isArray(o))throw fail('F10B5_INVALID_JSON');return o;
}
function validateInventory(buf,expected){const data=json(buf);
 if(data.schemaVersion!==1||data.backend!==expected||!Array.isArray(data.records)||
  data.records.length>100000)throw fail('F10B5_INVENTORY_INVALID');
 const ids=new Set();const rows=[];
 for(const r of data.records){
  if(!r||typeof r!=='object'||!safeName(r.id)||!Number.isSafeInteger(r.revision)||r.revision<0||
    !HASH.test(r.vectorSha256||'')||!HASH.test(r.metadataSha256||'')||ids.has(r.id))throw fail('F10B5_INVENTORY_INVALID');
  ids.add(r.id);rows.push([r.id,r.revision,r.vectorSha256,r.metadataSha256]);
 }
 rows.sort((a,b)=>a[0].localeCompare(b[0]));
 return {count:rows.length,fingerprint:sha(JSON.stringify(rows))};
}
function parseManifest(buf,backend,build){const doc=json(buf);
 if(doc.schemaVersion!==1||doc.checkpoint!=='F10b.5'||doc.backend!==backend||
  doc.environment!=='DISPOSABLE_HOST_ONLY'||!UUID.test(doc.hostRunId||'')||
  doc.pluginVersion!==build.pluginVersion||doc.extensionVersion!==build.extensionVersion||
  doc.pluginSourceFingerprint!==build.pluginSourceFingerprint||
  doc.restoreDestinationNewEmpty!==true||doc.productionActivationRequested!==false||
  doc.unresolvedOperationsReplayed!==false||doc.retainedLocksManuallyRemoved!==false||
  doc.unrelatedWritersProtected!==false||doc.cooperatingWritersOnly!==true||
  !Array.isArray(doc.artifacts)||doc.artifacts.length>MAX_FILES)throw fail('F10B5_MANIFEST_INVALID');
 let names=new Set(),kinds=new Set();
 for(const item of doc.artifacts){
  if(!item||!safeName(item.file)||!KINDS.includes(item.kind)||!HASH.test(item.sha256||'')||
   item.result!=='PASS'||names.has(item.file)||kinds.has(item.kind))throw fail('F10B5_MANIFEST_INVALID');
  names.add(item.file);kinds.add(item.kind);
 }
 return {doc,kinds};
}
function validateBuild(build){if(!build||typeof build!=='object'||
 !/^3\.2\.10-s10\.[0-9]+-f10b5$/.test(build.pluginVersion||'')||
 !/^2\.2\.0-alpha\.s11\.[0-9]+-f10b5$/.test(build.extensionVersion||'')||
 !HASH.test(build.pluginSourceFingerprint||''))throw fail('F10B5_BUILD_INVALID');
}
/** Only reads evidence from a private root. Missing evidence is a normal BLOCKED
 * result; malformed or tampered evidence is an explicit failure. It never
 * returns a certified/production-activated state, even if all files match. */
export async function assessF10b5HostEvidence({evidenceRoot,build}={}){
 if(typeof evidenceRoot!=='string'||!path.isAbsolute(evidenceRoot)||path.resolve(evidenceRoot)!==evidenceRoot||
  evidenceRoot===path.parse(evidenceRoot).root)throw fail('F10B5_ROOT_INVALID');
 validateBuild(build);
 await verifyAncestors(evidenceRoot);await secureDir(evidenceRoot);
 const results={};
 for(const backend of BACKENDS){
  const folder=path.join(evidenceRoot,backend);
  try{await secureDir(folder);}catch(e){if(e.code==='ENOENT'){
   results[backend]={status:'BLOCKED_MISSING_HOST_EVIDENCE',verifiedArtifacts:0,requiredArtifacts:KINDS.length,
    inventoryEqual:false,productionCertified:false};continue;}throw e;}
  const names=(await fs.readdir(folder)).sort();
  if(!names.includes('host-evidence.json')){
   if(names.length)throw fail('F10B5_UNEXPECTED_FILES');
   results[backend]={status:'BLOCKED_MISSING_HOST_EVIDENCE',verifiedArtifacts:0,requiredArtifacts:KINDS.length,
    inventoryEqual:false,productionCertified:false};continue;
  }
  const {doc,kinds}=parseManifest(await secureRead(path.join(folder,'host-evidence.json')),backend,build);
  const allowed=new Set(['host-evidence.json',...doc.artifacts.map(x=>x.file)]);
  if(names.length!==allowed.size||names.some(n=>!allowed.has(n)))throw fail('F10B5_UNEXPECTED_FILES');
  const content=new Map();
  for(const row of doc.artifacts){const bytes=await secureRead(path.join(folder,row.file));
   if(sha(bytes)!==row.sha256)throw fail('F10B5_ARTIFACT_TAMPERED');
   content.set(row.kind,bytes);
  }
  const missing=KINDS.filter(x=>!kinds.has(x));
  let inventoryEqual=false,inventoryCount=0;
  if(content.has('source_inventory')&&content.has('restored_inventory')){
   const source=validateInventory(content.get('source_inventory'),backend);
   const restored=validateInventory(content.get('restored_inventory'),backend);
   inventoryEqual=source.fingerprint===restored.fingerprint&&source.count===restored.count;
   inventoryCount=source.count;
  }
  results[backend]={status:missing.length?'BLOCKED_INCOMPLETE':!inventoryEqual?'BLOCKED_INVENTORY_MISMATCH':
   'READY_FOR_INDEPENDENT_MANUAL_REVIEW',verifiedArtifacts:content.size,requiredArtifacts:KINDS.length,
   missing,inventoryEqual,inventoryCount,productionCertified:false,independentHostAttestation:false,
   hostRunId:doc.hostRunId};
 }
 const eligible=BACKENDS.filter(b=>results[b].status==='READY_FOR_INDEPENDENT_MANUAL_REVIEW');
 return {checkpoint:'F10b.5',evidenceModel:'LOCAL_HASH_CHECKED_SELF_REPORTED_NOT_INDEPENDENT_ATTESTATION',
  results,eligibleForManualReview:eligible,allBackendsReadyForManualReview:eligible.length===BACKENDS.length,
  overall:'NO_GO_PRODUCTION',productionCertified:false,productionRestoreEnabled:false,
  retainedLockReleaseAllowed:false,receiptPromotionAllowed:false,mutationReplayAllowed:false,
  next:'INDEPENDENT_HOST_REVIEW_AND_UNIMPLEMENTED_NATIVE_RECOVERY_GATES'};
}
