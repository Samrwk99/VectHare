import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../core/settings-durability.js',import.meta.url),'utf8');
const settings={vecthare:{
 top_k:0,hybrid_search_enabled:false,custom_api_key:'SECRET1',qdrant_api_key:'SECRET2',
 alt_endpoint_url:'https://example.test/v1?api_key=SECRET3',
 collections:{'qdrant:custom:A':{enabled:false,temporalDecay:{minRelevance:0},vectorizationProfile:{embedding:{modelId:'model-a'}},chatChunkManifest:{entries:[{text:'PRIVATE CHAT'}],revision:7,chatUUID:'uuid'},queryCount:12}}
}};
const ctx=vm.createContext({console,JSON,Array,Object,Map,Set,Promise,URL,structuredClone,extension_settings:settings, getRequestHeaders:()=>({}),saveSettingsDebounced:()=>{},hostSaveDebounced:()=>{},hostSaveSettings:async()=>{},fetch:async()=>{},setTimeout,clearTimeout});
vm.runInContext(source.replace(/^import\s+.*?\s+from\s+['"].+?['"];\s*$/gm,'').replace(/^export /gm,''),ctx);
const mirror=vm.runInContext('recoverySnapshot(extension_settings.vecthare)',ctx);
assert.equal(mirror.top_k,0);assert.equal(mirror.hybrid_search_enabled,false);
assert.equal(mirror.collections['qdrant:custom:A'].temporalDecay.minRelevance,0);
const encoded=JSON.stringify(mirror);
for(const text of ['SECRET1','SECRET2','SECRET3','PRIVATE CHAT'])assert(!encoded.includes(text),`Leaked ${text}`);
assert.equal(mirror.collections['qdrant:custom:A'].chatChunkManifest.revision,7);
console.log('PASS: non-secret settings mirror preserves independent settings, zero/false and excludes credentials/text');
