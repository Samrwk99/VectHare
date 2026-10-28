import {ManagedChatRegistry} from './f09b4-managed-registry.js';
/** F09b.4 — consented, exact saved-message delete/revector and read-only receipt inspection.
 * No orphan inference, collection inventory, purge, background retry or production grant.
 */
import {createHash} from 'node:crypto';
import {readAttestedChatSnapshot,validateF09bSyncBody} from './f09b-chat-sync.js';
import {executeF02ScopedRead,resolveF02Binding} from './f02-public-reads.js';
import {readF03ProvisionReceipt,attestF03QdrantIndexes} from './f03-provision.js';
import {inspectQdrantV2Collection,qdrantV2Adapter} from './s06-qdrant.js';
import {inspectLanceV2Table,lancedbV2Adapter} from './s08-lancedb.js';
import {vectraV2Adapter} from './s08-vectra.js';
import {milvusV2Adapter} from './s07-milvus.js';
import {f08LocalMilvus,f08VerifiedCollection} from './f08-milvus.js';
import {OperationLedger} from './s04-ledger.js';
import {MutationEngine} from './s04-engine.js';
import {planMutation} from './s04-contract.js';
import {contentFingerprint} from './s02-identity.js';

export const F09B4_DELETE_CONSENT='I ACCEPT EXACT MESSAGE VECTOR DELETE PILOT';
export const F09B4_REVECTOR_CONSENT='I ACCEPT EXACT MESSAGE REVECTOR PILOT';
const SOURCES=new Set(['transformers','openai','togetherai','mistral','electronhub','openrouter','nomicai','cohere']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const obj=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const bad=(code,status=409)=>Object.assign(new Error(code),{code,status});
const code=e=>typeof e?.code==='string'&&/^[A-Z0-9_]{2,90}$/.test(e.code)?e.code:'F09B4_REFUSED';
const shortId=parts=>{
 const b=Buffer.from(createHash('sha256').update(JSON.stringify(['F09B4-V1',...parts])).digest().subarray(0,16));
 b[6]=(b[6]&15)|128;b[8]=(b[8]&63)|128;
 const hex=b.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};
function trustedRequest(req){
 const body=req?.body;
 if(!obj(body)||Object.keys(body).some(k=>!['backend','source','embedding','configId','sourceRevisionFingerprint','messageIndex','action','experimentalConsent','operationId'].includes(k)))
  throw bad('F09B4_CLIENT_SCOPE_FORBIDDEN',403);
 const {backend,source,embedding,configId,action,messageIndex,operationId}=body;
 const keys=source?.kind==='chat'?['kind','avatar','chatFile']:source?.kind==='group-chat'?['kind','groupId','chatFile']:[];
 if(!keys.length||Object.keys(source).some(k=>!keys.includes(k))||keys.some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>220)||
    !obj(embedding)||Object.keys(embedding).some(k=>!['source','model','dimension','metric'].includes(k)))
  throw bad('F09B4_CLIENT_SCOPE_FORBIDDEN',403);
 validateF09bSyncBody({backend,source,embedding,configId});
 if(!['qdrant','lancedb','vectra','milvus'].includes(backend)||configId!==(backend==='qdrant'?'local':'default')||
    !SOURCES.has(embedding.source)||!Number.isSafeInteger(messageIndex)||messageIndex<0||messageIndex>=80||
    !['delete','revector','inspect'].includes(action)||!/^([a-f0-9]{64})$/.test(body.sourceRevisionFingerprint||''))
  throw bad('F09B4_REQUEST_INVALID',400);
 if(action==='inspect'){
  if(!UUID.test(operationId||'')||body.experimentalConsent!==undefined)throw bad('F09B4_RECEIPT_REQUIRED',400);
 }else if(operationId!==undefined||body.experimentalConsent!==(action==='delete'?F09B4_DELETE_CONSENT:F09B4_REVECTOR_CONSENT))
  throw bad('F09B4_CONSENT_REQUIRED',403);
 const header=k=>req?.get?.(k)??req?.headers?.[k.toLowerCase()]??req?.headers?.[k];
 if(header('x-vecthare-f09b4-pilot')!=='1'||(header('sec-fetch-site')&&!['none','same-origin'].includes(header('sec-fetch-site'))))
  throw bad('F09B4_SAME_ORIGIN_REQUIRED',403);
 const origin=header('origin'),host=header('host');
 if(origin&&(!host||![`http://${host}`,`https://${host}`].includes(origin)))throw bad('F09B4_ORIGIN_MISMATCH',403);
 if(!req.s03?.userScopeId||!req.s03?.vectorsPath||!req.user?.directories)throw bad('F09B4_HOST_REQUIRED',403);
 return {body,base:{backend,source,embedding,configId}};
}
async function transportFor(req,body,binding,{backendPool,createVectra}){
 if(body.backend==='vectra'){
  if(typeof createVectra!=='function')throw bad('F09B4_VECTRA_SEALED_INDEX_REQUIRED');
  return createVectra(req,binding);
 }
 if(!backendPool?.get)throw bad('F09B4_BACKEND_POOL_REQUIRED');
 const conn=await backendPool.get(req.s03,body.backend,body.configId);
 if(body.backend==='lancedb'){
  if(typeof conn?.getDatabase!=='function')throw bad('F09B4_LANCEDB_SOURCE_REQUIRED');
  return {db:await conn.getDatabase(binding.embedding.source)};
 }
 if(body.backend==='milvus')f08LocalMilvus(conn);
 return conn;
}
async function inspectCollection(ctx,binding,transport){
 const receipt=await readF03ProvisionReceipt(ctx,binding);
 if(receipt?.state!=='SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED')throw bad('F09B4_F03_RECEIPT_REQUIRED');
 if(binding.backend==='qdrant'){
  if((await inspectQdrantV2Collection(transport,binding))?.schemaInspected!==true)throw bad('F09B4_SCHEMA_UNVERIFIED');
  await attestF03QdrantIndexes(transport,binding);
 }else if(binding.backend==='lancedb'){
  if((await inspectLanceV2Table(transport,binding))?.schemaInspected!==true)throw bad('F09B4_SCHEMA_UNVERIFIED');
 }else if(binding.backend==='vectra'){
  if((await vectraV2Adapter(transport,binding).inspectSchema())?.schemaInspected!=='REGISTRY_SEAL_ONLY')throw bad('F09B4_SCHEMA_UNVERIFIED');
 }else if(binding.backend==='milvus'){
  f08LocalMilvus(transport);await f08VerifiedCollection({s03:ctx},binding,transport);
 }else throw bad('F09B4_UNSUPPORTED_BACKEND',403);
}
function adapterFor(transport,binding){
 switch(binding.backend){
  case 'qdrant':return qdrantV2Adapter({f04SourceBoundPilot:true,_request:(...a)=>transport._request(...a)},binding);
  case 'lancedb':return lancedbV2Adapter({...transport,s08DisposableFixture:true},binding);
  case 'vectra':return vectraV2Adapter({...transport,s08DisposableFixture:true},binding);
  case 'milvus':return milvusV2Adapter({client:transport.client,f08SourceBoundPilot:true},binding);
  default:throw bad('F09B4_UNSUPPORTED_BACKEND');
 }
}
export async function executeF09b4Lifecycle(req,{backendPool,createVectra,embed,
 readSnapshot=readAttestedChatSnapshot,readScoped=executeF02ScopedRead,bind=resolveF02Binding,
 getTransport=transportFor,verifyCollection=inspectCollection,makeAdapter=adapterFor,
 ledger=ctx=>new OperationLedger(ctx),registry=(ctx,binding)=>new ManagedChatRegistry(ctx,binding)}={}){
 const {body,base}=trustedRequest(req);
 const first=await readSnapshot(req,body.source);
 if(first.fileHash!==body.sourceRevisionFingerprint||!first.messages.length||!first.messages[body.messageIndex])
  throw bad('F09B4_SOURCE_CHANGED_OR_MESSAGE_MISSING');
 const msg=first.messages[body.messageIndex];
 const {binding}=await bind(req,base,{reserve:false});
 if(binding.backend!==body.backend||binding.scope?.userScopeId!==req.s03.userScopeId||binding.scope?.sourceId!==first.sourceId)
  throw bad('F09B4_BINDING_MISMATCH',403);
 const receiptStore=ledger(req.s03);
 const managed=registry(req.s03,binding);
 if(body.action==='inspect'){
  const receipt=await receiptStore.read(body.operationId);
  if(receipt.plan?.collectionKey!==binding.collection.key||receipt.plan?.recordId!==msg.recordId||
     receipt.plan.scope?.sourceId!==first.sourceId||!['delete','update'].includes(receipt.plan.action))
   throw bad('F09B4_RECEIPT_SCOPE_MISMATCH',403);
  const second=await readSnapshot(req,body.source);
  if(second.fileHash!==first.fileHash||second.sourceId!==first.sourceId)throw bad('F09B4_SOURCE_CHANGED');
  // Independently inspect current physical evidence through F02's authorized
  // get, but never convert an UNCERTAIN receipt to VERIFIED. Presence/revision
  // alone cannot prove the physical vector or defeat an external writer.
  const physical=await readScoped(req,{...base,recordId:msg.recordId},'get',{backendPool,createVectra});
  const observation=physical===null?'RECORD_ABSENT_NOT_FINAL_PROOF':
   physical?.recordId!==msg.recordId||!Number.isSafeInteger(physical?.revision)?'READBACK_UNVERIFIED':
   physical.revision===receipt.plan.targetRevision?'TARGET_REVISION_SEEN_NOT_FINAL_PROOF':
   physical.revision===receipt.plan.expectedRevision?'OLD_REVISION_SEEN_NOT_FINAL_PROOF':
   'OTHER_REVISION_SEEN_NOT_FINAL_PROOF';
  return {status:'RECEIPT_INSPECTED',state:receipt.state,operationId:receipt.operationId,
   recordId:msg.recordId,action:receipt.plan.action,history:receipt.history,
   readbackObservation:observation,recordExistenceIsNotRecoveryProof:true,
   retryable:false,automaticallyReconciled:false,productionWritesEnabled:false};
 }
 await managed.guard(msg.recordId);
 const existing=await readScoped(req,{...base,recordId:msg.recordId},'get',{backendPool,createVectra});
 if(!existing||existing.recordId!==msg.recordId||!Number.isSafeInteger(existing.revision)||existing.revision<1)
  throw bad('F09B4_EXACT_RECORD_UNAVAILABLE');
 if(body.action==='delete' && (typeof existing.text!=='string'||contentFingerprint(existing.text)!==msg.contentHash))
  throw bad('F09B4_DELETE_CONTENT_CHANGED');
 const conn=await getTransport(req,body,binding,{backendPool,createVectra});
 await verifyCollection(req.s03,binding,conn);
 let vector=null;
 if(body.action==='revector'){
  if(typeof embed!=='function')throw bad('F09B4_SERVER_EMBEDDING_REQUIRED');
  vector=await embed(body.embedding.source,msg.text,body.embedding.model,req.user.directories,req);
  if(!Array.isArray(vector)||vector.length!==body.embedding.dimension||!vector.every(v=>typeof v==='number'&&Number.isFinite(v)))
   throw bad('F09B4_EMBEDDING_INVALID');
  if(body.backend==='milvus')vector=vector.map(Math.fround);
 }
 // A revector must preserve the original metadata exactly. Carry it as
 // a planned content hash, not silently rely on the backend's default merge.
 const metadata=body.action==='revector'?existing.metadata:undefined;
 if(body.action==='revector'){
  if(!obj(metadata)||typeof existing.metadataHash!=='string'||
     createHash('sha256').update(JSON.stringify(metadata)).digest('hex')!==existing.metadataHash)
   throw bad('F09B4_METADATA_PRESERVATION_UNVERIFIED');
 }
 const second=await readSnapshot(req,body.source);
 if(second.sourceId!==first.sourceId||second.fileHash!==first.fileHash)throw bad('F09B4_SOURCE_CHANGED');
 const action=body.action==='revector'?'update':'delete';
 const operationId=shortId([binding.collection.key,msg.recordId,body.action,existing.revision]);
 const payload=action==='delete'?null:{text:msg.text,vector,metadata};
 const plan=planMutation(req.s03,{backend:body.backend,scope:binding.scope,embedding:binding.embedding,
  action,recordId:msg.recordId,operationId,expectedRevision:existing.revision,...(payload||{})});
 if(plan.collectionKey!==binding.collection.key||plan.physicalCollectionName!==binding.collection.physicalName)
  throw bad('F09B4_PLAN_BINDING_MISMATCH',403);
 const engine=new MutationEngine({ledger:receiptStore,adapter:makeAdapter(conn,binding),authorize:async p=>{
  const now=await readSnapshot(req,body.source);
  if(now.sourceId!==first.sourceId||now.fileHash!==first.fileHash||now.messages[body.messageIndex]?.recordId!==msg.recordId)
   throw bad('F09B4_SOURCE_CHANGED',403);
  const current=(await bind(req,base,{reserve:false})).binding;
  if(current.collection.key!==binding.collection.key||JSON.stringify(current.scope)!==JSON.stringify(binding.scope))
   throw bad('F09B4_BINDING_CHANGED',403);
  await verifyCollection(req.s03,current,conn);
  return {authorized:true,ownerVerified:true,mutationContractVerified:true,collectionKey:p.collectionKey,backend:p.backend};
 }});
 // Store an intent before dispatch: a verified delete creates a tombstone
 // that future synchronization must not silently resurrect.
 await managed.begin({recordId:msg.recordId,contentHash:contentFingerprint(existing.text),
  revision:existing.revision,operationId,action:action==='delete'?'delete':'write',bootstrap:true});
 const result=await engine.execute(plan,payload);
 if(result.state==='VERIFIED')await managed.finish({recordId:msg.recordId,operationId,
  action:action==='delete'?'delete':'write',contentHash:msg.contentHash,
  revision:action==='delete'?existing.revision:plan.targetRevision});
 return {status:result.state,operationId,recordId:msg.recordId,
  action:body.action,targetRevision:plan.targetRevision,retryable:false,
  productionWritesEnabled:false,externalWriterSafetyCertified:false,
  orphanDeletionEnabled:false,legacyCollectionsTouched:false};
}

export const F09B4_ORPHAN_CONSENT='I ACCEPT VERIFIED MANAGED ORPHAN DELETE PILOT';
/** Delete ONLY a previously registered v2 record whose identity is no longer
 * present in the complete, re-attested saved chat snapshot. Never infer
 * orphans from physical backend listings or accept a record ID from browser.
 */
export async function executeF09b4OrphanPilot(req,{backendPool,createVectra,
 readSnapshot=readAttestedChatSnapshot,readScoped=executeF02ScopedRead,bind=resolveF02Binding,
 getTransport=transportFor,verifyCollection=inspectCollection,makeAdapter=adapterFor,
 ledger=ctx=>new OperationLedger(ctx),registry=(ctx,binding)=>new ManagedChatRegistry(ctx,binding)}={}){
 const b=req?.body;
 if(!obj(b)||Object.keys(b).some(k=>!['backend','source','embedding','configId','mode','sourceRevisionFingerprint',
  'registryFingerprint','orphanIndex','operationId','experimentalConsent'].includes(k))||!['preview','delete','inspect'].includes(b.mode))
  throw bad('F09B4_ORPHAN_CLIENT_SCOPE_FORBIDDEN',403);
 const checked=trustedRequest({...req,body:{backend:b.backend,source:b.source,embedding:b.embedding,
  configId:b.configId,sourceRevisionFingerprint:b.mode==='delete'?b.sourceRevisionFingerprint:'0'.repeat(64),messageIndex:0,
  action:'inspect',operationId:'00000000-0000-8000-8000-000000000001'}});
 if(b.mode==='inspect'&&(!UUID.test(b.operationId||'')||b.orphanIndex!==undefined||b.registryFingerprint!==undefined||b.experimentalConsent!==undefined||b.sourceRevisionFingerprint!==undefined))
  throw bad('F09B4_ORPHAN_INSPECT_INVALID',400);
 if(b.mode==='delete'&&(!/^[a-f0-9]{64}$/.test(b.sourceRevisionFingerprint||'')||b.operationId!==undefined||!Number.isSafeInteger(b.orphanIndex)||b.orphanIndex<0||b.orphanIndex>=2000||
  !/^[a-f0-9]{64}$/.test(b.registryFingerprint||'')||b.experimentalConsent!==F09B4_ORPHAN_CONSENT))
  throw bad('F09B4_ORPHAN_CONSENT_REQUIRED',403);
 if(b.mode==='preview'&&(b.orphanIndex!==undefined||b.registryFingerprint!==undefined||b.operationId!==undefined||b.experimentalConsent!==undefined||b.sourceRevisionFingerprint!==undefined))
  throw bad('F09B4_ORPHAN_PREVIEW_INVALID',400);
 const first=await readSnapshot(req,b.source);
 if(b.mode==='delete'&&first.fileHash!==b.sourceRevisionFingerprint)throw bad('F09B4_ORPHAN_SOURCE_CHANGED');
 const {binding}=await bind(req,checked.base,{reserve:false});
 if(binding.backend!==b.backend||binding.scope?.userScopeId!==req.s03.userScopeId||
  binding.scope?.sourceId!==first.sourceId)throw bad('F09B4_ORPHAN_BINDING_MISMATCH',403);
 const managed=registry(req.s03,binding),doc=await managed.read();
 if(b.mode==='inspect'){
  const entry=Object.values(doc.records).find(e=>e.operationId===b.operationId&&
    ['DELETE_PENDING','WRITE_PENDING'].includes(e.state));
  if(!entry)throw bad('F09B4_ORPHAN_RECEIPT_NOT_OWNED',403);
  const receipt=await ledger(req.s03).read(b.operationId);
  if(receipt.plan?.collectionKey!==binding.collection.key||receipt.plan?.recordId!==entry.recordId||
    receipt.plan?.scope?.sourceId!==first.sourceId)throw bad('F09B4_ORPHAN_RECEIPT_SCOPE_MISMATCH',403);
  const physical=await readScoped(req,{...checked.base,recordId:entry.recordId},'get',{backendPool,createVectra});
  const second=await readSnapshot(req,b.source);
  if(second.fileHash!==first.fileHash||second.sourceId!==first.sourceId)throw bad('F09B4_ORPHAN_SOURCE_CHANGED');
  return {status:'MANAGED_RECEIPT_INSPECTED',state:receipt.state,managedState:entry.state,
   operationId:b.operationId,readbackObservation:physical===null?'RECORD_ABSENT_NOT_FINAL_PROOF':
    physical.recordId===entry.recordId&&Number.isSafeInteger(physical.revision)?'RECORD_PRESENT_NOT_FINAL_PROOF':'READBACK_UNVERIFIED',
   automaticallyReconciled:false,retryable:false,productionWritesEnabled:false};
 }
 const current=new Set(first.messages.map(m=>m.recordId));
 const orphans=Object.values(doc.records).filter(e=>e.state==='ACTIVE'&&!current.has(e.recordId))
  .sort((a,b)=>a.recordId.localeCompare(b.recordId));
 const pending=Object.values(doc.records).filter(e=>e.state==='WRITE_PENDING'||e.state==='DELETE_PENDING');
 const second=await readSnapshot(req,b.source);
 if(second.fileHash!==first.fileHash||second.sourceId!==first.sourceId)throw bad('F09B4_ORPHAN_SOURCE_CHANGED');
 if(b.mode==='preview'){
  // A destructive action must be reviewable. Identify each candidate by its
  // actual owner-scoped text, not merely an opaque ordinal. Bounded and all-
  // or-nothing: never label a partial scan as a complete managed preview.
  if(orphans.length>80)throw bad('F09B4_ORPHAN_PREVIEW_LIMIT');
  const reviewed=[];
  for(let i=0;i<orphans.length;i++){
   const item=orphans[i],actual=await readScoped(req,{...checked.base,recordId:item.recordId},'get',{backendPool,createVectra});
   if(!actual||actual.recordId!==item.recordId||actual.revision!==item.revision||
      typeof actual.text!=='string'||contentFingerprint(actual.text)!==item.contentHash)
    throw bad('F09B4_ORPHAN_RECORD_CHANGED');
   reviewed.push({index:i,revision:item.revision,recordId:item.recordId,
    textPreview:actual.text.replace(/\s+/g,' ').slice(0,100)});
  }
  const last=await readSnapshot(req,b.source);
  if(last.fileHash!==first.fileHash||last.sourceId!==first.sourceId||
     (await managed.read()).fingerprint!==doc.fingerprint)throw bad('F09B4_ORPHAN_PREVIEW_CHANGED');
  return {status:'MANAGED_ORPHAN_PREVIEW',sourceVerified:true,
   sourceRevisionFingerprint:first.fileHash,registryFingerprint:doc.fingerprint,
   orphanCount:orphans.length,pendingCount:pending.length,tombstoneCount:Object.values(doc.records).filter(e=>e.state==='DELETED').length,orphans:reviewed,
   completeBackendInventory:false,legacyOrphansNotDiscoverable:true,productionWritesEnabled:false,retryable:false};
 }
 if(doc.fingerprint!==b.registryFingerprint)throw bad('F09B4_ORPHAN_REGISTRY_CHANGED');
 const item=orphans[b.orphanIndex];if(!item)throw bad('F09B4_ORPHAN_NOT_AVAILABLE');
 const existing=await readScoped(req,{...checked.base,recordId:item.recordId},'get',{backendPool,createVectra});
 if(!existing||existing.recordId!==item.recordId||existing.revision!==item.revision||
  typeof existing.text!=='string'||contentFingerprint(existing.text)!==item.contentHash)
  throw bad('F09B4_ORPHAN_RECORD_CHANGED');
 const transport=await getTransport(req,b,binding,{backendPool,createVectra});
 await verifyCollection(req.s03,binding,transport);
 const operationId=shortId([binding.collection.key,item.recordId,'managed-orphan-delete',item.revision]);
 const plan=planMutation(req.s03,{backend:b.backend,scope:binding.scope,embedding:binding.embedding,
  action:'delete',recordId:item.recordId,operationId,expectedRevision:item.revision});
 if(plan.collectionKey!==binding.collection.key||plan.physicalCollectionName!==binding.collection.physicalName)
  throw bad('F09B4_ORPHAN_PLAN_MISMATCH',403);
 const third=await readSnapshot(req,b.source);
 if(third.fileHash!==first.fileHash||third.sourceId!==first.sourceId||
  third.messages.some(m=>m.recordId===item.recordId))throw bad('F09B4_ORPHAN_SOURCE_CHANGED');
 // The durable deletion intent suppresses future sync even if dispatch crashes.
 await managed.begin({recordId:item.recordId,contentHash:item.contentHash,revision:item.revision,
  operationId,action:'delete'});
 const engine=new MutationEngine({ledger:ledger(req.s03),adapter:makeAdapter(transport,binding),authorize:async p=>{
  const now=await readSnapshot(req,b.source),entry=(await managed.read()).records[item.recordId];
  if(now.sourceId!==first.sourceId||now.fileHash!==first.fileHash||
    now.messages.some(m=>m.recordId===item.recordId)||entry?.state!=='DELETE_PENDING'||entry.operationId!==operationId)
   throw bad('F09B4_ORPHAN_SOURCE_CHANGED',403);
  const currentBinding=(await bind(req,checked.base,{reserve:false})).binding;
  if(currentBinding.collection.key!==binding.collection.key||JSON.stringify(currentBinding.scope)!==JSON.stringify(binding.scope))
   throw bad('F09B4_ORPHAN_BINDING_CHANGED',403);
  await verifyCollection(req.s03,currentBinding,transport);
  return {authorized:true,ownerVerified:true,mutationContractVerified:true,collectionKey:p.collectionKey,backend:p.backend};
 }});
 const result=await engine.execute(plan,null);
 if(result.state==='VERIFIED')await managed.finish({recordId:item.recordId,operationId,action:'delete',
  contentHash:item.contentHash,revision:item.revision});
 return {status:result.state,operationId,action:'managed-orphan-delete',recordId:item.recordId,
  retryable:false,productionWritesEnabled:false,externalWriterSafetyCertified:false,legacyCollectionsTouched:false};
}

export function registerF09b4LifecycleRoutes(router,deps={}){
 router.post('/v2/workflows/chat-orphan-pilot',async(req,res)=>{
  try{const result=await executeF09b4OrphanPilot(req,deps);
   return res.status(result.status==='UNCERTAIN'?202:200).json({success:result.status!=='UNCERTAIN',experimental:true,...result});
  }catch(e){return res.status(Number.isInteger(e?.status)&&e.status>=400&&e.status<=599?e.status:409).json({
   success:false,code:code(e),experimental:true,productionWritesEnabled:false,retryable:false});}
 });
 router.post('/v2/workflows/chat-lifecycle-pilot',async(req,res)=>{
  try{
   const result=await executeF09b4Lifecycle(req,deps);
   return res.status(result.status==='UNCERTAIN'?202:200).json({success:result.status!=='UNCERTAIN',experimental:true,...result});
  }catch(e){return res.status(Number.isInteger(e?.status)&&e.status>=400&&e.status<=599?e.status:409).json({
   success:false,code:code(e),experimental:true,productionWritesEnabled:false,retryable:false});}
 });
}
