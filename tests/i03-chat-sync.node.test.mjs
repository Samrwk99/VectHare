/** I03 regressions: extracted real handlers + per-collection cooldown utility. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createReverseSyncThrottle } from '../utils/reverse-sync-throttle.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

function resumeHarness() {
    const src = source('index.js');
    const start = src.indexOf('async function offerResumeOfUnfinishedVectorization() {');
    const end = src.indexOf('\n}\n', start);
    assert.ok(start >= 0 && end > start);
    const pending = [];
    const calls = [];
    let chat = 'A';
    const context = vm.createContext({
        console: { log() {}, debug() {}, warn() {} },
        RESUME_CHECK_MAX_ATTEMPTS: 1,
        RESUME_CHECK_RETRY_MS: 0,
        isVectorizationActive: () => false,
        getChatCollectionId: () => chat,
        currentChatIdentity: () => ({chatId:chat}),
        checkUnfinishedVectorization: () => {
            const d = deferred(); pending.push({ chat, ...d }); return d.promise;
        },
        settings: {},
        updateContinueVectorizationButton: (...args) => calls.push(['button', chat, ...args]),
        refreshVectorizationStatusDisplay: result => calls.push(['status', chat, result?.total]),
        progressTracker: { isDatabaseSnapshot: false },
        consumeWasLastRunStoppedByUser: () => true,
        showResumeToast: () => calls.push(['toast']),
        getCollectionRegistry: () => [],
        parseRegistryKey: x => ({ collectionId: x }),
        setTimeout,
    });
    vm.runInContext(`let resumeCheckRequestId = 0;\n${src.slice(start, end + 2)}\nthis.resume = offerResumeOfUnfinishedVectorization;`, context);
    return { context, pending, calls, changeChat: value => { chat = value; } };
}

test('I03 #25: old chat resume result cannot overwrite newly selected chat UI', async () => {
    const h = resumeHarness();
    const a = h.context.resume();
    assert.equal(h.pending.length, 1);
    h.changeChat('B');
    const b = h.context.resume();
    assert.equal(h.pending.length, 2);
    h.pending[1].resolve({ hasBacklog: false, pending: 0, total: 9 });
    await b;
    h.pending[0].resolve({ hasBacklog: true, pending: 2, total: 5 });
    await a;
    assert.equal(h.calls.filter(x => x[0] === 'button').length, 1);
    assert.deepEqual(h.calls.filter(x => x[0] === 'button')[0], ['button', 'B', 'available', 0, 9]);
    assert.ok(!h.calls.some(x => x[0] === 'status' && x[2] === 5));
});

test('I03 #25: newer same-chat refresh supersedes an older reply', async () => {
    const h = resumeHarness();
    const old = h.context.resume();
    const latest = h.context.resume();
    h.pending[1].resolve({ hasBacklog: false, pending: 0, total: 12 });
    await latest;
    h.pending[0].resolve({ hasBacklog: true, pending: 8, total: 10 });
    await old;
    assert.equal(h.calls.filter(x => x[0] === 'button').length, 1);
    assert.equal(h.calls.find(x => x[0] === 'status')[2], 12);
});

test('I03 #43: successful cooldown on chat A does not throttle chat B', () => {
    let time = 1000;
    const throttle = createReverseSyncThrottle(300000, () => time);
    assert.ok(throttle.shouldRun('A'));
    throttle.markSuccessful('A');
    assert.equal(throttle.shouldRun('A'), false);
    assert.equal(throttle.shouldRun('B'), true);
    throttle.markSuccessful('B');
    time += 299999;
    assert.equal(throttle.shouldRun('A'), false);
    time++;
    assert.equal(throttle.shouldRun('A'), true);
    assert.equal(throttle.shouldRun('B'), true);
});

test('I03 #114: failed/skipped cleanup never starts cooldown, forced passes remain retryable', () => {
    const throttle = createReverseSyncThrottle(300000, () => 9000);
    assert.ok(throttle.shouldRun('A'));
    // No markSuccessful after a rejected deletion or missing backend metadata.
    assert.ok(throttle.shouldRun('A'));
    throttle.markSuccessful('A');
    assert.equal(throttle.shouldRun('A'), false);
    throttle.force('A');
    assert.ok(throttle.shouldRun('A'));
    // Failed forced pass must not clear the forced flag.
    assert.ok(throttle.shouldRun('A'));
    throttle.markSuccessful('A');
    assert.equal(throttle.shouldRun('A'), false);
    assert.equal(throttle.shouldRun('B'), true);
});

function toggleHarness({ initialEnabled = false } = {}) {
    const s = source('ui/ui-manager.js');
    const begin = s.indexOf(".on('input', async function() {");
    const start = s.indexOf('async function()', begin);
    const end = s.indexOf('\n        });', start);
    assert.ok(start >= 0 && end > start);
    // The handler body is unmodified; replacing the dynamic module loader lets
    // it run with the same storage behavior in this offline harness.
    const handlerSource = s.slice(start, end + '\n        }'.length).replaceAll("import('../core/collection-metadata.js')", 'loadMeta()');
    let chat = 'A';
    let checked = true;
    let disabled = false;
    let stored = initialEnabled;
    let modalResult = { action: 'continue' };
    let vectorize = async () => true;
    const calls = [];
    const ui = {
        prop(key, value) {
            if (value === undefined) return key === 'checked' ? checked : disabled;
            if (key === 'checked') checked = value;
            if (key === 'disabled') disabled = value;
            return this;
        },
    };
    const context = vm.createContext({
        $: () => ui,
        getCurrentChatId: () => chat,
        getChatCollectionId: () => chat,
        toastr: { warning: x => calls.push(['warning', x]), info: x => calls.push(['info', x]),
            success: x => calls.push(['success', x]), error: x => calls.push(['error', x]) },
        console: { log() {}, error() {} },
        openContentVectorizer: () => calls.push(['vectorizer']),
        doesChatHaveVectors: async () => ({ hasVectors: true, allMatches: [{ collectionId: chat }] }),
        showAutoSyncConfirmModal: async () => modalResult,
        loadMeta: async () => ({
            setCollectionAutoSync: (id, value) => { stored = value; calls.push(['set', id, value]); },
            isCollectionAutoSyncEnabled: () => stored,
        }),
        refreshAutoSyncCheckbox: () => { checked = stored; disabled = false; },
        settings: {},
        callbacks: { onVectorizeAll: () => vectorize() },
    });
    const handler = vm.runInContext(`let autoSyncUiVersion = 0;\n(${handlerSource})`, context);
    return { handler, ui, calls, setChat: v => { chat = v; }, setModal: v => { modalResult = v; },
        setVectorize: fn => { vectorize = fn; }, getState: () => ({ checked, disabled, stored }) };
}

test('I03 #30/#11: Continue action is in scope and awaited before reporting success', async () => {
    const h = toggleHarness();
    const work = deferred();
    h.setVectorize(() => work.promise);
    const running = h.handler.call(h.ui);
    await flush();
    assert.equal(h.getState().stored, true);
    assert.equal(h.getState().disabled, true);
    assert.equal(h.calls.filter(x => x[0] === 'success').length, 0);
    work.resolve(true);
    await running;
    assert.equal(h.getState().disabled, false);
    assert.equal(h.calls.filter(x => x[0] === 'success').length, 1);
});

test('I03 #11: failed Continue restores previous toggle state', async () => {
    const h = toggleHarness();
    h.setVectorize(async () => { throw Error('backend failed'); });
    await h.handler.call(h.ui);
    assert.equal(h.getState().stored, false);
    assert.equal(h.getState().checked, false);
    assert.equal(h.getState().disabled, false);
    assert.equal(h.calls.filter(x => x[0] === 'success').length, 0);
    assert.equal(h.calls.filter(x => x[0] === 'error').length, 1);
});

test('I03 #30: cancelling confirmation does not change saved auto-sync setting', async () => {
    const h = toggleHarness();
    h.setModal({ action: 'cancel' });
    await h.handler.call(h.ui);
    assert.equal(h.getState().stored, false);
    assert.equal(h.getState().checked, false);
    assert.equal(h.calls.filter(x => x[0] === 'set').length, 0);
});

test('I03 #25: chat switching while confirmation is pending cannot enable another chat', async () => {
    const h = toggleHarness();
    const ready = deferred();
    // Use async modal state via actual handler-relevant test harness.
    h.setModal({ action: 'continue' });
    h.setVectorize(() => ready.promise);
    const running = h.handler.call(h.ui);
    await flush();
    h.setChat('B');
    ready.resolve(true);
    await running;
    assert.equal(h.calls.filter(x => x[0] === 'success').length, 0);
    assert.ok(!h.calls.some(x => x[0] === 'set' && x[1] === 'B'));
});

test('I03 #11: vectorizer explicitly reports false, auto-sync enable is rolled back', async () => {
    const h = toggleHarness();
    h.setVectorize(async () => false);
    await h.handler.call(h.ui);
    assert.equal(h.getState().stored, false);
    assert.equal(h.getState().checked, false);
});

test('I03 #11: vectorizeAll propagates completion status through UI callback', () => {
    const index = source('index.js');
    const vectorize = source('core/chat-vectorization.js');
    assert.match(index, /const result = await vectorizeAll\(settings, getBatchSize\(\)\)/);
    assert.match(index, /async function onVectorizeAllClick\(\)[\s\S]*?return result;/);
    assert.match(vectorize, /Vectorization complete after[^\n]+\n\s*return true;/);
    assert.match(vectorize, /Vectorization failed: \$\{error.message\}[^\n]*\n\s*return false;/);
});

test('I03 #114: cleanup cooldown is recorded only on successful metadata-backed pass', () => {
    const s = source('core/chat-vectorization.js');
    const begin = s.indexOf('if (existingHashes.size > 0 && reverseSyncThrottle.shouldRun(throttleKey))');
    const end = s.indexOf('// Filter out already vectorized items', begin);
    const block = s.slice(begin, end);
    assert.ok(begin > 0 && end > begin);
    assert.ok(block.indexOf('reverseSyncThrottle.markSuccessful(throttleKey)') > block.indexOf('if (metaByHash)'));
    assert.ok(block.indexOf('reverseSyncThrottle.markSuccessful(throttleKey)') < block.indexOf('} else {\n                    console.debug'));
    assert.match(block, /destructive cleanup deferred/i);
});

test('I03 #25: switching chat before auto-sync confirmation returns cannot persist the old request', async () => {
    const h = toggleHarness();
    const modal = deferred();
    h.setModal(modal.promise);
    const running = h.handler.call(h.ui);
    await flush();
    h.setChat('B');
    modal.resolve({ action: 'continue' });
    await running;
    assert.equal(h.getState().stored, false);
    assert.equal(h.calls.filter(x => x[0] === 'set').length, 0);
});

test('I03 #25: slow checkbox refresh from old chat cannot update the new chat', async () => {
    const s = source('ui/ui-manager.js');
    const start = s.indexOf('export function refreshAutoSyncCheckbox(settings) {');
    const end = s.indexOf('\n}\n', start);
    assert.ok(start > 0 && end > start);
    const func = s.slice(start, end + 2).replace(/^export /, '').replaceAll("import('../core/collection-metadata.js')", 'loadMeta()');
    let chat = 'A';
    let checked = false;
    const pending = [];
    const context = vm.createContext({
        console: { warn() {} },
        getChatCollectionId: () => chat,
        $: () => ({ prop(key, value) {
            if (key === 'checked') checked = value;
            return this;
        } }),
        loadMeta: () => {
            const d = deferred(); pending.push(d); return d.promise;
        },
    });
    vm.runInContext(`let autoSyncUiVersion = 0;\n${func}\nthis.refresh = refreshAutoSyncCheckbox`, context);
    context.refresh({});
    chat = 'B';
    context.refresh({});
    pending[1].resolve({ isCollectionAutoSyncEnabled: id => id === 'B' });
    await flush();
    assert.equal(checked, true);
    pending[0].resolve({ isCollectionAutoSyncEnabled: () => false });
    await flush();
    assert.equal(checked, true);
});
