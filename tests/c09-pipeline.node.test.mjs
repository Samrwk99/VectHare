/** Run the real orchestrator in a host-isolated VM to check bounded C09 refill. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {candidateId,removeOverlappingGroups,selectFinal} from '../core/retrieval-planner.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=fs.readFileSync(path.join(root,'core/chat-vectorization.js'),'utf8');
const first=source.indexOf('export async function rearrangeChat('),last=source.indexOf('\n}\n',first)+2;
assert.ok(first>=0&&last>first);
const functionText=source.slice(first,last).replace('export async function','async function');
function fixture({roundResults,eligible=x=>true,dedup=x=>false}={}) {
    const calls=[],errors=[],captured=[];
    const chat=[{mes:'query',is_user:true}];
    const scope={
        console:{log(){},warn(){},debug(){},error(){},info(){}},window:{},
        chatJobs:{startJob:()=>({assertCurrent(){},finish(){},signal:{aborted:false}})},
        StaleJobError:class StaleJobError extends Error{},
        clearVectHarePrompts(){},getCurrentChatId:()=> 'chat-1',
        gatherCollectionsToQuery:()=>['a'],buildSearchQuery:()=> 'query',
        extractChatKeywords:()=> [],getCollectionMeta:()=>({groups:[]}),
        getRequiredConditionDepth:()=>0,getContext:()=>({characterId:1,name2:'friend'}),
        chatIdForActivation:()=> 'chat-1',worldInfoSnapshots:{previous:()=>({entries:[],source:'unavailable'})},
        buildSearchContext:()=>({}),filterActiveCollections:async()=>['a'],
        createDebugData:()=>({stages:{},stats:{},trace:[],settings:{}}),
        addTrace(d,stage,action,details={}){d.trace.push({stage,action,details});},
        setLastSearchDebug:d=>captured.push(d),
        queryAndMergeCollections:async (collections,q,settings,chat,debug,factor=3)=>{
            calls.push(factor);return (roundResults[Math.max(0,factor-3)]||[]).map(x=>({...x}));
        },
        hasVerifiedCapability:()=>false,
        expandRequiredLinks:async chunks=>({items:chunks,reasons:[]}),
        getChunkMetadata:()=>null,recordChunkFate(){},
        applyKeywordBoost:items=>items,
        containsLexicalPhrase:()=>false,
        expandSummaryChunks:async items=>items,
        applyThresholdFilter:(items,t)=>items.filter(i=>i.score>=t),
        applyTemporalDecayStage:items=>items,
        applyConditionsStage:async items=>items.filter(eligible),
        applyGroupsAndLinksStage:async items=>items,
        hasInjectableText:()=>true,
        deduplicateChunks:items=>({toInject:items.filter(x=>!dedup(x)),skipped:items.filter(dedup)}),
        removeOverlappingGroups,selectFinal,candidateId,
        getChatCollectionPolicy:()=>({selectedCollections:[]}),
        injectChunksIntoPrompt:items=>({verified:true,text:items.map(x=>x.text).join(','),groups:[]}),
        toastr:{error:s=>errors.push(s)},
    };
    const context=vm.createContext(scope);
    const fn=vm.runInContext(`${functionText}\nrearrangeChat`,context);
    const settings={query:2,top_k:2,score_threshold:0,enabled_world_info:false};
    return {run:()=>fn(chat,settings,'normal'),calls,errors,captured};
}
const c=(hash,opts={})=>({hash,recordId:`a#${hash}`,collectionId:'a',score:1,text:`memory ${hash}`,metadata:{},...opts});
test('C09 live pipeline refills after conditions plus chat dedup and selects exactly K',async()=>{
    const f=fixture({roundResults:[[c('a'),c('b')],[c('a'),c('b'),c('c'),c('d')]],eligible:i=>i.hash!=='a',dedup:i=>i.hash==='b'});
    await f.run();
    assert.deepEqual(f.errors,[]);
    assert.deepEqual(f.calls,[3,4]);
    assert.equal(f.captured.length,1);
    assert.deepEqual(Array.from(f.captured[0].stages.injected,x=>x.hash),['c','d']);
    assert.equal(f.captured[0].retrievalPlanner.refillRounds,1);
});
test('C09 live pipeline stops at two refill rounds and explains missing slots',async()=>{
    const f=fixture({roundResults:[[c('a')],[c('a'),c('b')],[c('a'),c('b'),c('c')]],eligible:()=>false});
    await f.run();
    assert.deepEqual(f.errors,[]);
    assert.deepEqual(f.calls,[3,4,5]);
    assert.equal(f.captured.length,1);
    assert.equal(f.captured[0].retrievalPlanner.refillReason,'refill-bound-reached');
    assert.deepEqual(Array.from(f.captured[0].stages.injected),[]);
});
test('C09 live pipeline stops refill on no progress',async()=>{
    const f=fixture({roundResults:[[c('a')],[c('a')]]});
    await f.run();
    assert.deepEqual(f.errors,[]);
    assert.deepEqual(f.calls,[3,4]);
    assert.equal(f.captured[0].retrievalPlanner.refillReason,'refill-no-progress');
});
