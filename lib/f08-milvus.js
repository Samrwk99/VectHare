/** F08 Milvus — verified existing-source binding and guarded manual pilot.
 * No production/legacy mutation unlock, purge or unrestricted inventory.
 */
import {resolveF02Binding} from './f02-public-reads.js';
import {readF03ProvisionReceipt} from './f03-provision.js';
import {inspectMilvusV2Collection,milvusV2Adapter} from './s07-milvus.js';
import {OperationLedger} from './s04-ledger.js';
import {planMutation} from './s04-contract.js';
import {MutationEngine} from './s04-engine.js';
export const F08_PILOT_CONSENT='I ACCEPT F08 DISPOSABLE MILVUS PILOT';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowed=new Set(['backend','source','embedding','configId','action','recordId','expectedRevision','operationId','experimentalConsent','text','vector','metadata']);
const actions=new Set(['insert','update','metadata','delete']);
const fail=(code,status=409)=>Object.assign(new Error(code),{code,status});
const safeCode=e=>typeof e?.code==='string'&&/^[A-Z0-9_]{2,90}$/.test(e.code)?e.code:'F08_PILOT_UNCERTAIN';
export function f08LocalMilvus(transport){
 const address=transport?.config?.address;
 if(typeof address!=='string'||!/^((127\.0\.0\.1)|(localhost)):[0-9]{2,5}$/.test(address))
  throw fail('F08_LOCAL_MILVUS_REQUIRED',403);
 return true;
}
export function validateF08MilvusPilot(req){
 const b=req?.body,h=req?.headers||{},get=k=>req?.get?.(k)??h[k.toLowerCase()]??h[k];
 if(get('x-vecthare-f08-pilot')!=='1'||(get('sec-fetch-site')&&!['same-origin','none'].includes(get('sec-fetch-site'))))
  throw fail('F08_SAME_ORIGIN_HEADER_REQUIRED',403);
 const origin=get('origin'),host=get('host');
 if(origin&&(!host||![`http://${host}`,`https://${host}`].includes(origin)))throw fail('F08_ORIGIN_INVALID',403);
 if(!object(b)||b.backend!=='milvus'||b.configId!=='default'||!object(b.source)||!object(b.embedding)||
   Object.keys(b).some(k=>!allowed.has(k)))throw fail('F08_CLIENT_SCOPE_FORBIDDEN',403);
 if(b.experimentalConsent!==F08_PILOT_CONSENT)throw fail('F08_PILOT_CONSENT_REQUIRED',403);
 if(!actions.has(b.action)||!uuid.test(b.recordId||'')||!uuid.test(b.operationId||''))throw fail('F08_ID_INVALID',400);
 if(b.action==='insert'?b.expectedRevision!==0:!Number.isSafeInteger(b.expectedRevision)||b.expectedRevision<1)
  throw fail('F08_REVISION_INVALID',400);
 const keys=['insert','update'].includes(b.action)?['text','vector','metadata']:b.action==='metadata'?['metadata']:[];
 if(['text','vector','metadata'].some(k=>Object.hasOwn(b,k)&&!keys.includes(k)))throw fail('F08_PAYLOAD_INVALID',400);
 if(['insert','update'].includes(b.action)&&(typeof b.text!=='string'||!Array.isArray(b.vector)))throw fail('F08_PAYLOAD_INVALID',400);
 if(b.action==='metadata'&&!object(b.metadata))throw fail('F08_PAYLOAD_INVALID',400);
 if(['insert','update'].includes(b.action)&&(!Number.isSafeInteger(b.embedding.dimension)||
    b.vector.length!==b.embedding.dimension||!b.vector.every(x=>typeof x==='number'&&Number.isFinite(x)&&Object.is(x,Math.fround(x)))))
  throw fail('F08_FLOAT32_VECTOR_REQUIRED',400);
 if(Object.hasOwn(b,'metadata')&&!object(b.metadata))throw fail('F08_METADATA_INVALID',400);
 return b;
}
export async function f08VerifiedCollection(req,binding,transport){
 if(binding.backend!=='milvus'||binding.scope?.userScopeId!==req.s03?.userScopeId)throw fail('F08_SOURCE_NOT_ATTESTED',403);
 const receipt=await readF03ProvisionReceipt(req.s03,binding);
 if(receipt?.state!=='SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED')throw fail('F08_PROVISION_RECEIPT_REQUIRED');
 const inspected=await inspectMilvusV2Collection(transport,binding);
 if(inspected.schemaInspected!==true||inspected.primaryKeyVerified!==true||inspected.indexVerified!==true)
  throw fail('F08_PHYSICAL_SCHEMA_UNVERIFIED');
 return true;
}
export function registerF08MilvusPilotRoutes(router,{backendPool,bind=resolveF02Binding,verify=f08VerifiedCollection,
 makeAdapter=(transport,binding)=>milvusV2Adapter({client:transport.client,f08SourceBoundPilot:true},binding),
 makeLedger=ctx=>new OperationLedger(ctx)}={}){
 if(typeof backendPool?.get!=='function')throw Error('F08_BACKEND_POOL_REQUIRED');
 router.post('/v2/records/milvus-pilot-mutate',async(req,res)=>{
  try{
   const body=validateF08MilvusPilot(req);
   if(!req.s03?.userScopeId||!req.s03?.vectorsPath)throw fail('F08_HOST_AUTH_REQUIRED',403);
   const {binding}=await bind(req,body,{reserve:false});
   if(binding.backend!=='milvus'||binding.scope.userScopeId!==req.s03.userScopeId)throw fail('F08_SOURCE_NOT_ATTESTED',403);
   const transport=await backendPool.get(req.s03,'milvus','default');
   f08LocalMilvus(transport);await verify(req,binding,transport);
   const payload=body.action==='delete'?undefined:body.action==='metadata'?{metadata:body.metadata}:
    {text:body.text,vector:body.vector,...(body.metadata!==undefined?{metadata:body.metadata}:{})};
   const plan=planMutation(req.s03,{backend:'milvus',scope:binding.scope,embedding:binding.embedding,
    action:body.action,recordId:body.recordId,operationId:body.operationId,expectedRevision:body.expectedRevision,...(payload||{})});
   if(plan.collectionKey!==binding.collection.key||plan.physicalCollectionName!==binding.collection.physicalName)
    throw fail('F08_COLLECTION_MISMATCH',403);
   const engine=new MutationEngine({atomicOnly:false,ledger:makeLedger(req.s03),adapter:makeAdapter(transport,binding),authorize:async intent=>{
    const current=(await bind(req,body,{reserve:false})).binding;
    if(current.collection.key!==binding.collection.key||JSON.stringify(current.scope)!==JSON.stringify(binding.scope))
     throw fail('F08_SOURCE_CHANGED',403);
    f08LocalMilvus(transport);await verify(req,current,transport);
    return {authorized:true,ownerVerified:true,mutationContractVerified:true,collectionKey:intent.collectionKey,backend:'milvus'};
   }});
   const result=await engine.execute(plan,payload);
   return res.status(result.state==='VERIFIED'?200:202).json({success:result.state==='VERIFIED',state:result.state,
    recordId:plan.recordId,operationId:plan.operationId,targetRevision:plan.targetRevision,
    experimental:true,productionWritesEnabled:false,retryable:false,legacyCollectionsTouched:false});
  }catch(e){return res.status(e?.status>=400&&e.status<=599?e.status:409).json({success:false,code:safeCode(e),
   experimental:true,productionWritesEnabled:false,retryable:false,legacyCollectionsTouched:false});}
 });
}
