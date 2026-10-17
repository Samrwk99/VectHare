/** Dependency-free runtime tests for crash recovery and cooperative controls. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
let checks=0;
const test=async(name,fn)=>{await fn();checks++;console.log('PASS',name);};
const root=new URL('..',import.meta.url);
const read=p=>fs.readFileSync(new URL(p,root),'utf8');
const local=new Map();
const db=[];const manifest=[];
const settings={source:'llamacpp',vector_backend:'qdrant',chunking_strategy:'conversation_turns'};
const saved={vecthare:{}};
let started='chat-a',mode='ok',insertions=[],filesWritten=0;
const expected=[1,2,3].map(n=>({hash:n,text:`Pair ${n}`,metadata:{messageIds:[n*2-2,n*2-1],messageHashes:[`${n}a`,`${n}b`]}}));
let chat=[{mes:'a'},{mes:'b'}];
const ctx=vm.createContext({
    console,Date,Math,Number,String,Array,Map,Set,JSON,structuredClone,Error,globalThis:null,
    extension_settings:saved,saveSettingsDebounced:()=>{filesWritten++},
    localStorage:{getItem:k=>local.get(k)||null,setItem:(k,v)=>local.set(k,v),removeItem:k=>local.delete(k)},
    getChatUUID:()=>started,getCurrentChatId:()=>started,
    getChatBinding:()=>({registryKey:'qdrant:llamacpp:chat-a',writeVerified:true}),
    settingsForSavedCollection:(_k,s)=>({...s,chunking_strategy:'conversation_turns'}),
    getChatCollectionId:()=> 'chat-a',
    resolveChatWriteTarget:()=>({collectionId:'chat-a',registryKey:'qdrant:llamacpp:chat-a',newCollection:false}),
    applyAndVerifyProfile:async(_k,s)=>({settings:s,profile:{embedding:{verified:true}}}),
    waitUntilCondition:async()=>{},is_send_press:false,
    getContext:()=>({chat}),
    getCollectionRegistry:()=>['qdrant:llamacpp:chat-a'],
    getChatChunkManifest:()=>({schemaVersion:1,chatUUID:'chat-a',entries:manifest.map(x=>({...x}))}),
    buildExpectedChatItems:async()=>expected,
    getBackend:async()=>({listChunks:async(_id,_s,{cursor,pageSize})=>({items:db.slice(cursor??0,(cursor??0)+(pageSize??200)),cursor:null,hasMore:false,pageMode:"cursor"}),getChunk:async(_id,hash)=>db.find(x=>String(x.hash)===String(hash))||null}),
    patchChatChunkManifest:async(_k,items,_uuid,removed=[])=>{
        for(const hash of removed){const i=manifest.findIndex(x=>String(x.hash)===String(hash));if(i>=0)manifest.splice(i,1);}
        for(const chunk of items){const i=manifest.findIndex(x=>String(x.hash)===String(chunk.hash));if(i>=0)manifest.splice(i,1);manifest.push(chunk);}
    },
    insertVectorItems:async(_id,items)=>{
        for(const row of items){insertions.push(row.hash);const i=db.findIndex(x=>x.hash===row.hash);if(i>=0)db.splice(i,1);db.push(row);}
        if(mode==='crashAfterWrite'){mode='ok';throw new Error('connection lost after write');}
        if(mode==='failBeforeWrite')throw new Error('embedding failed');
    },
    deleteVectorItems:async(_id,hashes)=>{for(const hash of hashes){const i=db.findIndex(x=>String(x.hash)===String(hash));if(i>=0)db.splice(i,1);}},
    setCollectionMeta:()=>{},startActivity:()=> 'auto',updateActivity:()=>{},finishActivity:()=>{},
    createOperationControl:()=>({checkpoint:async()=>{}}),detachOperationControl:()=>{},hasActiveVectorWrite:()=>false,
    OperationStoppedError:class OperationStoppedError extends Error{},SharedOperationStoppedError:class SharedOperationStoppedError extends Error{},
    acquireSharedOperation:async()=>({id:'mock'}),finishSharedOperation:async()=>{},
});
ctx.globalThis=ctx;
for(const filename of ['core/sync-checkpoints.js','core/chunk-integrity.js']){
    const source=read(filename).replace(/^import .*?;\s*$/gm,'').replace(/^export /gm,'');
    vm.runInContext(source,ctx,{filename});
}
const src=read('core/chat-vectorization.js');
const begin=src.indexOf('export async function synchronizeChat(');
const end=src.indexOf('// ============================================================================\n// REARRANGE CHAT PIPELINE',begin);
assert.ok(begin>0 && end>begin);
vm.runInContext(src.slice(begin,end).replace(/^export /gm,''),ctx,{filename:'core/chat-vectorization.js'});
await test('synchronization checks backend before inserting',async()=>{
    await ctx.synchronizeChat(settings,1,{manual:true});
    assert.deepEqual(insertions,[1]);assert.equal(manifest.length,1);
    assert.equal(ctx.getSyncCheckpoint('qdrant:llamacpp:chat-a','chat-a').verified,1);
});
await test('confirmed vector is reused after a session restart',async()=>{
    await ctx.synchronizeChat(settings,1,{manual:true});
    assert.deepEqual(insertions,[1,2]);
});
await test('post-write crash does not cause a duplicate embedding',async()=>{
    mode='crashAfterWrite';
    await assert.rejects(ctx.synchronizeChat(settings,1,{manual:true}),/connection lost/);
    assert.deepEqual(insertions,[1,2,3]);
    assert.equal(manifest.length,2);
    await ctx.synchronizeChat(settings,1,{manual:true});
    assert.deepEqual(insertions,[1,2,3]);
    assert.equal(manifest.length,3);
    assert.equal(ctx.getSyncCheckpoint('qdrant:llamacpp:chat-a','chat-a').phase,'completed');
});
await test('tampered stored text is repaired but healthy vectors are skipped',async()=>{
    db[1]={...db[1],text:'tampered'};
    await ctx.synchronizeChat(settings,1,{manual:true});
    assert.deepEqual(insertions,[1,2,3,2]);
    assert.equal(db.find(x=>x.hash===2).text,'Pair 2');
});
await test('deleted/obsolete records are removed after all correct vectors are verified',async()=>{
    db.push({hash:99,text:'deleted',metadata:{messageIds:[0]}});
    await ctx.synchronizeChat(settings,1,{manual:true});
    assert.ok(!db.some(x=>x.hash===99));
    assert.deepEqual(insertions,[1,2,3,2]);
});
await test('complete inventory failure never becomes an empty collection',async()=>{
    const original=ctx.inspectCollectionChunks;
    ctx.inspectCollectionChunks=async()=>{throw Error('HTTP 500');};
    await assert.rejects(ctx.synchronizeChat(settings,1,{manual:true}),/HTTP 500/);
    ctx.inspectCollectionChunks=original;
    assert.deepEqual(insertions,[1,2,3,2]);
});
await test('checkpoint journal is immediately persisted without chat contents',async()=>{
    assert.ok([...local.keys()].some(k=>k.includes('sync-checkpoint')));
    assert.ok(filesWritten>0);
    for(const value of local.values())assert.ok(!value.includes('Pair 1'));
});
// Dedicated controller test with actual activity state and pause/resume gates.
const actx=vm.createContext({Map,Set,Date,Math,Number,console,Error,checkpointSharedOperation:async()=>{}});
vm.runInContext(read('ui/activity-status.js').replace(/^export /gm,''),actx);
actx.setActivityPhase=actx.setActivityPhase;
vm.runInContext(read('ui/operation-controls.js').replace(/^import .*?;\s*$/gm,'').replace(/^export /gm,''),actx);
await test('pause waits at next safe checkpoint until explicit resume',async()=>{
    const id=actx.startActivity('Manual Sync');const ctl=actx.createOperationControl(id);
    assert.equal(ctl.request('pause'),true);
    let released=false;const waiting=ctl.checkpoint().then(()=>{released=true;});
    await Promise.resolve();assert.equal(released,false);assert.equal(ctl.state,'paused');
    assert.equal(ctl.request('resume'),true);await waiting;assert.equal(released,true);
    ctl.dispose();actx.finishActivity(id,true);
});
await test('stop releases paused work and prevents further writes',async()=>{
    const id=actx.startActivity('Repair');const ctl=actx.createOperationControl(id);
    ctl.request('pause');const waiting=ctl.checkpoint();await Promise.resolve();
    ctl.request('stop');await assert.rejects(waiting,/stopped safely/);
    ctl.dispose();actx.finishActivity(id,'stopped');
    assert.equal(actx.getActivitySnapshot().history[0].phase,'stopped');
});
console.log(`\n${checks} recovery and controls checks passed`);
