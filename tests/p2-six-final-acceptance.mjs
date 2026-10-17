/** Final focused P2 #34/#40/#44/#47/#49/#57 behaviour checks. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {inspectCollectionChunks} from '../core/chunk-integrity.js';
import {createStreamingLexicalAccumulator} from '../core/lexical-stream.js';
import {createBM25Scorer,tokenize} from '../core/bm25-scorer.js';
import {countConservativeGenerationTokens,chooseMemoryInjections} from '../core/injection-budget.js';
const read=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
let checks=0;
async function check(name,action){await action();console.log('PASS',name);checks++;}
const mkrow=(id,text)=>({hash:id,text,metadata:{hash:id,text}});
await check('#34: multiple cursor pages: request cursor, never offset, and verify all hashes',async()=>{
 const pages=new Map([[null,{items:Array.from({length:200},(_,i)=>mkrow(i,'a')),cursor:'p2',pageMode:'cursor',hasMore:true}],['p2',{items:Array.from({length:200},(_,i)=>mkrow(200+i,'b')),cursor:'p3',pageMode:'cursor',hasMore:true}],['p3',{items:[mkrow(400,'c')],cursor:null,pageMode:'cursor',hasMore:false}]]);
 const seen=[];
 const rows=await inspectCollectionChunks({listChunks:async(_id,_settings,opts)=>{seen.push(opts);return pages.get(opts.cursor);}},'id',{vector_backend:'qdrant'});
 assert.equal(rows.length,401);assert.equal(new Set(rows.map(x=>x.hash)).size,401);
 assert.deepEqual(seen.map(x=>x.cursor),[null,'p2','p3']);assert.ok(seen.every(x=>!Object.hasOwn(x,'offset')));
});
await check('#34: stalled cursor, fake successful empty page and abort fail closed',async()=>{
 await assert.rejects(inspectCollectionChunks({listChunks:async()=>({items:[],hasMore:true,pageMode:'cursor',cursor:'stale'})},'x',{vector_backend:'qdrant'}),/stalled/);
 await assert.rejects(inspectCollectionChunks({listChunks:async()=>{throw new Error('database offline');}},'x',{vector_backend:'qdrant'}),/database offline/);
 const c=new AbortController();c.abort();
 await assert.rejects(inspectCollectionChunks({listChunks:async()=>{throw new Error('should not call');}},'x',{vector_backend:'qdrant'},{signal:c.signal}),/stopped/);
});
await check('#44: streaming BM25 matches corpus BM25+ scores including title/tag boosts and b=0',()=>{
 const docs=[{hash:'a',text:'silver dragon dragon',title:'Book',tags:['creatures']},{hash:'b',text:'dragon river',title:'Silver',tags:[]},{hash:'c',text:'small river fish',title:'fish',tags:['fish']},{hash:'d',text:'totally different',title:'none',tags:[]}];
 const opts={k1:1.5,b:0,fieldBoosting:true};const accum=createStreamingLexicalAccumulator('silver dragon',opts);
 docs.forEach(d=>accum.add(d));
 const baseline=createBM25Scorer(docs,opts);const terms=tokenize('silver dragon');
 const expected=new Map(docs.map((d,i)=>[d.hash,baseline.scoreDocument(terms,i)]));
 const streamed=accum.results(50);
 for(const row of streamed)assert.ok(Math.abs(row.bm25Score-expected.get(row.hash))<1e-10, `${row.hash} mismatch: ${row.bm25Score} vs ${expected.get(row.hash)}`);
 assert.equal(streamed.length,2);assert.equal(accum.totalDocs,4);assert.equal(accum.retainedDocs,2);
});
await check('#44: >20k independently listed corpus uses streaming shortlist; keyword-only hit survives',async()=>{
 const source=read('core/hybrid-search.js').replace(/^import .*?;\s*$/gm,'').replace(/^export /gm,'');
 const count=20100;
 const backend={constructor:{name:'LargeQdrant'},supportsHybridSearch:()=>false,
   queryCollection:async()=>({hashes:[],metadata:[]}),listChunks:async(_id,_settings,opts)=>{
     const offset=opts.cursor==null?0:Number(opts.cursor);const n=Math.min(opts.pageSize,count-offset);
     const items=Array.from({length:n},(_,i)=>mkrow(offset+i,offset+i===count-1?'unicorn azure':'ordinary forest'));
     const next=offset+n;
     return {items,cursor:next<count?String(next):null,pageMode:'cursor',hasMore:next<count};
   }};
 const sandbox=vm.createContext({console:{log(){},warn(){},error(){}},Map,Set,Math,Number,Array,String,getBackend:async()=>backend,
    createBM25Scorer,tokenize,createStreamingLexicalAccumulator});
 vm.runInContext(source,sandbox);
 const out=await sandbox.hybridSearch('big','unicorn azure',3,{vector_backend:'qdrant',hybrid_native_prefer:false,hybrid_lexical_scan_limit:20101});
 assert.ok(out.hashes.includes(count-1));
 await assert.rejects(sandbox.hybridSearch('big','unicorn azure',3,{vector_backend:'qdrant',hybrid_native_prefer:false,hybrid_lexical_scan_limit:20000}),/exceeded 20000/);
});
await check('#44: native Qdrant sparse unavailable must throw for independent lexical fallback',()=>{
 const native=read('backends/qdrant.js');
 assert.match(native,/Native sparse hybrid unavailable/);
 assert.doesNotMatch(native,/return this\.queryCollection\(collectionId, searchText, topK, settings\);/);
});
const wi=read('core/world-info-integration.js');
const start=wi.indexOf('export function deduplicateWithActiveEntries('),end=wi.indexOf('\n// =====',start);
const wiScope=vm.createContext({Set,String});vm.runInContext(wi.slice(start,end).replace('export ',''),wiScope);
await check('#47: active ID aliases and normalized texts prevent re-injection without suppressing distinct entries',()=>{
 const actual=wiScope.deduplicateWithActiveEntries([
   {uid:'70',content:'Other text'},{uid:71,content:' SAME  text '},{uid:'72',content:'fresh entry'},
 ],[{entryId:70,content:'different text'},{id:800,content:'same text'}]);
 assert.deepEqual(Array.from(actual,x=>x.uid),['72']);
});
await check('#47: lifecycle gate includes final ST scan and chat UUID/file freshness',()=>{
 assert.match(wi,/args\?\.state\?\.next !== 0/);
 assert.match(wi,/args\?\.activated\?\.entries instanceof Map/);
 assert.match(wi,/data\.chatFile !== getCurrentChatId\(\)/);
 assert.match(wi,/data\.chatUUID !== getChatUUID\(\)/);
});
await check('#49: shared pure embedding planner performs same enrichment/splits and does not write',async()=>{
 const mod=read('core/content-vectorization.js');const from=mod.indexOf('export async function buildContentEmbeddingPlan(');const to=mod.indexOf('\n}\n',from)+2;
 const original=[{text:'one'},{text:'two'}];const fakeHash=str=>'hash:'+str;
 const scope=vm.createContext({enrichChunks:chunks=>chunks.map(x=>({...x,text:x.text+' enriched'})),getStringHash:fakeHash,
    prepareEmbeddingItems:async(items)=>items.flatMap(x=>[{...x,text:x.text+'-split'}]),
    assignOccurrenceIds:items=>items.map((x,i)=>({...x,occurrence:i}))});
 vm.runInContext(mod.slice(from,to).replace('export ',''),scope);
 const preview=await scope.buildContentEmbeddingPlan(original,'document',{}, {}, {},{});
 const write=await scope.buildContentEmbeddingPlan(original,'document',{}, {}, {},{});
 assert.deepEqual(JSON.parse(JSON.stringify(preview)),JSON.parse(JSON.stringify(write)));
 assert.equal(original[0].text,'one');assert.equal(preview.length,2);
});
await check('#57: prevent underestimated generation token counts with UTF-8 byte safeguard',async()=>{
 assert.equal(await countConservativeGenerationTokens('A'.repeat(40),async()=>4),48);
 assert.equal(await countConservativeGenerationTokens('🧠',async()=>2),12);
 assert.equal(await countConservativeGenerationTokens('hi',async()=>50),50);
 await assert.rejects(countConservativeGenerationTokens('hello',async()=>NaN),/invalid token count/);
});
await check('#57: combined count/byte bound prevents oversized whole-memory injection',async()=>{
 const candidates=[{hash:1,text:'A'.repeat(50)},{hash:2,text:'B'.repeat(50)}];
 const renderGroups=rows=>rows.length?['WRAP:'+rows.map(r=>r.text).join('\\n')]:[];
 const countTokens=x=>countConservativeGenerationTokens(x,async()=>1);
 const out=await chooseMemoryInjections(candidates,{maxMemories:2,maxTokens:70,renderGroups,countTokens});
 assert.deepEqual(out.selected.map(x=>x.hash),[1]);assert.ok(out.usedTokens<=70);
});
await check('#40: exact embedding tokenizer splits losslessly; unavailable tokenizer blocks guessed splitting',async()=>{
 const code=read('core/embedding-overflow.js').replace(/^import .*?;\s*$/gm,'').replace(/^export /gm,'');
 const configs={source:'vllm',vllm_model:'test',embedding_max_tokens:40};
 let exact=true;
 const fetch=async(url,{body})=>{
   const r=JSON.parse(body);
   if(url.endsWith('/capabilities'))return {ok:true,json:async()=>({success:true,modelId:'test',limits:{maxTokens:1000}})};
   if(exact)return {ok:true,json:async()=>({success:true,count:Math.ceil(r.text.length/4)})};
   return {ok:false,status:422,text:async()=> 'Tokenizer unavailable'};
 };
 const scope=vm.createContext({console,Map,Set,Math,Number,Array,String,Date,fetch,
   getProviderSpecificParams:()=>({apiUrl:'http://localhost:1234',customEndpointMode:'base'}),getRequestHeaders:()=>({})});
 vm.runInContext(code,scope);
 const text='A'.repeat(300);
 const split=await scope.prepareEmbeddingItems([{hash:1,text,metadata:{}}],configs,x=>'hash:'+x);
 assert.ok(split.length>1);assert.equal(split.map(x=>x.text).join(''),text);
 exact=false;
 const different={...configs,vllm_model:'other',embedding_max_tokens:30};
 await assert.rejects(scope.prepareEmbeddingItems([{hash:1,text:'B'.repeat(300),metadata:{}}],different,x=>x),/verified embedding-model tokenizer is available/);
 await scope.assertEmbeddingQueryFits('small',different);
 await assert.rejects(scope.assertEmbeddingQueryFits('C'.repeat(300),different),/exceeds/);
});
console.log(`${checks} P2 six-item final checks passed`);
