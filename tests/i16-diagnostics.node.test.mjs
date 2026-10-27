/** I16: truthful diagnostics, safe cleanup, and collection usage. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const VECTOR_LIST_LIMIT=10000;
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const silent={log(){},warn(){},error(){},info(){},debug(){}};
const asPlain=o=>JSON.parse(JSON.stringify(o));
function extracted(file,name,context={},deps={}) {
  const src=read(file);
  const matcher=new RegExp(`(?:export\\s+)?(?:async\\s+)?function ${name}\\(`);
  const found=matcher.exec(src);assert.ok(found,`${file} missing ${name}`);
  const start=found.index;
  const end=src.indexOf('\n}\n',start);assert.ok(end>start,`missing end for ${name}`);
  let code=src.slice(start,end+2).replace(/^export\s+/,'');
  // Substitute module imports only in an isolated test fixture; production code is unchanged.
  code=code.replace(/await import\((['"])([^'"]+)\1\)/g,(_,q,spec)=>`__mocks[${JSON.stringify(spec)}]`);
  const scope=vm.createContext({console:silent,Date,Math,Set,Map,JSON,Object,RegExp,Number,String,Promise,__mocks:deps,...context});
  return vm.runInContext(`${code}\n${name}`,scope);
}
const prod='diagnostics/production-tests.js',config='diagnostics/configuration.js';

test('#160: both Fix Now actions read actual extension settings, not absent ui-settings module',async()=>{
 const src=read('diagnostics/index.js');
 assert.doesNotMatch(src,/ui\/ui-settings\.js/);
 assert.match(src,/import \{ extension_settings \} from '\.\.\/\.\.\/\.\.\/\.\.\/extensions\.js'/);
 const actions=extracted('diagnostics/index.js','executeFixAction',{extension_settings:{vecthare:{source:'test'}} ,fixDuplicateHashes:async (_d,_c,settings)=>({success:true,settings}),fixOrphanedGroupMembers:async()=>({success:true})});
 const result=await actions({fixable:true,fixAction:'removeDuplicateHashes',data:{duplicates:[1],collectionId:'c'}});
 assert.equal(result.success,true);assert.equal(result.settings.source,'test');
 const cleanup=await actions({fixable:true,fixAction:'cleanOrphanedGroupMembers'});
 assert.equal(cleanup.success,true);
});

test('#164: validates the actual conditions.rules collection, including disabled rules',async()=>{
 const rules=[{type:'pattern',settings:{patterns:['ok']}},{type:'madeUp',settings:{value:'foo'}}];
 let checked=[];
 const fn=extracted(config,'checkConditionRuleValidity',{
  getChatCollectionId:()=> 'chat',
  getSavedHashes:async()=>({hashes:[101],metadata:[{conditions:{enabled:false,rules}}]}),
  validateConditionRule:r=>{checked.push(r);return {valid:r.type==='pattern',errors:['bad rule']}}
 });
 const result=await fn({});assert.equal(checked.length,2);assert.equal(result.status,'warning');
 assert.equal(result.data.invalidConditions[0].hash,101);
 assert.equal(result.data.invalidConditions[0].rule,'madeUp');
});

test('#164: missing metadata does not produce PASS',async()=>{
 const fn=extracted(config,'checkConditionRuleValidity',{
  getChatCollectionId:()=> 'chat',getSavedHashes:async()=>[5],validateConditionRule:()=>({valid:true})
 });
 assert.equal((await fn({})).status,'warning');
});

test('#174: group integrity remains warning and not fixable when inventory fails',async()=>{
 const fn=extracted(config,'checkChunkGroupMemberIntegrity',{
  getCollectionRegistry:()=>['source:A'],getSavedHashes:async()=>{throw Error('offline')},VECTOR_LIST_LIMIT
 },{'../core/collection-metadata.js':{getCollectionMeta:()=>({groups:[{name:'g',members:['1']}]})}});
 const result=await fn({});assert.equal(result.status,'warning');
 assert.equal(result.fixable,undefined);assert.equal(result.data.unverifiedCollections,1);
});

test('#174: group integrity finds orphan and supports cleanup only after verified list',async()=>{
 const fn=extracted(config,'checkChunkGroupMemberIntegrity',{
  getCollectionRegistry:()=>['source:A'],getSavedHashes:async()=>[1],VECTOR_LIST_LIMIT
 },{'../core/collection-metadata.js':{getCollectionMeta:()=>({groups:[{name:'g',members:['1','2']}]})}});
 const result=await fn({});assert.equal(result.status,'warning');
 assert.equal(result.fixable,true);assert.equal(result.data.orphanedCount,1);
});

test('#173: production trigger diagnostic tests both positive and negative activation',async()=>{
 const core=read('core/collection-metadata.js');
 assert.match(core,/export function checkTriggers\(/);
 const checkTriggers=extracted('core/collection-metadata.js','checkTriggers');
 const fn=extracted('diagnostics/activation-tests.js','testActivationTriggers',{}, {'../core/collection-metadata.js':{checkTriggers}});
 assert.equal((await fn()).status,'pass');
 assert.match(read('diagnostics/index.js'),/categories\.production\.push\(await testActivationTriggers\(\)\)/);
});

test('#172: keyword boosting test checks bounded current algorithm, not legacy multiplier',async()=>{
 const scorer=results=>results.map(r=>({...r,originalScore:r.score,keywordBoosted:r.hash==='doc1',matchedKeywords:r.hash==='doc1'?['wizard','spell']:[],keywordBoost:r.hash==='doc1'?1.2:1,score:r.hash==='doc1'?0.84:r.score})).sort((a,b)=>b.score-a.score);
 const fn=extracted(prod,'testKeywordBoosting',{applyKeywordBoost:scorer});
 assert.equal((await fn({})).status,'pass');
 assert.doesNotMatch(read(prod).slice(read(prod).indexOf('export async function testKeywordBoosting'),read(prod).indexOf('export async function testLorebookKeywordExtraction')),/expectedBoost = 2\.5/);
});

test('#165: retrieval routes through selected backend, not hard-coded native /api/vector/query',async()=>{
 let queries=[];
 const fn=extracted(prod,'testVectorRetrieval',{
  getCurrentChatId:()=> 'chat',getChatCollectionId:()=> 'chat-id',getSavedHashes:async()=>[1],
  queryCollection:async(...args)=>{queries.push(args);return {hashes:[1],metadata:[{score:0.9}]}}
 });
 const result=await fn({vector_backend:'qdrant'});
 assert.equal(result.status,'pass');assert.equal(queries.length,1);assert.equal(queries[0][0],'chat-id');
 assert.match(result.message,/qdrant/);
});

test('#166: dimensions not verifiable -> warning, never PASS',async()=>{
 const fn=extracted(prod,'testVectorDimensions',{
  getCurrentChatId:()=> 'chat',getChatCollectionId:()=> 'c',getRequestHeaders:()=>({}),getModelField:()=> 'model',
  fetch:async()=>({ok:false})
 });
 assert.equal((await fn({vector_backend:'qdrant'})).status,'warning');
 const absent=extracted(prod,'testVectorDimensions',{getCurrentChatId:()=>null});
 assert.equal((await absent({})).status,'warning');
});

test('#178: disabled global decay does not break arithmetic diagnostic',async()=>{
 const fn=extracted(prod,'testTemporalDecay',{}, {
  '../core/temporal-decay.js':{getDefaultDecaySettings:()=>({enabled:false,halfLife:50,mode:'exponential'}),applyTemporalDecay:(score,age,s)=>s.enabled?score*0.5:score},
 });
 assert.equal((await fn({})).status,'pass');
});

test('#179: blind fixture metadata is removed even when assertions fail',async()=>{
 let stored={};
 const metadata={
  getDefaultDecayForType:()=>({enabled:false}),
  getChunkMetadata:id=>stored[id]||null,
  setChunkTemporallyBlind:(id,bool)=>{stored[id]={temporallyBlind:bool}},
  isChunkTemporallyBlind:id=>stored[id]?.temporallyBlind ===true,
  deleteChunkMetadata:id=>{delete stored[id]},
  saveChunkMetadata:(id,data)=>{stored[id]=data}
 };
 const fn=extracted(prod,'testTemporallyBlindChunks',{}, {
  '../core/collection-metadata.js':metadata,
  '../core/temporal-decay.js':{applyDecayToResults:items=>items.map(item=>({...item,score:item.score,temporallyBlind:!!stored[item.hash]?.temporallyBlind}))}
 });
 assert.equal((await fn({})).status,'fail');assert.deepEqual(stored,{});
});

test('#168: failed cleanup does not unregister or report successful storage',async()=>{
 let unregisters=0;
 const cleanup=extracted(prod,'cleanupTestCollection',{
  purgeVectorIndex:async()=>false,unregisterCollection:()=>{unregisters++}
 });
 const result=await cleanup('vh:test:storage_123',{source:'x'});
 assert.equal(result.success,false);assert.equal(unregisters,0);
 const success=extracted(prod,'cleanupTestCollection',{
  purgeVectorIndex:async()=>true,unregisterCollection:()=>{unregisters++}
 });
 assert.equal((await success('vh:test:storage_123',{source:'x'})).success,true);assert.equal(unregisters,2);
});

test('#168: storage fixture always attempts cleanup after insertion error',async()=>{
 let purges=0;
 const cleanup=extracted(prod,'cleanupTestCollection',{
  purgeVectorIndex:async()=>{purges++;return false;},unregisterCollection:()=>{}
 });
 // Build an independent helper with identical mocked calls, exercise the actual storage body through a combined VM scope.
 const fn=extracted(prod,'testVectorStorage',{
  markDiagnosticTestCollection:()=>{},getModelField:()=>null,getRequestHeaders:()=>({}),
  fetch:async()=>({ok:false,status:500,text:async()=> 'server error'}),
  getPluginProviderParams:()=>({}),cleanupTestCollection:cleanup,
  Math,
 });
 const result=await fn({source:'test'});
 assert.equal(result.status,'fail');assert.match(result.message,/Cleanup failed/);assert.equal(purges,1);
});

test('#196: usage counter updates the exact key and refuses ambiguous aliases',()=>{
 let saves=0;
 const settings={vecthare:{collections:{'source:A':{queryCount:2},'other:A':{queryCount:5}}}};
 const fn=extracted('core/collection-metadata.js','recordCollectionUsage',{
   extension_settings:settings,ensureCollectionsObject:()=>{},saveSettingsDebounced:()=>saves++,
   parseRegistryKey:key=>({collectionId:String(key).split(':').at(-1)})
 });
 fn('A');assert.equal(saves,0);
 fn('source:A');assert.equal(saves,1);assert.equal(settings.vecthare.collections['source:A'].queryCount,3);
 assert.equal(settings.vecthare.collections['other:A'].queryCount,5);
 const core=read('core/core-vector-api.js');assert.match(core,/recordCollectionUsage\(collectionId\)/);
});

test('#219: report uses live qdrant_use_cloud and qdrant_url fields',()=>{
 const src=read('ui/ui-manager.js');
 const i=src.indexOf('const qdrantMode = settings.qdrant_use_cloud');
 assert.ok(i>0);
 assert.match(src.slice(i,i+200),/settings\.qdrant_url/);
 assert.doesNotMatch(src.slice(i,i+200),/qdrant_cloud_url|settings\.qdrant_mode/);
});

test('#160/#174: Group Member Fix Now persists via setCollectionMeta only after a trusted read',async()=>{
 const meta={groups:[{name:'group',members:['a','b']}]};
 let saved=[];
 const deps={
   '../core/collection-metadata.js':{getCollectionMeta:()=>structuredClone(meta),setCollectionMeta:(key,patch)=>saved.push({key,patch})},
   '../core/collection-loader.js':{getCollectionRegistry:()=>['source:abc']},
   '../core/core-vector-api.js':{getSavedHashes:async()=>['a']}
 };
 const fn=extracted('diagnostics/index.js','fixOrphanedGroupMembers',{extension_settings:{vecthare:{source:'source'}},VECTOR_LIST_LIMIT},deps);
 const result=await fn();assert.equal(result.success,true);assert.equal(saved.length,1);
 assert.equal(saved[0].key,'abc');assert.deepEqual(asPlain(saved[0].patch.groups[0].members),['a']);
 const bad=extracted('diagnostics/index.js','fixOrphanedGroupMembers',{extension_settings:{vecthare:{}},VECTOR_LIST_LIMIT},{
   ...deps,'../core/core-vector-api.js':{getSavedHashes:async()=>{throw Error('backend offline')}}
 });
 saved=[];
 assert.equal((await bad()).success,false);assert.equal(saved.length,0);
});

test('#168: successful storage must also confirm the cleanup purge',async()=>{
 const cleanup=extracted(prod,'cleanupTestCollection',{
   purgeVectorIndex:async()=>true,unregisterCollection:()=>{}
 });
 const fn=extracted(prod,'testVectorStorage',{
   markDiagnosticTestCollection:()=>{},getModelField:()=>null,getRequestHeaders:()=>({}),
   fetch:async()=>({ok:true}),getPluginProviderParams:()=>({}),cleanupTestCollection:cleanup
 });
 const result=await fn({source:'transformers'});
 assert.equal(result.status,'pass');assert.match(result.message,/cleaned up/i);
});

test('#174: capped backend inventory cannot authorize a destructive group repair',async()=>{
 const hashes=Array.from({length:VECTOR_LIST_LIMIT},(_,i)=>String(i));
 const data={'../core/collection-metadata.js':{getCollectionMeta:()=>({groups:[{name:'g',members:['missing']}]})}};
 const fn=extracted(config,'checkChunkGroupMemberIntegrity',{
   getCollectionRegistry:()=>['source:A'],getSavedHashes:async()=>hashes,VECTOR_LIST_LIMIT
 },data);
 const res=await fn({});assert.equal(res.status,'warning');assert.equal(res.fixable,undefined);
 const mutable=[];
 const fixer=extracted('diagnostics/index.js','fixOrphanedGroupMembers',{
   extension_settings:{vecthare:{}},VECTOR_LIST_LIMIT
 },{
   '../core/collection-metadata.js':{...data['../core/collection-metadata.js'],setCollectionMeta:()=>mutable.push(1)},
   '../core/collection-loader.js':{getCollectionRegistry:()=>['source:A']},
   '../core/core-vector-api.js':{getSavedHashes:async()=>hashes}
 });
 assert.equal((await fixer()).success,false);assert.equal(mutable.length,0);
});
