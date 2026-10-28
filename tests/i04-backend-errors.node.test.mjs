import {adapterCollectionId, rejectUnscopedPointOperation} from '../utils/tenant-route.js';
/** I04: real adapter methods against a fake fetch; no SillyTavern server required. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { mergeDefinedChunkMetadata, trustedQueryMetadata } from '../utils/chunk-record-metadata.js';
import { requireListedItems, requireQueryItems, hybridEndpointUnsupported } from '../utils/backend-response-validation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const silent = { log() {}, warn() {}, error() {}, debug() {} };
const settings = { source: 'transformers', vector_backend: 'standard', qdrant_multitenancy: false };
function response(status, payload, statusText = 'HTTP status') {
    return { status, statusText, ok: status >= 200 && status < 300,
        json: async () => payload, text: async () => JSON.stringify(payload ?? {}) };
}
function adapter(file, replies = []) {
    const src = source(`backends/${file}.js`)
        .replace(/^import .*?;\s*$/gm, '')
        .replace('export class ', 'class ');
    const calls = [];
    const context = vm.createContext({
        console: silent,
        VectorBackend: class {},
        getRequestHeaders: () => ({}),
        getModelField: () => null,
        getProviderSpecificParams: () => ({}),
        VECTOR_LIST_LIMIT: 100,
        requireListedItems, requireQueryItems, hybridEndpointUnsupported,
        mergeDefinedChunkMetadata, trustedQueryMetadata,
        adapterCollectionId, rejectUnscopedPointOperation, requireTenantScope: () => {}, hasVerifiedCapability: () => false,
        fetch: async (url, opts) => {
            calls.push({ url, opts });
            assert.ok(replies.length > 0, `No fake response for ${url}`);
            const next = replies.shift();
            if (next instanceof Error) throw next;
            return next;
        },
    });
    const className = { standard: 'StandardBackend', qdrant: 'QdrantBackend', milvus: 'MilvusBackend', lancedb: 'LanceDBBackend' }[file];
    const Class = vm.runInContext(`${src}\n${className}`, context, { timeout: 5000 });
    return { backend: new Class(), calls };
}

for (const file of ['qdrant', 'lancedb', 'milvus']) {
    test(`I04 #222: ${file} list rejects HTTP 200 application failure, malformed, and missing items`, async () => {
        for (const payload of [{ success: false, items: [] }, { foo: [] }, { items: null }, { error: 'database offline', items: [] }]) {
            const { backend } = adapter(file, [response(200, payload)]);
            await assert.rejects(backend.getSavedHashes('abc', settings), /invalid or unsuccessful/);
        }
    });
    test(`I04 #222: ${file} list accepts explicit empty list and valid hashes`, async () => {
        let h = adapter(file, [response(200, { success: true, items: [] })]);
        assert.deepEqual(await h.backend.getSavedHashes('abc', settings), []);
        h = adapter(file, [response(200, { items: [{ hash: 55 }, { hash: 99 }] })]);
        assert.deepEqual(Array.from(await h.backend.getSavedHashes('abc', settings)), [55, 99]);
    });
}

for (const file of ['lancedb', 'milvus']) {
    test(`I04 #78: ${file} mixed multi-collection query preserves failure metadata`, async () => {
        const { backend } = adapter(file, [response(200, { results: [{ hash: 9, score: 0.8, text: 'good' }] }), response(503, {})]);
        const result = await backend.queryMultipleCollections(['A', 'B'], 'test', 5, 0, settings);
        assert.deepEqual(Array.from(result.A.hashes), [9]);
        assert.deepEqual(Array.from(result.B.hashes), []);
        assert.match(result.B.error, /503/);
    });
    test(`I04 #78: ${file} transport and application-level query failure are distinct from empty`, async () => {
        const { backend } = adapter(file, [response(200, { success: false, results: [] }), new Error('connection refused')]);
        const result = await backend.queryMultipleCollections(['A', 'B'], 'test', 5, 0, settings);
        assert.match(result.A.error, /unsuccessful/);
        assert.match(result.B.error, /connection refused/);
    });
}

test('I04 #66: Standard list propagates HTTP 500 and malformed 200', async () => {
    let a = adapter('standard', [response(500, { error: 'disk failure' })]);
    await assert.rejects(a.backend.getSavedHashes('A', settings), /500/);
    a = adapter('standard', [response(200, { error: 'not an array' })]);
    await assert.rejects(a.backend.getSavedHashes('A', settings), /expected an array/);
    a = adapter('standard', [response(200, [])]);
    assert.deepEqual(await a.backend.getSavedHashes('A', settings), []);
});

test('I04 #223: Standard health is false for HTTP 500 or network failures', async () => {
    assert.equal(await adapter('standard', [response(500)]).backend.healthCheck(), false);
    assert.equal(await adapter('standard', [new Error('offline')]).backend.healthCheck(), false);
    assert.equal(await adapter('standard', [response(200, [])]).backend.healthCheck(), true);
});

test('I04 #67: Standard rejected plugin init remains native-only', async () => {
    const a = adapter('standard', [response(200, {}), response(503, {})]);
    await a.backend.initialize(settings);
    assert.equal(a.backend.pluginAvailable, false);
    assert.equal(a.calls.length, 2);
    const b = adapter('standard', [response(200, {}), response(200, {})]);
    await b.backend.initialize(settings);
    assert.equal(b.backend.pluginAvailable, true);
});

for (const file of ['qdrant', 'milvus']) {
    test(`I04 hybrid ${file}: fallback on unsupported endpoint only`, async () => {
        const a = adapter(file, [response(404), response(200, { results: [] })]);
        const result = await a.backend.hybridQuery('abc', 'hello', 5, settings);
        assert.equal(result.hashes.length, 0);
        assert.equal(a.calls.length, 2);
        const b = adapter(file, [response(503)]);
        await assert.rejects(b.backend.hybridQuery('abc', 'hello', 5, settings), /HTTP 503/);
        assert.equal(b.calls.length, 1);
        const c = adapter(file, [new Error('connection broke')]);
        await assert.rejects(c.backend.hybridQuery('abc', 'hello', 5, settings), /connection broke/);
        const d = adapter(file, [response(200, { success: false, results: [] })]);
        await assert.rejects(d.backend.hybridQuery('abc', 'hello', 5, settings), /unsuccessful/);
    });
}

function extractFunction(file, name) {
    const src = source(file);
    const start = src.indexOf(`async function ${name}(`);
    assert.ok(start >= 0);
    const end = src.indexOf('\n}\n', start);
    assert.ok(end > start);
    return src.slice(start, end + 2);
}

test('I04 #109: all failed searches surface an error instead of empty success', async () => {
    const context = vm.createContext({
        console: silent,
        getStringHash: () => 1,
        getTextWithoutAttachments: m => m.mes,
        overfetchSize: k => Math.min(k*3,200),
        queryCollection: async () => { throw new Error('backend offline'); },
        toastr: { warning() {} },
        addTrace() {},
    });
    const fn = vm.runInContext(`${extractFunction('core/chat-vectorization.js', 'queryAndMergeCollections')}\nqueryAndMergeCollections`, context);
    const debug = {};
    await assert.rejects(fn(['A', 'B'], 'query', { top_k: 5 }, [], debug), /All 2 collection queries failed/);
    assert.equal(debug.queryFailures.length, 2);
});

test('I04 #109: partial search failure retains healthy results and warns', async () => {
    const warnings = [];
    const context = vm.createContext({
        console: silent,
        getStringHash: () => 1,
        getTextWithoutAttachments: m => m.mes,
        overfetchSize: k => Math.min(k*3,200),
        queryCollection: async id => {
            if (id === 'B') throw new Error('backend offline');
            return { hashes: [1], metadata: [{ text: 'hello', score: 0.8 }] };
        },
        toastr: { warning: message => warnings.push(message) },
        addTrace() {}, recordChunkFate() {},
    });
    const fn = vm.runInContext(`${extractFunction('core/chat-vectorization.js', 'queryAndMergeCollections')}\nqueryAndMergeCollections`, context);
    const debug = {};
    const result = await fn(['A', 'B'], 'query', { top_k: 5 }, [], debug);
    assert.equal(result.length, 1);
    assert.equal(debug.queryFailures.length, 1);
    assert.equal(warnings.length, 1);
});

test('I04 #105: manual vectorization with a failed insert ends incomplete, not successful', async () => {
    const src = source('core/chat-vectorization.js');
    const start = src.indexOf('export async function vectorizeAll(settings, batchSize) {');
    const end = src.indexOf('\n}\n', start);
    assert.ok(start >= 0 && end > start);
    const completions = [], notifications = [];
    const responses = [
        { remaining: 1, messagesProcessed: 1, chunksCreated: 0, itemsFailed: 1, total: 2 },
        { remaining: 0, messagesProcessed: 1, chunksCreated: 1, itemsFailed: 0, total: 2 },
    ];
    const context = vm.createContext({
        console: silent,
        chatJobs: {startJob: () => ({assertCurrent(){},finish(){},signal:{aborted:false}})},
        StaleJobError: class StaleJobError extends Error {},
        tryAcquireVectorizationRun: () => true,
        getCurrentChatId: () => 'chat-A',
        getContext: () => ({ chat: [{ mes: 'one' }, { mes: 'two' }] }),
        isBackendAvailable: async () => true,
        getChatCollectionId: () => null,
        progressTracker: {
            show() {}, hide() {}, setControls() {}, updateEmbeddingProgress() {},
            updateProgress() {}, updateChunks() {}, addError() {},
            complete: (...args) => completions.push(args),
        },
        resetControlState() {},
        isVectorizationStopped: () => false,
        isVectorizationPaused: () => false,
        synchronizeChat: async () => responses.shift(),
        toastr: {
            info: (...args) => notifications.push(['info', ...args]),
            error: (...args) => notifications.push(['error', ...args]),
            warning: (...args) => notifications.push(['warning', ...args]),
            success: (...args) => notifications.push(['success', ...args]),
        },
        is_send_press: false,
    });
    const fn = vm.runInContext(`let vectorizeRunActive = true;\n${src.slice(start, end+2).replace('export async function','async function')}\nvectorizeAll`, context);
    assert.equal(await fn({ vector_backend: 'standard', chunking_strategy: 'per_message' }, 2), false);
    assert.equal(responses.length, 0);
    assert.equal(completions.at(-1)[0], false);
    assert.match(completions.at(-1)[1], /1 item\(s\) failed/);
    assert.ok(!notifications.some(([name]) => name === 'success'));
    assert.ok(notifications.some(([name]) => name === 'warning'));
});

test('I04 #105: manual vectorization with fully successful batches reports success', async () => {
    const src = source('core/chat-vectorization.js');
    const start = src.indexOf('export async function vectorizeAll(settings, batchSize) {');
    const end = src.indexOf('\n}\n', start);
    const completions = [], notifications = [];
    const context = vm.createContext({
        console: silent,
        chatJobs: {startJob: () => ({assertCurrent(){},finish(){},signal:{aborted:false}})},
        StaleJobError: class StaleJobError extends Error {},
        tryAcquireVectorizationRun: () => true, getCurrentChatId: () => 'chat-A',
        getContext: () => ({ chat: [{ mes: 'one' }] }), isBackendAvailable: async () => true,
        getChatCollectionId: () => null,
        progressTracker: {
            show() {}, hide() {}, setControls() {}, updateEmbeddingProgress() {},
            updateProgress() {}, updateChunks() {}, addError() {},
            complete: (...args) => completions.push(args),
        },
        resetControlState() {}, isVectorizationStopped: () => false,
        isVectorizationPaused: () => false, is_send_press: false,
        synchronizeChat: async () => ({ remaining: 0, messagesProcessed: 1, chunksCreated: 1, itemsFailed: 0, total: 1 }),
        toastr: {
            info() {}, error() {}, warning() {},
            success: message => notifications.push(message),
        },
    });
    const fn = vm.runInContext(`let vectorizeRunActive = true;\n${src.slice(start, end+2).replace('export async function','async function')}\nvectorizeAll`, context);
    assert.equal(await fn({ vector_backend: 'standard', chunking_strategy: 'per_message' }, 1), true);
    assert.equal(completions.at(-1)[0], true);
    assert.equal(notifications.length, 1);
});
