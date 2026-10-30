/** M0 backend adapter interface. Unsupported methods reject explicitly and do
 * not masquerade as operations supported by a production backend.
 */
import {qdrantV2Adapter} from './s06-qdrant.js';
export const BACKEND_METHODS=Object.freeze(['inspectSchema','getRecord','enumeratePage','insertRecord',
 'updateRecord','deleteRecord','deleteCollection','getInventory','captureBackup','restoreToNew',
 'inspectOperationOutcome','capabilities']);
const denied=(name)=>{throw Object.assign(new Error(`M0_${name}_NOT_CERTIFIED`),{code:'M0_ADAPTER_OPERATION_NOT_CERTIFIED',status:409,method:name});};
export function assertAdapterContract(adapter){
 if(!adapter||BACKEND_METHODS.some(m=>typeof adapter[m]!=='function'))
  throw Object.assign(new Error('M0_ADAPTER_INCOMPLETE'),{code:'M0_ADAPTER_INCOMPLETE'});
 return adapter;
}
/** A fixture-only reference wrapper around existing S06. The wrapper never
 * grants production writes. Collection/inventory/backup remain M3 work.
 */
export function qdrantM0Reference(transport,binding){
 const a=qdrantV2Adapter(transport,binding);
 return assertAdapterContract(Object.freeze({
  inspectSchema:()=>a.inspectSchema(),getRecord:id=>a.getRecord(id),
  enumeratePage:opts=>a.listPage(opts),
  insertRecord:(plan,payload)=>a.insertRecord(plan,payload),
  updateRecord:(plan,payload)=>a.updateRecord(plan,payload),
  deleteRecord:plan=>a.deleteRecord(plan),
  deleteCollection:()=>denied('COLLECTION_DELETE'),
  getInventory:()=>denied('INVENTORY'),captureBackup:()=>denied('BACKUP'),
  restoreToNew:()=>denied('RESTORE'),inspectOperationOutcome:()=>denied('OUTCOME'),
  capabilities:()=>Object.freeze({backend:'qdrant',reference:true,
    productionCertified:false,disposableOnly:true,atomicRevisionCompare:false,
    idempotentGoalStateCertified:false,collectionLifecycleCertified:false,
    methods:BACKEND_METHODS})
 }));
}
/** In-memory backend for testing the contract, never installed in HTTP. */
export function mockM0Backend({fault=()=>null}={}){
 const rows=new Map(),calls=[];
 async function point(stage){calls.push(stage);const error=fault(stage);if(error)throw error;}
 const collection={schemaVersion:2,embedding:{source:'transformers',model:'fixture',dimension:3,metric:'cosine'}};
 return assertAdapterContract({
  rows,calls,async inspectSchema(){await point('inspectSchema');return structuredClone(collection);},
  async getRecord(id){await point('getRecord');return structuredClone(rows.get(id)??null);},
  async enumeratePage({cursor=0,limit=50}={}){await point('enumeratePage');const all=[...rows.values()].sort((a,b)=>a.recordId.localeCompare(b.recordId));
   const entries=all.slice(cursor,cursor+limit);return {items:structuredClone(entries),nextCursor:cursor+limit<all.length?cursor+limit:null};},
  async insertRecord(plan,payload){await point('insertRecord:before');if(rows.has(plan.recordId))return {status:'REJECTED',reason:'ALREADY_EXISTS'};
   rows.set(plan.recordId,{recordId:plan.recordId,revision:1,text:payload.text,vector:[...payload.vector],operationId:plan.operationId});
   await point('insertRecord:after');return {status:'VERIFIED',operationId:plan.operationId};},
  async updateRecord(plan,payload){await point('updateRecord:before');const r=rows.get(plan.recordId);
   if(!r||r.revision!==plan.expectedRevision)return {status:'REJECTED',reason:'REVISION_CONFLICT'};
   rows.set(plan.recordId,{...r,revision:r.revision+1,text:payload.text,vector:[...payload.vector],operationId:plan.operationId});
   await point('updateRecord:after');return {status:'VERIFIED',operationId:plan.operationId};},
  async deleteRecord(plan){await point('deleteRecord:before');const r=rows.get(plan.recordId);
   if(!r||r.revision!==plan.expectedRevision)return {status:'REJECTED',reason:'REVISION_CONFLICT'};
   rows.delete(plan.recordId);await point('deleteRecord:after');return {status:'VERIFIED',operationId:plan.operationId};},
  async deleteCollection(){await point('deleteCollection');rows.clear();return {status:'VERIFIED'};},
  async getInventory(){await point('getInventory');return {items:structuredClone([...rows.values()])};},
  async captureBackup(){await point('captureBackup');return {schema:structuredClone(collection),rows:structuredClone([...rows.values()])};},
  async restoreToNew(backup){await point('restoreToNew');if(rows.size)return {status:'REJECTED',reason:'NOT_FRESH'};
   for(const row of backup.rows)rows.set(row.recordId,structuredClone(row));return {status:'VERIFIED'};},
  async inspectOperationOutcome(operationId){await point('inspectOperationOutcome');return {status:
   [...rows.values()].some(x=>x.operationId===operationId)?'OBSERVED_GOAL_STATE':'UNCERTAIN',
   proofOfDispatch:false};},
  capabilities:()=>({backend:'mock',productionCertified:false,disposableOnly:true})
 });
}
