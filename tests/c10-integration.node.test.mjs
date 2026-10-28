import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {planInjection} from '../utils/prompt-budget.js';
import {wrapPromptBlock} from '../utils/prompt-receipts.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const code=read('core/chat-vectorization.js');

test('C10 #115: runtime uses final C09 output rather than raw retrieval hits',()=>{
    const planner=code.indexOf('const budgetPlan=await planBudgetedInjection(chunksToInject,settings,injectionNonce)');
    const injection=code.indexOf('const injection=injectChunksIntoPrompt(chunksToInject,settings,debugData,injectionNonce,budgetPlan.renderedBlocks)');
    const finalSelection=code.indexOf('chunksToInject = finalPlan.items');
    assert.ok(finalSelection>=0&&finalSelection<planner&&planner<injection);
});
test('C10 #115: exact rendered blocks are passed to registration without a macro rerender',()=>{
    assert.match(code,/const insertedText = preparedBlocks\?\.\[0\] \?\?/);
    assert.match(code,/const groupText = preparedBlocks\?\.\[groupIndex\] \?\?/);
});
test('C10 #115: token cap and margin are user configurable',()=>{
    const ui=read('ui/ui-manager.js'),index=read('index.js');
    for(const field of ['injection_token_cap','injection_safety_margin']) {
        assert.match(ui,new RegExp(`id="vecthare_${field}"`));
        assert.match(index,new RegExp(`${field}:`));
    }
});
test('C10 #187: host assembly events are registered for both completion styles',()=>{
    const index=read('index.js');
    assert.match(index,/event_types\.CHAT_COMPLETION_PROMPT_READY/);
    assert.match(index,/event_types\.GENERATE_AFTER_COMBINE_PROMPTS/);
    assert.match(index,/promptReceipts\.observe\('chat'/);
    assert.match(index,/promptReceipts\.observe\('text'/);
});
test('C10 #187: chat switch, edits and pagehide invalidate pending confirmations',()=>{
    const index=read('index.js');
    assert.match(index,/const invalidateChat = \(\) => \{\s*promptReceipts\.invalidate\(\)/);
    assert.match(index,/const invalidateMessage = \(\) => \{\s*promptReceipts\.invalidate\(\)/);
    assert.match(index,/onPageHide = \(\) => \{promptReceipts\.invalidate\(\)/);
});
test('C10 #187: debugger reports assembly status separately from registration',()=>{
    const ui=read('ui/search-debug.js');
    assert.match(ui,/finalReceipt=data\.injection\.finalReceipt/);
    assert.match(ui,/FINAL INCLUSION UNCONFIRMED/);
    assert.match(ui,/data\.promptBudget\?\.tokens/);
});
test('C10 #88 bridge: only an included group spends a verified ledger receipt',()=>{
    const source=read('core/prompt-receipt-runtime.js');
    assert.match(source,/if\(group\.status!=='included'\) continue/);
    assert.match(source,/activationFrequencyLedger\.recordActivation/);
    assert.match(read('utils/activation-frequency-ledger.js'),/createDurableFrequencyLedger\(\)/);
});
test('C10 rendered token count includes both unique sentinels and wrapper',async()=>{
    const nonce='abcdabcdabcdabcdabcdabcdabcdabcd';
    const render=chunks=>chunks.length?[wrapPromptBlock(`<wrapper>${chunks[0].text}</wrapper>`,nonce,0)]:[];
    const out=await planInjection({candidates:[{hash:'x',text:'hello'}],render,tokenizer:x=>x.length,availableTokens:512});
    assert.equal(out.tokens,out.renderedBlocks[0].length);
    assert.match(out.renderedBlocks[0],/VH:abcdabcd.*BEGIN/);
    assert.equal(out.trimmed.length,0);
});
test('C10 planned registration block is a snapshot even when its underlying data changes',async()=>{
    let wrapper='first';const render=items=>items.map(item=>`${wrapper}-${item.text}`);
    const out=await planInjection({candidates:[{hash:'x',text:'hello'}],render,tokenizer:x=>x.length,availableTokens:200});
    wrapper='second';assert.equal(out.renderedBlocks[0],'first-hello');
});
test('C10 original signal-dependent frequency rules remain disabled until host verification',()=>{
    assert.match(read('utils/activation-frequency-ledger.js'),/C08_FINAL_INCLUSION_RECEIPT_AVAILABLE = false/);
});
