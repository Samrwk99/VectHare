/** New audit P0 #1–4. Run: node tests/p0-final-data-safety.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read=rel=>fs.readFileSync(new URL('../'+rel,import.meta.url),'utf8');
const parse=src=>src.replace(/^import\s+\{[\s\S]*?\}\s+from\s+['"][^'"]+['"];?\s*$/gm,'').replace(/^import\s+[^\n]+\s+from\s+['"][^'"]+['"];?\s*$/gm,'').replace(/^export /gm,'');
const parseRegistryKey=key=>{const parts=String(key||'').split(':');return parts.length>=3?{backend:parts[0],source:parts[1],collectionId:parts.slice(2).join(':')}:{backend:null,source:null,collectionId:key||''}};
let passes=0;
async function check(name,fn){await fn();passes++;console.log('PASS',name)}
const settings={vector_backend:'qdrant',source:'llamacpp',qdrant_host:'127.0.0.1',qdrant_port:6333,qdrant_multitenancy:false};
const ext={vecthare:{...settings,collections:{},vecthare_collection_registry:[],chatCollectionBindings:{}}};
const physicalCtx=vm.createContext({console,URL,Object,Number,Date,String,Set,Math,parseRegistryKey,extension_settings:ext,saveSettingsDebounced(){}});
vm.runInContext(parse(read('core/physical-identity.js')),physicalCtx);
await check('new collection claims its original physical Qdrant destination',()=>{
    physicalCtx.claimQdrantIdentity('qdrant:llamacpp:vecthare_chat_test',settings);
    assert.ok(ext.vecthare.qdrantPhysicalIdentities['qdrant:llamacpp:vecthare_chat_test'].includes('127.0.0.1'));
});
await check('same-name collection on another Qdrant host cannot be read/written/deleted',()=>{
    assert.throws(()=>physicalCtx.assertQdrantIdentity('qdrant:llamacpp:vecthare_chat_test',{...settings,qdrant_host:'10.2.3.4'}),/DIFFERENT Qdrant server/);
});
await check('multitenancy changes are incompatible even at same URL',()=>{
    assert.throws(()=>physicalCtx.assertQdrantIdentity('qdrant:llamacpp:vecthare_chat_test',{...settings,qdrant_multitenancy:true}),/DIFFERENT/);
});
await check('known legacy collection never inherits arbitrary new Qdrant host',()=>{
    ext.vecthare.vecthare_collection_registry.push('qdrant:llamacpp:vecthare_chat_old');
    assert.throws(()=>physicalCtx.assertQdrantIdentity('qdrant:llamacpp:vecthare_chat_old',settings),/no confirmed physical-server/);
    physicalCtx.confirmLegacyQdrantServer(settings);
    assert.ok(physicalCtx.assertQdrantIdentity('qdrant:llamacpp:vecthare_chat_old',settings));
});
await check('explicit legacy migration cannot relabel a confirmed server',()=>{
    assert.throws(()=>physicalCtx.confirmLegacyQdrantServer({...settings,qdrant_host:'10.1.2.3'}),/Refusing/);
});
ext.vecthare.vecthare_collection_registry=[];

let busy=false;
let discovered=[{backend:'qdrant',collectionId:'vecthare_chat_test',multitenancy:false}];
let inventoryOk=true,backendOk=true,deleteOk=true,pretendDelete=false,after=[];
const purgeCtx=vm.createContext({console,Object,Array,Set,Math,JSON,String,Error,parseRegistryKey,
    extension_settings:ext, getRequestHeaders:()=>({}),saveSettingsDebounced(){},
    getCollectionRegistry:()=>ext.vecthare.vecthare_collection_registry,
    getBackend:async(opts)=>{if(!backendOk)throw Error('backend offline');return {
        initialize:async()=>{},
        purgeVectorIndex:async id=>{if(!deleteOk)throw Error('incomplete purge');if(!pretendDelete)discovered=discovered.filter(row=>!(row.collectionId===id && row.backend===(opts.vector_backend||'standard')));return true;},
    };},
    assertQdrantIdentity:(key,s)=>physicalCtx.assertQdrantIdentity(key,s),
    qdrantDestination:(s)=>physicalCtx.qdrantDestination(s),
    unregisterCollection:key=>{ext.vecthare.vecthare_collection_registry=ext.vecthare.vecthare_collection_registry.filter(x=>x!==key)},
    deleteCollectionMeta:key=>{delete ext.vecthare.collections[key]},
    retireChatChunkManifest:async()=>{},
    forgetDeletedCollection:()=>{},
    forgetQdrantIdentity:(key)=>{delete ext.vecthare.qdrantPhysicalIdentities[key]},
    hasActiveVectorWrite:()=>busy,
    createOperationControl:()=>{busy=true;},detachOperationControl:()=>{busy=false;},
    clearAllRecovery(){},clearRecoveryForCollection(){},
    fetch:async()=>({ok:inventoryOk,status:inventoryOk?200:500,text:async()=>'offline',json:async()=>({success:true,targets:discovered,qdrantScanned:true,qdrantInitialized:true,qdrantEndpoint:'http://127.0.0.1:6333'})}),
});
vm.runInContext(parse(read('core/safe-purge.js')),purgeCtx);
ext.vecthare.vecthare_collection_registry.push('qdrant:llamacpp:vecthare_chat_test');
await check('purge preflight refuses destructive operation while another write is running',async()=>{
    busy=true;
    await assert.rejects(purgeCtx.planVectHarePurge(settings),/another vector-writing operation/i);
    busy=false;
});
await check('purge preflight refuses a backend inventory failure before delete',async()=>{
    inventoryOk=false;
    await assert.rejects(purgeCtx.planVectHarePurge(settings),/inventory/);
    inventoryOk=true;
});
await check('purge preflight fails closed when plugin is connected to a different Qdrant server',async()=>{
    const original=purgeCtx.fetch;
    purgeCtx.fetch=async()=>({ok:true,json:async()=>({success:true,targets:discovered,qdrantScanned:true,qdrantInitialized:true,qdrantEndpoint:'http://10.0.0.23:6333'})});
    await assert.rejects(purgeCtx.planVectHarePurge(settings),/DIFFERENT Qdrant server/);
    purgeCtx.fetch=original;
});
await check('purge preflight refuses untracked backend collections',async()=>{
    discovered=[{backend:'qdrant',collectionId:'vecthare_chat_untracked',multitenancy:false}];
    await assert.rejects(purgeCtx.planVectHarePurge(settings),/Untracked/);
    discovered=[{backend:'qdrant',collectionId:'vecthare_chat_test',multitenancy:false}];
});
await check('purge preflight refuses missing metadata targets and unrelated backends',async()=>{
    ext.vecthare.vecthare_collection_registry.push('standard:llamacpp:vecthare_chat_other');
    await assert.rejects(purgeCtx.planVectHarePurge(settings),/Inventory did not confirm/);
    ext.vecthare.vecthare_collection_registry.pop();
});
await check('failed deletion preserves all settings and failed collection records',async()=>{
    const plan=await purgeCtx.planVectHarePurge(settings);
    deleteOk=false;
    await assert.rejects(purgeCtx.executeVectHarePurge(settings,plan,{resetSettings:true}),/Partial purge/);
    assert.ok(ext.vecthare.vecthare_collection_registry.includes('qdrant:llamacpp:vecthare_chat_test'));
    assert.equal(ext.vecthare.qdrant_host,'127.0.0.1');
    deleteOk=true;
});
await check('a 200 response with remaining vectors preserves settings and metadata',async()=>{
    pretendDelete=true;
    const plan=await purgeCtx.planVectHarePurge(settings);
    await assert.rejects(purgeCtx.executeVectHarePurge(settings,plan,{resetSettings:true}),/still exists/);
    assert.ok(ext.vecthare.vecthare_collection_registry.includes('qdrant:llamacpp:vecthare_chat_test'));
    pretendDelete=false;
});
await check('data-only purge preserves provider settings and removes only confirmed tracking',async()=>{
    ext.vecthare.collections['qdrant:llamacpp:vecthare_chat_test']={displayName:'test',
        vectorizationProfile:{chunking:{strategy:'per_message'}},
        chatChunkManifest:{entries:[{text:'private data'}]},chunkCount:1};
    const plan=await purgeCtx.planVectHarePurge(settings);
    const result=await purgeCtx.executeVectHarePurge(settings,plan,{resetSettings:false});
    assert.deepEqual(Array.from(result.completed),['vecthare_chat_test']);
    assert.equal(ext.vecthare.qdrant_host,'127.0.0.1');
    assert.ok(!ext.vecthare.vecthare_collection_registry.includes('qdrant:llamacpp:vecthare_chat_test'));
    const archive=ext.vecthare.archivedCollectionConfigurations?.['qdrant:llamacpp:vecthare_chat_test'];
    assert.ok(archive.settings.vectorizationProfile);
    assert.equal(archive.settings.chatChunkManifest,undefined,'purge must not archive deleted message data');
});

await check('mixed Standard/Qdrant purge uses separate backend-scoped deletes and resets only afterward',async()=>{
    const q='qdrant:llamacpp:vecthare_chat_new';
    const st='standard:llamacpp:vecthare_chat_new';
    ext.vecthare.vecthare_collection_registry.push(q,st);
    ext.vecthare.qdrantPhysicalIdentities[q]='qdrant:v1:http://127.0.0.1:6333:multitenancy=false';
    discovered=[{backend:'standard',collectionId:'vecthare_chat_new',source:'llamacpp'},
        {backend:'qdrant',collectionId:'vecthare_chat_new',multitenancy:false}];
    const plan=await purgeCtx.planVectHarePurge(settings);
    assert.equal(plan.count,2);
    const result=await purgeCtx.executeVectHarePurge(settings,plan,{resetSettings:true});
    assert.equal(result.completed.length,2);
    assert.equal(ext.vecthare.qdrant_host,undefined,'reset must occur only after both backends are confirmed');
    assert.equal(discovered.length,0);
});

const imported=[];
const originalKey='standard:llamacpp:vecthare_chat_old';
const oldMeta={enabled:true};const savedMeta=new Map([[originalKey,oldMeta]]);
let failInsert=false,originalBound=originalKey,replaceDeletes=0;
const importCtx=vm.createContext({console,Object,Array,Map,Set,JSON,Math,Date,String,Number,Error,structuredClone,
    assignOccurrenceIds:items=>items,
    getStringHash:text=>String(text).split('').reduce((a,ch)=>a+ch.charCodeAt(0),0),
    getModelField:()=> 'embedding_model',
    discoverEmbeddingModel:async()=>({verified:true,modelId:'M'}),
    makeCollectionProfile:async()=>({schemaVersion:1,embedding:{provider:'llamacpp',modelId:'M',verified:true}}),
    getCollectionRegistry:()=>[originalKey],
    getChatBinding:()=>({registryKey:originalBound}),getCollectionOwner:key=>key===originalKey?'chat-a':null,
    bindChatCollection:(_owner,key)=>{originalBound=key},
    setCollectionMeta:(key,val)=>savedMeta.set(key,{...(savedMeta.get(key)||{}),...val}),
    getCollectionMeta:key=>savedMeta.get(key)||{},
    saveCollectionProfile:async()=>{},registerCollection:()=>{},saveSettingsDebounced(){},saveChunkMetadata(){},
    assertQdrantIdentity:()=>{},claimQdrantIdentity:()=>{},
    hasActiveVectorWrite:()=>false,createOperationControl:()=>{},detachOperationControl:()=>{},
    getBackend:async()=>({listChunks:async id=>({items:imported.filter(row=>row.destination===id)}),
        insertVectorItems:async(id,chunks)=>{
            if(failInsert)throw Error('embedding request failed');
            for(const chunk of chunks)imported.push({...chunk,destination:id});
        }}),
    insertVectorItems:async(id,chunks)=>{
        if(failInsert)throw Error('embedding request failed');
        for(const chunk of chunks)imported.push({...chunk,destination:id});
    },
    progressTracker:{show(){},updateCurrentItem(){},updateProgress(){},updateChunks(){},addError(){},complete(){}},
});
vm.runInContext(parse(read('core/collection-export.js')),importCtx);
const file={collection:{id:'vecthare_chat_old',name:'Old'},chunks:[{hash:42,text:'hello'}],vectorizationProfile:{schemaVersion:1,embedding:{provider:'llamacpp',modelId:'M',verified:true}}};
await check('failed staged overwrite never deletes old collection or switches binding',async()=>{
    failInsert=true;
    await assert.rejects(importCtx.importCollectionSafely(file,{vector_backend:'standard',source:'llamacpp'},{overwrite:true}),/embedding request failed/);
    assert.equal(replaceDeletes,0);
    assert.equal(originalBound,originalKey);
    assert.equal(savedMeta.get(originalKey).enabled,true);
});
await check('successful staged overwrite verifies new chunks before switching binding',async()=>{
    failInsert=false;
    const result=await importCtx.importCollectionSafely(file,{vector_backend:'standard',source:'llamacpp'},{overwrite:true});
    assert.equal(result.previousCollectionPreserved,true);
    assert.notEqual(result.collectionId,file.collection.id);
    assert.equal(originalBound,'standard:llamacpp:'+result.collectionId);
    assert.equal(savedMeta.get(originalKey).enabled,false);
    assert.equal(replaceDeletes,0);
});
await check('legacy blanket plugin purge is disabled and new inventory exists',()=>{
    const plugin=fs.readFileSync(new URL('../../VectFox-Similharity-Plugin/index.js',import.meta.url),'utf8');
    assert.match(plugin,/router\.post\('\/purge-all',[\s\S]{0,120}status\(410\)/);
    assert.match(plugin,/router\.get\('\/vecthare\/purge-inventory'/);
});
await check('browser data-only button never offers reset and Actions offers both modes',()=>{
    const browser=read('ui/database-browser.js'),index=read('index.js');
    assert.match(browser,/id="vecthare_browser_purge_data"/);
    assert.match(browser,/openPurgeDialog\(browserState\.settings,\{allowReset:false\}\)/);
    assert.match(index,/openPurgeDialog\(settings,\{allowReset:true\}\)/);
});
console.log(`\n${passes} NEW P0 data-safety regression checks passed`);
