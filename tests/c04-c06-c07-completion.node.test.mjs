import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyCollectionOwner} from '../utils/c04-ownership.js';
import {createScopedFacade} from '../utils/c06-scoped-facade.js';
import {planPhysicalIdMigration,applyPhysicalIdMigration} from '../utils/c07-physical-migration.js';
import {recordId} from '../utils/record-identity.js';
const key='qdrant:openai:colA',foreign='milvus:openai:colA';
const mk=(cap=()=>false,adapter={})=>{
 let calls=0;
 const f=createScopedFacade({settings:{vector_backend:'qdrant',source:'openai'},capability:cap,
  resolveAdapter:async()=>{calls++;return adapter;}});
 return {f,calls:()=>calls};
};
const verifyAll=()=>true;
const records=[
 {recordId:'11',collectionKey:key,text:'message one',vector:[0.1,0.2],metadata:{linkedHashes:['12'],parentHash:'12'}},
 {recordId:'12',collectionKey:key,text:'message two',vector:[0.2,0.3],metadata:{linkedHashes:['11']}},
];
const inventory=(items=records)=>({complete:true,contractVerified:true,endOfListConfirmed:true,
 scope:key,expectedCount:items.length,records:items});
const identities=[{oldId:'11',localId:'message:uid1',verified:true},{oldId:'12',localId:'message:uid2',verified:true}];
const plan=()=>planPhysicalIdMigration({collectionKey:key,inventory:inventory(),identities});

test('C04 both chat and character exclusive locks must match simultaneously',()=>{
 const metadata={enabled:true,lockMode:'exclusive',lockedToChatIds:['chat-1'],lockedToCharacterIds:['char-1']};
 assert.equal(verifyCollectionOwner({collectionKey:key,metadata,chatId:'chat-2',characterId:'char-1'}).allowed,false);
 assert.equal(verifyCollectionOwner({collectionKey:key,metadata,chatId:'chat-1',characterId:'char-2'}).allowed,false);
 assert.equal(verifyCollectionOwner({collectionKey:key,metadata,chatId:'chat-1',characterId:'char-1'}).allowed,true);
});
test('C04 a foreign collection metadata identity never confers ownership',()=>{
 assert.equal(verifyCollectionOwner({collectionKey:key,metadata:{collectionKey:foreign,enabled:true}}).allowed,false);
});
test('C06 unknown point capability prevents network access',async()=>{
 const {f,calls}=mk();
 await assert.rejects(f.getByIds({key,recordIds:['1']}),/tenantFilter contract unverified/);
 await assert.rejects(f.updatePayload({key,updates:[{recordId:'1',metadata:{x:2}}]}),/tenantFilter contract unverified/);
 await assert.rejects(f.count({key}),/count contract unverified/);
 assert.equal(calls(),0);
});
test('C06 reject mismatched route on every new facade method',async()=>{
 const {f,calls}=mk();
 await assert.rejects(f.getByIds({key:foreign,recordIds:['1']}),/route mismatch/);
 await assert.rejects(f.updatePayload({key:foreign,updates:[{recordId:'1',metadata:{}}]}),/route mismatch/);
 await assert.rejects(f.count({key:foreign}),/route mismatch/);
 assert.equal(calls(),0);
});
test('C06 count requires independent verified scope when returning envelope',async()=>{
 const {f}=mk(verifyAll,{countScopedRecords:()=>({scope:foreign,contractVerified:true,count:4})});
 assert.equal((await f.count({key})).status,'unavailable');
});
test('C06 valid count does not translate a zero count to unavailable',async()=>{
 const {f}=mk(verifyAll,{countScopedRecords:()=>({scope:key,contractVerified:true,count:0})});
 assert.deepEqual(await f.count({key}),{status:'confirmed',scope:key,count:0});
});
test('C06 list rejects count that is not a safe integer',async()=>{
 const {f}=mk(verifyAll,{countScopedRecords:()=>-1,listScopedPage:()=>({})});
 assert.equal((await f.list({key})).complete,false);
});
test('C06 point read requires server verified complete response',async()=>{
 const {f}=mk(verifyAll,{getByIdsScoped:()=>({scope:key,complete:false,contractVerified:true,items:[]})});
 assert.equal((await f.getByIds({key,recordIds:['1']})).status,'unavailable');
});
test('C06 point read rejects foreign tenant, duplicate IDs and extra IDs',async()=>{
 let result={scope:key,complete:true,contractVerified:true,items:[{recordId:'1',collectionKey:foreign}]};
 const {f}=mk(verifyAll,{getByIdsScoped:()=>result});
 assert.equal((await f.getByIds({key,recordIds:['1']})).status,'unavailable');
 result={...result,items:[{recordId:'1',collectionKey:key},{recordId:'1',collectionKey:key}]};
 assert.equal((await f.getByIds({key,recordIds:['1']})).status,'unavailable');
 result={...result,items:[{recordId:'2',collectionKey:key}]};
 assert.equal((await f.getByIds({key,recordIds:['1']})).status,'unavailable');
});
test('C06 scoped point reads retain explicit missing IDs (not empty success)',async()=>{
 const {f}=mk(verifyAll,{getByIdsScoped:()=>({scope:key,complete:true,contractVerified:true,items:[{recordId:'1',collectionKey:key}]})});
 assert.deepEqual((await f.getByIds({key,recordIds:['1','2']})).missingIds,['2']);
});
test('C06 refuse duplicate target IDs before point lookup network call',async()=>{
 let read=false;const {f}=mk(verifyAll,{getByIdsScoped:()=>{read=true;return {};}});
 await assert.rejects(f.getByIds({key,recordIds:['1','1']}),/Unique/);
 assert.equal(read,false);
});
test('C06 scoped updatePayload cannot assert success on HTTP only',async()=>{
 const {f}=mk(verifyAll,{updatePayloadScoped:()=>({scope:key,httpStatus:200,updated:1})});
 assert.equal((await f.updatePayload({key,updates:[{recordId:'1',metadata:{a:1}}]})).status,'uncertain');
});
test('C06 scoped update requires count and explicit contract verified',async()=>{
 const {f}=mk(verifyAll,{updatePayloadScoped:()=>({scope:key,contractVerified:true,confirmed:true,updated:2})});
 assert.equal((await f.updatePayload({key,updates:[{recordId:'1',metadata:{a:1}}]})).status,'uncertain');
});
test('C06 scoped update accepts explicit proven count',async()=>{
 const {f}=mk(verifyAll,{updatePayloadScoped:()=>({scope:key,contractVerified:true,confirmed:true,updated:1})});
 assert.equal((await f.updatePayload({key,updates:[{recordId:'1',metadata:{a:1}}]})).status,'confirmed');
});
test('C06 reject invalid metadata update before adapter call',async()=>{
 let called=false;const {f}=mk(verifyAll,{updatePayloadScoped:()=>{called=true;return {};}});
 await assert.rejects(f.updatePayload({key,updates:[{recordId:'1',metadata:null}]}),/metadata/);
 assert.equal(called,false);
});
test('C06 reject cross-tenant write before adapter call',async()=>{
 let called=false;const {f}=mk(verifyAll,{upsertScoped:()=>{called=true;return {};}});
 await assert.rejects(f.upsert({key,items:[{collectionKey:foreign}]}),/Cross-tenant/);
 assert.equal(called,false);
});
test('C06 point delete requires point tenant proof before adapter call',async()=>{
 let called=false;const {f}=mk((_,flag)=>flag!=='pointTenantFilter',{deleteScoped:()=>{called=true;return {};}});
 await assert.rejects(f.remove({key,recordIds:['1']}),/pointTenantFilter contract unverified/);
 assert.equal(called,false);
});
test('C07 plan requires a true complete scoped inventory, not a short page',()=>{
 for (const override of [{complete:false},{scope:foreign},{contractVerified:false},{endOfListConfirmed:false},{expectedCount:1}]) {
  assert.equal(planPhysicalIdMigration({collectionKey:key,inventory:{...inventory(),...override},identities}).status,'blocked');
 }
});
test('C07 plan rejects duplicate physical record IDs and foreign record owner',()=>{
 assert.equal(planPhysicalIdMigration({collectionKey:key,inventory:inventory([records[0],records[0]]),identities}).status,'blocked');
 assert.equal(planPhysicalIdMigration({collectionKey:key,inventory:inventory([{...records[0],collectionKey:foreign},records[1]]),identities}).status,'blocked');
});
test('C07 unmapped or unverified identities cannot migrate',()=>{
 assert.equal(planPhysicalIdMigration({collectionKey:key,inventory:inventory(),identities:identities.slice(0,1)}).status,'blocked');
 assert.equal(planPhysicalIdMigration({collectionKey:key,inventory:inventory(),identities:[{...identities[0],verified:false},identities[1]]}).status,'blocked');
});
test('C07 two different old IDs cannot collapse onto one physical ID',()=>{
 const p=planPhysicalIdMigration({collectionKey:key,inventory:inventory(),identities:[identities[0],{...identities[1],localId:identities[0].localId}]});
 assert.equal(p.status,'blocked');assert.equal(p.reason,'new-record-id-collision');
});
test('C07 missing source text or unresolved links cannot be silently migrated',()=>{
 const bad=[{...records[0],text:undefined},records[1]];
 assert.equal(planPhysicalIdMigration({collectionKey:key,inventory:inventory(bad),identities}).status,'blocked');
 const wrong=[{...records[0],metadata:{parentHash:'does-not-exist'}},records[1]];
 assert.equal(planPhysicalIdMigration({collectionKey:key,inventory:inventory(wrong),identities}).status,'blocked');
});
test('C07 plan remaps parent and linked IDs without mutating inventory',()=>{
 const orig=structuredClone(records),p=plan();assert.equal(p.status,'ready');
 assert.deepEqual(records,orig);
 assert.equal(p.changes[0].newId,recordId(key,'message:uid1'));
 assert.equal(p.changes[0].metadata.parentHash,recordId(key,'message:uid2'));
 assert.equal(p.changes[0].metadata.linkedHashes[0],recordId(key,'message:uid2'));
});
test('C07 physical ID cannot overwrite an unrelated occupied target',()=>{
 const p=planPhysicalIdMigration({collectionKey:key,inventory:inventory(),identities,existingIds:[recordId(key,'message:uid1')]});
 assert.equal(p.status,'blocked');
});
test('C07 cannot apply plan without explicit approval and verified server contracts',async()=>{
 let calls=0;const replaceRecords=()=>{calls++;};
 for (const opts of [{approved:false,verifiedContracts:true},{approved:true,verifiedContracts:false}]) {
  assert.equal((await applyPhysicalIdMigration(plan(),{...opts,currentInventory:inventory(),replaceRecords})).status,'blocked');
 }
 assert.equal(calls,0);
});
test('C07 stale inventory blocks migration before backend dispatch',async()=>{
 let calls=0;const p=plan();
 const res=await applyPhysicalIdMigration(p,{approved:true,verifiedContracts:true,currentInventory:inventory([{...records[0],text:'changed'},records[1]]),replaceRecords:()=>{calls++;}});
 assert.equal(res.status,'blocked');assert.equal(calls,0);
});
test('C07 confirmed C02 callback returns commit and one all-or-none replacement call',async()=>{
 let calls=0;const p=plan();
 const res=await applyPhysicalIdMigration(p,{approved:true,verifiedContracts:true,currentInventory:inventory(),replaceRecords:async request=>{
  calls++;assert.deepEqual(request.oldIds,['11','12']);assert.equal(request.newItems.length,2);
  assert.equal(request.kind,'physical-id-migration');return {status:'committed',operationId:'op1',deletedIds:['11','12']};
 }});
 assert.equal(res.status,'committed');assert.equal(calls,1);
});
test('C07 uncertain C02 callback is never presented as a completed migration',async()=>{
 const res=await applyPhysicalIdMigration(plan(),{approved:true,verifiedContracts:true,currentInventory:inventory(),replaceRecords:async()=>({status:'needs-reconcile',operationId:'op2'})});
 assert.equal(res.status,'needs-reconcile');assert.equal(res.operationId,'op2');
});
test('C07 transport failure after dispatch retains uncertainty',async()=>{
 const res=await applyPhysicalIdMigration(plan(),{approved:true,verifiedContracts:true,currentInventory:inventory(),replaceRecords:async()=>{throw Error('lost connection');}});
 assert.equal(res.status,'needs-reconcile');
});
import {backendConfigurationFingerprint} from '../utils/backend-configuration.js';
test('C06 backend cache key changes for provider, endpoint, tenant and model, without hashing raw credentials',()=>{
 const base={source:'openai',qdrant_host:'localhost',qdrant_multitenancy:false,openai_model:'a',qdrant_api_key:'a'};
 const original=backendConfigurationFingerprint('qdrant',base);
 for (const change of [{source:'cohere'},{qdrant_host:'other'},{qdrant_multitenancy:true},{openai_model:'b'}]) {
  assert.notEqual(backendConfigurationFingerprint('qdrant',{...base,...change}),original);
 }
 assert.notEqual(backendConfigurationFingerprint('milvus',base),original);
 assert.equal(backendConfigurationFingerprint('qdrant',{...base,qdrant_api_key:'rotated'}),original);
});
test('C06 backend cache fingerprint is insensitive to unrelated UI configuration',()=>{
 const x={source:'openai',qdrant_host:'localhost'};
 assert.equal(backendConfigurationFingerprint('qdrant',x),backendConfigurationFingerprint('qdrant',{...x,ui_theme:'dark'}));
});
test('C07 physical migration refuses missing original vectors unless reembed is independently certified',()=>{
 const raw=[{...records[0],vector:undefined},records[1]];
 assert.equal(planPhysicalIdMigration({collectionKey:key,inventory:inventory(raw),identities}).status,'blocked');
 assert.equal(planPhysicalIdMigration({collectionKey:key,inventory:inventory(raw),identities,verifiedReembed:true}).status,'ready');
});
test('C07 physical migration does not accept status-only commit or incomplete delete receipt',async()=>{
 const result=await applyPhysicalIdMigration(plan(),{approved:true,verifiedContracts:true,currentInventory:inventory(),replaceRecords:async()=>({status:'committed',operationId:'x'})});
 assert.equal(result.status,'needs-reconcile');
});
import {embeddingProfileFingerprint,EMBEDDING_PROFILE_VERSION} from '../utils/record-identity.js';
test('C07 embedding profile stamp changes when model, source or chunk strategy changes',()=>{
 const base={source:'ollama',ollama_model:'a',chunking_strategy:'per_message'};
 const value=embeddingProfileFingerprint(base);
 assert.match(EMBEDDING_PROFILE_VERSION,/v1/);
 for (const diff of [{ollama_model:'b'},{source:'openai',openai_model:'a'},{chunking_strategy:'message_batch'}])
  assert.notEqual(embeddingProfileFingerprint({...base,...diff}),value);
});
test('C07 embedding profile never fingerprints secret keys or API endpoints',()=>{
 const base={source:'ollama',ollama_model:'a'};
 assert.equal(embeddingProfileFingerprint(base),embeddingProfileFingerprint({...base,ollama_api_key:'secret',ollama_url:'https://private.invalid'}));
});
