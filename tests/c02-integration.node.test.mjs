import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=path=>readFileSync(resolve(root,path),'utf8');
const tracker=Object.fromEntries(['show','updateCurrentItem','updateProgress','updateChunks','complete','addError'].map(k=>[k,()=>{}]));
async function makeExport(outcome='needs-reconcile'){
 const metadata=new Map(), registry=new Set(), writes=[];
 const context=vm.createContext({console:{log(){},warn(){},error(){}},Blob,URL,FileReader:class{},fetch:async()=>{throw Error('No direct write allowed');}});
 const imports={
 '../utils/security.js':{redactSecrets:x=>x},
 '../utils/c04-ownership.js':{quarantineImportedOwnership:x=>({...x,enabled:false})},
 '../utils/tenant-route.js':{adapterCollectionId:x=>x},
 '../../../../extensions.js':{extension_settings:{vecthare:{}}},
 '../../../../../script.js':{getRequestHeaders:()=>({}),saveSettingsDebounced:()=>{}},
 './core-vector-api.js':{getSavedHashes:async()=>[],insertVectorItems:async()=>{throw Error('Bypassed journal')},purgeVectorIndex:async()=>false,
 replaceVectorRecords:async(id,old,items,settings,opts)=>{writes.push({id,old,items,opts});return {status:outcome,operationId:'c02-1234567890abcdef'};}},
 './collection-metadata.js':{getCollectionMeta:()=>null,setCollectionMeta:(id,m)=>metadata.set(id,m),getChunkMetadata:()=>null,saveChunkMetadata:()=>{},getAllChunkMetadata:()=>({})},
 './collection-loader.js':{registerCollection:id=>registry.add(id),getCollectionRegistry:()=>[]},
 '../ui/progress-tracker.js':{progressTracker:tracker},
 '../../../../utils.js':{getStringHash:text=>text.length*17},
 './providers.js':{getConfiguredEmbeddingModel:()=> 'model'},
 };
 const m=new vm.SourceTextModule(source('core/collection-export.js'),{context});
 await m.link(spec=>{assert.ok(imports[spec],`Unexpected import: ${spec}`);return new vm.SyntheticModule(Object.keys(imports[spec]),function(){for(const [k,v] of Object.entries(imports[spec]))this.setExport(k,v)},{context});});
 await m.evaluate();return {m:m.namespace,metadata,registry,writes};
}
const backup={version:'1.0.0',collection:{id:'target'},chunks:[{text:'first',index:0,metadata:{}}]};
const settings={vector_backend:'standard',source:'transformers',model:'model'};

test('C02 real import module refuses to activate metadata when journalled write is uncertain',async()=>{
 const h=await makeExport();await assert.rejects(h.m.importCollection(backup,settings),/requires reconciliation/);
 assert.equal(h.writes.length,1);assert.equal(h.metadata.has('target'),false);assert.equal(h.registry.size,0);
 assert.equal(h.writes[0].opts.kind,'import');
});
test('C02 multi-import reports partial failures rather than false success',async()=>{
 const h=await makeExport();const result=await h.m.importMultipleCollections({collections:[backup]},settings);
 assert.equal(result.success,false);assert.equal(result.failed,1);assert.equal(result.imported,0);
 assert.equal(h.metadata.size,0);
});
test('C02 overwrite remains blocked before any insert or metadata update',async()=>{
 const h=await makeExport('committed');await assert.rejects(h.m.importCollection(backup,settings,{overwrite:true}),/Overwrite blocked/);
 assert.equal(h.writes.length,0);assert.equal(h.metadata.size,0);
});
test('C02 journalled import only activates metadata in a synthetic proven commit',async()=>{
 const h=await makeExport('committed');const result=await h.m.importCollection(backup,settings);
 assert.equal(result.success,true);assert.equal(h.metadata.has('target'),true);assert.equal(h.registry.has('target'),true);
});
test('C02 rejects conflicting same-hash import before writing',async()=>{
 const h=await makeExport('committed');const b={...backup,chunks:[{text:'a',index:0},{text:'b',index:1}]};
 await assert.rejects(h.m.importCollection(b,settings),/duplicate content hashes/);
 assert.equal(h.writes.length,0);
});
test('C02 both chunk editors use journalled upsert before metadata mutation',()=>{
 const s=source('ui/chunk-visualizer.js');
 assert.equal((s.match(/const replacement = await replaceVectorRecords\(/g)||[]).length,2);
 for(const anchor of ['#vecthare_save_text','#vecthare_text_save']){
  const editor=s.slice(s.indexOf(anchor),s.indexOf(anchor)+2000);
  assert.doesNotMatch(editor,/await deleteVectorItems\(currentCollectionId, \[chunk\.hash\]/);
 }
 assert.equal((s.match(/if\(replacement\?\.status!==\x27committed\x27\)/g)||[]).length,2);
});
test('C02 ordinary server insert and streaming embed insert no longer blindly retry',()=>{
 const s=source('core/core-vector-api.js');
 const section=s.slice(s.indexOf('export async function insertVectorItems'),s.indexOf('export async function deleteVectorItems'));
 assert.doesNotMatch(section,/AsyncUtils\.retry\(async \(\) => \{\s*await withOpGuard\(\s*\(\) => backend\.insertVectorItems/);
 assert.match(section,/Batch insert \(no blind retry\)/);
 assert.match(section,/Streamed batch write \(no blind retry\)/);
});
test('C02 direct updateChunkText no longer routes to an unverified delete-first adapter',()=>{
 const s=source('core/core-vector-api.js');
 const section=s.slice(s.indexOf('export async function updateChunkText'),s.indexOf('export async function updateChunkMetadata'));
 assert.match(section,/Unsafe direct re-embedding blocked/);
 assert.doesNotMatch(section,/backend\.updateChunkText/);
});
test('C02 scene creation preserves individual chunks until journalled commit',()=>{
 const s=source('core/scenes.js');
 const section=s.slice(s.indexOf('export async function createSceneChunk'),s.indexOf('export async function deleteSceneChunk'));
 assert.ok(section.indexOf('replaceVectorRecords')<section.indexOf('disabledByScene: sceneHash'));
 assert.match(section,/if\(staged\?\.status!==\x27committed\x27\)/);
});
test('C02 scene splitting cannot delete original before staging a replacement',()=>{
 const s=source('ui/scene-markers.js');
 const section=s.slice(s.indexOf('// Case 3: Inside existing scene'),s.indexOf('// Case 4: Pending scene'));
 assert.doesNotMatch(section,/deleteSceneChunk\(/);
 assert.match(section,/original scene preserved/);
});
test('C02 pending journal is surfaced on extension startup',()=>{
 const s=source('index.js');
 assert.match(s,/recoverPendingC02Operations/);
 assert.match(s,/no automatic purge was attempted/);
});
