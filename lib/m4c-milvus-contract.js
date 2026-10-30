/** M4c.2 Milvus collection lifecycle primitives. Invoked only through the
 * authenticated server gateway; the caller holds cross-process writer exclusion.
 * Milvus Strong queries do not exclude external writers: double-read and count
 * attestations are required; no unconditional destructive permission is issued.
 */
import {createHash} from 'node:crypto';
import {requireReadBinding,ownedRecord} from './s05-contract.js';
import {milvusV2Adapter,inspectMilvusV2Collection} from './s07-milvus.js';
import {assertAdapterContract} from './m0-backend-contract.js';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code,status:409});};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const columns=['schemaVersion','recordId','physicalId','userScopeId','collectionId','type','sourceId','branchId',
 'revision','text','textHash','metadata','metadataHash','embedding','vectorHash','vector'];
function check(response,kind,{requireStatus=false}={}){
 if(!response||typeof response!=='object')fail('M4C_'+kind+'_ACK_MISSING');
 const status=response.status;
 if(!status){if(requireStatus)fail('M4C_'+kind+'_ACK_MISSING');return response;}
 const code=status.error_code??status.errorCode??status.code;
 if(code!==undefined&&!['0','Success','SUCCESS'].includes(String(code)))
  fail('M4C_'+kind+'_BACKEND_FAILURE');
 if(requireStatus&&code===undefined)fail('M4C_'+kind+'_ACK_UNVERIFIABLE');
 if(status.reason&&(code===undefined||!['0'].includes(String(code))))
  fail('M4C_'+kind+'_BACKEND_FAILURE');
 if(response.acknowledged===false)fail('M4C_'+kind+'_ACK_UNCERTAIN');
 return response;
}
function parseRow(raw){
 if(!raw||typeof raw!=='object')fail('M4C_ROW_INVALID');
 let metadata=raw.metadata,embedding=raw.embedding;
 try{if(typeof metadata==='string')metadata=JSON.parse(metadata);
  if(typeof embedding==='string')embedding=JSON.parse(embedding);}catch{fail('M4C_ROW_JSON_INVALID');}
 return {...raw,metadata,embedding,vector:Array.from(raw.vector??[])};
}
export function m4cMilvusLifecycleAdapter({backend,binding,writerBoundary,requireLifecycleProof,
 checkOutcome,maxRecords=20000}={}){
 const b=requireReadBinding(binding),client=backend?.client;
 if(binding.backend!=='milvus'||!client||!Number.isSafeInteger(maxRecords)||maxRecords<1||maxRecords>20000)
  fail('M4C_ADAPTER_CONTEXT_UNTRUSTED');
 const basic=milvusV2Adapter(backend,binding);
 async function onePass(){
  if(typeof client.queryIterator!=='function'||typeof client.count!=='function')
   fail('M4C_EXHAUSTIVE_ITERATOR_REQUIRED');
  const total=check(await client.count({collection_name:b.physicalName,filter:'',consistency_level:'Strong'}),'COUNT').data;
  if(!Number.isSafeInteger(total)||total<0||total>maxRecords)fail('M4C_COUNT_UNVERIFIABLE');
  const stream=await client.queryIterator({collection_name:b.physicalName,filter:'',
   output_fields:columns,batchSize:128,consistency_level:'Strong'});
  if(!stream||typeof stream[Symbol.asyncIterator]!=='function')fail('M4C_ITERATOR_UNAVAILABLE');
  const items=[],ids=new Set();let batches=0;
  for await (const batch of stream){
   if(!Array.isArray(batch)||batch.length>128||++batches>Math.ceil(maxRecords/128)+1)
    fail('M4C_ITERATOR_MALFORMED');
   for(const original of batch){
    const row=ownedRecord(parseRow(original),binding,{includeVector:true});
    if(ids.has(row.physicalId))fail('M4C_DUPLICATE_ID');
    ids.add(row.physicalId);items.push(row);
    if(items.length>maxRecords||items.length>total)fail('M4C_INVENTORY_OVERFLOW');
   }
  }
  if(items.length!==total)fail('M4C_INVENTORY_INCOMPLETE');
  const post=check(await client.count({collection_name:b.physicalName,filter:'',consistency_level:'Strong'}),'COUNT').data;
  if(post!==total)fail('M4C_INVENTORY_CHANGED');
  items.sort((a,c)=>a.physicalId.localeCompare(c.physicalId));
  return {items,count:items.length,logicalFingerprint:hash(items)};
 }
 async function inventory({withinBoundary=false}={}){
  if(typeof writerBoundary!=='function')fail('M4C_WRITER_BOUNDARY_REQUIRED');
  const scan=async()=>{
   const schema=await inspectMilvusV2Collection(backend,binding);
   if(schema.indexVerified!==true)fail('M4C_SCHEMA_UNVERIFIED');
   const first=await onePass(),second=await onePass();
   if(first.count!==second.count||first.logicalFingerprint!==second.logicalFingerprint)
    fail('M4C_INVENTORY_CHANGED');
   return {...second,fullPhysicalScan:true,ownerVerified:true,quiescenceProvidedByCaller:true,
    externalWriterExclusionUnproven:true};
  };
  return withinBoundary?scan():writerBoundary(scan);
 }
 async function proof(kind,operationId,backupChecksum){
  if(!UUID.test(operationId??'')||typeof requireLifecycleProof!=='function')fail('M4C_LIFECYCLE_PROOF_REQUIRED');
  const p=await requireLifecycleProof({kind,backend:'milvus',collectionKey:b.collectionKey,
   physicalName:b.physicalName,owner:b.scope.userScopeId,operationId,backupChecksum});
  if(p?.authorized!==true||p.consumed!==true||p.backupVerified!==true||p.operationId!==operationId)
   fail('M4C_LIFECYCLE_PROOF_INVALID');
 }
 async function exists(name){
  if(typeof client.hasCollection==='function'){
   const response=check(await client.hasCollection({collection_name:name}),'HAS_COLLECTION');
   if(typeof response.value!=='boolean')fail('M4C_EXISTENCE_UNVERIFIABLE');
   return response.value;
  }
  if(typeof client.listCollections!=='function')fail('M4C_EXISTENCE_UNVERIFIABLE');
  const response=check(await client.listCollections(),'LIST_COLLECTIONS');
  if(!Array.isArray(response.data)||response.data.some(r=>typeof r?.name!=='string'))
   fail('M4C_COLLECTION_LIST_INCOMPLETE');
  return response.data.some(r=>r.name===name);
 }
 return assertAdapterContract(Object.freeze({
  inspectSchema:()=>inspectMilvusV2Collection(backend,binding),getRecord:basic.getRecord,
  enumeratePage:basic.listPage,insertRecord:basic.insertRecord,updateRecord:basic.updateRecord,
  deleteRecord:basic.deleteRecord,getInventory:inventory,
  async captureBackup(){const snap=await inventory();const pack={format:'VH_MILVUS_LOGICAL_V1',
   backend:'milvus',collectionKey:b.collectionKey,physicalName:b.physicalName,
   scope:b.scope,embedding:b.embedding,items:snap.items,count:snap.count,
   logicalFingerprint:snap.logicalFingerprint};return {...pack,checksum:hash(pack)};},
  async deleteCollection({backup,operationId}={}){
   if(!backup||backup.format!=='VH_MILVUS_LOGICAL_V1'||backup.backend!=='milvus'||
      backup.physicalName!==b.physicalName||backup.collectionKey!==b.collectionKey||
      hash((({checksum,...other})=>other)(backup))!==backup.checksum||
      JSON.stringify(backup.scope)!==JSON.stringify(b.scope)||
      JSON.stringify(backup.embedding)!==JSON.stringify(b.embedding))fail('M4C_BACKUP_PROOF_REQUIRED');
   if(typeof client.dropCollection!=='function')fail('M4C_DROP_UNAVAILABLE');
   return writerBoundary(async()=>{
    const current=await inventory({withinBoundary:true});
    if(current.logicalFingerprint!==backup.logicalFingerprint||current.count!==backup.count)
     fail('M4C_BACKUP_STALE');
    await proof('deleteCollection',operationId,backup.checksum);
    // No blind replay if the transport loses this response; caller retains locks.
    check(await client.dropCollection({collection_name:b.physicalName}),'DROP',{requireStatus:true});
    if(await exists(b.physicalName))fail('M4C_DROP_UNCERTAIN');
    return {status:'VERIFIED',operationId};
   });
  },
  async restoreToNew(backup,{operationId}={}){
   if(!backup||backup.format!=='VH_MILVUS_LOGICAL_V1'||backup.backend!=='milvus'||
    backup.physicalName===b.physicalName||backup.collectionKey!==b.collectionKey||
    JSON.stringify(backup.scope)!==JSON.stringify(b.scope)||
    JSON.stringify(backup.embedding)!==JSON.stringify(b.embedding)||
    !Array.isArray(backup.items)||backup.items.length!==backup.count||
    hash(backup.items)!==backup.logicalFingerprint||
    hash((({checksum,...other})=>other)(backup))!==backup.checksum)fail('M4C_RESTORE_BACKUP_INVALID');
   if(typeof client.insert!=='function')fail('M4C_RESTORE_CLIENT_UNAVAILABLE');
   return writerBoundary(async()=>{
    const initial=await inventory({withinBoundary:true});
    if(initial.count!==0)fail('M4C_RESTORE_TARGET_NOT_EMPTY');
    await proof('restoreToNew',operationId,backup.checksum);
    for(let i=0;i<backup.items.length;i+=128){
     const rows=backup.items.slice(i,i+128).map(r=>{
      const owned=ownedRecord({...r,...r.scope,branchId:r.scope?.branchId??''},binding,{includeVector:true});
      return {schemaVersion:2,...b.scope,branchId:b.scope.branchId??'',physicalId:owned.physicalId,
       recordId:owned.recordId,revision:owned.revision,text:owned.text,textHash:owned.textHash,
       metadata:owned.metadata,metadataHash:owned.metadataHash,embedding:b.embedding,
       vectorHash:owned.vectorHash,vector:owned.vector};
     });
     const ack=check(await client.insert({collection_name:b.physicalName,data:rows}),'RESTORE_INSERT');
     if(Number(ack.insert_cnt)!==rows.length)fail('M4C_RESTORE_INSERT_UNCERTAIN');
    }
    const after=await inventory({withinBoundary:true});
    if(after.count!==backup.count||after.logicalFingerprint!==backup.logicalFingerprint)
     fail('M4C_RESTORE_READBACK_MISMATCH');
    return {status:'VERIFIED',operationId,restoredCount:after.count};
   });
  },
  async inspectOperationOutcome(operationId,evidence){
   if(!UUID.test(operationId??''))fail('M4C_OPERATION_ID_INVALID');
   if(typeof checkOutcome!=='function')return {status:'UNCERTAIN',proofOfDispatch:false};
   const answer=await checkOutcome(operationId,evidence);
   return answer?.status==='PROVEN_APPLIED'&&answer.evidenceVerified===true?
    {status:'PROVEN_APPLIED',evidenceVerified:true}:{status:'UNCERTAIN',proofOfDispatch:false};
  },
  capabilities:()=>({backend:'milvus',productionCertified:false,writerBoundaryRequired:true,
   externalWriterExclusionUnproven:true,uncertainOperationDefault:'QUARANTINE',
   supportedAdapterMethods:true,fullLifecycleGateRequired:true})
 }));
}
