import test from 'node:test';
import assert from 'node:assert/strict';
import {locateSavedLorebookEntry,commitSavedLorebookTextEdit} from '../utils/pb7-managed-lorebook-edit.js';
import {validateSavedBrowserPage} from '../utils/pb1-saved-browser.js';
const id='eabb4525-29cc-8bbc-af01-22decd92ae77';
const source={kind:'lorebook',name:'Lore 1'};
const original=()=>({entries:{'34':{uid:34,content:'old',key:['x'],comment:'keep'},'4':{uid:4,content:'other',key:['y']}}});
const fixture=()=>{
 let book=original(),saved=0,planned=0,applied=0,verified=0;
 const opts={source,uid:34,recordId:id,previousText:'old',newText:'new',expectedFingerprint:'a'.repeat(64),
  loadWorldInfo:async()=>structuredClone(book),
  saveWorldInfo:async(name,data,immediate)=>{assert.equal(name,'Lore 1');assert.equal(immediate,true);book=data;saved++;},
  getSource:async()=>source,checkBeforeSave:async()=>{},
  readAfterSave:async()=>({fileFingerprint:'b'.repeat(64),row:{lorebookUid:34,
   savedText:'new',savedTextTruncated:false,physicalState:'VERIFIED',availableActions:['update']}}),
  plan:async hash=>{assert.equal(hash,'b'.repeat(64));planned++;return {operationId:'ticket'};},
  apply:async()=>{applied++;return {state:'VERIFIED',operationId:'ticket'};},
  verify:async()=>{verified++;},confirm:async()=>true};
 return {opts,get book(){return book;},get flags(){return {saved,planned,applied,verified};}};
};
test('P-B.7 persists correct saved lorebook UID before any M1 write, preserves other entry metadata',async()=>{
 const f=fixture();assert.equal((await commitSavedLorebookTextEdit(f.opts)).status,'VERIFIED');
 assert.deepEqual(f.flags,{saved:1,planned:1,applied:1,verified:1});
 assert.equal(f.book.entries['34'].content,'new');assert.equal(f.book.entries['34'].comment,'keep');
 assert.equal(f.book.entries['4'].content,'other');
});
test('P-B.7 refuses stale, disabled, duplicate and missing entries',async()=>{
 assert.equal(locateSavedLorebookEntry(original(),34,'old').uid,34);
 for(const [world,uid,text] of [
  [original(),34,'stale'],[original(),99,'old'],
  [{entries:{'1':{uid:34,content:'old'},'2':{uid:34,content:'old'}}},34,'old'],
  [{entries:{'1':{uid:34,content:'old',disable:true}}},34,'old']
 ])assert.throws(()=>locateSavedLorebookEntry(world,uid,text),/PB7_/);
});
test('P-B.7 cancelled, changed and invalid edits never write the source or vector',async()=>{
 const f=fixture();f.opts.confirm=async()=>false;
 assert.equal((await commitSavedLorebookTextEdit(f.opts)).status,'CANCELLED');
 assert.equal(f.flags.saved,0);
 const changed=fixture();changed.opts.loadWorldInfo=async()=>({entries:{'1':{uid:34,content:'updated elsewhere'}}});
 await assert.rejects(()=>commitSavedLorebookTextEdit(changed.opts),/PB7_LORE_CONTENT_CHANGED/);
 assert.equal(changed.flags.saved,0);
 for(const extra of [{newText:'old'},{newText:''},{newText:'x'.repeat(8193)},{uid:-1}]){
  const x=fixture();await assert.rejects(()=>commitSavedLorebookTextEdit({...x.opts,...extra}),/PB7_LORE_EDIT_INVALID/);
  assert.equal(x.flags.saved,0);
 }
});
test('P-B.7 failed M1 update never pretends to roll back saved lorebook',async()=>{
 const f=fixture();f.opts.plan=async()=>{throw Error('disabled');};
 await assert.rejects(()=>commitSavedLorebookTextEdit(f.opts),err=>err.sourceSaved&&/PB7_LORE_SAVED_VECTOR_NOT_VERIFIED/.test(err.message));
 assert.equal(f.book.entries['34'].content,'new');assert.equal(f.flags.saved,1);assert.equal(f.flags.applied,0);
});
test('P-B.7 uncertain save halts before any M1 plan/replay',async()=>{
 const f=fixture();f.opts.saveWorldInfo=async()=>{throw Error('write then disconnect');};
 await assert.rejects(()=>commitSavedLorebookTextEdit(f.opts),err=>err.sourceSaveUncertain&&err.code==='PB7_LORE_SAVE_OUTCOME_UNCERTAIN');
 assert.equal(f.flags.planned,0);
});
test('P-B.7 server post-save must independently match UID and exact saved bytes',async()=>{
 for(const row of [{lorebookUid:35,savedText:'new'},{lorebookUid:34,savedText:'not new'}]){
  const f=fixture();f.opts.readAfterSave=async()=>({fileFingerprint:'b'.repeat(64),row:{...row,physicalState:'VERIFIED',availableActions:['update']}});
  await assert.rejects(()=>commitSavedLorebookTextEdit(f.opts),err=>err.sourceSaved&&/PB7_LORE_SAVED_VECTOR_NOT_VERIFIED/.test(err.message));
  assert.equal(f.flags.planned,0);
 }
});
test('P-B.7 browser accepts only nonnegative integer server UID',()=>{
 const good={success:true,readOnly:true,sourceAuthoritative:true,inventoryKind:'SAVED_SOURCE_RECORDS',inventoryVerified:false,
  physicalInventoryComplete:false,completeSavedSource:true,logicalKey:'a'.repeat(64),fileFingerprint:'b'.repeat(64),
  registryFingerprint:'c'.repeat(64),routingGeneration:0,sourceSelectionGeneration:0,totalRecords:1,offset:0,
  nextCursor:null,pageComplete:true,records:[{recordId:id,physicalState:'VERIFIED',savedText:'old',
   savedTextTruncated:false,lorebookUid:34,availableActions:['update']}]};
 assert.equal(validateSavedBrowserPage(good).records[0].lorebookUid,34);
 for(const uid of [-1,'34',3.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>validateSavedBrowserPage({...good,records:[{...good.records[0],lorebookUid:uid}]}),/PB1_BROWSER/);
});
