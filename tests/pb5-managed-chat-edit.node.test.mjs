import test from 'node:test';
import assert from 'node:assert/strict';
import {locateSavedChatMessage,commitSavedChatTextEdit} from '../utils/pb5-managed-chat-edit.js';
const source={kind:'chat',avatar:'alice.png',chatFile:'chat'};
const locator={sendDate:'2025-01-01',name:'Alice',isUser:true};
const make=()=>{
 const chat=[{send_date:'2025-01-01',name:'Alice',is_user:true,mes:'old'}];
 let saved=false,planned=false,applied=false,verified=false;
 const context={chat,saveChat:async()=>{saved=true;}};
 const opts={source,locator,previousText:'old',newText:'new',recordId:'eabb4525-29cc-8bbc-af01-22decd92ae77',
 expectedFingerprint:'a'.repeat(64),context,getSource:async()=>source,
 checkBeforeSave:async()=>{},readAfterSave:async()=>({fileFingerprint:'b'.repeat(64),
  row:{savedText:'new',savedTextTruncated:false,physicalState:'VERIFIED',availableActions:['update']}}),
 plan:async()=>{planned=true;return {operationId:'operation'};},
 apply:async()=>{applied=true;return {state:'VERIFIED',operationId:'operation'};},
 verify:async()=>{verified=true;},confirm:async()=>true};
 return {chat,opts,context,get flags(){return {saved,planned,applied,verified};}};
};
test('P-B.5 host source edit persists first then M1 and authoritative readback',async()=>{
 const f=make();const result=await commitSavedChatTextEdit(f.opts);
 assert.equal(result.status,'VERIFIED');assert.equal(f.chat[0].mes,'new');
 assert.deepEqual(f.flags,{saved:true,planned:true,applied:true,verified:true});
});
test('P-B.5 rejects ambiguous, stale, or non-source-bound messages',()=>{
 const f=make();assert.equal(locateSavedChatMessage(f.chat,locator,'old'),f.chat[0]);
 assert.throws(()=>locateSavedChatMessage([...f.chat,{...f.chat[0]}],locator,'old'),/AMBIGUOUS/);
 assert.throws(()=>locateSavedChatMessage(f.chat,locator,'outdated'),/CHANGED/);
 assert.throws(()=>locateSavedChatMessage(f.chat,{...locator,recordId:'foreign'},'old'),/INVALID/);
});
test('P-B.5 pre-save drift never edits host or submits M1',async()=>{
 const f=make();f.opts.checkBeforeSave=async()=>{throw Error('stale');};
 await assert.rejects(()=>commitSavedChatTextEdit(f.opts),/stale/);
 assert.equal(f.chat[0].mes,'old');assert.deepEqual(f.flags,{saved:false,planned:false,applied:false,verified:false});
});
test('P-B.5 cancelled edit leaves source unchanged',async()=>{
 const f=make();f.opts.confirm=async()=>false;
 assert.equal((await commitSavedChatTextEdit(f.opts)).status,'CANCELLED');
 assert.equal(f.chat[0].mes,'old');assert.equal(f.flags.saved,false);
});
test('P-B.5 saved edit with failed M1 is explicitly unfinished, never rolled back',async()=>{
 const f=make();f.opts.plan=async()=>{throw Error('M1_CODE_GATE_REFUSED');};
 await assert.rejects(()=>commitSavedChatTextEdit(f.opts),e=>e.sourceSaved&&/CHAT_SAVED_VECTOR_NOT_VERIFIED/.test(e.message));
 assert.equal(f.chat[0].mes,'new');assert.equal(f.flags.saved,true);assert.equal(f.flags.applied,false);
});
test('P-B.5 uncertain host save outcome never implies rollback',async()=>{
 const f=make();f.context.saveChat=async()=>{throw Error('connection lost');};
 await assert.rejects(()=>commitSavedChatTextEdit(f.opts),e=>e.sourceSaveUncertain&&e.code==='PB5_HOST_SAVE_OUTCOME_UNCERTAIN');
 assert.equal(f.chat[0].mes,'new');assert.equal(f.flags.planned,false);
});
test('P-B.5 rejects lorebook, long, empty, and unchanged text without saving',async()=>{
 for(const extra of [{source:{kind:'lorebook',name:'x'}},{newText:'x'.repeat(8193)},{newText:'  '},{newText:'old'}]){
  const f=make();await assert.rejects(()=>commitSavedChatTextEdit({...f.opts,...extra}),/INVALID/);
  assert.equal(f.flags.saved,false);
 }
});
