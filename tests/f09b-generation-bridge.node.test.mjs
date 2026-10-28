import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const code=fs.readFileSync(new URL('../core/chat-vectorization.js',import.meta.url),'utf8');
const start=code.indexOf('export async function rearrangeChat(');
const end=code.indexOf('/**\n * Vectorizes entire chat',start);
assert.ok(start>0&&end>start);
const extracted=code.slice(start,end).replace('export async function','async function');
function runtime({enabled,fail=false}={}){
 const registered=[],queries=[],debug=[],calls=[];
 const chat=[{mes:'some user message',is_user:true}];
 const scope={
  console:{log(){},debug(){},warn(...args){calls.push(['warn',...args]);},error(...args){calls.push(['error',...args]);},info(){}},
  StaleJobError:class StaleJobError extends Error{},
  chatJobs:{startJob:()=>({assertCurrent(){},finish(){calls.push('finished');}})},
  getCurrentChatId:()=> 'chat-file',
  clearVectHarePrompts:()=>{calls.push('clear');},extension_prompts:{},
  buildSearchQuery:()=> 'query text',
  getContext:()=> ({maxContext:4096}),getRequestHeaders:()=>({}),
  getAdditionalArgs:async()=>({embeddings:{'query text':[1,0,0]}}),
  injectF09bV2:async args=>{queries.push(args.queryText);if(fail)throw Error('F09B_REFUSED');
    return {status:'REGISTERED_UNWITNESSED',nonce:'0123456789abcdef0123456789abcdef',block:'v2 text',recordIds:['x'],candidateCount:1};},
  promptReceipts:{invalidate(){calls.push('invalidate');},register:r=>{registered.push(r);return {status:'registered'};}},
  chatIdForActivation:()=> 'chat-id',
  setExtensionPrompt:(...args)=>calls.push(['set',...args]),
  F09B_PROMPT_TAG:'vecthare_f09b_verified_v2',
  createDebugData:()=>({}),setLastSearchDebug:x=>debug.push(x),
 };
 vm.createContext(scope);vm.runInContext(extracted,scope);
 return {scope,chat,queries,registered,debug,calls,settings:{f09b_v2_prompt_enabled:enabled,source:'webllm',position:0,depth:2}};
}
test('F09b is called in normal generation and uses receipt tracking instead of legacy retrieval',async()=>{
 const r=runtime({enabled:true});
 await r.scope.rearrangeChat(r.chat,r.settings,'normal');
 assert.deepEqual(r.queries,['query text'],JSON.stringify(r.calls));
 assert.equal(r.registered.length,1);assert.equal(r.registered[0].groups[0].text,'v2 text');
 assert.equal(r.debug[0].f09b.status,'REGISTERED_UNWITNESSED');
 assert.ok(r.calls.includes('finished'));
});
test('F09b failures do not try legacy retrieval and do not retain a prompt receipt',async()=>{
 const r=runtime({enabled:true,fail:true});
 await r.scope.rearrangeChat(r.chat,r.settings,'normal');
 assert.deepEqual(r.queries,['query text'],JSON.stringify(r.calls));
 assert.equal(r.registered.length,0);
 assert.equal(r.debug[0].stopReason,'f09b_v2_fail_closed');
 assert.ok(r.calls.includes('invalidate'));
 assert.ok(r.calls.includes('finished'));
});
