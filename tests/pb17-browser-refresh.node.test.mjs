import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

// Execute the actual browser refresh function with narrow UI stubs. This avoids
// mounting the full SillyTavern DOM while testing ordering and failure behavior.
const source=readFileSync(new URL('../ui/database-browser.js',import.meta.url),'utf8');
const begin=source.indexOf('async function refreshCollections() {');
const end=source.indexOf('/**\n * Renders collections list',begin);
assert.ok(begin>=0 && end>begin);
const refreshSource=source.slice(begin,end);
function harness() {
  const state={settings:{vector_backend:'qdrant',source:'openai'},collections:[],selectedCollection:'old'};
  const requests=[],html=[],stats=[],renders=[];
  const context=vm.createContext({
    browserState:state,console:{error(){}},
    $:()=>({html:v=>html.push(v)}),
    updateStats:(...v)=>stats.push(v),
    renderCollections:()=>renders.push([...state.collections]),
    loadAllCollections:()=>new Promise((resolve,reject)=>requests.push({resolve,reject})),
  });
  vm.runInContext(`let collectionsRefreshEpoch=0; ${refreshSource}; globalThis.refreshCollections=refreshCollections; globalThis.cancel=()=>++collectionsRefreshEpoch;`,context);
  return {state,requests,html,stats,renders,refresh:context.refreshCollections,cancel:context.cancel};
}
test('PB17: older completed refresh cannot overwrite latest collection read',async()=>{
  const h=harness();
  const first=h.refresh(),second=h.refresh();
  h.requests[1].resolve([{id:'new'}]);await second;
  h.requests[0].resolve([{id:'old'}]);await first;
  assert.equal(h.state.collections[0].id,'new');
  assert.equal(h.renders.length,1);
});
test('PB17: newest refresh failure removes stale actionable cards and clears stats',async()=>{
  const h=harness();h.state.collections=[{id:'stale'}];
  const first=h.refresh(),second=h.refresh();
  h.requests[1].reject(Error('offline'));await second;
  h.requests[0].resolve([{id:'old'}]);await first;
  assert.equal(h.state.collections.length,0);
  assert.equal(h.state.selectedCollection,null);
  assert.deepEqual(h.stats.at(-1),[0,0]);
  assert.match(h.html.at(-1),/Failed to load collections/);
  assert.equal(h.renders.length,0);
});
test('PB17: changing backend during fetch invalidates its result',async()=>{
  const h=harness();const pending=h.refresh();
  h.state.settings.vector_backend='milvus';
  h.requests[0].resolve([{id:'qdrant-old'}]);await pending;
  assert.equal(h.renders.length,0);
  assert.equal(h.state.collections.length,0);
  assert.match(h.html.at(-1),/Refresh collections/);
});
test('PB17: closing browser cancels an outstanding read',async()=>{
  const h=harness();const pending=h.refresh();h.cancel();
  h.requests[0].resolve([{id:'old'}]);await pending;
  assert.equal(h.renders.length,0);
});
test('PB18: successful refresh clears the previous inventory selection',async()=>{
  const h=harness();h.state.selectedCollection={id:'removed-old'};
  const pending=h.refresh();h.requests[0].resolve([{id:'new',registryKey:'qdrant:openai:new'}]);
  await pending;
  assert.equal(h.state.selectedCollection,null);
  assert.equal(h.state.collections[0].id,'new');
});

test('PB18: prior collection cards are not actionable while their refresh is pending',async()=>{
  const h=harness();h.state.collections=[{id:'deleted-remotely'}];
  h.state.selectedCollection={id:'deleted-remotely'};
  const pending=h.refresh();
  assert.equal(h.state.collections.length,0);
  assert.equal(h.state.selectedCollection,null);
  assert.match(h.html.at(-1),/Refreshing collections/);
  h.requests[0].resolve([{id:'still-present'}]);await pending;
  assert.equal(h.state.collections[0].id,'still-present');
});
