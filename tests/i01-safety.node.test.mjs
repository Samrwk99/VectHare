/**
 * Run without external dependencies:
 *   node --experimental-vm-modules --test tests/i01-safety.node.test.mjs
 * (Other project tests remain Vitest-based.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
    isGeneratedDiagnosticCollectionId,
    assertFullPurgeAcknowledged,
    purgeAllAndResetSettings,
} from '../core/destructive-safety.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fakeResponse = (status, body = undefined) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 500 ? 'Internal Server Error' : 'OK',
    headers: { get: () => body === undefined ? null : 'application/json' },
    json: async () => body,
});

test('I01 #215: HTTP error retains settings and skips persistence', async () => {
    const settings = { enabled: true, collections: { chat: { important: true } }, vector_backend: 'qdrant' };
    let persists = 0;
    await assert.rejects(
        purgeAllAndResetSettings({ requestPurge: async () => fakeResponse(500), contractVerified:true, settings, persistSettings: () => persists++ }),
        /not accepted/,
    );
    assert.equal(settings.collections.chat.important, true);
    assert.equal(settings.vector_backend, 'qdrant');
    assert.equal(persists, 0);
});

test('I01 #215: application-level failures and malformed JSON retain settings', async () => {
    for (const response of [
        fakeResponse(200, { success: false, error: 'purge blocked' }),
        fakeResponse(200, { status: 'failed' }),
        { ...fakeResponse(200, {}), json: async () => { throw new Error('broken JSON'); } },
    ]) {
        const settings = { enabled: false, collections: { keep: true } };
        let persists = 0;
        await assert.rejects(purgeAllAndResetSettings({ requestPurge: async () => response, contractVerified:true, settings, persistSettings: () => persists++ }));
        assert.deepEqual(settings, { enabled: false, collections: { keep: true } });
        assert.equal(persists, 0);
    }
});

test('I01 #215: only acknowledged purge clears settings; enabled is preserved', async () => {
    const settings = { enabled: false, collections: { some: 'data' }, qdrant_api_key: 'secret' };
    let persists = 0;
    await purgeAllAndResetSettings({ requestPurge: async () => fakeResponse(204), contractVerified:true, settings, persistSettings: () => persists++ });
    assert.deepEqual(settings, { enabled: false });
    assert.equal(persists, 1);
    await assert.doesNotReject(assertFullPurgeAcknowledged(fakeResponse(200, { success: true })));
});

test('I01 #170: only recognized diagnostic ID shapes qualify', () => {
    for (const id of ['vh:test:visualizer_1700000000000', 'vh:test:storage_1700000000000', 'vh:test:embed_1700000000000']) {
        assert.equal(isGeneratedDiagnosticCollectionId(id), true);
    }
    for (const id of [
        'my_vh:test:visualizer_1700000000000',
        'vecthare_test_1700000000000',
        'ordinary_vh:test:embed_1700000000000_memory',
        'vh:test:storage_not_a_timestamp',
        'vh:test:visualizer_123',
    ]) {
        assert.equal(isGeneratedDiagnosticCollectionId(id), false, id);
    }
});

// Evaluate the real collection-loader module with isolated SillyTavern stubs.
// This tests its actual registry/deletion logic, not a copied implementation.
async function loadCollectionLoader({ registry = [], purge = async () => true } = {}) {
    const settings = { vecthare_collection_registry: [...registry], vecthare_diagnostic_test_ids: [], collections:Object.fromEntries(registry.filter(k=>k.split(':').length>=3).map(k=>[k,{}])) }; 
    const extension_settings = { vecthare: settings };
    const calls = { saves: 0, metadataDeletes: [], purges: [] };
    const context = vm.createContext({ console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout });
    const cache = new Map();
    const stubs = {
        '../utils/e02-vector-request-gateway.js':{guardedVectorFetch:(...args)=>context.fetch(...args)},
        '../utils/keyed-mutex.js': {withCollectionLock: async (_key,fn)=>fn(),writeBarrier:{closeAndDrain:async()=>({verified:true}),reopen:()=>{}}},
        '../utils/c01-deletion.js': {deleteCollectionSafely:async()=>({success:false,status:'blocked',reason:'destructive-server-contract-unverified'}),recoverTombstones:()=>[]},
        '../utils/c01-inventory.js': {collectScopedInventory:async()=>({complete:false,status:'unavailable'})},
        '../utils/backend-contracts.js': {hasVerifiedCapability:()=>false},
        '../backends/backend-manager.js': {getBackendForCollection:async()=>null},
        '../utils/c11-adapter-inventory.js': {inspectAdapterInventory:async()=>({complete:false,status:'unavailable'})},
        '../../../../extensions.js': { extension_settings, getContext: () => ({}) },
        '../../../../../script.js': {
            characters: [], substituteParams: x => x,
            getRequestHeaders: () => ({}), saveSettingsDebounced: () => calls.saves++,
            getCurrentChatId: () => 'chat-a', chat_metadata: {},
        },
        '../../../../utils.js': { getStringHash: () => 1 },
        './core-vector-api.js': {
            getSavedHashes: async () => [], queryCollection: async () => [],
            purgeVectorIndex: async (id, opts) => { calls.purges.push(id); return purge(id, opts); },
        },
        './collection-metadata.js': {
            isCollectionEnabled: () => true, setCollectionEnabled: () => {},
            getChunkMetadata: () => ({}), saveChunkMetadata: () => {}, deleteChunkMetadata: () => {},
            deleteCollectionMeta: id => calls.metadataDeletes.push(id),
            ensureCollectionMeta: () => {}, getCollectionMeta: () => ({}),
        },
    };
    const actual = new Map([
        ['./destructive-safety.js', 'core/destructive-safety.js'],
        ['../utils/collection-keys.js', 'utils/collection-keys.js'],
        ['./collection-ids.js', 'core/collection-ids.js'],
    ]);
    function synthetic(specifier) {
        const obj = stubs[specifier];
        if (!obj) throw Error(`Unexpected import: ${specifier}`);
        return new vm.SyntheticModule(Object.keys(obj), function () {
            for (const [key, value] of Object.entries(obj)) this.setExport(key, value);
        }, { context, identifier: specifier });
    }
    async function linker(specifier) {
        if (cache.has(specifier)) return cache.get(specifier);
        const file = actual.get(specifier);
        const result = file
            ? new vm.SourceTextModule(fs.readFileSync(path.join(root, file), 'utf8'), { context, identifier: file })
            : synthetic(specifier);
        cache.set(specifier, result);
        return result;
    }
    const loader = new vm.SourceTextModule(fs.readFileSync(path.join(root, 'core/collection-loader.js'), 'utf8'), { context, identifier: 'core/collection-loader.js' });
    await loader.link(linker);
    await loader.evaluate();
    return { api: loader.namespace, settings, calls };
}

test('I01 #170: cleanup preserves unmarked and user-named collections', async () => {
    const owned = 'vh:test:storage_1700000000001';
    const unmarked = 'vh:test:visualizer_1700000000002';
    const custom = 'vecthare_test_my_story';
    const testKey = `qdrant:openai:${owned}`;
    const { api, settings, calls } = await loadCollectionLoader({ registry: [testKey, unmarked, custom, 'notes_vh:test:storage_1700000000001'] });
    assert.equal(api.cleanupTestCollections(), 0);
    assert.equal(settings.vecthare_collection_registry.length, 4);
    api.markDiagnosticTestCollection(owned);
    assert.equal(api.cleanupTestCollections(), 1);
    assert.deepEqual(settings.vecthare_collection_registry, [unmarked, custom, 'notes_vh:test:storage_1700000000001']);
    assert.deepEqual(Array.from(settings.vecthare_diagnostic_test_ids), []);
    assert.ok(calls.saves >= 2);
});

test('I01 #170: refuse to mark user IDs as diagnostic-owned', async () => {
    const { api } = await loadCollectionLoader();
    assert.throws(() => api.markDiagnosticTestCollection('my_vecthare_test_story'), /Unrecognized/);
});

test('I01 #6: failed purge retains collection registry and metadata', async () => {
    const { api, settings, calls } = await loadCollectionLoader({ registry: ['standard:openai:my_chat'], purge: async () => false });
    const result = await api.deleteCollection('my_chat', {}, 'standard:openai:my_chat');
    assert.equal(result.success, false);
    assert.equal(result.vectorsDeleted, false);
    assert.equal(result.registryDeleted, false);
    assert.equal(result.metadataDeleted, false);
    assert.equal(result.errors.length, 1);
    assert.deepEqual(settings.vecthare_collection_registry, ['standard:openai:my_chat']);
    assert.deepEqual(calls.metadataDeletes, []);
});

test('I01 #6: purge exceptions retain collection registry and metadata', async () => {
    const { api, settings, calls } = await loadCollectionLoader({ registry: ['standard:openai:my_chat'], purge: async () => { throw Error('unavailable'); } });
    const result = await api.deleteCollection('my_chat', {});
    assert.equal(result.success, false);
    assert.deepEqual(settings.vecthare_collection_registry, ['standard:openai:my_chat']);
    assert.deepEqual(calls.metadataDeletes, []);
});

test('I01 #6 / C01: a mocked purge acknowledgement alone cannot authorize registry or metadata deletion', async () => {
    const { api, settings, calls } = await loadCollectionLoader({ registry: ['standard:openai:my_chat', 'my_chat'] });
    const result = await api.deleteCollection('my_chat', {}, 'standard:openai:my_chat');
    assert.equal(result.success, false);
    assert.deepEqual(settings.vecthare_collection_registry, ['standard:openai:my_chat', 'my_chat']);
    assert.deepEqual(calls.metadataDeletes, []);
    assert.deepEqual(calls.purges, []);
});
