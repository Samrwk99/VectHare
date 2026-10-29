/** F10b.3: strict OFFLINE restore staging for verified F10b.2 disposable captures.
 * Local LanceDB/Vectra: byte-exact reconstruction in a NEW, private and inert
 * directory. Qdrant: verify and stage native snapshot bytes ONLY; no Qdrant API
 * restore, no collection creation, no upload, no activation, no live data writes.
 * Milvus: not supported until official backup integration exists.
 * Hashes are integrity checks, not cryptographic authentication of provenance.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants as C} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {verifyF10b2Capture} from './f10b2-physical-capture.js';

const fail=code=>{const e=new Error(code);e.code=code;return e;};
const sha=x=>createHash('sha256').update(x).digest('hex');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONSENT='F10B3_I_CONFIRM_NEW_DISPOSABLE_RESTORE_STAGING_ONLY';
const MAX_BYTES=128*1024*1024,MAX_FILES=1500,MAX_FILE=64*1024*1024;
const SOURCE={qdrant:/^vh_f09c6_disposable_[a-f0-9]{32}$/,
 lancedb:/^vh_f09c7_disposable_[a-f0-9]{32}$/,
 vectra:/^vh_f09c8_disposable_[a-f0-9]{32}$/};
function exact(p){if(typeof p!=='string'||!path.isAbsolute(p)||path.resolve(p)!==p||p===path.parse(p).root)
 throw fail('F10B3_PATH_INVALID');return p;}
async function privateDir(p){const s=await fs.lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||
 (process.platform!=='win32'&&(s.mode&0o077)))throw fail('F10B3_UNTRUSTED_DIRECTORY');}
async function ancestors(p){let c=path.parse(p).root;for(const item of path.relative(c,p).split(path.sep).filter(Boolean)){
 c=path.join(c,item);const s=await fs.lstat(c);if(!s.isDirectory()||s.isSymbolicLink())throw fail('F10B3_PATH_SYMLINK');}}
function relative(p){return typeof p==='string'&&p.length<512&&!p.includes('\\')&&!p.startsWith('/')&&
 p.split('/').every(x=>x&&x!=='.'&&x!=='..'&&!x.includes('\0'));}
async function read(file,max=MAX_FILE){const st=await fs.lstat(file);
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>max||
 (process.platform!=='win32'&&(st.mode&0o022)))throw fail('F10B3_UNTRUSTED_FILE');
 const h=await fs.open(file,C.O_RDONLY|(C.O_NOFOLLOW??0));try{
  const st2=await h.stat();if(st.dev!==st2.dev||st.ino!==st2.ino||st.size!==st2.size||st2.nlink!==1)
   throw fail('F10B3_SOURCE_CHANGED');
  const bytes=await h.readFile();if(bytes.length!==st.size)throw fail('F10B3_SOURCE_CHANGED');return bytes;
 }finally{await h.close();}}
async function write(file,buf){const h=await fs.open(file,'wx',0o600);try{await h.writeFile(buf);await h.sync();}finally{await h.close();}}
async function mkdir(file){await fs.mkdir(file,{mode:0o700});await privateDir(file);}
async function sync(file){if(process.platform==='win32')return;const h=await fs.open(file,'r');try{await h.sync();}finally{await h.close();}}
function noOverlap(a,b){return a!==b&&!a.startsWith(b+path.sep)&&!b.startsWith(a+path.sep);}
async function strictTree(root){let count=0,total=0;const found=[];
 async function walk(dir,rel='',depth=0){if(depth>12)throw fail('F10B3_TREE_TOO_DEEP');await privateDir(dir);
  for(const n of (await fs.readdir(dir)).sort()){
   const r=rel?rel+'/'+n:n;if(!relative(r)||n.length>200)throw fail('F10B3_INVALID_NAME');
   const file=path.join(dir,n),st=await fs.lstat(file);
   if(st.isSymbolicLink())throw fail('F10B3_UNTRUSTED_FILE');
   if(st.isDirectory()){await walk(file,r,depth+1);continue;}
   if(!st.isFile())throw fail('F10B3_UNTRUSTED_FILE');
   const bytes=await read(file);total+=bytes.length;if(++count>MAX_FILES||total>MAX_BYTES)throw fail('F10B3_SIZE_LIMIT');
   found.push({relative:r,size:bytes.length,sha256:sha(bytes)});
  }
 }
 await walk(root);return found;
}
function equal(a,b){return JSON.stringify(a)===JSON.stringify(b);}
/** Always creates an unpredictable NEW staging dir; operator supplies only a
 * private staging ROOT, never a final collection/table name or live path. */
export async function stageF10b3DisposableRestore(options={}){
 const {backupRoot,restoreRoot,id,consent}=options;
 if(consent!==CONSENT)throw fail('F10B3_CONSENT_REQUIRED');
 if(!UUID.test(id||''))throw fail('F10B3_ID_INVALID');
 exact(backupRoot);exact(restoreRoot);
 if(!noOverlap(backupRoot,restoreRoot))throw fail('F10B3_OVERLAPPING_ROOTS');
 await ancestors(backupRoot);await ancestors(restoreRoot);await privateDir(backupRoot);await privateDir(restoreRoot);
 // Mandatory complete F10b.2 verification occurs BEFORE creating any output.
 const verified=await verifyF10b2Capture({backupRoot,id});
 const location=path.join(backupRoot,'f10b2-'+id);
 const original=await read(path.join(location,'manifest.json'));
 let m;try{m=JSON.parse(original.toString());}catch{throw fail('F10B3_MANIFEST_INVALID');}
 if(!Object.hasOwn(SOURCE,m.backend)||!SOURCE[m.backend].test(m.source||'')||
  verified.backend!==m.backend||!Array.isArray(m.files)||m.files.length>MAX_FILES||!m.files.length)
  throw fail('F10B3_MANIFEST_INVALID');
 const digest=sha(original);
 const idOut=randomUUID(),dest=path.join(restoreRoot,'f10b3-'+idOut);
 await mkdir(dest); // Retain any partial state on error; never delete a possibly uncertain restore.
 const destination=path.join(dest,m.backend==='qdrant'?'snapshot.bin':'database');
 let copied=0;
 if(m.backend==='qdrant'){
  // NO Qdrant database restore; only preserve validated archive for later offline inspection.
  const bytes=await read(path.join(location,'snapshot.bin'),MAX_BYTES);
  if(bytes.length!==m.files[0].size||sha(bytes)!==m.files[0].sha256)throw fail('F10B3_CAPTURE_CHANGED');
  await write(destination,bytes);copied=bytes.length;
  const output=await read(destination,MAX_BYTES);
  if(!output.equals(bytes))throw fail('F10B3_STAGING_MISMATCH');
 }else{
  await mkdir(destination);
  for(const row of m.files){
   if(!relative(row.relative))throw fail('F10B3_MANIFEST_INVALID');
   const source=path.join(location,'data',...row.relative.split('/'));
   const bytes=await read(source);
   if(bytes.length!==row.size||sha(bytes)!==row.sha256)throw fail('F10B3_CAPTURE_CHANGED');
   let folder=destination;
   for(const segment of row.relative.split('/').slice(0,-1)){
    folder=path.join(folder,segment);
    try{await mkdir(folder);}catch(e){if(e.code!=='EEXIST')throw e;await privateDir(folder);}
   }
   await write(path.join(folder,row.relative.split('/').at(-1)),bytes);
   copied+=bytes.length;if(copied>MAX_BYTES)throw fail('F10B3_SIZE_LIMIT');
  }
  const actual=await strictTree(destination);
  if(!equal(actual,m.files))throw fail('F10B3_STAGING_MISMATCH');
 }
 // Reverify original after copy to catch changed manifests and altered source.
 await verifyF10b2Capture({backupRoot,id});
 if(sha(await read(path.join(location,'manifest.json')))!==digest)throw fail('F10B3_CAPTURE_CHANGED');
 const receipt={schemaVersion:1,mode:'F10B3_OFFLINE_DISPOSABLE_STAGING_ONLY',id:idOut,
  captureId:id,backend:m.backend,source:m.source,captureManifestSha256:digest,
  files:m.files,bytes:copied,staged:true,sourceInventoryVerified:false,
  restoredIntoRunningBackend:false,productionCertified:false,
  restoreMechanism:m.backend==='qdrant'?'QDRANT_SNAPSHOT_ARCHIVE_STAGED_ONLY':'COLD_LOCAL_FILES_BYTE_EXACT_STAGING',
  noAutomaticActivation:true};
 await write(path.join(dest,'restore-receipt.json'),Buffer.from(JSON.stringify(receipt)+'\n'));
 await sync(m.backend==='qdrant'?dest:destination);await sync(dest);await sync(restoreRoot);
 return {id:idOut,captureId:id,backend:m.backend,location:dest,bytes:copied,files:m.files.length,
  staged:true,stagingIntegrityVerified:true,restoredIntoRunningBackend:false,productionCertified:false};
}
/** Verify a previously staged result without activating databases or resolving any lock. */
export async function verifyF10b3Staging({restoreRoot,id}={}){
 exact(restoreRoot);if(!UUID.test(id||''))throw fail('F10B3_ID_INVALID');
 await ancestors(restoreRoot);await privateDir(restoreRoot);
 const dest=path.join(restoreRoot,'f10b3-'+id);await privateDir(dest);
 const bytes=await read(path.join(dest,'restore-receipt.json'));
 let r;try{r=JSON.parse(bytes.toString());}catch{throw fail('F10B3_RECEIPT_INVALID');}
 if(r?.schemaVersion!==1||r.mode!=='F10B3_OFFLINE_DISPOSABLE_STAGING_ONLY'||r.id!==id||
  !Object.hasOwn(SOURCE,r.backend)||!SOURCE[r.backend].test(r.source||'')||
  !UUID.test(r.captureId||'')||r.restoredIntoRunningBackend!==false||r.productionCertified!==false||
  r.noAutomaticActivation!==true||!Array.isArray(r.files)||!r.files.length||r.files.length>MAX_FILES)
  throw fail('F10B3_RECEIPT_INVALID');
 if(r.files.some(x=>!relative(x.relative)||!Number.isSafeInteger(x.size)||x.size<0||
  !/^[a-f0-9]{64}$/.test(x.sha256)))throw fail('F10B3_RECEIPT_INVALID');
 const expected=r.backend==='qdrant'?['restore-receipt.json','snapshot.bin']:['database','restore-receipt.json'];
 if(!equal((await fs.readdir(dest)).sort(),expected))throw fail('F10B3_STAGING_TAMPERED');
 if(r.backend==='qdrant'){
  if(r.files.length!==1||r.files[0].relative!=='snapshot.bin')throw fail('F10B3_RECEIPT_INVALID');
  const file=await read(path.join(dest,'snapshot.bin'),MAX_BYTES);
  if(file.length!==r.files[0].size||sha(file)!==r.files[0].sha256)throw fail('F10B3_STAGING_TAMPERED');
 }else{
  const tree=await strictTree(path.join(dest,'database'));
  if(!equal(tree,r.files))throw fail('F10B3_STAGING_TAMPERED');
 }
 return {id,backend:r.backend,stagingIntegrityVerified:true,restoredIntoRunningBackend:false,
  productionCertified:false,sourceInventoryVerified:false};
}
export const F10B3_CONSENT=CONSENT;
