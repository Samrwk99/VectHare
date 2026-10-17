/** Read-only scan / staged repair / deletion reconciliation. Run: node tests/p1-chat-repair.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const file = new URL('../core/chat-repair.js', import.meta.url);
const source=fs.readFileSync(file,'utf8').replace(/^import\s+.*?\s+from\s+['"].*?['"];\s*$/gm,'').replace(/^export /gm,'');
const key='qdrant:llamacpp:chat', id='chat';
let chat=[{mes:'one'},{mes:'two'}], rows=[], expected=[], manifest, chatId=id, failWrites=false;
let ops=[], reads=0;
const settings={source:'llamacpp',vector_backend:'qdrant'};
const env={console,Date,Math,JSON,Number,String,Array,Set,Map,structuredClone,hasActiveVectorWrite:()=>false,
 startActivity:()=> 'repair-1',updateActivity:()=>{},finishActivity:()=>{},createOperationControl:()=>({checkpoint:async()=>{}}),detachOperationControl:()=>{},OperationStoppedError:class OperationStoppedError extends Error{},
 getChatUUID:()=>chatId,getContext:()=>({chat}),getChatBinding:()=>({registryKey:key}),
 resolveChatWriteTarget:()=>({registryKey:key,collectionId:'chat'}),
 applyAndVerifyProfile:async()=>({settings,profile:{verified:true}}),
 getChatChunkManifest:()=>manifest,
 saveChatChunkManifest:async(k,items,uuid)=>{manifest={schemaVersion:1,chatUUID:uuid,entries:items.map(i=>({hash:i.hash,messageIds:i.metadata.messageIds??[i.metadata.messageId]}))};ops.push('manifest');},
 getBackend:async()=>({listChunks:async(_id,_s,opts)=>{reads++;return{items:rows.slice(opts.offset,opts.offset+opts.limit)}}}),
 buildExpectedChatItems:async()=>expected,
 insertVectorItems:async(_id,items)=>{ops.push('insert');if(failWrites)throw Error('embed failure');rows.push(...items.map(i=>({...i})));},
 deleteVectorItems:async(_id,hashes)=>{ops.push('delete');rows=rows.filter(r=>!hashes.map(String).includes(String(r.hash)));},
};
const ctx=vm.createContext(env);
vm.runInContext(fs.readFileSync(new URL('../core/chunk-integrity.js',import.meta.url),'utf8').replace(/^export /gm,''),ctx);
vm.runInContext(source,ctx,{filename:'core/chat-repair.js'});
function item(hash,text,ids=[0,1]){return{hash,text,metadata:{messageIds:ids,messageHashes:ids.map(String)}}}
function reset(){ops=[];reads=0;chatId=id;chat=[{mes:'one'},{mes:'two'}];expected=[item(1,'Hello')];rows=[item(1,'Hello')];manifest={schemaVersion:1,chatUUID:id,entries:[{hash:1,messageIds:[0,1]}]};}
let passes=0;
async function test(n,fn){reset();await fn();console.log('PASS',n);passes++}
await test('Read-only scan identifies correct vectors without mutation',async()=>{let scan=await ctx.scanCurrentChat(settings);assert.equal(scan.issues.length,0);assert.equal(ops.length,0)});
await test('Scan checks complete source text (not just prefix)',async()=>{rows=[item(1,'Hello with stale extra text')];let scan=await ctx.scanCurrentChat(settings);assert.equal(scan.missing.length,1);assert.equal(ops.length,0)});
await test('Scan catches changed source references even when hash is same',async()=>{rows=[item(1,'Hello',[1,2])];let scan=await ctx.scanCurrentChat(settings);assert.equal(scan.missing.length,1)});
await test('Scan refuses incomplete backend payload rather than saying All Clear',async()=>{rows=[{hash:1,text:'Hello'}];await assert.rejects(ctx.scanCurrentChat(settings),/source text\/metadata/)});
await test('Repair writes and verifies replacement before removing stale',async()=>{expected=[item(2,'New')];const scan=await ctx.scanCurrentChat(settings);const done=await ctx.repairCurrentChat(settings,scan);assert.equal(done.issues.length,0);assert.ok(ops.indexOf('insert')<ops.indexOf('delete'));assert.equal(rows.length,1);assert.equal(rows[0].text,'New')});
await test('Failed replacement never deletes old vectors',async()=>{expected=[item(2,'New')];const scan=await ctx.scanCurrentChat(settings);failWrites=true;try{await assert.rejects(ctx.repairCurrentChat(settings,scan),/embed failure/)}finally{failWrites=false};assert.ok(!ops.includes('delete'));assert.equal(rows[0].hash,1)});
await test('Automatic deletion reconciliation notices reindexed middle deletion',async()=>{chat=[{mes:'one'}];expected=[item(2,'Only one',[0])];await ctx.reconcileDeletedMessages(settings);assert.equal(rows.length,1);assert.equal(rows[0].hash,2);assert.ok(ops.includes('delete'))});
await test('Automatic deletion does not vectorize unrelated unsynced messages',async()=>{chat=[{mes:'one'},{mes:'two'},{mes:'three'},{mes:'four'}];expected=[item(2,'Changed existing',[0,1]),item(3,'Unsynced',[2,3])];await ctx.reconcileDeletedMessages(settings);assert.ok(rows.some(r=>r.hash===2));assert.ok(!rows.some(r=>r.hash===3));});
console.log(`\n${passes} Chat Repair regression checks passed`);
