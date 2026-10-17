/** P2 #59: rename must preserve an unvectorised chat's identity without creating vectors. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const state = {
  file: 'first-chat', uuid: 'chat-1', scope: 7,
  extensions: { vecthare: {} }, saves: 0,
};
const context = vm.createContext({
  console, Date, Error, String,
  extension_settings: state.extensions,
  chat_metadata: { get integrity() { return state.uuid; } },
  getCurrentChatId: () => state.file,
  getChatUUID: () => state.uuid,
  getContext: () => ({ characterId: state.scope }),
  saveVectHareSettingsDebounced: () => { state.saves++; },
  saveSettingsDebounced: () => { state.saves++; },
  parseRegistryKey: () => ({}),
  getCollectionMeta: () => ({}),
  assertQdrantIdentity: () => {},
});
for (const file of ['chat-identity-ledger.js', 'collection-ownership.js']) {
  const source = fs.readFileSync(new URL(`../core/${file}`, import.meta.url), 'utf8')
    .replace(/^import .*?;\s*$/gm, '').replace(/^export /gm, '');
  vm.runInContext(source, context, { filename: file });
}
let passed = 0;
function test(name, action) {
  action(); passed++;
  console.log('PASS', name);
}
function reset(file, uuid, scope = 7) {
  state.file = file; state.uuid = uuid; state.scope = scope;
}
function rename(oldFile, newFile) {
  state.file = newFile; // authoritative host rename event occurs after reload
  return context.reconcileActiveChatRename({ oldFileName: `${oldFile}.jsonl`, newFileName: `${newFile}.jsonl` });
}

test('unvectorised chat rename advances only its ledger (no collections or binding created)', () => {
  reset('first-chat', 'chat-1');
  assert.equal(context.recordCurrentChatIdentity().verified, true);
  assert.equal(state.extensions.vecthare.chatCollectionBindings, undefined);
  assert.equal(rename('first-chat', 'new-name'), true);
  assert.equal(state.extensions.vecthare.chatIdentityLedger['chat-1'].file, 'new-name');
  assert.equal(context.recordCurrentChatIdentity().verified, true);
  assert.equal(state.extensions.vecthare.chatCollectionBindings, undefined);
  assert.equal(state.extensions.vecthare.vecthare_collection_registry, undefined);
});

test('renaming a different unvectorised chat with same display name does not affect the first', () => {
  reset('first-chat', 'chat-2');
  assert.equal(context.recordCurrentChatIdentity().verified, true);
  assert.equal(rename('first-chat', 'new-name'), true);
  assert.equal(state.extensions.vecthare.chatIdentityLedger['chat-1'].file, 'new-name');
  assert.equal(state.extensions.vecthare.chatIdentityLedger['chat-2'].file, 'new-name');
  assert.equal(state.extensions.vecthare.chatCollectionBindings, undefined);
});

test('copied UUID / wrong old filename cannot spoof a rename', () => {
  reset('branch-copy', 'chat-1');
  assert.equal(context.recordCurrentChatIdentity().verified, false);
  assert.equal(rename('branch-copy', 'renamed-copy'), false);
  assert.equal(state.extensions.vecthare.chatIdentityLedger['chat-1'].file, 'new-name');
});

test('renames for mismatched character scope are refused', () => {
  reset('new-name', 'chat-1', 8);
  assert.equal(rename('new-name', 'hijack'), false);
  assert.equal(state.extensions.vecthare.chatIdentityLedger['chat-1'].file, 'new-name');
});

test('existing verified writable collection binding follows the rename', () => {
  reset('original', 'bound-chat', 7);
  assert.equal(context.recordCurrentChatIdentity().verified, true);
  state.extensions.vecthare.chatCollectionBindings = {
    'bound-chat': { registryKey: 'qdrant:ollama:chat-bound', sourceChatId: 'original', writeVerified: true },
  };
  assert.equal(rename('original', 'renamed'), true);
  assert.equal(state.extensions.vecthare.chatIdentityLedger['bound-chat'].file, 'renamed');
  assert.equal(state.extensions.vecthare.chatCollectionBindings['bound-chat'].sourceChatId, 'renamed');
  assert.equal(state.extensions.vecthare.chatCollectionBindings['bound-chat'].registryKey, 'qdrant:ollama:chat-bound');
  assert.equal(context.recordCurrentChatIdentity().verified, true);
});

test('mismatching saved binding blocks rename without mutating the ledger or binding', () => {
  reset('original', 'bound-chat');
  state.extensions.vecthare.chatCollectionBindings['bound-chat'].sourceChatId = 'unrelated';
  assert.equal(rename('original', 'should-not-pass'), false);
  assert.equal(state.extensions.vecthare.chatIdentityLedger['bound-chat'].file, 'renamed');
  assert.equal(state.extensions.vecthare.chatCollectionBindings['bound-chat'].sourceChatId, 'unrelated');
});

test('unknown chat identity cannot be silently registered by a rename event', () => {
  reset('old-chat', 'unknown-id');
  assert.equal(rename('old-chat', 'new-chat'), false);
  assert.equal(state.extensions.vecthare.chatIdentityLedger['unknown-id'], undefined);
});

console.log(`\n${passed} P2 #59 chat rename regression checks passed`);
