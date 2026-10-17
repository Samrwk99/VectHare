/** P2/P3 targeted checks. Run: node --experimental-vm-modules tests/p2-p3-regression.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
const check = (label, fn) => { fn(); console.log('PASS', label); checks++; };
const checkAsync = async (label, fn) => { await fn(); console.log('PASS', label); checks++; };
const source = rel => fs.readFileSync(path.join(root, rel), 'utf8');

async function loadIsolated(rel, imports = {}, contextExtras = {}) {
    const context = vm.createContext({ console: {log(){},warn(){},error(){},debug(){}}, Date, Math,
        JSON, String, Number, URL, URLSearchParams, setTimeout, clearTimeout, ...contextExtras });
    const code = new vm.SourceTextModule(source(rel), {context, identifier: rel});
    const cache = new Map();
    await code.link(spec => {
        const key = path.basename(spec);
        const exports = imports[spec] || imports[key];
        if (!exports) throw new Error(`Unmocked import ${rel}: ${spec}`);
        if (!cache.has(spec)) {
            cache.set(spec, new vm.SyntheticModule(Object.keys(exports), function() {
                for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
            }, {context,identifier:spec}));
        }
        return cache.get(spec);
    });
    await code.evaluate();
    return code.namespace;
}

check('Per Scene is marker-only in Content Vectorizer, never zero-chunk batch', () => {
    const ui = source('ui/content-vectorizer.js');
    const core = source('core/content-vectorization.js');
    assert.match(ui, /if \(type\.id === 'chat' && s\.id === 'per_scene'\) return/);
    assert.match(core, /contentType === 'chat' && settings\?\.strategy === 'per_scene'/);
    assert.match(core, /Per Scene is marker-driven/);
    assert.match(source('ui/scene-markers.js'), /scene/i);
});
check('Diagnostic Fix Now actions do not import missing ui-settings.js', () => {
    assert.doesNotMatch(source('diagnostics/index.js'), /ui-settings\.js/);
    assert.match(source('diagnostics/index.js'), /extension_settings\.vecthare/);
});
check('Document-level vectorizer event listeners have a clean namespace', () => {
    const ui = source('ui/content-vectorizer.js');
    assert.match(ui, /\$\(document\)\.off\('\.vecthareContentVectorizer'\)/);
    assert.equal((ui.match(/\$\(document\)\.on\('change\.vecthareContentVectorizer'/g)||[]).length, 11);
    assert.doesNotMatch(ui, /\$\(document\)\.on\('change',/);
});
check('Enabled collections distinguish conditional eligibility from real activation', () => {
    const ui = source('ui/database-browser.js');
    assert.match(ui, /Enabled · No auto rule/);
    assert.match(ui, /Enabled · Conditional/);
    assert.doesNotMatch(ui, /vecthare-badge-success">Active</);
});

await checkAsync('BananaBread custom key is forwarded from VectHare settings, not secret_state', async () => {
    const m = await loadIsolated('backends/provider-params.js', {
        'extensions.js': { extension_settings: {apiUrl: '', apiKey:''} },
        'textgen-settings.js': {textgen_types:{},textgenerationwebui_settings:{server_urls:{}}},
        'openai.js': {oai_settings:{}},
    });
    const result = m.getProviderSpecificParams({source:'bananabread',use_alt_endpoint:true,alt_endpoint_url:'http://host:4000',bananabread_api_key:'CUSTOM_KEY'});
    assert.equal(result.apiKey,'CUSTOM_KEY');
    assert.equal(result.apiUrl,'http://host:4000');
});

await checkAsync('Cached backend is recreated when connection settings change', async () => {
    let created = 0;
    class Backend { constructor(){ this.id = ++created; } async initialize(settings){this.settings=settings;} async healthCheck(){return true;} }
    const ext = {vecthare:{vector_backend:'qdrant'}};
    const m = await loadIsolated('backends/backend-manager.js', {
        'extensions.js': {extension_settings:ext},
        'standard.js': {StandardBackend: Backend},
        'lancedb.js': {LanceDBBackend: Backend},
        'qdrant.js': {QdrantBackend: Backend},
        'milvus.js': {MilvusBackend: Backend},
    });
    const a = await m.initializeBackend('qdrant', {qdrant_host:'one',qdrant_api_key:'x'});
    const a2 = await m.initializeBackend('qdrant', {qdrant_host:'one',qdrant_api_key:'x'});
    assert.equal(a,a2);
    const b = await m.initializeBackend('qdrant', {qdrant_host:'two',qdrant_api_key:'x'});
    assert.notEqual(a,b);
    const c = await m.initializeBackend('qdrant', {qdrant_host:'two',qdrant_api_key:'y'});
    assert.notEqual(b,c);
    assert.equal(c.settings.qdrant_api_key, 'y');
    m.resetBackendHealth('qdrant');
    const d = await m.initializeBackend('qdrant', {qdrant_host:'two',qdrant_api_key:'y'});
    assert.notEqual(d,c);
});

await checkAsync('Plugin failed health cache expires and succeeds on retry', async () => {
    const loader=source('core/collection-loader.js');
    let current = 100000;
    let responds = false;
    let probes = 0;
    const section=loader.slice(loader.indexOf('async function checkPluginAvailable()'), loader.indexOf('// Cache for plugin collection data'));
    const code = `let pluginAvailable = null; let pluginCheckedAt=0; const PLUGIN_HEALTHY_TTL_MS=60000; const PLUGIN_FAILED_TTL_MS=10000; ${section}; checkPluginAvailable;`;
    const fn=vm.runInNewContext(code,{Date:{now:()=>current},getRequestHeaders:()=>({}),console:{log(){},warn(){}},fetch:async()=>{probes++;return{ok:responds,json:async()=>({status:'ok',version:'1'})}}});
    assert.equal(await fn(), false); asserts(1);
    responds = true; current += 5000;
    assert.equal(await fn(), false); asserts(1);
    current += 6000;
    assert.equal(await fn(), true); asserts(2);
    function asserts(expected){assert.equal(probes,expected);}
});

await checkAsync('Legacy filename policy migrates only current chat to UUID without losing selection', async () => {
    const chat = {current:'alice_2024',uuid:'chat-uuid-123'};
    const settings = {vecthare:{collections:{},chatCollectionPolicies:{alice_2024:{mode:'only_selected',selectedCollections:['qdrant:llamacpp:foo']}},vecthare_collection_registry:['qdrant:llamacpp:foo','standard:llamacpp:foo']}};
    const m = await loadIsolated('core/collection-metadata.js', {
        'extensions.js': {extension_settings:settings},
        'script.js': { saveSettingsDebounced(){},getCurrentChatId:()=>chat.current },
        'shared-operations.js': {withSharedWriteHeaders:x=>x,runExclusiveNativeMutation:(_l,_r,fn)=>fn()},
        'settings-durability.js': {saveVectHareSettingsDebounced(){}},
        'physical-identity.js': {assertQdrantIdentity(){return true;}},
        'collection-ids.js': {getChatUUID:()=>chat.uuid,parseCollectionId:key=>({type:String(key).startsWith('vecthare_lorebook_')?'lorebook':'chat'}),parseRegistryKey:key=>{
            const split=key.split(':');return split.length>=3 ? {backend:split[0],source:split[1],collectionId:split.slice(2).join(':')}:{backend:null,source:null,collectionId:key};
        }},
    });
    const existing = m.getChatCollectionPolicy(chat.current);
    assert.equal(existing.mode,'only_selected');
    m.setChatCollectionPolicy(chat.current,{mode:'prefer_selected'});
    assert.equal(settings.vecthare.chatCollectionPolicies['alice_2024'],undefined);
    assert.equal(settings.vecthare.chatCollectionPolicies['chat-uuid-123'].mode,'prefer_selected');
    assert.equal(m.getChatCollectionPolicy(chat.uuid).selectedCollections[0],'qdrant:llamacpp:foo');
    assert.equal(m.isCollectionSelectedForChat('standard:llamacpp:foo',chat.current),false);
    assert.equal(m.isCollectionSelectedForChat('qdrant:llamacpp:foo',chat.current),true);
    const preferred = m.applyChatCollectionPolicy(['standard:llamacpp:foo','qdrant:llamacpp:foo'],chat.current);
    assert.deepEqual(Array.from(preferred), ['qdrant:llamacpp:foo','standard:llamacpp:foo']);
    m.setChatCollectionPolicy(chat.uuid,{selectedCollections:['foo']});
    assert.equal(m.isCollectionSelectedForChat('qdrant:llamacpp:foo',chat.uuid),false, 'ambiguous bare policy cannot select both backends');
    chat.current = 'bob_2024'; chat.uuid='other-uuid';
    assert.equal(m.getChatCollectionPolicy(chat.current).mode,'normal');
});

await checkAsync('Standard native sidecar saves text+metadata after success and preserves on failed deletion', async () => {
    const ext={vecthare:{}};
    const hashes=new Set(); let failDelete=false; let failPurge=false;
    const fetch=async(uri,opts={})=>{
        const body=opts.body ? JSON.parse(opts.body):{};
        if(uri==='/api/vector/insert')for(const item of body.items)hashes.add(item.hash);
        if(uri==='/api/vector/delete' && !failDelete)for(const hash of body.hashes)hashes.delete(hash);
        if(uri==='/api/vector/purge' && !failPurge) hashes.clear();
        const failed = (failDelete && uri==='/api/vector/delete') || (failPurge && uri==='/api/vector/purge');
        return {ok:!failed,status:failed?500:200,statusText:'OK',
            json:async()=> uri==='/api/vector/list'? [...hashes]:uri==='/api/vector/query'?{hashes:[...hashes],metadata:[{score:.3}]}:{},
            text:async()=> 'error'};
    };
    class VectorBackend {};
    const m=await loadIsolated('backends/standard.js',{
        'shared-operations.js': {withSharedWriteHeaders:x=>x,runExclusiveNativeMutation:(_l,_r,fn)=>fn()},
        'settings-durability.js': {saveVectHareSettingsDebounced(){}},
        'script.js': {getRequestHeaders:()=>({}),saveSettingsDebounced(){}},
        'extensions.js': {extension_settings:ext},
        'backend-interface.js': {VectorBackend},
        'providers.js': {getModelField:()=> 'embedding_model'},
        'provider-params.js': {getProviderSpecificParams:()=>({})},
        'embedding-overflow.js': {assertEmbeddingQueryFits:async()=>{}},
        'constants.js': {VECTOR_LIST_LIMIT:10000},
    },{fetch});
    const backend=new m.StandardBackend();
    const settings={source:'llamacpp',embedding_model:'embed-A'};
    await backend.insertVectorItems('alice',[{hash:123,text:'London trip',metadata:{role:'user'},keywords:['London']}],settings);
    const listing=await backend.listChunks('alice',settings);
    assert.equal(listing.items[0].text,'London trip');
    assert.equal(listing.items[0].metadata.role,'user');
    assert.equal(listing.items[0].metadata.keywords[0],'London');
    assert.equal((await backend.queryCollection('alice','trip',4,settings)).metadata[0].role,'user');
    failDelete=true;
    await assert.rejects(backend.deleteVectorItems('alice',[123],settings));
    assert.equal((await backend.listChunks('alice',settings)).items[0].text,'London trip');
    failDelete=false;
    await backend.deleteVectorItems('alice',[123],settings);
    assert.equal((await backend.listChunks('alice',settings)).items.length,0);
    assert.equal((await backend.getChunk('alice',123,settings)),null);
    await backend.insertVectorItems('alice',[{hash:777,text:'Old message',metadata:{messageId:4}}],settings);
    failPurge=true;
    await assert.rejects(backend.purgeVectorIndex('alice', settings));
    assert.equal((await backend.listChunks('alice',settings)).items[0].text,'Old message');
    failPurge=false;
    await backend.purgeVectorIndex('alice',settings);
    assert.equal((await backend.listChunks('alice',settings)).total,0);
    assert.equal(Object.keys(ext.vecthare.nativeStandardChunks).length,0);
});

console.log(`\n${checks} P2/P3 regression checks passed`);
