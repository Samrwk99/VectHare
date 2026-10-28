import {ManagedChatRegistry} from './f09b4-managed-registry.js';
import {contentFingerprint} from './s02-identity.js';
/** F09b.3 — explicitly confirmed, bounded local-plugin saved-chat synchronization.
 * Only server-read saved chat text is embedded; no browser vectors, IDs or text.
 * This is a non-production PILOT until F09c backend concurrency acceptance.
 */
import {createHash} from 'node:crypto';
import {readAttestedChatSnapshot,compareF09bSyncMessages,validateF09bSyncBody} from './f09b-chat-sync.js';
import {executeF02ScopedRead,resolveF02Binding} from './f02-public-reads.js';
import {readF03ProvisionReceipt,attestF03QdrantIndexes} from './f03-provision.js';
import {inspectQdrantV2Collection,qdrantV2Adapter} from './s06-qdrant.js';
import {inspectLanceV2Table,lancedbV2Adapter} from './s08-lancedb.js';
import {vectraV2Adapter} from './s08-vectra.js';
import {milvusV2Adapter} from './s07-milvus.js';
import {f08LocalMilvus,f08VerifiedCollection} from './f08-milvus.js';
import {OperationLedger} from './s04-ledger.js';
import {planMutation} from './s04-contract.js';
import {MutationEngine} from './s04-engine.js';

export const F09B3_CONSENT='I ACCEPT LOCAL CHAT SYNC PILOT';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SERVER_EMBED_SOURCES=new Set(['transformers','openai','togetherai','mistral','electronhub','openrouter','nomicai','cohere']);
const bad=(code,status=409)=>Object.assign(new Error(code),{code,status});
const obj=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const safeCode=e=>typeof e?.code==='string'&&/^[A-Z0-9_]{2,90}$/.test(e.code)?e.code:'F09B3_SYNC_REFUSED';
function idFor(intent){
 const b=Buffer.from(createHash('sha256').update(JSON.stringify(['F09B3-SYNC-V1',...intent])).digest().subarray(0,16));
 b[6]=(b[6]&15)|0x80;b[8]=(b[8]&63)|0x80;
 const s=b.toString('hex');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
function validateRequest(req){
 const b=req?.body;
 if(!obj(b)||Object.keys(b).some(k=>!['backend','source','embedding','configId','experimentalConsent','sourceRevisionFingerprint'].includes(k)))
  throw bad('F09B3_CLIENT_SCOPE_FORBIDDEN',403);
 const base={backend:b.backend,source:b.source,embedding:b.embedding,configId:b.configId};
 const sourceKeys=b.source?.kind==='chat'?['kind','avatar','chatFile']:
  b.source?.kind==='group-chat'?['kind','groupId','chatFile']:[];
 if(!sourceKeys.length||Object.keys(b.source).some(k=>!sourceKeys.includes(k))||
    sourceKeys.some(k=>typeof b.source[k]!=='string'||!b.source[k]||b.source[k].length>220)||
    Object.keys(b.embedding??{}).some(k=>!['source','model','dimension','metric'].includes(k)))
  throw bad('F09B3_CLIENT_SCOPE_FORBIDDEN',403);
 validateF09bSyncBody(base);
 if(!['qdrant','milvus','lancedb','vectra'].includes(b.backend)||
    b.configId!==(b.backend==='qdrant'?'local':'default')||!SERVER_EMBED_SOURCES.has(b.embedding.source))
  throw bad('F09B3_LOCAL_BACKEND_SERVER_EMBEDDING_REQUIRED',403);
 if(b.experimentalConsent!==F09B3_CONSENT||!/^([a-f0-9]{64})$/.test(b.sourceRevisionFingerprint||''))
  throw bad('F09B3_EXPLICIT_CONSENT_AND_SNAPSHOT_REQUIRED',403);
 const read=k=>req?.get?.(k)??req?.headers?.[k.toLowerCase()]??req?.headers?.[k];
 if(read('x-vecthare-f09b3-pilot')!=='1'||(read('sec-fetch-site')&&!['same-origin','none'].includes(read('sec-fetch-site'))))
  throw bad('F09B3_SAME_ORIGIN_REQUIRED',403);
 const origin=read('origin'),host=read('host');
 if(origin&&(!host||![`http://${host}`,`https://${host}`].includes(origin)))throw bad('F09B3_ORIGIN_MISMATCH',403);
 return {body:b,base};
}
async function actualAdapter(transport,binding){
 switch(binding.backend){
  case 'qdrant':return qdrantV2Adapter({f04SourceBoundPilot:true,_request:(...a)=>transport._request(...a)},binding);
  case 'lancedb':return lancedbV2Adapter({...transport,s08DisposableFixture:true},binding);
  case 'vectra':return vectraV2Adapter({...transport,s08DisposableFixture:true},binding);
  case 'milvus':return milvusV2Adapter({client:transport.client,f08SourceBoundPilot:true},binding);
  default:throw bad('F09B3_UNSUPPORTED_BACKEND',403);
 }
}
async function verifiedCollection(context,binding,transport){
 const receipt=await readF03ProvisionReceipt(context,binding);
 if(receipt?.state!=='SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED')throw bad('F09B3_F03_RECEIPT_REQUIRED');
 switch(binding.backend){
  case 'qdrant':{
   const schema=await inspectQdrantV2Collection(transport,binding);
   if(schema?.schemaInspected!==true)throw bad('F09B3_SCHEMA_UNVERIFIED');
   await attestF03QdrantIndexes(transport,binding);break;
  }
  case 'lancedb':{
   if((await inspectLanceV2Table(transport,binding))?.schemaInspected!==true)throw bad('F09B3_SCHEMA_UNVERIFIED');break;
  }
  case 'vectra':{
   // f07SealedVectra already proves the F03 receipt, sealed server index,
   // index path and physical schema; verify the sealed adapter again.
   const index=vectraV2Adapter(transport,binding);
   if((await index.inspectSchema())?.schemaInspected!=='REGISTRY_SEAL_ONLY')throw bad('F09B3_SCHEMA_UNVERIFIED');break;
  }
  case 'milvus':{
   f08LocalMilvus(transport);
   await f08VerifiedCollection({s03:context},binding,transport);break;
  }
  default:throw bad('F09B3_UNSUPPORTED_BACKEND',403);
 }
}
export async function executeF09b3Sync(req,{backendPool,createVectra,embed,readSnapshot=readAttestedChatSnapshot,
 readScoped=executeF02ScopedRead,bind=resolveF02Binding,ledger=ctx=>new OperationLedger(ctx),registry=(ctx,binding)=>new ManagedChatRegistry(ctx,binding),
 makeAdapter=actualAdapter,verifyCollection=verifiedCollection,
 getTransport=async(req,body,binding)=>{
  if(body.backend==='vectra'){
   if(typeof createVectra!=='function')throw bad('F09B3_VECTRA_INDEX_REQUIRED');
   return createVectra(req,binding);
  }
  const backend=await backendPool.get(req.s03,body.backend,body.configId);
  if(body.backend==='lancedb'){
   if(typeof backend?.getDatabase!=='function')throw bad('F09B3_LANCEDB_SOURCE_REQUIRED');
   return {db:await backend.getDatabase(binding.embedding.source)};
  }
  if(body.backend==='milvus')f08LocalMilvus(backend);
  return backend;
 }}={}){
 const {body:b,base}=validateRequest(req);
 if(!req.s03?.userScopeId||!req.s03.vectorsPath||typeof embed!=='function')throw bad('F09B3_TRUSTED_HOST_REQUIRED',403);
 const first=await readSnapshot(req,b.source);
 if(!first.messages?.length||first.messages.length>80||first.fileHash!==b.sourceRevisionFingerprint)
  throw bad('F09B3_SOURCE_CHANGED_OR_EMPTY');
 const found=[];
 for(const m of first.messages)found.push(await readScoped(req,{...base,recordId:m.recordId},'get',{backendPool,createVectra}));
 const actions=compareF09bSyncMessages(first.messages,found);
 const pending=actions.map((action,i)=>({action,message:first.messages[i]})).filter(x=>x.action.action!=='IN_SYNC');
 // Never infer deletions from incomplete listing; apply at most one change per
 // request, so interruptions cannot leave a misleading completed batch report.
 if(!pending.length)return {status:'IN_SYNC',applied:0,remaining:0,productionWritesEnabled:false};
 const chosen=pending[0],act=chosen.action.action==='CREATE_PENDING_EMBEDDING'?'insert':'update';
 const second=await readSnapshot(req,b.source);
 if(first.fileHash!==second.fileHash||first.sourceId!==second.sourceId)throw bad('F09B3_SOURCE_CHANGED');
 const {binding}=await bind(req,base,{reserve:false});
 if(binding.backend!==b.backend||binding.scope.userScopeId!==req.s03.userScopeId||binding.scope.sourceId!==first.sourceId)
  throw bad('F09B3_SOURCE_BINDING_MISMATCH',403);
 const managed=registry(req.s03,binding);
 await managed.guard(chosen.message.recordId);
 const transport=await getTransport(req,b,binding);
 await verifyCollection(req.s03,binding,transport);
 let vector=await embed(b.embedding.source,chosen.message.text,b.embedding.model,req.user.directories,req);
 if(!Array.isArray(vector)||vector.length!==b.embedding.dimension||!vector.every(v=>typeof v==='number'&&Number.isFinite(v)))
  throw bad('F09B3_SERVER_EMBEDDING_DIMENSION_MISMATCH');
 if(b.backend==='milvus')vector=vector.map(Math.fround);
 const third=await readSnapshot(req,b.source);
 if(first.fileHash!==third.fileHash||first.sourceId!==third.sourceId)throw bad('F09B3_SOURCE_CHANGED');
 // One operation ID per owned collection/record/action/revision: a changed chat
 // file or edited text cannot bypass an earlier UNCERTAIN operation receipt.
 const opId=idFor([binding.collection.key,chosen.action.recordId,act,chosen.action.expectedRevision]);
 const payload={text:chosen.message.text,vector};
 const plan=planMutation(req.s03,{backend:b.backend,scope:binding.scope,embedding:binding.embedding,
  action:act,recordId:chosen.action.recordId,operationId:opId,expectedRevision:chosen.action.expectedRevision,...payload});
 if(plan.collectionKey!==binding.collection.key||plan.physicalCollectionName!==binding.collection.physicalName)
  throw bad('F09B3_PLAN_BINDING_MISMATCH',403);
 const engine=new MutationEngine({ledger:ledger(req.s03),adapter:makeAdapter(transport,binding),authorize:async p=>{
  const now=await readSnapshot(req,b.source);
  if(now.sourceId!==first.sourceId||now.fileHash!==first.fileHash)throw bad('F09B3_SOURCE_CHANGED',403);
  const current=(await bind(req,base,{reserve:false})).binding;
  if(current.collection.key!==binding.collection.key||JSON.stringify(current.scope)!==JSON.stringify(binding.scope))
   throw bad('F09B3_BINDING_CHANGED',403);
  await verifyCollection(req.s03,current,transport);
  return {authorized:true,ownerVerified:true,mutationContractVerified:true,collectionKey:p.collectionKey,backend:p.backend};
 }});
 // Durable intent precedes the backend dispatch. An interrupted operation
 // stays blocked until independently investigated: no automatic replay.
 await managed.begin({recordId:chosen.message.recordId,contentHash:act==='insert'?chosen.message.contentHash:
   contentFingerprint(found[first.messages.indexOf(chosen.message)].text),revision:plan.expectedRevision,
   operationId:opId,action:'write',bootstrap:true});
 const result=await engine.execute(plan,payload);
 if(result.state==='VERIFIED')await managed.finish({recordId:chosen.message.recordId,
  operationId:opId,action:'write',contentHash:chosen.message.contentHash,revision:plan.targetRevision});
 return {status:result.state,applied:result.state==='VERIFIED'?1:0,
  remaining:Math.max(0,pending.length-(result.state==='VERIFIED'?1:0)),
  operationId:opId,recordId:chosen.action.recordId,targetRevision:plan.targetRevision,
  retryable:false,productionWritesEnabled:false,automaticMutationsEnabled:false,
  externalWriterSafetyCertified:false,legacyCollectionsTouched:false};
}
export function registerF09b3SyncRoutes(router,deps={}){
 router.post('/v2/workflows/chat-sync-pilot-apply',async(req,res)=>{
  try{
   const result=await executeF09b3Sync(req,deps);
   return res.status(result.status==='UNCERTAIN'?202:200).json({success:result.status!=='UNCERTAIN',experimental:true,...result});
  }catch(e){return res.status(Number.isInteger(e?.status)&&e.status>=400&&e.status<=599?e.status:409).json({
   success:false,code:safeCode(e),experimental:true,productionWritesEnabled:false,retryable:false});}
 });
}
