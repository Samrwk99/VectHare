/** F10b.1: private local control-plane recovery rehearsal.
 * NOT a database snapshot, production restore, credential backup, or lock reset.
 * Never overwrites live files, calls backend write APIs, or clears uncertain intents.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants as C} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {CollectionRegistry} from './s02-registry.js';

const hash=x=>createHash('sha256').update(x).digest('hex');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX=/^[a-f0-9]{64}$/;
const LIMIT_FILES=600, LIMIT_BYTES=16*1024*1024, LIMIT_FILE=1024*1024;
const AREAS=Object.freeze({
 's04-operations':x=>UUID.test(x.replace(/\.json$/,''))&&x.endsWith('.json'),
 'f09b4-managed':x=>HEX.test(x.replace(/\.json$/,''))&&x.endsWith('.json'),
 's02-registry':x=>['s02-collection-registry.json','s02-registry.initialized'].includes(x),
});
export class F10bError extends Error{
 constructor(code){super(code);this.code=code;this.status=409;}
}
function deny(code){throw new F10bError(code);}
async function statDirectory(dir){
 const st=await fs.lstat(dir);
 if(!st.isDirectory()||st.isSymbolicLink()||(process.platform!=='win32'&&(st.mode&0o077)))deny('F10B_DIRECTORY_UNTRUSTED');
}
async function privateRoot(context){
 if(!context||!path.isAbsolute(context.vectorsPath||'')||typeof context.userScopeId!=='string'||!context.userScopeId)deny('F10B_CONTEXT_INVALID');
 // The host validates the vectors directory. F10b requires it to be private too,
 // because captured metadata and receipt plans may contain sensitive text.
 await statDirectory(context.vectorsPath);
 const parent=path.join(context.vectorsPath,'.similharity');
 await statDirectory(parent);
 return parent;
}
async function readRegular(filename,max=LIMIT_FILE){
 const st=await fs.lstat(filename);
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>max||
   (process.platform!=='win32'&&(st.mode&0o077)))deny('F10B_FILE_UNTRUSTED');
 const handle=await fs.open(filename,C.O_RDONLY|(C.O_NOFOLLOW??0));
 try{
  const now=await handle.stat();
  if(now.ino!==st.ino||now.dev!==st.dev||now.size!==st.size||now.nlink!==1)deny('F10B_SOURCE_CHANGED');
  const bytes=await handle.readFile();
  if(bytes.length!==st.size)deny('F10B_SOURCE_CHANGED');
  return bytes;
 }finally{await handle.close();}
}
function verifyJson(relative,bytes,owner){
 let doc;try{doc=JSON.parse(bytes.toString('utf8'));}catch{deny('F10B_STATE_CORRUPT');}
 if(!doc||typeof doc!=='object'||Array.isArray(doc))deny('F10B_STATE_CORRUPT');
 if(relative==='s02-registry/s02-collection-registry.json'){
  if(doc.schemaVersion!==2||!Array.isArray(doc.entries)||doc.entries.length>100000)deny('F10B_STATE_CORRUPT');
  return;
 }
 const {checksum,...payload}=doc;
 if(!HEX.test(checksum||'')||hash(JSON.stringify(payload))!==checksum)deny('F10B_STATE_CORRUPT');
 if(relative.startsWith('s04-operations/')){
  const id=relative.split('/')[1].slice(0,-5);
  if(doc.schemaVersion!==4||doc.owner!==owner||doc.operationId!==id||
    doc.plan?.scope?.userScopeId!==owner||
    !['VERIFIED','FAILED'].includes(doc.state))deny('F10B_PENDING_OPERATION');
 }else if(relative.startsWith('f09b4-managed/')){
  const key=relative.split('/')[1].slice(0,-5);
  if(doc.schemaVersion!==1||doc.owner!==owner||doc.collectionKey!==key||
    !doc.records||typeof doc.records!=='object'||Array.isArray(doc.records)||
    Object.values(doc.records).some(v=>!v||!['ACTIVE','DELETED'].includes(v.state)))deny('F10B_PENDING_MANAGED_RECORD');
 }
}
async function scan(base,context){
 const state=[];
 for(const [area,valid] of Object.entries(AREAS)){
  const dir=area==='s02-registry'?base:path.join(base,area);
  let names;try{await statDirectory(dir);names=area==='s02-registry'
    ?(await fs.readdir(dir)).filter(x=>valid(x)).sort():(await fs.readdir(dir)).sort();}
  catch(e){if(e.code==='ENOENT')continue;throw e;}
  if(area==='s02-registry' && names.length){
   if(!names.includes('s02-collection-registry.json')||!names.includes('s02-registry.initialized'))deny('F10B_REGISTRY_INCOMPLETE');
   try{await new CollectionRegistry(base).read();}catch{deny('F10B_REGISTRY_INVALID');}
  }
  for(const name of names){
   if(!valid(name))deny('F10B_UNEXPECTED_STATE_ENTRY');
   const relative=`${area}/${name}`,bytes=await readRegular(path.join(dir,name));
   if(name!=='s02-registry.initialized')verifyJson(relative,bytes,context.userScopeId);
   else if(bytes.length)deny('F10B_REGISTRY_INVALID');
   state.push({relative,bytes,sha256:hash(bytes)});
   if(state.length>LIMIT_FILES||state.reduce((n,r)=>n+r.bytes.length,0)>LIMIT_BYTES)deny('F10B_LIMIT_EXCEEDED');
  }
 }
 // Do not copy or export server credentials, saved-chat text, physical database files,
 // embedding profiles, external dependency state, or any lock/temporary files.
 return state;
}
async function checkQuiescent(base){
 const locks=path.join(base,'f09c10-writer-locks');
 try{
  await statDirectory(locks);
  if((await fs.readdir(locks)).length)deny('F10B_WRITER_LOCK_PRESENT');
 }catch(e){if(e.code!=='ENOENT')throw e;}
 for(const area of Object.keys(AREAS)){
  const dir=path.join(base,area);
  try{
   await statDirectory(dir);
   if((await fs.readdir(dir)).some(n=>n.startsWith('.lock-')||n.startsWith('.tmp-')))deny('F10B_STATE_IN_PROGRESS');
  }catch(e){if(e.code!=='ENOENT')throw e;}
 }
}
async function fsyncDir(dir){if(process.platform==='win32')return;const h=await fs.open(dir,'r');try{await h.sync();}finally{await h.close();}}
async function mkdirPrivate(dir){await fs.mkdir(dir,{mode:0o700});await statDirectory(dir);}
async function writePrivate(file,bytes){const h=await fs.open(file,'wx',0o600);try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}}
function validateManifest(manifest,owner,id){
 if(manifest?.schemaVersion!==1||manifest.mode!=='F10B_CONTROL_PLANE_REHEARSAL_ONLY'||
 manifest.owner!==owner||manifest.id!==id||manifest.restoresLiveData!==false||
 manifest.vectorBackupComplete!==false||!Array.isArray(manifest.files)||manifest.files.length>LIMIT_FILES)
  deny('F10B_MANIFEST_INVALID');
 let total=0;const seen=new Set();
 for(const row of manifest.files){
  if(!row||typeof row.relative!=='string'||!HEX.test(row.sha256||'')||
   !Number.isSafeInteger(row.size)||row.size<0||row.size>LIMIT_FILE||seen.has(row.relative))deny('F10B_MANIFEST_INVALID');
  const [area,name,...extra]=row.relative.split('/');
  if(extra.length||!Object.hasOwn(AREAS,area)||!AREAS[area](name))deny('F10B_MANIFEST_INVALID');
  total+=row.size;seen.add(row.relative);
 }
 if(total>LIMIT_BYTES)deny('F10B_LIMIT_EXCEEDED');
}
/** Trusted administrative code only. Intentionally not exported via any HTTP route. */
export class F10bRecoveryRehearsal{
 constructor(context){this.context=context;}
 async root(){const parent=await privateRoot(this.context);const dir=path.join(parent,'f10b-rehearsals');
  try{await mkdirPrivate(dir);}catch(e){if(e.code!=='EEXIST')throw e;await statDirectory(dir);}
  return {parent,dir};
 }
 async capture(){
  const {parent,dir}=await this.root();
  await checkQuiescent(parent);const first=await scan(parent,this.context);
  await checkQuiescent(parent);const second=await scan(parent,this.context);
  if(first.length!==second.length||first.some((x,i)=>x.relative!==second[i].relative||x.sha256!==second[i].sha256))deny('F10B_SOURCE_CHANGED');
  const id=randomUUID(),captureDir=path.join(dir,id);
  await mkdirPrivate(captureDir);
  const files=second.map(x=>({relative:x.relative,size:x.bytes.length,sha256:x.sha256}));
  const manifest={schemaVersion:1,mode:'F10B_CONTROL_PLANE_REHEARSAL_ONLY',id,
   owner:this.context.userScopeId,files,restoresLiveData:false,vectorBackupComplete:false,
   remoteBackendQuiescence:'UNVERIFIED',captureDigest:hash(JSON.stringify(files))};
  try{
   for(const row of second){const [area,name]=row.relative.split('/');
    const folder=path.join(captureDir,area);
    try{await mkdirPrivate(folder);}catch(e){if(e.code!=='EEXIST')throw e;}
    await writePrivate(path.join(folder,name),row.bytes);
   }
   await writePrivate(path.join(captureDir,'manifest.json'),Buffer.from(JSON.stringify(manifest)+'\n'));
   await fsyncDir(captureDir);await fsyncDir(dir);
  }catch(e){ // Never delete an incomplete capture automatically: preserve forensic evidence.
   throw e;
  }
  await checkQuiescent(parent);
  return {id,files:files.length,bytes:files.reduce((n,x)=>n+x.size,0),
   captureDigest:manifest.captureDigest,mode:manifest.mode,liveRestoreAllowed:false};
 }
 async verify(id){
  if(!UUID.test(id||''))deny('F10B_ID_INVALID');
  const {dir}=await this.root(),location=path.join(dir,id);
  await statDirectory(location);
  const manifestBytes=await readRegular(path.join(location,'manifest.json'),LIMIT_FILE);
  let manifest;try{manifest=JSON.parse(manifestBytes.toString('utf8'));}catch{deny('F10B_MANIFEST_INVALID');}
  validateManifest(manifest,this.context.userScopeId,id);
  if(manifest.captureDigest!==hash(JSON.stringify(manifest.files)))deny('F10B_MANIFEST_TAMPERED');
  const expected=new Map();
  for(const row of manifest.files){
   const file=path.join(location,row.relative),bytes=await readRegular(file);
   if(row.relative!=='s02-registry/s02-registry.initialized')verifyJson(row.relative,bytes,this.context.userScopeId);
   else if(bytes.length)deny('F10B_REGISTRY_INVALID');
   if(bytes.length!==row.size||hash(bytes)!==row.sha256)deny('F10B_CAPTURE_TAMPERED');
   expected.set(row.relative,bytes);
  }
  const allowed=new Set(['manifest.json',...Object.keys(AREAS).filter(a=>manifest.files.some(f=>f.relative.startsWith(a+'/')))]);
  for(const entry of await fs.readdir(location))if(!allowed.has(entry))deny('F10B_UNEXPECTED_CAPTURE_ENTRY');
  for(const area of Object.keys(AREAS)){
   if(!allowed.has(area))continue;
   await statDirectory(path.join(location,area));
   const names=(await fs.readdir(path.join(location,area))).sort();
   if(names.some(n=>!expected.has(`${area}/${n}`))||names.length!==manifest.files.filter(x=>x.relative.startsWith(area+'/')).length)
    deny('F10B_UNEXPECTED_CAPTURE_ENTRY');
  }
  return {manifest,bytes:expected};
 }
 async rehearse(id){
  // Never accepts a caller-supplied destination. This is deliberately a new,
  // private sandbox under the trusted rehearsal root, not the live registry.
  const {manifest,bytes}=await this.verify(id),{dir}=await this.root();
  const destination=path.join(dir,randomUUID()+'-staged');
  await mkdirPrivate(destination);
  for(const [relative,data] of bytes){
   const [area,name]=relative.split('/'),folder=path.join(destination,area);
   try{await mkdirPrivate(folder);}catch(e){if(e.code!=='EEXIST')throw e;}
   await writePrivate(path.join(folder,name),data);
  }
  for(const row of manifest.files){
   if(hash(await readRegular(path.join(destination,row.relative)))!==row.sha256)deny('F10B_REHEARSAL_MISMATCH');
  }
  await fsyncDir(destination);
  return {sourceCaptureId:id,stagedFiles:manifest.files.length,rehearsalVerified:true,
   liveRestoreAllowed:false,vectorBackupComplete:false,stagingDirectory:destination};
 }
}
