/** Real branch provenance logic with an isolated SillyTavern context. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const file=new URL('../core/chat-identity-ledger.js',import.meta.url);
const source=fs.readFileSync(file,'utf8').replace(/^import .*?;\s*$/gm,'').replace(/^export /gm,'');
const state={file:'main.jsonl',characterId:7,uuid:'main-uuid',settings:{vecthare:{}},saves:0};
const ctx=vm.createContext({console,Date,Error,String,
 extension_settings:state.settings,
 chat_metadata:{get integrity(){return state.uuid;}},
 getCurrentChatId:()=>state.file,
 getContext:()=>({characterId:state.characterId}),
 saveVectHareSettingsDebounced:()=>{state.saves++;},
});
vm.runInContext(source,ctx,{filename:'chat-identity-ledger.js'});
let passed=0;
function test(name,fn){fn();passed++;console.log('PASS',name);}
test('first visit records UUID, character and filename but creates no collection',()=>{
 const result=ctx.recordCurrentChatIdentity();assert.equal(result.verified,true);
 assert.equal(Object.keys(state.settings.vecthare.chatIdentityLedger).length,1);
 assert.equal(state.settings.vecthare.vecthare_collection_registry,undefined);
});
test('identically named chats with independent integrity IDs do not collide',()=>{
 state.uuid='other-uuid';state.file='main.jsonl';state.characterId=7;
 assert.equal(ctx.recordCurrentChatIdentity().verified,true);
 assert.equal(Object.keys(state.settings.vecthare.chatIdentityLedger).length,2);
});
test('new release branches with unique IDs remain separate without empty collections',()=>{
 for(let i=0;i<125;i++){
    state.uuid=`branch-${i}`;state.file=`main-branch-${i}.jsonl`;
    assert.equal(ctx.recordCurrentChatIdentity().verified,true);
 }
 assert.equal(Object.keys(state.settings.vecthare.chatIdentityLedger).length,127);
 assert.equal(state.settings.vecthare.vecthare_collection_registry,undefined);
});
test('legacy copied UUID across branch files is detected, never rebound',()=>{
 state.uuid='main-uuid';state.file='copied-branch.jsonl';state.characterId=7;
 assert.equal(ctx.recordCurrentChatIdentity().verified,false);
 assert.throws(()=>ctx.assertCurrentChatIdentity(),/collision/);
 assert.equal(state.settings.vecthare.chatIdentityLedger['main-uuid'].file,'main.jsonl');
});
test('copied UUID and filename on a different character also fails',()=>{
 state.uuid='main-uuid';state.file='main.jsonl';state.characterId=8;
 assert.equal(ctx.recordCurrentChatIdentity().verified,false);
});
test('verified rename changes only matching original file, not branch identity',()=>{
 state.uuid='main-uuid';state.file='renamed.jsonl';state.characterId=7;
 assert.equal(ctx.recordVerifiedChatRename('main-uuid','wrong.jsonl','renamed.jsonl'),false);
 assert.equal(ctx.recordVerifiedChatRename('main-uuid','main.jsonl','renamed.jsonl'),true);
 assert.equal(ctx.recordCurrentChatIdentity().verified,true);
 assert.equal(state.settings.vecthare.chatIdentityLedger['main-uuid'].file,'renamed.jsonl');
});
console.log(`\n${passed} branch identity and lazy-storage tests passed`);
