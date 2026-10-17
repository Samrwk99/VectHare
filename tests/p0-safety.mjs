/** Dependency-free regression checks for VectHare P0 protection paths.
 * Run: node --experimental-vm-modules tests/p0-safety.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const saved = { vecthare: { vector_backend:'qdrant',source:'llamacpp',qdrant_host:'localhost',qdrant_port:6333, collections: {}, chatCollectionBindings: {}, vecthare_collection_registry: [] } };
const metadata = { integrity: 'chat-a' };
const state = { chatId: 'chat-a', name2: 'Alice', characterId: 1 };
let fetches = [];
let responseMode = 'ok';
let tenantCapabilitiesAvailable = true;
const context = vm.createContext({
    console: { ...console, log() {}, debug() {}, warn() {}, error() {} },
    Date, Math, URL, URLSearchParams, setTimeout, clearTimeout,
    fetch: async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : {};
        fetches.push({ url, body, options });
        if (url.includes('/embedding/capabilities')) return {ok:true,json:async()=>({success:true,modelId:'mock',limits:{maxTokens:2048}})};
        if (url.includes('/embedding/tokenize')) return {ok:true,json:async()=>({count:1})};
        if (url.includes('/qdrant/tenant-capabilities')) return tenantCapabilitiesAvailable
            ? { ok: true, json: async () => ({qdrantTenantIsolation:1,pointIds:'sha256-uuid-of-tenant-and-hash',filters:'content_type'}) }
            : { ok: false, status:404 };
        if (responseMode === 'error') return { ok: false, status: 500, statusText: 'Internal Error', text: async () => 'failure' };
        return { ok: true, status: 200, statusText: 'OK', text: async () => '', json: async () => ({success:true,items:[
            {hash:1,metadata:{content_type:'alice'}}, {hash:2,metadata:{content_type:'bob'}}
        ], results:[
            {hash:1,metadata:{content_type:'alice'}, score:1}, {hash:2,metadata:{content_type:'bob'}, score:1}
        ]}), clone() { return this; } };
    },
});
const mods = new Map();
const imports = {
  'extensions.js': { extension_settings: saved, getContext: () => state, modules: [], getRequestHeaders: () => ({}) },
  'script.js': { saveSettingsDebounced() {}, saveSettings:async()=>{}, getCurrentChatId: () => state.chatId, chat_metadata: metadata, getRequestHeaders: () => ({}), characters: [], substituteParams: x => x },
  'textgen-settings.js': { textgen_types: { LLAMACPP: 'llamacpp', OLLAMA:'ollama', VLLM:'vllm' }, textgenerationwebui_settings: { server_urls: {llamacpp:'http://127.0.0.1:8080'} } },
  'openai.js': { oai_settings: {} },
  'secrets.js': { secret_state: {} },
  'providers.js': { getModelField: () => null },
  'constants.js': { VECTOR_LIST_LIMIT: 1000 },
};
function synthetic(id, definitions) {
    if (!mods.has(id)) {
        mods.set(id, new vm.SyntheticModule(Object.keys(definitions), function () {
            for (const [k,v] of Object.entries(definitions)) this.setExport(k,v);
        }, { context, identifier: id }));
    }
    return mods.get(id);
}
function moduleFor(p) {
    const full = path.resolve(p);
    if (mods.has(full)) return mods.get(full);
    if (!full.startsWith(root + path.sep)) {
        const name = path.basename(full);
        if (!imports[name]) throw new Error(`Unmocked import: ${full}`);
        return synthetic(full, imports[name]);
    }
    if (full.endsWith('/ui/shared-operations.js')) return synthetic(full,{withSharedWriteHeaders:h=>h,runExclusiveNativeMutation:(_l,_r,fn)=>fn()});
    if (full.endsWith('/core/providers.js')) return synthetic(full, imports['providers.js']);
    if (full.endsWith('/core/constants.js')) return synthetic(full, imports['constants.js']);
    const m = new vm.SourceTextModule(fs.readFileSync(full, 'utf8'), { context, identifier: full });
    mods.set(full, m);
    return m;
}
async function load(rel) {
    const m = moduleFor(path.join(root,rel));
    if (m.status === 'unlinked') await m.link(spec => moduleFor(path.resolve(path.dirname(m.identifier),spec)));
    if (m.status === 'linked') await m.evaluate();
    return m.namespace;
}
let checks = 0;
const check = (label, f) => { f(); checks++; process.stdout.write(`PASS ${label}\n`); };
const meta = await load('core/collection-metadata.js');
const owner = await load('core/collection-ownership.js');
const physical = await load('core/physical-identity.js');
const ids = await load('core/collection-ids.js');
check('metadata from different backends isolated', () => {
    meta.setCollectionMeta('qdrant:llamacpp:same', {displayName:'Q'});
    meta.setCollectionMeta('standard:llamacpp:same', {displayName:'S'});
    // P0 physical-server provenance is required for an existing Qdrant record.
    saved.vecthare.qdrantPhysicalIdentities ||= {};
    saved.vecthare.qdrantPhysicalIdentities['qdrant:llamacpp:same'] = 'qdrant:v1:http://localhost:6333:multitenancy=false';
    assert.equal(meta.getCollectionMeta('qdrant:llamacpp:same').displayName,'Q');
    assert.equal(meta.getCollectionMeta('standard:llamacpp:same').displayName,'S');
    assert.equal(meta.getCollectionMeta('same').displayName,null);
});
check('refresh does not remove locks or metadata with bare IDs', () => {
    const result = meta.cleanupOrphanedMeta(['same']);
    assert.equal(result.removed,0);
    assert.equal(meta.getCollectionMeta('qdrant:llamacpp:same').displayName,'Q');
});
check('write binding stays on exact backend and collection', () => {
    const key='qdrant:llamacpp:alice';
    saved.vecthare.qdrantPhysicalIdentities[key] = 'qdrant:v1:http://localhost:6333:multitenancy=false';
    owner.bindChatCollection('chat-a',key,{writeVerified:true});
    assert.equal(owner.resolveChatWriteTarget({vector_backend:'qdrant',source:'llamacpp'},'chat-a').collectionId,'alice');
    assert.throws(() => owner.resolveChatWriteTarget({vector_backend:'standard',source:'llamacpp'},'chat-a'),/switch backend/i);
});
check('unknown legacy embedding profile is read-only for all write paths', () => {
    const key='qdrant:llamacpp:unknown-legacy';
    saved.vecthare.qdrantPhysicalIdentities[key] = 'qdrant:v1:http://localhost:6333:multitenancy=false';
    owner.bindChatCollection('chat-z',key);
    assert.equal(owner.getChatBinding('chat-z').registryKey,key);
    assert.throws(() => owner.resolveChatWriteTarget({vector_backend:'qdrant',source:'llamacpp'},'chat-z'),/read-only/i);
});
check('second chat cannot take ownership without explicit transfer', () => {
    assert.throws(() => owner.bindChatCollection('chat-b','qdrant:llamacpp:alice'),/another chat/i);
});
check('exclusive lock stops wrong chat write binding', () => {
    saved.vecthare.qdrantPhysicalIdentities['qdrant:llamacpp:locked'] = 'qdrant:v1:http://localhost:6333:multitenancy=false';
    meta.setCollectionMeta('qdrant:llamacpp:locked',{lockMode:'exclusive',lockedToChatIds:['chat-b']});
    assert.throws(() => owner.bindChatCollection('chat-a','qdrant:llamacpp:locked'),/exclusively locked/i);
});
check('character name discovery patterns exclude other Alice chats', () => {
    const patterns=ids.buildChatSearchPatterns('Alice - 2024', 'chat-a');
    assert.equal(patterns.some(x=>x==='vecthare_chat_alice'),false);
});
// Qdrant isolated after current VM graph has evaluated.
const q = await load('backends/qdrant.js');
const backend = new q.QdrantBackend();
const settings = {source:'llamacpp',vector_backend:'qdrant',use_alt_endpoint:true,alt_endpoint_url:'http://127.0.0.1:9977'};
await backend.purgeVectorIndex('qdrant:llamacpp:alice',settings);
check('successful Qdrant purge does not throw or reference undefined variables',()=>{
    assert.equal(fetches.at(-1).body.collectionId,'alice');
});
responseMode='error';
await assert.rejects(backend.purgeVectorIndex('alice',settings),/Failed to purge/);
check('Qdrant error is surfaced and cannot count as purge success',()=>{});
responseMode='ok';
await assert.rejects(backend.purgeVectorIndex('alice',{...settings,qdrant_multitenancy:true}),/DIFFERENT Qdrant server/);
check('switching the same collection into another tenancy mode is prohibited',()=>{});
// Remaining request-contract checks operate on a separate, explicitly adopted
// tenant-mode fixture rather than weakening the new physical-server guard.
saved.vecthare.qdrantPhysicalIdentities['qdrant:llamacpp:alice']='qdrant:v1:http://localhost:6333:multitenancy=true';
await backend.purgeVectorIndex('alice',{...settings,qdrant_multitenancy:true});
check('Qdrant shared tenant purge uses content_type-filtered endpoint',()=>{
    assert.equal(fetches.at(-1).body.collectionId,'vecthare_multitenancy');
    assert.deepEqual(fetches.at(-1).body.filters,{content_type:'alice'});
});
fetches=[];
const list = await backend.listChunks('qdrant:llamacpp:alice',{...settings,qdrant_multitenancy:true});
check('Qdrant tenant list uses shared physical collection and enforces filter',()=>{
    assert.equal(fetches.at(-1).body.collectionId,'vecthare_multitenancy');
    assert.deepEqual(fetches.at(-1).body.filters,{content_type:'alice'});
    assert.equal(list.items.length,1);
});
const more = await backend.queryCollection('qdrant:llamacpp:alice','hello',3,{...settings,qdrant_multitenancy:true});
check('Qdrant tenant query discards other tenants even if plugin ignores filter',()=>{
    assert.equal(more.hashes.length,1);
    assert.equal(more.hashes[0],1);
    assert.deepEqual(fetches.at(-1).body.filters,{content_type:'alice'});
});
const tenantSettings={...settings,qdrant_multitenancy:true};
await backend.getSavedHashes('alice',tenantSettings);
check('saved hash listing filtered before pagination',()=>{
    assert.deepEqual(fetches.at(-1).body.filters,{content_type:'alice'});
});
await backend.getChunk('alice',1,tenantSettings);
check('single chunk lookup carries tenant filter query parameter',()=>{
    assert.match(String(fetches.at(-1).url),/filters=/);
    assert.match(decodeURIComponent(String(fetches.at(-1).url)),/content_type/);
});
await backend.updateChunkText('alice',1,'updated',tenantSettings);
check('text edit scoped to tenant and correct shared collection',()=>{
    assert.equal(fetches.at(-1).body.collectionId,'vecthare_multitenancy');
    assert.deepEqual(fetches.at(-1).body.filters,{content_type:'alice'});
});
await backend.updateChunkMetadata('alice',1,{importance:10},tenantSettings);
check('metadata update scoped to tenant',()=>{
    assert.deepEqual(fetches.at(-1).body.filters,{content_type:'alice'});
});
await backend.getStats('alice',tenantSettings);
check('collection stats uses tenant filter',()=>{
    assert.deepEqual(fetches.at(-1).body.filters,{content_type:'alice'});
});
await backend.hybridQuery('alice','hello',3,tenantSettings);
check('hybrid retrieval carries tenant filter to server',()=>{
    const reqs=fetches.filter(x=>String(x.url).includes('hybrid-query'));
    assert.deepEqual(reqs.at(-1).body.filters,{content_type:'alice'});
});
await backend.deleteVectorItems('alice',[1],{...settings,qdrant_multitenancy:true});
check('Qdrant shared tenant deletion supplies hard filter',()=>{
    assert.equal(fetches.at(-1).body.collectionId,'vecthare_multitenancy');
    assert.deepEqual(fetches.at(-1).body.filters,{content_type:'alice'});
});
// Run the real exported loader deletion function with isolated stubbed I/O.
const source = fs.readFileSync(path.join(root,'core/collection-loader.js'),'utf8');
const begin = source.indexOf('export async function deleteCollection(');
const finish = source.indexOf('/**\n * Clears the entire registry',begin);
assert.ok(begin !== -1 && finish > begin);
const target = 'qdrant:llamacpp:alice';
saved.vecthare.vecthare_collection_registry.push(target);
saved.vecthare.qdrantPhysicalIdentities[target]='qdrant:v1:http://localhost:6333:multitenancy=false';
meta.setCollectionMeta(target,{description:'must survive failure'});
let deletes = 0, permit = false;
Object.assign(context,{
    parseRegistryKey: ids.parseRegistryKey,
    clearRecoveryForCollection:()=>{},
    purgeVectorIndex: async () => permit,
    forgetQdrantIdentity:()=>{},
    getBackend:async()=>({listChunks:async()=>({items:[]})}),
    unregisterCollection: key => {deletes++; const i=saved.vecthare.vecthare_collection_registry.indexOf(key); if(i>=0) saved.vecthare.vecthare_collection_registry.splice(i,1);},
    deleteCollectionMeta: meta.deleteCollectionMeta,
    retireChatChunkManifest:async()=>{},
    forgetDeletedCollection: owner.forgetDeletedCollection,
});
const deleteFn=vm.runInContext('('+source.slice(begin,finish).replace('export async function','async function').trim()+')',context);
let deleted = await deleteFn('alice',settings,target);
check('failed purge preserves registry, metadata, and write owner',()=>{
    assert.equal(deleted.success,false);
    assert.equal(deletes,0);
    assert.equal(saved.vecthare.vecthare_collection_registry.includes(target),true);
    assert.equal(meta.getCollectionMeta(target).description,'must survive failure');
    assert.equal(owner.getChatBinding('chat-a').registryKey,target);
});
permit=true;
saved.vecthare.qdrantPhysicalIdentities['qdrant:llamacpp:alice']='qdrant:v1:http://localhost:6333:multitenancy=false';
deleted=await deleteFn('alice',settings,target);
check('successful purge deletes registry, metadata and binding together',()=>{
    assert.equal(deleted.success,true);
    assert.equal(deletes,1);
    assert.equal(saved.vecthare.vecthare_collection_registry.includes(target),false);
    assert.equal(owner.getChatBinding('chat-a'),null);
});
const cv = fs.readFileSync(path.join(root,'core/content-vectorization.js'),'utf8');
const ui = fs.readFileSync(path.join(root,'ui/content-vectorizer.js'),'utf8');
const manager=fs.readFileSync(path.join(root,'ui/ui-manager.js'),'utf8');
const index=fs.readFileSync(path.join(root,'index.js'),'utf8');
const importSource=fs.readFileSync(path.join(root,'core/collection-export.js'),'utf8');
check('chat upload creates independent collection ID instead of current chat ID',()=>{
    assert.match(cv,/source\.type === 'file'[\s\S]*vecthare_chat_upload_/);
});
check('Current Chat replacement uses source.type and staged replacement',()=>{
    assert.match(ui,/source\.type === 'current'/);
    assert.doesNotMatch(ui.slice(ui.indexOf('async function startVectorization()'),ui.indexOf('function escapeHtml')),/await purgeVectorIndex/);
    assert.match(cv,/source\.replaceExisting[\s\S]*_replacement_/);
});
check('Auto-sync Connect writes the selected binding rather than computed ID',()=>{
    assert.match(manager,/bindChatCollection\(getChatUUID\(\), key\)/);
    assert.match(manager,/setCollectionAutoSync\(boundKey, enabling\)/);
});
check('import overwrite stages instead of purging originals',()=>{
    assert.doesNotMatch(importSource,/await purgeVectorIndex\(collectionId, settings\)/);
    assert.match(importSource,/replacementCollectionId\(originalId\)/);
    assert.match(importSource,/checkImportedChunks\(collectionId,prepared,settings\)/);
});
check('purge-all uses scoped, verified inventory with explicit settings modes',()=>{
    assert.match(index,/openPurgeDialog\(settings,\{allowReset:true\}\)/);
    const service=fs.readFileSync(path.join(root,'core/safe-purge.js'),'utf8');
    assert.match(service,/executeVectHarePurge/);
    assert.doesNotMatch(index,/fetch\(['"]\/api\/plugins\/similharity\/purge-all/);
});
check('Resync preserves registry before and during discovery',()=>{
    const browser=fs.readFileSync(path.join(root,'ui/database-browser.js'),'utf8');
    const handler=browser.slice(browser.indexOf('$("#vecthare_reset_registry")'),browser.indexOf('// Keyboard shortcuts'));
    assert.doesNotMatch(handler,/clearCollectionRegistry\(/);
    assert.doesNotMatch(browser.slice(browser.indexOf('async function refreshCollections()'),browser.indexOf('function renderCollections()',browser.indexOf('async function refreshCollections()'))),/cleanupOrphanedMeta\(/);
});
check('chat deletion retains vector collections',()=>{
    const events=index.slice(index.indexOf('eventSource.on(event_types.CHAT_DELETED'),index.indexOf('eventSource.on(event_types.GROUP_CHAT_DELETED')+300);
    assert.doesNotMatch(events,/purgeVectorIndex\(/);
});
process.stdout.write(`\n${checks} P0 safety checks passed.\n`);
// Exercise the complete Content Vectorizer control flow against mock embeddings.
const vectorizeEnd = cv.indexOf('/**\n * Resolves and prepares content for preview');
const vectorizeStart = cv.indexOf('export async function vectorizeContent(');
assert.ok(vectorizeStart !== -1 && vectorizeEnd > vectorizeStart);
let shouldFailInsert=false;
const inserted=[];
const progressTracker={activityId:'p0-cv',show(){},updateCurrentItem(){},updateProgress(){},updateChunks(){},updateEmbeddingProgress(){},updateVerifiedChunks(){},registerRetry(){},complete(){},addError(){}};
const cvRows=new Map(),cvProfiles=new Map(),cvManifests=new Map(),cvPending=new Map();
const getCVRows=id=>{if(!cvRows.has(id))cvRows.set(id,[]);return cvRows.get(id);};
Object.assign(context,{
    extension_settings:saved, structuredClone, localStorage:{getItem:k=>cvPending.get(k)||null,setItem:(k,v)=>cvPending.set(k,v),removeItem:k=>cvPending.delete(k)},
    getChatUUID:()=>metadata.integrity,
    getCurrentChatId:()=>state.chatId,
    getContext:()=>state,
    getModelField:()=>null,modelIsolationDecision:()=>({requiresConfirmation:false,token:""}),
    getContentType:()=>({label:'Chat',defaultStrategy:'conversation_turns',defaults:{chunkSize:400,chunkOverlap:50}}),
    progressTracker,
    resolveSource:async (_,source)=>({content:source.content||[],name:'Alice'}),
    prepareContent:async()=>({text:'user and assistant conversation'}),
    chunkText:async()=>[{text:'user and assistant conversation'}],
    generateCollectionId:()=>`vecthare_chat_alice_${metadata.integrity}`,
    getStringHash:text=>text.length,
    enrichChunks:chunks=>chunks,
    buildContentEmbeddingPlan:async chunks=>chunks.map((chunk,i)=>({...chunk,hash:chunk.text.length,index:i})),
    getBackend:async()=>({listChunks:async(id,_s,{offset,limit})=>({items:getCVRows(id).slice(offset,offset+limit)}),getChunk:async(id,hash)=>getCVRows(id).find(x=>String(x.hash)===String(hash))||null}),
    claimQdrantIdentity:(key)=>physical.claimQdrantIdentity(key,{...saved.vecthare,vector_backend:'qdrant',source:'llamacpp'}),
    insertVectorItems:async (id,items)=>{if(shouldFailInsert)throw new Error('mock insertion failure');inserted.push(id);for(const item of items){const rows=getCVRows(id);const pos=rows.findIndex(x=>String(x.hash)===String(item.hash));if(pos>=0)rows.splice(pos,1);rows.push(item);}},
    setCollectionMeta:meta.setCollectionMeta,
    getDefaultDecayForType:()=>({enabled:false}),
    hasFeature:()=>false,
    registerCollection:key=>{if(!saved.vecthare.vecthare_collection_registry.includes(key))saved.vecthare.vecthare_collection_registry.push(key);},
    bindChatCollection:owner.bindChatCollection,
    resolveChatWriteTarget:owner.resolveChatWriteTarget,
    getChatBinding:owner.getChatBinding,
    prepareEmbeddingItems:async items=>items,assignOccurrenceIds:items=>items,
    captureCleaningSnapshot:()=>({selectedPreset:"none",customPatterns:[],enabledBuiltins:[]}),
    buildExpectedChatItems:async()=>[{text:'user and assistant conversation',hash:31,metadata:{messageId:0}}],
    makeCollectionProfile:async()=>({schemaVersion:1,embedding:{verified:true,modelId:'mock'},chunking:{chunking_strategy:'conversation_turns',chunk_size:400}}),
    applyAndVerifyProfile:async key=>({profile:cvProfiles.get(key)}),
    getCollectionProfile:key=>cvProfiles.get(key)||null,
    saveCollectionProfile:async(key,profile)=>{cvProfiles.set(key,profile)},
    getChatChunkManifest:key=>cvManifests.get(key)||null,
    saveChatChunkManifest:async(key,items,uuid)=>cvManifests.set(key,{chatUUID:uuid,entries:items}),
    patchChatChunkManifest:async(key,items,uuid,removed=[])=>{let old=cvManifests.get(key)?.entries||[];old=old.filter(x=>!removed.map(String).includes(String(x.hash)));for(const item of items){old=old.filter(x=>String(x.hash)!==String(item.hash));old.push(item);}cvManifests.set(key,{chatUUID:uuid,entries:old})},
    inspectCollectionChunks:async(backend,id,s)=>{const rows=[];for(let offset=0;offset<100000;offset+=200){const part=await backend.listChunks(id,s,{offset,limit:200});rows.push(...part.items);if(part.items.length<200)break;}return rows},
    expectedEmbeddedText:item=>item.text,chunkMatchesExpected:(row,item)=>!!row && row.text===item.text && JSON.stringify(row.metadata?.messageIds||[row.metadata?.messageId])===JSON.stringify(item.metadata?.messageIds||[item.metadata?.messageId]),
    beginSyncCheckpoint:()=>{},updateSyncCheckpoint:()=>{},acknowledgeSyncChunk:()=>{},finalizeSyncCheckpoint:()=>{},
    acquireSharedOperation:async()=>({id:'mock'}),finishSharedOperation:async()=>{},SharedOperationStoppedError:class SharedOperationStoppedError extends Error{},
    hasActiveVectorWrite:()=>false,createOperationControl:()=>({activityId:'p0-cv',checkpoint:async()=>{},bindSharedOperation:()=>{}}),detachOperationControl:()=>{},OperationStoppedError:class OperationStoppedError extends Error{},
    parseRegistryKey:ids.parseRegistryKey,
    toastr:{error(){}},
});
context.contentVectorizationActive=false;
const vectorize=vm.runInContext('('+cv.slice(vectorizeStart,vectorizeEnd).replace('export async function','async function').trim()+')',context);
saved.vecthare.vector_backend='qdrant'; saved.vecthare.source='llamacpp';
const sourceSettings={strategy:'conversation_turns',chunkSize:400};
const uploaded=await vectorize({contentType:'chat',source:{type:'file',filename:'alice.jsonl',content:[{mes:'hello'}]},settings:sourceSettings});
check('uploaded chat vectorization writes to a separate unbound collection',()=>{
    assert.match(uploaded.collectionId,/^vecthare_chat_upload_alice_jsonl_/);
    assert.equal(owner.getChatBinding('chat-a'),null);
});
const normal=await vectorize({contentType:'chat',source:{type:'current',name:'Alice',content:[{mes:'hello'}]},settings:sourceSettings});
check('current-chat vectorization persists full write binding',()=>{
    assert.equal(owner.getChatBinding('chat-a').registryKey,'qdrant:llamacpp:vecthare_chat_alice_chat-a');
    assert.equal(normal.collectionId,'vecthare_chat_alice_chat-a');
    assert.equal(owner.getChatBinding('chat-a').writeVerified,true);
});
const originalBinding=owner.getChatBinding('chat-a').registryKey;
shouldFailInsert=true;
await assert.rejects(vectorize({contentType:'chat',source:{type:'current',replaceExisting:true,name:'Alice',content:[{mes:'hello'}]},settings:sourceSettings}),/mock insertion failure/);
check('failed replacement leaves old chat binding and metadata untouched',()=>{
    assert.equal(owner.getChatBinding('chat-a').registryKey,originalBinding);
    assert.equal(meta.getCollectionMeta(originalBinding).chunkCount,1);
});
shouldFailInsert=false;
const replacement=await vectorize({contentType:'chat',source:{type:'current',replaceExisting:true,name:'Alice',content:[{mes:'hello'}]},settings:sourceSettings});
check('successful replacement switches binding after new vectors are written',()=>{
    assert.match(replacement.collectionId,/_replacement_/);
    assert.equal(owner.getChatBinding('chat-a').registryKey,`qdrant:llamacpp:${replacement.collectionId}`);
    assert.equal(meta.getCollectionMeta(originalBinding).chunkCount,1);
    assert.equal(owner.getChatBinding('chat-a').writeVerified,true);
});
const oldBinding=owner.getChatBinding('chat-a').registryKey;
// Tenant mode uses a separate explicitly labelled test collection identity.
saved.vecthare.qdrantPhysicalIdentities['qdrant:llamacpp:alice']='qdrant:v1:http://localhost:6333:multitenancy=true';
await backend.insertVectorItems('alice',[{hash:1,text:'hey'}],{...settings,qdrant_multitenancy:true});
check('shared Qdrant insertion forwards tenant identity to verified plugin',()=>{
    assert.deepEqual(fetches.at(-1).body.filters,{content_type:'alice'});
    assert.equal(fetches.at(-1).body.items[0].metadata.content_type,'alice');
    assert.equal(owner.getChatBinding('chat-a').registryKey,oldBinding);
});
// Refuse all writes with a legacy plugin: it silently ignores tenant filters and overwrites hash IDs.
tenantCapabilitiesAvailable = false;
const oldLength = fetches.length;
await assert.rejects(backend.insertVectorItems('alice',[{hash:1,text:'no old plugin'}],{...settings,qdrant_multitenancy:true}),/updated Similharity plugin/);
check('older plugin cannot perform unsafe tenant write',()=>{
    assert.equal(fetches.slice(oldLength).every(f=>!String(f.url).includes('/chunks/insert')),true);
});
await assert.rejects(backend.purgeVectorIndex('alice',{...settings,qdrant_multitenancy:true}),/updated Similharity plugin/);
check('older plugin cannot perform unsafe tenant purge',()=>{
    assert.equal(fetches.slice(oldLength).every(f=>!String(f.url).includes('/chunks/purge')),true);
});
process.stdout.write(`\n${checks} total safety checks passed.\n`);
