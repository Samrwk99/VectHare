/** Mocked Content Vectorizer crash/resume without SillyTavern or backend network. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const file=new URL('../core/content-vectorization.js',import.meta.url);
const source=fs.readFileSync(file,'utf8');
const start=source.indexOf('let contentVectorizationActive=false;');
const end=source.indexOf('/**\n * Resolves and prepares content for preview or chunking',start);
assert.ok(start>0&&end>start);
const realRows=[],storedProfiles=new Map(),local=new Map(),manifest=[];
let actualInserts=[],crashAfterFirst=true,bindings=[],completed=0;
const settings={strategy:'per_message',chunkSize:500,batchSize:4};
const globalSettings={source:'llamacpp',vector_backend:'qdrant',chunking_strategy:'per_message'};
const chat=[{mes:'a',is_user:true},{mes:'b',is_user:false}];
const src={name:'Original chat',type:'current',replaceExisting:true,replacedCollectionKey:'qdrant:llamacpp:old-chat'};
const getHash=x=>[...String(x)].reduce((a,c)=>(a*31+c.charCodeAt(0))|0,0);
const ext={vecthare:{...globalSettings}};
const progress={activityId:'activity-1',show(){},updateCurrentItem(){},updateProgress(){},updateChunks(){},updateVerifiedChunks(){},addError(){},complete(v){completed++},registerRetry(){}};
const ctx=vm.createContext({
 console,Date,Math,String,Number,Array,Map,Set,JSON,Error,structuredClone,globalThis:null,
 extension_settings:ext,saveSettingsDebounced:()=>{},localStorage:{setItem:(k,v)=>local.set(k,v),getItem:k=>local.get(k)||null,removeItem:k=>local.delete(k)},
 getContentType:()=>({label:'Chat',defaultStrategy:'per_message',defaults:{chunkSize:500,chunkOverlap:0}}),
 getChatUUID:()=> 'chat-uuid',getContext:()=>({chat}),
 progressTracker:progress,hasActiveVectorWrite:()=>false,createOperationControl:()=>({activityId:'activity-1',checkpoint:async()=>{}}),detachOperationControl:()=>{},
 OperationStoppedError:class OperationStoppedError extends Error{},
 resolveSource:async()=>({text:'a\nb'}),prepareContent:async(_t,text)=>text,
 chunkText:async()=>[{text:'first'},{text:'second'}],
 generateCollectionId:()=> 'new-chat',parseRegistryKey:key=>{const [backend,source,...parts]=key.split(':');return {backend,source,collectionId:parts.join(':')};},
 getCollectionOwner:()=> 'chat-uuid',getChatBinding:()=>({registryKey:'qdrant:llamacpp:old-chat'}),
 resolveChatWriteTarget:()=>({collectionId:'new-chat',registryKey:'qdrant:llamacpp:new-chat',newCollection:true}),
 getStringHash:getHash,enrichChunks:chunks=>chunks,
 prepareEmbeddingItems:async items=>items,
 buildExpectedChatItems:async()=>[
    {hash:1,text:'first',metadata:{messageIds:[0],messageHashes:['a']}},
    {hash:2,text:'second',metadata:{messageIds:[1],messageHashes:['b']}},
 ],
 getCollectionProfile:key=>storedProfiles.get(key)||null,
 applyAndVerifyProfile:async key=>({profile:storedProfiles.get(key)}),
 makeCollectionProfile:async()=>({schemaVersion:1,embedding:{verified:true,provider:'llamacpp',modelId:'A'},chunking:{chunking_strategy:'per_message'}}),
 saveCollectionProfile:async(key,p)=>{storedProfiles.set(key,p)},
 getChatChunkManifest:()=>({chatUUID:'chat-uuid',entries:manifest}),
 saveChatChunkManifest:async()=>{},patchChatChunkManifest:async(_key,items)=>{for(const item of items){const i=manifest.findIndex(x=>x.hash===item.hash);if(i>=0)manifest.splice(i,1);manifest.push(item)}},
 getBackend:async()=>({listChunks:async(_id,_s,{offset,limit})=>({items:realRows.slice(offset,offset+limit)}),getChunk:async(_id,hash)=>realRows.find(x=>x.hash===hash)||null}),
 insertVectorItems:async(_id,items)=>{const x=items[0];actualInserts.push(x.hash);realRows.push(x);if(crashAfterFirst){crashAfterFirst=false;throw Error('backend connection dropped after commit');}},
 setCollectionMeta:()=>{},registerCollection:()=>{},bindChatCollection:(uuid,key)=>bindings.push({uuid,key}),
 hasFeature:()=>false, getDefaultDecayForType:()=>({enabled:false}),
});
ctx.globalThis=ctx;
for(const filename of ['../core/sync-checkpoints.js','../core/chunk-integrity.js']){
 let code=fs.readFileSync(new URL(filename,file),'utf8').replace(/^import\s+.*?;\s*$/gm,'').replace(/^export /gm,'');
 vm.runInContext(code,ctx,{filename});
}
vm.runInContext(source.slice(start,end).replace(/^export /gm,''),ctx,{filename:'content-vectorization.js'});
await assert.rejects(ctx.vectorizeContent({contentType:'chat',source:src,settings}),/connection dropped/);
assert.equal(bindings.length,0);
assert.equal(realRows.length,1);
assert.equal(actualInserts.length,1);
assert.equal(local.size>0,true);
assert.ok(ctx.getPendingContentForChat('chat-uuid')?.registryKey); 
const result=await ctx.vectorizeContent({contentType:'chat',source:src,settings});
assert.equal(result.chunkCount,2);
assert.equal(actualInserts.length,2,'must not re-embed previously accepted first chunk');
assert.equal(realRows.length,2);
assert.equal(bindings.length,1);
assert.equal(ctx.getPendingContentForChat('chat-uuid'),null,'success clears pending replacement');
assert.notEqual(bindings[0].key,'qdrant:llamacpp:old-chat');
assert.equal(storedProfiles.size,1,'retry must reuse its own staging collection, not make another');
assert.equal(ctx.getSyncCheckpoint(bindings[0].key,'chat-uuid').phase,'completed');
console.log('PASS staged replacement remains unbound after partial failed insert');
console.log('PASS retry reuses staging collection without re-embedding acknowledged chunk');
console.log('PASS old chat remains untouched until full verification');
console.log('PASS verified replacement binds after all chunks complete');
