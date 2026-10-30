/** M0 HTTP gateway foundation: source-attested, scope-derived plans only.
 * Execution stays deliberately disabled until M1 supplies a reviewed trusted
 * dispatch, registry state transaction, ledger, lock and readback implementation.
 */
import {randomUUID} from 'node:crypto';
import {resolveF02Binding} from './f02-public-reads.js';
import {getEmbeddingProfile} from './f09b5-embedding-profiles.js';
import {readF03ProvisionReceipt} from './f03-provision.js';
import {capability,capabilityMatrix} from './m0-capabilities.js';
import {M1_IMPLEMENTATION_EVIDENCE} from './m1-saved-records.js';
import {M3_IMPLEMENTATION_EVIDENCE} from './m3-collections.js';
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const bad=(code,status=409)=>Object.assign(new Error(code),{code,status});
const sourceFields={chat:['kind','avatar','chatFile'],'group-chat':['kind','groupId','chatFile'],lorebook:['kind','name']};
export function validatePlanIntent(body){
 if(!plain(body)||Object.keys(body).some(k=>!['backend','configId','source','action','recordId'].includes(k)))
  throw bad('M0_BROWSER_FIELD_FORBIDDEN',403);
 if(!['qdrant','milvus','lancedb','vectra'].includes(body.backend)||
  !['insert','update','revectorize','delete'].includes(body.action))throw bad('M0_INTENT_INVALID',400);
 if(body.configId!==undefined&&(!['local','default'].includes(body.configId)||
  (body.configId==='local'&&body.backend!=='qdrant')))throw bad('M0_CONFIG_SELECTOR_INVALID',400);
 const fields=sourceFields[body.source?.kind];
 if(!fields||!plain(body.source)||Object.keys(body.source).some(k=>!fields.includes(k))||
  fields.some(k=>typeof body.source[k]!=='string'||!body.source[k]||body.source[k].length>220))
  throw bad('M0_SOURCE_SELECTOR_INVALID',400);
 if(typeof body.recordId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.recordId))
  throw bad('M0_RECORD_SELECTOR_INVALID',400);
 return body;
}
export async function planSavedMutation(req,logicalKey,{bind=resolveF02Binding,getProfile=getEmbeddingProfile,
 getReceipt=readF03ProvisionReceipt}={}){
 if(!req?.s03?.userScopeId)throw bad('M0_AUTH_REQUIRED',403);
 const intent=validatePlanIntent(req.body);
 if(!/^[a-f0-9]{64}$/.test(logicalKey))throw bad('M0_COLLECTION_KEY_INVALID',400);
 const {configured,profile}=await getProfile(req.s03);
 if(!configured||!profile)throw bad('M0_EMBEDDING_PROFILE_REQUIRED');
 // Server reads configured model/dimension; browser cannot override it.
 const {binding}=await bind(req,{backend:intent.backend,configId:intent.configId,
   source:intent.source,embedding:profile},{reserve:false});
 if(binding.collection.key!==logicalKey||binding.scope.userScopeId!==req.s03.userScopeId)
  throw bad('M0_COLLECTION_BINDING_MISMATCH',403);
 const receipt=await getReceipt(req.s03,binding);
 if(receipt?.state!=='SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED')throw bad('M0_F03_SCHEMA_RECEIPT_REQUIRED');
 return Object.freeze({operationId:randomUUID(),backend:binding.backend,logicalKey:binding.collection.key,
  recordId:intent.recordId,action:intent.action,sourceAttested:true,
  embeddingProfile:{source:profile.source,model:profile.model,dimension:profile.dimension,metric:profile.metric},
  authorizedForExecution:false,executionAllowed:false,reasonCode:'M0_EXECUTION_NOT_CERTIFIED'});
}
export function registerM0GatewayRoutes(router,deps={}){
 const error=(res,e)=>res.status(Number.isInteger(e.status)?e.status:409).json({success:false,
  code:/^M0_[A-Z0-9_]+$/.test(e?.code??'')?e.code:'M0_PLAN_REFUSED',executionAllowed:false});
 router.post('/v2/collections/:logicalKey/records/plan',async(req,res)=>{
  try{const plan=await planSavedMutation(req,req.params.logicalKey,deps);
   res.json({success:true,plan,executionAllowed:false});}catch(e){error(res,e);}
 });
 // Permanent fail-closed M0 handler, replaced by the M1 integrated gateway,
 // not forwarded to generic S04 /v2/operations/submit or /chunks/*.
 router.post('/v2/mutations/execute',(_req,res)=>res.status(409).json({success:false,
  code:'M0_EXECUTION_NOT_CERTIFIED',executionAllowed:false,retryable:false}));
 router.get('/v2/collections/:logicalKey/capabilities',async(req,res)=>{
  try{
   if(!/^[a-f0-9]{64}$/.test(req.params.logicalKey))throw bad('M0_COLLECTION_KEY_INVALID',400);
   if(req.query && Object.keys(req.query).length)throw bad('M0_QUERY_FIELDS_FORBIDDEN',403);
   // A guessed logical hash is not an authorization. Do not leak whether one exists.
   res.status(409).json({success:false,code:'M0_COLLECTION_ATTESTATION_REQUIRED',
    capabilities:[],executionAllowed:false});
  }catch(e){error(res,e);}
 });
 router.get('/v2/m0/capabilities',async(_req,res)=>{
  const report=typeof deps.liveCapabilityEvidence==='function'?await deps.liveCapabilityEvidence():{};
  const implementationEvidenceByOperation=Object.fromEntries(
   [...['qdrant','lancedb','vectra','milvus'].flatMap(backend=>['insert','update','revectorize','delete'].map(op=>[`${backend}:${op}`,M1_IMPLEMENTATION_EVIDENCE])),
    ...['backup','restore','collection-delete','scoped-purge'].map(op=>[`qdrant:${op}`,M3_IMPLEMENTATION_EVIDENCE]),
    ['lancedb:backup',M3_IMPLEMENTATION_EVIDENCE],
    ['lancedb:collection-delete',M3_IMPLEMENTATION_EVIDENCE],
    ['lancedb:restore',M3_IMPLEMENTATION_EVIDENCE],
    ['lancedb:scoped-purge',M3_IMPLEMENTATION_EVIDENCE],
    ['vectra:backup',M3_IMPLEMENTATION_EVIDENCE],
    ['vectra:collection-delete',M3_IMPLEMENTATION_EVIDENCE],
    ['vectra:restore',M3_IMPLEMENTATION_EVIDENCE],
    ['vectra:scoped-purge',M3_IMPLEMENTATION_EVIDENCE],
    ...['backup','restore','collection-delete','scoped-purge'].map(op=>[`milvus:${op}`,M3_IMPLEMENTATION_EVIDENCE])]);
  const cells=capabilityMatrix({hostVersion:report.hostVersion??null,
   evidenceByOperation:report.evidenceByOperation??{},implementationEvidenceByOperation});
  return res.json({success:true,contractVersion:2,cells,
   manualTestWritesEnabled:cells.some(c=>c.enabled),productionWritesEnabled:false,
   productionCertified:false,evidenceAccepted:cells.some(c=>c.validationStatus==='VERIFIED')});
 });
}
