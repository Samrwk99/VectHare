/** #13 source-module tests with a deterministic transactional IndexedDB stand-in.
 * Tests sidecar acknowledgement, compact settings and crash/restart replay.
 * Browser IndexedDB/WebView integration must be tested on-device separately.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../core/vectorization-profile.js',import.meta.url),'utf8');
const meta=new Map(), server=new Map(), idb=new Map();
let failAfterCommit=false, failBeforeCommit=false, failLocalPatch=false;
const calls=[];
function value(key){return structuredClone(meta.get(key)||{});}
const set=(key,change)=>meta.set(key,{...value(key),...structuredClone(change)});
const route=async(url,opts)=>{
    const body=JSON.parse(opts.body||'{}');calls.push({url,body});
    if(body.key?.startsWith('standard:'))return {ok:false,status:404};
    if(url.endsWith('/profile/get')){
        const s=server.get(body.key);
        return s?{ok:true,json:async()=>structuredClone(s)}:{ok:false,status:404};
    }
    if(url.endsWith('/profile/set')){
        const prev=server.get(body.key);
        if(prev?.manifest && body.manifest && (prev.manifest.revision??0)>(body.manifest.revision??0))return {ok:false,status:409};
        server.set(body.key,structuredClone(body));return {ok:true,json:async()=>({success:true})};
    }
    if(url.endsWith('/manifest/patch')){
        if(failBeforeCommit){failBeforeCommit=false;return {ok:false,status:503};}
        const state=server.get(body.key);const before=state?.manifest;
        if(!before || before.chatUUID!==body.chatUUID || before.revision!==body.expectedRevision ||
          before.updatedAt!==body.expectedUpdatedAt)return {ok:false,status:409};
        const map=new Map(before.entries.map(r=>[String(r.hash),r]));
        for(const hash of body.removedHashes)map.delete(String(hash));
        for(const row of body.upserts)map.set(String(row.hash),row);
        state.manifest={...before,entries:[...map.values()],revision:body.revision,updatedAt:body.updatedAt};
        if(failAfterCommit){failAfterCommit=false;return {ok:false,status:503};}
        return {ok:true,json:async()=>({success:true,revision:body.revision,updatedAt:body.updatedAt,entries:map.size})};
    }
    throw Error('Unexpected route '+url);
};
function launch(){
    const context=vm.createContext({console,Date,Math,JSON,String,Number,Array,Set,Map,URL,structuredClone,fetch:route,
        extension_settings:{vecthare:{}},CHUNK_IDENTITY_VERSION:2,
        captureCleaningSnapshot:()=>({}),withSharedWriteHeaders:x=>x,runExclusiveNativeMutation:(_l,_r,fn)=>fn(),saveSettingsDebounced(){},getRequestHeaders:()=>({}),
        getProviderSpecificParams:()=>({}),getModelField:()=>null,getBackend:async()=>({}),
        parseRegistryKey:key=>({backend:key.split(':')[0]}),getChatUUID:()=>null,getChatBinding:()=>null,
        getCollectionMeta:value,setCollectionMeta:set,
        hasManifestStorage:()=>true,
        readManifest:async key=>structuredClone(idb.get(key)||null),
        deleteManifest:async key=>{idb.delete(key);},
        replaceManifest:async(key,m)=>{idb.set(key,structuredClone(m));},
        patchManifest:async(key,d)=>{
            if(failLocalPatch){failLocalPatch=false;throw Error('Simulated storage write failure');}
            const prev=idb.get(key);
            if(!prev || prev.revision!==d.expectedRevision || prev.chatUUID!==d.chatUUID)throw Error('Local revision conflict');
            const rows=new Map(prev.entries.map(r=>[String(r.hash),r]));
            for(const hash of d.removedHashes)rows.delete(String(hash));
            for(const row of d.upserts)rows.set(String(row.hash),row);
            idb.set(key,{...prev,updatedAt:d.updatedAt,revision:d.revision,entries:[...rows.values()]});
        },
    });
    vm.runInContext(source.replace(/^import\s+.*?\s+from\s+['"].*?['"];\s*$/gm,'').replace(/^export /gm,''),context);
    return context;
}
const key='qdrant:llamacpp:long-chat';
const recipe={version:2,cleaning:{selectedPreset:'none'},settings:{},algorithmVersions:{chunkIdentity:2,chunking:4,cleaning:1}};
const profile={schemaVersion:1,recipe,embedding:{provider:'llamacpp',modelId:'model-one',verified:true}};
set(key,{vectorizationProfile:profile,profileSaveStatus:'committed'});
let api=launch();
await api.saveChatChunkManifest(key,[],'chat-123');
assert.equal(value(key).chatChunkManifest.storage,'indexeddb-v1');
assert.equal(value(key).chatChunkManifest.entries,undefined);
const longText='Private chat memory '.repeat(75);
for(let i=0;i<320;i++){
    await api.patchChatChunkManifest(key,[{hash:i,text:longText+i,metadata:{messageIds:[i]}}],'chat-123');
    assert.equal(value(key).chatChunkManifest.entries,undefined);
}
assert.equal(value(key).chatChunkManifest.entryCount,320);
assert.equal(server.get(key).manifest.entries.length,320);
assert.equal(idb.get(key).entries.length,320);
assert.ok(JSON.stringify(value(key)).length<1800,'local settings should remain small at 320 long chunks');
const patches=calls.filter(c=>c.url.endsWith('/manifest/patch'));
assert.equal(patches.length,320);
assert.ok(patches.every(c=>c.body.upserts.length===1 && c.body.removedHashes.length===0));
console.log('PASS: 320 incremental commits, compact settings, remote + IndexedDB revisions');
// Simulated extension reload loses its in-process cache but not IndexedDB or server.
api=launch();
const restored=await api.hydrateChatChunkManifest(key);
assert.equal(restored.entries.length,320);
assert.equal(restored.entries[2].text,longText+'2');
await api.patchChatChunkManifest(key,[], 'chat-123',[0]);
assert.equal(idb.get(key).entries.length,319);
assert.equal(server.get(key).manifest.entries.length,319);
console.log('PASS: restart hydration and remove-only patch leave 319 correct records');
failAfterCommit=true;
await assert.rejects(api.patchChatChunkManifest(key,[{hash:999,text:'durable acknowledgement lost',metadata:{messageIds:[999]}}],'chat-123'),/failed/i);
assert.equal(value(key).profileSaveStatus,'failed');
assert.equal(server.get(key).manifest.revision,322);
assert.equal(idb.get(key).revision,321);
await api.reconcileCollectionProfile(key);
assert.equal(value(key).profileSaveStatus,'committed');
assert.equal(idb.get(key).revision,322);
assert.equal(api.getChatChunkManifest(key).entries.length,320);
console.log('PASS: lost acknowledgement reconciled from newer server revision, without rollback');
const standardKey='standard:transformers:native-chat';
set(standardKey,{vectorizationProfile:profile,profileSaveStatus:'committed'});
await api.saveChatChunkManifest(standardKey,[],'native-uuid');
for(let i=0;i<25;i++){
    await api.patchChatChunkManifest(standardKey,[{hash:i,text:longText+i,metadata:{messageIds:[i]}}],'native-uuid');
}
assert.equal(idb.get(standardKey).entries.length,25);
assert.equal(value(standardKey).chatChunkManifest.entries,undefined);
api=launch();
assert.equal((await api.hydrateChatChunkManifest(standardKey)).entries.length,25);
console.log('PASS: plugin-free Standard uses IndexedDB rather than whole settings rewrites');
const failKey='qdrant:llamacpp:failed-before-commit';
set(failKey,{vectorizationProfile:profile,profileSaveStatus:'committed'});
await api.saveChatChunkManifest(failKey,[],'failed-chat');
failBeforeCommit=true;
await assert.rejects(api.patchChatChunkManifest(failKey,[{hash:1,text:'vector may have been inserted',metadata:{messageIds:[1]}}],'failed-chat'),/failed/i);
await assert.rejects(api.reconcileCollectionProfile(failKey),/verified database reconciliation/i);
assert.equal(value(failKey).profileSaveStatus,'failed');
console.log('PASS: uncommitted remote patch cannot be falsely marked repaired');
failLocalPatch=true;
await assert.rejects(api.patchChatChunkManifest(standardKey,[{hash:555,text:'native vector may exist',metadata:{messageIds:[555]}}],'native-uuid'),/storage write failure/i);
await assert.rejects(api.reconcileCollectionProfile(standardKey),/verified database reconciliation/i);
assert.equal(value(standardKey).profileSaveStatus,'failed');
console.log('PASS: failed native IndexedDB patch cannot be silently marked committed');
await api.retireChatChunkManifest(standardKey);
assert.equal(idb.has(standardKey),false,'purge must erase private manifest text from IndexedDB');
meta.delete(standardKey);
assert.equal(api.getChatChunkManifest(standardKey),null,'old in-process cache must not revive a purged collection');
console.log('PASS: verified deletion retires IndexedDB text and its memory cache');
console.log('7 local-manifest regression scenarios passed');
