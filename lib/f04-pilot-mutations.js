/** F04 limited public mutation pilot for newly F03-provisioned Qdrant v2 namespaces.
 * NOT activation of legacy memory writes, not external-writer isolation, not a
 * production capability. Every call requires server F01 re-attestation, S02
 * binding, F03 receipt, independent physical schema/index inspection, exact
 * operation UUID and explicit user consent. All other backends fail closed.
 */
import {resolveF02Binding} from './f02-public-reads.js';
import {readF03ProvisionReceipt,attestF03QdrantIndexes} from './f03-provision.js';
import {inspectQdrantV2Collection,qdrantV2Adapter} from './s06-qdrant.js';
import {OperationLedger} from './s04-ledger.js';
import {planMutation} from './s04-contract.js';
import {MutationEngine} from './s04-engine.js';

export const F04_PILOT_CONSENT='I ACCEPT DISPOSABLE V2 RECORD MUTATIONS';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS=new Set(['insert','update','metadata','delete']);
const BASE=['backend','source','embedding','configId','action','recordId','expectedRevision','operationId','experimentalConsent'];
export class F04PilotError extends Error {
 constructor(code,message,status=409){super(message);this.code=code;this.status=status;}
}
function validatePilotOrigin(req){
 const headers=req?.headers??{};
 const read=k=>req?.get?.(k)??headers[k.toLowerCase()]??headers[k];
 if(read('x-vecthare-f04-pilot')!=='1')
  throw new F04PilotError('F04_PILOT_HEADER_REQUIRED','Explicit same-origin pilot header required',403);
 const site=String(read('sec-fetch-site')??'');
 if(site&&!['same-origin','none'].includes(site))
  throw new F04PilotError('F04_PILOT_ORIGIN_FORBIDDEN','Cross-origin mutation refused',403);
 const origin=read('origin');
 if(origin){
  const host=read('host');
  if(!host||![`http://${host}`,`https://${host}`].includes(origin))
   throw new F04PilotError('F04_PILOT_ORIGIN_FORBIDDEN','Request origin mismatch',403);
 }
}
export function validateF04Pilot(body){
 if(!object(body)||body.backend!=='qdrant'||!object(body.source)||!object(body.embedding))
  throw new F04PilotError('F04_PILOT_QDRANT_ONLY','F04 pilot requires authenticated Qdrant v2 source',400);
 if(Object.keys(body).some(k=>![...BASE,'text','vector','metadata'].includes(k)))
  throw new F04PilotError('F04_CLIENT_SCOPE_FORBIDDEN','Client owner/collection/physical scope prohibited',403);
 if(body.experimentalConsent!==F04_PILOT_CONSENT)
  throw new F04PilotError('F04_EXPLICIT_CONSENT_REQUIRED','Explicit disposable-only consent required',403);
 if(!ACTIONS.has(body.action)||!UUID.test(body.operationId||'')||!UUID.test(body.recordId||''))
  throw new F04PilotError('F04_OPERATION_ID_INVALID','Valid action, stable UUID record and operation IDs required',400);
 if(body.configId!=='local')
  throw new F04PilotError('F04_LOCAL_QDRANT_ONLY','Pilot requires server-configured loopback Qdrant; cloud/external writers are unverified',403);
 if(body.action==='insert'&&body.expectedRevision!==0 || body.action!=='insert'&&(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<1))
  throw new F04PilotError('F04_REVISION_INVALID','Insert must use revision 0; modifications require current revision >=1',400);
 const fields=body.action==='insert'||body.action==='update'?['text','vector','metadata']:
  body.action==='metadata'?['metadata']:[];
 if(['text','vector','metadata'].some(k=>Object.hasOwn(body,k)&&!fields.includes(k)))
  throw new F04PilotError('F04_ACTION_PAYLOAD_INVALID','Unexpected action payload',400);
 if((body.action==='insert'||body.action==='update')&&
  (typeof body.text!=='string'||!Array.isArray(body.vector)) ||
  (body.action==='metadata'&&!object(body.metadata)))
  throw new F04PilotError('F04_ACTION_PAYLOAD_INVALID','Required text/vector or metadata missing',400);
 return body;
}
function redacted(error){return typeof error?.code==='string'&&/^[A-Z0-9_]{2,90}$/.test(error.code)?error.code:'F04_MUTATION_REFUSED';}
async function verifyCollection(req,body,binding,transport){
 const receipt=await readF03ProvisionReceipt(req.s03,binding);
 if(receipt?.state!=='SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED')
  throw new F04PilotError('F04_F03_RECEIPT_REQUIRED','New, completed F03 provisioning receipt required');
 const schema=await inspectQdrantV2Collection(transport,binding);
 if(schema?.schemaInspected!==true)throw new F04PilotError('F04_SCHEMA_UNVERIFIED','Physical schema not independently verified');
 await attestF03QdrantIndexes(transport,binding);
 return true;
}
/** Test dependency injection never appears on HTTP wire; production uses all defaults. */
export function registerF04PilotRoutes(router,{backendPool,bind=resolveF02Binding,
 verify=verifyCollection,makeAdapter=(transport,binding)=>qdrantV2Adapter({
  f04SourceBoundPilot:true,_request:(...args)=>transport._request(...args)
 },binding),makeLedger=context=>new OperationLedger(context)}={}){
 if(!backendPool||typeof backendPool.get!=='function')throw Error('F04_BACKEND_POOL_REQUIRED');
 router.post('/v2/records/pilot-mutate',async(req,res)=>{
  try{
   validatePilotOrigin(req);
   const body=validateF04Pilot(req.body);
   if(!req?.s03?.userScopeId||!req.s03.vectorsPath)
    throw new F04PilotError('F04_HOST_AUTH_REQUIRED','Authenticated host required',403);
   const {binding}=await bind(req,body,{reserve:false}); // F01 re-attested for every operation.
   if(binding.backend!==body.backend||binding.scope?.userScopeId!==req.s03.userScopeId)
    throw new F04PilotError('F04_SOURCE_NOT_VERIFIED','Binding user/backend mismatch',403);
   const transport=await backendPool.get(req.s03,'qdrant',body.configId??'default');
   await verify(req,body,binding,transport);
   const payload=body.action==='delete'?undefined:body.action==='metadata'?{metadata:body.metadata}:
    {text:body.text,vector:body.vector,...(body.metadata!==undefined?{metadata:body.metadata}:{})};
   const plan=planMutation(req.s03,{backend:'qdrant',scope:binding.scope,embedding:binding.embedding,
    action:body.action,recordId:body.recordId,operationId:body.operationId,
    expectedRevision:body.expectedRevision,...(payload||{})});
   if(plan.collectionKey!==binding.collection.key||plan.physicalCollectionName!==binding.collection.physicalName)
    throw new F04PilotError('F04_PLAN_BINDING_MISMATCH','Planned collection differs from owned F03 collection',403);
   const engine=new MutationEngine({ledger:makeLedger(req.s03),adapter:makeAdapter(transport,binding),
    authorize:async p=>{
     // Repeat ownership validation INSIDE engine; a checked checkbox alone is not authority.
     const {binding:again}=await bind(req,body,{reserve:false});
     if(again.collection.key!==binding.collection.key ||
         JSON.stringify(again.scope)!==JSON.stringify(binding.scope))
      throw new F04PilotError('F04_SOURCE_CHANGED','Saved source changed during operation',403);
     await verify(req,body,again,transport);
     return {authorized:true,ownerVerified:true,mutationContractVerified:true,
      collectionKey:p.collectionKey,backend:p.backend};
    }});
   const result=await engine.execute(plan,payload);
   // The backend can return UNCERTAIN; never re-submit an operation UUID.
   return res.status(result.state==='VERIFIED'?200:202).json({success:result.state==='VERIFIED',
    state:result.state,recordId:plan.recordId,operationId:plan.operationId,
    targetRevision:plan.targetRevision,experimental:true,productionWritesEnabled:false,
    retryable:false,legacyCollectionsTouched:false});
  }catch(error){
   const code=redacted(error),status=Number.isInteger(error?.status)&&error.status>=400&&error.status<=599?error.status:409;
   return res.status(status).json({success:false,code,experimental:true,productionWritesEnabled:false,
    retryable:false,legacyCollectionsTouched:false});
  }
 });
}
