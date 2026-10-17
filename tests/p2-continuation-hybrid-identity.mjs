/** P2 continuation regression tests: independent lexical recall, identity and event routing. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = p => readFileSync(new URL('../'+p, import.meta.url), 'utf8');
let passes = 0;
function check(name, fn) { return Promise.resolve().then(fn).then(()=>{passes++;console.log('PASS',name)}); }
const row = (hash, text, score=0) => ({hash,text,score,metadata:{hash,text,score}});
const pages = [
  {items:[row('vector','fuzzy language',.8),row('keyword','orchid orbit compass')],cursor:11,hasMore:true,pageMode:'cursor'},
  {items:[row('other','unrelated')],cursor:null,hasMore:false,pageMode:'cursor'},
];
let pageCalls=[];
const backend = {
  constructor: {name:'QdrantBackend'},
  supportsHybridSearch: ()=>false,
  queryCollection: async()=>({hashes:['vector'],metadata:[row('vector','fuzzy language',.8).metadata]}),
  listChunks: async(_id,_settings,opts)=>{
    pageCalls.push(opts.cursor);
    return pages[opts.cursor == null ? 0 : 1];
  },
};
const vmctx = vm.createContext({console,Math,Map,Set,Number,Array,String,
  getBackend:async()=>backend,
  createBM25Scorer: docs=>({totalDocs:docs.length,
    scoreDocument:(terms,i)=>terms.some(t=>docs[i].text.includes(t))?8:0}),
  tokenize:text=>String(text).split(/\s+/).filter(Boolean),
});
vm.runInContext(source('core/hybrid-search.js')
  .replace(/^import .*?;\s*$/gm,'').replace(/^export /gm,''),vmctx);
await check('independent lexical scan finds keyword-only memory missing from vectors',async()=>{
  const results=await vmctx.hybridSearch('chat-one','orchid',5,
    {vector_backend:'qdrant',source:'test',hybrid_native_prefer:false});
  assert.ok(results.hashes.includes('keyword'),JSON.stringify(results.hashes));
  assert.deepEqual(pageCalls,[null,11]);
});
await check('lexical inventory failure propagates rather than returning false empty',async()=>{
  const saved=backend.listChunks;
  backend.listChunks=async()=>{throw new Error('HTTP 500')};
  await assert.rejects(vmctx.hybridSearch('chat-one','orchid',5,
    {vector_backend:'qdrant',hybrid_native_prefer:false}),/HTTP 500/);
  backend.listChunks=saved;
});
await check('missing immutable integrity must not fall back to mutable chat filename',()=>{
  const ids=source('core/collection-ids.js');
  assert.match(ids,/return null;\n\}/);
  assert.doesNotMatch(ids,/return chatId;\s*\}/);
});
await check('host-confirmed active chat rename preserves the original write binding',()=>{
  const owner=source('core/collection-ownership.js');
  assert.match(owner,/export function reconcileActiveChatRename\(event\)/);
  assert.match(owner,/binding\.sourceChatId !== oldFile/);
  assert.match(owner,/getCurrentChatId\(\) !== newFile/);
  const index=source('index.js');
  assert.match(index,/event_types\.CHAT_RENAMED/);
});
await check('debounced events preserve originating chat and branch file identities',()=>{
  const index=source('index.js');
  assert.match(index,/const debouncedChatUpdate = debounce\(async \(sourceUUID, sourceChatFile\)/);
  assert.match(index,/getChatUUID\(\) !== sourceUUID \|\| getCurrentChatId\(\) !== sourceChatFile/);
});
await check('WI hook accepts authoritative finished ST 1.19 activated map only',()=>{
  const wi=source('core/world-info-integration.js');
  assert.match(wi,/WORLDINFO_SCAN_DONE/);
  assert.match(wi,/args\?\.activated\?\.entries instanceof Map/);
  assert.match(wi,/data\.chatFile !== getCurrentChatId\(\)/);
});
await check('unvectorised empty chats do not create phantom collections or bindings',()=>{
  const sync=source('core/chat-vectorization.js');
  const content=source('core/content-vectorization.js');
  assert.match(sync,/if\(target\.newCollection && expected\.length===0\)/);
  assert.match(content,/if \(!hashedChunks\.length\)/);
  assert.match(content,/openedChatFile!==getCurrentChatId\(\)/);
});
await check('non-chat preview shares exact keyword and overflow write plan',()=>{
  const cv=source('ui/content-vectorizer.js');
  const engine=source('core/content-vectorization.js');
  assert.match(cv,/await buildContentEmbeddingPlan\(chunks,currentContentType/);
  assert.match(engine,/export async function buildContentEmbeddingPlan/);
  assert.match(engine,/await buildContentEmbeddingPlan\(chunks,contentType/);
});
await check('credentials and endpoint URLs are not logged verbatim',()=>{
  assert.doesNotMatch(source('backends/qdrant.js'),/JSON\.stringify\(config\)\)\s*;/);
  assert.doesNotMatch(source('backends/provider-params.js'),/console\.log\(`VectHare DEBUG llamacpp/);
});
await check('valid zero chunk injection depth and group boost persist',()=>{
  const ui=source('ui/chunk-visualizer.js');
  assert.match(ui,/group\.boost \?\? 0\.15/);
  assert.doesNotMatch(ui,/parseInt\(\$\(this\)\.val\(\)\) \|\| 2/);
});
console.log(`${passes} P2 continuation extension checks passed`);
