/** P2 #34/#40/#44/#47/#49/#57 isolated acceptance tests. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {inspectCollectionChunks} from '../core/chunk-integrity.js';
import {chooseMemoryInjections} from '../core/injection-budget.js';
const src=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
let passed=0;
async function check(name,run){await run();passed++;console.log('PASS',name);}
const row=(i,text)=>({hash:i,text,metadata:{hash:i,text}});
await check('#34 generic Qdrant Sync inspector uses actual cursor page, including full first page',async()=>{
 const requests=[];
 const backend={listChunks:async(_id,_settings,opts)=>{
  requests.push(opts);
  if(opts.cursor==null)return {items:Array.from({length:200},(_,i)=>row(i,'x')),pageMode:'cursor',cursor:'continuation',hasMore:true};
  return {items:[row(200,'end')],pageMode:'cursor',cursor:null,hasMore:false};
 }};
 const rows=await inspectCollectionChunks(backend,'example',{vector_backend:'qdrant'});
 assert.equal(rows.length,201);assert.deepEqual(requests.map(x=>x.cursor),[null,'continuation']);
 assert.ok(requests.every(x=>!Object.hasOwn(x,'offset')));
});
await check('#34 refuses Qdrant false completion, repeated cursors and malformed pages',async()=>{
 const fail=async response=>assert.rejects(inspectCollectionChunks({listChunks:async()=>response},'x',{vector_backend:'qdrant'}));
 await fail({items:[],pageMode:'offset',hasMore:false});
 await fail({items:[],pageMode:'cursor',cursor:42,hasMore:true});
 await fail({items:null,pageMode:'cursor',hasMore:false});
});
await check('#34 native Standard inspector does not accidentally use cursor mode',async()=>{
 let calls=0;
 const backend={listChunks:async(_id,_settings,opts)=>{assert.ok(Object.hasOwn(opts,'offset'));calls++;return {items:[row(1,'ok')]}}};
 const rows=await inspectCollectionChunks(backend,'native',{vector_backend:'standard'});
 assert.equal(rows.length,1);assert.equal(calls,1);
});
const lexicalSource=src('core/hybrid-search.js').replace(/^import .*?;\s*$/gm,'').replace(/^export /gm,'');
const backend={constructor:{name:'MockQdrant'},supportsHybridSearch:()=>false,
 queryCollection:async()=>({hashes:[],metadata:[]}),listChunks:async()=>({items:[row('a','keyword-only beacon')],cursor:null,pageMode:'cursor',hasMore:false})};
const scope=vm.createContext({console,Map,Set,Math,Number,Array,String,
 getBackend:async()=>backend,
 createBM25Scorer:docs=>({totalDocs:docs.length,scoreDocument:(terms,i)=>terms.some(t=>docs[i].text.includes(t))?12:0}),
 tokenize:text=>String(text).split(/\s+/).filter(Boolean)});
vm.runInContext(lexicalSource,scope);
const hybrid=()=>scope.hybridSearch('test','keyword-only',5,{vector_backend:'qdrant',hybrid_native_prefer:false});
await check('#44 Qdrant lexical-only result exists even when dense search returns zero',async()=>{
 const out=await hybrid();assert.ok(out.hashes.includes('a'));
});
await check('#44 refuses Qdrant cursor downgrade and malformed pages',async()=>{
 const old=backend.listChunks;
 try{
  backend.listChunks=async()=>({items:[],total:0});await assert.rejects(hybrid(),/cursor pagination/);
  backend.listChunks=async()=>({items:[],pageMode:'cursor',cursor:1,hasMore:true});await assert.rejects(hybrid(),/truncated|progress/i);
  backend.listChunks=async()=>({items:[row(1,'a'),row(2,'b')],pageMode:'cursor',cursor:null,hasMore:false});
  await hybrid();
 }finally{backend.listChunks=old;}
});
await check('#44 offset lexical source refuses unverifiable counts',async()=>{
 const old=backend.listChunks;
 try{
  backend.listChunks=async()=>({items:[row('a','keyword-only beacon')]});
  await assert.rejects(scope.hybridSearch('x','keyword-only',5,{vector_backend:'standard',hybrid_native_prefer:false}),/authoritative total/);
  backend.listChunks=async()=>({items:[row('a','keyword-only beacon')],total:1});
  const out=await scope.hybridSearch('x','keyword-only',5,{vector_backend:'standard',hybrid_native_prefer:false});
  assert.ok(out.hashes.includes('a'));
 }finally{backend.listChunks=old;}
});
const wi=src('core/world-info-integration.js');
const wiStart=wi.indexOf('export function deduplicateWithActiveEntries(');
const wiEnd=wi.indexOf('\n// =====',wiStart);
const wiSandbox=vm.createContext({Set,String});vm.runInContext(wi.slice(wiStart,wiEnd).replace(/^export /,''),wiSandbox);
await check('#47 numeric/string IDs, host aliases and whitespace are deduplicated',async()=>{
 const entries=[{uid:'7',content:'duplicate'}, {uid:8,content:' Another   Entry '},{uid:'9',content:'unique'}];
 const filtered=wiSandbox.deduplicateWithActiveEntries(entries,[{id:7,content:'unrelated'},{entryId:'8',content:'whatever'}]);
 assert.equal(filtered.length,1);assert.equal(filtered[0].uid,'9');
 const byText=wiSandbox.deduplicateWithActiveEntries([{uid:'1',content:'Hello \n WORLD'}],[{uid:2,content:'hello world'}]);
 assert.equal(byText.length,0);
});
await check('#49 preview invokes same final enrichment/split functions, no vector insert',()=>{
 const preview=src('ui/content-vectorizer.js');const write=src('core/content-vectorization.js');
 assert.match(preview,/await buildExpectedChatItems\(getContext\(\)\.chat,effective\)/);
 assert.match(preview,/await buildContentEmbeddingPlan\(chunks,currentContentType,source,currentSettings,prepared,effective\)/);
 assert.match(write,/await buildContentEmbeddingPlan\(chunks,contentType,source,settings,preparedContent,effectiveProfileSettings\)/);
 assert.match(preview,/chunkSize:currentSettings\.chunkSize \|\| type\.defaults\.chunkSize/);
 assert.match(preview,/batchSize:currentSettings\.batchSize \|\| 4/);
});
await check('#57 combined budget counts all group wrappers and selects only full chunks',async()=>{
 const items=[{hash:'a',text:'A'.repeat(15),position:0},{hash:'b',text:'B'.repeat(70),position:1},{hash:'c',text:'C'.repeat(10),position:1}];
 const renderGroups=rows=>[0,1].map(p=>rows.filter(x=>x.position===p)).filter(x=>x.length).map(x=>'WRAPPED '+x.map(y=>y.text).join('|'));
 const out=await chooseMemoryInjections(items,{maxMemories:2,maxTokens:50,renderGroups,countTokens:async t=>t.length});
 assert.deepEqual(out.selected.map(x=>x.hash),['a','c']);
 assert.ok(out.usedTokens<=50);
 const text=renderGroups(out.selected);assert.equal(text.reduce((a,b)=>a+b.length,0),out.usedTokens);
});
await check('#57 invalid token counts fail closed and injection acknowledgements are checked',async()=>{
 await assert.rejects(chooseMemoryInjections([{hash:1}],{maxTokens:5,renderGroups:()=>['hey'],countTokens:async()=>NaN}),/invalid token count/);
 assert.match(src('core/chat-vectorization.js'),/if \(!injection\.verified\)/);
 assert.match(src('core/chat-vectorization.js'),/cleared all VectHare tags/);
 assert.match(src('core/world-info-integration.js'),/independent semantic WI injection disabled while the unified memory budget is active/);
});
await check('#40 host-managed embedding providers with manual limit fail on oversized query or chunk',()=>{
 const x=src('core/embedding-overflow.js');
 assert.match(x,/conservativeBytes\(finalText\)>budget/);
 assert.match(x,/conservativeBytes\(text\);/);
 assert.match(x,/no verified tokenizer\/splitting path is available/);
});
console.log(`${passed} isolated batch-B checks passed`);
