/** F10b.7 administrator-only native reopen of F10b.3 local disposable backups.
 * Creates one NEW copy of an inert stage, then compares native inventory to
 * the still-quiescent disposable source. Never writes to original stage/backup,
 * normal collections, or user databases. No cleanup/retry/production approval.
 * Operator assures all participating writers use the F09c.5 lock root.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants as C} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {verifyF10b2Capture} from './f10b2-physical-capture.js';
import {verifyF10b3Staging} from './f10b3-disposable-restore.js';
import {CooperativeWriterBoundary} from './f09c5-writer-boundary.js';
export const F10B7_CONSENT='F10B7_I_CONFIRM_DISPOSABLE_NATIVE_LOCAL_RESTORE';
const fail=code=>Object.assign(new Error(code),{code});
const sha=x=>createHash('sha256').update(x).digest('hex');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE={lancedb:/^vh_f09c7_disposable_[a-f0-9]{32}$/,vectra:/^vh_f09c8_disposable_[a-f0-9]{32}$/};
const MAX_FILE=64*1024*1024,MAX_BYTES=128*1024*1024,MAX_ROWS=5000,MAX_TABLES=20,MAX_INVENTORY=64*1024*1024,MAX_FILES=1500;
function absolute(p){if(typeof p!=='string'||!path.isAbsolute(p)||path.resolve(p)!==p||p===path.parse(p).root)throw fail('F10B7_PATH_INVALID');return p;}
async function privateDir(p){const st=await fs.lstat(p);if(!st.isDirectory()||st.isSymbolicLink()||(process.platform!=='win32'&&(st.mode&0o077)))throw fail('F10B7_DIRECTORY_UNTRUSTED');}
async function ancestors(p){let q=path.parse(p).root;for(const n of path.relative(q,p).split(path.sep).filter(Boolean)){q=path.join(q,n);const st=await fs.lstat(q);if(st.isSymbolicLink()||!st.isDirectory())throw fail('F10B7_PATH_SYMLINK');}}
async function checkRoot(p){absolute(p);await ancestors(p);await privateDir(p);}
function distinct(paths){for(let i=0;i<paths.length;i++)for(let j=i+1;j<paths.length;j++)if(paths[i]===paths[j]||paths[i].startsWith(paths[j]+path.sep)||paths[j].startsWith(paths[i]+path.sep))throw fail('F10B7_OVERLAPPING_ROOTS');}
async function safeRead(p,limit=MAX_FILE){const st=await fs.lstat(p);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>limit||(process.platform!=='win32'&&(st.mode&0o022)))throw fail('F10B7_FILE_UNTRUSTED');const h=await fs.open(p,C.O_RDONLY|(C.O_NOFOLLOW??0));try{const s=await h.stat();if(s.ino!==st.ino||s.dev!==st.dev||s.size!==st.size||s.nlink!==1)throw fail('F10B7_SOURCE_CHANGED');const data=await h.readFile();if(data.length!==st.size)throw fail('F10B7_SOURCE_CHANGED');return data;}finally{await h.close();}}
async function save(p,content){const h=await fs.open(p,'wx',0o600);try{await h.writeFile(content);await h.sync();}finally{await h.close();}}
async function syncDir(p){if(process.platform==='win32')return;const h=await fs.open(p,'r');try{await h.sync();}finally{await h.close();}}
async function receipt(dir,obj){const tmp='receipt-'+randomUUID()+'.tmp';await save(path.join(dir,tmp),JSON.stringify(obj)+'\n');await fs.rename(path.join(dir,tmp),path.join(dir,'receipt.json'));await syncDir(dir);}
function relName(r){return typeof r==='string'&&r.length<=512&&!r.startsWith('/')&&!r.includes('\\')&&r.split('/').every(v=>v!==''&&v!=='.'&&v!=='..'&&!v.includes('\0'));}
function normalized(value,depth=0){if(depth>24)throw fail('F10B7_INVENTORY_INVALID');if(value===null||typeof value==='string'||typeof value==='boolean')return value;
 if(typeof value==='number'){if(!Number.isFinite(value))throw fail('F10B7_INVENTORY_INVALID');return value;}
 if(typeof value==='bigint')return {$int64:value.toString()};
 if(value instanceof Date)return {$date:value.toISOString()};
 if(ArrayBuffer.isView(value))return Array.from(value, x=>normalized(x,depth+1));
 if(Array.isArray(value))return value.map(x=>normalized(x,depth+1));
 if(value&&typeof value==='object'){
  if(typeof value.toJSON==='function')return normalized(value.toJSON(),depth+1);
  const proto=Object.getPrototypeOf(value);if(proto!==Object.prototype&&proto!==null)throw fail('F10B7_INVENTORY_INVALID');
  const output={};for(const key of Object.keys(value).sort()){
   if(['__proto__','constructor','prototype'].includes(key)||typeof value[key]==='undefined')throw fail('F10B7_INVENTORY_INVALID');output[key]=normalized(value[key],depth+1);
  }return output;
 }throw fail('F10B7_INVENTORY_INVALID');}
function canonical(obj){return JSON.stringify(normalized(obj));}
function digestRecords(tables){let bytes=0,count=0;const output=[];for(const [table,rows] of tables){if(!Array.isArray(rows)||rows.length>MAX_ROWS)throw fail('F10B7_INVENTORY_LIMIT');
  const records=[];for(const row of rows){const value=canonical(row);bytes+=Buffer.byteLength(value);if(bytes>MAX_INVENTORY)throw fail('F10B7_INVENTORY_LIMIT');records.push(value);if(++count>MAX_ROWS)throw fail('F10B7_INVENTORY_LIMIT');}
  records.sort();output.push(canonical({table,records}));}output.sort();return {count,tables:tables.length,sha256:sha(output.join('\n'))};}
async function inventory(backend,location,sdk){const tables=[];
 if(backend==='lancedb'){
  if(typeof sdk.connect!=='function')throw fail('F10B7_LANCEDB_SDK_INVALID');
  const db=await sdk.connect(location);if(!db||typeof db.tableNames!=='function'||typeof db.openTable!=='function')throw fail('F10B7_LANCEDB_SDK_INVALID');
  const names=await db.tableNames();if(!Array.isArray(names)||names.length!==1||names[0]!=='vh_f09c7_probe')throw fail('F10B7_UNEXPECTED_TABLES');
  for(const name of names){const table=await db.openTable(name);if(!table||typeof table.query!=='function')throw fail('F10B7_LANCEDB_SDK_INVALID');const q=table.query();if(typeof q?.toArray!=='function')throw fail('F10B7_LANCEDB_SDK_INVALID');const rows=await q.toArray();tables.push([name,rows]);}
 }else{
  const LocalIndex=sdk?.LocalIndex??sdk?.default?.LocalIndex;if(typeof LocalIndex!=='function')throw fail('F10B7_VECTRA_SDK_INVALID');
  const index=new LocalIndex(location);if(typeof index?.isIndexCreated!=='function'||typeof index?.listItems!=='function'||await index.isIndexCreated()!==true)throw fail('F10B7_VECTRA_INDEX_INVALID');
  const rows=await index.listItems();if(!Array.isArray(rows))throw fail('F10B7_VECTRA_INDEX_INVALID');tables.push(['vectra-index',rows]);
 }
 if(tables.length>MAX_TABLES)throw fail('F10B7_INVENTORY_LIMIT');return digestRecords(tables);
}
async function copyTree(source,dest,manifest){if(manifest.length>MAX_FILES||!manifest.length)throw fail('F10B7_MANIFEST_INVALID');const items=[];let size=0;
 for(const row of manifest){if(!relName(row.relative)||!Number.isSafeInteger(row.size)||row.size<0||row.size>MAX_FILE||!/^[a-f0-9]{64}$/.test(row.sha256))throw fail('F10B7_MANIFEST_INVALID');
  const from=path.join(source,...row.relative.split('/'));await ancestors(path.dirname(from));const buf=await safeRead(from);if(buf.length!==row.size||sha(buf)!==row.sha256)throw fail('F10B7_STAGE_CHANGED');size+=buf.length;if(size>MAX_BYTES)throw fail('F10B7_SIZE_LIMIT');
  const target=path.join(dest,...row.relative.split('/'));await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await save(target,buf);items.push({relative:row.relative,size:buf.length,sha256:sha(await safeRead(target))});
 }if(JSON.stringify(items)!==JSON.stringify(manifest))throw fail('F10B7_COPY_MISMATCH');await syncDir(dest);}
async function loadSdk(backend){return backend==='lancedb'?import('@lancedb/lancedb'):import('vectra');}
export async function runF10b7NativeLocalRestore(options={},sdkLoader=loadSdk){
 if(options.consent!==F10B7_CONSENT)throw fail('F10B7_CONSENT_REQUIRED');
 if(options.operatorDeclaredQuiescent!==true)throw fail('F10B7_QUIESCENCE_REQUIRED');
 const {backupRoot,restoreRoot,nativeRoot,evidenceRoot,disposableParent,backend,captureId,stagingId}=options;
 if(!Object.hasOwn(SOURCE,backend)||!UUID.test(captureId||'')||!UUID.test(stagingId||''))throw fail('F10B7_ARGUMENTS_INVALID');
 for(const p of [backupRoot,restoreRoot,nativeRoot,evidenceRoot,disposableParent])await checkRoot(p);
 distinct([backupRoot,restoreRoot,nativeRoot,evidenceRoot,disposableParent]);
 const capture=await verifyF10b2Capture({backupRoot,id:captureId});
 const stage=await verifyF10b3Staging({restoreRoot,id:stagingId});
 if(capture.backend!==backend||stage.backend!==backend)throw fail('F10B7_BACKEND_MISMATCH');
 const m=JSON.parse((await safeRead(path.join(backupRoot,'f10b2-'+captureId,'manifest.json'))).toString());
 const r=JSON.parse((await safeRead(path.join(restoreRoot,'f10b3-'+stagingId,'restore-receipt.json'))).toString());
 if(!SOURCE[backend].test(m.source||'')||r.source!==m.source||r.captureId!==captureId||r.captureManifestSha256!==sha(await safeRead(path.join(backupRoot,'f10b2-'+captureId,'manifest.json'))))throw fail('F10B7_CAPTURE_BINDING_MISMATCH');
 const original=path.join(disposableParent,m.source);
 await checkRoot(original);
 const stageLocation=path.join(restoreRoot,'f10b3-'+stagingId,'database');
 await checkRoot(stageLocation);
 // Detect native SDK unavailable *before* constructing evidence or copying stage.
 let sdk;try{sdk=await sdkLoader(backend);}catch{throw fail('F10B7_NATIVE_SDK_UNAVAILABLE');}
 if(backend==='lancedb'&&typeof sdk?.connect!=='function'||backend==='vectra'&&typeof (sdk?.LocalIndex??sdk?.default?.LocalIndex)!=='function')throw fail('F10B7_NATIVE_SDK_UNAVAILABLE');
 const physicalName=backend==='lancedb'?'vh_f09c7_probe_'+m.source.slice(-12):m.source;
 const lock=new CooperativeWriterBoundary({root:path.join(disposableParent,'writer-locks'),backend,physicalName});
 const plan={backend,physicalCollectionName:physicalName,collectionKey:sha(JSON.stringify([original,m.source,'F10B7']))};
 const nativeName='vh_f10b7_'+backend+'_disposable_'+randomUUID().replaceAll('-','');
 const outputId=randomUUID();const evidenceDir=path.join(evidenceRoot,'f10b7-'+outputId),dest=path.join(nativeRoot,nativeName);
 // A failure after native SDK access is UNCERTAIN: no retry, no lock release.
 const base={schemaVersion:1,mode:'F10B7_NATIVE_LOCAL_DISPOSABLE_REOPEN',id:outputId,backend,source:m.source,captureId,stagingId,destination:nativeName,productionCertified:false,hostCertified:false,automaticCleanup:false};
 let refusal=null;
 const result=await lock.withWriteBoundary(plan,async()=>{
  let nativeDispatched=false;
  try{
   await fs.mkdir(evidenceDir,{mode:0o700});await privateDir(evidenceDir);
   await receipt(evidenceDir,{...base,state:'PREPARED'});
   await fs.mkdir(dest,{mode:0o700});await privateDir(dest);
   await copyTree(stageLocation,dest,m.files);
   await verifyF10b3Staging({restoreRoot,id:stagingId});
   await receipt(evidenceDir,{...base,state:'SUBMITTED'});
   nativeDispatched=true;
   const before=await inventory(backend,original,sdk);
   const restored=await inventory(backend,dest,sdk);
   const after=await inventory(backend,original,sdk);
   if(before.count===0||before.sha256!==after.sha256||before.count!==after.count)throw fail('F10B7_SOURCE_CHANGED');
   if(before.sha256!==restored.sha256||before.count!==restored.count||before.tables!==restored.tables)throw fail('F10B7_INVENTORY_MISMATCH');
   // The backup must still be unchanged after native opening of the clone.
   await verifyF10b2Capture({backupRoot,id:captureId});await verifyF10b3Staging({restoreRoot,id:stagingId});
   await receipt(evidenceDir,{...base,state:'VERIFIED',sourceInventory:before,restoredInventory:restored});
   return {state:'VERIFIED',result:{id:outputId,backend,source:m.source,destination:dest,rows:restored.count,inventoryDigest:restored.sha256,nativeReopenObserved:true,productionCertified:false,hostCertified:false}};
  }catch(e){
   if(!nativeDispatched){refusal=e;if(await fs.stat(evidenceDir).catch(()=>null))await receipt(evidenceDir,{...base,state:'REFUSED_BEFORE_NATIVE_OPEN',reason:e.code||'F10B7_PRECHECK_FAILED'});return {state:'VERIFIED'};}
   try{await receipt(evidenceDir,{...base,state:'UNCERTAIN_REQUIRES_MANUAL_REVIEW',reason:e.code||'F10B7_NATIVE_ERROR'});}catch{}
   throw e;
  }
 });
 if(refusal)throw refusal;
 return result.result;
}
