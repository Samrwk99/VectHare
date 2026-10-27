import {adapterCollectionId} from '../utils/tenant-route.js';
/** I08 regression tests: provider-model compatibility and Standard plugin insert fallback. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { mergeDefinedChunkMetadata } from '../utils/chunk-record-metadata.js';
import { hybridEndpointUnsupported } from '../utils/backend-response-validation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = f => fs.readFileSync(path.join(root, f), 'utf8');
const quiet = { log() {}, debug() {}, warn() {}, error() {} };
const json = value => JSON.parse(JSON.stringify(value));
function http(status, payload = {}, statusText = 'test') {
    return { ok: status >= 200 && status < 300, status, statusText,
        json: async () => payload, text: async () => JSON.stringify(payload) };
}

let providers;
async function getProviders() {
    if (providers) return providers;
    const context = vm.createContext({ console: quiet });
    const module = new vm.SourceTextModule(source('core/providers.js'), { context });
    await module.link(spec => {
        assert.equal(spec, '../../../../secrets.js');
        return new vm.SyntheticModule(['SECRET_KEYS'], function () { this.setExport('SECRET_KEYS', {}); }, { context });
    });
    await module.evaluate();
    providers = module.namespace;
    return providers;
}

function makeStandard(replies, getProviderSpecificParams = () => ({ apiUrl: 'http://provider.local', keep: true })) {
    const src = source('backends/standard.js').replace(/^import .*?;\s*$/gm, '').replace('export class ', 'class ');
    const calls = [];
    const context = vm.createContext({
        console: quiet,
        VectorBackend: class {}, getRequestHeaders: () => ({}),
        getModelField: src => ({ ollama: 'ollama_model', vllm: 'vllm_model', openai: 'openai_model' })[src] || null,
        getProviderSpecificParams, hybridEndpointUnsupported, mergeDefinedChunkMetadata, adapterCollectionId, hasVerifiedCapability:()=>false,
        VECTOR_LIST_LIMIT: 100,
        fetch: async (url, options) => {
            calls.push({ url, body: JSON.parse(options.body) });
            assert.ok(replies.length, `Unexpected ${url}`);
            const next = replies.shift();
            if (next instanceof Error) throw next;
            return next;
        },
    });
    return { backend: new (vm.runInContext(`${src}\nStandardBackend`, context))(), calls };
}

async function makeExportHarness() {
    const p = await getProviders();
    const calls = [];
    const written = [];
    const settingsStore = new Map();
    const items = [{ hash: 32, text: 'world', index: 0, vector: [0.5, 0.1], metadata: {} }];
    const context = vm.createContext({
        console: quiet, Blob, URL, document: {}, FileReader: class {},
        fetch: async (url, options) => {
            const body = JSON.parse(options.body);
            calls.push({ url, body });
            if (url.endsWith('/list')) return http(200, { success: true, items });
            if (url.endsWith('/insert')) return http(200, { success: true, inserted: body.items.length });
            throw new Error(`Unexpected endpoint ${url}`);
        },
    });
    const extensionStubs = {
        '../utils/security.js': {redactSecrets:value=>value},
    '../utils/c04-ownership.js': {quarantineImportedOwnership:(meta)=>({...meta,enabled:false,ownershipReviewRequired:true})},
    '../utils/tenant-route.js': {adapterCollectionId:(key)=>key},
        '../../../../extensions.js': { extension_settings: { vecthare: {} } },
        '../../../../../script.js': { getRequestHeaders: () => ({}), saveSettingsDebounced() {} },
        './core-vector-api.js': { getSavedHashes: async () => [], insertVectorItems: async (id, records) => written.push({ id, records }), purgeVectorIndex: async () => true },
        './collection-metadata.js': { getCollectionMeta: id => settingsStore.get(id), setCollectionMeta: (id, meta) => settingsStore.set(id, meta),
            getChunkMetadata: () => null, saveChunkMetadata() {}, getAllChunkMetadata: () => ({}) },
        './collection-loader.js': { registerCollection() {}, getCollectionRegistry: () => [] },
        '../ui/progress-tracker.js': { progressTracker: Object.fromEntries(['show', 'updateCurrentItem', 'updateProgress', 'updateChunks', 'complete', 'addError'].map(name => [name, () => {}])) },
        '../../../../utils.js': { getStringHash: () => 32 },
        './providers.js': { getConfiguredEmbeddingModel: p.getConfiguredEmbeddingModel },
    };
    const m = new vm.SourceTextModule(source('core/collection-export.js'), { context });
    await m.link(spec => {
        assert.ok(extensionStubs[spec], `Unknown dependency ${spec}`);
        return new vm.SyntheticModule(Object.keys(extensionStubs[spec]), function () {
            for (const [key, value] of Object.entries(extensionStubs[spec])) this.setExport(key, value);
        }, { context });
    });
    await m.evaluate();
    return { api: m.namespace, calls, written, items };
}

const sample = model => ({ version: '1.0.0', collection: { id: 'imported' },
    embedding: { source: 'ollama', model, dimension: 2 }, chunks: [{ text: 'world', vector: [0.5, 0.1] }] });

// #60: always read the selected source's configured embedding model rather than
// a generic/stale settings.model, both for export and import paths.
test('#60 provider-specific model resolution wins over stale generic model', async () => {
    const p = await getProviders();
    assert.equal(p.getConfiguredEmbeddingModel({ source: 'ollama', ollama_model: 'm-1', model: 'stale' }), 'm-1');
    assert.equal(p.getConfiguredEmbeddingModel({ source: 'openai', openai_model: 'text-embedding-3-small', model: 'stale' }), 'text-embedding-3-small');
    assert.equal(p.getConfiguredEmbeddingModel({ source: 'vllm', model: 'stale' }), '');
    assert.equal(p.getConfiguredEmbeddingModel({ source: 'transformers', model: 'legacy' }), 'legacy');
});

test('#60 validation and import use provider model for both direct and re-embed decisions', async () => {
    const { api, calls, written } = await makeExportHarness();
    const settings = { source: 'ollama', ollama_model: 'model-A', model: 'stale-model', vector_backend: 'standard' };
    const good = sample('model-A');
    assert.equal(api.validateImportData(good, settings).compatible, true);
    const direct = await api.importCollection(good, settings);
    assert.equal(direct.usedVectors, true);
    assert.equal(calls.filter(c => c.url.endsWith('/insert')).at(-1).body.model, 'model-A');
    assert.equal(written.length, 0, 'Direct import must preserve matching vectors');

    const wrong = sample('stale-model');
    assert.equal(api.validateImportData(wrong, settings).compatible, false);
    const reembedded = await api.importCollection(wrong, settings);
    assert.equal(reembedded.usedVectors, false);
    assert.equal(written.length, 1, 'Provider mismatch requires re-embedding');
    assert.equal(written[0].records[0].vector, undefined);

    const silentGood = await api.importMultipleCollections({ type: 'multi', collections: [good] }, settings);
    assert.equal(silentGood.imported, 1);
    assert.equal(calls.filter(c => c.url.endsWith('/insert')).at(-1).body.model, 'model-A');
});

test('#60 export writes selected provider model and honors explicit registry model', async () => {
    const { api, calls } = await makeExportHarness();
    const settings = { source: 'ollama', ollama_model: 'effective', model: 'stale', vector_backend: 'standard' };
    const backup = await api.exportCollection('collection', settings, {}, { silent: true });
    assert.equal(backup.embedding.model, 'effective');
    assert.equal(calls.at(-1).body.model, 'effective');
    const other = await api.exportCollection('collection', settings, { model: 'registry-model' }, { silent: true });
    assert.equal(other.embedding.model, 'registry-model');
    assert.equal(calls.at(-1).body.model, 'registry-model');
});

const item = [{ hash: 1, text: 'one', index: 0, metadata: { keywords: ['tag'] } }];

test('#224 plugin insert passes identical provider-specific params used by native route', async () => {
    const a = makeStandard([http(200, { success: true, inserted: 1 })]);
    a.backend.pluginAvailable = true;
    await a.backend.insertVectorItems('abc', item, { source: 'ollama', ollama_model: 'nomic' });
    assert.equal(a.calls.length, 1);
    assert.equal(a.calls[0].url, '/api/plugins/similharity/chunks/insert');
    assert.equal(a.calls[0].body.apiUrl, 'http://provider.local');
    assert.equal(a.calls[0].body.keep, true);
    assert.equal(a.calls[0].body.model, 'nomic');
    assert.equal(a.calls[0].body.items[0].metadata.keywords[0], 'tag');
});

test('#130 fallback on missing plugin route and cache capability, retaining provider params', async () => {
    const a = makeStandard([http(404, {}), http(200, {}), http(200, {})]);
    a.backend.pluginAvailable = true;
    await a.backend.insertVectorItems('abc', item, { source: 'ollama', ollama_model: 'nomic' });
    assert.deepEqual(a.calls.map(x => x.url), ['/api/plugins/similharity/chunks/insert', '/api/vector/insert']);
    assert.equal(a.calls[1].body.apiUrl, 'http://provider.local');
    assert.equal(a.calls[1].body.model, 'nomic');
    assert.equal(a.backend.pluginAvailable, true, 'Other plugin endpoints stay available');
    assert.equal(a.backend.pluginInsertUnavailable, true);
    await a.backend.insertVectorItems('abc', item, { source: 'ollama', ollama_model: 'nomic' });
    assert.equal(a.calls.at(-1).url, '/api/vector/insert');
    assert.equal(a.calls.length, 3);
});

for (const code of [405, 501]) {
    test(`#130 HTTP ${code} also means missing plugin insertion capability`, async () => {
        const a = makeStandard([http(code), http(200)]);
        a.backend.pluginAvailable = true;
        await a.backend.insertVectorItems('abc', item, { source: 'transformers' });
        assert.equal(a.calls.length, 2);
    });
}

for (const code of [401, 403, 500, 503]) {
    test(`#130 HTTP ${code} is a real failure, not a native fallback`, async () => {
        const a = makeStandard([http(code, { error: 'failed' })]);
        a.backend.pluginAvailable = true;
        await assert.rejects(a.backend.insertVectorItems('abc', item, { source: 'transformers' }), new RegExp(String(code)));
        assert.equal(a.calls.length, 1);
        assert.equal(a.backend.pluginInsertUnavailable, false);
    });
}

test('#130 plugin network and application errors do not trigger fallback', async () => {
    const network = makeStandard([new Error('connection down')]);
    network.backend.pluginAvailable = true;
    await assert.rejects(network.backend.insertVectorItems('abc', item, { source: 'ollama' }), /connection down/);
    assert.equal(network.calls.length, 1);

    const rejected = makeStandard([http(200, { success: false, error: 'bad vector' })]);
    rejected.backend.pluginAvailable = true;
    await assert.rejects(rejected.backend.insertVectorItems('abc', item, { source: 'ollama' }), /bad vector/);
    assert.equal(rejected.calls.length, 1);
});

test('#130 native fallback errors are reported, not swallowed', async () => {
    const a = makeStandard([http(404), http(500, { error: 'native down' })]);
    a.backend.pluginAvailable = true;
    await assert.rejects(a.backend.insertVectorItems('abc', item, { source: 'transformers' }), /500/);
    assert.equal(a.calls.length, 2);
});
