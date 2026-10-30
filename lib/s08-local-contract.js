/** S08 local backend v2 invariants. INTERNAL only; no public HTTP mutation grant.
 * These helpers validate an S04 intent against an S05 server-attested binding.
 */
import {createHash} from 'node:crypto';
import {recordIdentity,contentFingerprint} from './s02-identity.js';
import {requireReadBinding,validateVector,ownedRecord} from './s05-contract.js';

const isObj=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export class LocalV2Error extends Error {
 constructor(code,message,status=409){super(message);this.name='LocalV2Error';this.code=code;this.status=status;}
}
export function requireLocalBinding(binding,backend){
 const b=requireReadBinding(binding);
 if(binding.backend!==backend)throw new LocalV2Error('S08_BACKEND_MISMATCH',`${backend} binding required`,403);
 return b;
}
export function validateLocalPlan(plan,binding){
 const b=requireReadBinding(binding);
 if(!isObj(plan)||plan.schemaVersion!==4||plan.backend!==binding.backend||plan.collectionKey!==b.collectionKey||
  plan.physicalCollectionName!==b.physicalName||JSON.stringify(plan.scope)!==JSON.stringify(b.scope)||
  JSON.stringify(plan.embedding)!==JSON.stringify(b.embedding)||
  typeof plan.recordId!=='string'||plan.physicalId!==recordIdentity(b.scope,plan.recordId).physicalId||
  !Number.isSafeInteger(plan.expectedRevision)||plan.expectedRevision<0||
  plan.targetRevision!==plan.expectedRevision+1||plan.authorized!==false||plan.executionAllowed!==false||
  !['insert','update','metadata','delete'].includes(plan.action)){
  throw new LocalV2Error('S08_PLAN_INVALID','Mutation plan does not match authorized binding',403);
 }
 return b;
}
export function validateLocalPayload(plan,payload,binding){
 const b=validateLocalPlan(plan,binding);
 if(!isObj(payload)||Object.keys(payload).some(k=>!['text','vector','metadata'].includes(k)))
  throw new LocalV2Error('S08_PAYLOAD_INVALID','Unexpected fields in mutation payload',400);
 if(['insert','update'].includes(plan.action)){
  if(typeof payload.text!=='string'||contentFingerprint(payload.text)!==plan.textHash)
   throw new LocalV2Error('S08_TEXT_MISMATCH','Text does not match mutation plan',400);
  validateVector(payload.vector,b.embedding.dimension);
  // LanceDB and some Vectra builds serialize float32. Require a roundtrip-safe plan.
  if(!payload.vector.every(v=>Object.is(v,Math.fround(v))))
   throw new LocalV2Error('S08_FLOAT32_REQUIRED','Vector must be canonicalized to float32 before planning',400);
  if(sha(payload.vector)!==plan.vectorHash)
   throw new LocalV2Error('S08_VECTOR_MISMATCH','Vector fingerprint differs from plan',400);
 }
 if(payload.metadata!==undefined&&(!isObj(payload.metadata)||sha(payload.metadata)!==plan.metadataHash))
  throw new LocalV2Error('S08_METADATA_MISMATCH','Metadata differs from plan',400);
 if(plan.action==='delete'&&Object.keys(payload).length)
  throw new LocalV2Error('S08_PAYLOAD_INVALID','Delete cannot have payload',400);
 if(plan.action==='metadata'&&Object.keys(payload).some(k=>k!=='metadata'))
  throw new LocalV2Error('S08_PAYLOAD_INVALID','Metadata update cannot replace text/vector',400);
 return b;
}
export function localRow(plan,payload,prior,binding){
 const b=requireReadBinding(binding);
 const text=payload.text??prior?.text,vector=payload.vector??prior?.vector,metadata=payload.metadata??prior?.metadata??{};
 if(typeof text!=='string'||!isObj(metadata))throw new LocalV2Error('S08_ROW_INVALID','Complete record required');
 validateVector(vector,b.embedding.dimension);
 const row={schemaVersion:2,...b.scope,branchId:b.scope.branchId??'',recordId:plan.recordId,
  physicalId:plan.physicalId,revision:plan.targetRevision,text,textHash:contentFingerprint(text),
  vector,vectorHash:sha(vector),metadata,metadataHash:sha(metadata),embedding:b.embedding};
 if(plan.textHash!==null&&plan.textHash!==row.textHash||plan.vectorHash!==null&&plan.vectorHash!==row.vectorHash||
  plan.metadataHash!==null&&plan.metadataHash!==row.metadataHash)
  throw new LocalV2Error('S08_PLAN_HASH_MISMATCH','Computed record fingerprints differ from plan');
 return row;
}
export function verifiedLocalRow(raw,binding){return ownedRecord(raw,binding,{includeVector:true});}
export function verifyLocalMutation(plan,record){
 if(plan.action==='delete'){
  if(record!==null)throw new LocalV2Error('S08_MUTATION_UNCERTAIN','Record still visible after deletion');
 } else if(!record||record.physicalId!==plan.physicalId||record.revision!==plan.targetRevision||
  (plan.textHash!==null&&record.textHash!==plan.textHash)||
  (plan.vectorHash!==null&&record.vectorHash!==plan.vectorHash)||
  (plan.metadataHash!==null&&record.metadataHash!==plan.metadataHash)){
  throw new LocalV2Error('S08_MUTATION_UNCERTAIN','Readback does not prove intended mutation');
 }
 return {status:'VERIFIED',operationId:plan.operationId};
}
export const M4A_M1_WRITER_TOKEN=Symbol('M4A_TRUSTED_SERVER_SAVED_SOURCE_GATEWAY');
export function localWritesDisposableOnly(transport){
 if(transport?.s08DisposableFixture!==true&&transport?.m4aTrustedGateway!==M4A_M1_WRITER_TOKEN)throw new LocalV2Error('S08_WRITE_NOT_ACTIVATED',
  'S08 public mutations remain blocked until real-host and backend acceptance',409);
}
