import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const script = fs.readFileSync(new URL('../core/collection-loader.js', import.meta.url), 'utf8');
async function createLoader({ registry = ['qdrant:openai:shared'], backend = 'qdrant', source = 'openai', chatId = null } = {}) {
  const events = { health: true, rows: [], failCatalogue: false, catalogueComplete: false, coverage:['vectra','lancedb'], probes: [], calls: [], onFetch: null, savedHashes: null, activeChatId:chatId };
  const settings = {vector_backend:backend, source};
  const data = { vecthare_collection_registry:[...registry], collections:{} };
  const headers = {'content-type':'application/json'};
  const respond = (ok, body, status=ok?200:503) => ({ok,status,json:async()=>body});
  const ctx = vm.createContext({console:{log(){},warn(){},error(){},debug(){}},setTimeout,clearTimeout,
    fetch: async (url) => {
      events.calls.push(url);
      if (events.onFetch) return events.onFetch(url, respond);
      if (url.endsWith('/health')) return respond(events.health,{status:events.health?'ok':'down'});
      if (url.endsWith('/collections')) {
        if(events.failCatalogue) return respond(false,{error:'offline'});
        return respond(true,{success:true,collections:events.rows,catalogueComplete:events.catalogueComplete,coverage:events.coverage,ownershipVerified:false});
      }
      throw Error('Unexpected route: '+url);
    }});
  const key = value => {
    if(typeof value!=='string')return null;
    const [backend,source,...id]=value.split(':');
    return ['standard','vectra','qdrant','milvus','lancedb'].includes(backend)&&source&&id.length
      ?{backend,source,collectionId:id.join(':')}:null;
  };
  const imports = {
    '../utils/e03-mutation-lock.js':{withCrossTabMutationLock:async(_k,fn)=>fn()},
    '../utils/e02-vector-request-gateway.js':{guardedVectorFetch:(...a)=>ctx.fetch(...a)},
    '../backends/backend-manager.js':{getBackendForCollection:async()=>null},
    '../utils/c11-adapter-inventory.js':{inspectAdapterInventory:async()=>({})},
    '../utils/keyed-mutex.js':{withCollectionLock:async(_k,fn)=>fn()},
    './destructive-safety.js':{guardDelete:()=>false,isGeneratedDiagnosticCollectionId:()=>false},
    '../utils/c01-deletion.js':{deleteCollectionSafely:async()=>({success:false}),recoverTombstones:()=>[]},
    '../utils/backend-contracts.js':{hasVerifiedCapability:()=>false},
    '../../../../extensions.js':{extension_settings:{vecthare:data},getContext:()=>({chatId:events.activeChatId})},
    '../../../../../script.js':{characters:[],substituteParams:x=>x,getRequestHeaders:()=>headers,saveSettingsDebounced:()=>{}},
    './core-vector-api.js':{getSavedHashes:async (id,s)=>{events.probes.push({id,backend:s.vector_backend,source:s.source});return events.savedHashes ? events.savedHashes(id,s) : ['found'];},queryCollection:async()=>[],purgeVectorIndex:async()=>{}},
    '../../../../utils.js':{getStringHash:()=>1},
    './collection-metadata.js':{isCollectionEnabled:()=>true,setCollectionEnabled:()=>{},getChunkMetadata:()=>({}),saveChunkMetadata:()=>{},deleteChunkMetadata:()=>{},deleteCollectionMeta:()=>{},ensureCollectionMeta:()=>{},getCollectionMeta:()=>({})},
    './collection-ids.js':{getChatUUID:()=>events.activeChatId,buildChatCollectionId:()=>events.activeChatId?'vecthare_chat_'+events.activeChatId:null,buildLegacyChatCollectionId:()=>events.activeChatId?'vecthare_chat_'+events.activeChatId:null,parseCollectionId:()=>({type:'chat',scope:'chat',rawId:'x'}),buildChatSearchPatterns:()=>chatId?[chatId]:[],matchesPatterns:(v,patterns)=>patterns.some(p=>v.includes(p)),parseRegistryKey:v=>key(v)??{backend:null,source:null,collectionId:v},resolveCollectionKey:()=>({status:'none'}),parseCollectionKey:key,COLLECTION_PREFIXES:{VECTHARE_CHAT:'vecthare_chat_',VECTHARE_CHARACTER:'vecthare_character_',VECTHARE_LOREBOOK:'vecthare_lorebook_',VECTHARE_DOCUMENT:'vecthare_document_',FILE:'file_'}}
  };
  const linked = new Map();
  const mod = new vm.SourceTextModule(script,{context:ctx,identifier:'collection-loader'});
  await mod.link(spec=>{
    if(!linked.has(spec)){
      assert.ok(imports[spec],`Unexpected dependency ${spec}`);
      linked.set(spec,new vm.SyntheticModule(Object.keys(imports[spec]),function(){for(const [k,v] of Object.entries(imports[spec]))this.setExport(k,v);},{context:ctx,identifier:spec}));
    }
    return linked.get(spec);
  });
  await mod.evaluate();
  return {api:mod.namespace,events,settings,data};
}

test('PB15: health failure recovers without page reload; catalogue refresh drops stale counts',async()=>{
  const {api,events,settings,data}=await createLoader();
  events.health=false;
  await api.discoverExistingCollections(settings);
  events.health=true;
  events.rows=[{id:'shared',backend:'qdrant',source:'openai',chunkCount:9}];
  assert.deepEqual(Array.from(await api.discoverExistingCollections(settings)),['qdrant:openai:shared']);
  const first=await api.loadAllCollections(settings,false);
  assert.equal(first[0].chunkCount,9);
  events.failCatalogue=true;
  await api.discoverExistingCollections(settings);
  const second=await api.loadAllCollections(settings,false);
  assert.equal(second[0].chunkCount,1,'must use fresh scoped probe, not previous nine-record catalogue');
  assert.deepEqual(Array.from(data.vecthare_collection_registry),['qdrant:openai:shared']);
  assert.equal(events.calls.filter(x=>x.endsWith('/health')).length,3);
});

test('PB15: qualified owner cannot silently probe standard or a different configured backend',async()=>{
  const {api,events,settings}=await createLoader({backend:'milvus'});
  events.health=false;
  assert.equal((await api.loadAllCollections(settings)).length,0);
  assert.equal(events.probes.length,0);
  settings.vector_backend='qdrant';
  assert.equal((await api.loadAllCollections(settings)).length,1);
  assert.deepEqual(events.probes.map(p=>p.backend),['qdrant','qdrant']);
  settings.source='cohere';
  assert.equal((await api.loadAllCollections(settings)).length,0);
  assert.equal(events.probes.length,2);
});

test('PB15: Vectra discovery is supported; duplicate catalogue owners cannot silently overwrite count',async()=>{
  const {api,events,settings}=await createLoader({registry:['vectra:openai:x'],backend:'vectra'});
  events.rows=[{id:'x',source:'openai',backend:'vectra',chunkCount:12}];
  assert.deepEqual(Array.from(await api.discoverExistingCollections(settings)),['vectra:openai:x']);
  assert.equal((await api.loadAllCollections(settings,false))[0].chunkCount,12);
  events.rows.push({...events.rows[0],chunkCount:42},{...events.rows[0],chunkCount:100});
  assert.deepEqual(Array.from(await api.discoverExistingCollections(settings)),[]);
  assert.equal((await api.loadAllCollections(settings,false))[0].chunkCount,1);
});

test('PB16: late catalogue response cannot resurrect data after a newer failed refresh',async()=>{
  const {api,events,settings}=await createLoader({registry:['qdrant:openai:chat_123']});
  let releaseOlder;
  const olderCatalogue = new Promise(resolve=>{releaseOlder=resolve;});
  let calls=0;
  events.onFetch=async (url,respond)=>{
    if(url.endsWith('/health')) return respond(true,{status:'ok'});
    if(url.endsWith('/collections')) {
      calls++;
      if(calls===1) return olderCatalogue;
      return respond(false,{error:'offline'});
    }
    throw Error('Unexpected '+url);
  };
  const first=api.discoverExistingCollections(settings);
  // Allow the first health request to settle and catalogue fetch to start.
  while (calls===0) await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(Array.from(await api.discoverExistingCollections(settings)),['qdrant:openai:chat_123'],
    'catalogue failure may fall back to fresh scoped reads, but not stale plugin rows');
  releaseOlder({ok:true,json:async()=>({success:true,collections:[{id:'chat_123',backend:'qdrant',source:'openai',chunkCount:77}]})});
  assert.deepEqual(Array.from(await first),[], 'superseded discovery cannot publish old results');
  assert.equal((await api.loadAllCollections(settings,false))[0].chunkCount,1,'no stale count must survive');
});

test('PB16: stale or wrong-tenant registered chat does not enable auto-sync',async()=>{
  const {api,events,settings,data}=await createLoader({chatId:'chat_123',registry:[
    'milvus:openai:vecthare_chat_chat_123',
    'qdrant:cohere:vecthare_chat_chat_123',
    'qdrant:openai:vecthare_chat_chat_123',
  ]});
  events.health=false;
  events.savedHashes=()=>[];
  const missing=await api.doesChatHaveVectors(settings);
  assert.equal(missing.hasVectors,false,'zero vectors in selected backend must not be accepted');
  assert.ok(events.probes.every(p=>p.backend==='qdrant'&&p.source==='openai'));
  assert.deepEqual(Array.from(data.vecthare_collection_registry),[
    'milvus:openai:vecthare_chat_chat_123',
    'qdrant:cohere:vecthare_chat_chat_123',
    'qdrant:openai:vecthare_chat_chat_123',
  ],'unverified entries are retained for manual review, not purged');
  events.probes.length=0;
  events.savedHashes=id=>id==='vecthare_chat_chat_123'?['one','two']:[];
  const found=await api.doesChatHaveVectors(settings);
  assert.equal(found.hasVectors,true);
  assert.equal(found.registryKey,'qdrant:openai:vecthare_chat_chat_123');
  assert.equal(found.chunkCount,2);
  assert.equal(found.allMatches.length,1);
});

test('PB18: malformed advisory counts cannot create ghost collection cards or corrupt totals',async()=>{
  const {api,events,settings}=await createLoader({registry:['qdrant:openai:shared']});
  for(const count of ['10',-1,Number.MAX_SAFE_INTEGER+1,null]){
    events.rows=[{id:'shared',backend:'qdrant',source:'openai',chunkCount:count}];
    assert.deepEqual(Array.from(await api.discoverExistingCollections(settings)),['qdrant:openai:shared']);
    const loaded=await api.loadAllCollections(settings,false);
    assert.equal(loaded.length,1);
    assert.equal(loaded[0].chunkCount,1,'invalid catalogue must fall back to scoped physical probe');
  }
});

test('PB18: malformed model rows cannot turn a valid collection into an invisible browser card',async()=>{
  const {api,events,settings}=await createLoader({registry:['vectra:openai:shared'],backend:'vectra'});
  events.rows=[{id:'shared',backend:'vectra',source:'openai',chunkCount:5,
    models:[{path:'model-a',chunkCount:'not-a-number'}]}];
  assert.deepEqual(Array.from(await api.discoverExistingCollections(settings)),[]);
  assert.equal((await api.loadAllCollections(settings,false))[0].chunkCount,1);
  events.rows=[{id:'shared',backend:'vectra',source:'openai',chunkCount:5,
    model:'model-a',models:[{path:'model-a',chunkCount:5}]}];
  assert.deepEqual(Array.from(await api.discoverExistingCollections(settings)),['vectra:openai:shared']);
  assert.equal((await api.loadAllCollections(settings,false))[0].chunkCount,5);
});


test('PB19: chat-vector discovery only accepts exact legacy or UUID-suffixed owners',async()=>{
  const {api,events,settings}=await createLoader({chatId:'chat_123',registry:[
    'qdrant:openai:vecthare_chat_alice_chat_1234',
    'qdrant:openai:vecthare_chat_alice_chat_123',
    'qdrant:openai:vecthare_chat_bob_chat_123_more',
    'qdrant:openai:vecthare_chat_chat_123',
    'qdrant:openai:vecthare_chat_amy_chat_123_2',
  ]});
  const result=await api.doesChatHaveVectors(settings);
  assert.equal(result.hasVectors,true);
  assert.equal(result.allMatches.length,2);
  assert.deepEqual(events.probes.map(p=>p.id),[
    'vecthare_chat_alice_chat_123','vecthare_chat_chat_123',
  ]);
});

test('PB19: an in-flight probe cannot answer after backend/source or chat switch',async()=>{
  for(const change of ['backend','source','chat']){
    const {api,events,settings}=await createLoader({chatId:'chat_123',registry:['qdrant:openai:vecthare_chat_alice_chat_123']});
    let release, started;
    const entered=new Promise(r=>{started=r;});
    events.savedHashes=()=>{started();return new Promise(r=>{release=r;});};
    const pending=api.doesChatHaveVectors(settings);
    await entered;
    if(change==='backend')settings.vector_backend='milvus';
    if(change==='source')settings.source='cohere';
    if(change==='chat')events.activeChatId='chat_999';
    release(['present']);
    const result=await pending;
    assert.equal(result.hasVectors,false,`stale ${change} must not answer`);
  }
});

test('PB19: direct legacy hash fallback remains discoverable but never auto-registers an unverified owner',async()=>{
  const {api,events,settings,data}=await createLoader({chatId:'chat_123',registry:[]});
  events.health=false;
  events.savedHashes=id=>id==='vecthare_chat_chat_123'?['one']:[];
  const found=await api.doesChatHaveVectors(settings);
  assert.equal(found.hasVectors,true);
  assert.equal(found.collectionId,'vecthare_chat_chat_123');
  assert.equal(found.unregisteredLegacy,true);
  assert.deepEqual(Array.from(data.vecthare_collection_registry),[]);
});

test('PB20: healthy plugin with failed catalogue falls back to selected-owner reads',async()=>{
  const {api,events,settings,data}=await createLoader({registry:['qdrant:openai:shared']});
  events.failCatalogue=true;
  const result=await api.discoverExistingCollections(settings);
  assert.deepEqual(Array.from(result),['qdrant:openai:shared']);
  assert.deepEqual(events.probes.map(p=>p.backend),['qdrant']);
  assert.deepEqual(Array.from(data.vecthare_collection_registry),['qdrant:openai:shared']);
});

test('PB20: successful empty local catalogue still allows a scoped registered remote read',async()=>{
  const {api,events,settings}=await createLoader({registry:['qdrant:openai:shared']});
  events.rows=[];
  assert.deepEqual(Array.from(await api.discoverExistingCollections(settings)),['qdrant:openai:shared']);
  assert.deepEqual(events.probes.map(x=>x.backend),['qdrant']);
});


test('PB22: partial local catalogue supplements only registered collections on an uncovered selected backend',async()=>{
  const {api,events,settings,data}=await createLoader({registry:[
    'qdrant:openai:shared','milvus:openai:foreign','qdrant:cohere:another',
    'unqualified_legacy'
  ]});
  events.rows=[{id:'local',backend:'vectra',source:'openai',chunkCount:12}];
  const result=await api.discoverExistingCollections(settings);
  assert.deepEqual(Array.from(result),['vectra:openai:local','qdrant:openai:shared']);
  assert.deepEqual(events.probes.map(x=>x.id),['shared']);
  assert.deepEqual(Array.from(data.vecthare_collection_registry),[
    'qdrant:openai:shared','milvus:openai:foreign','qdrant:cohere:another','unqualified_legacy'
  ]);
});

test('PB22: covered local backend avoids needless fallback and unverified remote is not invented',async()=>{
  const {api,events,settings}=await createLoader({registry:['vectra:openai:missing'],backend:'vectra'});
  events.rows=[];
  assert.deepEqual(Array.from(await api.discoverExistingCollections(settings)),[]);
  assert.equal(events.probes.length,0);
  settings.vector_backend='qdrant';
  assert.deepEqual(Array.from(await api.discoverExistingCollections(settings)),[]);
  assert.equal(events.probes.length,0);
});

test('PB22: failed remote physical check does not claim a collection or remove registry entry',async()=>{
  const {api,events,settings,data}=await createLoader({registry:['qdrant:openai:shared']});
  events.savedHashes=()=>[];
  assert.deepEqual(Array.from(await api.discoverExistingCollections(settings)),[]);
  assert.equal(events.probes.length,1);
  assert.deepEqual(Array.from(data.vecthare_collection_registry),['qdrant:openai:shared']);
});

test('PB22: backend/source switch during uncovered-backend read discards stale discovery',async()=>{
  const {api,events,settings}=await createLoader({registry:['qdrant:openai:shared']});
  let release, started;
  const entered=new Promise(resolve=>{started=resolve});
  events.savedHashes=()=>{started();return new Promise(resolve=>{release=resolve});};
  const pending=api.discoverExistingCollections(settings);
  await entered;
  settings.source='cohere';
  release(['found']);
  assert.deepEqual(Array.from(await pending),[]);
});
