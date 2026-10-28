/** S08 plugin Vectra (Standard) internal v2 adapter.
 * NOT SillyTavern's native /api/vector endpoints. No public v2 routes.
 * Full index scans are only bounded DISPLAY traversals, never snapshot proof.
 */
import {requireReadBinding,readPageOptions,verifyPage,validateSearchOptions,ownedRecord} from './s05-contract.js';
import {recordIdentity} from './s02-identity.js';
import {requireLocalBinding,validateLocalPlan,validateLocalPayload,localRow,
 verifyLocalMutation,localWritesDisposableOnly,LocalV2Error} from './s08-local-contract.js';

function unpack(item){
 if(!item||typeof item!=='object'||!item.metadata||typeof item.metadata!=='object')
  throw new LocalV2Error('S08_ROW_INVALID','Vectra item lacks physical ownership fields');
 if(item.metadata.physicalId!==item.id)
  throw new LocalV2Error('S08_PHYSICAL_ID_INVALID','Vectra item ID and stored physical ID disagree');
 return {...item.metadata,physicalId:item.id,vector:item.vector};
}
function pack(row){const {vector,...metadata}=row;return {id:row.physicalId,vector,metadata};}
export async function inspectVectraV2Index(backend,binding){
 const b=requireLocalBinding(binding,'vectra');
 if(!backend?.index||typeof backend.index.getItem!=='function'||typeof backend.index.listItems!=='function'||
  typeof backend.index.isIndexCreated!=='function')throw new LocalV2Error('S08_TRANSPORT_INVALID','Vectra LocalIndex required');
 // This seal must be loaded from the server-side S02 mapping/registry, not a request.
 const s=backend.s08ServerSchema;
 if(!s||s.schemaVersion!==2||s.provenance!=='SERVER_REGISTRY'||s.collectionKey!==b.collectionKey||
  s.physicalName!==b.physicalName||JSON.stringify(s.embedding)!==JSON.stringify(b.embedding))
  throw new LocalV2Error('S08_SCHEMA_UNVERIFIED','Server-mapped v2 index schema required');
 if(await backend.index.isIndexCreated()!==true)throw new LocalV2Error('S08_COLLECTION_MISSING','V2 index not provisioned',404);
 return {index:backend.index,physicalName:b.physicalName,schemaInspected:'REGISTRY_SEAL_ONLY',
  consistency:'LIVE_UNVERIFIED'};
}
export function vectraV2Adapter(backend,binding){
 const b=requireLocalBinding(binding,'vectra');
 async function index(){return (await inspectVectraV2Index(backend,binding)).index;}
 async function lookup(recordId){
  const rid=recordIdentity(b.scope,recordId),idx=await index();
  const item=await idx.getItem(rid.physicalId);
  return item?ownedRecord(unpack(item),binding,{includeVector:true}):null;
 }
 async function before(plan){localWritesDisposableOnly(backend);validateLocalPlan(plan,binding);await index();}
 async function commit(idx,method,args){
  if(['beginUpdate','endUpdate','cancelUpdate'].some(k=>typeof idx[k]!=='function'))
   throw new LocalV2Error('S08_TX_UNSUPPORTED','Vectra update lifecycle not verified');
  await idx.beginUpdate();
  try{await idx[method](...args);await idx.endUpdate();}
  catch(e){try{await idx.cancelUpdate();}catch{ /* caller must reconcile; original error preserved */ }throw e;}
 }
 return Object.freeze({
  inspectSchema:()=>inspectVectraV2Index(backend,binding),
  getRecord:async id=>lookup(typeof id==='string'?id:id.recordId),
  async listPage(options={}){
   const o=readPageOptions(options),offset=o.cursor??0;
   if(!Number.isSafeInteger(offset)||offset<0||offset>100000)throw new LocalV2Error('S08_CURSOR_INVALID','Invalid offset',400);
   const idx=await index(),items=await idx.listItems();
   if(!Array.isArray(items))throw new LocalV2Error('S08_READ_INVALID','Vectra list did not return items');
   // Vectra loads the index in memory; do not claim this is a stable or complete snapshot.
   if(items.length>20000)throw new LocalV2Error('S08_LIST_BOUNDED','List exceeds safe in-memory display budget');
   const owned=items.map(unpack).map(r=>ownedRecord(r,binding,{includeVector:true}));
   owned.sort((a,c)=>a.physicalId.localeCompare(c.physicalId));
   const part=owned.slice(offset,offset+o.limit),hasMore=offset+o.limit<owned.length;
   const raw=part.map(p=>({...p,...p.scope,branchId:p.scope.branchId??'',embedding:b.embedding}));
   return verifyPage({items:raw,hasMore,nextCursor:hasMore?offset+o.limit:null},binding,o);
  },
  async query(input){
   const o=validateSearchOptions(input,binding),idx=await index();
   if(typeof idx.queryItems!=='function')throw new LocalV2Error('S08_QUERY_UNSUPPORTED','Vectra query API unavailable');
   const matches=await idx.queryItems(o.vector,o.topK);
   if(!Array.isArray(matches))throw new LocalV2Error('S08_READ_INVALID','Vectra query missing results');
   return matches.map(m=>{
    const row=ownedRecord(unpack(m.item),binding,{includeVector:true});
    if(typeof m.score!=='number'||!Number.isFinite(m.score))throw new LocalV2Error('S08_SCORE_INVALID','Invalid search score');
    return {...row,score:m.score};
   });
  },
  async insertRecord(plan,payload){
   await before(plan);validateLocalPayload(plan,payload,binding);
   if(plan.action!=='insert'||plan.expectedRevision!==0)throw new LocalV2Error('S08_ACTION_INVALID','Insert plan required');
   if(await lookup(plan.recordId)!==null)throw new LocalV2Error('S08_RECORD_EXISTS','Record already exists');
   const idx=await index(),row=localRow(plan,payload,null,binding);
   await commit(idx,'insertItem',[pack(row)]);
   return verifyLocalMutation(plan,await lookup(plan.recordId));
  },
  async updateRecord(plan,payload){
   await before(plan);validateLocalPayload(plan,payload,binding);
   if(!['update','metadata'].includes(plan.action))throw new LocalV2Error('S08_ACTION_INVALID','Update plan required');
   const old=await lookup(plan.recordId);
   if(!old||old.revision!==plan.expectedRevision)throw new LocalV2Error('S08_REVISION_CONFLICT','Stale record revision');
   const idx=await index(),row=localRow(plan,payload,old,binding);
   await commit(idx,'upsertItem',[pack(row)]);
   return verifyLocalMutation(plan,await lookup(plan.recordId));
  },
  async deleteRecord(plan){
   await before(plan);
   if(plan.action!=='delete')throw new LocalV2Error('S08_ACTION_INVALID','Delete plan required');
   const old=await lookup(plan.recordId);
   if(!old||old.revision!==plan.expectedRevision)throw new LocalV2Error('S08_REVISION_CONFLICT','Stale record revision');
   await commit(await index(),'deleteItem',[plan.physicalId]);
   return verifyLocalMutation(plan,await lookup(plan.recordId));
  }
 });
}
