import test from 'node:test';
import assert from 'node:assert/strict';
import {contentFingerprint} from '../lib/s02-identity.js';
import {parseLorebookSnapshot,derivedUuid} from '../lib/f09b6-saved-content.js';
import {previewM1Records} from '../lib/m1-saved-records.js';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const profile={source:'transformers',model:'fixture',dimension:3,metric:'cosine'};
const source={kind:'lorebook',name:'Lore 1'};
const uid=34;
const original=Buffer.from(JSON.stringify({entries:{one:{uid,content:'old',key:['a']},two:{uid:4,content:'other'}}}));
test('P-B.7 saved lorebook parsing uses stable UID independent of entry object key or order',()=>{
 const first=parseLorebookSnapshot(original,'saved-lorebook');
 const second=parseLorebookSnapshot(Buffer.from(JSON.stringify({entries:{moved:{uid:4,content:'other'},renamed:{uid,content:'old',key:['a']}}})),'saved-lorebook');
 assert.deepEqual(first.map(x=>x.recordId).sort(),second.map(x=>x.recordId).sort());
 assert.equal(first.find(x=>x.sourceKey==='34').text,'old');
 assert.equal(first.find(x=>x.sourceKey==='34').recordId,derivedUuid('saved-lorebook','lorebook-entry','34'));
});
test('P-B.7 M1 large-lorebook parsing does not relax legacy F09b 80-entry bound',()=>{
 const large=Buffer.from(JSON.stringify({entries:Object.fromEntries(Array.from({length:250},(_,i)=>[String(i),{uid:i,content:'text'+i}]))}));
 assert.throws(()=>parseLorebookSnapshot(large,'owned'),/F09B6_LOREBOOK_FORMAT_UNSUPPORTED/);
 assert.equal(parseLorebookSnapshot(large,'owned',{maxEntries:10000}).length,250);
 assert.throws(()=>parseLorebookSnapshot(large,'owned',{maxEntries:Infinity}),/F09B6_LOREBOOK_MAX_ENTRIES_INVALID/);
});
test('P-B.7 server browse exposes UID exclusively from saved file snapshot, without taking UID as selector',async()=>{
 const msg={recordId:derivedUuid('saved-lorebook','lorebook-entry','34'),text:'old',contentHash:contentFingerprint('old'),
  lorebook:{uid:'34',enabled:true,triggers:['a'],conditions:[]}};
 const state={messages:[msg],fileHash:'a'.repeat(64),sourceId:'saved-lorebook',sourceKind:'lorebook'};
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pb7-test-'));await fs.chmod(dir,0o700);
 const req={s03:{userScopeId:'alice',vectorsPath:dir},user:{directories:{}},body:{backend:'qdrant',source,verifyPhysical:true}};
 const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',scope:{userScopeId:'alice',
  sourceId:'saved-lorebook',branchId:'',type:'lorebook',collectionId:'Lore 1'},embedding:profile,
  collection:{key:'b'.repeat(64),generation:1,physicalName:'test'}};
 const deps={getProfile:async()=>({configured:true,profile,connectionState:'VERIFIED'}),
  bind:async()=>({binding}),readSnapshot:async()=>structuredClone(state),
  getReceipt:async()=>({state:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED'}),
  registry:()=>({read:async()=>({fingerprint:'c'.repeat(64),records:{}})}),
  readRecord:async()=>null};
 try{
  const page=await previewM1Records(req,deps,{browse:true});
  assert.equal(page.records[0].lorebookUid,34);
  assert.equal(page.records[0].savedText,'old');
  assert.equal(page.records[0].physicalState,'MISSING');
  assert.equal(page.sourceKind,'lorebook');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('P-B.7 managed lorebook update embeds changed SERVER snapshot through M1, not a browser text payload',async()=>{
 const {collectionIdentity,recordIdentity}=await import('../lib/s02-identity.js');
 const {savedRecordIdentity,planM1Record,executeM1Record}=await import('../lib/m1-saved-records.js');
 const {ManagedChatRegistry}=await import('../lib/f09b4-managed-registry.js');
 const scope={userScopeId:'alice',sourceId:'saved-lorebook',type:'lore',collectionId:'Lore 1'};
 const ident=collectionIdentity({backend:'qdrant',scope,embedding:profile});
 const binding={authorized:true,provenance:'SERVER_VERIFIED',backend:'qdrant',scope,embedding:profile,
  collection:{key:ident.key,physicalName:ident.physicalName}};
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pb7-mutation-'));await fs.chmod(dir,0o700);
 const req={s03:{userScopeId:'alice',vectorsPath:dir},user:{directories:{}},body:null};
 const msg={recordId:derivedUuid(scope.sourceId,'lorebook-entry','34'),text:'old',contentHash:contentFingerprint('old'),
  lorebook:{uid:'34',enabled:true,triggers:['a'],conditions:[]}};
 const state={sourceId:scope.sourceId,fileHash:hash('saved-old'),sourceKind:'lorebook',messages:[msg]};
 const rows=new Map(),calls=[];
 const deps={getProfile:async()=>({configured:true,connectionState:'VERIFIED',profile}),
  bind:async()=>({binding}),readSnapshot:async()=>structuredClone(state),
  getReceipt:async()=>({state:'SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED'}),
  registry:(ctx,b)=>new ManagedChatRegistry(ctx,b),
  certify:async()=>true,transport:async()=>({}),verifySchema:async()=>true,
  embed:async (_req,_profile,text)=>{calls.push(['embed',text]);return [0.1,0.2,0.3];},
  readRecord:async (_req,_binding,id)=>structuredClone(rows.get(id)??null),
  adapter:()=>({getRecord:async id=>structuredClone(rows.get(typeof id==='string'?id:id.recordId)??null)}),
  engine:()=>({execute:async(plan,payload)=>{
   calls.push([plan.action,payload.text]);
   rows.set(plan.recordId,{recordId:plan.recordId,physicalId:recordIdentity(scope,plan.recordId).physicalId,
    scope,revision:plan.targetRevision,text:payload.text,metadata:payload.metadata,vector:payload.vector});
   return {state:'VERIFIED'};
  }})};
 const recordId=savedRecordIdentity(req.s03,binding,msg).recordId;
 const mutate=async(action)=>{
  req.body={backend:'qdrant',source,recordId,action,expectedFileFingerprint:state.fileHash};
  const ticket=await planM1Record(req,ident.key,deps);
  req.body={operationId:ticket.operationId,confirmation:'APPLY SAVED RECORD MUTATION'};
  const result=await executeM1Record(req,deps);
  assert.equal(result.state,'VERIFIED');
 };
 try{
  await mutate('insert');
  state.messages[0].text='new from disk';
  state.messages[0].contentHash=contentFingerprint('new from disk');
  state.fileHash=hash('saved-new');
  await mutate('update');
  assert.equal(rows.get(recordId).text,'new from disk');
  assert.equal(rows.get(recordId).revision,2);
  assert.equal(rows.get(recordId).metadata.vecthareRecordV2.lorebook.uid,'34');
  assert.equal((await new ManagedChatRegistry(req.s03,binding).read()).records[recordId].state,'ACTIVE');
  assert.deepEqual(calls.filter(x=>x[0]==='update'),[['update','new from disk']]);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
