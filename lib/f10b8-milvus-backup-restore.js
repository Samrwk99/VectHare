/** F10b.8 — administrator-only Milvus Backup API v0.6 disposable roundtrip.
 * Creates and seeds one NEW S02-identified collection; backs up ONLY that name
 * using configured Milvus Backup service/object storage, restores to a new
 * generated suffix, and verifies bounded full fixture rows. Retains artifacts.
 * NO legacy collection, existing-source selection, drop, clear, retries,
 * automatic lock release on uncertain operations, or production permission.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {collectionIdentity} from './s02-identity.js';
import {planMutation} from './s04-contract.js';
import {milvusV2Adapter,provisionDisposableMilvusV2Collection} from './s07-milvus.js';
import {CooperativeWriterBoundary} from './f09c5-writer-boundary.js';

export const F10B8_CONSENT='F10B8_I_CONFIRM_NEW_DISPOSABLE_MILVUS_BACKUP_AND_RESTORE';
const fail=code=>Object.assign(new Error(code),{code});
const sha=value=>createHash('sha256').update(value).digest('hex');
const FIELDS=['physicalId','recordId','userScopeId','collectionId','type','sourceId','branchId','schemaVersion','revision','text','textHash','metadata','metadataHash','embedding','vectorHash','vector'];
function normal(v,depth=0){
 if(depth>18)throw fail('F10B8_INVALID_INVENTORY');
 if(v===null||typeof v==='string'||typeof v==='boolean')return v;
 if(typeof v==='number'&&Number.isFinite(v))return v;
 if(typeof v==='bigint')return v.toString();
 if(ArrayBuffer.isView(v))return Array.from(v,x=>normal(x,depth+1));
 if(Array.isArray(v))return v.map(x=>normal(x,depth+1));
 if(v&&typeof v==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(v))){const o={};for(const k of Object.keys(v).sort()){
  if(['__proto__','constructor','prototype'].includes(k))throw fail('F10B8_INVALID_INVENTORY');o[k]=normal(v[k],depth+1);
 }return o;}
 throw fail('F10B8_INVALID_INVENTORY');
}
function canonical(obj){return JSON.stringify(normal(obj));}
function loopback(s){let u;try{u=new URL(s);}catch{throw fail('F10B8_LOOPBACK_REQUIRED');}
 if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.pathname!=='/'||u.username||u.password||u.search||u.hash)throw fail('F10B8_LOOPBACK_REQUIRED');return u.origin;
}
function localMilvus(s){if(typeof s!=='string'||!/^127\.0\.0\.1:([1-9][0-9]{0,4})$/.test(s)||Number(s.split(':')[1])>65535)throw fail('F10B8_LOCAL_MILVUS_REQUIRED');return s;}
async function checkDir(p){if(typeof p!=='string'||!path.isAbsolute(p)||path.resolve(p)!==p||p===path.parse(p).root)throw fail('F10B8_PRIVATE_ROOT_REQUIRED');
 let q=path.parse(p).root;for(const component of path.relative(q,p).split(path.sep).filter(Boolean)){
  q=path.join(q,component);const st=await fs.lstat(q);if(!st.isDirectory()||st.isSymbolicLink())throw fail('F10B8_UNTRUSTED_DIRECTORY');
 }
 const st=await fs.lstat(p);if(process.platform!=='win32'&&(st.mode&0o077))throw fail('F10B8_UNTRUSTED_DIRECTORY');
}
async function syncDir(p){if(process.platform==='win32')return;const f=await fs.open(p,'r');try{await f.sync();}finally{await f.close();}}
async function receipt(dir,obj){const tmp=path.join(dir,'receipt-'+randomUUID()+'.tmp');const f=await fs.open(tmp,'wx',0o600);try{await f.writeFile(JSON.stringify(obj)+'\n');await f.sync();}finally{await f.close();}await fs.rename(tmp,path.join(dir,'receipt.json'));await syncDir(dir);}
function validApi(r){if(!r||typeof r!=='object'||Array.isArray(r)||typeof r.code==='number'&&r.code!==0||r.code!==undefined&&r.code!==0||!r.data||typeof r.data!=='object')throw fail('F10B8_BACKUP_RESPONSE_INVALID');return r.data;}
function taskId(s){if(typeof s!=='string'||s.length>128||!/^[A-Za-z0-9_-]+$/.test(s))throw fail('F10B8_TASK_ID_INVALID');return s;}
function state(data){if(!Number.isInteger(data?.state_code)||![0,1,2,3,4].includes(data.state_code))throw fail('F10B8_TASK_STATE_UNKNOWN');return data.state_code;}
function sourceScope(run){const id=run.replaceAll('-','');return {userScopeId:'f10b8_operator_'+id,collectionId:'f10b8_'+id,type:'other',sourceId:'diagnostic_'+id};}
const embedding=Object.freeze({source:'diagnostic',model:'f10b8-milvus-four-dim',dimension:4,metric:'cosine'});

async function realNative(address){
 const sdk=await import('@zilliz/milvus2-sdk-node');const Client=sdk?.MilvusClient??sdk?.default?.MilvusClient;
 if(typeof Client!=='function')throw fail('F10B8_MILVUS_SDK_UNAVAILABLE');
 const client=new Client({address,timeout:30000,maxRetries:0});if(client.connectPromise)await client.connectPromise;
 const status=r=>{if(!r||r.status?.error_code!==undefined&&![0,'0','Success','SUCCESS'].includes(r.status.error_code))throw fail('F10B8_MILVUS_SDK_ERROR');return r;};
 return {
  async close(){await client.closeConnection?.();},
  async exists(name){const list=status(await client.listCollections());if(!Array.isArray(list.data))throw fail('F10B8_COLLECTION_LIST_INVALID');return list.data.some(x=>x.name===name);},
  async seed(run,collection,recordId){
   const scope=sourceScope(run),context={userScopeId:scope.userScopeId},binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'milvus',scope,embedding,collection:{key:collection.key,physicalName:collection.physicalName}};
   await provisionDisposableMilvusV2Collection({client,s07DisposableFixture:true},binding);
   const payload={text:'F10b8 disposable Milvus backup fixture',vector:[0.5,0.25,0.125,0.0625],metadata:{fixture:'F10b8',kind:'backup-restore',revision:1}};
   const plan=planMutation(context,{backend:'milvus',scope,embedding,action:'insert',recordId,expectedRevision:0,...payload});
   const adapter=milvusV2Adapter({client,s07DisposableFixture:true},binding);
   const result=await adapter.insertRecord(plan,payload);if(result?.status!=='VERIFIED')throw fail('F10B8_SEED_UNVERIFIED');
  },
  async inventory(name){
   if(typeof client.query!=='function'||typeof client.describeCollection!=='function'||typeof client.loadCollection!=='function')throw fail('F10B8_NATIVE_INVENTORY_UNAVAILABLE');
   status(await client.loadCollection({collection_name:name}));
   const desc=status(await client.describeCollection({collection_name:name,cache:false}));const fields=desc.schema?.fields;
   if(!Array.isArray(fields)||!FIELDS.every(f=>fields.some(x=>x.name===f)))throw fail('F10B8_NATIVE_SCHEMA_MISMATCH');
   const r=status(await client.query({collection_name:name,filter:'physicalId != ""',output_fields:FIELDS,limit:2,consistency_level:'Strong'}));
   if(!Array.isArray(r.data)||r.data.length!==1)throw fail('F10B8_NATIVE_INVENTORY_NOT_SINGLETON');
   const row=r.data[0];if(!row||!FIELDS.every(f=>Object.hasOwn(row,f))||!Array.isArray(row.vector)&&!ArrayBuffer.isView(row.vector))throw fail('F10B8_NATIVE_INVENTORY_INCOMPLETE');
   const rows=FIELDS.reduce((o,k)=>(o[k]=row[k],o),{});
   const schema=fields.map(f=>({name:f.name,data_type:f.data_type??f.dataType,type_params:f.type_params??f.params??null,is_primary_key:f.is_primary_key??f.isPrimaryKey??false,auto_id:f.auto_id??f.autoID??false})).sort((a,b)=>a.name.localeCompare(b.name));
   const digest=sha(canonical({rows,schema}));return {count:1,digest};
  }
 };
}
/** Native adapter is replaceable only for deterministic offline tests. CLI uses realNative. */
export async function runF10b8MilvusRoundtrip(options={},deps={}){
 if(options.consent!==F10B8_CONSENT)throw fail('F10B8_CONSENT_REQUIRED');
 if(options.operatorDeclaredQuiescent!==true||options.backupApiVersion!=='0.6')throw fail('F10B8_DECLARATIONS_REQUIRED');
 const address=localMilvus(options.milvusAddress),origin=loopback(options.backupEndpoint);
 await checkDir(options.privateRoot);
 if(typeof (deps.fetchFn??globalThis.fetch)!=='function')throw fail('F10B8_FETCH_UNAVAILABLE');
 const fetchFn=deps.fetchFn??globalThis.fetch;
 // Milvus Backup API may have elevated write privileges. Never follow redirects.
 async function api(method,route,body){let response;try{response=await fetchFn(origin+'/api/v1/'+route,{method,headers:{accept:'application/json',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(15000)});}catch{throw fail('F10B8_HTTP_UNCERTAIN');}
  if(response?.status!==200)throw fail('F10B8_HTTP_UNCERTAIN');let json;try{json=await response.json();}catch{throw fail('F10B8_HTTP_UNCERTAIN');}return validApi(json);}
 const native=await (deps.nativeFactory??realNative)(address);
 if(!native||!['exists','seed','inventory','close'].every(k=>typeof native[k]==='function'))throw fail('F10B8_NATIVE_UNAVAILABLE');
 const run=randomUUID(),sourceId=sourceScope(run),collection=collectionIdentity({backend:'milvus',scope:sourceId,embedding});
 const source=collection.physicalName,suffix='_b8_'+randomUUID().replaceAll('-','').slice(0,12),destination=source+suffix;
 const backupName='vh_f10b8_'+randomUUID().replaceAll('-','');
 const id=randomUUID(),evidenceDir=path.join(options.privateRoot,'f10b8-'+id);
 const base={schemaVersion:1,checkpoint:'F10b.8',id,source,destination,backupName,backupApiVersion:'0.6',storage:'MILVUS_BACKUP_CONFIGURED_OBJECT_STORAGE',productionCertified:false,hostCertified:false,manualCleanupRequired:true};
 try{
  // No database mutations or evidence dirs until read-only service preflight succeeds.
  await api('GET','list');
  if(await native.exists(source)||await native.exists(destination))throw fail('F10B8_DISPOSABLE_COLLISION');
  const boundary=new CooperativeWriterBoundary({root:path.join(options.privateRoot,'writer-locks'),backend:'milvus',physicalName:source});
  const plan={backend:'milvus',physicalCollectionName:source,collectionKey:collection.key};
  let refused;
  const outcome=await boundary.withWriteBoundary(plan,async()=>{
   let dispatched=false;const evidence={};
   try{
    if(await native.exists(source)||await native.exists(destination))throw fail('F10B8_DISPOSABLE_COLLISION');
    await fs.mkdir(evidenceDir,{mode:0o700});await receipt(evidenceDir,{...base,state:'PREPARED'});
    dispatched=true;await receipt(evidenceDir,{...base,state:'SUBMITTED_PREPARING_NEW_SOURCE'});
    await native.seed(run,collection,randomUUID());
    const before=await native.inventory(source);if(before?.count!==1||!/^[a-f0-9]{64}$/.test(before.digest))throw fail('F10B8_SOURCE_INVENTORY_INVALID');
    // Preserve receipt before every potentially dispatched remote request.
    await receipt(evidenceDir,{...base,state:'BACKUP_SUBMITTED',sourceInventory:before});
    const created=await api('POST','create',{async:true,backup_name:backupName,collection_names:[source],format:'binlog'});
    const createId=taskId(created.requestId);evidence.backupTaskId=createId;await receipt(evidenceDir,{...base,...evidence,state:'BACKUP_TASK_ACCEPTED',sourceInventory:before});let backupDone=false;
    for(let i=0;i<20;i++){
     const progress=await api('GET','get_backup?backup_id='+encodeURIComponent(createId)+'&backup_name='+backupName);
     const current=state(progress);if(current===2){backupDone=true;break;}if(current===3||current===4)throw fail('F10B8_BACKUP_FAILED');
     await (deps.delay??(ms=>new Promise(r=>setTimeout(r,ms))))(250);
    }
    if(!backupDone)throw fail('F10B8_BACKUP_STATUS_UNCERTAIN');
    if(await native.exists(destination))throw fail('F10B8_DESTINATION_EXISTS');
    await receipt(evidenceDir,{...base,state:'RESTORE_SUBMITTED',sourceInventory:before});
    const started=await api('POST','restore',{async:true,collection_names:[source],collection_suffix:suffix,backup_name:backupName});
    const restoreId=taskId(started.id);evidence.restoreTaskId=restoreId;await receipt(evidenceDir,{...base,...evidence,state:'RESTORE_TASK_ACCEPTED',sourceInventory:before});let restoreDone=false;
    for(let i=0;i<20;i++){
     const progress=await api('GET','get_restore?id='+encodeURIComponent(restoreId));const current=state(progress);
     if(current===2){restoreDone=true;break;}if(current===3||current===4)throw fail('F10B8_RESTORE_FAILED');
     await (deps.delay??(ms=>new Promise(r=>setTimeout(r,ms))))(250);
    }
    if(!restoreDone)throw fail('F10B8_RESTORE_STATUS_UNCERTAIN');
    if(!await native.exists(destination))throw fail('F10B8_DESTINATION_NOT_CREATED');
    const restored=await native.inventory(destination),after=await native.inventory(source);
    if(!restored||restored.count!==1||restored.digest!==before.digest)throw fail('F10B8_RESTORED_INVENTORY_MISMATCH');
    if(!after||after.count!==1||after.digest!==before.digest)throw fail('F10B8_SOURCE_CHANGED');
    await receipt(evidenceDir,{...base,state:'VERIFIED',sourceInventory:before,restoredInventory:restored,backupTaskId:createId,restoreTaskId:restoreId,nativeRoundtripObserved:true});
    return {state:'VERIFIED',result:{id,source,destination,backupName,sourceInventoryDigest:before.digest,nativeRoundtripObserved:true,productionCertified:false,hostCertified:false,storage:'CONFIGURED_OBJECT_STORAGE',evidenceLocation:evidenceDir}};
   }catch(e){
    if(!dispatched){refused=e;return {state:'VERIFIED'};}
    try{await receipt(evidenceDir,{...base,...evidence,state:'UNCERTAIN_REQUIRES_MANUAL_REVIEW',reason:typeof e?.code==='string'?e.code:'F10B8_UNKNOWN'});}catch{}
    throw e;
   }
  });
  if(refused)throw refused;
  return outcome.result;
 }finally{try{await native.close();}catch{}}
}
