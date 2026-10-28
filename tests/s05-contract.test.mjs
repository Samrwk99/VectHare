import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {collectionIdentity,recordIdentity,contentFingerprint} from '../lib/s02-identity.js';
import {requireReadBinding,validateVector,ownedRecord,verifyPage,walkInventory,ReadError,readPageOptions} from '../lib/s05-contract.js';

export const scope={userScopeId:'alice',collectionId:'my-chat',type:'chat',sourceId:'chat-17',branchId:'branch-1'};
export const embedding={source:'transformers',model:'test-model',dimension:3,metric:'cosine'};
const collection=collectionIdentity({backend:'qdrant',scope,embedding});
export const binding={backend:'qdrant',authorized:true,provenance:'SERVER_VERIFIED',scope,embedding,collection:{key:collection.key,physicalName:collection.physicalName}};
const sha=v=>createHash('sha256').update(v).digest('hex');
export function recordFor(recordId=randomUUID(),overrides={}){
 const id=recordIdentity(scope,recordId),text='hello',vector=[0.1,0.2,0.3],metadata={tag:'test'};
 return {...scope,recordId:id.recordId,physicalId:id.physicalId,revision:1,text,textHash:contentFingerprint(text),vector,vectorHash:sha(JSON.stringify(vector)),
 metadata,metadataHash:sha(JSON.stringify(metadata)),embedding,...overrides};
}
const fails=(fn,code)=>assert.throws(fn,e=>e.code===code);
test('S05 trusted binding required; raw client assertion alone not accepted by route',()=>{
 fails(()=>requireReadBinding({...binding,authorized:false}),'S05_SOURCE_ATTESTATION_REQUIRED');
 fails(()=>requireReadBinding({...binding,provenance:'CLIENT'}),'S05_SOURCE_ATTESTATION_REQUIRED');
 fails(()=>requireReadBinding({...binding,collection:{physicalName:'vecthare_main',key:collection.key}}),'S05_COLLECTION_UNVERIFIED');
 fails(()=>requireReadBinding({...binding,backend:'milvus'}),'S05_COLLECTION_UNVERIFIED');
});
test('S05 strict vector validates finite values, shape and dimension',()=>{
 assert.deepEqual(validateVector([1,2,3],3),[1,2,3]);
 for(const x of [[1,NaN,3],[1,Infinity,3],[1,2],new Float32Array([1,2,3]),['1',2,3]]) fails(()=>validateVector(x,3),'S05_VECTOR_INVALID');
});
test('S05 owner assertions require authoritative physical fields and correct branch',()=>{
 assert.equal(ownedRecord(recordFor(),binding,{includeVector:true}).scope.branchId,'branch-1');
 for(const diff of [{type:'lore'},{userScopeId:'bob'},{sourceId:'chat-18'},{branchId:'branch-2'},{collectionId:'other'}]){
  fails(()=>ownedRecord(recordFor(undefined,diff),binding),'S05_OWNER_MISMATCH');
 }
 const record=recordFor();const {userScopeId,...without}=record;
 fails(()=>ownedRecord({...without,metadata:{...record.metadata,userScopeId:'alice'}},binding),'S05_OWNER_MISMATCH');
});
test('S05 physical id, revision and fingerprints independently verified',()=>{
 for(const [diff,code] of [[{physicalId:randomUUID()},'S05_PHYSICAL_ID_MISMATCH'],[{revision:0},'S05_RECORD_INVALID'],
  [{text:'other'},'S05_CONTENT_MISMATCH'],[{metadataHash:'000'},'S05_METADATA_MISMATCH'],
  [{vectorHash:'abc'},'S05_VECTOR_MISMATCH'],[{embedding:{...embedding,model:'another'}},'S05_EMBEDDING_MISMATCH']]){
  fails(()=>ownedRecord(recordFor(undefined,diff),binding,{includeVector:true}),code);
 }
});
test('S05 strict pagination bounds and duplicate/page owner proof',()=>{
 for(const limit of [0,257,1.5,-4]) fails(()=>readPageOptions({limit}),'S05_PAGE_INVALID');
 const r=recordFor(),s=recordFor();
 assert.equal(verifyPage({items:[r,s],hasMore:false,nextCursor:null},binding,{limit:2}).inventoryVerified,false);
 fails(()=>verifyPage({items:[r,r],hasMore:false},binding,{limit:2}),'S05_DUPLICATE_RECORD');
 fails(()=>verifyPage({items:[r],hasMore:true},binding,{limit:2}),'S05_CURSOR_MISSING');
});
test('S05 inventory traverses >1050 records without claiming a consistent snapshot',async()=>{
 const rows=Array.from({length:1090},()=>recordFor());
 const r=await walkInventory({binding,limit:100,readPage:async({cursor,limit})=>{
  const index=cursor??0;const items=rows.slice(index,index+limit);return {items,hasMore:index+limit<rows.length,nextCursor:index+limit<rows.length?index+limit:null};
 }});
 assert.equal(r.examined,1090);assert.equal(r.pages,11);assert.equal(r.verifiedExportAllowed,false);
});
test('S05 inventory refuses non-advancing cursor and repeated IDs',async()=>{
 const row=recordFor();
 await assert.rejects(()=>walkInventory({binding,readPage:async()=>({items:[row],hasMore:true,nextCursor:5})}),e=>e.code==='S05_CURSOR_LOOP'||e.code==='S05_DUPLICATE_RECORD');
 await assert.rejects(()=>walkInventory({binding,maxPages:1,readPage:async()=>({items:[recordFor()],hasMore:true,nextCursor:5})}),{code:'S05_INVENTORY_BOUNDED'});
});
test('S05 inventory backend errors are never interpreted as empty results',async()=>{
 await assert.rejects(()=>walkInventory({binding,readPage:async()=>{throw new Error('backend offline')}}),/backend offline/);
});
