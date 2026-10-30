/** P-B.2 read-only audit of canonical *saved source* records.
 * A complete traversal here is never evidence of whole physical DB inventory,
 * and no backend writes are allowed through this helper.
 */
const KEY=/^[a-f0-9]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const fail=code=>{throw Error(code);};
/** Explicit bounded UI audit: maxRows is an exposed failure, never truncation. */
export async function auditManagedSavedSource({readPage,shouldContinue=()=>true,onPage=()=>{},maxRows=200000}={}){
 if(typeof readPage!=='function'||typeof shouldContinue!=='function'||typeof onPage!=='function'||
   !integer(maxRows)||maxRows===0)fail('PB2_AUDIT_ARGUMENTS_INVALID');
 let cursor=null,examined=0,total=null,anchor=null,orphanReview=null;
 const seenIds=new Set(),seenCursors=new Set();
 const tally={physicallyVerified:0,missing:0,conflicts:0,registryMismatches:0,sourceChanged:0};
 do{
  if(!shouldContinue())fail('PB2_AUDIT_CANCELLED');
  const page=await readPage(cursor);
  if(!shouldContinue())fail('PB2_AUDIT_CANCELLED');
  if(!page||page.readOnly!==true||page.sourceAuthoritative!==true||
   page.inventoryKind!=='SAVED_SOURCE_RECORDS'||page.completeSavedSource!==true||
   page.inventoryVerified!==false||page.physicalInventoryComplete!==false||
   !KEY.test(page.logicalKey??'')||!KEY.test(page.fileFingerprint??'')||
   !KEY.test(page.registryFingerprint??'')||!integer(page.routingGeneration)||
   !integer(page.sourceSelectionGeneration)||!integer(page.totalRecords)||
   !integer(page.offset)||!Array.isArray(page.records)||page.records.length>50||
   !integer(page.orphanReview)||typeof page.pageComplete!=='boolean')
   fail('PB2_AUDIT_PAGE_UNVERIFIED');
  if(total===null){
   total=page.totalRecords;orphanReview=page.orphanReview;
   if(total>maxRows)fail('PB2_AUDIT_EXPLICIT_ROW_LIMIT');
   anchor=['logicalKey','fileFingerprint','registryFingerprint','routingGeneration',
    'sourceSelectionGeneration','totalRecords','orphanReview','backend','sourceKind']
    .map(k=>page[k]);
  }else if(JSON.stringify(anchor)!==JSON.stringify(['logicalKey','fileFingerprint',
   'registryFingerprint','routingGeneration','sourceSelectionGeneration','totalRecords',
   'orphanReview','backend','sourceKind'].map(k=>page[k])))
   fail('PB2_AUDIT_SCOPE_OR_REGISTRY_CHANGED');
  if(page.offset!==examined||examined+page.records.length>total||
    (page.records.length===0&&examined!==total))fail('PB2_AUDIT_PAGE_SEQUENCE_INVALID');
  for(const row of page.records){
   if(!UUID.test(row?.recordId??'')||seenIds.has(row.recordId)||
    !['VERIFIED','MISSING','CONFLICT'].includes(row.physicalState))
    fail('PB2_AUDIT_RECORD_INVALID_OR_DUPLICATE');
   seenIds.add(row.recordId);
   if(row.physicalState==='VERIFIED')tally.physicallyVerified++;
   if(row.physicalState==='MISSING')tally.missing++;
   if(row.physicalState==='CONFLICT')tally.conflicts++;
   if(row.registryMismatch===true)tally.registryMismatches++;
   if(row.changed===true)tally.sourceChanged++;
  }
  examined+=page.records.length;
  if(page.nextCursor!==null){
   if(typeof page.nextCursor!=='string'||page.nextCursor.length>2048||
      !/^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/.test(page.nextCursor)||
      seenCursors.has(page.nextCursor)||page.pageComplete||examined>=total)
    fail('PB2_AUDIT_CURSOR_INVALID');
   seenCursors.add(page.nextCursor);
  }else if(!page.pageComplete||examined!==total)fail('PB2_AUDIT_EARLY_TERMINATION');
  onPage({examined,total});cursor=page.nextCursor;
 }while(cursor!==null);
 if(!shouldContinue())fail('PB2_AUDIT_CANCELLED');
 // End-of-scan sentinel: re-attest the first source-bound page after the last
 // physical read. Without this, a save/registry change immediately after the
 // final page could yield an apparently complete but mixed-revision report.
 const finalPage=await readPage(null);
 if(!shouldContinue())fail('PB2_AUDIT_CANCELLED');
 const finalAnchor=['logicalKey','fileFingerprint','registryFingerprint','routingGeneration',
   'sourceSelectionGeneration','totalRecords','orphanReview','backend','sourceKind']
   .map(k=>finalPage?.[k]);
 if(!finalPage||finalPage.readOnly!==true||finalPage.inventoryKind!=='SAVED_SOURCE_RECORDS'||
  finalPage.offset!==0||JSON.stringify(anchor)!==JSON.stringify(finalAnchor))
  fail('PB2_AUDIT_CHANGED_DURING_FINAL_ATTESTATION');
 return {inventoryKind:'SAVED_SOURCE_RECORDS',sourceAuthoritative:true,
  completeSavedSource:true,physicalInventoryComplete:false,inventoryVerified:false,
  examined,total,orphanReview,...tally};
}
/** Validate M3's *separate* double-scanned exclusive Qdrant proof. No rows,
 * deletes, backups, ownership overrides or editable metadata are accepted. */
export function verifyQdrantPhysicalProof(data){
 if(!data||data.success!==true||data.backend!=='qdrant'||data.inventoryVerified!==true||
  data.managedV2Only!==true||data.entirePhysicalCollectionVerified!==true||
  data.exclusiveOwner!==true||data.readOnly!==true||
  data.legacySharedCollectionsVerified!==false||data.repairAuthorized!==false||
  data.deleteAuthorized!==false||data.productionCertified!==false||
  !KEY.test(data.logicalKey??'')||!KEY.test(data.inventoryDigest??'')||
  ![data.recordCount,data.uniqueContentHashCount,data.repeatedContentHashGroups,
    data.repeatedContentHashExtraRecords,data.routingGeneration].every(integer)||
  data.uniqueContentHashCount>data.recordCount||
  data.repeatedContentHashExtraRecords!==data.recordCount-data.uniqueContentHashCount||
  'rows' in data||'vectors' in data||'physicalName' in data)
  fail('PB2_QDRANT_PHYSICAL_PROOF_UNVERIFIED');
 return data;
}
