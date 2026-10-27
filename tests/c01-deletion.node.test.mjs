import test from 'node:test';
import assert from 'node:assert/strict';
import {collectScopedInventory,metadataEvidence,planOrphanCollectionMetadataRemoval} from '../utils/c01-inventory.js';
import {deleteCollectionSafely,recoverTombstones} from '../utils/c01-deletion.js';
import {FaultBackend} from './helpers/fake-backend.js';
const A='qdrant:openai:story',B='milvus:openai:story';
const page=(key,ids=[],more=null)=>({scope:key,items:ids.map(recordId=>({recordId})),endOfList:more===null,...(more!==null?{nextCursor:more}:{})});
const goodInventory=key=>({status:'complete',complete:true,scope:key,endOfListConfirmed:true,recordIds:['same']});
const goodEmpty=key=>({scope:key,status:'confirmed',complete:true,empty:true});
const fixtures=()=>{const db=new FaultBackend();db.seed(A,['same']);db.seed(B,['same']);
  const store={registry:[A,B],collections:{[A]:{},[B]:{protected:true}},recordMetadata:{[A]:{same:{}},[B]:{same:{owner:'B'}}},tombstones:{}};
  let persistCount=0;const persist=async()=>{persistCount++;return true;};
  let purges=0;
  const handlers={key:A,store,contractVerified:true,persist,inventory:async key=>goodInventory(key),
    purge:async key=>{purges++;return db.purge(key).then(result=>({...result,scope:key}));},
    verifyEmpty:async key=>db.ids(key).length===0?goodEmpty(key):{scope:key,status:'confirmed',complete:true,empty:false}};
  return {db,store,handlers,persisted:()=>persistCount,purges:()=>purges};
};
test('C01: complete two-page inventory requires explicit end-of-list and scoped record IDs',async()=>{
 let calls=0;const result=await collectScopedInventory({key:A,contractVerified:true,listPage:({cursor})=>{calls++;return cursor===null?page(A,['a'],'second'):page(A,['b']);},expectedCount:2});
 assert.equal(result.status,'complete');assert.equal(result.complete,true);assert.deepEqual(result.recordIds,['a','b']);assert.equal(calls,2);
});
for(const [name,handler] of [
 ['unverified capability',{contractVerified:false,listPage:async()=>page(A,[])}],
 ['no explicit end',{contractVerified:true,listPage:async()=>({scope:A,items:[]})}],
 ['wrong tenant page',{contractVerified:true,listPage:async()=>page(B,[])}],
 ['wrong tenant record',{contractVerified:true,listPage:async()=>({scope:A,items:[{recordId:'x',collectionKey:B}],endOfList:true})}],
 ['missing record ID',{contractVerified:true,listPage:async()=>({scope:A,items:[{}],endOfList:true})}],
 ['repeated cursor',{contractVerified:true,listPage:async()=>page(A,['x'],'cursor')}],
 ['page cap',{contractVerified:true,maxPages:2,listPage:async({cursor})=>page(A,['x'],cursor===null?'1':'2')}],
 ['timeout',{contractVerified:true,listPage:async()=>{throw Error('timeout');}}],
 ['count mismatch',{contractVerified:true,expectedCount:3,listPage:async()=>page(A,['x'])}],
]) test(`C01 inventory fail-closed: ${name}`,async()=>{
 const result=await collectScopedInventory({key:A,...handler});assert.equal(result.complete,false);assert.notEqual(result.status,'complete');
});
test('C01: an explicitly empty collection metadata object exists; missing metadata does not',()=>{
 const collections={[A]:{}};assert.deepEqual(metadataEvidence(collections,A),{status:'available',exists:true,value:{}});
 assert.deepEqual(metadataEvidence(collections,B),{status:'available',exists:false});
 assert.equal(metadataEvidence(null,A).status,'unavailable');
});
test('C01 #189: partial/uncoverspecified inventory never authorizes orphan deletion',()=>{
 const collections={[A]:{},[B]:{},legacy:{}};
 assert.equal(planOrphanCollectionMetadataRemoval({inventory:{complete:false},collections}).allowed,false);
 assert.equal(planOrphanCollectionMetadataRemoval({inventory:{complete:true,status:'complete',endOfListConfirmed:true,collections:[B]},collections}).allowed,false);
 const result=planOrphanCollectionMetadataRemoval({inventory:{complete:true,status:'complete',endOfListConfirmed:true,collections:[B],verifiedScopes:['qdrant:openai']},collections,registry:[B]});
 assert.deepEqual(result.remove,[A]);assert.ok(!result.remove.includes(B));
});
test('C01 #158/#216: verified deletion removes only A, preserves B same hash, and leaves completion receipt',async()=>{
 const f=fixtures();const result=await deleteCollectionSafely(f.handlers);
 assert.equal(result.success,true);assert.equal(result.status,'purged-verified');
 assert.deepEqual(f.db.ids(B),['same']);assert.deepEqual(f.db.ids(A),[]);
 assert.ok(f.store.registry.includes(B));assert.ok(!f.store.registry.includes(A));
 assert.deepEqual(f.store.collections[B],{protected:true});assert.deepEqual(f.store.recordMetadata[B],{same:{owner:'B'}});
 assert.equal(f.store.recordMetadata[A],undefined);assert.equal(f.store.tombstones[A].status,'completed');
 assert.equal(f.purges(),1);assert.ok(f.persisted()>=4);
});
test('C01: unverified real-server contract makes zero network and zero settings changes',async()=>{
 const f=fixtures();const result=await deleteCollectionSafely({...f.handlers,contractVerified:false});
 assert.equal(result.status,'blocked');assert.equal(f.purges(),0);assert.equal(f.persisted(),0);
 assert.deepEqual(f.store.registry,[A,B]);assert.deepEqual(f.db.ids(A),['same']);
});
for(const [name,patch] of [
 ['registry key missing',s=>{s.registry=[B];}],
 ['metadata not stored',s=>{delete s.collections[A];}],
 ['backend inventory partial',(_,h)=>{h.inventory=async()=>({...goodInventory(A),complete:false});}],
 ['wrong scoped inventory',(_,h)=>{h.inventory=async()=>goodInventory(B);}],
 ['no authoritative end',(_,h)=>{h.inventory=async()=>({...goodInventory(A),endOfListConfirmed:false});}],
]) test(`C01 #216 refuses to prepare unsafe delete: ${name}`,async()=>{
 const f=fixtures();patch(f.store,f.handlers);const r=await deleteCollectionSafely(f.handlers);
 assert.equal(r.success,false);assert.equal(f.purges(),0);assert.deepEqual(f.db.ids(A),['same']);assert.equal(f.store.tombstones[A],undefined);
});
test('C01: protected collections require verified export receipt before purge',async()=>{
 const f=fixtures();f.handlers.key=B;f.handlers.protectedCollection=true;
 assert.equal((await deleteCollectionSafely(f.handlers)).status,'blocked');assert.equal(f.purges(),0);
 f.handlers.backup=async()=>({scope:B,complete:false});
 assert.equal((await deleteCollectionSafely(f.handlers)).status,'blocked');assert.equal(f.purges(),0);
 f.handlers.backup=async()=>({scope:B,complete:true,verified:true});
 const done=await deleteCollectionSafely(f.handlers);
 assert.equal(done.success,true);assert.deepEqual(f.db.ids(A),['same']);
});
test('C01: tombstone persistence uncertainty prevents purge and subsequent in-memory retry',async()=>{
 const f=fixtures();f.handlers.persist=async()=>false;
 assert.equal((await deleteCollectionSafely(f.handlers)).status,'needs-retry');assert.equal(f.purges(),0);
 assert.equal(f.store.tombstones[A].durable,false);
 assert.equal((await deleteCollectionSafely({...f.handlers,resume:true})).reason,'tombstone-not-durable');assert.equal(f.purges(),0);
});
test('C01: lost purge acknowledgement leaves durable purge-sent tombstone; retry never sends blind second purge',async()=>{
 const f=fixtures();f.db.queueFault('purge','commit-lost-ack');
 const r=await deleteCollectionSafely(f.handlers);assert.equal(r.status,'needs-retry');
 assert.deepEqual(f.store.registry,[A,B]);assert.ok(f.store.collections[A]);
 assert.equal(f.store.tombstones[A].stage,'purge-sent');assert.equal(f.purges(),1);
 // Confirmed empty inventory allows completing after a crash, without a second purge.
 const after=await deleteCollectionSafely({...f.handlers,resume:true});
 assert.equal(after.success,true);assert.equal(f.purges(),1);assert.deepEqual(f.db.ids(B),['same']);
});
test('C01: purge ACK lost without empty readback cannot auto-repeat destructive request',async()=>{
 const f=fixtures();f.db.queueFault('purge','reject');
 const r=await deleteCollectionSafely(f.handlers);assert.equal(r.status,'needs-retry');
 const second=await deleteCollectionSafely({...f.handlers,resume:true});
 assert.equal(second.reason,'prior-purge-uncertain-requires-reconciliation');
 assert.equal(f.purges(),1);assert.deepEqual(f.db.ids(A),['same']);
});
test('C01: post-purge readback error leaves retry reference and does not delete metadata',async()=>{
 const f=fixtures();let n=0;f.handlers.verifyEmpty=async key=>{n++;if(n>=2)throw Error('lost read');return {scope:key,complete:true,status:'confirmed',empty:false};};
 const r=await deleteCollectionSafely(f.handlers);assert.equal(r.status,'needs-retry');
 assert.equal(f.store.tombstones[A].stage,'purge-sent');assert.ok(f.store.registry.includes(A));assert.ok(f.store.recordMetadata[A]);
});
test('C01: crash at purged checkpoint recovers via verified empty without repeat purge',async()=>{
 const f=fixtures();f.db.seed(A,[]);
 f.store.tombstones[A]={status:'deleting',stage:'purged',collectionKey:A,durable:true};
 assert.deepEqual(recoverTombstones(f.store),[{key:A,stage:'purged',status:'needs-retry'}]);
 const r=await deleteCollectionSafely({...f.handlers,resume:true});
 assert.equal(r.success,true);assert.equal(f.purges(),0);assert.ok(f.store.registry.includes(B));
});
test('C01: failed finalization persist restores registry and scoped metadata, leaves tombstone',async()=>{
 const f=fixtures();let n=0;f.handlers.persist=async()=>{n++;return n!==4;};
 const r=await deleteCollectionSafely(f.handlers);
 assert.equal(r.status,'needs-retry');assert.equal(r.reason,'finalization-persist-failed');
 assert.deepEqual(f.store.registry,[A,B]);assert.ok(Object.hasOwn(f.store.collections,A));
 assert.ok(Object.hasOwn(f.store.recordMetadata,A));assert.equal(f.store.tombstones[A].stage,'purged');
 const recovered=await deleteCollectionSafely({...f.handlers,resume:true,persist:async()=>true});
 assert.equal(recovered.success,true);assert.equal(f.purges(),1);
});
test('C01: abort before pre-purge checkpoint means no purge',async()=>{
 const f=fixtures();let n=0;f.handlers.persist=async()=>++n!==2;
 const r=await deleteCollectionSafely(f.handlers);
 assert.equal(r.status,'needs-retry');assert.equal(f.purges(),0);
});
test('C01: accidental missing registry entry on recovery never removes unrelated last entry',async()=>{
 const f=fixtures();f.db.seed(A,[]);f.store.registry=[B];
 f.store.tombstones[A]={status:'deleting',stage:'purged',collectionKey:A,durable:true};
 const r=await deleteCollectionSafely({...f.handlers,resume:true});
 assert.equal(r.success,true);assert.deepEqual(f.store.registry,[B]);
});

test('C01 #189: collection inventory verifies every backend and source',async()=>{
 const {collectCollectionInventory}=await import('../utils/c01-inventory.js');
 let i=0;const result=await collectCollectionInventory({backend:'qdrant',source:'openai',contractVerified:true,expectedCount:2,
    listPage:()=>++i===1?{scope:'qdrant:openai',collections:[A],endOfList:false,nextCursor:'n'}:{scope:'qdrant:openai',collections:['qdrant:openai:other'],endOfList:true}});
 assert.equal(result.complete,true);assert.deepEqual(result.verifiedScopes,['qdrant:openai']);assert.equal(result.collections.length,2);
});
for(const invalid of [
 {scope:'qdrant:openai',collections:[B],endOfList:true},
 {scope:'qdrant:openai',collections:[A]},
 {scope:'other',collections:[],endOfList:true},
]) test('C01 #189: incomplete or cross-tenant collection list cannot delete metadata',async()=>{
 const {collectCollectionInventory}=await import('../utils/c01-inventory.js');
 const result=await collectCollectionInventory({backend:'qdrant',source:'openai',contractVerified:true,listPage:async()=>invalid});
 assert.equal(result.complete,false);assert.equal(planOrphanCollectionMetadataRemoval({inventory:result,collections:{[A]:{}}}).allowed,false);
});

test('C01 #158: legacy hash metadata deletion refuses an owner in another collection',async()=>{
 const {mayRemoveLegacyHashMetadata}=await import('../utils/c01-inventory.js');
 const inventories={[A]:goodInventory(A),[B]:goodInventory(B)};
 assert.equal(mayRemoveLegacyHashMetadata({hash:'same',registry:[A,B],inventoryByCollection:inventories}).allowed,false);
 assert.equal(mayRemoveLegacyHashMetadata({hash:'gone',registry:[A,B],inventoryByCollection:{...inventories,[B]:{...inventories[B],complete:false}}}).allowed,false);
 assert.equal(mayRemoveLegacyHashMetadata({hash:'gone',registry:[A,B,'old:legacy'],inventoryByCollection:inventories}).allowed,false);
 assert.equal(mayRemoveLegacyHashMetadata({hash:'gone',registry:[A,B],inventoryByCollection:inventories}).allowed,true);
});
test('C01 #220: null metadata cannot masquerade as an explicitly empty record',()=>{
 assert.equal(metadataEvidence({[A]:null},A).status,'unavailable');
 assert.equal(metadataEvidence({[A]:undefined},A).status,'unavailable');
 assert.equal(metadataEvidence({[A]:{}},A).exists,true);
});

test('C01 #158/#220: real metadata module never deletes B for A or through a bare hash',async()=>{
 const vm=await import('node:vm'),fs=await import('node:fs');
 const {parseCollectionKey}=await import('../utils/collection-keys.js');
 const source=fs.readFileSync(new URL('../core/collection-metadata.js',import.meta.url),'utf8');
 const settings={vecthare:{collections:{[A]:{},[B]:{note:'B'}}}};
 let saves=0;
 const context=vm.createContext({console:{log(){},warn(){},error(){}}});
 const module=new vm.SourceTextModule(source,{context});
 const stubs={
   '../../../../extensions.js':{extension_settings:settings},
   '../../../../../script.js':{saveSettingsDebounced:()=>saves++},
   './collection-ids.js':{parseRegistryKey:k=>({collectionId:String(k).split(':').at(-1)})},
   '../utils/c01-inventory.js':{planOrphanCollectionMetadataRemoval:()=>({allowed:false,reason:'incomplete'})},
   '../utils/collection-keys.js':{parseCollectionKey},
 };
 await module.link(spec=>{const exports=stubs[spec];assert.ok(exports,spec);
   return new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v);},{context});
 });
 await module.evaluate();const m=module.namespace;
 m.saveScopedChunkMetadata(A,'same',{});m.saveScopedChunkMetadata(B,'same',{owner:'B'});
 assert.equal(m.getScopedChunkMetadata(A,'same').exists,true);
 assert.equal(m.getScopedChunkMetadata(B,'same').value.owner,'B');
 assert.equal(m.deleteScopedChunkMetadata(A,'same'),true);
 assert.equal(m.getScopedChunkMetadata(A,'same').exists,false);
 assert.equal(m.getScopedChunkMetadata(B,'same').exists,true);
 assert.equal(m.deleteChunkMetadata('same'),false);
 m.deleteCollectionMeta('story'); // legacy key refused
 assert.equal(Object.hasOwn(settings.vecthare.collections,B),true);
 m.deleteCollectionMeta(A);assert.equal(Object.hasOwn(settings.vecthare.collections,A),false);
 assert.equal(Object.hasOwn(settings.vecthare.collections,B),true);
 assert.ok(saves>=4);
});
