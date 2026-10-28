/** F03 — explicit new-collection provisioning. Mutates schema ONLY, never records.
 * A fresh F01 attestation and a durable S02 reservation are independently required.
 * No request field can choose the physical collection, owner or backend credentials.
 * Cross-process locking is local to the authenticated SillyTavern user directory.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {resolveF02Binding} from './f02-public-reads.js';
import {OperationLedger} from './s04-ledger.js';
import {provisionDisposableQdrantV2Collection,inspectQdrantV2Collection} from './s06-qdrant.js';
import {provisionDisposableMilvusV2Collection,inspectMilvusV2Collection} from './s07-milvus.js';
import {provisionF06LanceV2Collection} from './f06-lancedb.js';

export class F03ProvisionError extends Error {
 constructor(code,message,status=409){super(message);this.code=code;this.status=status;}
}
const isObj=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const backends=new Set(['qdrant','milvus','lancedb']);
function validate(body,provision){
 if(!isObj(body)||!isObj(body.source)||!isObj(body.embedding)||!backends.has(body.backend))
  throw new F03ProvisionError('F03_REQUEST_INVALID','Backend, saved source and embedding required',400);
 const allowed=['backend','source','embedding','configId',...(provision?['confirmProvision','expectedCollectionName']:[])];
 if(Object.keys(body).some(k=>!allowed.includes(k)))throw new F03ProvisionError('F03_CLIENT_SCOPE_FORBIDDEN','Unrecognized or client-controlled scope field',403);
 if(body.configId!==undefined&&!['default','local'].includes(body.configId))throw new F03ProvisionError('F03_CONFIG_INVALID','Invalid connection selector',400);
 if(body.backend!=='qdrant'&&body.configId==='local')throw new F03ProvisionError('F03_CONFIG_INVALID','Local selector applies only to Qdrant',400);
 if(provision&&(body.confirmProvision!==true||typeof body.expectedCollectionName!=='string'))
  throw new F03ProvisionError('F03_CONFIRMATION_REQUIRED','Explicit confirmation and exact generated name required',400);
 return body;
}
async function ensurePrivateDir(dir){
 const st=await fs.lstat(dir);
 if(!st.isDirectory()||st.isSymbolicLink()|| (process.platform!=='win32'&&(st.mode&0o077)))
  throw new F03ProvisionError('F03_RECEIPT_ROOT_UNTRUSTED','Private receipt directory required');
}
async function receiptFolder(context){
 const parent=path.join(context.vectorsPath,'.similharity');
 await ensurePrivateDir(parent); // S02 reserve created it before provisioning
 const folder=path.join(parent,'f03-provisions');
 try{await fs.mkdir(folder,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
 await ensurePrivateDir(folder);
 return folder;
}
async function syncDir(dir){const fd=await fs.open(dir,'r');try{await fd.sync();}finally{await fd.close();}}
async function refuseExistingReceipt(context,binding){
 const folder=await receiptFolder(context),filename=path.join(folder,binding.collection.key+'.json');
 try{await fs.lstat(filename);throw new F03ProvisionError('F03_RECEIPT_EXISTS','Provisioning previously attempted; investigate receipt before retry');}
 catch(e){if(e?.code!=='ENOENT')throw e;}
}
export async function readF03ProvisionReceipt(context,binding){
 const folder=await receiptFolder(context),file=path.join(folder,binding.collection.key+'.json');
 let stat;
 try{stat=await fs.lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8192||
    (process.platform!=='win32'&&(stat.mode&0o077)))
  throw new F03ProvisionError('F03_RECEIPT_UNTRUSTED','Provisioning receipt is not trustworthy');
 let value;
 try{value=JSON.parse(await fs.readFile(file,'utf8'));}catch{throw new F03ProvisionError('F03_RECEIPT_UNTRUSTED','Provisioning receipt unreadable');}
 if(value?.schemaVersion!==3||value.collectionKey!==binding.collection.key||
  value.physicalName!==binding.collection.physicalName||value.backend!==binding.backend||
  value.userScopeId!==context.userScopeId||
  !['PREPARED','UNCERTAIN','SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED'].includes(value.state))
  throw new F03ProvisionError('F03_RECEIPT_UNTRUSTED','Provisioning receipt scope/state invalid');
 return {state:value.state,operationId:value.operationId,code:value.code??null};
}
async function beginReceipt(context,binding){
 const folder=await receiptFolder(context),name=binding.collection.key+'.json',file=path.join(folder,name);
 const document={schemaVersion:3,collectionKey:binding.collection.key,physicalName:binding.collection.physicalName,
  backend:binding.backend,userScopeId:context.userScopeId,operationId:randomUUID(),state:'PREPARED'};
 let handle;
 try{handle=await fs.open(file,'wx',0o600);await handle.writeFile(JSON.stringify(document)+'\n');await handle.sync();}
 catch(e){if(e.code==='EEXIST')throw new F03ProvisionError('F03_RECEIPT_EXISTS','Collection provisioning previously attempted; investigate receipt, never auto-retry');throw e;}
 finally{await handle?.close();}
 await syncDir(folder);
 return {folder,file,document};
}
async function sealReceipt(receipt,state,code){
 const body={...receipt.document,state,...(code?{code}:{}),updatedAt:new Date().toISOString()};
 const tmp=path.join(receipt.folder,'.tmp-'+randomUUID());
 let handle;
 try{handle=await fs.open(tmp,'wx',0o600);await handle.writeFile(JSON.stringify(body)+'\n');await handle.sync();}
 finally{await handle?.close();}
 try{await fs.rename(tmp,receipt.file);await syncDir(receipt.folder);}
 finally{await fs.rm(tmp,{force:true});}
}
function sanitized(err){return typeof err?.code==='string'&&/^[A-Z0-9_]{2,90}$/.test(err.code)?err.code:'F03_BACKEND_UNCERTAIN';}
/** Inspect backend-native Qdrant keyword indexes after creation.
 * An accepted index request by itself is not proof that filtering is ready.
 */
export async function attestF03QdrantIndexes(backend,binding){
 const response=await backend._request('GET',`/collections/${binding.collection.physicalName}`);
 const schema=response?.result?.payload_schema;
 const fields=['userScopeId','collectionId','type','sourceId','branchId','recordId','physicalId'];
 if(!isObj(schema)||fields.some(field=>{
  const index=schema[field];
  const kind=index?.data_type??index?.params?.type;
  return !index||String(kind).toLowerCase()!=='keyword';
 }))throw new F03ProvisionError('F03_QDRANT_OWNER_INDEX_UNVERIFIED','Owner keyword indexes not verifiable');
 return true;
}
async function provision(backend,transport,binding){
 // Never mark pooled instances. Only an internal, request-local wrapper receives
 // F03 capability after authenticated source verification and exact user consent.
 if(backend==='qdrant'){
  const isolated={f03SourceProvisionAuthorized:true,_request:(...args)=>transport._request(...args)};
  const created=await provisionDisposableQdrantV2Collection(isolated,binding);
  await inspectQdrantV2Collection(isolated,binding);
  await attestF03QdrantIndexes(isolated,binding);
  return created;
 }
 if(backend==='lancedb'){
  return provisionF06LanceV2Collection(transport,binding);
 }
 if(backend==='milvus'){
  const isolated={f03SourceProvisionAuthorized:true,client:transport.client};
  const created=await provisionDisposableMilvusV2Collection(isolated,binding);
  await inspectMilvusV2Collection(isolated,binding);
  return created;
 }
 throw new F03ProvisionError('F03_BACKEND_UNSUPPORTED','Provisioning not certified for this backend');
}
function fail(res,error){return res.status(Number.isInteger(error?.status)?error.status:409).json({
 success:false,code:sanitized(error),productionWritesEnabled:false,physicalPurgeEnabled:false});}
export function registerF03ProvisionRoutes(router,{backendPool,bind=resolveF02Binding,provisionBackend=provision}={}){
 if(!backendPool||typeof backendPool.get!=='function')throw Error('F03_BACKEND_POOL_REQUIRED');
 router.post('/v2/collections/preview',async(req,res)=>{
  try{const body=validate(req.body,false),{binding}=await bind(req,body,{reserve:true});
   return res.json({success:true,backend:binding.backend,collectionName:binding.collection.physicalName,
    collectionKey:binding.collection.key,physicalCollectionProvisioned:false,productionWritesEnabled:false,
    consentRequired:true,backendCertified:false});
  }catch(e){return fail(res,e);}
 });
 router.post('/v2/collections/status',async(req,res)=>{
  try{
   const body=validate(req.body,false),{binding}=await bind(req,body,{reserve:false});
   const receipt=await readF03ProvisionReceipt(req.s03,binding);
   return res.json({success:true,backend:binding.backend,collectionName:binding.collection.physicalName,
    receiptState:receipt?.state??'NO_F03_RECEIPT',receiptCode:receipt?.code??null,
    productionWritesEnabled:false,backendCertified:false,physicalCollectionProvisioned:receipt?.state==='SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED',
    inventoryVerified:false});
  }catch(e){return fail(res,e);}
 });
 router.post('/v2/collections/provision',async(req,res)=>{
  try{
   const body=validate(req.body,true),{binding}=await bind(req,body,{reserve:false});
   if(body.expectedCollectionName!==binding.collection.physicalName)
    throw new F03ProvisionError('F03_COLLECTION_CONFIRM_MISMATCH','Generated collection does not match user confirmation',409);
   if(!req?.s03?.userScopeId||!req?.s03?.vectorsPath)
    throw new F03ProvisionError('F03_HOST_AUTH_REQUIRED','Authenticated user context unavailable',403);
   const ledger=new OperationLedger(req.s03);
   return await ledger.withCollectionLock({collectionKey:binding.collection.key},async()=>{
    await refuseExistingReceipt(req.s03,binding);
    // Resolve connection before consuming the one-time provisioning receipt.
    // Only backend-side create/index operations can create UNCERTAIN state.
    const transport=await backendPool.get(req.s03,body.backend,body.configId??'default');
    const receipt=await beginReceipt(req.s03,binding); // before backend dispatch
    let created;
    try{
     created=await provisionBackend(body.backend,transport,binding);
     if(created?.status!=='PROVISIONED_SOURCE_BOUND_UNCERTIFIED'||created?.physicalName!==binding.collection.physicalName)
      throw new F03ProvisionError('F03_ACK_UNVERIFIED','Physical schema creation not conclusively verified');
     await sealReceipt(receipt,'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED');
    }catch(error){
     try{await sealReceipt(receipt,'UNCERTAIN',sanitized(error));}catch{/* never hide the original backend error */}
     // No delete/drop and no automatic retry, even on backend connection failure.
     throw new F03ProvisionError('F03_PROVISION_UNCERTAIN','Collection creation outcome requires inspection',409);
    }
    return res.json({success:true,backend:body.backend,collectionName:binding.collection.physicalName,
     physicalCollectionProvisioned:true,recordMutationsEnabled:false,productionWritesEnabled:false,
     backendCertified:false,inventoryVerified:false,receiptState:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED'});
   });
  }catch(e){return fail(res,e);}
 });
}
