/** P-B.3 — read-after-write evidence for managed saved records.
 * Uses only authenticated, physically verified saved-source pages. Never infer
 * a successful mutation from an HTTP 200/receipt alone or from legacy hashes.
 */
import {validateSavedBrowserPage} from './pb1-saved-browser.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE=new Set(['insert','restore','repair-missing','update','revectorize','repair-registry']);
export async function verifyManagedRecordReadback({readPage,recordId,action,shouldContinue=()=>true,maxRows=200000}){
 if(typeof readPage!=='function'||!UUID.test(recordId??'')||(!ACTIVE.has(action)&&action!=='delete')||
  !Number.isSafeInteger(maxRows)||maxRows<1)throw Error('PB3_READBACK_ARGUMENTS_INVALID');
 let cursor=null,examined=0,previous=null,found=null,firstRow=null,targetCursor=null;
 const cursors=new Set(),ids=new Set();
 while(true){
  if(!shouldContinue())throw Error('PB3_READBACK_SELECTION_CHANGED');
  const page=validateSavedBrowserPage(await readPage(cursor));
  if(!shouldContinue())throw Error('PB3_READBACK_SELECTION_CHANGED');
  const identity=['logicalKey','fileFingerprint','registryFingerprint','routingGeneration',
   'sourceSelectionGeneration','totalRecords'].map(k=>page[k]);
  if(previous&&identity.some((v,i)=>v!==previous[i]))throw Error('PB3_READBACK_GENERATION_CHANGED');
  previous=identity;
  if(cursor===null)firstRow=page.records[0]??null;
  if(page.totalRecords>maxRows)throw Error('PB3_READBACK_EXPLICIT_LIMIT');
  if(page.offset!==examined||page.records.length===0&&page.nextCursor!==null)
   throw Error('PB3_READBACK_PAGE_SEQUENCE_INVALID');
  for(const row of page.records){
   if(ids.has(row.recordId))throw Error('PB3_READBACK_DUPLICATE_ID');
   ids.add(row.recordId);
   if(row.recordId===recordId){found=row;targetCursor=cursor;}
  }
  examined+=page.records.length;
  if(!page.nextCursor){
   if(examined!==page.totalRecords)throw Error('PB3_READBACK_INCOMPLETE');
   break;
  }
  if(cursors.has(page.nextCursor))throw Error('PB3_READBACK_CURSOR_REPLAY');
  cursors.add(page.nextCursor);cursor=page.nextCursor;
 }
 if(!found)throw Error('PB3_READBACK_SOURCE_RECORD_NOT_FOUND');
 // Re-read the opening page at completion. A concurrent source save or
 // registry update after the last page must not produce a false success.
 if(!shouldContinue())throw Error('PB3_READBACK_SELECTION_CHANGED');
 const final=validateSavedBrowserPage(await readPage(null));
 if(!shouldContinue())throw Error('PB3_READBACK_SELECTION_CHANGED');
 if(final.offset!==0||previous.some((v,i)=>v!==['logicalKey','fileFingerprint','registryFingerprint',
  'routingGeneration','sourceSelectionGeneration','totalRecords'].map(k=>final[k])[i])||
  JSON.stringify(final.records[0]??null)!==JSON.stringify(firstRow))
  throw Error('PB3_READBACK_CHANGED_DURING_FINAL_ATTESTATION');
 // Re-attest the specific target as well, even if it was on page 4,000:
 // a stable registry fingerprint is not itself proof of unchanged physics.
 if(targetCursor!==null){
  if(!shouldContinue())throw Error('PB3_READBACK_SELECTION_CHANGED');
  const last=validateSavedBrowserPage(await readPage(targetCursor));
  if(!shouldContinue())throw Error('PB3_READBACK_SELECTION_CHANGED');
  if(previous.some((v,i)=>v!==['logicalKey','fileFingerprint','registryFingerprint',
   'routingGeneration','sourceSelectionGeneration','totalRecords'].map(k=>last[k])[i])||
   JSON.stringify(last.records.find(row=>row.recordId===recordId)??null)!==JSON.stringify(found))
   throw Error('PB3_READBACK_TARGET_CHANGED_DURING_FINAL_ATTESTATION');
 }
 if(action==='delete'){
  if(found.physicalState!=='MISSING'||found.managedState!=='DELETED')
   throw Error('PB3_READBACK_DELETE_NOT_CONFIRMED');
 }else if(found.physicalState!=='VERIFIED'||found.managedState!=='ACTIVE'||found.changed!==false||
  found.registryMismatch===true||found.displayStatus!=='PHYSICALLY_VERIFIED')
  throw Error('PB3_READBACK_WRITE_NOT_CONFIRMED');
 // Avoid falsely claiming physical *collection* inventory completeness.
 return {recordId,action,readbackVerified:true,physicalState:found.physicalState,
  managedState:found.managedState,examined,inventoryKind:'SAVED_SOURCE_RECORDS',
  physicalInventoryComplete:false};
}
