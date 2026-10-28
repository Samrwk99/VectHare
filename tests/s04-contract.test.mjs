import test from 'node:test';
import assert from 'node:assert/strict';
import {planMutation,verifyMutationReadback} from '../lib/s04-contract.js';
export const ctx={userScopeId:'alice',vectorsPath:'/tmp/alice'};
export const base={backend:'qdrant',scope:{collectionId:'chat123',type:'chat',sourceId:'chat123',branchId:'branchB'},
 embedding:{source:'transformers',model:'some-model',dimension:3,metric:'cosine'},recordId:'47c58ec9-d1cc-43a5-9e1a-5e4c688785f2',
 operationId:'8aa4b7d5-4aa3-4d50-93e7-2b6f234806cb'};
export const sample=(action='insert')=>({...base,action,...(action==='insert'?{text:'hello',vector:[0.1,0.2,0.3],metadata:{tag:'safe'}}:
 action==='update'?{expectedRevision:1,text:'changed',vector:[0.3,0.2,0.1]}:
 action==='metadata'?{expectedRevision:1,metadata:{tag:'new'}}:{expectedRevision:1})});
const err=(fn,code)=>assert.throws(fn,e=>e.code===code);
test('S04 creates scope-qualified deterministic IDs and never persists raw text/vector',()=>{
 const p=planMutation(ctx,sample());const clone=planMutation(ctx,sample());
 assert.equal(p.physicalId,clone.physicalId);assert.equal(p.collectionKey,clone.collectionKey);
 assert.equal(p.authorized,false);assert.equal(p.executionAllowed,false);assert.equal(p.targetRevision,1);
 assert.ok(!JSON.stringify(p).includes('hello'));assert.ok(!JSON.stringify(p).includes('[0.1'));
 const b=planMutation(ctx,{...sample(),scope:{...sample().scope,branchId:'branchC'}});
 assert.notEqual(p.physicalId,b.physicalId);assert.notEqual(p.collectionKey,b.collectionKey);
});
test('S04 enforces exact owner binding, required revision, stable UUIDs',()=>{
 err(()=>planMutation(ctx,{...sample(),scope:{...sample().scope,userScopeId:'bob'}}),'S04_SCOPE_MISMATCH');
 err(()=>planMutation(ctx,{...sample(),userScopeId:'bob'}),'S04_SCOPE_MISMATCH');
 err(()=>planMutation(ctx,{...sample('update'),expectedRevision:undefined}),'S04_REVISION_REQUIRED');
 err(()=>planMutation(ctx,{...sample(),recordId:'123'}),'S02_INVALID_RECORD_ID');
 err(()=>planMutation(ctx,{...sample(),operationId:'evil'}),'S04_OPERATION_ID_INVALID');
 err(()=>planMutation(ctx,{...sample('delete'),text:'something'}),'S04_ACTION_PAYLOAD_INVALID');
});
test('S04 forbids invalid vectors, protected fields, malformed metadata, and partial batches',()=>{
 for (const vector of [[1,2],[1,NaN,3],[1,Infinity,3],['1',2,3],null])
  err(()=>planMutation(ctx,{...sample(),vector}),'S04_VECTOR_INVALID');
 for (const metadata of [{recordId:'spoof'},{revision:2},{userScopeId:'bob'},{__proto2__:1}]) {
  if(Object.keys(metadata).some(k=>['recordId','revision','userScopeId'].includes(k)))err(()=>planMutation(ctx,{...sample(),metadata}),'S04_PROTECTED_METADATA');
 }
 err(()=>planMutation(ctx,{...sample('metadata'),metadata:null}),'S04_METADATA_INVALID');
 err(()=>planMutation(ctx,{...sample(),action:'purge'}),'S04_ACTION_INVALID');
});
test('S04 independent readback verifies physical ID, owner, revision, content, embedding, metadata',()=>{
 const plan=planMutation(ctx,sample());
 const item={recordId:plan.recordId,physicalId:plan.physicalId,scope:plan.scope,revision:1,textHash:plan.textHash,vectorHash:plan.vectorHash,metadataHash:plan.metadataHash};
 assert.equal(verifyMutationReadback(plan,item).verified,true);
 for(const bad of [{...item,revision:0},{...item,scope:{...item.scope,userScopeId:'bob'}},{...item,vectorHash:'bad'},{...item,physicalId:'other'}])
  assert.equal(verifyMutationReadback(plan,bad).verified,false);
 assert.equal(verifyMutationReadback(planMutation(ctx,sample('delete')),null).verified,true);
});
