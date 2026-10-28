/** I10 focused tests: prompt cleanup, real text validation, wrapping and WI tag isolation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const src = read('core/chat-vectorization.js');
const quiet = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
function functionBody(source, signature) {
    const start = source.indexOf(signature);
    assert.ok(start >= 0, `Missing function: ${signature}`);
    const brace = source.indexOf('{', start);
    let depth = 0;
    for (let i = brace; i < source.length; i++) {
        if (source[i] === '{') depth++;
        if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
        // Ignore braces inside template strings; main function extractor below uses a sentinel.
    }
    throw new Error(`Unclosed function: ${signature}`);
}
function extract(source, name, nextBoundary) {
    const start = source.indexOf(name);
    assert.ok(start >= 0, name);
    const end = source.indexOf(nextBoundary, start);
    assert.ok(end > start, nextBoundary);
    return source.slice(start, end);
}
const helpers = extract(src, 'function hasInjectableText(', '/**\n * Builds the nested prompt structure');
const nested = extract(src, 'function buildNestedInjectionText(', '/**\n * Resolves the effective injection position');
const resolve = extract(src, 'function resolveChunkInjectionPosition(', '/**\n * Stage 8: Format and inject');
const inject = extract(src, 'function injectChunksIntoPrompt(', '// ============================================================================\n// MAIN ORCHESTRATOR');
const rearrange = extract(src, 'export async function rearrangeChat(', '/**\n * Vectorizes entire chat');

function makeRuntime() {
    const extension_prompts = {};
    const calls = [];
    const settings = { position: 0, depth: 2, rag_context: 'GLOBAL CONTEXT', rag_xml_tag: 'memory' };
    const chunkMeta = new Map();
    const collectionMeta = new Map();
    const scope = {
        console: quiet, settings, extension_prompts,
        chatJobs: {startJob: () => ({assertCurrent(){},finish(){},signal:{aborted:false}})},
        StaleJobError: class StaleJobError extends Error {},
        F09B_PROMPT_TAG:'vecthare_f09b_verified_v2', EXTENSION_PROMPT_TAG: '3_vecthare', LEGACY_WORLD_INFO_PROMPT_TAG: 'vecthare_world_info',
        setExtensionPrompt: (tag, text, position, depth, scan) => {
            calls.push({ tag, text, position, depth, scan });
            extension_prompts[tag] = { value: text, position, depth };
        },
        getChunkMetadata: hash => chunkMeta.get(hash),
        getCollectionMeta: id => collectionMeta.get(id),
        substituteParams: x => x,
        recordChunkFate: () => {},
        promptReceipts:{invalidate(){}},
        makePromptSentinel:()=> '0123456789abcdef0123456789abcdef',
        wrapPromptBlock:(text,nonce,i)=>`<!-- VH:${nonce}:${i}:BEGIN -->\n${text}\n<!-- VH:${nonce}:${i}:END -->`,
        frequencyRecordKey:chunk=>String(chunk.recordId??chunk.hash),
        getCurrentChatId: () => null,
    };
    vm.createContext(scope);
    const implementation = [helpers, nested, resolve, inject, rearrange.replace('export async function', 'async function')].join('\n');
    vm.runInContext(implementation, scope);
    return { scope, settings, calls, extension_prompts, chunkMeta, collectionMeta,
        call: (expression) => vm.runInContext(expression, scope) };
}

test('#50 quiet generation clears existing prompts before early exit', async () => {
    const { scope, extension_prompts, calls } = makeRuntime();
    extension_prompts['3_vecthare'] = { value: 'STALE' };
    extension_prompts['3_vecthare_pos1'] = { value: 'STALE POSITION' };
    await scope.rearrangeChat([], { position: 0, depth: 2 }, 'quiet');
    assert.equal(extension_prompts['3_vecthare'].value, '');
    assert.equal(extension_prompts['3_vecthare_pos1'].value, '');
    assert.ok(calls.some(x => x.tag === '3_vecthare_pos1' && x.text === ''));
});

test('#64 cleanup includes all position tags, even >10', async () => {
    const { scope, extension_prompts } = makeRuntime();
    for (let i = 0; i < 25; i++) extension_prompts[`3_vecthare_pos${i}`] = { value: `old-${i}` };
    extension_prompts['3_vecthare_position_custom'] = { value: 'unrelated' };
    await scope.rearrangeChat([], {}, 'quiet');
    for (let i = 0; i < 25; i++) assert.equal(extension_prompts[`3_vecthare_pos${i}`].value, '');
    assert.equal(extension_prompts['3_vecthare_position_custom'].value, 'unrelated');
});

test('#50 no-chat early exit clears previous prompts', async () => {
    const { scope, extension_prompts } = makeRuntime();
    extension_prompts['3_vecthare_pos19'] = { value: 'stale' };
    await scope.rearrangeChat([], {}, 'normal');
    assert.equal(extension_prompts['3_vecthare_pos19'].value, '');
});

test('#181 missing and placeholder text is never injected', () => {
    const { scope, extension_prompts } = makeRuntime();
    const settings = { position: 0, depth: 2, rag_context: 'global' };
    const result = scope.injectChunksIntoPrompt([
        { hash: '1', collectionId: 'c', text: '(text not found)', score: 0.5 },
        { hash: '2', collectionId: 'c', text: '', score: 0.5 },
        { hash: '3', collectionId: 'c', text: '(text not available)', score: 0.5 },
        { hash: '4', collectionId: 'c', text: '  ', score: 0.5 },
        { hash: '5', collectionId: 'c', text: 'Real memory', score: 0.5 },
    ], settings, {});
    assert.equal(result.verified, true);
    assert.match(result.text, /Real memory/);
    assert.doesNotMatch(result.text, /text not found|text not available/i);
    assert.equal(extension_prompts['3_vecthare'].value, result.text);
});

test('#181 entirely invalid results leave no wrapper-only or stale prompt', () => {
    const { scope, extension_prompts } = makeRuntime();
    extension_prompts['3_vecthare'] = { value: 'stale memory' };
    const result = scope.injectChunksIntoPrompt([{ hash: '1', collectionId: 'c', text: '(text not found)' }], { rag_context: 'context', position: 0 }, {});
    assert.equal(result.verified, false);
    assert.equal(result.text, '');
    assert.equal(extension_prompts['3_vecthare'].value, '');
});

test('#65 global and collection wrappers are applied independently to each position', () => {
    const { scope, extension_prompts, chunkMeta, collectionMeta } = makeRuntime();
    chunkMeta.set('a', { position: 0, xmlTag: 'item' });
    chunkMeta.set('b', { position: 1, xmlTag: 'item' });
    collectionMeta.set('C', { context: 'COLLECTION CONTEXT', xmlTag: 'group' });
    const settings = { position: 0, depth: 2, rag_context: 'GLOBAL CONTEXT', rag_xml_tag: 'memories' };
    const result = scope.injectChunksIntoPrompt([
        { hash: 'a', collectionId: 'C', text: 'first' },
        { hash: 'b', collectionId: 'C', text: 'second' },
    ], settings, {});
    assert.equal(result.verified, true);
    for (const tag of ['3_vecthare_pos0', '3_vecthare_pos1']) {
        const value = extension_prompts[tag].value;
        assert.match(value, /<memories>\nGLOBAL CONTEXT/);
        assert.match(value, /COLLECTION CONTEXT/);
        assert.match(value, /<group>/);
        assert.match(value, /<item>/);
        assert.match(value, /<\/memories>/);
    }
    assert.match(extension_prompts['3_vecthare_pos0'].value, /first/);
    assert.doesNotMatch(extension_prompts['3_vecthare_pos0'].value, /second/);
    assert.match(extension_prompts['3_vecthare_pos1'].value, /second/);
});

test('#65 single-position wrapping remains unchanged', () => {
    const { scope, extension_prompts } = makeRuntime();
    const result = scope.injectChunksIntoPrompt([{ hash: 'x', collectionId: 'C', text: 'memory' }],
        { position: 0, depth: 2, rag_context: 'context', rag_xml_tag: 'root' }, {});
    assert.equal(result.verified, true);
    assert.match(extension_prompts['3_vecthare'].value, /<root>\ncontext/);
    assert.match(extension_prompts['3_vecthare'].value, /<\/root>/);
});

test('#29 dormant World Info path uses a separate tag; normal cleanup also clears it', async () => {
    const wi = read('core/world-info-integration.js');
    const helper = extract(wi, 'export async function applySemanticEntriesToPrompt(', '\n}').replace('export async function', 'async function') + '\n}';
    const calls = [];
    const scope = {
        console: quiet,
        LEGACY_WORLD_INFO_PROMPT_TAG: 'vecthare_world_info',
        getSemanticWorldInfoEntries: async () => [{ content: 'lore memory' }],
        setExtensionPrompt: (...args) => calls.push(args),
    };
    vm.createContext(scope);
    vm.runInContext(helper, scope);
    await scope.applySemanticEntriesToPrompt([{ mes: 'query' }], { enabled_world_info: true, position: 0, depth: 2 });
    assert.equal(calls[0][0], 'vecthare_world_info');
    assert.notEqual(calls[0][0], '3_vecthare');
    const run = makeRuntime();
    run.extension_prompts['vecthare_world_info'] = { value: 'old' };
    await run.scope.rearrangeChat([], {}, 'quiet');
    assert.equal(run.extension_prompts['vecthare_world_info'].value, '');
});

test('#181 missing-text rejection is recorded in the search pipeline for debugging', () => {
    assert.match(src, /recordChunkFate\(debugData, chunk\.hash, 'injection', 'skipped',\s*'Retrieved chunk has no available text'/);
    assert.match(src, /chunks = chunks\.filter\(hasInjectableText\)/);
});
