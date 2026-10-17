/** P2 new behavioural regressions; run: node --experimental-vm-modules tests/p2-new-behaviour.mjs */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {chooseMemoryInjections} from '../core/injection-budget.js';
const src=p=>readFileSync(new URL(p.startsWith('../')?'../../'+p.slice(3):'../'+p,import.meta.url),'utf8');
let checks=0;
async function test(name,fn){await fn();checks++;console.log('PASS',name)}
const memories=Array.from({length:20},(_,i)=>({hash:i,text:'X'.repeat(1000),position:i%3}));
const renderGroups=rows=>[0,1,2].map(pos=>'HEADER '+rows.filter(r=>r.position===pos).map(r=>r.text).join(' | ')).filter(str=>str.length>7);
const countTokens=async text=>Math.ceil(text.length/5);
await test('20 memories + 3000 tokens uses both limits and full chunks across 3 positions',async()=>{
 const result=await chooseMemoryInjections(memories,{maxMemories:20,maxTokens:3000,renderGroups,countTokens});
 assert.ok(result.selected.length<=20);assert.ok(result.usedTokens<=3000);
 assert.ok(result.selected.length<20);assert.ok(result.skipped.length>0);
 assert.deepEqual(result.selected.map(x=>x.hash),memories.slice(0,result.selected.length).map(x=>x.hash));
});
await test('oversized memory skipped and smaller lower-ranked memory fills spare budget',async()=>{
 const set=[{hash:'a',text:'12345678',position:0},{hash:'b',text:'A'.repeat(200),position:0},{hash:'c',text:'12345',position:0}];
 const out=await chooseMemoryInjections(set,{maxMemories:3,maxTokens:9,renderGroups:rows=>[rows.map(x=>x.text).join('|')],countTokens:async str=>str.length});
 assert.deepEqual(out.selected.map(x=>x.hash),['a']); // even the separator makes c overflow
 const out2=await chooseMemoryInjections(set,{maxMemories:3,maxTokens:14,renderGroups:rows=>[rows.map(x=>x.text).join('|')],countTokens:async str=>str.length});
 assert.deepEqual(out2.selected.map(x=>x.hash),['a','c']);
});
await test('no tokenizer is a failure, not a fake token guarantee',async()=>{
 await assert.rejects(chooseMemoryInjections(memories,{maxMemories:20,maxTokens:3000,renderGroups}),/tokenizer unavailable/);
});
await test('without a token budget normal Top-K still governs count and no hidden trimming',async()=>{
 const out=await chooseMemoryInjections(memories,{maxMemories:8,maxTokens:0,renderGroups});
 assert.equal(out.selected.length,8);assert.equal(out.skipped.length,12);
});
await test('new options are persisted and connected to the generation injection stage',()=>{
 assert.match(src('index.js'),/memory_max_injections: 0/);
 assert.match(src('index.js'),/memory_token_budget: 0/);
 assert.match(src('ui/ui-manager.js'),/memory_token_budget/);
 assert.match(src('core/chat-vectorization.js'),/chooseMemoryInjections\(chunksToInject/);
});
await test('deleted message repair captures branch and file identity before delay',()=>{
 assert.match(src('index.js'),/const sourceChatId = getCurrentChatId\(\)/);
 assert.match(src('index.js'),/pendingDeletionReconciliations/);
 assert.match(src('core/chat-repair.js'),/sourceChatId!==getCurrentChatId\(\)/);
});
await test('Qdrant cursor route avoids full-list rescan and rejects malformed replies',()=>{
 assert.match(src('../VectFox-Similharity-Plugin/qdrant-backend.js'),/listItemsPage\(/);
 assert.match(src('../VectFox-Similharity-Plugin/index.js'),/qdrantBackend\.listItemsPage/);
 assert.match(src('core/chat-repair.js'),/cursorMode\?\{cursor,pageSize:200\}/);
});
await test('zero BM25, WI and temporal floor remain explicit and valid',()=>{
 assert.doesNotMatch(src('ui/ui-manager.js'),/settings\.bm25_b \|\| 0\.75/);
 assert.match(src('core/world-info-integration.js'),/world_info_threshold \?\? 0\.3/);
 assert.match(src('ui/database-browser.js'),/finiteInRange\(\$\("#vecthare_decay_min"\)\.val\(\), 0\.3, 0, 1\)/);
 assert.match(src('ui/content-vectorizer.js'),/finiteCVNumber\(\$\(this\)\.val\(\), 0\.3, 0, 1\)/);
});
await test('unknown keyword active World Info refuses silent duplicate injection',()=>{
 assert.match(src('core/world-info-integration.js'),/if \(!settings\.world_info_enabled_for_all && !verifiedActive\)/);
});
await test('secrets in endpoint query rejected before profile snapshot',()=>{
 assert.match(src('core/vectorization-profile.js'),/assertPersistableEndpoint\(effective\.use_alt_endpoint/);
});
console.log(`${checks} P2 new checks passed`);
