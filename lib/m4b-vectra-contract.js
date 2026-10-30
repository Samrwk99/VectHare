/** M4b trusted Vectra collection primitives. The caller supplies a server-sealed
 * LocalIndex and holds the cooperative physical writer boundary. There is no
 * public route to this adapter and no browser-controlled filesystem path.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {requireLocalBinding,LocalV2Error} from './s08-local-contract.js';
import {vectraV2Adapter,inspectVectraV2Index} from './s08-vectra.js';
import {ownedRecord} from './s05-contract.js';
import {assertAdapterContract} from './m0-backend-contract.js';
import {f07VectraLocation} from './f07-vectra.js';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=code=>{throw new LocalV2Error(code,code)};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function decode(item){
 if(!item||typeof item!=='object'||typeof item.id!=='string'||item.metadata?.physicalId!==item.id)
  fail('M4B_ITEM_IDENTITY_INVALID');
 return {...item.metadata,physicalId:item.id,vector:item.vector};
}
async function secureFolder(ctx,binding,{exists=true}={}){
 const folder=await f07VectraLocation(ctx,binding),root=path.dirname(folder);
 const rootStat=await fs.lstat(root);
 if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||
    (process.platform!=='win32'&&(rootStat.mode&0o077)))fail('M4B_ROOT_UNTRUSTED');
 let stat;try{stat=await fs.lstat(folder);}catch(e){if(!exists&&e.code==='ENOENT')return folder;throw e;}
 if(!stat.isDirectory()||stat.isSymbolicLink()||(process.platform!=='win32'&&(stat.mode&0o077)))
  fail('M4B_FOLDER_UNTRUSTED');
 // Unexpected files or subdirectories may be foreign data. Never remove them.
 const names=await fs.readdir(folder);
 if(names.some(n=>n!=='index.json'))fail('M4B_FOLDER_CONTENTS_UNTRUSTED');
 if(names.includes('index.json')){
  const file=await fs.lstat(path.join(folder,'index.json'));
  if(!file.isFile()||file.isSymbolicLink()||file.nlink!==1)fail('M4B_INDEX_FILE_UNTRUSTED');
 }
 return folder;
}
export function m4bVectraLifecycleAdapter({backend,binding,ctx,writerBoundary,requireLifecycleProof,
 checkOutcome,maxRecords=20000}={}){
 const b=requireLocalBinding(binding,'vectra');
 if(!ctx?.userScopeId||ctx.userScopeId!==b.scope.userScopeId||typeof backend?.index?.listItems!=='function'||
    !Number.isInteger(maxRecords)||maxRecords<1||maxRecords>20000)fail('M4B_ADAPTER_CONTEXT_UNTRUSTED');
 const basic=vectraV2Adapter(backend,binding);
 async function inventory({withinBoundary=false}={}){
  if(typeof writerBoundary!=='function')fail('M4B_WRITER_BOUNDARY_REQUIRED');
  const scan=async()=>{
   await secureFolder(ctx,binding);
   await inspectVectraV2Index(backend,binding);
   // Vectra's listItems is a full in-memory collection. There is no query
   // filter or page cursor: ALL items must be validated, not just owned ones.
   const original=await backend.index.listItems();
   if(!Array.isArray(original)||original.length>maxRecords)fail('M4B_INVENTORY_LIMIT');
   const ids=new Set(),rows=[];
   for(const entry of original){
    const row=ownedRecord(decode(entry),binding,{includeVector:true});
    if(ids.has(row.physicalId))fail('M4B_DUPLICATE_ID');
    ids.add(row.physicalId);rows.push(row);
   }
   rows.sort((a,c)=>a.physicalId.localeCompare(c.physicalId));
   const again=await backend.index.listItems();
   if(!Array.isArray(again)||again.length!==rows.length)fail('M4B_INVENTORY_CHANGED');
   const normalizedAgain=again.map(decode).map(r=>ownedRecord(r,binding,{includeVector:true}));
   normalizedAgain.sort((a,c)=>a.physicalId.localeCompare(c.physicalId));
   if(digest(rows)!==digest(normalizedAgain))fail('M4B_INVENTORY_CHANGED');
   return {items:rows,count:rows.length,fullPhysicalScan:true,ownerVerified:true,
    quiescenceProvidedByCaller:true,logicalFingerprint:digest(rows)};
  };
  return withinBoundary?scan():writerBoundary(scan);
 }
 async function proof(kind,operationId,backupChecksum){
  if(typeof requireLifecycleProof!=='function'||!UUID.test(operationId??''))fail('M4B_LIFECYCLE_PROOF_REQUIRED');
  const p=await requireLifecycleProof({kind,operationId,backend:'vectra',collectionKey:b.collectionKey,
   physicalName:b.physicalName,owner:b.scope.userScopeId,backupChecksum});
  if(p?.authorized!==true||p?.consumed!==true||p?.backupVerified!==true||p.operationId!==operationId)
   fail('M4B_LIFECYCLE_PROOF_INVALID');
 }
 return assertAdapterContract(Object.freeze({
  inspectSchema:()=>inspectVectraV2Index(backend,binding),
  getRecord:basic.getRecord,enumeratePage:basic.listPage,
  insertRecord:basic.insertRecord,updateRecord:basic.updateRecord,deleteRecord:basic.deleteRecord,
  getInventory:inventory,
  async captureBackup(){const scan=await inventory();const doc={format:'VH_VECTRA_LOGICAL_V1',backend:'vectra',
    collectionKey:b.collectionKey,physicalName:b.physicalName,scope:b.scope,embedding:b.embedding,
    items:scan.items,count:scan.count,logicalFingerprint:scan.logicalFingerprint};
   return {...doc,checksum:digest(doc)};},
  async deleteCollection({backup,operationId}={}){
   if(!backup||backup.backend!=='vectra'||backup.format!=='VH_VECTRA_LOGICAL_V1'||
      backup.collectionKey!==b.collectionKey||backup.physicalName!==b.physicalName||
      !same(backup.scope,b.scope)||!same(backup.embedding,b.embedding)||
      backup.checksum!==digest((({checksum,...x})=>x)(backup)))fail('M4B_BACKUP_PROOF_REQUIRED');
   return writerBoundary(async()=>{
    const current=await inventory({withinBoundary:true});
    if(current.logicalFingerprint!==backup.logicalFingerprint||current.count!==backup.count)
     fail('M4B_BACKUP_STALE');
    const folder=await secureFolder(ctx,binding);
    await proof('deleteCollection',operationId,backup.checksum);
    // No blind retry after this point. The trusted caller must retain locks
    // until an authoritative deletion outcome is established.
    await fs.rm(folder,{recursive:true,force:false,maxRetries:0});
    try{await fs.lstat(folder);fail('M4B_DELETE_NOT_ABSENT');}
    catch(e){if(e.code!=='ENOENT')throw e;}
    return {status:'VERIFIED',operationId};
   });
  },
  async restoreToNew(backup,{operationId}={}){
   if(!backup||backup.format!=='VH_VECTRA_LOGICAL_V1'||backup.backend!=='vectra'||
      !same(backup.scope,b.scope)||!same(backup.embedding,b.embedding)||
      backup.physicalName===b.physicalName||!Array.isArray(backup.items)||
      backup.items.length!==backup.count||backup.count>maxRecords||
      backup.logicalFingerprint!==digest(backup.items)||
      backup.checksum!==digest((({checksum,...doc})=>doc)(backup)))
    fail('M4B_RESTORE_BACKUP_INVALID');
   return writerBoundary(async()=>{
    const initial=await inventory({withinBoundary:true});
    if(initial.count!==0)fail('M4B_RESTORE_TARGET_NOT_EMPTY');
    await proof('restoreToNew',operationId,backup.checksum);
    const index=backend.index;
    if(['beginUpdate','endUpdate','insertItem'].some(m=>typeof index[m]!=='function'))
     fail('M4B_RESTORE_SDK_UNSUPPORTED');
    await index.beginUpdate();
    try{
     for(const row of backup.items){
      const validated=ownedRecord({...row,...row.scope,branchId:row.scope?.branchId??'',embedding:b.embedding},binding,{includeVector:true});
      if(validated.physicalId!==row.physicalId)fail('M4B_RESTORE_RECORD_ID_INVALID');
      const metadata={schemaVersion:2,...b.scope,branchId:b.scope.branchId??'',
       recordId:row.recordId,physicalId:row.physicalId,revision:row.revision,
       text:row.text,textHash:row.textHash,metadata:row.metadata,
       metadataHash:row.metadataHash,embedding:b.embedding,vectorHash:row.vectorHash};
      await index.insertItem({id:row.physicalId,vector:row.vector,metadata});
     }
     await index.endUpdate();
    }catch(e){try{await index.cancelUpdate?.();}catch{}throw e;}
    const after=await inventory({withinBoundary:true});
    if(after.count!==backup.count||after.logicalFingerprint!==backup.logicalFingerprint)
     fail('M4B_RESTORE_READBACK_MISMATCH');
    return {status:'VERIFIED',operationId,restoredCount:after.count};
   });
  },
  async inspectOperationOutcome(operationId,evidence){
   if(!UUID.test(operationId??''))fail('M4B_OPERATION_ID_INVALID');
   if(typeof checkOutcome!=='function')return {status:'UNCERTAIN',proofOfDispatch:false};
   const result=await checkOutcome(operationId,evidence);
   return result?.status==='PROVEN_APPLIED'&&result?.evidenceVerified===true?
    {status:'PROVEN_APPLIED',evidenceVerified:true}:{status:'UNCERTAIN',proofOfDispatch:false};
  },
  capabilities:()=>({backend:'vectra',productionCertified:false,
   core:{insert:true,update:true,revectorize:true,delete:true,backup:true,collectionDelete:true,
    restore:true,scopedPurge:true},uncertainOperationDefault:'QUARANTINE'})
 }));
}
