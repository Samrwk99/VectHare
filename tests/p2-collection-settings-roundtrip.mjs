import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../core/vectorization-profile.js',import.meta.url),'utf8');
const state=new Map();
const a='qdrant:llamacpp:chat-A',b='qdrant:llamacpp:chat-B';
const profile={schemaVersion:1,recipe:{version:2,settings:{chunking_strategy:'conversation_turns'}},embedding:{provider:'llamacpp',modelId:'model-a'}};
state.set(a,{vectorizationProfile:profile,configurationRevision:3,profileSaveStatus:'committed',
 enabled:false,autoSync:false,lockMode:'exclusive',exclusiveScope:'lorebook',
 triggers:['red'],triggerScanDepth:0,conditions:{enabled:true,logic:'OR',rules:[{type:'speaker',value:'Alice',negate:false}]},
 temporalDecay:{enabled:true,minRelevance:0,linearRate:0,halfLife:50,type:'nostalgia'},
 context:'Stored memory context',xmlTag:'chat',position:1,depth:0,
 groups:[{id:'g1',name:'group'}],lastUsedVectorizationDraft:{chunk_size:256,chunk_overlap:0}});
state.set(b,{vectorizationProfile:profile,profileSaveStatus:'committed',enabled:true,autoSync:false,
 temporalDecay:{enabled:false,minRelevance:0.5},lastUsedVectorizationDraft:{chunk_size:1024}});
const context=vm.createContext({console,structuredClone,Map,Set,Date,JSON,URL,Math,Number,Array,
 getCollectionMeta:key=>state.get(key)||{},setCollectionMeta:(key,patch)=>state.set(key,{...(state.get(key)||{}),...patch}),
 parseRegistryKey:k=>({backend:'qdrant',source:'llamacpp',collectionId:k}),
 globalThis:{localStorage:null},clearTimeout,setTimeout});
vm.runInContext(source.replace(/^import\s+.*?\s+from\s+['"].*?['"];\s*$/gm,'').replace(/^export /gm,''),context);
const stored=context.getCollectionConfiguration(a);
for(const key of ['enabled','autoSync','lockMode','exclusiveScope','triggers','triggerScanDepth','conditions','temporalDecay','context','xmlTag','position','depth','groups']){
 assert.deepEqual(JSON.parse(JSON.stringify(stored.preferences[key])),JSON.parse(JSON.stringify(state.get(a)[key])),`${key} not in collection A preference snapshot`);
}
assert.equal(stored.preferences.temporalDecay.minRelevance,0);
assert.equal(stored.preferences.triggerScanDepth,0);
assert.equal(stored.preferences.depth,0);
assert.equal(stored.lastUsedDraft.chunk_overlap,0);
const unchangedB=JSON.stringify(state.get(b));
context.saveCollectionDraft(a,{chunk_size:300,chunk_overlap:0});
assert.equal(JSON.stringify(state.get(b)),unchangedB,'Changes to A must not mutate B');
assert.equal(context.getCollectionConfiguration(a).originalRecipe.settings.chunking_strategy,'conversation_turns','Original embedding recipe must be immutable');
assert.equal(context.getCollectionConfiguration(a).lastUsedDraft.chunk_size,300);
const portable=JSON.parse(JSON.stringify(context.getCollectionConfiguration(a).preferences));
assert.equal(portable.conditions.rules[0].value,'Alice');
console.log('PASS: collection-specific retrieval, decay, activation, prompt and draft settings preserve zero/false, remain isolated and serialize correctly');
