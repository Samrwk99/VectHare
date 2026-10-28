/** S06 Qdrant v2 physical adapter. NOT a public route or production write grant.
 * Binding is an INTERNAL server-only contract; HTTP clients cannot attest it.
 * The mutation methods are executable only in explicitly marked disposable
 * test fixtures. Real host, multi-writer and Qdrant acceptance remain pending.
 */
import {createHash} from 'node:crypto';
import {requireReadBinding,ownedRecord,ReadError,validateVector} from './s05-contract.js';
import {qdrantV2Reads} from './s05-backend-reads.js';
import {recordIdentity,contentFingerprint} from './s02-identity.js';

const sha=x=>createHash('sha256').update(x).digest('hex');
const metricMap={cosine:'Cosine',dot:'Dot',euclid:'Euclid'};
const isObj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
export class QdrantV2Error extends Error {
 constructor(code,message,status=409){super(message);this.name='QdrantV2Error';this.code=code;this.status=status;}
}
function assertResponse(response,description) {
 if (!isObj(response) || response.status==='error' || response.result===undefined || response.result===null) {
  throw new QdrantV2Error('S06_BACKEND_RESPONSE_INVALID',`${description} response missing result`);
 }
 return response.result;
}
function validateOperationResponse(response,description){
 const r=assertResponse(response,description);
 // Qdrant typically returns {operation_id,status:'completed'|'acknowledged'}.
 if (!isObj(r) || !['completed','acknowledged'].includes(r.status) ||
  (r.operation_id!==undefined && !Number.isSafeInteger(r.operation_id))) {
  throw new QdrantV2Error('S06_MUTATION_ACK_INVALID',`${description} did not return a valid operation acknowledgement`);
 }
 return r; // 'acknowledged' MUST NOT be reported as committed.
}
function assertPlan(plan,b) {
 if (!isObj(plan)||plan.backend!=='qdrant'||plan.schemaVersion!==4||plan.collectionKey!==b.collectionKey||
  plan.physicalCollectionName!==b.physicalName ||
  JSON.stringify(plan.scope)!==JSON.stringify(b.scope)||JSON.stringify(plan.embedding)!==JSON.stringify(b.embedding)) {
  throw new QdrantV2Error('S06_PLAN_SCOPE_INVALID','Plan does not match verified Qdrant binding',403);
 }
 const expected=recordIdentity(b.scope,plan.recordId);
 if(plan.physicalId!==expected.physicalId) throw new QdrantV2Error('S06_RECORD_ID_INVALID','Plan physical ID is invalid',403);
 if(!Number.isSafeInteger(plan.expectedRevision)||plan.expectedRevision<0||
  plan.targetRevision!==plan.expectedRevision+1) throw new QdrantV2Error('S06_REVISION_INVALID','Invalid planned revision');
}
function assertPayload(plan,payload,b) {
 if(!isObj(payload)||Object.keys(payload).some(k=>!['text','vector','metadata'].includes(k))) throw new QdrantV2Error('S06_PAYLOAD_INVALID','Unexpected payload',400);
 if(plan.action==='insert'||plan.action==='update'){
  if(typeof payload.text!=='string'||contentFingerprint(payload.text)!==plan.textHash) throw new QdrantV2Error('S06_TEXT_MISMATCH','Text does not match planned digest');
  validateVector(payload.vector,b.embedding.dimension);
  if(sha(JSON.stringify(payload.vector))!==plan.vectorHash) throw new QdrantV2Error('S06_VECTOR_MISMATCH','Vector does not match planned digest');
 }
 if(payload.metadata!==undefined){
  if(!isObj(payload.metadata)||sha(JSON.stringify(payload.metadata))!==plan.metadataHash) throw new QdrantV2Error('S06_METADATA_MISMATCH','Metadata does not match plan');
 }
}
function rowFor(plan,payload,original,b){
 const text=payload.text??original?.text;
 const vector=payload.vector??original?.vectorReference??original?.vector;
 const metadata=payload.metadata??original?.metadata??{};
 if(typeof text!=='string'||!Array.isArray(vector)||!isObj(metadata)) throw new QdrantV2Error('S06_ROW_INVALID','Complete record required');
 validateVector(vector,b.embedding.dimension);
 const textHash=contentFingerprint(text),vectorHash=sha(JSON.stringify(vector)),metadataHash=sha(JSON.stringify(metadata));
 if(plan.textHash!==null&&plan.textHash!==textHash || plan.vectorHash!==null&&plan.vectorHash!==vectorHash ||
  plan.metadataHash!==null&&plan.metadataHash!==metadataHash) throw new QdrantV2Error('S06_PLAN_HASH_MISMATCH','Record contents differ from mutation plan');
 return {schemaVersion:2,...b.scope,branchId:b.scope.branchId??'',recordId:plan.recordId,physicalId:plan.physicalId,
  revision:plan.targetRevision,text,textHash,metadata,metadataHash,vectorHash,vectorReference:vector,embedding:b.embedding,vector};
}
function fullOwnerFilter(b,recordId=null,revision=null,physicalId=null){
 const must=['userScopeId','collectionId','type','sourceId'].map(key=>({key,match:{value:b.scope[key]}}));
 must.push({key:'branchId',match:{value:b.scope.branchId??''}});
 if(recordId!==null) must.push({key:'recordId',match:{value:recordId}});
 if(physicalId!==null) must.push({key:'physicalId',match:{value:physicalId}});
 if(revision!==null) must.push({key:'revision',match:{value:revision}});
 return {must};
}
/** Read Qdrant schema without creating or replacing collections. */
export async function inspectQdrantV2Collection(backend,binding){
 const b=requireReadBinding(binding);
 if(binding.backend!=='qdrant'||typeof backend?._request!=='function') throw new QdrantV2Error('S06_BACKEND_INVALID','Qdrant transport required');
 let result;
 try {result=assertResponse(await backend._request('GET',`/collections/${b.physicalName}`),'collection inspect');}
 catch(e){if(e.httpStatus===404) throw new QdrantV2Error('S06_COLLECTION_MISSING','V2 collection must be explicitly provisioned',404);throw e;}
 const vectors=result?.config?.params?.vectors;
 if(!isObj(vectors)||vectors.size!==b.embedding.dimension||vectors.distance!==metricMap[b.embedding.metric]||
  Object.keys(vectors).some(k=>!['size','distance','on_disk','datatype','hnsw_config','quantization_config','multivector_config'].includes(k))){
  throw new QdrantV2Error('S06_SCHEMA_MISMATCH','Existing collection vector schema incompatible; no automatic rebuild');
 }
 return {collection:b.physicalName,dimension:vectors.size,distance:vectors.distance,
  status:result.status??null,schemaInspected:true,ownerIndexAttested:false};
}
/** Explicit disposable-only collection provisioning, never implicit in insert.
 * Must not be registered on an HTTP route or used on existing user data.
 * Partial failures are UNCERTAIN: intentionally no cleanup/drop/recreation.
 */
export async function provisionDisposableQdrantV2Collection(backend,binding){
 const b=requireReadBinding(binding);
 if(binding.backend!=='qdrant'||typeof backend?._request!=='function'||backend.s06DisposableFixture!==true&&backend.f03SourceProvisionAuthorized!==true) {
  throw new QdrantV2Error('S06_PROVISION_NOT_AUTHORIZED','Disposable test transport and Qdrant binding required',403);
 }
 const url=`/collections/${b.physicalName}`;
 try {
  await backend._request('GET',url);
  throw new QdrantV2Error('S06_COLLECTION_EXISTS','Provisioning refuses any existing collection');
 }catch(e){if(e.httpStatus!==404) throw e;}
 try {
  const created=assertResponse(await backend._request('PUT',url,{
   vectors:{size:b.embedding.dimension,distance:metricMap[b.embedding.metric]}}),'collection creation');
  if(created!==true) throw new QdrantV2Error('S06_PROVISION_UNCERTAIN','Creation acknowledgement was not conclusive');
  await inspectQdrantV2Collection(backend,binding);
  for(const field of ['userScopeId','collectionId','type','sourceId','branchId','recordId','physicalId']){
   const ack=assertResponse(await backend._request('PUT',`${url}/index?wait=true`,{
    field_name:field,field_schema:'keyword'}),'payload index creation');
   if(isObj(ack)&&ack.status&&!['completed','acknowledged'].includes(ack.status)){
    throw new QdrantV2Error('S06_INDEX_UNCERTAIN','Payload index operation not accepted');
   }
  }
  return {status:backend.f03SourceProvisionAuthorized===true?'PROVISIONED_SOURCE_BOUND_UNCERTIFIED':'PROVISIONED_DISPOSABLE_ONLY',physicalName:b.physicalName,verifiedSchema:true,
   ownerIndexesRequested:true,liveBackendVerified:false};
 }catch(e){
  throw new QdrantV2Error('S06_PROVISION_UNCERTAIN',`Provisioning outcome uncertain; never delete automatically (${e.code??'BACKEND_ERROR'})`);
 }
}

/** Qdrant v2 scope filter, including explicit empty-string branch for unbranched chats. */
export function qdrantV2OwnerFilter(binding,{recordId=null,revision=null,physicalId=null}={}){
 const b=requireReadBinding(binding);
 if(binding.backend!=='qdrant') throw new QdrantV2Error('S06_BACKEND_INVALID','Qdrant binding required');
 return fullOwnerFilter(b,recordId,revision,physicalId);
}
/** This constructor does not grant write authorization: mutation methods only run
 * on specifically marked disposable in-memory test transports. */
export function qdrantV2Adapter(backend,binding){
 const b=requireReadBinding(binding);
 if(binding.backend!=='qdrant'||typeof backend?._request!=='function') throw new QdrantV2Error('S06_BACKEND_INVALID','Qdrant binding and transport required');
 const reads=qdrantV2Reads(backend,binding);
 const endpoint=`/collections/${b.physicalName}/points`;
 function disposableOnly(){
  if(backend.s06DisposableFixture!==true) throw new QdrantV2Error('S06_WRITE_NOT_ACTIVATED','Real Qdrant writes require host attestation and live acceptance',409);
 }
 async function getByPlan(plan){assertPlan(plan,b);return reads.getRecord(plan.recordId);}
 async function beforeMutation(plan){
  disposableOnly();assertPlan(plan,b);
  await inspectQdrantV2Collection(backend,binding);
 }
 async function confirmed(recordId){return reads.getRecord(recordId);}
 return Object.freeze({
  ...reads,
  inspectSchema:()=>inspectQdrantV2Collection(backend,binding),
  getRecord:async(planOrId)=>typeof planOrId==='string'?reads.getRecord(planOrId):getByPlan(planOrId),
  async insertRecord(plan,payload){
   await beforeMutation(plan);
   if(plan.action!=='insert'||plan.expectedRevision!==0) throw new QdrantV2Error('S06_ACTION_INVALID','Insert plan required');
   assertPayload(plan,payload,b);
   if(await getByPlan(plan)!==null) throw new QdrantV2Error('S06_RECORD_EXISTS','Record already exists');
   const row=rowFor(plan,payload,null,b),{vector,...stored}=row;
   const ack=validateOperationResponse(await backend._request('PUT',`${endpoint}?wait=true`,{points:[{id:plan.physicalId,vector,payload:stored}]}),'insert');
   if(ack.status!=='completed') throw new QdrantV2Error('S06_MUTATION_UNCERTAIN','Insert acknowledged but completion is uncertain');
   const actual=await confirmed(plan.recordId);
   if(!actual||actual.revision!==plan.targetRevision||actual.textHash!==plan.textHash||actual.vectorHash!==plan.vectorHash||actual.metadataHash!==row.metadataHash) {
    throw new QdrantV2Error('S06_MUTATION_UNCERTAIN','Insert readback not verified');
   }
   return {status:'VERIFIED',operationId:plan.operationId};
  },
  async updateRecord(plan,payload){
   await beforeMutation(plan);
   if(!['update','metadata'].includes(plan.action)) throw new QdrantV2Error('S06_ACTION_INVALID','Update plan required');
   assertPayload(plan,payload,b);
   const old=await getByPlan(plan);
   if(!old||old.revision!==plan.expectedRevision) throw new QdrantV2Error('S06_REVISION_CONFLICT','Record absent or revision stale');
   // IMPORTANT: Qdrant upsert does NOT offer cross-process atomic revision-CAS.
   // This path is restricted to disposable test fixtures until an exclusive
   // server-wide write policy is live-proven and old-writer interference excluded.
   const row=rowFor(plan,payload,old,b),{vector,...stored}=row;
   const ack=validateOperationResponse(await backend._request('PUT',`${endpoint}?wait=true`,{points:[{id:plan.physicalId,vector,payload:stored}]}),'update');
   if(ack.status!=='completed') throw new QdrantV2Error('S06_MUTATION_UNCERTAIN','Update acknowledgement uncertain');
   const actual=await confirmed(plan.recordId);
   if(!actual||actual.revision!==plan.targetRevision||actual.textHash!==row.textHash||actual.vectorHash!==row.vectorHash||actual.metadataHash!==row.metadataHash) {
    throw new QdrantV2Error('S06_MUTATION_UNCERTAIN','Update readback not verified');
   }
   return {status:'VERIFIED',operationId:plan.operationId};
  },
  async deleteRecord(plan){
   await beforeMutation(plan);
   if(plan.action!=='delete') throw new QdrantV2Error('S06_ACTION_INVALID','Delete plan required');
   const old=await getByPlan(plan);
   if(!old||old.revision!==plan.expectedRevision) throw new QdrantV2Error('S06_REVISION_CONFLICT','Record absent or revision stale');
   const ack=validateOperationResponse(await backend._request('POST',`${endpoint}/delete?wait=true`,{
    filter:fullOwnerFilter(b,plan.recordId,plan.expectedRevision,plan.physicalId)}),'delete');
   if(ack.status!=='completed') throw new QdrantV2Error('S06_MUTATION_UNCERTAIN','Delete acknowledgement uncertain');
   if(await confirmed(plan.recordId)!==null) throw new QdrantV2Error('S06_MUTATION_UNCERTAIN','Deletion readback not verified');
   return {status:'VERIFIED',operationId:plan.operationId};
  }
 });
}
