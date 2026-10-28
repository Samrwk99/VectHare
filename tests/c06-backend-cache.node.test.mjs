import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {backendConfigurationFingerprint} from '../utils/backend-configuration.js';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
async function makeHarness() {
 const fakeInstances=[];
 class FakeBackend {
  async initialize(settings){this.source=settings.source;this.host=settings.qdrant_host;fakeInstances.push(this);}
  async healthCheck(){return true;}
 }
 const context=vm.createContext({console:{log(){},warn(){},error(){}},Date,Math,Object,Promise});
 const s=fs.readFileSync(resolve(root,'backends/backend-manager.js'),'utf8');
 const mod=new vm.SourceTextModule(s,{context});
 const stubs={
  '../../../../extensions.js':{extension_settings:{vecthare:{}}},
  '../utils/backend-configuration.js':{backendConfigurationFingerprint},
  './standard.js':{StandardBackend:FakeBackend},
  './lancedb.js':{LanceDBBackend:FakeBackend},
  './qdrant.js':{QdrantBackend:FakeBackend},
  './milvus.js':{MilvusBackend:FakeBackend},
 };
 await mod.link(spec=>{
  assert.ok(stubs[spec],`Unexpected import ${spec}`);
  return new vm.SyntheticModule(Object.keys(stubs[spec]),function(){for(const [k,v] of Object.entries(stubs[spec]))this.setExport(k,v)},{context});
 });
 await mod.evaluate();
 return {api:mod.namespace,fakeInstances};
}
test('C06 backend cache reuses an instance only with same provider/server configuration',async()=>{
 const {api,fakeInstances}=await makeHarness();
 const settings={source:'openai',qdrant_host:'old'};
 const a=await api.initializeBackend('qdrant',settings);
 assert.equal(await api.initializeBackend('qdrant',settings),a);
 assert.equal(fakeInstances.length,1);
 const b=await api.initializeBackend('qdrant',{...settings,qdrant_host:'new'});
 assert.notEqual(b,a);assert.equal(fakeInstances.length,2);
 assert.equal(await api.initializeBackend('qdrant',{...settings,qdrant_host:'new'}),b);
 const c=await api.initializeBackend('qdrant',{...settings,source:'cohere',qdrant_host:'new'});
 assert.notEqual(c,b);assert.equal(fakeInstances.length,3);
});
test('C06 backend cache allows recovery after rotating a bad credential',async()=>{
 const {api}=await makeHarness();
 await api.initializeBackend('qdrant',{source:'openai',qdrant_api_key:'old'});
 const updated=await api.initializeBackend('qdrant',{source:'openai',qdrant_api_key:'new'});
 assert.equal(updated.source,'openai');
});
