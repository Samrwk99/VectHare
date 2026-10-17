/** Standalone conversation-turn regression checks. Run: node tests/conversation-turn-order.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {groupConversationTurns, normalizeTurnOrder} from '../core/conversation-turns.js';
import {chunkText} from '../core/chunking.js';
let checks=0;
async function test(name,fn){ await fn(); checks++; console.log('PASS',name); }
const sequence=(s)=>[...s].map((speaker,index)=>({is_user:speaker==='U',name:speaker==='U'?'You':'Alice',text:`${speaker}${index+1}`,index,hash:`h${index}`}));
const indexes=groups=>groups.map(pair=>pair.map(m=>m.index));
await test('default order remains User → Character for legacy settings',()=>{assert.equal(normalizeTurnOrder(), 'user_character');});
await test('repeated User and Character messages make a single logical pair',()=>{
 assert.deepEqual(indexes(groupConversationTurns(sequence('UUUCC'))),[[0,1,2,3,4]]);
 assert.deepEqual(indexes(groupConversationTurns(sequence('CCUU'), 'character_user')),[[0,1,2,3]]);
});
await test('normal alternating User → Character pairs have stable boundaries',()=>{
 assert.deepEqual(indexes(groupConversationTurns(sequence('UCUCUC'))),[[0,1],[2,3],[4,5]]);
});
await test('normal alternating Character → User pairs have stable boundaries',()=>{
 assert.deepEqual(indexes(groupConversationTurns(sequence('CUCUCU'),'character_user')),[[0,1],[2,3],[4,5]]);
});
await test('opposite-role greeting attaches without reordering or losing content',()=>{
 assert.deepEqual(indexes(groupConversationTurns(sequence('CUC'))),[[0,1,2]]);
 assert.deepEqual(indexes(groupConversationTurns(sequence('UCU'),'character_user')),[[0,1,2]]);
 assert.deepEqual(indexes(groupConversationTurns(sequence('CU'))),[[0,1]]);
});
await test('consecutive messages are merged before selecting next group',()=>{
 assert.deepEqual(indexes(groupConversationTurns(sequence('UCUCCUUC'))),[[0,1],[2,3,4],[5,6,7]]);
});
await test('unanswered final turn remains an independent chunk',()=>{
 assert.deepEqual(indexes(groupConversationTurns(sequence('UCU'))),[[0,1],[2]]);
 assert.deepEqual(indexes(groupConversationTurns(sequence('CUC'),'character_user')),[[0,1],[2]]);
});
await test('empty, one-message and all-one-speaker sequences do not lose messages',()=>{
 assert.deepEqual(groupConversationTurns([]),[]);
 assert.deepEqual(indexes(groupConversationTurns(sequence('C'))),[[0]]);
 assert.deepEqual(indexes(groupConversationTurns(sequence('UUUU'))),[[0,1,2,3]]);
 assert.deepEqual(indexes(groupConversationTurns(sequence('CCCC'),'character_user')),[[0,1,2,3]]);
});
await test('all arbitrary speaker sequences partition source IDs exactly once in original order',()=>{
 for(let n=0;n<=9;n++)for(let mask=0;mask<(1<<n);mask++) {
  const messages=Array.from({length:n},(_,i)=>({is_user:!!(mask&(1<<i)),index:i}));
  for(const direction of ['user_character','character_user']) {
   const groups=groupConversationTurns(messages,direction);
   assert.deepEqual(groups.flat().map(m=>m.index),messages.map(m=>m.index));
   assert.ok(groups.every(group=>group.length));
  }
 }
});
// The full chat sync implementation needs SillyTavern imports; evaluate just
// its pure exported grouping function, with the same shared helper stub.
const script=fs.readFileSync(new URL('../core/chat-vectorization.js',import.meta.url),'utf8');
const start=script.indexOf('export function groupMessagesByStrategy(');
const end=script.indexOf('\n}\n',start)+2;
assert.ok(start>=0&&end>start);
const ctx=vm.createContext({groupConversationTurns,normalizeTurnOrder,extractBM25Keywords:()=>[],getStringHash:t=>`hash-${t}`});
vm.runInContext(script.slice(start,end).replace('export function','function'),ctx);
await test('Content Vectorizer and Sync/Repair produce identical chunks and message references',async()=>{
 for(const dir of ['user_character','character_user'])for(const speakers of ['UUC','CUC','UCUCCUUC','UCCUU','CUUCCU','UCUC']) {
  const messages=sequence(speakers);
  const chunks=await chunkText(messages,{strategy:'conversation_turns',conversationTurnOrder:dir});
  const expected=ctx.groupMessagesByStrategy(messages,'conversation_turns',4,'off',dir);
  assert.deepEqual(chunks.map(c=>c.text),expected.map(c=>c.text));
  assert.deepEqual(chunks.map(c=>Array.from(c.metadata.messageIds)),expected.map(c=>Array.from(c.metadata.messageIds)));
  assert.deepEqual(expected.map(c=>Array.from(c.metadata.messageHashes)),indexes(groupConversationTurns(messages,dir)).map(ids=>ids.map(i=>`h${i}`)));
  assert.ok(expected.every(c=>c.metadata.turnOrder===dir));
 }
});
await test('new message updates only the changing tail pair, with stable earlier hash boundaries',()=>{
 const old=ctx.groupMessagesByStrategy(sequence('UCU'),'conversation_turns',4,'off','user_character');
 const updated=ctx.groupMessagesByStrategy(sequence('UCUC'),'conversation_turns',4,'off','user_character');
 assert.equal(old[0].hash,updated[0].hash);
 assert.notEqual(old[1].hash,updated[1].hash);
 assert.deepEqual([...updated[1].metadata.messageIds],[2,3]);
});
await test('UI exposes two choices and saves the direction in both entry points',()=>{
 const ui=fs.readFileSync(new URL('../ui/ui-manager.js',import.meta.url),'utf8');
 const cv=fs.readFileSync(new URL('../ui/content-vectorizer.js',import.meta.url),'utf8');
 const profile=fs.readFileSync(new URL('../core/vectorization-profile.js',import.meta.url),'utf8');
 const content=fs.readFileSync(new URL('../core/content-vectorization.js',import.meta.url),'utf8');
 assert.match(ui,/id="vecthare_conversation_turn_order"/);
 assert.match(cv,/id="vecthare_cv_turn_order"/);
 assert.match(ui,/settings\.conversation_turn_order\s*=/);
 assert.match(cv,/currentSettings\.conversationTurnOrder\s*=/);
 assert.match(profile,/'conversation_turn_order'/);
 assert.match(profile,/conversation_turn_order:profile\.chunking\.conversation_turn_order \|\| 'user_character'/);
 assert.match(content,/conversation_turn_order:settings\.conversationTurnOrder/);
});
console.log(`\n${checks} Conversation Turns regression checks passed`);
// Saved collection profiles control continuation independent of global preference.
const profileSource=fs.readFileSync(new URL('../core/vectorization-profile.js',import.meta.url),'utf8');
const profiles=new Map();
const profileCtx=vm.createContext({
 captureCleaningSnapshot:()=>({selectedPreset:"none",customPatterns:[],enabledBuiltins:[]}),CHUNK_IDENTITY_VERSION:2,
 console,Date,Math,JSON,Number,String,Array,Set,Map,URL,structuredClone,
 extension_settings:{vecthare:{}},saveSettingsDebounced(){},flushVectHareSettings:async()=>{},
 getRequestHeaders:()=>({'Content-Type':'application/json'}),
 getProviderSpecificParams:()=>({apiUrl:''}),getModelField:()=>null,
 parseRegistryKey:key=>{const [backend,source,...rest]=key.split(':');return {backend,source,collectionId:rest.join(':')};},
 getCollectionMeta:key=>profiles.get(key)||{},
 setCollectionMeta:(key,value)=>profiles.set(key,{...(profiles.get(key)||{}),...value}),
 fetch:async()=>({ok:true,json:async()=>({success:true})}),
});
vm.runInContext(profileSource.replace(/^import\s+.*?\s+from\s+['"].*?['"];\s*$/gm,'').replace(/^export /gm,''),profileCtx);
await test('two saved collections retain different pairing directions across global settings changes',async()=>{
 for (const [key,order] of [['standard:transformers:chat-A','user_character'],['standard:transformers:chat-B','character_user']]) {
  const settings={source:'transformers',vector_backend:'standard',chunking_strategy:'conversation_turns',conversation_turn_order:order,qdrant_multitenancy:false};
  const profile=await profileCtx.makeCollectionProfile(settings);
  await profileCtx.saveCollectionProfile(key,profile);
 }
 const global={source:'transformers',vector_backend:'standard',chunking_strategy:'conversation_turns',conversation_turn_order:'character_user',qdrant_multitenancy:false};
 assert.equal(profileCtx.settingsForSavedCollection('standard:transformers:chat-A',global).conversation_turn_order,'user_character');
 assert.equal(profileCtx.settingsForSavedCollection('standard:transformers:chat-B',{...global,conversation_turn_order:'user_character'}).conversation_turn_order,'character_user');
});
await test('legacy verified Conversation Turns profile without an order continues User → Character',async()=>{
 const key='standard:transformers:old-chat';
 const profile=await profileCtx.makeCollectionProfile({source:'transformers',vector_backend:'standard',chunking_strategy:'conversation_turns',qdrant_multitenancy:false});
 delete profile.chunking.conversation_turn_order;
 await profileCtx.saveCollectionProfile(key,profile);
 const global={source:'transformers',vector_backend:'standard',chunking_strategy:'conversation_turns',conversation_turn_order:'character_user',qdrant_multitenancy:false};
 assert.equal(profileCtx.settingsForSavedCollection(key,global).conversation_turn_order,'user_character');
 assert.equal((await profileCtx.applyAndVerifyProfile(key,global)).settings.conversation_turn_order,'user_character');
});
console.log('Saved-profile compatibility checks passed');
const overflowSource=fs.readFileSync(new URL('../core/embedding-overflow.js',import.meta.url),'utf8');
const overflowContext=vm.createContext({
 console,Math,Date,JSON,Number,String,Map,Set,
 getProviderSpecificParams:()=>({apiUrl:'http://127.0.0.1:9977'}),
 getRequestHeaders:()=>({'Content-Type':'application/json'}),
 fetch:async(url,options)=>{
  const body=JSON.parse(options.body);
  return {ok:true,json:async()=>String(url).endsWith('/capabilities')
   ? {success:true,modelId:'test-embedding',limits:{maxTokens:40}}
   : {success:true,count:String(body.text).trim().split(/\s+/).filter(Boolean).length}};
 }
});
vm.runInContext(overflowSource.replace(/^import\s+.*?\s+from\s+['"].*?['"];\s*$/gm,'').replace(/^export /gm,''),overflowContext);
await test('oversized reverse-direction pair repeats short partner while preserving source links',async()=>{
 const long=Array.from({length:90},(_,i)=>`word${i}`).join(' ');
 const pair=`[Character]: Hi\n\n[User]: ${long}`;
 const item={text:pair,hash:1024,metadata:{strategy:'conversation_turns',turnOrder:'character_user',messageIds:[4,5]}};
 const chunks=await overflowContext.prepareEmbeddingItems([item],{source:'llamacpp'},x=>String(x.length));
 assert.ok(chunks.length>1);
 for(const c of chunks){
  assert.ok(c.text.includes('[Character]: Hi'));
  assert.equal(c.metadata.parentHash,1024);
  assert.deepEqual([...c.metadata.messageIds],[4,5]);
  assert.equal(c.metadata.turnOrder,'character_user');
  assert.ok(c.text.trim().split(/\s+/).length<=37);
 }
});
console.log('Reverse-direction overflow checks passed');
