import {test} from 'node:test';
import assert from 'node:assert/strict';
import {overfetchSize,candidateId,rankCandidates,resolveGroupConstraints,expandRequiredLinks,selectFinal,planCandidates,removeOverlappingGroups,resolveExclusiveCollections} from '../core/retrieval-planner.js';
import {createClientLexicalIndex,lexicalCandidates,clearLexicalCache} from '../core/lexical-provider.js';
import {processChunkGroups,applyExclusiveGroups} from '../core/chunk-groups.js';
const chunk=(collectionId,hash,score=.8,metadata={})=>({collectionId,hash,score,metadata});
const g=(collectionId,id,members,extra={})=>({collectionId,id,members,mode:'exclusive',...extra});
test('C09 #108 bounded overfetch never underfetches a requested K',()=>{assert.equal(overfetchSize(5),15);assert.equal(overfetchSize(300),300);assert.equal(overfetchSize(0),0);assert.equal(overfetchSize(3,{factor:100}),15);});
test('C09 #192 qualification distinguishes equal physical hashes in distinct collections',()=>assert.notEqual(candidateId(chunk('a',11)),candidateId(chunk('b',11))));
test('C09 #192 priorities only break ties after score',()=>{const a=chunk('a',1,.6),b=chunk('b',2,.7);assert.ok(rankCandidates(a,b,{a:999})>0);assert.ok(rankCandidates(a,b,{})>0);});
test('C09 #192 stable tie breaks across input permutations',()=>{const a=chunk('a','2'),b=chunk('a','1');for(let i=0;i<8;i++)assert.deepEqual(selectFinal(i%2?[a,b]:[b,a],{limit:1}).items.map(x=>x.hash),['1']);});
test('C09 #192 quotas refuse extra collection rows without re-enabling disabled',()=>{const r=selectFinal([chunk('a',1,.9),chunk('a',2,.8),chunk('b',3,.7)],{limit:2,quotas:{a:1}});assert.deepEqual(r.items.map(x=>x.hash),[1,3]);assert.equal(r.reasons[0].code,'collection-quota');});
test('C09 #139 overlapping exclusive groups never restore their shared loser',()=>{const items=[chunk('a','A',.9),chunk('a','B',.8),chunk('a','C',.7)];const groups=[g('a','1',['A','B']),g('a','2',['B','C'],{mandatory:true})];const r=resolveGroupConstraints(items,groups);assert.deepEqual(r.items.map(x=>x.hash),['A']);assert.ok(r.reasons.some(x=>x.code==='mandatory-group-unsatisfied'));});
test('C09 #139 group order cannot alter simultaneous winner constraints',()=>{const items=[chunk('a','A',.7),chunk('a','B',.8),chunk('a','C',.9)],gs=[g('a','1',['A','B']),g('a','2',['A','C'])];assert.deepEqual(resolveGroupConstraints(items,gs).items,resolveGroupConstraints(items,gs.reverse()).items);});
test('C09 #139 missing mandatory owner never injects another tenant record',()=>{const r=resolveGroupConstraints([chunk('b','X')],[g('a','g',['X'],{mandatory:true})]);assert.equal(r.items.length,1);assert.equal(r.reasons[0].code,'mandatory-group-unsatisfied');});
test('C09 #55 scoped hard group member missing top-K is independently fetched',async()=>{const item=chunk('a','A');const result=await expandRequiredLinks([item],[{collectionId:'a',id:'g',mode:'inclusive',linkType:'hard',members:['A','B']}],{getByIds:async ({collectionId,recordIds})=>({status:'confirmed',complete:true,items:recordIds.map(id=>chunk(collectionId,id))})});assert.deepEqual(result.items.map(x=>x.hash),['A','B']);});
test('C09 #54 hard explicit link from metadata is independently fetched',async()=>{const item=chunk('a','A',.9,{links:[{type:'hard',target:'B'}]});const result=await expandRequiredLinks([item],[],{getByIds:async()=>({status:'confirmed',complete:true,items:[chunk('a','B')]})});assert.equal(result.items.length,2);});
test('C09 #54 no verified getByIds keeps original and reports missing capability',async()=>{const r=await expandRequiredLinks([chunk('a','A',.8,{links:[{type:'hard',target:'B'}]})]);assert.equal(r.items.length,1);assert.equal(r.reasons[0].code,'get-by-ids-unverified');});
test('C09 #54 cross-scope forged result must be discarded',async()=>{const r=await expandRequiredLinks([chunk('a','A',.8,{links:[{type:'hard',target:'B'}]})],[],{getByIds:async()=>({status:'confirmed',complete:true,items:[chunk('b','B')]})});assert.equal(r.items.length,1);assert.equal(r.reasons[0].code,'get-by-ids-scope-mismatch');});
test('C09 #54 partial lookup cannot authorise inclusion',async()=>{const r=await expandRequiredLinks([chunk('a','A',.8,{links:[{type:'hard',target:'B'}]})],[],{getByIds:async()=>({status:'partial',items:[chunk('a','B')]})});assert.equal(r.items.length,1);});
test('C09 #55 candidate expansion is bounded and records omissions',async()=>{const r=await expandRequiredLinks([chunk('a','A')],[{id:'g',collectionId:'a',mode:'inclusive',linkType:'hard',members:['A','B','C','D']}],{maxIds:1,getByIds:async({recordIds})=>({status:'confirmed',complete:true,items:recordIds.map(id=>chunk('a',id))})});assert.equal(r.items.length,2);assert.equal(r.reasons[0].code,'expansion-cap');});
test('C09 #76 grouped overlap uses message IDs not combined-text hashes',()=>{const a=chunk('a','A',.9,{chatId:'c1',messageIds:[1,2]}),b=chunk('a','B',.8,{chatId:'c1',messageIds:[2,3]}),c=chunk('b','C',.7,{chatId:'c1',messageIds:[2]});const r=removeOverlappingGroups([b,c,a]);assert.deepEqual(r.items.map(x=>x.hash),['A','C']);assert.equal(r.reasons[0].code,'overlapping-message-membership');});
test('C09 #76 missing message references never suppress a candidate',()=>assert.equal(removeOverlappingGroups([chunk('a','x'),chunk('a','y')]).items.length,2));
test('C09 #147 one deterministic exclusive collection wins, not every exclusive collection',()=>{const metas={a:{exclusiveWhenActive:true,exclusiveScope:'all',retrievalPriority:1},b:{exclusiveWhenActive:true,exclusiveScope:'all',retrievalPriority:2}};const r=resolveExclusiveCollections(['a','b','doc'],id=>metas[id]);assert.deepEqual(r.ids,['b']);});
test('C09 #147 exclusive activation only considers already-active collection IDs',()=>{const r=resolveExclusiveCollections(['doc'],()=>({exclusiveWhenActive:true}));assert.deepEqual(r.ids,['doc']);});
test('C09 #147 lorebook-only exclusivity retains ordinary docs',()=>{const meta={exclusiveWhenActive:true,exclusiveScope:'lorebook'};const r=resolveExclusiveCollections(['lorebook:1','document:1'],id=>id==='lorebook:1'?meta:{});assert.deepEqual(r.ids,['lorebook:1','document:1']);});
test('C09 #108 plan refills after late filtering and selects an eligible record',async()=>{const seen=[];const r=await planCandidates({limit:2,collections:['a'],query:'q',fetchRound:async ({round,limit})=>{seen.push([round,limit]);return{items:round===0?[chunk('a',1),chunk('a',2)]:[chunk('a',1),chunk('a',2),chunk('a',3),chunk('a',4)],exhausted:round===1};},filter:async items=>items.filter(c=>c.hash>2)});assert.equal(r.items.length,2);assert.equal(r.rounds,2);assert.equal(seen.length,2);});
test('C09 #108 repeated pages stop instead of infinite refill',async()=>{const r=await planCandidates({limit:3,fetchRound:async()=>({items:[chunk('a',1)]})});assert.equal(r.rounds,2);assert.ok(r.reasons.some(x=>x.code==='refill-no-progress'));});
test('C09 #108 uncertain pagination stops and reports partial',async()=>{const r=await planCandidates({limit:3,fetchRound:async()=>({items:[],complete:false})});assert.equal(r.rounds,1);assert.equal(r.reasons[0].code,'refill-backend-incomplete');});
test('C09 #108 two refill rounds maximum even if requested more',async()=>{const r=await planCandidates({limit:5,maxRounds:99,fetchRound:async({round})=>({items:[chunk('a',round)]})});assert.equal(r.rounds,3);assert.ok(r.reasons.some(x=>x.code==='refill-bound-reached'));});
test('C09 #68 no lexical contract means vector-only',async()=>assert.deepEqual(await lexicalCandidates({collectionKey:'a',query:'dragon',limit:3}),{mode:'none',items:[],reason:'no-independent-lexical-provider'}));
test('C09 #68 partial inventory cannot build a client BM25 index',()=>assert.equal(createClientLexicalIndex({collectionKey:'a',version:'v1',items:[],complete:false,verified:true,expectedCount:0}),null));
test('C09 #68 cross-tenant index rows are refused',()=>assert.equal(createClientLexicalIndex({collectionKey:'a',version:'v1',items:[{collectionKey:'b',hash:1,text:'dragon'}],complete:true,verified:true,expectedCount:1}),null));
test('C09 #68 independently indexed lexical-only hit can appear beyond vector top K',async()=>{clearLexicalCache();const snap={collectionKey:'a',version:'v1',verified:true,complete:true,expectedCount:2,items:[{collectionKey:'a',hash:1,text:'castle'},{collectionKey:'a',hash:2,text:'dragons dragons dragons'}]};const r=await lexicalCandidates({collectionKey:'a',query:'dragons',limit:2,provider:'clientScan',clientSnapshot:snap});assert.equal(r.mode,'clientScan');assert.equal(r.items[0].hash,2);});
test('C09 #68 wrong client snapshot cannot silently authorize a query',async()=>{const r=await lexicalCandidates({collectionKey:'b',query:'dragon',limit:1,provider:'clientScan',clientSnapshot:{collectionKey:'a',version:'1',complete:true,verified:true,expectedCount:0,items:[]}});assert.equal(r.mode,'none');});
test('C09 #68 unverified native lexical results are rejected',async()=>{const r=await lexicalCandidates({collectionKey:'a',query:'q',limit:1,provider:'native',nativeSearch:async()=>({scope:'a',items:[{collectionKey:'a',hash:1,bm25Score:1}]})});assert.equal(r.mode,'none');});
test('C09 #68 scoped verified native independent result accepted',async()=>{const r=await lexicalCandidates({collectionKey:'a',query:'q',limit:1,provider:'native',nativeSearch:async()=>({scope:'a',verified:true,items:[{collectionKey:'a',hash:3,bm25Score:4}]})});assert.equal(r.mode,'native');assert.equal(r.items[0].hash,3);});
test('C09 #55 original chunk-group implementation never excludes cross-collection same hash',()=>{const a=chunk('a','x'),b=chunk('b','x');const r=applyExclusiveGroups([a,b],[g('a','g',['x','z'])]);assert.equal(r.chunks.length,2);});
test('C09 #139 original chunk-group processor applies scoped deterministic exclusion',()=>{const a=chunk('a','A',.7),b=chunk('a','B',.8);const r=processChunkGroups([a,b],[g('a','group',['A','B'])],new Map());assert.deepEqual(r.chunks.map(x=>x.hash),['B']);});
test('C09 #139 real runtime recordIds still match group membership by physical hash',()=>{const a={...chunk('a','A',.9),recordId:'a#hash%3AA'},b={...chunk('a','B',.8),recordId:'a#hash%3AB'};const r=resolveGroupConstraints([b,a],[g('a','g',['A','B'])]);assert.deepEqual(r.items.map(x=>x.hash),['A']);});
test('C09 #55 real runtime recordIds do not hide required group members',async()=>{const a={...chunk('a','A',.8),recordId:'a#hash%3AA'};const r=await expandRequiredLinks([a],[{collectionId:'a',id:'g',mode:'inclusive',linkType:'hard',members:['A','B']}],{getByIds:async()=>({status:'confirmed',complete:true,items:[chunk('a','B')]})});assert.deepEqual(r.items.map(x=>x.hash),['A','B']);});
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('C09 #56 summary expansion preserves multiple summaries of a scoped parent',async()=>{
    const src=fs.readFileSync(path.join(root,'core/chat-vectorization.js'),'utf8');
    const start=src.indexOf('async function expandSummaryChunks('),end=src.indexOf('\n}\n',start)+2;
    assert.ok(start>0&&end>start);
    const fn=vm.runInNewContext(`${src.slice(start,end)}\nexpandSummaryChunks`,{
        console:{warn(){},log(){}},addTrace(){},recordChunkFate(){},
        getSavedHashes:async id=>({hashes:['P'],metadata:[{text:`original-${id}`}]})
    });
    const input=[chunk('a','SA',.9,{isSummary:true,parentHash:'P'}),chunk('a','SB',.8,{isSummary:true,parentHash:'P'}),chunk('b','SC',.7,{isSummary:true,parentHash:'P'})];
    const result=await fn(input,['a','b'],{},{});
    assert.equal(result.length,3);
    assert.deepEqual(Array.from(result,x=>x.text),['original-a','original-a','original-b']);
    assert.deepEqual(Array.from(result,x=>x.metadata.originalSummaryHash),['SA','SB','SC']);
});

test('C09 #76 copied positional IDs across chats are not treated as overlap',()=>{const r=removeOverlappingGroups([chunk('a',1,.8,{chatId:'one',messageIds:[1]}),chunk('a',2,.7,{chatId:'two',messageIds:[1]})]);assert.equal(r.items.length,2);});
test('C09 #76 unscoped legacy message positions do not trigger destructive deduplication',()=>assert.equal(removeOverlappingGroups([chunk('a',1,.8,{messageIds:[1]}),chunk('a',2,.7,{messageIds:[1]})]).items.length,2));

test('C09 #139 ambiguous duplicate physical hash is excluded fail-closed',()=>{const r=selectFinal([{...chunk('a','x'),recordId:'a#one'},{...chunk('a','x'),recordId:'a#two'}],{limit:2});assert.equal(r.items.length,0);assert.ok(r.reasons.some(x=>x.code==='ambiguous-physical-hash'));});
test('C09 #192 every ineligible record receives an exclusion reason',()=>{const r=selectFinal([{...chunk('a','x'),eligible:false}],{limit:1});assert.equal(r.items.length,0);assert.equal(r.reasons[0].code,'ineligible-or-disabled');});

test('C09 #76 copied chat UIDs remain separate when origin differs',()=>{const a=chunk('a',1,.9,{messageRefs:[{chatId:'c1',messageUid:'same'}]}),b=chunk('a',2,.8,{messageRefs:[{chatId:'c2',messageUid:'same'}]});assert.equal(removeOverlappingGroups([a,b]).items.length,2);});
