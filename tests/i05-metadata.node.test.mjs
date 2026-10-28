import {adapterCollectionId, rejectUnscopedPointOperation} from '../utils/tenant-route.js';
/** I05: collection isolation and metadata integrity tests; no live backend required. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { mergeDefinedChunkMetadata, trustedQueryMetadata, completeSavedChunkMetadata } from '../utils/chunk-record-metadata.js';
import { requireListedItems, requireQueryItems, hybridEndpointUnsupported } from '../utils/backend-response-validation.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const silent = { log() {}, debug() {}, warn() {}, error() {} };
const settings = { source: 'transformers', qdrant_multitenancy: false };
const response = payload => ({ ok: true, status: 200, json: async () => payload });

function makeAdapter(file, results) {
    const src = source(`backends/${file}.js`).replace(/^import .*?;\s*$/gm, '').replace('export class ', 'class ');
    const calls = [];
    const context = vm.createContext({ console: silent, VectorBackend: class {},
        getRequestHeaders: () => ({}), getModelField: () => null, getProviderSpecificParams: () => ({}),
        VECTOR_LIST_LIMIT: 100, requireListedItems, requireQueryItems, hybridEndpointUnsupported,
        mergeDefinedChunkMetadata, trustedQueryMetadata,
        adapterCollectionId, rejectUnscopedPointOperation, requireTenantScope: () => {}, hasVerifiedCapability: () => false,
        fetch: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return response(results.shift()); },
    });
    const className = { standard: 'StandardBackend', qdrant: 'QdrantBackend', milvus: 'MilvusBackend', lancedb: 'LanceDBBackend' }[file];
    return { backend: new (vm.runInContext(`${src}\n${className}`, context))(), calls };
}

test('#199: nested metadata survives missing top-level fields and explicit false/empty overrides', () => {
    const source = { metadata: { keywords: [{ text: 'nested' }], conditions: { rules: [42] }, isSummaryChunk: true, importance: 0.8 }, keywords: undefined, importance: 0, isSummaryChunk: false };
    const result = mergeDefinedChunkMetadata(source);
    assert.deepEqual(result.keywords, [{ text: 'nested' }]);
    assert.deepEqual(result.conditions, { rules: [42] });
    assert.equal(result.importance, 0);
    assert.equal(result.isSummaryChunk, false);
    assert.equal(source.metadata.importance, 0.8, 'Must not mutate original');
});

for (const name of ['qdrant', 'milvus', 'lancedb', 'standard']) {
    test(`#199: ${name} actual insert carries nested metadata without clobbering it`, async () => {
        const { backend, calls } = makeAdapter(name, [{}]);
        if (name === 'standard') backend.pluginAvailable = true;
        if (name === 'qdrant') backend._registerCollection = async () => {};
        const item = { hash: 42, text: 'hello', index: 0, metadata: { keywords: ['inside'], conditions: { enabled: true }, summary: 'inside', importance: 0.9 },
            importance: undefined, keywords: undefined, conditions: undefined };
        await backend.insertVectorItems('my-collection', [item], settings);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].body.items[0].metadata.summary, 'inside');
        assert.deepEqual(calls[0].body.items[0].metadata.keywords, ['inside']);
        assert.deepEqual(calls[0].body.items[0].metadata.conditions, { enabled: true });
        assert.equal(calls[0].body.items[0].metadata.importance, 0.9);
    });
}

for (const name of ['qdrant', 'milvus', 'lancedb']) {
    test(`#200: ${name} single/multi-query protects result identity and score`, async () => {
        const malicious = { hash: 'wrong', text: 'wrong text', score: 900, keywordBoost: 2 };
        const r = { hash: 123, text: 'real text', score: 0.32, metadata: {...malicious,type:'chat',sourceId:'collection'} };
        const a = makeAdapter(name, [{ results: [r] }]);
        const single = await a.backend.queryCollection(name === 'qdrant' ? 'vh:chat:collection' : 'collection', 'query', 5, settings);
        assert.deepEqual(Array.from(single.hashes), [123]);
        assert.equal(single.metadata[0].hash, 123);
        assert.equal(single.metadata[0].text, 'real text');
        assert.equal(single.metadata[0].score, 0.32);
        assert.equal(single.metadata[0].keywordBoost, 2);
        const b = makeAdapter(name, [{ results: [r] }]);
        const multi = await b.backend.queryMultipleCollections([name === 'qdrant' ? 'vh:chat:collection' : 'collection'], 'query', 5, 0, settings);
        assert.equal(multi[name === 'qdrant' ? 'vh:chat:collection' : 'collection'].metadata[0].hash, 123);
        assert.equal(multi[name === 'qdrant' ? 'vh:chat:collection' : 'collection'].metadata[0].text, 'real text');
        assert.equal(multi[name === 'qdrant' ? 'vh:chat:collection' : 'collection'].metadata[0].score, 0.32);
    });
}

test('#37: merging a saved item preserves all metadata plus authoritative hash, index and text', () => {
    const merged = completeSavedChunkMetadata({ hash: 123, text: 'stored text', index: 0, metadata: { hash: 999, text: 'stale text', index: 5, conditions: { enabled: true } } });
    assert.deepEqual(merged, { hash: 123, text: 'stored text', index: 0, conditions: { enabled: true } });
    assert.deepEqual(completeSavedChunkMetadata({ hash: 2, text: '' }), { hash: 2, text: '' });
});

test('#37: actual getSavedHashes(includeMetadata) returns text/hash/index from list items', async () => {
    const src = source('core/core-vector-api.js');
    const begin = src.indexOf('export async function getSavedHashes(');
    const end = src.indexOf('\n}\n', begin);
    assert.ok(begin >= 0 && end > begin);
    const fnSrc = src.slice(begin, end+2).replace('export async function ', 'async function ');
    const backend = {
        getSavedHashes: async () => [123, 124],
        listChunks: async () => ({ items: [{ hash: 123, text: 'text here', index: 7, metadata: { conditions: { enabled: true } } }, { hash: 124, text: '', index: 0, metadata: {} }] }),
    };
    const ctx = vm.createContext({ getBackend: async () => backend, withOpGuard: fn => fn(), completeSavedChunkMetadata, VECTOR_LIST_LIMIT: 1000, console: silent });
    const fn = vm.runInContext(`${fnSrc}\ngetSavedHashes`, ctx);
    const result = await fn('key', settings, true);
    assert.deepEqual(Array.from(result.hashes), [123,124]);
    assert.equal(result.metadata[0].text, 'text here');
    assert.equal(result.metadata[0].hash, 123);
    assert.equal(result.metadata[0].index, 7);
    assert.deepEqual(result.metadata[0].conditions, { enabled: true });
    assert.equal(result.metadata[1].text, '');
});

async function collectionSettingsModule() {
    const data = { vecthare: { collections: {} } };
    let saves = 0;
    const ctx = vm.createContext({ console: silent });
    const mod = new vm.SourceTextModule(source('core/collection-metadata.js'), { context: ctx });
    await mod.link(spec => {
        const dependencies = {
            '../../../../extensions.js': { extension_settings: data },
            '../../../../../script.js': { saveSettingsDebounced: () => saves++ },
            './collection-ids.js': { parseRegistryKey: id => ({ collectionId: String(id).split(':').pop() }) },
            '../utils/c01-inventory.js': {planOrphanCollectionMetadataRemoval:()=>({allowed:false,reason:'no authoritative inventory',remove:[]})},
            '../utils/c04-registry-migration.js': {inspectRegistryMigration:()=>({status:'requires-remap'})},
            '../utils/c04-ownership.js': {verifyCollectionOwner:()=>({allowed:true})},
            '../utils/collection-keys.js': {parseCollectionKey:()=>null},
        };
        assert.ok(dependencies[spec], `Unexpected dependency ${spec}`);
        const obj = dependencies[spec];
        return new vm.SyntheticModule(Object.keys(obj), function () {
            for (const [k,v] of Object.entries(obj)) this.setExport(k,v);
        }, { context:ctx });
    });
    await mod.evaluate();
    return { meta: mod.namespace, data, saves: () => saves };
}

test('#175: getCollectionMeta defaults are independent on missing and stored collections', async () => {
    const { meta, data } = await collectionSettingsModule();
    const a = meta.getCollectionMeta('A');
    a.tags.push('A'); a.conditions.rules.push({ type:'pattern' }); a.temporalDecay.enabled = true;
    const b = meta.getCollectionMeta('B');
    assert.equal(b.tags.length,0);
    assert.equal(b.conditions.rules.length,0);
    assert.equal(b.temporalDecay.enabled,false);
    meta.ensureCollectionMeta('C'); meta.ensureCollectionMeta('D');
    data.vecthare.collections.C.conditions.rules.push('C');
    assert.equal(data.vecthare.collections.D.conditions.rules.length,0);
    const all = meta.getAllCollectionMeta();
    all.C.conditions.rules.push('detached');
    assert.equal(data.vecthare.collections.C.conditions.rules.length,1);
    const ret = meta.getCollectionMeta('C');
    ret.conditions.rules.push('should be detached');
    assert.equal(data.vecthare.collections.C.conditions.rules.length,1);
});

test('#175: setCollectionMeta does not share input objects and legacy migration clones defaults', async () => {
    const { meta, data } = await collectionSettingsModule();
    const incoming = { tags:['hello'], conditions:{ enabled:true, rules:[{ test:1 }] } };
    meta.setCollectionMeta('X',incoming);
    incoming.tags.push('mutated');incoming.conditions.rules[0].test = 999;
    assert.deepEqual(Array.from(meta.getCollectionMeta('X').tags),['hello']);
    assert.equal(meta.getCollectionMeta('X').conditions.rules[0].test,1);
    data.vecthare.vecthare_collection_enabled_old = false;
    const migration=meta.migrateOldEnabledKeys();
    assert.equal(migration.migrated,0);
    assert.equal(migration.blocked,1);
    assert.equal(data.vecthare.vecthare_collection_enabled_old,false);
    assert.equal(data.vecthare.collections.old,undefined); // cannot infer owner from old flag
    assert.equal(meta.getCollectionMeta('X').conditions.rules.length,1);
});

function getSaveAllChangesFunction() {
    const s=source('ui/chunk-visualizer.js');const start=s.indexOf('async function saveAllChanges() {');const end=s.indexOf('\n}\n',start);
    assert.ok(start>=0 && end>start);
    return s.slice(start,end+2);
}
async function exerciseSave(updater) {
    const pendingChanges=new Map([[1,{ keywords:['A'] }],[2,{ conditions:{enabled:true} }]]);
    const persisted=[];const messages=[];const calls=[];
    const ctx=vm.createContext({ pendingChanges, console:silent, currentCollectionId:'collection', currentSettings:{},
        toastr: { warning:m=>messages.push(['warning',m]), success:m=>messages.push(['success',m]), info:m=>messages.push(['info',m]) },
        updateChunkMetadata: async (id,hash,metadata)=>{calls.push(hash);return updater(hash,metadata);},
        getChunkMetadata:()=>({}), saveChunkMetadata:(hash, value)=>persisted.push(hash),
    });
    const fn=vm.runInContext(`${getSaveAllChangesFunction()}\nsaveAllChanges`,ctx);
    await fn();
    return {pendingChanges,persisted,messages,calls, ctx,fn};
}

test('#83: backend rejected metadata keeps the edit unsaved and never shows success',async()=>{
    const result=await exerciseSave(()=>{throw new Error('backend offline');});
    assert.deepEqual(result.persisted,[]);
    assert.equal(result.pendingChanges.size,2);
    assert.equal(result.messages[0][0],'warning');
    assert.equal(vm.runInContext('hasUnsavedChanges', result.ctx),true);
});

test('#83: partial backend failure keeps only failed chunks for retry',async()=>{
    const result=await exerciseSave(hash=>hash===2?false:undefined);
    assert.deepEqual(result.persisted,[1]);
    assert.deepEqual([...result.pendingChanges.keys()],[2]);
    assert.equal(result.messages[0][0],'warning');
    assert.match(result.messages[0][1],/Saved 1 of 2/);
    assert.equal(vm.runInContext('hasUnsavedChanges',result.ctx),true);
});

test('#83: all metadata saves confirmed clears pending and reports success',async()=>{
    const result=await exerciseSave(()=>({success:true}));
    assert.deepEqual(result.persisted,[1,2]);
    assert.equal(result.pendingChanges.size,0);
    assert.equal(result.messages[0][0],'success');
    assert.equal(vm.runInContext('hasUnsavedChanges',result.ctx),false);
});
