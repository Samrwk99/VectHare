import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {adapterCollectionId,requireTenantScope,rejectUnscopedPointOperation} from '../utils/tenant-route.js';
import {inventoryPages} from '../utils/c11-paginated-inventory.js';
import {inspectAdapterInventory} from '../utils/c11-adapter-inventory.js';
import {hasVerifiedCapability} from '../utils/backend-contracts.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const key='qdrant:openai:vh:chat:id-1';
const fakeSettings={vector_backend:'qdrant',source:'openai',qdrant_multitenancy:true};
const quiet={log(){},warn(){},error(){},debug(){}};
const adapter=(name)=>{
 const code=fs.readFileSync(path.join(root,'backends',`${name}.js`),'utf8').replace(/^import .*?;\s*$/gm,'').replace('export class ','class ');
 let sends=0; const requests=[];
 const context=vm.createContext({console:quiet,VectorBackend:class{},getModelField:()=>null,getRequestHeaders:()=>({}),
  getProviderSpecificParams:()=>({}),mergeDefinedChunkMetadata:x=>x,trustedQueryMetadata:x=>x,
  VECTOR_LIST_LIMIT:100, requireListedItems:x=>x.items,requireQueryItems:x=>x.results,hybridEndpointUnsupported:()=>false,
  hasVerifiedCapability,adapterCollectionId,requireTenantScope,rejectUnscopedPointOperation,
  fetch:async(url,options)=>{sends++;requests.push({url,body:options?.body ? JSON.parse(options.body) : null});return {ok:true,json:async()=>(name==='standard' ? [] : {items:[],results:[]})};},
  URLSearchParams});
 const Type=vm.runInContext(code+'\n'+{standard:'StandardBackend',qdrant:'QdrantBackend',milvus:'MilvusBackend',lancedb:'LanceDBBackend'}[name],context);
 return {backend:new Type(),sends:()=>sends,requests};
};
test('C04-A: existing qualified tenant IDs are authoritative; bare legacy remains compat',()=>{
 assert.equal(adapterCollectionId('qdrant:openai:vh:chat:UUID','qdrant','openai'),'vh:chat:UUID');
 assert.equal(adapterCollectionId('openai:vh:chat:UUID','qdrant','openai'),'vh:chat:UUID');
 assert.equal(adapterCollectionId('vh:chat:UUID','qdrant','openai'),'vh:chat:UUID');
 assert.throws(()=>adapterCollectionId('milvus:openai:vh:chat:UUID','qdrant','openai'),/route mismatch/);
 assert.throws(()=>adapterCollectionId('qdrant:cohere:vh:chat:UUID','qdrant','openai'),/route mismatch/);
 assert.throws(()=>adapterCollectionId('milvus:BAD:vh:chat:UUID','qdrant','openai'),/Malformed/);
 assert.throws(()=>adapterCollectionId('openai:vh:chat:UUID','qdrant','cohere'),/route mismatch/);
 assert.throws(()=>adapterCollectionId('','qdrant','openai'),/Invalid/);
});
test('C06-A: all backend capabilities retain unverified tenant and pagination flags',()=>{
 for (const name of ['standard','qdrant','milvus','lancedb']){
  for(const cap of ['tenantFilter','pointTenantFilter','listPagination','completeInventory'])
   assert.equal(hasVerifiedCapability(name,cap),false,`${name}:${cap} must not be presumed supported`);
 }
});
test('C06-A: Qdrant multitenancy cannot point-delete/get/purge without proof; no fetch',async()=>{
 const a=adapter('qdrant');
 await assert.rejects(a.backend.deleteVectorItems(key,['shared'],fakeSettings),/acknowledgement unverified/);
 await assert.rejects(a.backend.getChunk(key,'shared',fakeSettings),/does not carry verified tenant scope/);
 await assert.rejects(a.backend.purgeVectorIndex(key,fakeSettings),/shared physical collection purge disabled/);
 assert.equal(a.sends(),0);
});
test('C06-A: Qdrant separate-mode refuses cross-backend qualified identities before fetch',async()=>{
 const a=adapter('qdrant'),settings={...fakeSettings,qdrant_multitenancy:false};
 await assert.rejects(a.backend.getSavedHashes('milvus:openai:vh:chat:id-1',settings),/route mismatch/);
 await assert.rejects(a.backend.getSavedHashes('qdrant:cohere:vh:chat:id-1',settings),/route mismatch/);
 assert.equal(a.sends(),0);
});
test('C06-A: Milvus shared tenants cannot read/write/delete before verified filtering',async()=>{
 const a=adapter('milvus'),settings={vector_backend:'milvus',source:'openai'};
 await assert.rejects(a.backend.getSavedHashes('milvus:openai:vh:chat:a',settings),/tenantFilter contract unavailable/);
 await assert.rejects(a.backend.insertVectorItems('milvus:openai:vh:chat:a',[{hash:3}],settings),/tenantFilter contract unavailable/);
 await assert.rejects(a.backend.deleteVectorItems('milvus:openai:vh:chat:a',['3'],settings),/acknowledgement unverified/);
 await assert.rejects(a.backend.getChunk('milvus:openai:vh:chat:a','3',settings),/does not carry verified tenant scope/);
 await assert.rejects(a.backend.purgeAllVectorIndexes(settings),/Global Milvus purge disabled/);
 assert.throws(()=>a.backend._parseCollectionId('qdrant:openai:vh:chat:a',settings),/route mismatch/);
 assert.equal(a.sends(),0);
});
test('C04-A: Standard receives the native collection ID and rejects cross-backend identity',async()=>{
 const a=adapter('standard'),settings={source:'openai',vector_backend:'standard'};
 assert.deepEqual(await a.backend.getSavedHashes('standard:openai:vh:chat:uuid',settings),[]);
 assert.equal(a.requests[0].body.collectionId,'vh:chat:uuid');
 assert.equal(a.requests[0].body.source,'openai');
 await assert.rejects(a.backend.getSavedHashes('qdrant:openai:vh:chat:uuid',settings),/route mismatch/);
 assert.equal(a.sends(),1);
});
test('C06-A: direct targeted deletes require verified acknowledgement before any send',async()=>{
 for(const name of ['standard','lancedb','qdrant','milvus']){
  const a=adapter(name),settings={source:'openai',vector_backend:name,qdrant_multitenancy:false};
  await assert.rejects(a.backend.deleteVectorItems(`${name}:openai:vh:chat:a`,['shared'],settings),/acknowledgement unverified/);
  assert.equal(a.sends(),0,name);
 }
});
test('C06-A: direct Standard global purge cannot bypass C01 gate',async()=>{
 const a=adapter('standard');
 await assert.rejects(a.backend.purgeAllVectorIndexes({source:'openai'}),/Global Standard purge disabled/);
 assert.equal(a.sends(),0);
});
test('C06-A: direct Standard purge cannot bypass unverified C01 acknowledgement gate',async()=>{
 const a=adapter('standard');
 await assert.rejects(a.backend.purgeVectorIndex('standard:openai:vh:chat:uuid',{source:'openai'}),/acknowledgement contract unverified/);
 assert.equal(a.sends(),0);
});
test('C06-A: direct LanceDB purge cannot bypass unverified C01 acknowledgement gate',async()=>{
 const a=adapter('lancedb');
 await assert.rejects(a.backend.purgeVectorIndex('lancedb:openai:vh:chat:uuid',{source:'openai'}),/acknowledgement unverified/);
 assert.equal(a.sends(),0);
});
test('C06-A: LanceDB cannot purge a globally unverified collection list',async()=>{
 const a=adapter('lancedb');
 await assert.rejects(a.backend.purgeAllVectorIndexes({source:'openai'}),/Global LanceDB purge disabled/);
 await assert.rejects(a.backend.getSavedHashes('milvus:openai:vh:chat:a',{source:'openai'}),/route mismatch/);
 assert.equal(a.sends(),0);
});
test('C11-A: offset scan over 120k records confirms complete only on explicit end',async()=>{
 const k='qdrant:openai:vh:chat:big',total=120_001,records=Array.from({length:total},(_,i)=>String(i));
 const seen=[];
 const result=await inventoryPages({key:k,mode:'offset',contractVerified:true,pageSize:5000,maxPages:30,expectedCount:total,
  readPage:({key,offset,limit})=>{seen.push(offset);const part=records.slice(offset,offset+limit);return {scope:key,items:part.map(recordId=>({recordId,collectionKey:key})),endOfList:offset+part.length>=total};}});
 assert.equal(result.complete,true);assert.equal(result.count,total);assert.equal(result.pages,25);assert.equal(seen.at(-1),120000);
});
test('C11-A: cursor traversal and count verify a scoped two-page inventory',async()=>{
 const result=await inventoryPages({key,mode:'cursor',contractVerified:true,expectedCount:2,
  readPage:({cursor})=>cursor===null?{scope:key,items:[{recordId:'a',collectionKey:key}],endOfList:false,nextCursor:'second'}:
  {scope:key,items:[{recordId:'b',collectionKey:key}],endOfList:true}});
 assert.equal(result.complete,true);assert.deepEqual(result.recordIds,['a','b']);
});
for(const [label,readPage,options] of [
 ['unknown end',()=>({scope:key,items:[{recordId:'a',collectionKey:key}]})],
 ['short page not proof',()=>({scope:key,items:[{recordId:'a',collectionKey:key}],endOfList:false}),{maxPages:3}],
 ['foreign scope',()=>({scope:'milvus:openai:vh:chat:id-1',items:[],endOfList:true})],
 ['foreign record',()=>({scope:key,items:[{recordId:'a',collectionKey:'qdrant:openai:other'}],endOfList:true})],
 ['server failure',()=>{throw Error('network');}],
 ['duplicate across pages',({offset})=>({scope:key,items:[{recordId:'a',collectionKey:key}],endOfList:offset!==0})],
 ['unconfirmed count',()=>({scope:key,items:[],endOfList:true}),{expectedCount:2}],
 ['page size violation',()=>({scope:key,items:[{recordId:'a'},{recordId:'b'}],endOfList:true}),{pageSize:1}],
 ]) test(`C11-A refuses ${label}`,async()=>{
   const result=await inventoryPages({key,mode:'offset',contractVerified:true,readPage,...options});
   assert.equal(result.complete,false);
 });
test('C11-A no confirmed contract means zero network activity',async()=>{
 let calls=0;
 const result=await inventoryPages({key,mode:'offset',readPage:async()=>{calls++;return {};}});
 assert.equal(result.status,'unavailable');assert.equal(calls,0);
});
test('C01 bridge does not call the adapter while backend capability contracts remain unknown',async()=>{
 let calls=0;
 const result=await inspectAdapterInventory({key,settings:fakeSettings,adapter:{listChunks:async()=>{calls++;return {};}}});
 assert.equal(result.complete,false);assert.equal(result.status,'unavailable');assert.equal(calls,0);
});
test('C01 bridge refuses a different backend identity before network',async()=>{
 let calls=0;
 const result=await inspectAdapterInventory({key,settings:{source:'openai',vector_backend:'milvus'},adapter:{listChunks:async()=>{calls++;}}});
 assert.equal(result.complete,false);assert.equal(calls,0);
});
