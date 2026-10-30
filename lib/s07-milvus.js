/** S07 Milvus v2 adapter: internal, disposable-only mutation testing.
 * No public v2 read/write route is enabled. The caller must independently
 * establish SERVER_VERIFIED host/source scope; this module does not do that.
 * Milvus upsert is not atomic revision-CAS; no production write grant here.
 */
import {createHash} from 'node:crypto';
import {requireReadBinding,validateVector,ReadError} from './s05-contract.js';
import {milvusV2Reads} from './s05-backend-reads.js';
import {recordIdentity,contentFingerprint} from './s02-identity.js';

const sha = x => createHash('sha256').update(x).digest('hex');
// Private module-scoped capability; ordinary browser requests and pilot routes
// cannot supply this token. The M1 controller alone constructs a trusted wrapper.
export const M4C_M1_WRITER_TOKEN=Symbol('M4C_SERVER_ATTESTED_M1_WRITER');
const object = x => !!x && typeof x==='object' && !Array.isArray(x);
const DATATYPE = Object.freeze({Int64:5,VarChar:21,JSON:23,FloatVector:101});
const OWNER_KEYS = Object.freeze(['userScopeId','collectionId','type','sourceId','branchId']);
const REQUIRED_FIELDS = Object.freeze({
 physicalId:{type:'VarChar',max:36,primary:true},recordId:{type:'VarChar',max:36},
 userScopeId:{type:'VarChar',max:1024},collectionId:{type:'VarChar',max:1024},
 type:{type:'VarChar',max:128},sourceId:{type:'VarChar',max:1024},branchId:{type:'VarChar',max:1024},
 schemaVersion:{type:'Int64'},revision:{type:'Int64'},text:{type:'VarChar',max:65535},
 textHash:{type:'VarChar',max:64},metadata:{type:'JSON'},metadataHash:{type:'VarChar',max:64},
 embedding:{type:'JSON'},vectorHash:{type:'VarChar',max:64},vector:{type:'FloatVector'}
});
export class MilvusV2Error extends Error {
 constructor(code,message,status=409){super(message);this.name='MilvusV2Error';this.code=code;this.status=status;}
}
function typeName(field){
 const raw=field.data_type??field.dataType;
 if(typeof raw==='number') return Object.entries(DATATYPE).find(([,v])=>v===raw)?.[0]??null;
 if(typeof raw==='string'){
  if(/^[0-9]+$/.test(raw))return Object.entries(DATATYPE).find(([,v])=>v===Number(raw))?.[0]??null;
  const name=raw.replace(/[^a-z0-9]/gi,'').toLowerCase();
  return Object.keys(DATATYPE).find(n=>n.toLowerCase()===name)??null;
 }
 return null;
}
function parameter(field,key){
 const direct=field[key]??field.type_params?.[key]??field.params?.[key];
 if(direct!==undefined)return Number(direct);
 for(const list of [field.type_params,field.params]){
  if(Array.isArray(list)){
   const entry=list.find(v=>v.key===key);
   if(entry)return Number(entry.value);
  }
 }
 return NaN;
}
function isPrimary(field){return field.is_primary_key===true||field.isPrimaryKey===true;}
function isAuto(field){return field.autoID===true||field.auto_id===true||field.autoId===true;}
function checkStatus(result,description,{requireStatus=false}={}){
 if(!object(result))throw new MilvusV2Error('S07_BACKEND_RESPONSE_INVALID',`${description} response malformed`);
 const status=result.status;
 if(!status){
  if(requireStatus)throw new MilvusV2Error('S07_ACK_UNVERIFIED',`${description} returned no status`);
  return result;
 }
 const code=status.error_code??status.errorCode??status.code;
 if(code!==undefined && code!==0 && code!=='0' && code!=='Success' && code!=='SUCCESS'){
  throw new MilvusV2Error('S07_BACKEND_FAILURE',`${description} failed (${String(code)})`);
 }
 if(requireStatus && code===undefined){
  throw new MilvusV2Error('S07_ACK_UNVERIFIED',`${description} returned unrecognized status`);
 }
 if(status.reason && (code===undefined || (code!==0 && code!=='0'))){
  throw new MilvusV2Error('S07_BACKEND_FAILURE',`${description} reported an error`);
 }
 return result;
}
function transport(backend,binding){
 const b=requireReadBinding(binding);
 if(binding.backend!=='milvus'||!object(backend?.client))throw new MilvusV2Error('S07_BACKEND_INVALID','Milvus v2 binding and client required');
 return {b,client:backend.client};
}
/** Inspect an existing collection ONLY. No auto-create, drop or schema adjustment. */
export async function inspectMilvusV2Collection(backend,binding,{requireIndex=true}={}){
 const {b,client}=transport(backend,binding);
 if(typeof client.describeCollection!=='function')throw new MilvusV2Error('S07_SCHEMA_UNVERIFIABLE','describeCollection required');
 const response=checkStatus(await client.describeCollection({collection_name:b.physicalName,cache:false}),'describeCollection');
 const fields=response.schema?.fields;
 if(!Array.isArray(fields))throw new MilvusV2Error('S07_SCHEMA_UNVERIFIABLE','Milvus schema fields unavailable');
 const map=new Map(fields.map(f=>[f.name,f]));
 if(map.size!==fields.length)throw new MilvusV2Error('S07_SCHEMA_MISMATCH','Duplicate schema field names');
 const primary=fields.filter(isPrimary);
 if(primary.length!==1||primary[0]?.name!=='physicalId'||isAuto(primary[0])||response.schema?.autoID===true){
  throw new MilvusV2Error('S07_SCHEMA_MISMATCH','Physical ID must be the sole non-auto primary key');
 }
 for(const [name,expect] of Object.entries(REQUIRED_FIELDS)){
  const f=map.get(name);
  if(!f||typeName(f)!==expect.type||(!expect.primary&&isPrimary(f))||isAuto(f)){
   throw new MilvusV2Error('S07_SCHEMA_MISMATCH',`Field ${name} missing or incompatible`);
  }
  if(expect.type==='VarChar' && (!Number.isSafeInteger(parameter(f,'max_length'))||parameter(f,'max_length')<expect.max)){
   throw new MilvusV2Error('S07_SCHEMA_MISMATCH',`Field ${name} maximum length incompatible`);
  }
  if(expect.type==='FloatVector' && parameter(f,'dim')!==b.embedding.dimension){
   throw new MilvusV2Error('S07_DIMENSION_MISMATCH','Existing Milvus vector dimensions differ');
  }
  if(f.nullable===true)throw new MilvusV2Error('S07_SCHEMA_MISMATCH',`Required field ${name} must not be nullable`);
 }
 // A matching vector dimension is not enough: the index metric must match too.
 let indexVerified=false;
 if(requireIndex){
  if(typeof client.describeIndex!=='function')throw new MilvusV2Error('S07_INDEX_UNVERIFIABLE','describeIndex required');
  const info=checkStatus(await client.describeIndex({collection_name:b.physicalName,field_name:'vector'}),'describeIndex');
  const indices=info.index_descriptions;
  if(!Array.isArray(indices)||indices.length!==1||indices[0].field_name!=='vector'){
   throw new MilvusV2Error('S07_INDEX_UNVERIFIABLE','Expected exactly one vector index');
  }
  const params=indices[0].params;
  const rawMetric=Array.isArray(params)?params.find(p=>p.key==='metric_type')?.value:
   (object(params)?params.metric_type:undefined);
  const expected={cosine:'COSINE',dot:'IP',euclid:'L2'}[b.embedding.metric];
  if(String(rawMetric).toUpperCase()!==expected){
   throw new MilvusV2Error('S07_INDEX_METRIC_MISMATCH','Vector index metric does not match embedding configuration');
  }
  indexVerified=true;
 }
 return {physicalName:b.physicalName,dimension:b.embedding.dimension,fieldCount:fields.length,
  schemaInspected:true,primaryKeyVerified:true,indexVerified,consistency:'UNVERIFIED_LIVE'};
}
function proposedFields(dimension){
 return Object.entries(REQUIRED_FIELDS).map(([name,def])=>({
  name,data_type:DATATYPE[def.type],...(def.max?{max_length:def.max}:{}),
  ...(def.primary?{is_primary_key:true,auto_id:false}:{}),
  ...(name==='vector'?{dim:dimension}:{})
 }));
}
/** Provision an ABSENT disposable collection only. Partial outcomes are uncertain;
 * NEVER drop or clear automatically. No public route invokes this.
 */
export async function provisionDisposableMilvusV2Collection(backend,binding){
 const {b,client}=transport(backend,binding);
 if(backend.s07DisposableFixture!==true&&backend.f03SourceProvisionAuthorized!==true)throw new MilvusV2Error('S07_PROVISION_NOT_AUTHORIZED','Only explicit disposable fixture provisioning',403);
 if(!['listCollections','createCollection','describeCollection','describeIndex','createIndex','loadCollection'].every(k=>typeof client[k]==='function')){
  throw new MilvusV2Error('S07_PROVISION_UNAVAILABLE','Milvus 2.6 lifecycle SDK methods required');
 }
 const listing=checkStatus(await client.listCollections(),'listCollections');
 if(!Array.isArray(listing.data))throw new MilvusV2Error('S07_INVENTORY_UNVERIFIABLE','Collection listing unavailable');
 if(listing.data.some(x=>x.name===b.physicalName))throw new MilvusV2Error('S07_COLLECTION_EXISTS','Provision refuses existing collections');
 try{
  checkStatus(await client.createCollection({collection_name:b.physicalName,fields:proposedFields(b.embedding.dimension),
   enable_dynamic_field:false,consistency_level:'Strong'}),'createCollection',{requireStatus:true});
  await inspectMilvusV2Collection(backend,binding,{requireIndex:false});
  const metric={cosine:'COSINE',dot:'IP',euclid:'L2'}[b.embedding.metric];
  if(!metric)throw new MilvusV2Error('S07_METRIC_UNSUPPORTED','Unsupported metric');
  checkStatus(await client.createIndex({collection_name:b.physicalName,field_name:'vector',
   index_type:'AUTOINDEX',metric_type:metric}),'createIndex',{requireStatus:true});
  checkStatus(await client.loadCollection({collection_name:b.physicalName}),'loadCollection',{requireStatus:true});
  await inspectMilvusV2Collection(backend,binding);
  return {status:backend.f03SourceProvisionAuthorized===true?'PROVISIONED_SOURCE_BOUND_UNCERTIFIED':'PROVISIONED_DISPOSABLE_ONLY',physicalName:b.physicalName,liveBackendVerified:false};
 }catch(error){
  throw new MilvusV2Error('S07_PROVISION_UNCERTAIN',`Provision result uncertain; do not drop (${error.code??'BACKEND_ERROR'})`);
 }
}
export function milvusV2OwnerExpression(binding,{recordId=null,physicalId=null,revision=null}={}){
 const b=requireReadBinding(binding);
 if(binding.backend!=='milvus')throw new MilvusV2Error('S07_BACKEND_INVALID','Milvus binding required');
 const parts=OWNER_KEYS.map(k=>`${k} == ${JSON.stringify(b.scope[k]??'')}`);
 if(recordId!==null){recordIdentity(b.scope,recordId);parts.push(`recordId == ${JSON.stringify(recordId)}`);}
 if(physicalId!==null){
  if(recordId===null||recordIdentity(b.scope,recordId).physicalId!==physicalId)throw new MilvusV2Error('S07_PHYSICAL_ID_INVALID','Physical ID must match record and scope');
  parts.push(`physicalId == ${JSON.stringify(physicalId)}`);
 }
 if(revision!==null){
  if(!Number.isSafeInteger(revision)||revision<1)throw new MilvusV2Error('S07_REVISION_INVALID','Revision must be positive');
  parts.push(`revision == ${revision}`);
 }
 return parts.join(' && ');
}
function assertPlan(plan,b){
 if(!object(plan)||plan.backend!=='milvus'||plan.schemaVersion!==4||plan.collectionKey!==b.collectionKey||
  plan.physicalCollectionName!==b.physicalName||JSON.stringify(plan.scope)!==JSON.stringify(b.scope)||
  JSON.stringify(plan.embedding)!==JSON.stringify(b.embedding)||plan.physicalId!==recordIdentity(b.scope,plan.recordId).physicalId||
  !Number.isSafeInteger(plan.expectedRevision)||plan.expectedRevision<0||plan.targetRevision!==plan.expectedRevision+1||
  plan.authorized!==false||plan.executionAllowed!==false){
  throw new MilvusV2Error('S07_PLAN_SCOPE_INVALID','Mutation plan does not match Milvus binding',403);
 }
}
function assertPayload(plan,payload,b){
 if(!object(payload)||Object.keys(payload).some(k=>!['text','vector','metadata'].includes(k))){
  throw new MilvusV2Error('S07_PAYLOAD_INVALID','Unrecognized mutation payload',400);
 }
 if(['insert','update'].includes(plan.action)){
  if(typeof payload.text!=='string'||contentFingerprint(payload.text)!==plan.textHash){
   throw new MilvusV2Error('S07_TEXT_MISMATCH','Text differs from signed plan',400);
  }
  if(Buffer.byteLength(payload.text,'utf8')>65535)throw new MilvusV2Error('S07_TEXT_TOO_LONG','Text exceeds Milvus varchar limit',400);
  validateVector(payload.vector,b.embedding.dimension);
  // FloatVector stores float32, not JS float64. Do not accept payloads whose
  // hashes cannot survive a round trip through the actual vector datatype.
  if(!payload.vector.every(v=>Object.is(v,Math.fround(v)))){
   throw new MilvusV2Error('S07_FLOAT32_REQUIRED','Vector must be pre-canonicalized to float32',400);
  }
  if(sha(JSON.stringify(payload.vector))!==plan.vectorHash){
   throw new MilvusV2Error('S07_VECTOR_MISMATCH','Vector differs from planned fingerprint',400);
  }
 }
 if(payload.metadata!==undefined){
  if(!object(payload.metadata)||sha(JSON.stringify(payload.metadata))!==plan.metadataHash){
   throw new MilvusV2Error('S07_METADATA_MISMATCH','Metadata differs from signed plan',400);
  }
 }
}
function storedRow(plan,payload,old,b){
 const text=payload.text??old?.text,vector=payload.vector??old?.vector,metadata=payload.metadata??old?.metadata??{};
 if(typeof text!=='string'||!Array.isArray(vector)||!object(metadata)||Buffer.byteLength(text)>65535){
  throw new MilvusV2Error('S07_ROW_INVALID','Complete Milvus record required');
 }
 validateVector(vector,b.embedding.dimension);
 const textHash=contentFingerprint(text),vectorHash=sha(JSON.stringify(vector)),metadataHash=sha(JSON.stringify(metadata));
 if(plan.textHash!==null&&plan.textHash!==textHash||plan.vectorHash!==null&&plan.vectorHash!==vectorHash||
  plan.metadataHash!==null&&plan.metadataHash!==metadataHash){
  throw new MilvusV2Error('S07_PLAN_HASH_MISMATCH','Stored row and plan fingerprints differ');
 }
 return {schemaVersion:2,...b.scope,branchId:b.scope.branchId??'',physicalId:plan.physicalId,
  recordId:plan.recordId,revision:plan.targetRevision,text,textHash,metadata,metadataHash,
  embedding:b.embedding,vectorHash,vector};
}
function verifyMutationAck(response,action){
 checkStatus(response,action,{requireStatus:true});
 // The SDK can return transport-success with mutation acknowledgement explicitly
 // false; never treat a matching count as conclusive in that case.
 if(response.acknowledged===false)throw new MilvusV2Error('S07_MUTATION_UNCERTAIN',`${action} not acknowledged`);
 const countKey=action==='delete'?'delete_cnt':action==='insert'?'insert_cnt':'upsert_cnt';
 const count=response[countKey];
 if(!Number.isSafeInteger(Number(count))||Number(count)!==1){
  throw new MilvusV2Error('S07_MUTATION_UNCERTAIN',`${action} count not conclusively one`);
 }
 if(Array.isArray(response.err_index)&&response.err_index.length){
  throw new MilvusV2Error('S07_MUTATION_UNCERTAIN',`${action} reported row failures`);
 }
 return true;
}
/** S07 v2 adapter: trusted server-attested M1 or disposable fixture only.
 * Updates are serialized by M1/S04 cooperative locks; Milvus upsert is NOT CAS
 * against external writers. Never mark uncertain outcomes NOT_APPLIED. */
export function milvusV2Adapter(backend,binding){
 const {b,client}=transport(backend,binding);
 if(!['query','search','insert','upsert','deleteEntities'].every(k=>typeof client[k]==='function')){
  throw new MilvusV2Error('S07_BACKEND_INVALID','Milvus read/write SDK contract unavailable');
 }
 const readClient={
  query:async args=>checkStatus(await client.query({...args,consistency_level:'Strong'}),'query'),
  search:async args=>checkStatus(await client.search({...args,consistency_level:'Strong'}),'search')
 };
 const reads=milvusV2Reads({client:readClient},binding);
 const fixtureOnly=()=>{if(backend.s07DisposableFixture!==true&&backend.f08SourceBoundPilot!==true&&backend.m4cTrustedGateway!==M4C_M1_WRITER_TOKEN)throw new MilvusV2Error('S07_WRITE_NOT_ACTIVATED','Milvus writes require trusted server-side source attestation',403);};
 async function before(plan){fixtureOnly();assertPlan(plan,b);await inspectMilvusV2Collection(backend,binding);}
 async function readPlan(plan){assertPlan(plan,b);return reads.getRecord(plan.recordId);}
 return Object.freeze({
  ...reads,inspectSchema:()=>inspectMilvusV2Collection(backend,binding),
  getRecord:input=>typeof input==='string'?reads.getRecord(input):readPlan(input),
  async insertRecord(plan,payload){
   await before(plan);
   if(plan.action!=='insert'||plan.expectedRevision!==0)throw new MilvusV2Error('S07_ACTION_INVALID','Insert plan required');
   assertPayload(plan,payload,b);
   if(await readPlan(plan)!==null)throw new MilvusV2Error('S07_RECORD_EXISTS','Record already exists');
   const row=storedRow(plan,payload,null,b);
   verifyMutationAck(await client.insert({collection_name:b.physicalName,data:[row]}),'insert');
   const found=await reads.getRecord(plan.recordId);
   if(!found||found.revision!==plan.targetRevision||found.textHash!==row.textHash||
    found.vectorHash!==row.vectorHash||found.metadataHash!==row.metadataHash){
    throw new MilvusV2Error('S07_MUTATION_UNCERTAIN','Insert readback unverified');
   }
   return {status:'VERIFIED',operationId:plan.operationId};
  },
  async updateRecord(plan,payload){
   await before(plan);
   if(!['update','metadata'].includes(plan.action))throw new MilvusV2Error('S07_ACTION_INVALID','Update plan required');
   assertPayload(plan,payload,b);
   const old=await readPlan(plan);
   if(!old||old.revision!==plan.expectedRevision)throw new MilvusV2Error('S07_REVISION_CONFLICT','Record absent or version stale');
   // Milvus upsert is NOT atomic compare-and-swap across processes/writers.
   // Only isolated disposable fixtures may execute this path in S07.
   const row=storedRow(plan,payload,old,b);
   verifyMutationAck(await client.upsert({collection_name:b.physicalName,data:[row]}),'upsert');
   const found=await reads.getRecord(plan.recordId);
   if(!found||found.revision!==plan.targetRevision||found.textHash!==row.textHash||
    found.vectorHash!==row.vectorHash||found.metadataHash!==row.metadataHash){
    throw new MilvusV2Error('S07_MUTATION_UNCERTAIN','Update readback unverified');
   }
   return {status:'VERIFIED',operationId:plan.operationId};
  },
  async deleteRecord(plan){
   await before(plan);
   if(plan.action!=='delete')throw new MilvusV2Error('S07_ACTION_INVALID','Delete plan required');
   const old=await readPlan(plan);
   if(!old||old.revision!==plan.expectedRevision)throw new MilvusV2Error('S07_REVISION_CONFLICT','Record absent or version stale');
   const filter=milvusV2OwnerExpression(binding,{recordId:plan.recordId,physicalId:plan.physicalId,revision:plan.expectedRevision});
   verifyMutationAck(await client.deleteEntities({collection_name:b.physicalName,filter}),'delete');
   if(await reads.getRecord(plan.recordId)!==null)throw new MilvusV2Error('S07_MUTATION_UNCERTAIN','Delete readback unverified');
   return {status:'VERIFIED',operationId:plan.operationId};
  }
 });
}
