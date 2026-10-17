/** P4 dependency-free contract suite. Run with node --experimental-vm-modules. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const dir = new URL('../',import.meta.url);
const code = p => fs.readFileSync(new URL(p,dir),'utf8');
let checks=0;
async function test(name,action){await action();checks++;console.log('PASS',name);}
async function load(file,imports,more={}){
  const context=vm.createContext({console,Date,JSON,Math,Number,Map,Set,String,structuredClone,fetch:more.fetch,...more});
  const module=new vm.SourceTextModule(code(file),{context,identifier:file});
  await module.link(async spec=>{
    const mod=imports[spec]||imports[spec.split('/').at(-1)];
    if(!mod)throw Error(`Missing mocked module ${spec}`);
    return new vm.SyntheticModule(Object.keys(mod),function(){for(const[k,v]of Object.entries(mod))this.setExport(k,v);},{context});
  });
  await module.evaluate();return module.namespace;
}
const records=new Map([
  ['qdrant:llamacpp:old',{replacedBy:'qdrant:llamacpp:new',enabled:false}],
  ['qdrant:llamacpp:new',{enabled:true}],
  ['qdrant:llamacpp:orphan',{enabled:false}],
]);
let purges=0,deleteSucceeds=true,owner=null;
const keys=[...records.keys()];
const parse=key=>{const [backend,source,...rest]=key.split(':');return {backend,source,collectionId:rest.join(':')};};
const maintenance=await load('core/collection-maintenance.js',{
  'collection-loader.js':{getCollectionRegistry:()=>keys,deleteCollection:async()=>{purges++;return deleteSucceeds?{success:true}:{success:false,errors:['HTTP 500']};}},
  'collection-metadata.js':{getCollectionMeta:key=>records.get(key)||{},isCollectionEnabled:key=>!!records.get(key)?.enabled},
  'collection-ownership.js':{getCollectionOwner:()=>owner},
  'vectorization-profile.js':{getCollectionProfile:key=>key.endsWith('new')?{embedding:{verified:true}}:null},
  'collection-ids.js':{parseRegistryKey:parse},
});
await test('only collections marked replaced are automatically classified as backups',()=>{
  const inventory=maintenance.getMaintenanceInventory();
  assert.equal(inventory.find(x=>x.id==='old').backupOf,'qdrant:llamacpp:new');
  assert.equal(inventory.find(x=>x.id==='orphan').backupOf,null);
});
await test('unknown or ambiguous collection refuses deletion',async()=>{
  await assert.rejects(maintenance.deleteConfirmedBackup('qdrant:llamacpp:orphan','qdrant:llamacpp:orphan',{}),/Not a confirmed/);
  assert.equal(purges,0);
});
await test('typed confirmation is required for backup deletion',async()=>{
  await assert.rejects(maintenance.deleteConfirmedBackup('qdrant:llamacpp:old','old',{}),/Type the complete/);
  assert.equal(purges,0);
});
await test('disabled and unowned backup only; prevent active-owner or retrieval-enabled deletion',async()=>{
  owner='chat-a';
  await assert.rejects(maintenance.deleteConfirmedBackup('qdrant:llamacpp:old','qdrant:llamacpp:old',{}),/owns/);
  owner=null;records.get('qdrant:llamacpp:old').enabled=true;
  await assert.rejects(maintenance.deleteConfirmedBackup('qdrant:llamacpp:old','qdrant:llamacpp:old',{}),/Disable/);
  records.get('qdrant:llamacpp:old').enabled=false;
});
await test('backend failure never reports successful deletion',async()=>{
  deleteSucceeds=false;
  await assert.rejects(maintenance.deleteConfirmedBackup('qdrant:llamacpp:old','qdrant:llamacpp:old',{}),/HTTP 500/);
  deleteSucceeds=true;
});
await test('successful explicit backup deletion routes to original backend',async()=>{
  let seen;
  const mod=await load('core/collection-maintenance.js',{
    'collection-loader.js':{getCollectionRegistry:()=>keys,deleteCollection:async(id,opts,key)=>{seen={id,opts,key};return{success:true};}},
    'collection-metadata.js':{getCollectionMeta:key=>records.get(key)||{},isCollectionEnabled:key=>!!records.get(key)?.enabled},
    'collection-ownership.js':{getCollectionOwner:()=>null},
    'vectorization-profile.js':{getCollectionProfile:()=>null},'collection-ids.js':{parseRegistryKey:parse},
  });
  await mod.deleteConfirmedBackup('qdrant:llamacpp:old','qdrant:llamacpp:old',{source:'ollama',vector_backend:'standard'});
  assert.equal(seen.key,'qdrant:llamacpp:old');assert.equal(seen.opts.source,'llamacpp');assert.equal(seen.opts.vector_backend,'qdrant');
});
const embedded=await load('core/embedding-verification.js',{
  'backend-manager.js':{getBackend:async()=>({listChunks:async()=>({items:[{hash:7,text:'some remembered text',vector:[1,0,0]},{hash:8,text:'mismatch',vector:[0,1,0]},{hash:9,text:'no vector',vector:null}]})})},
  'provider-params.js':{getProviderSpecificParams:()=>({apiUrl:'http://llama:1024'})},
  'providers.js':{getModelField:()=>null},'script.js':{getRequestHeaders:()=>({})},
  'collection-ids.js':{parseRegistryKey:parse},
  'vectorization-profile.js':{getCollectionProfile:()=>({embedding:{verified:true}}),settingsForSavedCollection:(_k,s)=>s,applyAndVerifyProfile:async(_k,s)=>({settings:s})},
},{fetch:async(_u,opts)=>({ok:true,json:async()=>({embedding:JSON.parse(opts.body).text==='some remembered text'?[1,0,0]:[1,0,0]})})});
await test('vector cosine reports mismatched dimensions and invalid values as unknown',()=>{
  assert.equal(embedded.cosineSimilarity([1,0],[1]),null);
  assert.equal(embedded.cosineSimilarity([NaN,0],[1,0]),null);
  assert.ok(Math.abs(embedded.cosineSimilarity([1,0,0],[1,0,0])-1)<1e-9);
});
await test('deep verification is read-only and distinguishes suspect/unavailable samples',async()=>{
  const result=await embedded.verifyEmbeddingSamples('qdrant:llamacpp:old',{vector_backend:'qdrant',source:'llamacpp'}, {maxSamples:3});
  assert.equal(result.passed,1);assert.equal(result.suspicious.length,1);assert.equal(result.unverifiable.length,1);
});
let capabilities={success:true,modelId:'embed',limits:{maxTokens:100}};
let tokenizeAvailable=true;
const overflow=await load('core/embedding-overflow.js',{
  'provider-params.js':{getProviderSpecificParams:()=>({apiUrl:'http://ollama:11434'})},
  'script.js':{getRequestHeaders:()=>({})},
},{fetch:async(uri,options)=>{
  const body=JSON.parse(options.body);
  if(uri.endsWith('/capabilities'))return{ok:true,json:async()=>capabilities};
  if(!tokenizeAvailable)return{ok:false,status:422,text:async()=> 'Tokenizer unavailable'};
  return{ok:true,json:async()=>({count:body.text.length})};
}});
await test('provider token-budget applies to Ollama with configured cap',async()=>{
  const budget=await overflow.getEmbeddingBudget({source:'ollama',embedding_max_tokens:40,ollama_model:'embed'});
  assert.equal(budget,34);
});
await test('long Ollama text splits losslessly with a supported exact tokenizer',async()=>{
  const item={hash:99,text:'Some quite long paragraph that needs splitting. Another equally long paragraph!',metadata:{strategy:'per_message'}};
  const result=await overflow.prepareEmbeddingItems([item],{source:'ollama',embedding_max_tokens:40,ollama_model:'embed'},String);
  assert.ok(result.length>1);
  assert.equal(result.map(p=>p.text).join(''),item.text);
  assert.ok(result.every(p=>p.metadata.parentHash===99));
});
await test('Ollama without tokenizer uses conservative splitting; server enforces truncate:false',async()=>{
  tokenizeAvailable=false;
  const input={hash:1,text:'a lengthy input requiring multiple chunks and a functional tokenizer',metadata:{}};
  const split=await overflow.prepareEmbeddingItems([input],{source:'ollama',embedding_max_tokens:40,ollama_model:'embed'},String);
  assert.ok(split.length>1);
  assert.equal(split.map(row=>row.text).join(''),input.text);
});
await test('other providers are not split by speculative character/token estimates',async()=>{
  const orig=[{hash:1,text:'very long content'}];
  const items=await overflow.prepareEmbeddingItems(orig,{source:'openai',embedding_max_tokens:4},String);
  assert.equal(items,orig);
});
await test('Database Browser has opt-in maintenance UI and never hijacks Live Status',()=>{
  const db=code('ui/database-browser.js');
  const ui=code('ui/collection-maintenance.js');
  assert.match(db,/data-tab="maintenance"/);assert.match(db,/renderCollectionMaintenance/);
  assert.match(ui,/Restore original settings/);assert.match(ui,/Safely re-vectorize into a NEW collection/);
  assert.match(ui,/getChatBinding\(getChatUUID\(\)\)/);
  assert.match(code('core/vectorization-profile.js'),/must be explicitly connected read-only/);
});
console.log(`\n${checks} P4 regression checks passed`);
