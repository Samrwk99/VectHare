import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveInjectionBudget,planInjection} from '../utils/prompt-budget.js';
import {wrapPromptBlock} from '../utils/prompt-receipts.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=fs.readFileSync(path.join(root,'core/chat-vectorization.js'),'utf8');
const between=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b)};
const sourceParts=[between('function hasInjectableText(', '/**\n * Builds the nested prompt structure'),
    between('function buildNestedInjectionText(','/**\n * Resolves the effective injection position'),
    between('function resolveChunkInjectionPosition(','/** Render exact positioned prompt blocks'),
    between('/** Render exact positioned prompt blocks','/**\n * Stage 8: Format and inject'),
    between('function injectChunksIntoPrompt(', '// ============================================================================\n// MAIN ORCHESTRATOR')];
function fixture({maxContext=4096}={}) {
    let suffix='first';const prompts={};const quiet={log(){},warn(){},error(){},debug(){}};
    const host={maxContext,getTokenCountAsync:async text=>text.length};
    const scope={console:quiet,getContext:()=>host,resolveInjectionBudget,planInjection,wrapPromptBlock,
        extension_prompts:prompts,EXTENSION_PROMPT_TAG:'3_vecthare',LEGACY_WORLD_INFO_PROMPT_TAG:'vecthare_world_info',
        getCollectionMeta:()=>({context:'collection wrapper'}),getChunkMetadata:hash=>hash==='other'?{position:3,depth:1}:{position:0,depth:2},
        substituteParams:text=>`${text} ${suffix}`,setExtensionPrompt:(tag,value,position,depth)=>prompts[tag]={value,position,depth},
        makePromptSentinel:()=> 'abcdef0123456789abcdef0123456789',
        recordChunkFate(){},frequencyRecordKey:c=>String(c.recordId??c.hash),
        promptReceipts:{invalidate(){}}
    };
    vm.createContext(scope);
    vm.runInContext(sourceParts.join('\n'),scope);
    return {scope,prompts,host,setSuffix:v=>suffix=v};
}
const c=(hash,text)=>({hash,text,collectionId:'docs',score:0.8});
test('C10 actual injection registers same text budgeted with host tokenizer even after macro change',async()=>{
    const {scope,prompts,setSuffix}=fixture();const nonce='abcdef0123456789abcdef0123456789';
    const plan=await scope.planBudgetedInjection([c('a','X'.repeat(900))],{injection_token_cap:250,injection_safety_margin:128,rag_context:'global'},nonce);
    assert.equal(plan.chosen.length,1);assert.equal(plan.trimmed.length,1);assert.ok(plan.tokens<=250);
    setSuffix('changed');
    const result=scope.injectChunksIntoPrompt(plan.chosen,{rag_context:'global'},{},nonce,plan.renderedBlocks);
    assert.equal(result.verified,true);
    assert.equal(result.groups.length,1);
    assert.equal(prompts['3_vecthare'].value,plan.renderedBlocks[0]);
    assert.match(result.groups[0].text,/first/);assert.doesNotMatch(result.groups[0].text,/changed/);
});
test('C10 real wrapper plus two separate positions both charged against one budget',async()=>{
    const {scope,prompts}=fixture();const nonce='abcdef0123456789abcdef0123456789';
    const plan=await scope.planBudgetedInjection([c('a','first memory'),c('other','second memory')],{injection_token_cap:500,rag_context:'global'},nonce);
    assert.equal(plan.chosen.length,2);assert.equal(plan.renderedBlocks.length,2);
    assert.equal(plan.tokens,plan.renderedBlocks.reduce((n,t)=>n+t.length,0));
    const result=scope.injectChunksIntoPrompt(plan.chosen,{rag_context:'global'},{},nonce,plan.renderedBlocks);
    assert.equal(result.groups.length,2);
    assert.equal(prompts['3_vecthare_pos0'].value,plan.renderedBlocks[0]);
    assert.equal(prompts['3_vecthare_pos1'].value,plan.renderedBlocks[1]);
});
test('C10 unknown host context keeps planner empty even with candidates',async()=>{
    const {scope}=fixture({maxContext:null});
    const plan=await scope.planBudgetedInjection([c('a','memory')],{},'abcdef0123456789abcdef0123456789');
    assert.equal(plan.chosen.length,0);assert.equal(plan.budget.reason,'unknown-context-size');
});
test('C10 a throwing host tokenizer never exceeds fallback budget',async()=>{
    const {scope,host}=fixture();host.getTokenCountAsync=()=>{throw Error('tokenizer-unavailable')};
    const plan=await scope.planBudgetedInjection([c('a','X'.repeat(700))],{injection_token_cap:230},'abcdef0123456789abcdef0123456789');
    assert.ok(plan.tokens<=230);assert.equal(plan.method,'conservative-code-unit-estimate');
});
