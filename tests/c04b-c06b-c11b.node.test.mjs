import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {planRegistryMigration,commitRegistryMigration,rollbackRegistryMigration,inspectRegistryMigration} from '../utils/c04-registry-migration.js';
import {verifyCollectionOwner,quarantineImportedOwnership} from '../utils/c04-ownership.js';
import {createScopedFacade} from '../utils/c06-scoped-facade.js';
import {inventoryPages} from '../utils/c11-paginated-inventory.js';
import {inspectAdapterInventory} from '../utils/c11-adapter-inventory.js';
const a='qdrant:openai:one',b='milvus:openai:one',legacy='one';
const fixture=()=>({vecthare_collection_registry:[legacy],collections:{[legacy]:{enabled:false,lockMode:'exclusive',lockedToChatId:'uuid1',triggers:['A']}},
 chatCollectionPolicies:{uuid1:{mode:'only_selected',selectedCollections:[legacy]}},
 vecthare_chunk_meta_by_collection:{[legacy]:{'hash1':{owner:'test'}}}});
const verified={one:{verified:true,chatIds:['uuid1']}};
const approved={approved:true,persist:()=>true};

test('C04-B: migration preview leaves caller-owned structures untouched',()=>{
 const x=fixture(),before=structuredClone(x);const p=planRegistryMigration(x,{mapping:{one:a},owners:verified});
 assert.deepEqual(x,before);assert.equal(p.status,'ready');assert.equal(p.changes.length,1);
 assert.deepEqual(p.after.vecthare_collection_registry,[a]);assert.equal(p.after.collections[a].enabled,false);
 assert.deepEqual(p.after.collections[a].lockedToChatId,'uuid1');
 assert.deepEqual(p.after.chatCollectionPolicies.uuid1.selectedCollections,[a]);
 assert.deepEqual(p.after.vecthare_chunk_meta_by_collection[a].hash1.owner,'test');
});
test('C04-B: ambiguous/legacy owner without explicit map stays quarantined and disabled',()=>{
 const x=fixture();x.collections.one.enabled=true;
 const p=planRegistryMigration(x);assert.equal(p.status,'requires-remap');
 assert.equal(p.after.collections.one.enabled,false);
 assert.deepEqual(p.after.collections.one.lockedToChatId,'uuid1');
 assert.ok(p.quarantined.some(item=>item.source==='one'));
});
test('C04-B: mapped but unmapped chat lock is retained while disabled',()=>{
 const x=fixture();x.collections.one.enabled=true;
 const p=planRegistryMigration(x,{mapping:{one:a}});
 assert.equal(p.status,'ready');assert.equal(p.after.collections[a].enabled,false);
 assert.equal(p.after.collections[a].ownershipReviewRequired,true);assert.equal(p.after.collections[a].lockedToChatId,'uuid1');
});
test('C04-B: conflicting qualified metadata blocks commit and never merges',()=>{
 const x=fixture();x.vecthare_collection_registry.push(a);x.collections[a]={enabled:true};
 const p=planRegistryMigration(x,{mapping:{one:a},owners:verified});
 assert.equal(p.status,'conflict');assert.ok(p.conflicts.length);
 assert.equal(commitRegistryMigration(x,p,approved).status,'blocked');
 assert.deepEqual(x.collections[a],{enabled:true});
});
test('C04-B: duplicate legacy owner mapping conflicts rather than last-write-wins',()=>{
 const x=fixture();x.vecthare_collection_registry.push('old:one');x.collections['old:one']={enabled:true};
 const p=planRegistryMigration(x,{mapping:{one:a,'old:one':a},owners:verified});
 assert.equal(p.status,'conflict');assert.equal(p.conflicts[0].reason,'multiple-legacy-owners');
});
test('C04-B: explicit approval and durable ack required; debounce is insufficient',()=>{
 const x=fixture(),before=structuredClone(x),p=planRegistryMigration(x,{mapping:{one:a},owners:verified});
 assert.equal(commitRegistryMigration(x,p,{persist:()=>true}).status,'blocked');
 assert.equal(commitRegistryMigration(x,p,{approved:true,persist:()=>false}).status,'blocked');
 assert.deepEqual(x,before);
});
test('C04-B: async persistence does not pass the synchronous commit gate',()=>{
 const x=fixture(),p=planRegistryMigration(x,{mapping:{one:a},owners:verified});
 assert.equal(commitRegistryMigration(x,p,{approved:true,persist:async()=>true}).status,'blocked');
 assert.ok(!x.vecthare_registry_backup);
});
test('C04-B: committed migration backs up exact original and rollback restores',()=>{
 const x=fixture(),before=structuredClone(x),p=planRegistryMigration(x,{mapping:{one:a},owners:verified});
 assert.equal(commitRegistryMigration(x,p,approved).status,'committed');
 assert.deepEqual(x.vecthare_registry_backup.before.vecthare_collection_registry,[legacy]);
 assert.equal(x.vecthare_registry_schema_version,2);
 assert.equal(rollbackRegistryMigration(x,approved).status,'rolled-back');
 assert.deepEqual(x,before);
});
test('C04-B: migration is idempotent; existing backup blocks a second commit',()=>{
 const x=fixture(),p=planRegistryMigration(x,{mapping:{one:a},owners:verified});
 assert.equal(commitRegistryMigration(x,p,approved).status,'committed');
 const p2=planRegistryMigration(x,{mapping:{one:a}});
 assert.equal(p2.changed,false);assert.equal(commitRegistryMigration(x,p2,approved).status,'blocked');
});
test('C04-B: stale preview cannot clobber new metadata',()=>{
 const x=fixture(),p=planRegistryMigration(x,{mapping:{one:a},owners:verified});
 x.collections.one.enabled=true;
 assert.equal(commitRegistryMigration(x,p,approved).reason,'registry-changed-since-dry-run');
});
test('C04-B: rollback refuses changed post-migration state to preserve new edits',()=>{
 const x=fixture(),p=planRegistryMigration(x,{mapping:{one:a},owners:verified});
 commitRegistryMigration(x,p,approved);x.collections[a].tags=['new'];
 assert.equal(rollbackRegistryMigration(x,approved).status,'blocked');
 assert.deepEqual(x.collections[a].tags,['new']);
});
test('C04-B: no backend-qualified key means no origin authorization',()=>{
 assert.equal(verifyCollectionOwner({collectionKey:'one',metadata:{enabled:true}}).allowed,false);
 assert.equal(verifyCollectionOwner({collectionKey:a,metadata:{enabled:false}}).allowed,false);
});
test('C04-B: verified chat and character origin cannot be bypassed',()=>{
 assert.equal(verifyCollectionOwner({collectionKey:a,metadata:{enabled:true,scope:'chat',originChatId:'uuid1'},chatId:'other'}).allowed,false);
 assert.equal(verifyCollectionOwner({collectionKey:a,metadata:{enabled:true,scope:'chat',originChatId:'uuid1'},chatId:'uuid1'}).allowed,true);
 assert.equal(verifyCollectionOwner({collectionKey:a,metadata:{enabled:true,scope:'chat'}}).allowed,false);
 assert.equal(verifyCollectionOwner({collectionKey:a,metadata:{enabled:true,scope:'character',originCharacterId:'charuuid'},characterId:'wrong'}).allowed,false);
});
test('C04-B: imported owner claims remain quarantined when not independently mapped',()=>{
 const imported={enabled:true,scope:'chat',originChatId:'file-name',lockedToChatIds:['file-name']};
 const unknown=quarantineImportedOwnership(imported);
 assert.equal(unknown.enabled,false);assert.equal(unknown.ownershipReviewRequired,true);
 assert.deepEqual(unknown.lockedToChatIds,['file-name']);assert.equal(imported.enabled,true);
 const mapped=quarantineImportedOwnership(imported,{verifiedChatIds:['file-name']});
 assert.equal(mapped.enabled,true);
});
test('C04-B: discovered plugin list and fallback failures cannot mutate registry',()=>{
 const code=fs.readFileSync(new URL('../core/collection-loader.js',import.meta.url),'utf8');
 const pluginSection=code.slice(code.indexOf('async function discoverViaPlugin('),code.indexOf('async function probeCollection('));
 assert.ok(!pluginSection.includes('unregisterCollection('));
 assert.ok(!pluginSection.includes('registerCollection('));
 const fallback=code.slice(code.indexOf('async function discoverViaFallback('),code.indexOf('export async function discoverExistingCollections('));
 assert.ok(!fallback.includes('unregisterCollection('));
 assert.ok(!fallback.includes('registerCollection('));
});
const makeFacade=(settings={vector_backend:'qdrant',source:'openai'},caps=()=>false,adapter={})=>{
 let calls=0;const facade=createScopedFacade({settings,capability:caps,resolveAdapter:async()=>{calls++;return adapter;}});
 return {facade,calls:()=>calls};
};
test('C06-B: facade fails closed without capability evidence and before adapter access',async()=>{
 const {facade,calls}=makeFacade();
 await assert.rejects(facade.list({key:a}),/listPagination contract unverified/);
 await assert.rejects(facade.query({key:a,text:'ok'}),/tenantFilter contract unverified/);
 await assert.rejects(facade.upsert({key:a,items:[{hash:'1'}]}),/tenantFilter contract unverified/);
 await assert.rejects(facade.remove({key:a,recordIds:['1']}),/tenantFilter contract unverified/);
 assert.equal(calls(),0);
});
test('C06-B: qualified key cannot use different backend or embedding source',async()=>{
 const {facade,calls}=makeFacade();
 await assert.rejects(facade.query({key:b,text:'x'}),/route mismatch/);
 await assert.rejects(facade.list({key:'qdrant:cohere:one'}),/route mismatch/);
 await assert.rejects(facade.query({key:'one',text:'x'}),/Qualified collection identity required/);
 assert.equal(calls(),0);
});
test('C06-B: scoped query rejects missing owner evidence and foreign results',async()=>{
 const {facade}=makeFacade(undefined,()=>true,{queryScoped:()=>({scope:a,items:[{collectionKey:b}]})});
 await assert.rejects(facade.query({key:a,text:'x'}),/Cross-tenant query result/);
});
test('C06-B: scoped upsert and delete reject missing tenant ack and partial counts',async()=>{
 const adapter={upsertScoped:()=>({scope:a,httpStatus:200,payload:{accepted:1}}),deleteScoped:()=>({scope:a,httpStatus:200,payload:{deleted:1}})};
 const {facade}=makeFacade(undefined,()=>true,adapter);
 assert.equal((await facade.upsert({key:a,items:[{},{}]})).status,'uncertain');
 assert.equal((await facade.remove({key:a,recordIds:['1','2']})).status,'uncertain');
 adapter.deleteScoped=()=>({scope:b,httpStatus:200,payload:{deleted:2}});
 assert.equal((await facade.remove({key:a,recordIds:['1','2']})).status,'uncertain');
});
test('C06-B: scoped facade lost acknowledgement produces uncertain not success',async()=>{
 const {facade}=makeFacade(undefined,()=>true,{upsertScoped:()=>{throw Error('lost ack');}});
 assert.equal((await facade.upsert({key:a,items:[{}]})).status,'uncertain');
});
test('C11-B prerequisite: count required and exact owner labels required for complete inventory',async()=>{
 const {facade}=makeFacade(undefined,()=>true,{countScopedRecords:()=>2,listScopedPage:(_,{offset})=>({scope:a,items:offset?[{recordId:'2',collectionKey:a}]:[{recordId:'1',collectionKey:a}],endOfList:offset>0})});
 assert.equal((await facade.list({key:a,mode:'offset'})).complete,true);
 const missing=await inventoryPages({key:a,mode:'offset',contractVerified:true,readPage:()=>({scope:a,items:[{recordId:'1'}],endOfList:true})});
 assert.equal(missing.complete,false);
});
test('C11-B prerequisite: self-reported item count or capped page cannot establish completeness',async()=>{
 const a1=makeFacade(undefined,()=>true,{countScopedRecords:()=>undefined,listScopedPage:()=>({scope:a,items:[],endOfList:true})});
 assert.equal((await a1.facade.list({key:a})).complete,false);
 const a2=makeFacade(undefined,()=>true,{countScopedRecords:()=>3,listScopedPage:()=>({scope:a,items:[{recordId:'1',collectionKey:a}],endOfList:true})});
 assert.equal((await a2.facade.list({key:a})).complete,false);
});
test('C11-B prerequisite: real bridge stays blocked without pinned capability flags',async()=>{
 let calls=0;const result=await inspectAdapterInventory({key:a,settings:{vector_backend:'qdrant',source:'openai'},adapter:{listScopedPage:()=>{calls++;},countScopedRecords:()=>{calls++;}}});
 assert.equal(result.complete,false);assert.equal(calls,0);
});
test('C04-B: policy selection refuses ambiguous bare ID and keeps qualified backends separate',async()=>{
 const vm=await import('node:vm');
 const {parseCollectionKey}=await import('../utils/collection-keys.js');
 const src=fs.readFileSync(new URL('../core/collection-metadata.js',import.meta.url),'utf8');
 const data={vecthare:{collections:{[a]:{enabled:true},[b]:{enabled:true}},
    vecthare_collection_registry:[a,b],chatCollectionPolicies:{chat:{mode:'only_selected',selectedCollections:['one']}}}};
 const ctx=vm.createContext({console:{log(){},warn(){},error(){}}});
 const mod=new vm.SourceTextModule(src,{context:ctx});
 const deps={
  '../../../../extensions.js':{extension_settings:data},
  '../../../../../script.js':{saveSettingsDebounced:()=>{}},
  './collection-ids.js':{parseRegistryKey:key=>({collectionId:String(key).split(':').at(-1)})},
  '../utils/c01-inventory.js':{planOrphanCollectionMetadataRemoval:()=>({remove:[],allowed:false})},
  '../utils/collection-keys.js':{parseCollectionKey},
  '../utils/c04-registry-migration.js':{inspectRegistryMigration:()=>({status:'ready'})},
  '../utils/c04-ownership.js':{verifyCollectionOwner:()=>({allowed:true})},
 };
 await mod.link(name=>{
  const dep=deps[name];assert.ok(dep,name);
  return new vm.SyntheticModule(Object.keys(dep),function(){for(const [k,v] of Object.entries(dep))this.setExport(k,v);},{context:ctx});
 });
 await mod.evaluate();const api=mod.namespace;
 assert.equal(api.isCollectionSelectedForChat(a,'chat'),false);
 assert.equal(api.isCollectionSelectedForChat(b,'chat'),false);
 assert.deepEqual(Array.from(api.applyChatCollectionPolicy([a,b],'chat')),[]);
 api.setChatCollectionPolicy('chat',{selectedCollections:[a]});
 assert.equal(api.isCollectionSelectedForChat(a,'chat'),true);
 assert.equal(api.isCollectionSelectedForChat(b,'chat'),false);
 assert.deepEqual(Array.from(api.applyChatCollectionPolicy([a,b],'chat')),[a]);
});
test('C04-B: C01 cleanup prunes only deleted key, and rolls policies back on failed persist',async()=>{
 const {deleteCollectionSafely}=await import('../utils/c01-deletion.js');
 const mk=()=>({registry:[a,b],collections:{[a]:{},[b]:{}},tombstones:{},
  chatCollectionPolicies:{chat:{selectedCollections:[a,b,'one']},other:{selectedCollections:[b]}}});
 const run=(store,persist)=>deleteCollectionSafely({key:a,store,contractVerified:true,persist,
   inventory:async()=>({scope:a,status:'complete',complete:true,endOfListConfirmed:true,recordIds:[]}),
   purge:async()=>({scope:a,status:'confirmed'}),
   verifyEmpty:(()=>{let n=0;return async()=>({scope:a,status:'confirmed',complete:true,empty:++n>=2});})()});
 const success=mk();assert.equal((await run(success,async()=>true)).success,true);
 assert.deepEqual(success.chatCollectionPolicies.chat.selectedCollections,[b,'one']);
 const failure=mk();let n=0;assert.equal((await run(failure,async()=>++n!==4)).success,false);
 assert.deepEqual(failure.chatCollectionPolicies.chat.selectedCollections,[a,b,'one']);
});
test('C04-B: oversized registry snapshots cannot be persisted inline',()=>{
 const x=fixture();x.collections.one.description='A'.repeat(2*1024*1024);
 const p=planRegistryMigration(x,{mapping:{one:a},owners:verified});
 assert.equal(commitRegistryMigration(x,p,approved).reason,'external-durable-backup-required');
 assert.equal(x.vecthare_registry_backup,undefined);
});
test('C06-B: all four backend contract ledgers remain unverified without pinned deployed server evidence',async()=>{
 const {auditBackendContract}=await import('../utils/c06-contract-audit.js');
 for(const backend of ['standard','qdrant','milvus','lancedb']) {
  const manifest=JSON.parse(fs.readFileSync(new URL(`contracts/${backend}.json`,import.meta.url),'utf8'));
  const report=auditBackendContract(manifest,{backend,serverVersion:'not-pinned',serverCommit:'not-pinned'});
  assert.equal(report.status,'unverified');assert.equal(report.readyForLiveAcceptance,false);
  assert.ok(report.blockers.includes('missing-serverSource'));
  assert.ok(report.blockers.includes('deployed-version-not-pinned'));
 }
});
test('C06-B: even a structurally complete fixture cannot directly unlock live capabilities',async()=>{
 const {auditBackendContract}=await import('../utils/c06-contract-audit.js');
 const manifest={backend:'qdrant',verifiedVersion:'1',evidence:{serverSource:'snapshot',serverCommit:'abc',liveFixture:'smoke'},
   endpoints:[{url:'/api/plugins/similharity/chunks/list',method:'POST'}],capabilities:{tenantFilter:'verified'},
   negativeCases:['http-200-success-false','http-500','partial-count','tenant-filter-negative'].map(name=>({name}))};
 const report=auditBackendContract(manifest,{backend:'qdrant',serverVersion:'1',serverCommit:'abc'});
 assert.equal(report.status,'candidate');assert.equal(report.readyForLiveAcceptance,false);
});
test('C04-B: unresolved legacy registry and enabled flags are inert without deleting old data',async()=>{
 const vm=await import('node:vm');
 const src=fs.readFileSync(new URL('../core/collection-metadata.js',import.meta.url),'utf8');
 const settings={vecthare:{collections:{one:{enabled:true,lockedToChatId:'owner'}},vecthare_collection_registry:['one'],vecthare_collection_enabled_orphan:true}};
 const ctx=vm.createContext({console:{log(){},warn(){},error(){}}});
 const mod=new vm.SourceTextModule(src,{context:ctx});
 const deps={
  '../../../../extensions.js':{extension_settings:settings},'../../../../../script.js':{saveSettingsDebounced:()=>{}},
  './collection-ids.js':{parseRegistryKey:k=>({collectionId:k})},
  '../utils/c01-inventory.js':{planOrphanCollectionMetadataRemoval:()=>({allowed:false,remove:[]})},
  '../utils/collection-keys.js':{parseCollectionKey:k=>k===a?{backend:'qdrant',source:'openai',collectionId:'one'}:null},
  '../utils/c04-registry-migration.js':{inspectRegistryMigration:()=>({status:'requires-remap'})},
  '../utils/c04-ownership.js':{verifyCollectionOwner:()=>({allowed:true})},
 };
 await mod.link(name=>{const dep=deps[name];assert.ok(dep,name);return new vm.SyntheticModule(Object.keys(dep),function(){for(const [k,v] of Object.entries(dep))this.setExport(k,v);},{context:ctx});});
 await mod.evaluate();const api=mod.namespace;
 assert.equal(api.getCollectionMeta('one').enabled,false);
 assert.equal(api.getCollectionMeta('one').ownershipReviewRequired,true);
 assert.equal(api.getCollectionMeta('orphan').enabled,false);
 assert.equal(api.migrateOldEnabledKeys().blocked,1);
 assert.deepEqual(settings.vecthare.collections.one,{enabled:true,lockedToChatId:'owner'});
 assert.equal(settings.vecthare.vecthare_collection_enabled_orphan,true);
});
test('C04-B: even a global backup import is disabled until explicit trusted review',()=>{
 const incoming={enabled:true,scope:'global',alwaysActive:true,forceMode:'forced'};
 const disabled=quarantineImportedOwnership(incoming,{requireRemapApproval:true});
 assert.equal(disabled.enabled,false);assert.equal(disabled.ownershipReviewRequired,true);
 const approved=quarantineImportedOwnership(incoming,{requireRemapApproval:true,approved:true});
 assert.equal(approved.enabled,true);assert.equal(incoming.enabled,true);
});
test('C11-B: legacy export warns about unverified completeness and refuses its fixed cap',()=>{
 const source=fs.readFileSync(new URL('../core/collection-export.js',import.meta.url),'utf8');
 assert.match(source,/inventoryComplete:\s*false/);
 assert.match(source,/data\.items\.length >= 50000/);
 assert.match(source,/adapterCollectionId\(collectionId,backendName/);
});
