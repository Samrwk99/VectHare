/** F10b.6 — administrator-only Qdrant disposable snapshot restore candidate.
 * Restores ONLY a verified F10b.2 capture into a fresh randomized collection,
 * then compares complete bounded vector+payload inventories against the
 * still-present and operator-quiescent disposable source. No public routes,
 * no source deletion, no automatic cleanup, no production permission.
 * Existing F10b.2 captures do NOT bind a snapshot-time semantic inventory:
 * comparison establishes equality only under the asserted stable source.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants as C} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {verifyF10b2Capture} from './f10b2-physical-capture.js';
import {verifyF10b3Staging} from './f10b3-disposable-restore.js';
import {CooperativeWriterBoundary} from './f09c5-writer-boundary.js';

const CONSENT='F10B6_I_CONFIRM_DISPOSABLE_QDRANT_RESTORE_CAN_CREATE_A_COLLECTION';
const SHA=v=>createHash('sha256').update(v).digest('hex');
const fail=c=>{const e=new Error(c);e.code=c;return e;};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SOURCE=/^vh_f09c6_disposable_[a-f0-9]{32}$/;
const MAX_SNAPSHOT=128*1024*1024,MAX_POINTS=5000,PAGE_SIZE=128,MAX_INVENTORY_BYTES=64*1024*1024;
function absolute(p){if(typeof p!=='string'||!path.isAbsolute(p)||path.resolve(p)!==p||p===path.parse(p).root)throw fail('F10B6_PATH_INVALID');return p;}
async function trustedDir(p){const st=await fs.lstat(p);if(!st.isDirectory()||st.isSymbolicLink()||(process.platform!=='win32'&&(st.mode&0o077)))throw fail('F10B6_DIRECTORY_UNTRUSTED');}
async function ancestors(p){let current=path.parse(p).root;for(const part of path.relative(current,p).split(path.sep).filter(Boolean)){current=path.join(current,part);const st=await fs.lstat(current);if(!st.isDirectory()||st.isSymbolicLink())throw fail('F10B6_SYMLINK_PATH');}}
async function safeRead(file,limit=MAX_SNAPSHOT){const st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size<1||st.size>limit||(process.platform!=='win32'&&(st.mode&0o022)))throw fail('F10B6_FILE_UNTRUSTED');const h=await fs.open(file,C.O_RDONLY|(C.O_NOFOLLOW??0));try{const st2=await h.stat();if(st.ino!==st2.ino||st.dev!==st2.dev||st.size!==st2.size||st2.nlink!==1)throw fail('F10B6_SOURCE_CHANGED');return await h.readFile();}finally{await h.close();}}
async function writeNew(file,value){const h=await fs.open(file,'wx',0o600);try{await h.writeFile(value);await h.sync();}finally{await h.close();}}
async function replaceFile(dir,name,value){const tmp=name+'.'+randomUUID()+'.tmp';await writeNew(path.join(dir,tmp),Buffer.from(JSON.stringify(value)+'\n'));await fs.rename(path.join(dir,tmp),path.join(dir,name));await sync(dir);}
async function sync(p){if(process.platform==='win32')return;const h=await fs.open(p,'r');try{await h.sync();}finally{await h.close();}}
function endpoint(s){let u;try{u=new URL(s);}catch{throw fail('F10B6_ENDPOINT_INVALID');}if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.pathname!=='/'||u.search||u.hash||u.username||u.password)throw fail('F10B6_LOOPBACK_ONLY');return u.origin;}
function canonical(v){if(v===null||typeof v==='string'||typeof v==='boolean')return JSON.stringify(v);if(typeof v==='number'&&Number.isFinite(v))return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype){return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';}throw fail('F10B6_POINT_INVALID');}
function stablePoint(point){if(!point||typeof point!=='object'||typeof point.id!=='string'&&typeof point.id!=='number'||point.vector==null||point.payload==null)throw fail('F10B6_POINT_INVALID');if(typeof point.id==='number'&&(!Number.isSafeInteger(point.id)||point.id<0))throw fail('F10B6_POINT_INVALID');return canonical({id:point.id,payload:point.payload,vector:point.vector});}
export async function runF10b6QdrantRestore(options={},fetchFn=globalThis.fetch){
 if(options.consent!==CONSENT)throw fail('F10B6_CONSENT_REQUIRED');
 if(options.operatorDeclaredQuiescent!==true)throw fail('F10B6_QUIESCENCE_REQUIRED');
 if(options.operatorDeclaredSingleNode!==true)throw fail('F10B6_SINGLE_NODE_CONFIRMATION_REQUIRED');
 if(!UUID.test(options.captureId||'')||!UUID.test(options.stagingId||''))throw fail('F10B6_ID_INVALID');
 const {backupRoot,restoreRoot,evidenceRoot,lockRoot}=options;
 for(const p of [backupRoot,restoreRoot,evidenceRoot,lockRoot]){absolute(p);await ancestors(p);await trustedDir(p);}
 for(const a of [backupRoot,restoreRoot,evidenceRoot,lockRoot])for(const b of [backupRoot,restoreRoot,evidenceRoot,lockRoot])if(a!==b&&(a.startsWith(b+path.sep)||b.startsWith(a+path.sep)))throw fail('F10B6_OVERLAPPING_ROOTS');
 const origin=endpoint(options.endpoint);
 if(options.apiKey!==undefined&&(typeof options.apiKey!=='string'||options.apiKey.length>4096))throw fail('F10B6_KEY_INVALID');
 if(typeof fetchFn!=='function')throw fail('F10B6_FETCH_UNAVAILABLE');
 const capture=await verifyF10b2Capture({backupRoot,id:options.captureId});
 const staged=await verifyF10b3Staging({restoreRoot,id:options.stagingId});
 if(capture.backend!=='qdrant'||staged.backend!=='qdrant')throw fail('F10B6_BACKEND_MISMATCH');
 const manifest=JSON.parse((await safeRead(path.join(backupRoot,'f10b2-'+options.captureId,'manifest.json'),65536)).toString());
 const receipt=JSON.parse((await safeRead(path.join(restoreRoot,'f10b3-'+options.stagingId,'restore-receipt.json'),65536)).toString());
 if(!SOURCE.test(manifest.source||'')||receipt.captureId!==options.captureId||receipt.source!==manifest.source||receipt.captureManifestSha256!==SHA(await safeRead(path.join(backupRoot,'f10b2-'+options.captureId,'manifest.json'),65536)))throw fail('F10B6_CAPTURE_BINDING_MISMATCH');
 const snapshot=await safeRead(path.join(restoreRoot,'f10b3-'+options.stagingId,'snapshot.bin'));
 if(SHA(snapshot)!==manifest.files[0].sha256||snapshot.length!==manifest.files[0].size)throw fail('F10B6_SNAPSHOT_CHANGED');
 const source=manifest.source;
 const destination='vh_f10b6_disposable_'+randomUUID().replaceAll('-','');
 const headers={accept:'application/json',...(options.apiKey?{'api-key':options.apiKey}:{})};
 async function request(method,route,body){let response;try{response=await fetchFn(origin+route,{method,headers:body===undefined?headers:{...headers,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'manual',signal:AbortSignal.timeout(30000)});}catch{throw fail('F10B6_NETWORK_UNCERTAIN');}if(!response||response.status<200||response.status>=300)throw fail('F10B6_HTTP_'+(response?.status??'UNKNOWN'));let json;try{json=await response.json();}catch{throw fail('F10B6_RESPONSE_INVALID');}if(json?.status!=='ok'||json.result===undefined)throw fail('F10B6_RESPONSE_INVALID');return json.result;}
 async function inspect(name){let r;try{r=await fetchFn(origin+'/collections/'+name,{method:'GET',headers,redirect:'manual',signal:AbortSignal.timeout(15000)});}catch{throw fail('F10B6_PREFLIGHT_UNCERTAIN');}if(r?.status===404){let result;try{result=await r.json();}catch{throw fail('F10B6_PREFLIGHT_AMBIGUOUS');}if(result?.status!=='error')throw fail('F10B6_PREFLIGHT_AMBIGUOUS');return false;}if(r?.status!==200)throw fail('F10B6_PREFLIGHT_UNCERTAIN');let result;try{result=await r.json();}catch{throw fail('F10B6_PREFLIGHT_AMBIGUOUS');}if(result?.status!=='ok'||!result.result||typeof result.result!=='object')throw fail('F10B6_PREFLIGHT_AMBIGUOUS');return true;}
 async function inventory(name){let offset,points=[],seen=new Set(),pages=0,totalBytes=0;do{if(++pages>42)throw fail('F10B6_INVENTORY_LIMIT');const result=await request('POST','/collections/'+name+'/points/scroll',{limit:PAGE_SIZE,with_payload:true,with_vector:true,...(offset===undefined?{}:{offset})});if(!Array.isArray(result?.points))throw fail('F10B6_SCROLL_INVALID');for(const row of result.points){const id=canonical(row?.id);if(seen.has(id))throw fail('F10B6_DUPLICATE_POINT');seen.add(id);const value=stablePoint(row);totalBytes+=Buffer.byteLength(value);if(totalBytes>MAX_INVENTORY_BYTES)throw fail('F10B6_INVENTORY_LIMIT');points.push(value);if(points.length>MAX_POINTS)throw fail('F10B6_INVENTORY_LIMIT');}if(result.next_page_offset!==null&&result.next_page_offset!==undefined&&!result.points.length)throw fail('F10B6_SCROLL_INVALID');const next=result.next_page_offset;if(next!==null&&next!==undefined){const key=canonical(next);if(key===canonical(offset??null)||seen.has('offset:'+key))throw fail('F10B6_SCROLL_LOOP');seen.add('offset:'+key);offset=next;}else offset=undefined;}while(offset!==undefined);points.sort();return {count:points.length,digest:SHA(points.join('\n'))};}
 // Fail before constructing an evidence case or sending an upload if source is unavailable.
 if(!await inspect(source))throw fail('F10B6_SOURCE_MISSING');
 const lock=new CooperativeWriterBoundary({root:lockRoot,backend:'qdrant',physicalName:source});
 const plan={backend:'qdrant',physicalCollectionName:source,collectionKey:SHA(JSON.stringify([origin,source,'F10B6']))};
 const outputId=randomUUID(),caseDir=path.join(evidenceRoot,'f10b6-'+outputId);
 await fs.mkdir(caseDir,{mode:0o700});await trustedDir(caseDir);
 const base={schemaVersion:1,mode:'F10B6_QDRANT_DISPOSABLE_NATIVE_RESTORE',id:outputId,captureId:options.captureId,stagingId:options.stagingId,source,destination,snapshotSha256:SHA(snapshot),productionCertified:false,liveHostCertified:false,automaticCleanup:false};
 await replaceFile(caseDir,'receipt.json',{...base,state:'PREPARED'});
 let preError;
 const outcome=await lock.withWriteBoundary(plan,async()=>{
  let dispatched=false;
  try{
   // Fresh generated destination, confirmed absent twice. No known HTTP way to
   // atomically require nonexistence at Qdrant's snapshot upload endpoint.
   if(await inspect(destination))throw fail('F10B6_DEST_EXISTS');
   const before=await inventory(source);
   if(!before.count)throw fail('F10B6_EMPTY_SOURCE_INVENTORY');
   if(await inspect(destination))throw fail('F10B6_DEST_EXISTS');
   await replaceFile(caseDir,'receipt.json',{...base,state:'SUBMITTED',sourceInventory:before});
   dispatched=true;
   const form=new FormData();form.set('snapshot',new Blob([snapshot],{type:'application/octet-stream'}),'f10b6.snapshot');
   let response;try{response=await fetchFn(origin+'/collections/'+destination+'/snapshots/upload?wait=true&priority=snapshot&checksum='+SHA(snapshot),{method:'POST',headers,body:form,redirect:'manual',signal:AbortSignal.timeout(120000)});}catch{throw fail('F10B6_UPLOAD_UNCERTAIN');}
   if(!response||response.status!==200)throw fail('F10B6_UPLOAD_UNCERTAIN');
   let answer;try{answer=await response.json();}catch{throw fail('F10B6_UPLOAD_UNCERTAIN');}
   if(answer?.status!=='ok'||answer.result!==true)throw fail('F10B6_UPLOAD_UNCERTAIN');
   if(!await inspect(destination))throw fail('F10B6_RESTORE_NOT_FOUND');
   const after=await inventory(source),restored=await inventory(destination);
   if(before.count!==after.count||before.digest!==after.digest)throw fail('F10B6_SOURCE_CHANGED');
   if(before.count!==restored.count||before.digest!==restored.digest)throw fail('F10B6_INVENTORY_MISMATCH');
   await replaceFile(caseDir,'receipt.json',{...base,state:'VERIFIED',sourceInventory:before,restoredInventory:restored,nativeRestoreObserved:true});
   return {state:'VERIFIED',result:{id:outputId,destination,source,points:restored.count,inventoryDigest:restored.digest,nativeRestoreObserved:true,productionCertified:false,liveHostCertified:false}};
  }catch(e){
   if(!dispatched){preError=e;await replaceFile(caseDir,'receipt.json',{...base,state:'REFUSED_BEFORE_DISPATCH',reason:e.code||'F10B6_PRECHECK_FAILED'});return {state:'VERIFIED'};}
   await replaceFile(caseDir,'receipt.json',{...base,state:'UNCERTAIN_REQUIRES_MANUAL_REVIEW',reason:e.code||'F10B6_UNKNOWN_FAILURE'});
   throw e; // Retain cooperating lock after dispatch, no automatic retries.
  }
 });
 if(preError)throw preError;
 return {...outcome.result,evidenceLocation:caseDir};
}
export const F10B6_CONSENT=CONSENT;
