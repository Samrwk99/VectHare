/** P1.0 independent configuration / durability regressions.
 * Run: node --experimental-vm-modules tests/p1-0-unified-config.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root=new URL('..',import.meta.url);
let passes=0;
async function check(name,fn){await fn();passes++;console.log('PASS',name);}
const source=name=>fs.readFileSync(new URL(name,root),'utf8');
function evaluate(name,mocks={}) {
 const ctx=vm.createContext({console,Date,Math,JSON,String,Number,Array,Set,Map,URL,structuredClone,globalThis,...mocks});
 vm.runInContext(source(name).replace(/^import\s+.*?\s+from\s+['"].*?['"];\s*$/gm,'').replace(/^export /gm,''),ctx,{filename:name});
 return ctx;
}
const hash=text=>{
 let h=0;for(const c of String(text))h=(Math.imul(31,h)+c.charCodeAt(0))|0;
 return h;
};
const id=evaluate('core/chunk-identity.js');
await check('identical message content gets two distinct numeric IDs with same contentHash',()=>{
 const x=id.assignOccurrenceIds([
 {text:'hello',hash:hash('hello'),metadata:{messageIds:[0]}},
 {text:'hello',hash:hash('hello'),metadata:{messageIds:[3]}}],hash);
 assert.equal(x.length,2);assert.notEqual(x[0].hash,x[1].hash);
 assert.ok(x.every(c=>Number.isInteger(c.hash)&&c.metadata.contentHash===hash('hello')));
 assert.deepEqual(x.map(c=>Array.from(c.metadata.messageIds)),[[0],[3]]);
});
await check('identities are deterministic across a restart and stable when appending later messages',()=>{
 const pair=[{text:'hello',hash:hash('hello'),metadata:{messageIds:[0]}},{text:'hello',hash:hash('hello'),metadata:{messageIds:[3]}}];
 const a=id.assignOccurrenceIds(pair,hash);const b=id.assignOccurrenceIds([...pair,{text:'again',hash:hash('again'),metadata:{messageIds:[5]}}],hash);
 assert.deepEqual(a.map(x=>x.hash),b.slice(0,2).map(x=>x.hash));
});
const globals={vecthare:{cleaning:{selectedPreset:'html_formatting',customPatterns:[],enabledBuiltins:[]}}};
const cleaner=evaluate('core/text-cleaning.js',{extension_settings:globals,uuidv4:()=> 'fake'});
await check('cleaning snapshot remains independent from global cleaning settings',()=>{
 const capture=cleaner.captureCleaningSnapshot('html_formatting');
 assert.ok(capture.resolvedPatterns.length>0);
 const before=cleaner.cleanText('<b>hello</b>',capture);
 globals.vecthare.cleaning={selectedPreset:'none',customPatterns:[],enabledBuiltins:[]};
 assert.equal(cleaner.cleanText('<b>hello</b>',capture),before);
 assert.notEqual(cleaner.cleanText('<b>hello</b>'),before);
});
await check('custom cleaning rules retain original regex even if global rule is changed',()=>{
 globals.vecthare.cleaning={selectedPreset:'custom',customPatterns:[{pattern:'Secret',replacement:'***',flags:'g',enabled:true}],enabledBuiltins:[]};
 const snapshot=cleaner.captureCleaningSnapshot();
 globals.vecthare.cleaning.customPatterns[0].replacement='REMOVED';
 assert.equal(cleaner.cleanText('Secret',snapshot),'***');
});
const metadata=new Map();const remote=new Map();let failRemote=false;let dropReadback=false;let model='alias-A';let vector=[1,0,0,0];
const transport=async(url,options={})=>{
 const body=options.body?JSON.parse(options.body):{};
 if(String(url).endsWith('/embedding/capabilities'))return {ok:true,json:async()=>({success:true,modelId:model,modelPath:'/model.gguf',limits:{maxTokens:2048}})};
 if(String(url).endsWith('/get-embedding'))return {ok:true,json:async()=>({embedding:vector})};
 if(String(url).endsWith('/profile/set')){
  if(failRemote)return {ok:false,status:500};
  remote.set(body.key,body);return {ok:true,json:async()=>({success:true})};
 }
 if(String(url).endsWith('/profile/get')){
  if(dropReadback)return {ok:false,status:404};
  const value=remote.get(body.key);return value?{ok:true,json:async()=>value}:{ok:false,status:404};
 }
 throw Error(`unexpected request: ${url}`);
};
const profile=evaluate('core/vectorization-profile.js',{
 hasManifestStorage:()=>false,readManifest:async()=>null,replaceManifest:async()=>{},patchManifest:async()=>{},
 CHUNK_IDENTITY_VERSION:2,captureCleaningSnapshot:(p)=>cleaner.captureCleaningSnapshot(p),
 withSharedWriteHeaders:x=>x,runExclusiveNativeMutation:(_l,_r,fn)=>fn(), extension_settings:{vecthare:{}},saveSettingsDebounced(){},flushVectHareSettings:async()=>{},getRequestHeaders:()=>({}),
 getProviderSpecificParams:s=>({apiUrl:s.alt_endpoint_url||'http://127.0.0.1:9977'}),
 getModelField:()=>null,
 parseRegistryKey:k=>{const [backend,source,...rest]=k.split(':');return {backend,source,collectionId:rest.join(':')};},
 getCollectionMeta:k=>metadata.get(k)||{},setCollectionMeta:(k,v)=>metadata.set(k,{...(metadata.get(k)||{}),...v}),
 fetch:transport,getBackend:async()=>({}),getChatUUID:()=>null,getChatBinding:()=>null,
 });
const BASE={source:'llamacpp',vector_backend:'qdrant',chunking_strategy:'conversation_turns',conversation_turn_order:'user_character',cleaning_preset:'html_formatting',alt_endpoint_url:'http://127.0.0.1:9977',qdrant_multitenancy:false};
await check('new collection saves complete versioned original recipe and verified model',async()=>{
 const key='qdrant:llamacpp:A';const recipe=await profile.makeCollectionProfile({...BASE,cleaning_snapshot:cleaner.captureCleaningSnapshot('html_formatting')});
 assert.equal(recipe.recipe.version,2);assert.equal(recipe.recipe.algorithmVersions.chunkIdentity,2);
 assert.equal(recipe.recipe.algorithmVersions.chunking,4);assert.equal(recipe.recipe.cleaning.resolvedPatterns.length>0,true);
 assert.equal(recipe.embedding.verified,true);assert.equal(recipe.embedding.modelId,'alias-A');
 await profile.saveCollectionProfile(key,recipe);assert.equal(metadata.get(key).profileSaveStatus,'committed');
});
await check('saving draft leaves original recipe unchanged and restores independently',async()=>{
 const key='qdrant:llamacpp:A';const original=profile.getCollectionProfile(key);
 profile.saveCollectionDraft(key,{model:'alias-B',chunking_strategy:'per_message'});
 const cfg=profile.getCollectionConfiguration(key);
 assert.equal(cfg.lastUsedDraft.model,'alias-B');assert.equal(cfg.originalRecipe.settings.chunking_strategy,'conversation_turns');
 assert.deepEqual(original,profile.getCollectionProfile(key));
 assert.equal(profile.describeRecipeEdit(key,cfg.lastUsedDraft).severity,'revectorize');
});
await check('global settings changes do not change saved collection cleaning or pairing',()=>{
 const effective=profile.settingsForSavedCollection('qdrant:llamacpp:A',{...BASE,chunking_strategy:'per_message',conversation_turn_order:'character_user',cleaning_preset:'none'});
 assert.equal(effective.chunking_strategy,'conversation_turns');assert.equal(effective.conversation_turn_order,'user_character');
 assert.equal(effective.cleaning_snapshot.selectedPreset,'html_formatting');
});
await check('collection B saves an independent recipe',async()=>{
 const b='qdrant:llamacpp:B';await profile.saveCollectionProfile(b,await profile.makeCollectionProfile({...BASE,chunking_strategy:'per_message',cleaning_snapshot:cleaner.captureCleaningSnapshot('none')}));
 assert.equal(profile.settingsForSavedCollection(b,BASE).chunking_strategy,'per_message');
 assert.equal(profile.settingsForSavedCollection('qdrant:llamacpp:A',BASE).chunking_strategy,'conversation_turns');
});
await check('failed remote write blocks future writes until profile reconciliation succeeds',async()=>{
 const key='qdrant:llamacpp:A';failRemote=true;
 await assert.rejects(profile.saveChatChunkManifest(key,[{hash:7,text:'abc',metadata:{messageIds:[1]}}],'uuid'),/persist/i);
 assert.equal(metadata.get(key).profileSaveStatus,'failed');
 assert.throws(()=>profile.settingsForSavedCollection(key,BASE),/persistence/i);
 failRemote=false;await profile.reconcileCollectionProfile(key);
 assert.equal(metadata.get(key).profileSaveStatus,'committed');
 assert.ok(profile.settingsForSavedCollection(key,BASE).cleaning_snapshot);
});
await check('unverified remote readback cannot mark an original profile committed',async()=>{
 const key='qdrant:llamacpp:readback';dropReadback=true;
 await assert.rejects(profile.saveCollectionProfile(key,await profile.makeCollectionProfile(BASE)),/verify saved profile/i);
 assert.equal(metadata.get(key).profileSaveStatus,'failed');
 assert.throws(()=>profile.settingsForSavedCollection(key,BASE),/persistence/i);
 dropReadback=false;await profile.reconcileCollectionProfile(key);
 assert.equal(metadata.get(key).profileSaveStatus,'committed');
});
await check('pending persistence from interrupted operation blocks writes',()=>{
 metadata.get('qdrant:llamacpp:A').profileSaveStatus='pending';
 assert.throws(()=>profile.settingsForSavedCollection('qdrant:llamacpp:A',BASE),/persistence/i);
 metadata.get('qdrant:llamacpp:A').profileSaveStatus='committed';
});
await check('model probe detects same-alias model replacement and prevents unsafe resumption',async()=>{
 model='alias-A';vector=[0,1,0,0];
 vm.runInContext('embeddingProbeCache.clear();',profile);
 await assert.rejects(profile.applyAndVerifyProfile('qdrant:llamacpp:A',BASE),/fingerprint/i);
 vector=[1,0,0,0];vm.runInContext('embeddingProbeCache.clear();',profile);
 await profile.applyAndVerifyProfile('qdrant:llamacpp:A',BASE);
});
await check('old profile without versioned recipe remains read-only',()=>{
 metadata.set('qdrant:llamacpp:old',{vectorizationProfile:{schemaVersion:1,embedding:{provider:'llamacpp',modelId:'alias-A',verified:true},chunking:{}}});
 assert.throws(()=>profile.settingsForSavedCollection('qdrant:llamacpp:old',BASE),/predates complete/i);
});
await check('retrieval uses each collection own model, URL and source',()=>{
 const key='qdrant:llamacpp:A';const alt=profile.settingsForCollectionQuery(key,{...BASE,source:'ollama',vector_backend:'standard',chunking_strategy:'per_message'});
 assert.equal(alt.source,'llamacpp');assert.equal(alt.vector_backend,'qdrant');assert.equal(alt.chunking_strategy,'conversation_turns');
 assert.equal(alt.alt_endpoint_url,'http://127.0.0.1:9977');
});
await check('collection editor exposes original recipe, draft controls and explicit profile recovery',()=>{
 const ui=source('ui/database-browser.js');
 for(const id of ['vecthare_original_recipe','vecthare_recipe_draft_source','vecthare_recipe_draft_model',
  'vecthare_recipe_draft_strategy','vecthare_recipe_draft_size','vecthare_recipe_draft_overlap',
  'vecthare_recipe_draft_batch','vecthare_recipe_draft_cleaning','vecthare_recipe_draft_keywords',
  'vecthare_recipe_draft_limit','vecthare_recipe_reconcile'])assert.ok(ui.includes(id),`missing ${id}`);
 assert.match(ui,/saveCollectionDraft\(state\.collectionId,proposed\)/);
 assert.match(ui,/await reconcileCollectionProfile\(key\)/);
});
await check('import/export and first-run journal are wired to the unified recipe',()=>{
 const contents=source('core/collection-export.js');
 assert.match(contents,/collectionConfiguration:/);assert.match(contents,/lastUsedDraft:/);assert.match(contents,/assignOccurrenceIds\(/);
 const cv=source('core/content-vectorization.js');assert.match(cv,/if\(source\.replaceExisting \|\| source\.type==='file' \|\| isOpenChat\)/);
 assert.match(cv,/saveCollectionProfile\(collectionKey,profile\)/);assert.match(cv,/saveChatChunkManifest\(collectionKey,\[\],chatUUID\)/);
});
console.log(`\n${passes} P1.0 unified settings/identity checks passed`);
