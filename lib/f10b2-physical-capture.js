/** F10b.2 — bounded administrator-only PHYSICAL backup candidates.
 * No HTTP routes. Only F09c disposable fixtures. No restore, no production grant.
 * Qdrant uses the native collection snapshot endpoint; LanceDB/Vectra copy
 * local files under the same cooperating-writer lock as their F09c diagnostics.
 * Milvus has NO claimed complete export: requires a separately certified native
 * backup tool and a verified deployment-specific consistent cut.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants as C} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {CooperativeWriterBoundary} from './f09c5-writer-boundary.js';

const sha=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{const e=new Error(code);e.code=code;return e;};
const DISPOSABLE={
 qdrant:/^vh_f09c6_disposable_[a-f0-9]{32}$/,
 lancedb:/^vh_f09c7_disposable_[a-f0-9]{32}$/,
 vectra:/^vh_f09c8_disposable_[a-f0-9]{32}$/
};
const MAX_FILES=1500,MAX_BYTES=128*1024*1024,MAX_FILE=64*1024*1024;
const CONSENT='F10B2_I_CONFIRM_DISPOSABLE_BACKUP_ONLY';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeRelative=r=>typeof r==='string'&&r.length<512&&!r.includes('\\')&&!r.startsWith('/')&&
 r.split('/').every(x=>x&&x!=='.'&&x!=='..'&&!x.includes('\0'));
const validHex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function exactPrivatePath(p){
 if(typeof p!=='string'||!path.isAbsolute(p)||p!==path.resolve(p)||p===path.parse(p).root)throw fail('F10B2_PATH_INVALID');
 return p;
}
async function privateDir(p){
 const s=await fs.lstat(p);
 if(!s.isDirectory()||s.isSymbolicLink()||(process.platform!=='win32'&&(s.mode&0o077)))throw fail('F10B2_UNTRUSTED_DIRECTORY');
}
async function safeAncestors(p){
 let current=path.parse(p).root;
 for(const part of path.relative(current,p).split(path.sep).filter(Boolean)){
  current=path.join(current,part);
  const s=await fs.lstat(current);
  if(!s.isDirectory()||s.isSymbolicLink())throw fail('F10B2_PATH_SYMLINK');
 }
}
async function readSafe(file,max=MAX_FILE){
 const s=await fs.lstat(file);
 if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>max||
 (process.platform!=='win32'&&(s.mode&0o022)))throw fail('F10B2_UNTRUSTED_FILE');
 const h=await fs.open(file,C.O_RDONLY|(C.O_NOFOLLOW??0));
 try{
  const check=await h.stat();
  if(check.dev!==s.dev||check.ino!==s.ino||check.size!==s.size||check.nlink!==1)throw fail('F10B2_SOURCE_CHANGED');
  const bytes=await h.readFile();
  if(bytes.length!==s.size)throw fail('F10B2_SOURCE_CHANGED');
  return bytes;
 }finally{await h.close();}
}
async function writeSafe(file,bytes){const h=await fs.open(file,'wx',0o600);try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}}
async function mkdirSafe(p){await fs.mkdir(p,{mode:0o700});await privateDir(p);}
async function syncDir(p){if(process.platform==='win32')return;const h=await fs.open(p,'r');try{await h.sync();}finally{await h.close();}}
async function boundedTree(root){
 const found=[];let total=0;
 async function walk(dir,relative='',depth=0){
  if(depth>12)throw fail('F10B2_TREE_TOO_DEEP');
  await privateDir(dir);
  const names=(await fs.readdir(dir)).sort();
  if(depth>0&&!names.length)throw fail('F10B2_EMPTY_DIRECTORY_NOT_COPIED');
  for(const name of names){
   if(!name||name==='.'||name==='..'||name.length>200)throw fail('F10B2_NAME_INVALID');
   const rel=relative?relative+'/'+name:name;
   if(!safeRelative(rel))throw fail('F10B2_NAME_INVALID');
   const filename=path.join(dir,name),st=await fs.lstat(filename);
   if(st.isSymbolicLink())throw fail('F10B2_SYMLINK_REFUSED');
   if(st.isDirectory()){await walk(filename,rel,depth+1);continue;}
   if(!st.isFile()||st.nlink!==1)throw fail('F10B2_SPECIAL_FILE_REFUSED');
   const bytes=await readSafe(filename);
   total+=bytes.length;
   if(total>MAX_BYTES||found.length>=MAX_FILES)throw fail('F10B2_SIZE_LIMIT');
   found.push({relative:rel,bytes,sha256:sha(bytes)});
  }
 }
 await walk(root);
 if(!found.length)throw fail('F10B2_EMPTY_SOURCE');
 return found;
}
function fileList(entries){return entries.map(({relative,bytes,sha256})=>({relative,size:bytes.length,sha256}));}
function matchList(a,b){return a.length===b.length&&a.every((x,i)=>x.relative===b[i].relative&&x.size===b[i].size&&x.sha256===b[i].sha256);}
async function reserve(backupRoot){
 exactPrivatePath(backupRoot);await safeAncestors(backupRoot);await privateDir(backupRoot);
 const id=randomUUID();const location=path.join(backupRoot,'f10b2-'+id);
 await mkdirSafe(location);
 return {id,location};
}
async function persistManifest(location,manifest){
 const bytes=Buffer.from(JSON.stringify(manifest)+'\n');await writeSafe(path.join(location,'manifest.json'),bytes);
 await syncDir(location);
}
function makeManifest(id,backend,source,files,mechanism){return {schemaVersion:1,mode:'F10B2_DISPOSABLE_BACKUP_CANDIDATE',id,
 backend,source,mechanism,files,fileListDigest:sha(JSON.stringify(files)),restoresLiveData:false,
 productionCertified:false,completeRestorableDatabase:false,
 externalWriterConsistency:'NOT_GUARANTEED_OUTSIDE_COOPERATING_VECTHARE_WRITERS'};}
export function validateF10b2Input(options={}){
 const {backend,disposableName,consent,backupRoot}=options;
 if(consent!==CONSENT)throw fail('F10B2_CONSENT_REQUIRED');
 if(!Object.hasOwn(DISPOSABLE,backend)||!DISPOSABLE[backend].test(disposableName||''))throw fail('F10B2_NOT_DISPOSABLE');
 exactPrivatePath(backupRoot);
 return Object.freeze({backend,disposableName,backupRoot});
}
/** Cold/cooperating-writer-local backup: accepts only F09c.7/.8 disposable dirs.
 * Host must stop unrelated writers and background compaction to claim consistency.
 * Recheck every source byte after copy. Never restore or remove source.
 */
export async function captureDisposableLocal(options={}){
 const {backend,disposableName,backupRoot}=validateF10b2Input(options);
 if(!['lancedb','vectra'].includes(backend))throw fail('F10B2_BACKEND_NOT_LOCAL');
 if(options.operatorDeclaredQuiescent!==true)throw fail('F10B2_QUIESCENCE_CONFIRMATION_REQUIRED');
 const parent=exactPrivatePath(options.disposableParent);
 await safeAncestors(parent);await privateDir(parent);
 await safeAncestors(backupRoot);await privateDir(backupRoot);
 // Backups must not be nested under sources or vice versa.
 const source=path.join(parent,disposableName);
 if(backupRoot===parent||backupRoot===source||backupRoot.startsWith(source+path.sep)||source.startsWith(backupRoot+path.sep))throw fail('F10B2_OVERLAPPING_ROOTS');
 await privateDir(source);
 const physicalName=backend==='vectra'?disposableName:'vh_f09c7_probe_'+disposableName.slice(-12);
 const key=backend==='vectra'?sha(JSON.stringify([parent,disposableName,'plugin-vectra-only'])):
  sha(JSON.stringify([source,'vh_f09c7_probe']));
 const lock=new CooperativeWriterBoundary({root:path.join(parent,'writer-locks'),backend,physicalName});
 const plan={backend,physicalCollectionName:physicalName,collectionKey:key};
 let result;
 await lock.withWriteBoundary(plan,async()=>{
  const before=await boundedTree(source);
  const {id,location}=await reserve(backupRoot);
  // Retain partial snapshot on error for forensic inspection; no auto cleanup.
  const dataRoot=path.join(location,'data');await mkdirSafe(dataRoot);
  for(const row of before){
   const components=row.relative.split('/');let folder=dataRoot;
   for(const component of components.slice(0,-1)){
    folder=path.join(folder,component);
    try{await mkdirSafe(folder);}catch(e){if(e.code!=='EEXIST')throw e;await privateDir(folder);}
   }
   await writeSafe(path.join(folder,components.at(-1)),row.bytes);
  }
  const after=await boundedTree(source);
  const copied=await boundedTree(dataRoot);
  if(!matchList(fileList(before),fileList(after))||!matchList(fileList(before),fileList(copied)))throw fail('F10B2_SOURCE_CHANGED');
  const files=fileList(before);
  const manifest=makeManifest(id,backend,disposableName,files,'COOPERATIVE_LOCK_LOCAL_FILE_COPY_NOT_NATIVE_SNAPSHOT');
  manifest.operatorDeclaredQuiescent=true;
  await persistManifest(location,manifest);await syncDir(backupRoot);
  result={id,backend,files:files.length,bytes:files.reduce((n,x)=>n+x.size,0),
   location,backupVerified:true,productionCertified:false,restoreAllowed:false};
  return {state:'VERIFIED'};
 });
 return result;
}
function endpointURL(endpoint){
 let u;try{u=new URL(endpoint);}catch{throw fail('F10B2_QDRANT_ENDPOINT_INVALID');}
 if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.pathname!=='/'||u.search||u.hash||u.username||u.password)
  throw fail('F10B2_QDRANT_LOOPBACK_REQUIRED');
 return u.origin;
}
/** Native Qdrant snapshot archive candidate. Snapshot creation is a server
 * admin operation. Restricts name to fresh F09c.6 fixtures and transport to
 * literal loopback; never deletes snapshots or calls restore endpoints.
 */
export async function captureDisposableQdrant(options={},fetchFn=globalThis.fetch){
 const {backend,disposableName,backupRoot}=validateF10b2Input(options);
 if(backend!=='qdrant')throw fail('F10B2_NOT_QDRANT');
 const origin=endpointURL(options.endpoint);
 if(typeof fetchFn!=='function')throw fail('F10B2_FETCH_UNAVAILABLE');
 if(options.apiKey!==undefined&&typeof options.apiKey!=='string')throw fail('F10B2_KEY_INVALID');
 await safeAncestors(backupRoot);await privateDir(backupRoot);
 const headers={accept:'application/json',...(options.apiKey?{'api-key':options.apiKey}:{})};
 const base='/collections/'+disposableName;
 async function call(method,p,acceptBinary=false){
  let response;
  try{response=await fetchFn(origin+p,{method,redirect:'manual',headers,
   signal:AbortSignal.timeout(20000)});}catch{throw fail('F10B2_QDRANT_OUTCOME_UNCERTAIN');}
  if(!response||response.status<200||response.status>=300)throw fail('F10B2_QDRANT_HTTP_ERROR');
  if(!acceptBinary){let data;try{data=await response.json();}catch{throw fail('F10B2_QDRANT_RESPONSE_INVALID');}
   if(!data||data.status==='error')throw fail('F10B2_QDRANT_RESPONSE_INVALID');return data;}
  return response;
 }
 // Confirm source exists *before* snapshot creation. Never create a collection.
 const pre=await call('GET',base);
 if(!pre.result||typeof pre.result!=='object')throw fail('F10B2_QDRANT_SOURCE_MISSING');
 const {id,location}=await reserve(backupRoot);
 // POST can be uncertain; leave the source snapshot for investigation.
 const created=await call('POST',base+'/snapshots');
 const snapshotName=created.result?.name;
 if(typeof snapshotName!=='string'||!/^[-A-Za-z0-9_.]{1,160}$/.test(snapshotName)||snapshotName==='.'||snapshotName==='..')
  throw fail('F10B2_QDRANT_SNAPSHOT_RESPONSE_INVALID');
 const response=await call('GET',base+'/snapshots/'+encodeURIComponent(snapshotName),true);
 const filename=path.join(location,'snapshot.bin');
 const h=await fs.open(filename,'wx',0o600);
 let bytes=0;const hash=createHash('sha256');
 try{
  if(!response.body||typeof response.body.getReader!=='function')throw fail('F10B2_QDRANT_STREAM_INVALID');
  const reader=response.body.getReader();
  while(true){const {done,value}=await reader.read();if(done)break;
   if(!(value instanceof Uint8Array))throw fail('F10B2_QDRANT_STREAM_INVALID');
   bytes+=value.byteLength;if(bytes>MAX_BYTES)throw fail('F10B2_SIZE_LIMIT');
   let offset=0;
   while(offset<value.byteLength){
    const {bytesWritten}=await h.write(value,offset,value.byteLength-offset);
    if(bytesWritten<=0)throw fail('F10B2_QDRANT_SHORT_WRITE');
    offset+=bytesWritten;
   }
   hash.update(value);
  }
  if(!bytes)throw fail('F10B2_EMPTY_SOURCE');
  await h.sync();
 }finally{await h.close();}
 const files=[{relative:'snapshot.bin',size:bytes,sha256:hash.digest('hex')}];
 const manifest=makeManifest(id,'qdrant',disposableName,files,'QDRANT_COLLECTION_SNAPSHOT_API_NO_RESTORE');
 manifest.remoteSnapshotName=snapshotName;
 await persistManifest(location,manifest);await syncDir(backupRoot);
 return {id,backend:'qdrant',files:1,bytes,location,backupVerified:true,remoteSnapshotName:snapshotName,
  productionCertified:false,restoreAllowed:false};
}
/** Milvus explicitly lacks an implemented authoritative collection backup
 * here. Do not present query/page exports as a consistent physical snapshot. */
export function assessMilvusF10b2(){return Object.freeze({backend:'milvus',snapshotImplemented:false,
  code:'F10B2_MILVUS_BACKUP_TOOL_REQUIRED',productionCertified:false,restoreAllowed:false});}
export async function verifyF10b2Capture({backupRoot,id}){
 exactPrivatePath(backupRoot);if(!uuid.test(id||''))throw fail('F10B2_ID_INVALID');
 await safeAncestors(backupRoot);await privateDir(backupRoot);
 const location=path.join(backupRoot,'f10b2-'+id);await privateDir(location);
 const bytes=await readSafe(path.join(location,'manifest.json'));
 let m;try{m=JSON.parse(bytes.toString());}catch{throw fail('F10B2_MANIFEST_INVALID');}
 if(m?.schemaVersion!==1||m.mode!=='F10B2_DISPOSABLE_BACKUP_CANDIDATE'||m.id!==id||
  m.restoresLiveData!==false||m.productionCertified!==false||m.completeRestorableDatabase!==false||
  !Object.hasOwn(DISPOSABLE,m.backend)||!DISPOSABLE[m.backend].test(m.source||'')||
  !Array.isArray(m.files)||!m.files.length||m.files.length>MAX_FILES||
  m.fileListDigest!==sha(JSON.stringify(m.files)))throw fail('F10B2_MANIFEST_INVALID');
 if(m.backend==='qdrant'&&(!/^[-A-Za-z0-9_.]{1,160}$/.test(m.remoteSnapshotName||'')||m.files.length!==1))
  throw fail('F10B2_MANIFEST_INVALID');
 const seen=new Set();let total=0;
 for(const row of m.files){
  if(!safeRelative(row?.relative)||seen.has(row.relative)||!validHex(row.sha256)||
    !Number.isSafeInteger(row.size)||row.size<0||row.size>MAX_FILE && m.backend!=='qdrant')throw fail('F10B2_MANIFEST_INVALID');
  if(m.backend==='qdrant'&&row.relative!=='snapshot.bin')throw fail('F10B2_MANIFEST_INVALID');
  seen.add(row.relative);total+=row.size;if(total>MAX_BYTES)throw fail('F10B2_SIZE_LIMIT');
 }
 const expected=new Set(['manifest.json',m.backend==='qdrant'?'snapshot.bin':'data']);
 const actual=await fs.readdir(location);
 if(actual.length!==expected.size||actual.some(x=>!expected.has(x)))throw fail('F10B2_CAPTURE_TAMPERED');
 if(m.backend==='qdrant'){
  const data=await readSafe(path.join(location,'snapshot.bin'),MAX_BYTES);
  if(data.length!==m.files[0].size||sha(data)!==m.files[0].sha256)throw fail('F10B2_CAPTURE_TAMPERED');
 }else{
  const actualTree=fileList(await boundedTree(path.join(location,'data')));
  if(!matchList(m.files,actualTree))throw fail('F10B2_CAPTURE_TAMPERED');
 }
 return {id,backend:m.backend,files:m.files.length,bytes:total,integrityVerified:true,
   physicallyRestored:false,productionCertified:false};
}
export const F10B2_CONSENT=CONSENT;
