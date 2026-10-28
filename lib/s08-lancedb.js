/** S08 LanceDB v2 internal adapter — disposable-fixture mutations only.
 * Existing legacy tables are never opened by guessed names or altered here.
 * Native SDK/Arrow compatibility, cross-process writes and complete snapshots
 * require real-host validation before any public activation.
 */
import {requireReadBinding,readPageOptions,verifyPage,validateSearchOptions,ownedRecord} from './s05-contract.js';
import {recordIdentity} from './s02-identity.js';
import {requireLocalBinding,validateLocalPlan,validateLocalPayload,localRow,verifyLocalMutation,
 localWritesDisposableOnly,LocalV2Error} from './s08-local-contract.js';

const FIELDS=['physicalId','recordId','userScopeId','collectionId','type','sourceId','branchId',
 'schemaVersion','revision','text','textHash','metadata','metadataHash','embedding','vectorHash','vector'];
const quote=s=>`'${String(s).replaceAll("'","''")}'`;
export function lanceV2ScopePredicate(binding,{physicalId=null,revision=null}={}){
 const b=requireLocalBinding(binding,'lancedb');
 const keys=['userScopeId','collectionId','type','sourceId','branchId'];
 const scope={...b.scope,branchId:b.scope.branchId??''};
 const expr=keys.map(k=>`${k} = ${quote(scope[k])}`);
 if(physicalId!==null){
  if(typeof physicalId!=='string'||physicalId.length!==36)throw new LocalV2Error('S08_ID_INVALID','Invalid physical ID');
  expr.push(`physicalId = ${quote(physicalId)}`);
 }
 if(revision!==null){
  if(!Number.isSafeInteger(revision)||revision<1)throw new LocalV2Error('S08_REVISION_INVALID','Invalid revision');
  expr.push(`revision = ${revision}`);
 }
 return expr.join(' AND ');
}
function decode(row){
 if(!row||typeof row!=='object')throw new LocalV2Error('S08_ROW_INVALID','Malformed LanceDB row');
 let metadata,embedding;
 try{metadata=typeof row.metadata==='string'?JSON.parse(row.metadata):row.metadata;
  embedding=typeof row.embedding==='string'?JSON.parse(row.embedding):row.embedding;}
 catch{throw new LocalV2Error('S08_ROW_INVALID','Malformed stored JSON');}
 return {...row,metadata,embedding,branchId:row.branchId||'',vector:row.vector===undefined?undefined:Array.from(row.vector)};
}
function encode(row){return {...row,metadata:JSON.stringify(row.metadata),embedding:JSON.stringify(row.embedding)};}
async function open(backend,b){
 if(!backend?.db||typeof backend.db.tableNames!=='function'||typeof backend.db.openTable!=='function')
  throw new LocalV2Error('S08_TRANSPORT_INVALID','Scoped LanceDB connection required');
 const names=await backend.db.tableNames();
 if(!Array.isArray(names))throw new LocalV2Error('S08_TABLES_UNVERIFIED','Table discovery failed');
 if(!names.includes(b.physicalName))throw new LocalV2Error('S08_COLLECTION_MISSING','V2 table not provisioned',404);
 return backend.db.openTable(b.physicalName);
}
export async function inspectLanceV2Table(backend,binding){
 const b=requireLocalBinding(binding,'lancedb'),table=await open(backend,b);
 const fields=table?.schema?.fields;
 if(!Array.isArray(fields))throw new LocalV2Error('S08_SCHEMA_UNVERIFIED','LanceDB Arrow schema unavailable');
 const names=new Set(fields.map(f=>f.name));
 if(fields.length!==names.size||FIELDS.some(name=>!names.has(name)))
  throw new LocalV2Error('S08_SCHEMA_MISMATCH','Required v2 table columns missing');
 const vector=fields.find(f=>f.name==='vector');
 if(!Number.isSafeInteger(vector?.type?.listSize)||vector.type.listSize!==b.embedding.dimension)
  throw new LocalV2Error('S08_DIMENSION_MISMATCH','Fixed-width vector schema dimension differs');
 const col=fields.find(f=>f.name==='physicalId');
 if(col?.nullable===true)throw new LocalV2Error('S08_SCHEMA_MISMATCH','Physical ID cannot be nullable');
 return {table,physicalName:b.physicalName,schemaInspected:true,dimension:b.embedding.dimension,
  consistency:'LIVE_UNVERIFIED'};
}
/** Real LanceDB v2 tables must be explicitly created by a later, tested provisioner.
 * S08 intentionally does NOT createEmptyTable with an untested Arrow schema.
 */
export function lancedbV2Adapter(backend,binding){
 const b=requireLocalBinding(binding,'lancedb');
 async function table(){return (await inspectLanceV2Table(backend,binding)).table;}
 async function lookup(recordId){
  const physicalId=recordIdentity(b.scope,recordId).physicalId;
  const t=await table();
  const rows=await t.query().where(lanceV2ScopePredicate(binding,{physicalId})).limit(2).toArray();
  if(!Array.isArray(rows))throw new LocalV2Error('S08_READ_INVALID','LanceDB read missing rows');
  if(rows.length>1)throw new LocalV2Error('S08_DUPLICATE_ID','Duplicate physical IDs');
  if(!rows.length)return null;
  return ownedRecord(decode(rows[0]),binding,{includeVector:true});
 }
 async function before(plan){localWritesDisposableOnly(backend);validateLocalPlan(plan,binding);await table();}
 return Object.freeze({
  inspectSchema:()=>inspectLanceV2Table(backend,binding),
  getRecord:async id=>lookup(typeof id==='string'?id:id.recordId),
  async listPage(options={}){
   const o=readPageOptions(options),offset=o.cursor??0;
   if(!Number.isSafeInteger(offset)||offset<0||offset>100000)
    throw new LocalV2Error('S08_CURSOR_INVALID','LanceDB offset outside bounded range',400);
   const t=await table();
   const rows=await t.query().where(lanceV2ScopePredicate(binding)).orderBy('physicalId').offset(offset).limit(o.limit+1).toArray();
   if(!Array.isArray(rows))throw new LocalV2Error('S08_READ_INVALID','LanceDB page missing rows');
   const hasMore=rows.length>o.limit;
   // This is a display page, NOT a complete immutable snapshot.
   return verifyPage({items:rows.slice(0,o.limit).map(decode),hasMore,nextCursor:hasMore?offset+o.limit:null},binding,o);
  },
  async query(input){
   const o=validateSearchOptions(input,binding),t=await table();
   const rows=await t.vectorSearch(o.vector).where(lanceV2ScopePredicate(binding)).limit(o.topK).toArray();
   if(!Array.isArray(rows))throw new LocalV2Error('S08_READ_INVALID','LanceDB search missing rows');
   return rows.map(r=>{
    const row=ownedRecord(decode(r),binding);
    if(typeof r._distance!=='number'||!Number.isFinite(r._distance))
     throw new LocalV2Error('S08_SCORE_INVALID','LanceDB distance invalid');
    return {...row,distance:r._distance};
   });
  },
  async insertRecord(plan,payload){
   await before(plan);validateLocalPayload(plan,payload,binding);
   if(plan.action!=='insert'||plan.expectedRevision!==0)throw new LocalV2Error('S08_ACTION_INVALID','Insert plan required');
   if(await lookup(plan.recordId)!==null)throw new LocalV2Error('S08_RECORD_EXISTS','Record already exists');
   const t=await table(),row=localRow(plan,payload,null,binding);
   await t.add([encode(row)]);
   return verifyLocalMutation(plan,await lookup(plan.recordId));
  },
  async updateRecord(plan,payload){
   await before(plan);validateLocalPayload(plan,payload,binding);
   if(!['update','metadata'].includes(plan.action))throw new LocalV2Error('S08_ACTION_INVALID','Update plan required');
   const old=await lookup(plan.recordId);
   if(!old||old.revision!==plan.expectedRevision)throw new LocalV2Error('S08_REVISION_CONFLICT','Stale record revision');
   const t=await table(),row=localRow(plan,payload,old,binding);
   const ack=await t.update({where:lanceV2ScopePredicate(binding,{physicalId:plan.physicalId,revision:plan.expectedRevision}),
    values:encode(row)});
   if(Number(ack?.rowsUpdated??ack?.numRowsUpdated)!==1)
    throw new LocalV2Error('S08_MUTATION_UNCERTAIN','Update count not conclusively one');
   return verifyLocalMutation(plan,await lookup(plan.recordId));
  },
  async deleteRecord(plan){
   await before(plan);
   if(plan.action!=='delete')throw new LocalV2Error('S08_ACTION_INVALID','Delete plan required');
   const old=await lookup(plan.recordId);
   if(!old||old.revision!==plan.expectedRevision)throw new LocalV2Error('S08_REVISION_CONFLICT','Stale record revision');
   const t=await table();
   // The predicate is scoped and revision-qualified. No table drop or filesystem rm.
   await t.delete(lanceV2ScopePredicate(binding,{physicalId:plan.physicalId,revision:plan.expectedRevision}));
   return verifyLocalMutation(plan,await lookup(plan.recordId));
  }
 });
}
