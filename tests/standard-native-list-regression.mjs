/**
 * Standard native /api/vector/list error handling regression.
 * Run: node --experimental-vm-modules tests/standard-native-list-regression.mjs
 * Doesn't depend on Vitest or a live SillyTavern server.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'backends/standard.js'), 'utf8');
const loaderSource = fs.readFileSync(path.join(root, 'core/collection-loader.js'), 'utf8');
let count = 0;

function response(status, data) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 500 ? 'Internal Server Error' : status === 403 ? 'Forbidden' : 'OK',
        json: async () => data,
        text: async () => String(data),
    };
}

async function createBackend(fetchImpl) {
    const extension_settings = { vecthare: { nativeStandardChunks: {} } };
    const context = vm.createContext({ fetch: fetchImpl, JSON, console: { log() {}, warn() {}, error() {} } });
    const module = new vm.SourceTextModule(source, { context, identifier: 'backends/standard.js' });
    const imports = {
        'script.js': { getRequestHeaders: () => ({ 'Content-Type': 'application/json' }), saveSettingsDebounced() {} },
        'extensions.js': { extension_settings },
        'backend-interface.js': { VectorBackend: class {} },
        'providers.js': { getModelField: () => 'embedding_model' },
        'provider-params.js': { getProviderSpecificParams: () => ({}) },
        'constants.js': { VECTOR_LIST_LIMIT: 10000 },
    };
    await module.link(spec => {
        const dependency = imports[path.basename(spec)];
        if (!dependency) throw Error(`Unmocked dependency: ${spec}`);
        return new vm.SyntheticModule(Object.keys(dependency), function () {
            for (const [key, value] of Object.entries(dependency)) this.setExport(key, value);
        }, { context });
    });
    await module.evaluate();
    const backend = new module.namespace.StandardBackend();
    const settings = { source: 'llamacpp', embedding_model: 'embedding-GGUF' };
    return { backend, settings, extension_settings };
}

async function check(label, fn) {
    await fn();
    console.log(`PASS ${label}`);
    count++;
}

await check('Native 200 with empty list is genuinely empty', async () => {
    const { backend, settings } = await createBackend(async () => response(200, []));
    assert.deepEqual(Array.from(await backend.getSavedHashes('chat-1', settings)), []);
    assert.equal((await backend.listChunks('chat-1', settings)).total, 0);
    assert.equal((await backend.getStats('chat-1', settings)).count, 0);
    assert.equal(await backend.healthCheck(), true);
});

await check('Native 200 preserves existing hashes', async () => {
    const { backend, settings } = await createBackend(async () => response(200, [123, 456]));
    assert.deepEqual(Array.from(await backend.getSavedHashes('chat-1', settings)), [123, 456]);
    assert.equal((await backend.listChunks('chat-1', settings)).total, 2);
    assert.equal((await backend.getStats('chat-1', settings)).count, 2);
});

await check('HTTP 500 cannot masquerade as empty collection for list, stats or getChunk', async () => {
    let calls = 0;
    const { backend, settings, extension_settings } = await createBackend(async () => { calls++; return response(500, 'backend failed'); });
    await assert.rejects(backend.getSavedHashes('chat-1', settings), /chat-1: HTTP 500/);
    await assert.rejects(backend.listChunks('chat-1', settings), /HTTP 500/);
    await assert.rejects(backend.getStats('chat-1', settings), /HTTP 500/);
    await assert.rejects(backend.getChunk('chat-1', 1, settings), /HTTP 500/);
    assert.equal(await backend.healthCheck(), false);
    assert.equal(calls, 5);
    assert.deepEqual(Object.keys(extension_settings.vecthare.nativeStandardChunks), []);
});

await check('HTTP 403 also rejects list and marks unhealthy', async () => {
    const { backend, settings } = await createBackend(async () => response(403, 'forbidden'));
    await assert.rejects(backend.getSavedHashes('chat-1', settings), /HTTP 403/);
    assert.equal(await backend.healthCheck(), false);
});

await check('Invalid JSON shape on HTTP 200 is not treated as empty', async () => {
    const { backend, settings } = await createBackend(async () => response(200, { hashes: [] }));
    await assert.rejects(backend.getSavedHashes('chat-1', settings), /expected an array/);
    await assert.rejects(backend.listChunks('chat-1', settings), /expected an array/);
    assert.equal(await backend.healthCheck(), false);
});

await check('JSON decoding failure on HTTP 200 propagates', async () => {
    const { backend, settings } = await createBackend(async () => ({
        ok: true, status: 200, json: async () => { throw new SyntaxError('bad JSON'); },
    }));
    await assert.rejects(backend.getSavedHashes('chat-1', settings), /bad JSON/);
    assert.equal(await backend.healthCheck(), false);
});

await check('Network failure never becomes zero hashes', async () => {
    const { backend, settings } = await createBackend(async () => { throw new Error('connection lost'); });
    await assert.rejects(backend.getSavedHashes('chat-1', settings), /connection lost/);
    assert.equal(await backend.healthCheck(), false);
});

await check('Fallback collection probing propagates native HTTP 500 instead of marking absent', async () => {
    const begin = loaderSource.indexOf('async function probeCollection(');
    const end = loaderSource.indexOf('/**\n * Discovers existing collections by probing', begin);
    assert.ok(begin >= 0 && end > begin);
    const block = loaderSource.slice(begin, end);
    const probe = vm.runInNewContext(`${block}; probeCollection`, {
        getSavedHashes: async () => { throw new Error('[Standard] HTTP 500 Internal Server Error'); },
        Error,
    });
    await assert.rejects(probe('chat-1', { vector_backend: 'standard' }), /Failed to probe collection chat-1:.*500/);
});

await check('Chat-discovery direct fallback does not swallow native 500', async () => {
    const begin = loaderSource.indexOf('export async function doesChatHaveVectors(');
    const end = loaderSource.indexOf('/**\n * Loads all collections with metadata', begin);
    assert.ok(begin >= 0 && end > begin);
    const block = loaderSource.slice(begin, end).replace(/^export /, '');
    const probe = vm.runInNewContext(`${block}; doesChatHaveVectors`, {
        discoverExistingCollections: async () => {},
        getCollectionRegistry: () => [],
        getChatUUID: () => 'uuid-1',
        getContext: () => ({ chatId: 'filename-1' }),
        getChatBinding: () => null,
        getChatCollectionId: () => 'chat-1',
        getLegacyChatCollectionId: () => 'legacy-1',
        getSavedHashes: async () => { throw new Error('[Standard] HTTP 500 Internal Server Error'); },
        console: { log() {} }, Error,
    });
    await assert.rejects(probe({ vector_backend: 'standard' }), /Unable to determine whether chat collection chat-1.*500/);
});

console.log(`\n${count} Standard native list regression checks passed`);
