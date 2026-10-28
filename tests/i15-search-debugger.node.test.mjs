/** I15: Search Debugger stage fidelity, actual placements and history isolation. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const core=read('core/chat-vectorization.js');
const ui=read('ui/search-debug.js');
const quiet={log(){},warn(){},error(){},debug(){},info(){}};
const extract=(src,start,end)=>{
 const a=src.indexOf(start);assert.ok(a>=0,`Missing ${start}`);
 const b=src.indexOf(end,a);assert.ok(b>a,`Missing ${end}`);
 return src.slice(a,b);
};
const rearrange=extract(core,'export async function rearrangeChat(', '/**\n * Vectorizes entire chat').replace('export async function','async function');
const helpers=extract(core,'function hasInjectableText(', '/**\n * Builds the nested prompt structure');
const nested=extract(core,'function buildNestedInjectionText(', '/**\n * Resolves the effective injection position');
const resolve=extract(core,'function resolveChunkInjectionPosition(', '/**\n * Stage 8: Format and inject');
const inject=extract(core,'function injectChunksIntoPrompt(', '// ============================================================================\n// MAIN ORCHESTRATOR');
function coreScope(options={}) {
 const debugEntries=[];
 const scope={
  console:quiet,
  chatJobs: {startJob: () => ({assertCurrent(){},finish(){},signal:{aborted:false}})},
  StaleJobError: class StaleJobError extends Error {},
  EXTENSION_PROMPT_TAG:'3_vecthare',LEGACY_WORLD_INFO_PROMPT_TAG:'vecthare_world_info',extension_prompts:{},
  getCurrentChatId:()=> 'chat-1',
  gatherCollectionsToQuery:()=> ['collection-A'],
  buildSearchQuery:()=> 'hello world',
  extractChatKeywords:()=> [{text:'hello'}],
  getCollectionMeta:()=> ({}), hasVerifiedCapability:()=>false,
  expandRequiredLinks:async items=>({items,reasons:[]}), getContext:()=> ({groupId:null,characterId:1,name2:'Character'}),
  getRequiredConditionDepth:()=> 0,
  buildSearchContext:()=> ({}),
  chatIdForActivation:()=> 'chat-1',worldInfoSnapshots:{previous:()=>({entries:[]})},
  filterActiveCollections:async()=> ['collection-A'],
  setLastSearchDebug: d=>debugEntries.push(d),
  createDebugData:()=> ({query:'',timestamp:Date.now(),collectionId:null,collectionsQueried:[],collectionDecisions:[],settings:{},stages:{initial:[],afterThreshold:[],afterDecay:[],afterConditions:[],injected:[]},trace:[],chunkFates:{},stats:{retrievedFromVector:0}}),
  addTrace:(d,stage,action,details={})=> d.trace.push({stage,action,...details}),
  queryAndMergeCollections:async(collections)=>collections.length ? [{hash:'h1',score:.5,originalScore:.5,text:'memory',collectionId:'collection-A',metadata:{keywords:['hello']}}] : [],
  getChunkMetadata:()=>null,
  containsLexicalPhrase:(full,phrase)=> full.includes(phrase),
  applyKeywordBoost:chunks=>chunks.map(c=>({...c,score:.7,keywordBoost:1.4})),
  getSemanticWorldInfoEntries:async()=> [{uid:44,score:.8,content:'WI memory',lorebookName:'Lorebook'}],
  mergeSemanticWorldInfoChunks:(chunks,wi)=>({chunks:[...chunks,...wi],uniqueWIChunks:wi}),
  getStringHash:()=> 44,
  expandSummaryChunks:async(_,__,___,data)=>{options.capture?.(data);throw Error('stop-after-stage-capture')},
  toastr:{error(){},warn(){},warning(){}},
  clearVectHarePrompts:()=>{},
  recordChunkFate:()=>{},
  setExtensionPrompt:(tag,text,position,depth)=>{scope.extension_prompts[tag]={value:text,position,depth}},
  substituteParams:x=>x,
  ...options.overrides
 };
 vm.createContext(scope);
 vm.runInContext([helpers,nested,resolve,inject,rearrange].join('\n'),scope);
 return {scope,debugEntries};
}
const chat=[{mes:'hello world',is_system:false}];
const settings={query:3,enabled_world_info:false,score_threshold:0.3,top_k:5,position:0,depth:2};

test('#185: failed collection activation records a new zero-result generation',async()=>{
 const {scope,debugEntries}=coreScope({overrides:{filterActiveCollections:async(_,context)=>{context.collectionDecisions.push({collectionId:'collection-A',decision:'not_activated'});return []}}});
 await scope.rearrangeChat(chat,settings,'normal');
 assert.equal(debugEntries.length,1);
 assert.equal(debugEntries[0].stopReason,'no_active_collections');
 assert.equal(debugEntries[0].query,'hello world');
 assert.deepEqual(Array.from(debugEntries[0].collectionsQueried),[]);
 assert.equal(debugEntries[0].collectionDecisions[0].decision,'not_activated');
 assert.equal(debugEntries[0].stages.initial.length,0);
 assert.match(debugEntries[0].trace[0].action,/search skipped/i);
});

test('#185: having no enabled collections also replaces stale debugger history',async()=>{
 const {scope,debugEntries}=coreScope({overrides:{gatherCollectionsToQuery:()=>[]}});
 await scope.rearrangeChat(chat,settings,'normal');
 assert.equal(debugEntries.length,1);
 assert.equal(debugEntries[0].stopReason,'no_active_collections');
 assert.equal(debugEntries[0].query,'hello world');
 assert.match(debugEntries[0].trace[0].action,/No enabled collections/);
});

test('#188: raw hits retain pre-boost scores and exclude World Info entries',async()=>{
 let captured;
 const {scope}=coreScope({capture:data=>{captured=data}});
 await scope.rearrangeChat(chat,{...settings,enabled_world_info:true},'normal');
 assert.ok(captured);
 assert.equal(captured.stages.initial.length,1);
 assert.equal(captured.stages.initial[0].score,.5);
 assert.equal(captured.stats.retrievedFromVector,1);
 assert.equal(captured.stages.afterKeywordBoost.length,1);
 assert.equal(captured.stages.afterKeywordBoost[0].score,.7);
 assert.equal(captured.stages.afterWorldInfo.length,2);
 assert.equal(captured.stages.afterWorldInfo[1].text,'WI memory');
 assert.equal(captured.stages.initial[0].keywordMatched,undefined);
});

test('#188: WI-only results do not inflate vector-search count',async()=>{
 let captured;
 const {scope}=coreScope({capture:d=>captured=d,overrides:{gatherCollectionsToQuery:()=>[],filterActiveCollections:async()=>[]}});
 await scope.rearrangeChat(chat,{...settings,enabled_world_info:true},'normal');
 assert.equal(captured.stages.initial.length,0);
 assert.equal(captured.stats.retrievedFromVector,0);
 assert.equal(captured.stages.afterWorldInfo.length,1);
});

test('#186: multi-position inject returns verified, per-tag placement receipts and texts',()=>{
 const {scope}=coreScope();
 const items=[
  {hash:'a',collectionId:'c1',score:.8,text:'first memory',metadata:{position:0,depth:1}},
  {hash:'b',collectionId:'c2',score:.7,text:'second memory',metadata:{position:1,depth:4}},
 ];
 // Use the supported resolver's chunk override fields (rather than assuming metadata names).
 const settings={position:0,depth:2,rag_context:'Wrapper context',rag_xml_tag:'memory'};
 const c1={hash:'a',collectionId:'c1',score:.8,text:'first memory',position:0,depth:1};
 const c2={hash:'b',collectionId:'c2',score:.7,text:'second memory',position:1,depth:4};
 scope.getChunkMetadata=hash=>hash==='a'?{position:0,depth:1}:{position:1,depth:4};
 const result=scope.injectChunksIntoPrompt([c1,c2],settings,{});
 assert.equal(result.verified,true);
 assert.equal(result.groups.length,2);
 assert.deepEqual(Array.from(result.groups,g=>g.tag),['3_vecthare_pos0','3_vecthare_pos1']);
 assert.deepEqual(Array.from(result.groups,g=>g.position),[0,1]);
 assert.deepEqual(Array.from(result.groups,g=>g.depth),[1,4]);
 assert.match(result.groups[0].text,/first memory/);
 assert.match(result.groups[1].text,/second memory/);
 assert.equal(scope.extension_prompts[result.groups[1].tag].position,1);
});

test('#186: single-position injection receipt identifies real resolved placement',()=>{
 const {scope}=coreScope();
 scope.getChunkMetadata=()=>({position:4,depth:0});
 const r=scope.injectChunksIntoPrompt([{hash:'a',text:'one',collectionId:'c'}],{position:0,depth:2},{});
 assert.equal(r.groups.length,1);
 assert.equal(r.groups[0].tag,'3_vecthare');
 assert.equal(r.groups[0].position,4);
 assert.equal(r.groups[0].depth,0);
});

function makeUi() {
 const handlers=new Map();
 const written=[];
 const $=selector=>({
  data(key){return typeof selector === 'object' ? selector.data(key) : undefined},
  on(event,callback){handlers.set(`${selector}:${event}`,callback);return this},
  off(){return this},
  remove(){return this},
  append(){return this},
  html(){return this},
  fadeIn(){return this},
  fadeOut(_,callback){callback?.();return this},
  replaceWith(){return this},
  show(){return this},
 });
 const scope={console:quiet,document:{},$,navigator:{clipboard:{writeText:async text=>written.push(text)}},toastr:{info(){},warning(){},success(){},error(){}},Date};
 vm.createContext(scope);
 vm.runInContext(ui.replaceAll('export function ','function ').replaceAll('export async function ','async function '),scope);
 return {scope,handlers,written};
}
function debug(query) {
 return {query,timestamp:Date.now(),collectionId:'c',settings:{},stages:{initial:[],afterDecay:[],afterThreshold:[],afterConditions:[],injected:[]},chunkFates:{},trace:[],stats:{}};
}

test('#182: inspecting old query leaves getLastSearchDebug pointing at the newest',()=>{
 const {scope,handlers}=makeUi();
 const old=debug('old');const latest=debug('latest');
 scope.setLastSearchDebug(old);
 scope.setLastSearchDebug(latest);
 vm.runInContext('bindEvents()',scope);
 const clicked=handlers.get('.vecthare-debug-history-tab:click');
 assert.equal(typeof clicked,'function');
 clicked.call({data:()=>1});
 assert.equal(scope.getLastSearchDebug(),latest);
 assert.equal(vm.runInContext('selectedHistoryData',scope),old);
 scope.setLastSearchDebug(debug('new generation'));
 assert.equal(scope.getLastSearchDebug().query,'new generation');
});

test('#182: copying history uses selected old entry while latest record remains unchanged',async()=>{
 const {scope,handlers,written}=makeUi();
 const old=debug('older query');const latest=debug('latest query');
 scope.setLastSearchDebug(old);scope.setLastSearchDebug(latest);
 vm.runInContext('bindEvents()',scope);
 handlers.get('.vecthare-debug-history-tab:click').call({data:()=>1});
 await vm.runInContext('copyDiagnosticDump()',scope);
 assert.match(written[0],/older query/);
 assert.doesNotMatch(written[0],/latest query/);
 assert.equal(scope.getLastSearchDebug(),latest);
});

test('#186: UI renders each prompt tag and resolved placement without interpolating raw HTML',()=>{
 const {scope}=makeUi();
 const d=debug('Q');
 d.stages.injected=[{hash:'a'}];
 d.injection={verified:true,text:'aggregate',position:0,depth:2,charCount:17,groups:[
  {tag:'3_vecthare_pos0',position:1,depth:0,text:'<script>x</script>',charCount:18,chunkHashes:['a'],verified:true},
  {tag:'3_vecthare_pos1',position:4,depth:3,text:'other',charCount:5,chunkHashes:['b'],verified:true}
 ]};
 const rendered=scope.renderInjectionVerification(d);
 assert.match(rendered,/2 separate placements/);
 assert.match(rendered,/3_vecthare_pos0/);
 assert.match(rendered,/depth 0/);
 assert.match(rendered,/depth 3/);
 assert.match(rendered,/&lt;script&gt;x&lt;\/script&gt;/);
 assert.doesNotMatch(rendered,/<script>/);
});

test('#185: UI identifies a skipped search rather than claiming vector search returned nothing',()=>{
 const {scope}=makeUi();const d=debug('Q');d.stopReason='no_active_collections';
 const html=scope.renderCriticalFailure(d);
 assert.match(html,/Vector search was not run/);
 assert.doesNotMatch(html,/Vector search returned no results/);
});
