import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveInjectionBudget,planInjection,countPromptTokens} from '../utils/prompt-budget.js';
import {createPromptReceiptTracker,wrapPromptBlock} from '../utils/prompt-receipts.js';

const nonce='abcdef0123456789abcdef0123456789';
const c=(id,text)=>({hash:id,recordId:id,text});
const tokenize=text=>text.length;
const render=items=>items.length?['<R>\n'+items.map(x=>x.text).join('\n')+'\n</R>']:[];

for(const v of [undefined,null,'',NaN,0,-1,'NaN'])test('C10 unknown context fails closed '+String(v),()=>{
    assert.equal(resolveInjectionBudget({maxContext:v}).availableTokens,0);
});
test('C10 budget min of cap and context headroom',()=>{
    assert.equal(resolveInjectionBudget({maxContext:4096,cap:128,margin:128}).availableTokens,128);
    assert.equal(resolveInjectionBudget({maxContext:1024,cap:1000,margin:128}).availableTokens,384);
});
test('C10 configured zero cap defaults safely',()=>assert.equal(resolveInjectionBudget({maxContext:4096,cap:0}).capTokens,1024));
test('C10 invalid tokenizer falls back to a protective code-unit estimate',async()=>{
    assert.deepEqual(await countPromptTokens('Hello',async()=>NaN),{tokens:5,method:'conservative-code-unit-estimate'});
});
test('C10 throwing tokenizer falls back without an exception',async()=>{
    assert.equal((await countPromptTokens('Hi',async()=>{throw Error('down')})).tokens,2);
});
test('C10 asynchronous tokenizer is awaited',async()=>{
    assert.deepEqual(await countPromptTokens('Hello',async text=>text.length+1),{tokens:6,method:'host'});
});
test('C10 wrapping counted in full rather than only chunk text',async()=>{
    const out=await planInjection({candidates:[c('a','12345678')],render,tokenizer:tokenize,availableTokens:8});
    assert.equal(out.chosen.length,0);
    assert.equal(out.dropped[0].reason,'token-budget');
});
test('C10 selected token total equals exactly rendered bytes with mock tokenizer',async()=>{
    const out=await planInjection({candidates:[c('a','hello'),c('b','world')],render,tokenizer:tokenize,availableTokens:100});
    assert.equal(out.tokens,render(out.chosen)[0].length);
    assert.equal(out.chosen.length,2);
});
test('C10 long text is trimmed without breaking JS surrogate pairs',async()=>{
    const input='🙂'.repeat(90)+'ABC';
    const out=await planInjection({candidates:[c('a',input)],render,tokenizer:tokenize,availableTokens:80});
    assert.equal(out.chosen.length,1);
    assert.equal(out.trimmed.length,1);
    assert.ok(out.chosen[0].text.length<input.length);
    assert.ok(out.tokens<=80);
    assert.ok(!/[\ud800-\udbff]$/.test(out.chosen[0].text));
    assert.equal(input,'🙂'.repeat(90)+'ABC');
});
test('C10 zero budget cannot register any text',async()=>{
    const out=await planInjection({candidates:[c('a','hello')],render,tokenizer:tokenize,availableTokens:0});
    assert.equal(out.chosen.length,0);assert.equal(out.dropped[0].reason,'no-token-budget');
});
test('C10 missing text is dropped with explicit reason',async()=>{
    const out=await planInjection({candidates:[c('a',' '),c('b','ok')],render,tokenizer:tokenize,availableTokens:100});
    assert.equal(out.chosen.length,1);assert.equal(out.dropped[0].reason,'no-text');
});
test('C10 multiple placement wrappers count separately',async()=>{
    const split=items=>items.map(item=>`<R> ${item.text} </R>`);
    const out=await planInjection({candidates:[c('a','a'),c('b','b')],render:split,tokenizer:tokenize,availableTokens:18});
    assert.equal(out.chosen.length,1);assert.ok(out.tokens<=18);
});
test('C10 sentiment first candidate prioritised ahead of later candidate',async()=>{
    const out=await planInjection({candidates:[c('a','a'.repeat(70)),c('b','b'.repeat(70))],render,tokenizer:tokenize,availableTokens:90});
    assert.equal(out.chosen[0].hash,'a');assert.ok(out.tokens<=90);
});
test('C10 invalid renderer cannot forge a token count',async()=>{
    await assert.rejects(planInjection({candidates:[c('a','foo')],render:()=>42,availableTokens:30}),/renderer/);
});

const block=(i,text)=>wrapPromptBlock(text,nonce,i);
const receiptGroups=[{tag:'3_vecthare',text:block(0,'hello'),recordIds:['a'],frequencyEntries:[]},
    {tag:'3_vecthare_pos1',text:block(1,'world'),recordIds:['b'],frequencyEntries:[]}];
function fixture({clock=()=>0}={}){
    const receipts=[];let chatId='chat-A';
    const tracker=createPromptReceiptTracker({getChatId:()=>chatId,now:clock,onReceipt:r=>receipts.push(r)});
    const register=()=>tracker.register({chatId:'chat-A',nonce,turnId:'turn-A',groups:receiptGroups});
    return {tracker,receipts,register,setChat:val=>chatId=val};
}
test('C10 registration is not a verified final inclusion',()=>{
    const {tracker,register}=fixture();assert.equal(register().verified,false);
    assert.equal(tracker.current().status,'registered');
});
test('C10 full text completion prompt confirms both groups',()=>{
    const {tracker,register,receipts}=fixture();register();
    const r=tracker.observe('text',{prompt:'prompt start\n'+receiptGroups.map(g=>g.text).join('\n')+'\nend',dryRun:false});
    assert.equal(r.status,'included');assert.equal(r.verified,true);assert.deepEqual(r.recordIds,['a','b']);
    assert.equal(receipts.length,1);
});
test('C10 chat completion prompt confirms nested user/system content',()=>{
    const {tracker,register}=fixture();register();
    const r=tracker.observe('chat',{chat:[{role:'system',content:[{type:'text',text:receiptGroups[0].text},
        {type:'text',text:receiptGroups[1].text}]}],dryRun:false});
    assert.equal(r.status,'included');
});
test('C10 only complete groups are credited during partial assembly',()=>{
    const {tracker,register}=fixture();register();
    const r=tracker.observe('text',{prompt:receiptGroups[0].text+'\n'+receiptGroups[1].text.slice(0,22),dryRun:false});
    assert.equal(r.status,'partial');assert.deepEqual(r.recordIds,['a']);
    assert.deepEqual(r.groups.map(g=>g.status),['included','notIncluded']);
});
test('C10 missing both groups is notIncluded (only after usable host event)',()=>{
    const {tracker,register}=fixture();register();
    assert.equal(tracker.observe('text',{prompt:'other content',dryRun:false}).status,'notIncluded');
});
test('C10 dry-run host event cannot spend a receipt',()=>{
    const {tracker,register,receipts}=fixture();register();
    assert.equal(tracker.observe('text',{prompt:receiptGroups[0].text,dryRun:true}).verified,false);
    assert.equal(tracker.hasPending(),true);assert.equal(receipts.length,0);
});
test('C10 dry_run host alias cannot spend receipt',()=>{
    const {tracker,register}=fixture();register();
    assert.equal(tracker.observe('text',{prompt:receiptGroups[0].text,dry_run:true}).verified,false);
});
test('C10 malformed event is unknown, not notIncluded',()=>{
    const {tracker,register}=fixture();register();
    assert.equal(tracker.observe('chat',{prompt:receiptGroups[0].text}).status,'unknown');
    assert.equal(tracker.hasPending(),true);
});
test('C10 chat mismatch invalidates pending receipt',()=>{
    const {tracker,register,setChat}=fixture();register();setChat('chat-B');
    assert.equal(tracker.observe('text',{prompt:receiptGroups.map(g=>g.text).join('')}).verified,false);
    assert.equal(tracker.hasPending(),false);
});
test('C10 expired receipt cannot confirm old generation',()=>{
    let now=10;const {tracker,register}=fixture({clock:()=>now});register();now+=120001;
    assert.equal(tracker.observe('text',{prompt:receiptGroups[0].text}).status,'unknown');
});
test('C10 cancellation clears pending receipt',()=>{
    const {tracker,register}=fixture();register();tracker.invalidate();
    assert.equal(tracker.observe('text',{prompt:receiptGroups[0].text}).verified,false);
});
test('C10 observed receipt cannot be replayed',()=>{
    const {tracker,register,receipts}=fixture();register();
    tracker.observe('text',{prompt:receiptGroups.map(g=>g.text).join('')});
    tracker.observe('text',{prompt:receiptGroups.map(g=>g.text).join('')});
    assert.equal(receipts.length,1);
});
test('C10 next registration replaces stale pending prompt',()=>{
    const {tracker,register}=fixture();register();
    const newText=block(0,'NEW');
    tracker.register({chatId:'chat-A',nonce,groups:[{tag:'3_vecthare',text:newText,recordIds:['z']}]});
    assert.equal(tracker.observe('text',{prompt:receiptGroups[0].text}).status,'notIncluded');
});
test('C10 no host event retains registered-only status',()=>{
    const {tracker,register}=fixture();register();assert.equal(tracker.current().status,'registered');
});
test('C10 rejects malformed registration without a receipt',()=>{
    const {tracker}=fixture();assert.equal(tracker.register({chatId:'chat-A',groups:[]}).verified,false);
});
