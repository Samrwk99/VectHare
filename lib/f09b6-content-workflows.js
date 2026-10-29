/** F09b.6 — bounded source-attested saved summary and lorebook entry pilots.
 * Preview: authenticated F02 get by deterministic UUID, no mutation.
 * Apply: exactly one explicitly consented source item through F03/S04 and the
 * durable F09b.4 managed registry; never auto-retry uncertain mutations.
 */
import {createHash} from 'node:crypto';
import {readF09b6Snapshot} from './f09b6-saved-content.js';
import {executeF02ScopedRead,resolveF02Binding} from './f02-public-reads.js';
import {canonicalEmbedding,contentFingerprint} from './s02-identity.js';
import {compareF09bSyncMessages} from './f09b-chat-sync.js';
import {actualAdapter,verifiedCollection} from './f09b3-chat-sync-execute.js';
import {f08LocalMilvus} from './f08-milvus.js';
import {ManagedChatRegistry} from './f09b4-managed-registry.js';
import {OperationLedger} from './s04-ledger.js';
import {MutationEngine} from './s04-engine.js';
import {planMutation} from './s04-contract.js';
export const F09B6_CONSENT='I ACCEPT SAVED CONTENT VECTOR PILOT';
const fail=(code,status=409)=>{throw Object.assign(new Error(code),{code,status});};
const obj=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const hashedId=parts=>{
 const b=Buffer.from(createHash('sha256').update(JSON.stringify(['F09B6-OP-V1',...parts])).digest().subarray(0,16));
 b[6]=(b[6]&15)|0x80;b[8]=(b[8]&63)|0x80;const s=b.toString('hex');
 return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
};
const safeCode=e=>typeof e?.code==='string'&&/^[A-Z0-9_]{2,90}$/.test(e.code)?e.code:'F09B6_REFUSED';
export function validateF09b6Request(req){
 const b=req?.body,source=b?.source;
 if(!obj(b)||!['preview','apply'].includes(b.mode)||
    Object.keys(b).some(k=>!['mode','backend','configId','source','embedding','sourceRevisionFingerprint','itemIndex','experimentalConsent'].includes(k))||
    !['qdrant','lancedb','vectra','milvus'].includes(b.backend)||b.configId!==(b.backend==='qdrant'?'local':'default')||
    !obj(source)||!['chat','group-chat','lorebook'].includes(source.kind))fail('F09B6_CLIENT_SCOPE_FORBIDDEN',403);
 const keys=source.kind==='chat'?['kind','avatar','chatFile']:
  source.kind==='group-chat'?['kind','groupId','chatFile']:['kind','name'];
 if(Object.keys(source).some(k=>!keys.includes(k))||keys.some(k=>typeof source[k]!=='string'||!source[k]||source[k].length>220)||
    !obj(b.embedding)||Object.keys(b.embedding).some(k=>!['source','model','dimension','metric'].includes(k)))fail('F09B6_CLIENT_SCOPE_FORBIDDEN',403);
 try{canonicalEmbedding(b.embedding);}catch{fail('F09B6_EMBEDDING_INVALID',400);}
 if(!['transformers','openai','togetherai','mistral','openrouter'].includes(b.embedding.source))fail('F09B6_MANAGED_EMBEDDING_REQUIRED',403);
 if(b.mode==='preview'){
  if(b.experimentalConsent!==undefined||b.itemIndex!==undefined||b.sourceRevisionFingerprint!==undefined)fail('F09B6_PREVIEW_FIELDS_FORBIDDEN',403);
 }else if(b.experimentalConsent!==F09B6_CONSENT||!Number.isSafeInteger(b.itemIndex)||b.itemIndex<0||b.itemIndex>=80||
          !/^[a-f0-9]{64}$/.test(b.sourceRevisionFingerprint||''))fail('F09B6_EXPLICIT_CONSENT_REQUIRED',403);
 const header=k=>req?.get?.(k)??req?.headers?.[k.toLowerCase()]??req?.headers?.[k];
 if(header('x-vecthare-f09b6-pilot')!=='1'||(header('sec-fetch-site')&&!['same-origin','none'].includes(header('sec-fetch-site'))))fail('F09B6_SAME_ORIGIN_REQUIRED',403);
 const origin=header('origin'),host=header('host');
 if(origin&&(!host||![`http://${host}`,`https://${host}`].includes(origin)))fail('F09B6_ORIGIN_MISMATCH',403);
 if(!req.s03?.userScopeId||!req.s03?.vectorsPath||!req.user?.directories)fail('F09B6_TRUSTED_HOST_REQUIRED',403);
 return b;
}
async function transportFor(req,b,binding,{backendPool,createVectra}){
 if(b.backend==='vectra'){
  if(typeof createVectra!=='function')fail('F09B6_SEALED_VECTRA_REQUIRED');return createVectra(req,binding);
 }
 if(typeof backendPool?.get!=='function')fail('F09B6_BACKEND_POOL_REQUIRED');
 const conn=await backendPool.get(req.s03,b.backend,b.configId);
 if(b.backend==='lancedb'){
  if(typeof conn?.getDatabase!=='function')fail('F09B6_LANCEDB_SOURCE_REQUIRED');
  return {db:await conn.getDatabase(binding.embedding.source)};
 }
 if(b.backend==='milvus')f08LocalMilvus(conn);
 return conn;
}
export async function executeF09b6(req,{backendPool,createVectra,embed,
 readSnapshot=readF09b6Snapshot,readScoped=executeF02ScopedRead,bind=resolveF02Binding,
 getTransport=transportFor,verifyCollection=verifiedCollection,makeAdapter=actualAdapter,
 ledger=ctx=>new OperationLedger(ctx),registry=(ctx,binding)=>new ManagedChatRegistry(ctx,binding)}={}){
 const b=validateF09b6Request(req);
 const base={backend:b.backend,configId:b.configId,source:b.source,embedding:b.embedding};
 const first=await readSnapshot(req,b.source);
 if(!first.items?.length||first.items.length>80||!first.sourceId||!/^[a-f0-9]{64}$/.test(first.fileHash||''))fail('F09B6_SNAPSHOT_INVALID');
 const found=[];
 for(const item of first.items)found.push(await readScoped(req,{...base,recordId:item.recordId},'get',{backendPool,createVectra}));
 const actions=compareF09bSyncMessages(first.items,found);
 const second=await readSnapshot(req,b.source);
 if(first.sourceId!==second.sourceId||first.fileHash!==second.fileHash)fail('F09B6_SOURCE_CHANGED');
 if(b.mode==='preview')return {status:'READ_ONLY_SAVED_CONTENT_PLAN',sourceVerified:true,sourceKind:first.kind,
  recordIdentity:'V2_STABLE_SAVED_SOURCE_UUID',sourceRevisionFingerprint:first.fileHash,actions,
  counts:{create:actions.filter(x=>x.action==='CREATE_PENDING_EMBEDDING').length,
   update:actions.filter(x=>x.action==='UPDATE_PENDING_EMBEDDING').length,
   inSync:actions.filter(x=>x.action==='IN_SYNC').length},sourceItemsChecked:actions.length,
  completeInventory:false,deletionsPlanned:false,automaticMutationsEnabled:false,productionWritesEnabled:false};
 if(first.fileHash!==b.sourceRevisionFingerprint)fail('F09B6_STALE_PREVIEW');
 const item=first.items[b.itemIndex],action=actions[b.itemIndex];
 if(!item||!action)fail('F09B6_ITEM_UNAVAILABLE');
 if(action.action==='IN_SYNC')return {status:'IN_SYNC',applied:0,remaining:0,productionWritesEnabled:false};
 const {binding}=await bind(req,base,{reserve:false});
 if(binding.backend!==b.backend||binding.scope?.userScopeId!==req.s03.userScopeId||binding.scope?.sourceId!==first.sourceId)fail('F09B6_BINDING_MISMATCH',403);
 const managed=registry(req.s03,binding);
 await managed.guard(item.recordId);
 const connection=await getTransport(req,b,binding,{backendPool,createVectra});
 await verifyCollection(req.s03,binding,connection);
 if(typeof embed!=='function')fail('F09B6_SERVER_EMBEDDING_REQUIRED');
 let vector=await embed(b.embedding.source,item.text,b.embedding.model,req.user.directories,req);
 if(!Array.isArray(vector)||vector.length!==b.embedding.dimension||!vector.every(v=>typeof v==='number'&&Number.isFinite(v)))fail('F09B6_VECTOR_INVALID');
 if(b.backend==='milvus')vector=vector.map(Math.fround);
 const third=await readSnapshot(req,b.source);
 if(third.sourceId!==first.sourceId||third.fileHash!==first.fileHash)fail('F09B6_SOURCE_CHANGED');
 const existing=found[b.itemIndex],act=action.action==='CREATE_PENDING_EMBEDDING'?'insert':'update';
 const operationId=hashedId([binding.collection.key,item.recordId,act,action.expectedRevision]);
 const metadata={f09b6Kind:item.kind,f09b6SavedKey:item.sourceKey};
 // On update retain existing metadata, except the server-controlled source fields.
 if(act==='update'&&(!obj(existing?.metadata)||Object.keys(existing.metadata).some(k=>k==='__proto__')))fail('F09B6_UPDATE_METADATA_UNVERIFIED');
 const payload={text:item.text,vector,metadata:act==='update'?{...existing.metadata,...metadata}:metadata};
 const plan=planMutation(req.s03,{backend:b.backend,scope:binding.scope,embedding:binding.embedding,
  action:act,recordId:item.recordId,operationId,expectedRevision:action.expectedRevision,...payload});
 if(plan.collectionKey!==binding.collection.key||plan.physicalCollectionName!==binding.collection.physicalName)fail('F09B6_PLAN_BINDING_MISMATCH');
 const engine=new MutationEngine({atomicOnly:false,ledger:ledger(req.s03),adapter:makeAdapter(connection,binding),authorize:async p=>{
  const snap=await readSnapshot(req,b.source);
  if(snap.sourceId!==first.sourceId||snap.fileHash!==first.fileHash||snap.items[b.itemIndex]?.recordId!==item.recordId)fail('F09B6_SOURCE_CHANGED',403);
  const current=(await bind(req,base,{reserve:false})).binding;
  if(current.collection.key!==binding.collection.key||JSON.stringify(current.scope)!==JSON.stringify(binding.scope))fail('F09B6_BINDING_CHANGED',403);
  await verifyCollection(req.s03,current,connection);
  return {authorized:true,ownerVerified:true,mutationContractVerified:true,collectionKey:p.collectionKey,backend:p.backend};
 }});
 await managed.begin({recordId:item.recordId,contentHash:act==='insert'?item.contentHash:contentFingerprint(existing.text),
  revision:action.expectedRevision,operationId,action:'write',bootstrap:act==='insert'});
 const result=await engine.execute(plan,payload);
 if(result.state==='VERIFIED')await managed.finish({recordId:item.recordId,operationId,action:'write',
  contentHash:item.contentHash,revision:plan.targetRevision});
 return {status:result.state,applied:result.state==='VERIFIED'?1:0,operationId,recordId:item.recordId,
  targetRevision:plan.targetRevision,retryable:false,productionWritesEnabled:false,
  automaticMutationsEnabled:false,externalWriterSafetyCertified:false,legacyCollectionsTouched:false};
}
export function registerF09b6Routes(router,deps={}){
 router.post('/v2/workflows/saved-content-pilot',async(req,res)=>{
  try{const data=await executeF09b6(req,deps);return res.status(data.status==='UNCERTAIN'?202:200).json({success:data.status!=='UNCERTAIN',experimental:true,...data});}
  catch(e){return res.status(Number.isInteger(e?.status)&&e.status>=400&&e.status<=599?e.status:409).json({success:false,code:safeCode(e),experimental:true,productionWritesEnabled:false,retryable:false});}
 });
}
