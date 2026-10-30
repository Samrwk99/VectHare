/** M4a LanceDB trusted internal lifecycle adapter. No public route or browser
 * authority is conferred by constructing this object. Collections are addressed
 * exclusively by server-attested v2 bindings; all destructive methods require a
 * fresh, server-issued single-use lifecycle authorization and verified backup.
 *
 * This adapter deliberately does not promise an immutable inventory snapshot:
 * callers must hold a backend-wide, externally exclusive writer boundary before
 * using a logical backup for destructive operations.
 */
import {createHash, randomUUID} from 'node:crypto';
import {requireLocalBinding,LocalV2Error} from './s08-local-contract.js';
import {lancedbV2Adapter,inspectLanceV2Table} from './s08-lancedb.js';
import {ownedRecord} from './s05-contract.js';
import {assertAdapterContract} from './m0-backend-contract.js';

const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=(code,detail)=>{throw new LocalV2Error(code,detail);};
const bound=(x,min,max)=>Number.isSafeInteger(x)&&x>=min&&x<=max;
const same=(x,y)=>JSON.stringify(x)===JSON.stringify(y);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Lifecycle authorization exists only in a trusted server closure.  The proof
 * functions are injected by the server; a request's body is never a proof. */
export function m4aLanceLifecycleAdapter({db,binding,writerBoundary,requireLifecycleProof,checkOutcome,
  writeTransport=null,maxRecords=20000}={}){
 const b=requireLocalBinding(binding,'lancedb');
 if(!db||typeof db.tableNames!=='function'||typeof db.openTable!=='function'||
  !bound(maxRecords,1,100000))fail('M4A_TRANSPORT_INVALID','Validated LanceDB transport required');
 const basic=lancedbV2Adapter({db,...(writeTransport??{})},binding);
 async function inventory({withinBoundary=false}={}){
  if(typeof writerBoundary!=='function')fail('M4A_WRITER_BOUNDARY_REQUIRED','Exclusive writer boundary required');
  const scan=async()=>{
   const {table}=await inspectLanceV2Table({db},binding);
   if(typeof table.countRows!=='function')fail('M4A_COUNT_UNAVAILABLE','Complete inventory count unavailable');
   const before=await table.countRows();
   if(!bound(before,0,maxRecords))fail('M4A_INVENTORY_BOUNDS','Collection exceeds verified inventory bound');
   const rows=[];const seen=new Set();const size=128;
   // Read the entire physical table, NOT a scope-filtered subset. A managed
   // collection containing any other owner's entry cannot be purged/backed up.
   for(let offset=0;offset<before;offset+=size){
    const raw=await table.query().orderBy('physicalId').offset(offset).limit(Math.min(size,before-offset)).toArray();
    if(!Array.isArray(raw)||raw.length!==Math.min(size,before-offset))fail('M4A_PAGE_UNCERTAIN','Collection pagination incomplete');
    for(const entry of raw){
     let metadata,embedding;
     try{metadata=typeof entry.metadata==='string'?JSON.parse(entry.metadata):entry.metadata;
      embedding=typeof entry.embedding==='string'?JSON.parse(entry.embedding):entry.embedding;}
     catch{fail('M4A_ROW_CORRUPT','Stored metadata or embedding invalid');}
     const r=ownedRecord({...entry,metadata,embedding,vector:Array.from(entry.vector)},binding,{includeVector:true});
     if(seen.has(r.physicalId))fail('M4A_DUPLICATE_RECORD','Duplicate physical identity detected');
     seen.add(r.physicalId);rows.push(r);
    }
   }
   const after=await table.countRows();
   if(after!==before||rows.length!==before)fail('M4A_INVENTORY_CHANGED','Table changed during inventory');
   return {items:rows,count:rows.length,fullPhysicalScan:true,quiescenceProvidedByCaller:true,
    ownerVerified:true,logicalFingerprint:sha(rows)};
  };
  return withinBoundary?scan():writerBoundary(scan);
 }
 async function proof(kind,details){
  if(typeof requireLifecycleProof!=='function')fail('M4A_LIFECYCLE_NOT_CONNECTED','Trusted lifecycle gate missing');
  const p=await requireLifecycleProof({kind,backend:'lancedb',collectionKey:b.collectionKey,
   physicalName:b.physicalName,owner:b.scope.userScopeId,...details});
  if(p?.authorized!==true||p?.consumed!==true||p?.backupVerified!==true||
    !uuid.test(p.operationId??'')||p.operationId!==details.operationId)
   fail('M4A_LIFECYCLE_PROOF_INVALID','One-use verified lifecycle authorization required');
  return p;
 }
 async function proveTableAbsent(name){
  // LanceDB's tableNames API can be paginated. A truncated first page is NOT
  // proof of physical absence; require exhaustive ordered enumeration.
  const seen=new Set();let after=null;
  for(let page=0;page<100;page++){
   const names=await db.tableNames(after===null?{limit:100}:{limit:100,startAfter:after});
   if(!Array.isArray(names)||names.length>100||
      names.some(x=>typeof x!=='string'||seen.has(x)||(after!==null&&x<=after)))
    fail('M4A_TABLE_ENUMERATION_UNCERTAIN','Cannot prove complete physical table absence');
   if(names.includes(name))fail('M4A_DROP_UNCERTAIN','Dropped table remains present');
   for(let i=0;i<names.length;i++){
    if(i>0&&names[i]<=names[i-1])fail('M4A_TABLE_ORDER_UNVERIFIED','Table listing not ordered');
    seen.add(names[i]);
   }
   if(names.length<100)return true;
   after=names.at(-1);
  }
  fail('M4A_TABLE_LIST_LIMIT','Complete table enumeration unavailable');
 }
 const schema=()=>inspectLanceV2Table({db},binding);
 return assertAdapterContract(Object.freeze({
  inspectSchema:schema,
  getRecord:basic.getRecord,
  enumeratePage:basic.listPage,
  insertRecord:basic.insertRecord,
  updateRecord:basic.updateRecord,
  deleteRecord:basic.deleteRecord,
  getInventory:inventory,
  async captureBackup(){
   const snap=await inventory();
   const pack={format:'VH_LANCEDB_LOGICAL_V1',backend:'lancedb',collectionKey:b.collectionKey,
    physicalName:b.physicalName,scope:b.scope,embedding:b.embedding,items:snap.items,
    count:snap.count,logicalFingerprint:snap.logicalFingerprint};
   return {...pack,checksum:sha(pack)};
  },
  async deleteCollection({backup,operationId}={}){
   if(!backup||backup.checksum!==sha((({checksum,...rest})=>rest)(backup))||
    backup.collectionKey!==b.collectionKey||backup.physicalName!==b.physicalName||
    backup.backend!=='lancedb'||backup.format!=='VH_LANCEDB_LOGICAL_V1'||
    !Array.isArray(backup.items)||backup.items.length!==backup.count||
    sha(backup.items)!==backup.logicalFingerprint||
    !same(backup.scope,b.scope)||!same(backup.embedding,b.embedding))
    fail('M4A_VERIFIED_BACKUP_REQUIRED','Matching verified logical backup required');
   if(typeof writerBoundary!=='function')fail('M4A_WRITER_BOUNDARY_REQUIRED','Exclusive writer boundary required');
   return writerBoundary(async()=>{
    const current=await inventory({withinBoundary:true});
    if(current.logicalFingerprint!==backup.logicalFingerprint||current.count!==backup.count)
     fail('M4A_BACKUP_STALE','Collection differs from verified backup');
    await proof('deleteCollection',{operationId,backupChecksum:backup.checksum,inventoryFingerprint:current.logicalFingerprint});
    if(typeof db.dropTable!=='function')fail('M4A_DROP_UNAVAILABLE','LanceDB drop API unavailable');
    await db.dropTable(b.physicalName);
    await proveTableAbsent(b.physicalName);
    return {status:'VERIFIED',operationId};
   });
  },
  async restoreToNew(backup,{operationId}={}){
   if(!backup||backup.checksum!==sha((({checksum,...rest})=>rest)(backup))||
    backup.format!=='VH_LANCEDB_LOGICAL_V1'||backup.backend!=='lancedb'||
    !same(backup.scope,b.scope)||!same(backup.embedding,b.embedding)||
    backup.physicalName===b.physicalName||
    !Array.isArray(backup.items)||backup.items.length!==backup.count||
    sha(backup.items)!==backup.logicalFingerprint||!bound(backup.count,0,maxRecords))
    fail('M4A_BACKUP_INVALID','Backup integrity or target identity mismatch');
   // This function can only restore a *new*, preprovisioned, empty v2 table.
   // It must never overwrite a populated or historical collection.
   if(typeof writerBoundary!=='function')fail('M4A_WRITER_BOUNDARY_REQUIRED','Exclusive writer boundary required');
   return writerBoundary(async()=>{
   const {table}=await schema();
   if(await table.countRows()!==0)fail('M4A_RESTORE_TARGET_NOT_EMPTY','Fresh empty target required');
   await proof('restoreToNew',{operationId,backupChecksum:backup.checksum});
   for(const r of backup.items){
    // Never overwrite ownership fields to make a foreign row appear valid.
    ownedRecord({...r,...(r.scope??{}),branchId:r.scope?.branchId??'',
      embedding:r.embedding,vector:r.vector},binding,{includeVector:true});
   }
   // In-place restoring the original IDs into an independently provisioned
   // table is valid only if its binding is the same source and generation.
   const chunks=[];for(let i=0;i<backup.items.length;i+=128)chunks.push(backup.items.slice(i,i+128));
   // Reconstruct ONLY the exact F06 Arrow schema columns. The normalized
   // readback object contains a nested `scope` property which is not a table
   // column; passing it to real LanceDB could silently widen or reject rows.
   for(const chunk of chunks)await table.add(chunk.map(r=>({
    physicalId:r.physicalId,recordId:r.recordId,...b.scope,branchId:b.scope.branchId??'',
    schemaVersion:2,revision:r.revision,text:r.text,textHash:r.textHash,
    metadata:JSON.stringify(r.metadata),metadataHash:r.metadataHash,
    embedding:JSON.stringify(b.embedding),vectorHash:r.vectorHash,vector:r.vector
   })));
   const after=await inventory({withinBoundary:true});
   if(after.logicalFingerprint!==backup.logicalFingerprint||after.count!==backup.count)
    fail('M4A_RESTORE_UNCERTAIN','Restored inventory differs from backup');
   return {status:'VERIFIED',operationId,restoredCount:after.count};
   });
  },
  async inspectOperationOutcome(operationId,evidence){
   if(!uuid.test(operationId??''))fail('M4A_OPERATION_ID_INVALID','Operation UUID required');
   // No default NOT_APPLIED classification: deletion removes operation marker
   // and the current LanceDB storage API has no durable per-op history.
   if(typeof checkOutcome!=='function')return {status:'UNCERTAIN',proofOfDispatch:false};
   const result=await checkOutcome(operationId,evidence,{getRecord:basic.getRecord,getInventory:inventory});
   if(!['PROVEN_APPLIED','PROVEN_NOT_APPLIED','UNCERTAIN'].includes(result?.status))
    fail('M4A_OUTCOME_INVALID','Outcome adjudicator returned invalid proof');
   return result;
  },
  capabilities:()=>({backend:'lancedb',contractVersion:'M4a-1',
   methods:['inspectSchema','getRecord','enumeratePage','insertRecord','updateRecord','deleteRecord',
    'deleteCollection','getInventory','captureBackup','restoreToNew','inspectOperationOutcome','capabilities'],
   writerBoundaryRequired:true,lifecycleGateRequired:true,uncertainReplayAllowed:false,
   independentlyProductionCertified:false})
 }));
}
