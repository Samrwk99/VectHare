/** I13: zero is a meaningful setting, not an absent value. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { evaluateConditionRule, filterChunksByConditions } from '../core/conditional-activation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = f => fs.readFileSync(path.join(root, f), 'utf8');
const quiet = {log(){},warn(){},error(){},debug(){}};
function extractFunction(file, name, scope={}) {
    const code=source(file);
    const match = new RegExp(`(?:async )?function ${name}\\(`).exec(code);
    assert.ok(match, `${name} exists`);
    const end=code.indexOf('\n}\n',match.index);
    assert.ok(end>match.index, `${name} closing brace`);
    return vm.runInNewContext(`${code.slice(match.index,end+2)}\n${name}`,{console:quiet,...scope});
}
function evalDeclaration(file, re, vars, expression){
    const match=re.exec(source(file));
    assert.ok(match,`declaration matched in ${file}`);
    return vm.runInNewContext(`${match[0]}; ${expression}`,vars);
}

test('#52: retrieved vector scores of zero are preserved in search and visualizer',()=>{
    const vector=source('core/chat-vectorization.js');
    assert.match(vector,/finalScore: meta\.score \?\? 1\.0/);
    assert.match(vector,/score: meta\.score \?\? 1\.0/);
    assert.match(vector,/similarity: meta\.score \?\? 1\.0/);
    assert.match(vector,/score: e\.score \?\? 1\.0/);
    const visualizer=source('ui/chunk-visualizer.js');
    assert.match(visualizer,/score: chunk\.score \?\? 1/);
    assert.match(visualizer,/similarity: chunk\.similarity \?\? 1/);
    // Inspect actual score expressions from source rather than a copied implementation.
    const expression=vector.match(/score:\s*(meta\.score \?\? 1\.0)/)?.[1];
    assert.ok(expression);
    assert.equal(vm.runInNewContext(expression,{meta:{score:0}}),0);
    assert.equal(vm.runInNewContext(expression,{meta:{}}),1);
});

test('#125: BM25 b=0 and k1=0 are honored by both scoring paths and the UI',()=>{
    let seen=[];
    const scoreResults=extractFunction('core/core-vector-api.js','scoreResults',{
        applyBM25Scoring:(items,text,options)=>{seen.push(options);return items;},
        applyKeywordBoosts:(items)=>items,
    });
    const data=[{hash:1,score:0.4}];
    scoreResults(data,'hello',1,{keyword_scoring_method:'bm25',bm25_b:0,bm25_k1:0});
    scoreResults(data,'hello',1,{keyword_scoring_method:'hybrid',bm25_b:0,bm25_k1:0});
    assert.equal(seen.length,2);
    for(const options of seen){assert.equal(options.b,0);assert.equal(options.k1,0);}
    const hybrid=source('core/hybrid-search.js');
    assert.match(hybrid,/b: settings\.bm25_b \?\? 0\.75/);
    const ui=source('ui/ui-manager.js');
    assert.match(ui,/\.val\(settings\.bm25_b \?\? 0\.75\)/);
    assert.match(ui,/\(settings\.bm25_b \?\? 0\.75\)\.toFixed\(2\)/);
});

test('#227 and #79: explicit score threshold=0 works with typed and legacy rules',()=>{
    for(const rule of [
        {type:'scoreThreshold',settings:{threshold:0}},
        {type:'scoreThreshold',value:'0'},
        {type:'scoreThreshold',settings:{value:'0'}}
    ]) {
        assert.equal(evaluateConditionRule(rule,{currentChunkScore:0}),true);
    }
    assert.equal(evaluateConditionRule({type:'scoreThreshold',settings:{threshold:0.5}}, {currentChunkScore:0}),false);
    const condition={enabled:true,rules:[{type:'scoreThreshold',settings:{threshold:0.5}}]};
    // Important: a real vector score of 0 must not be replaced by similarity: 1.
    const hits=[{hash:'a',score:0,similarity:1,conditions:condition}];
    assert.equal(filterChunksByConditions(hits,{}).length,0);
});

test('#228: recency messagesAgo=0 works with eq and lte, including legacy rules',()=>{
    const zeroAge={messageCount:10,currentChunkMessageIndex:10};
    const older={messageCount:10,currentChunkMessageIndex:9};
    for(const rule of [
        {type:'recency',settings:{messagesAgo:0,operator:'eq'}},
        {type:'recency',settings:{value:'0',operator:'eq'}},
        {type:'recency',settings:{messagesAgo:0,operator:'lte'}},
        {type:'recency',value:'0',settings:{operator:'lte'}},
    ]){
        assert.equal(evaluateConditionRule(rule,zeroAge),true);
        assert.equal(evaluateConditionRule(rule,older),false);
    }
    assert.equal(evaluateConditionRule({type:'recency',settings:{messagesAgo:0,operator:'gte'}},older),true);
});

test('#96: zero World Info threshold works with hybrid and non-hybrid mode',()=>{
    const code=source('core/world-info-integration.js');
    const start=code.indexOf('const baseThreshold =');
    const end=code.indexOf(';',code.indexOf('const threshold =',start))+1;
    assert.ok(start>0 && end>start);
    const snippet=code.slice(start,end);
    for (const hybrid of [false,true]){
        assert.equal(vm.runInNewContext(`${snippet}; threshold`,{settings:{world_info_threshold:0,hybrid_search_enabled:hybrid}}),0);
    }
    assert.match(source('ui/ui-manager.js'),/\.val\(settings\.world_info_threshold \?\? 0\.3\)/);
});

test('#74: zero random chance never succeeds, even if Math.random()=0',()=>{
    const random=extractFunction('core/conditional-activation.js','evaluateRandomChanceCondition',{
        Math:{random:()=>0},
    });
    assert.equal(random({settings:{probability:0}},{}),false);
    assert.equal(random({value:'0'},{}),false);
    assert.equal(random({settings:{probability:100}},{}),true);
    assert.equal(random({settings:{probability:50}},{}),true);
});

test('#58: zero Content Vectorizer overlap survives UI, preview, and execution',()=>{
    const ui=source('ui/content-vectorizer.js');
    const line=ui.match(/const chunkOverlap = [^\n]+;/)?.[0];
    assert.ok(line);
    const vars={currentSettings:{chunkOverlap:0},strategyDefaults:{defaultOverlap:100},defaults:{chunkOverlap:200}};
    assert.equal(vm.runInNewContext(`${line}\nchunkOverlap`,vars),0);
    assert.match(ui,/chunkOverlap: currentSettings\.chunkOverlap \?\? type\.defaults\.chunkOverlap/);
    assert.match(source('core/content-vectorization.js'),/chunkOverlap: settings\.chunkOverlap \?\? type\.defaults\.chunkOverlap/);
});

test('#193: chunk injection-depth input preserves 0 and defaults invalid input',()=>{
    const ui=source('ui/chunk-visualizer.js');
    const body=ui.match(/const parsedDepth = Number\.parseInt\(\$\(this\)\.val\(\), 10\);\s*const depth = Number\.isFinite\(parsedDepth\) \? parsedDepth : 2;/)?.[0];
    assert.ok(body);
    for (const [value, expected] of [['0',0],['5',5],['',2]]) {
        assert.equal(vm.runInNewContext(`${body}\ndepth`,{$:()=>({val:()=>value})}),expected);
    }
});

test('#193: collection depth 0 is persisted (and blank defaults to 2)',()=>{
    const ui=source('ui/database-browser.js');
    const expression=ui.match(/const depth =\s*position === 1\s*\? \(Number\.isFinite\(Number\.parseInt\(\$\("#vecthare_collection_depth"\)\.val\(\), 10\)\)\s*\? Number\.parseInt\(\$\("#vecthare_collection_depth"\)\.val\(\), 10\)\s*: 2\)\s*: null;/)?.[0];
    assert.ok(expression);
    for(const [value,expected] of [['0',0],['9',9],['',2]]){
        assert.equal(vm.runInNewContext(`${expression}\ndepth`,{position:1,$:()=>({val:()=>value})}),expected);
    }
    assert.equal(vm.runInNewContext(`${expression}\ndepth`,{position:0,$:()=>({val:()=>0})}),null);
});
