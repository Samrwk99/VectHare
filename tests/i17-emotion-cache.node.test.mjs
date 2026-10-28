/** I17/#238: classify-cache identity and invalidation regression tests. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import * as similarityImplementation from '../core/emotion-similarity.js';
import * as embeddingImplementation from '../core/emotion-embedding-provider.js';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../core/emotion-classifier.js');
const code = readFileSync(file, 'utf8');
const quiet = { log() {}, debug() {}, error() {}, warn() {} };

async function setup(handler = async (text) => ({label: text, score: 0.8})) {
    const settings = { vecthare: {
        emotion_classifier_enabled: true,
        emotion_classifier_model: 'model-one',
        emotion_use_similarity: false,
        emotion_custom_labels: [],
    }};
    const requests = [];
    const embeddingRequests = [];
    const fetch = async (_url, init) => {
        if (_url.endsWith('/batch-embeddings')) {
            const {texts}=JSON.parse(init.body); embeddingRequests.push([...texts]);
            return {ok:true,json:async()=>({success:true,embeddings:texts.map(()=>[1,0,0])})};
        }
        const body = JSON.parse(init.body);
        requests.push(body.text);
        const classified = await handler(body.text);
        if (classified === null) return { ok: false, status: 503 };
        return { ok: true, json: async () => ({classification: [{label: classified.label, score: classified.score}]}) };
    };
    const context = vm.createContext({
        console: quiet,
        fetch,
        window: {},
    });
    const script = new vm.SourceTextModule(code, {context, identifier: file});
    await script.link(async (specifier) => {
        if (specifier.endsWith('script.js')) {
            return new vm.SyntheticModule(['getRequestHeaders'], function () {
                this.setExport('getRequestHeaders', () => ({'Content-Type': 'application/json'}));
            }, {context});
        }
        if (specifier.endsWith('extensions.js')) {
            return new vm.SyntheticModule(['extension_settings'], function () {
                this.setExport('extension_settings', settings);
            }, {context});
        }
        if (specifier.endsWith('emotion-similarity.js') || specifier.endsWith('emotion-embedding-provider.js')) {
            const ns=specifier.endsWith('emotion-similarity.js')?similarityImplementation:embeddingImplementation;
            return new vm.SyntheticModule(Object.keys(ns),function(){for(const k of Object.keys(ns))this.setExport(k,ns[k]);},{context});
        }
        if (specifier.endsWith('feature-support.js')) {
            return new vm.SyntheticModule(['requireSupportedClassifierMode'],function(){this.setExport('requireSupportedClassifierMode',()=>{});},{context});
        }
        throw new Error(`Unmocked import ${specifier}`);
    });
    await script.evaluate();
    return {api: script.namespace, settings, requests, embeddingRequests, context};
}

test('#238: messages with equal first 100 chars use distinct classification calls and results', async () => {
    const {api, requests} = await setup();
    const prefix = 'X'.repeat(100);
    const first = `${prefix} delight`;
    const second = `${prefix} grief`;
    assert.equal((await api.classifyEmotion(first)).label, first);
    assert.equal((await api.classifyEmotion(second)).label, second);
    assert.deepEqual(requests, [first, second]);
    assert.equal((await api.classifyEmotion(first)).label, first);
    assert.equal(requests.length, 2, 'exactly identical input should be cached');
});

test('#238: full-text cache identity avoids ambiguous separators and short-text collisions', async () => {
    const {api, requests} = await setup();
    for (const text of ['x:y', 'x|y', 'x:y!', 'x|y!', '', '👍 hello', '👍 hello!']) {
        const result = await api.classifyEmotion(text);
        if (text) assert.equal(result.label, text);
        else assert.equal(result, null);
    }
    assert.deepEqual(requests, ['x:y', 'x|y', 'x:y!', 'x|y!', '👍 hello', '👍 hello!']);
});

test('#238/C14: model, mode and custom labels isolate cache and route through distinct endpoint', async () => {
    const {api, settings, requests, embeddingRequests} = await setup();
    await api.classifyEmotion('same');
    await api.classifyEmotion('same', {model:'model-two'});
    const sim=await api.classifyEmotion('same', {useEmbeddingSimilarity:true});
    assert.equal(sim.mode,'similarity');
    assert.equal(sim.label,'neutral', 'ties produce an explicit neutral fallback');
    await api.classifyEmotion('same',{customLabels:['joy']});
    assert.equal(requests.length,3,'similarity cannot silently call classify');
    assert.equal(embeddingRequests.length,2,'prototype and query embeddings sent');
    await api.classifyEmotion('same',{useEmbeddingSimilarity:true});
    assert.equal(embeddingRequests.length,2,'similarity cached independently');
    settings.vecthare.emotion_classifier_model='model-three';
    await api.classifyEmotion('same');
    settings.vecthare.emotion_custom_labels=['sadness'];
    await api.classifyEmotion('same');
    assert.equal(requests.length,5);
});

test('#238/C14: classifier setting changes invalidate caches and mode switches cannot reuse old response', async () => {
    const {api, requests, embeddingRequests} = await setup();
    assert.equal((await api.classifyEmotion('hello')).label,'hello');
    api.updateClassifierSetting('model','another-model');
    assert.equal((await api.classifyEmotion('hello')).label,'hello');
    api.updateClassifierSetting('useEmbeddingSimilarity',true);
    assert.equal((await api.classifyEmotion('hello')).mode,'similarity');
    assert.equal(embeddingRequests.length,2);
    api.updateClassifierSetting('customLabels',['sadness']);
    assert.equal((await api.classifyEmotion('hello')).mode,'similarity');
    assert.equal(embeddingRequests.length,4);
    api.updateClassifierSetting('enabled',false);
    assert.equal(await api.classifyEmotion('hello'),null);
    api.updateClassifierSetting('enabled',true);
    await api.classifyEmotion('hello');
    assert.equal(embeddingRequests.length,6);
    assert.equal(requests.length,2);
    api.clearClassifierCache();
    await api.classifyEmotion('hello');
    assert.equal(embeddingRequests.length,8);
});

test('#238: a pending request cannot refill a cache after settings change', async () => {
    let release;
    let calls = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const {api, requests} = await setup(async text => {
        calls++;
        if (calls === 1) await gate;
        return {label: `${text}-${calls}`, score: .9};
    });
    const old = api.classifyEmotion('hello');
    api.updateClassifierSetting('model', 'updated-model');
    release();
    await old;
    const fresh = await api.classifyEmotion('hello');
    assert.equal(fresh.label, 'hello-2');
    assert.equal(requests.length, 2);
    await api.classifyEmotion('hello');
    assert.equal(requests.length, 2);
});

test('#238: failures do not get cached as successful emotion results', async () => {
    let tries = 0;
    const {api, requests} = await setup(async text => {
        tries++;
        return tries === 1 ? null : {label: text, score: 0.7};
    });
    assert.equal(await api.classifyEmotion('recover'), null);
    assert.equal((await api.classifyEmotion('recover')).label, 'recover');
    assert.equal(requests.length, 2);
});

test('#238: cache remains bounded, evicting oldest entry at 100', async () => {
    const {api, requests} = await setup();
    for (let i = 0; i <= 100; i++) await api.classifyEmotion(`text-${i}`);
    assert.equal(requests.length, 101);
    await api.classifyEmotion('text-100');
    assert.equal(requests.length, 101);
    await api.classifyEmotion('text-0');
    assert.equal(requests.length, 102);
});
