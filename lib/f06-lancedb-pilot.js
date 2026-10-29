/** F06 local LanceDB v2 manual pilot: F01 re-attestation, F03 receipt,
 * S04 durable operation ledger and exact S08 scoped adapter. NOT a general
 * production-write route; every mutation remains explicitly consented.
 */
import {resolveF02Binding} from './f02-public-reads.js';
import {readF03ProvisionReceipt} from './f03-provision.js';
import {inspectLanceV2Table,lancedbV2Adapter} from './s08-lancedb.js';
import {OperationLedger} from './s04-ledger.js';
import {planMutation} from './s04-contract.js';
import {MutationEngine} from './s04-engine.js';
export const F06_PILOT_CONSENT='I ACCEPT F06 LOCAL LANCEDB PILOT';
const obj=x=>x&&typeof x==='object'&&!Array.isArray(x);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actions=new Set(['insert','update','metadata','delete']);
const keys=['backend','source','embedding','configId','action','recordId','expectedRevision','operationId','experimentalConsent','text','vector','metadata'];
const bad=(code,status=409)=>Object.assign(new Error(code),{code,status});
const errorCode=e=>typeof e?.code==='string'&&/^[A-Z0-9_]{2,90}$/.test(e.code)?e.code:'F06_PILOT_UNCERTAIN';
export function validateF06LancePilot(req){
 const b=req.body,h=req.headers??{},get=k=>req.get?.(k)??h[k.toLowerCase()]??h[k];
 if(get('x-vecthare-f06-pilot')!=='1'||(get('sec-fetch-site')&&!['same-origin','none'].includes(get('sec-fetch-site'))))
  throw bad('F06_SAME_ORIGIN_HEADER_REQUIRED',403);
 const origin=get('origin'),host=get('host');
 if(origin&&(!host||![`http://${host}`,`https://${host}`].includes(origin)))throw bad('F06_PILOT_ORIGIN_INVALID',403);
 if(!obj(b)||b.backend!=='lancedb'||!obj(b.source)||!obj(b.embedding)||b.configId!=='default'||
  Object.keys(b).some(k=>!keys.includes(k)))throw bad('F06_PILOT_REQUEST_INVALID',403);
 if(b.experimentalConsent!==F06_PILOT_CONSENT)throw bad('F06_PILOT_CONSENT_REQUIRED',403);
 if(!actions.has(b.action)||!UUID.test(b.recordId||'')||!UUID.test(b.operationId||''))throw bad('F06_PILOT_ID_INVALID',400);
 if(b.action==='insert'?b.expectedRevision!==0:!Number.isSafeInteger(b.expectedRevision)||b.expectedRevision<1)
  throw bad('F06_PILOT_REVISION_INVALID',400);
 const accepted=b.action==='insert'||b.action==='update'?['text','vector','metadata']:
  b.action==='metadata'?['metadata']:[];
 if(['text','vector','metadata'].some(k=>Object.hasOwn(b,k)&&!accepted.includes(k)))throw bad('F06_PILOT_ACTION_INVALID',400);
 if(['insert','update'].includes(b.action)&&(typeof b.text!=='string'||!Array.isArray(b.vector)))throw bad('F06_PILOT_PAYLOAD_INVALID',400);
 if(b.action==='metadata'&&!obj(b.metadata))throw bad('F06_PILOT_PAYLOAD_INVALID',400);
 return b;
}
async function verifyLancePilot(req,binding,backend){
 const receipt=await readF03ProvisionReceipt(req.s03,binding);
 if(receipt?.state!=='SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED')throw bad('F06_F03_RECEIPT_REQUIRED');
 if(typeof backend?.getDatabase!=='function')throw bad('F06_SOURCE_DATABASE_UNAVAILABLE');
 const db=await backend.getDatabase(binding.embedding.source);
 const inspected=await inspectLanceV2Table({db},binding);
 if(inspected.schemaInspected!==true)throw bad('F06_SCHEMA_UNVERIFIED');
 return db;
}
export function registerF06PilotRoutes(router,{backendPool,bind=resolveF02Binding,
 verify=verifyLancePilot,adapter=(db,binding)=>lancedbV2Adapter({db,s08DisposableFixture:true},binding),
 ledger=ctx=>new OperationLedger(ctx)}={}){
 if(typeof backendPool?.get!=='function')throw Error('F06_BACKEND_POOL_REQUIRED');
 router.post('/v2/records/lancedb-pilot-mutate',async(req,res)=>{
  try{
   const b=validateF06LancePilot(req);
   if(!req.s03?.userScopeId||!req.s03.vectorsPath)throw bad('F06_HOST_AUTH_REQUIRED',403);
   const {binding}=await bind(req,b,{reserve:false});
   if(binding.backend!=='lancedb'||binding.scope?.userScopeId!==req.s03.userScopeId)
    throw bad('F06_SOURCE_NOT_ATTESTED',403);
   const backend=await backendPool.get(req.s03,'lancedb','default');
   const db=await verify(req,binding,backend);
   const payload=b.action==='delete'?undefined:b.action==='metadata'?{metadata:b.metadata}:
    {text:b.text,vector:b.vector,...(b.metadata!==undefined?{metadata:b.metadata}:{})};
   const plan=planMutation(req.s03,{backend:'lancedb',scope:binding.scope,embedding:binding.embedding,
    action:b.action,recordId:b.recordId,operationId:b.operationId,expectedRevision:b.expectedRevision,...(payload||{})});
   if(plan.collectionKey!==binding.collection.key||plan.physicalCollectionName!==binding.collection.physicalName)
    throw bad('F06_COLLECTION_MISMATCH',403);
   const engine=new MutationEngine({atomicOnly:false,ledger:ledger(req.s03),adapter:adapter(db,binding),authorize:async intent=>{
    const current=(await bind(req,b,{reserve:false})).binding;
    if(current.collection.key!==binding.collection.key||JSON.stringify(current.scope)!==JSON.stringify(binding.scope))
     throw bad('F06_SOURCE_CHANGED',403);
    await verify(req,current,backend);
    return {authorized:true,ownerVerified:true,mutationContractVerified:true,
     collectionKey:intent.collectionKey,backend:'lancedb'};
   }});
   const result=await engine.execute(plan,payload);
   return res.status(result.state==='VERIFIED'?200:202).json({success:result.state==='VERIFIED',state:result.state,
    recordId:plan.recordId,operationId:plan.operationId,targetRevision:plan.targetRevision,
    experimental:true,productionWritesEnabled:false,retryable:false,legacyCollectionsTouched:false});
  }catch(e){return res.status(e?.status>=400&&e.status<=599?e.status:409).json({success:false,
   code:errorCode(e),experimental:true,productionWritesEnabled:false,retryable:false,legacyCollectionsTouched:false});}
 });
}
