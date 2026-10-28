/** Focused I02 regression tests; no SillyTavern server or node_modules needed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { clearBananaBreadKey } from '../utils/credential-controls.js';
import { mergeDefinedChunkMetadata, trustedQueryMetadata } from '../utils/chunk-record-metadata.js';
import {sharedTenantFromCollection,markSharedDisplayPage,denyUnverifiedSharedInventory,labelSharedQuery} from '../utils/e06-shared-read-contract.js';
import { requireListedItems, requireQueryItems, hybridEndpointUnsupported } from '../utils/backend-response-validation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
function actualFunction(file, name) {
    const code = source(file);
    const start = code.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `Missing ${name} in ${file}`);
    const end = code.indexOf('\n}\n', start);
    assert.ok(end > start, `Missing function end for ${name}`);
    return code.substring(start, end + 2);
}
function evaluateFunctions(file, names, globals = {}) {
    const code = names.map(name => actualFunction(file, name)).join('\n');
    const context = vm.createContext({ ...globals });
    const namesAsObject = names.join(', ');
    return vm.runInContext(`${code}\n({ ${namesAsObject} })`, context);
}
const hostile = 'x" onmouseover="alert(1)\'><img src=x onerror=alert(1)>';

test('I02 #41/#180/#194: HTML escapers protect text and attribute quotes', () => {
    for (const file of ['ui/database-browser.js', 'ui/search-debug.js', 'ui/chunk-visualizer.js']) {
        const { escapeHtml } = evaluateFunctions(file, ['escapeHtml']);
        const escaped = escapeHtml(hostile);
        assert.ok(escaped.includes('&quot;'), file);
        assert.ok(escaped.includes('&#39;'), file);
        assert.ok(escaped.includes('&lt;img'), file);
        assert.ok(!escaped.includes('<img'), file);
        assert.equal(escapeHtml(0), '0');
    }
});

test('I02 #41: real collection-card renderer escapes names, model, IDs and data attributes', () => {
    const icons = new Proxy({}, { get: () => () => '<svg></svg>' });
    const { renderCollectionCard } = evaluateFunctions('ui/database-browser.js', ['escapeHtml', 'renderCollectionCard'], {
        icons,
        getCollectionActivationSummary: () => ({ mode: 'auto', triggerCount: 0 }),
        getCollectionDecaySummary: () => ({ enabled: true, description: hostile }),
        getCollectionLockCount: () => 0,
    });
    const output = renderCollectionCard({
        id: hostile, registryKey: hostile, name: hostile, model: hostile, models: [hostile, 'other'],
        enabled: true, type: 'chat', scope: 'chat', backend: hostile, source: hostile, chunkCount: 1,
    });
    assert.ok(!output.includes('<img'), 'Raw injected image must not appear');
    assert.ok(!output.includes('onmouseover="alert(1)'), 'Injected attribute must not be activated');
    assert.ok(output.includes('&lt;img'), 'Name/attribute must remain readable as escaped text');
    assert.ok(output.includes('&quot;'), 'Quotes must not close attributes');
});

test('I02 #194: plaintext keyword editor keeps imported HTML inside the textarea', () => {
    let markup = '';
    const panel = { html(value) { markup = value; } };
    const { renderDetailPanel } = evaluateFunctions('ui/chunk-visualizer.js', ['escapeHtml', 'renderDetailPanel'], {
        $: () => panel,
        selectedChunkId: 'chunk-1',
        allChunksMap: new Map([['chunk-1', { data: { text: 'example', name: 'test', keywords: [{ text: hostile, weight: 1 }] } }]]),
        filteredChunksMap: new Map([['chunk-1', 0]]),
        plaintextKeywordMode: true,
        bindDetailEvents: () => {},
        console,
    });
    renderDetailPanel();
    assert.ok(markup.includes('vecthare_keywords_plaintext'));
    assert.ok(markup.includes('&lt;img'), 'The textarea must show escaped text');
    assert.ok(!markup.includes('</textarea><img'), 'A hostile keyword must not close the textarea');
});

test('I02 #180: debugger escapes hostile collection IDs, keyword badges, scores and expanded metadata', () => {
    const { escapeHtml, getScoreClass, buildScoreBreakdown, renderStageChunks } = evaluateFunctions(
        'ui/search-debug.js',
        ['escapeHtml', 'getScoreClass', 'buildScoreBreakdown', 'renderStageChunks'],
        { getExclusionStatus: () => null },
    );
    const chunk = {
        hash: hostile, index: 5, text: 'safe', collectionId: hostile,
        metadata: { keywords: [hostile] }, matchedQueryKeywords: [hostile],
        matchedKeywordsWithWeights: [{ text: hostile, weight: 2 }],
        score: 0.7, originalScore: 0.5, keywordBoost: 1.4,
    };
    const html = renderStageChunks([chunk], 'initial', { settings: {}, stages: {} });
    assert.ok(html.includes('&lt;img'), 'Hostile values should be safely displayed');
    assert.ok(html.includes('&quot;'), 'Hostile attribute quotes must be encoded');
    assert.ok(!html.includes('<img'), 'No interpreted markup from imported metadata');
    assert.ok(!html.includes('onmouseover="alert(1)'), 'No attribute breakout');
});

test('I02 #131: clear requires protected server revocation, state proof and durable save', async () => {
    const settings = { bananabread_api_key: 'should-not-remain' };
    let commitCount = 0;
    const contract={protocol:'vecthare-user-scoped-secrets-v1',userScope:'request-user',writeOnlyBrowser:true,
        serverSideResolution:true,authenticatedProbe:true,
        supportedKeys:['vecthare_qdrant_api_key','vecthare_milvus_password','vecthare_milvus_token','bananabread_api_key']};
    await clearBananaBreadKey(settings, async (url, request) => {
        if (url.endsWith('/capabilities/secrets')) return {ok:true,json:async()=>contract};
        if (url==='/api/secrets/read') return {ok:true,json:async()=>({bananabread_api_key:false})};
        assert.equal(url, '/api/secrets/write');
        assert.deepEqual(JSON.parse(request.body), { key: 'bananabread_api_key', value: '' });
        return { ok: true, text: async () => 'ok' };
    }, { 'Content-Type': 'application/json' }, snapshot => {
        commitCount++;
        assert.equal(snapshot.bananabread_api_key, undefined);
        return true;
    });
    assert.equal(settings.bananabread_api_key, undefined);
    assert.equal(commitCount, 1);
});

test('I02 #131: rejection, missing proof or unacknowledged persistence preserves legacy copy', async () => {
    const contract={protocol:'vecthare-user-scoped-secrets-v1',userScope:'request-user',writeOnlyBrowser:true,
        serverSideResolution:true,authenticatedProbe:true,
        supportedKeys:['vecthare_qdrant_api_key','vecthare_milvus_password','vecthare_milvus_token','bananabread_api_key']};
    for (const fail of ['missing-plugin','bad-write','still-set','unacknowledged-save']) {
        const settings={bananabread_api_key:'retain-this-key'};
        let commits=0;
        const fetchImpl=async url=>{
            if (url.endsWith('/capabilities/secrets')) return {ok:fail!=='missing-plugin',json:async()=>contract};
            if (url==='/api/secrets/write') return {ok:true,text:async()=>fail==='bad-write'?'error':'ok'};
            if (url==='/api/secrets/read') return {ok:true,json:async()=>({bananabread_api_key:fail==='still-set'})};
            throw new Error('Unknown endpoint');
        };
        await assert.rejects(clearBananaBreadKey(settings,fetchImpl,{},()=>{commits++;return false;}));
        assert.equal(settings.bananabread_api_key,'retain-this-key');
        if (fail!=='unacknowledged-save') assert.equal(commits,0);
    }
});

async function qdrantWithMock(fetchImpl) {
    const messages = [];
    const logger = Object.fromEntries(['log','error','warn','debug'].map(level => [level, (...args) => messages.push(args.map(String).join(' '))]));
    const context = vm.createContext({ fetch: fetchImpl, console: logger, setTimeout, clearTimeout });
    const exports = {
        '../utils/e02-vector-request-gateway.js':{guardedVectorFetch:(...args)=>context.fetch(...args)},
        '../../../../../script.js': { getRequestHeaders: () => ({}) },
        './backend-interface.js': { VectorBackend: class {} },
        '../core/providers.js': { getModelField: () => null },
        './provider-params.js': { getProviderSpecificParams: () => ({}) },
        '../core/constants.js': { VECTOR_LIST_LIMIT: 10000 },
        '../utils/backend-response-validation.js': { requireListedItems, requireQueryItems, hybridEndpointUnsupported },
        '../utils/chunk-record-metadata.js': { mergeDefinedChunkMetadata, trustedQueryMetadata },
        '../utils/e06-shared-read-contract.js': {sharedTenantFromCollection,markSharedDisplayPage,denyUnverifiedSharedInventory,labelSharedQuery},
        '../utils/c05-protected-credentials.js': { verifyServerSecretContract: async () => ({ verified: true }), ProtectedCredentialUnavailable: class extends Error {}, assertNoCredentialsInUrl: () => {} },
    };
    const mod = new vm.SourceTextModule(source('backends/qdrant.js'), { context });
    await mod.link(spec => {
        const values = exports[spec];
        if (spec === '../utils/tenant-route.js') {
            return new vm.SyntheticModule(['adapterCollectionId','requireTenantScope','rejectUnscopedPointOperation'], function() {
                this.setExport('adapterCollectionId',(id)=>id);this.setExport('requireTenantScope',()=>{});
                this.setExport('rejectUnscopedPointOperation',()=>{});
            },{context});
        }
        if (spec === '../utils/backend-contracts.js') {
            return new vm.SyntheticModule(['hasVerifiedCapability'],function(){this.setExport('hasVerifiedCapability',()=>false);},{context});
        }
        if (!values) throw new Error(`Unexpected Qdrant dependency ${spec}`);
        return new vm.SyntheticModule(Object.keys(values), function () {
            for (const [name, value] of Object.entries(values)) this.setExport(name, value);
        }, { context });
    });
    await mod.evaluate();
    return { Backend: mod.namespace.QdrantBackend, messages };
}

test('I02 #48: Qdrant initializes without logging API key or echoed server secret', async () => {
    const secret = 'qdrant-secret-sentinel';
    const { Backend, messages } = await qdrantWithMock(async (url, options) => {
        assert.equal(Object.hasOwn(JSON.parse(options.body), 'apiKey'), false, 'Browser must not send credentials');
        return { ok: true, json: async () => ({ apiKey: secret }) };
    });
    await new Backend().initialize({ qdrant_use_cloud: true, qdrant_url: 'https://server.example' });
    assert.ok(!messages.join('\n').includes(secret));
});

test('I02 #48: Qdrant init errors never echo backend response body or credentials', async () => {
    const secret = 'qdrant-secret-sentinel';
    const { Backend, messages } = await qdrantWithMock(async () => ({
        ok: false, status: 500, text: async () => `Auth error: ${secret}`,
    }));
    await assert.rejects(new Backend().initialize({ qdrant_use_cloud: true }), error => {
        assert.ok(!error.message.includes(secret));
        assert.match(error.message, /HTTP 500/);
        return true;
    });
    assert.ok(!messages.join('\n').includes(secret));
});

test('I02 #69: chat logs no longer interpolate query keywords, raw chunks, or prompt previews', () => {
    const code = source('core/chat-vectorization.js');
    assert.ok(!code.includes('console.debug(`  Text: "${chunk.text'));
    assert.ok(!code.includes('console.debug(`  Chunk text: "${chunk.text'));
    assert.ok(!code.includes('console.log(`      Text preview:'));
    assert.ok(!code.includes('console.log(`[VectHare Injection Control] Injection text preview:'));
    assert.ok(!code.includes('valuePreview: verifiedPrompt'));
    assert.ok(!code.includes('console.log(`VectHare: Extracted ${queryKeywords.length} keywords from query:`, queryKeywordTexts)'));
    assert.ok(!code.includes('text: "${String(item.text).substring'));
    const debugCode = source('ui/search-debug.js');
    assert.ok(!debugCode.includes('query: data.query?.substring(0, 50)'));
});
