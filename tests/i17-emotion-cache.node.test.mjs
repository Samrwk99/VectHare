/** I17/#238: classify-cache identity and invalidation regression tests. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

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
    const fetch = async (_url, init) => {
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
        throw new Error(`Unmocked import ${specifier}`);
    });
    await script.evaluate();
    return {api: script.namespace, settings, requests, context};
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

test('#238: model, mode and custom labels distinguish otherwise identical text', async () => {
    const {api, settings, requests} = await setup();
    await api.classifyEmotion('same');
    await api.classifyEmotion('same', {model: 'model-two'});
    await api.classifyEmotion('same', {useEmbeddingSimilarity: true});
    await api.classifyEmotion('same', {customLabels: ['joy']});
    assert.equal(requests.length, 4);
    await api.classifyEmotion('same', {model: 'model-two'});
    assert.equal(requests.length, 4);
    // Catch out-of-band changes (some older settings paths write directly).
    settings.vecthare.emotion_classifier_model = 'model-three';
    await api.classifyEmotion('same');
    settings.vecthare.emotion_use_similarity = true;
    await api.classifyEmotion('same');
    settings.vecthare.emotion_custom_labels = ['joy'];
    await api.classifyEmotion('same');
    assert.equal(requests.length, 7);
});

test('#238: changing any classifier setting invalidates cached classifications', async () => {
    const {api, requests} = await setup();
    const changes = [
        ['model', 'another-model'],
        ['useEmbeddingSimilarity', true],
        ['customLabels', ['sadness']],
        ['enabled', false],
        ['enabled', true],
    ];
    await api.classifyEmotion('hello');
    for (const [key, value] of changes) {
        api.updateClassifierSetting(key, value);
        const result = await api.classifyEmotion('hello');
        if (key === 'enabled' && !value) assert.equal(result, null);
        else assert.equal(result.label, 'hello');
    }
    assert.equal(requests.length, 5);
    await api.classifyEmotion('hello');
    assert.equal(requests.length, 5);
    api.clearClassifierCache();
    await api.classifyEmotion('hello');
    assert.equal(requests.length, 6);
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
