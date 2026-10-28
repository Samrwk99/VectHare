import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {planMutation} from '../lib/s04-contract.js';
import {collectionIdentity} from '../lib/s02-identity.js';
import {qdrantV2Adapter,qdrantV2OwnerFilter,inspectQdrantV2Collection} from '../lib/s06-qdrant.js';
const scope={userScopeId:'alice',collectionId:'my-chat',type:'chat',sourceId:'chat-17',branchId:'branch-1'};
const embedding={source:'transformers',model:'test-model',dimension:3,metric:'cosine'};
const c=collectionIdentity({backend:'qdrant',scope,embedding});
const binding={backend:'qdrant',authorized:true,provenance:'SERVER_VERIFIED',scope,embedding,collection:{key:c.key,physicalName:c.physicalName}};
const ctx={userScopeId:scope.userScopeId};
const mkPlan=(input)=>planMutation(ctx,{backend:'qdrant',scope,embedding,operationId:randomUUID(),...input});
function mockBackend({disposable=true,schema=3,metric='Cosine',fail=null,uncertain=false}={}){
 const points=new Map(),calls=[];
 const transport={s06DisposableFixture:disposable,points,calls,async _request(method,path,body){
  calls.push({method,path,body});
  if(fail?.(method,path,body)) throw Object.assign(new Error('injected qdrant outage'),{httpStatus:503});
  if(method==='GET'&&path.startsWith('/collections/')) return {result:{config:{params:{vectors:{size:schema,distance:metric}}},status:'green'}};
  if(path.endsWith('/points/scroll')){
   const matches=[...points.values()].filter(p=>{
    const must=body.filter.must;
    return must.every(x=>p.payload[x.key]===x.match.value);
   });
   const selected=matches.slice(0,body.limit);
   return {result:{points:selected.map(p=>({...p,vector:body.with_vector===true?p.vector:undefined})),next_page_offset:null}};
  }
  if(path.endsWith('/points/search'))return{result:[...points.values()].filter(p=>body.filter.must.every(x=>p.payload[x.key]===x.match.value)).slice(0,body.limit).map(p=>({...p,score:0.8}))};
  if(method==='PUT'&&path.includes('/points?wait=true')){
   for(const point of body.points)points.set(point.id,{...point});
   return {result:{status:uncertain?'acknowledged':'completed',operation_id:12}};
  }
  if(method==='POST'&&path.includes('/points/delete?wait=true')){
   for(const [key,p] of points)if(body.filter.must.every(x=>p.payload[x.key]===x.match.value))points.delete(key);
   return {result:{status:uncertain?'acknowledged':'completed',operation_id:13}};
  }
  throw new Error('unexpected mock call '+method+' '+path);
 }};
 return transport;
}
const payload={text:'hello qdrant',vector:[0.1,0.2,0.3],metadata:{tag:'example'}};
const planForInsert=()=>mkPlan({action:'insert',...payload});
test('S06 Qdrant scope filters include every owner component, record id, revision and stable point id',()=>{
 const f=qdrantV2OwnerFilter(binding,{recordId:randomUUID(),revision:2,physicalId:randomUUID()});
 assert.deepEqual(f.must.map(x=>x.key),['userScopeId','collectionId','type','sourceId','branchId','recordId','physicalId','revision']);
 assert.equal(f.must[4].match.value,'branch-1');
 const s={...scope};delete s.branchId;
 const c=collectionIdentity({backend:'qdrant',scope:s,embedding});
 const b={...binding,scope:s,collection:{key:c.key,physicalName:c.physicalName}};
 assert.equal(qdrantV2OwnerFilter(b).must[4].match.value,'');
});
test('S06 Qdrant schema inspection is read-only and rejects mismatch without mutation',async()=>{
 const bad=mockBackend({schema:4});
 await assert.rejects(()=>inspectQdrantV2Collection(bad,binding),{code:'S06_SCHEMA_MISMATCH'});
 assert.deepEqual(bad.calls.map(x=>x.method),['GET']);
 const named={_request:async()=>({result:{config:{params:{vectors:{body:{size:3,distance:'Cosine'}}}}}})};
 await assert.rejects(()=>inspectQdrantV2Collection(named,binding),{code:'S06_SCHEMA_MISMATCH'});
 const good=await inspectQdrantV2Collection(mockBackend(),binding);
 assert.equal(good.ownerIndexAttested,false);
});
test('S06 public-production mutation mode is not enabled: reject before any write',async()=>{
 const backend=mockBackend({disposable:false});const p=planForInsert();
 await assert.rejects(()=>qdrantV2Adapter(backend,binding).insertRecord(p,payload),{code:'S06_WRITE_NOT_ACTIVATED'});
 assert.equal(backend.calls.length,0);
});
test('S06 disposable insert -> authoritative readback -> edit -> metadata update -> scoped delete',async()=>{
 const backend=mockBackend(),adapter=qdrantV2Adapter(backend,binding),p=planForInsert();
 const inserted=await adapter.insertRecord(p,payload);assert.equal(inserted.status,'VERIFIED');
 const first=await adapter.getRecord(p);assert.equal(first.physicalId,p.physicalId);assert.equal(first.revision,1);
 const newContent={text:'changed memory',vector:[0.2,0.3,0.4],metadata:{tag:'after'}};
 const update=mkPlan({action:'update',recordId:p.recordId,expectedRevision:1,...newContent});
 assert.equal((await adapter.updateRecord(update,newContent)).status,'VERIFIED');
 assert.equal((await adapter.getRecord(p.recordId)).revision,2);
 const metaplan=mkPlan({action:'metadata',recordId:p.recordId,expectedRevision:2,metadata:{tag:'meta'}});
 assert.equal((await adapter.updateRecord(metaplan,{metadata:{tag:'meta'}})).status,'VERIFIED');
 assert.equal((await adapter.getRecord(p.recordId)).revision,3);
 assert.equal((await adapter.getRecord(p.recordId)).text,'changed memory');
 const del=mkPlan({action:'delete',recordId:p.recordId,expectedRevision:3});
 assert.equal((await adapter.deleteRecord(del)).status,'VERIFIED');
 assert.equal(await adapter.getRecord(p.recordId),null);
 assert.equal(backend.points.size,0);
 const d=backend.calls.find(x=>x.path.includes('/points/delete?'));
 assert.deepEqual(d.body.filter.must.map(x=>x.key),['userScopeId','collectionId','type','sourceId','branchId','recordId','physicalId','revision']);
});
test('S06 physical isolation: same text in distinct branches yields unique point ID and no cross-access',async()=>{
 const a=planForInsert(),otherScope={...scope,branchId:'branch-2'},otherBinding=(()=>{const c=collectionIdentity({backend:'qdrant',scope:otherScope,embedding});return {...binding,scope:otherScope,collection:{key:c.key,physicalName:c.physicalName}}})();
 const other=planMutation(ctx,{backend:'qdrant',scope:otherScope,embedding,action:'insert',operationId:randomUUID(),...payload});
 assert.notEqual(a.physicalId,other.physicalId);
 const bk=mockBackend();await qdrantV2Adapter(bk,binding).insertRecord(a,payload);
 assert.equal(await qdrantV2Adapter(bk,otherBinding).getRecord(other.recordId),null);
});
test('S06 reject forged plan, changed vector and stale update before write',async()=>{
 const backend=mockBackend(),adapter=qdrantV2Adapter(backend,binding),p=planForInsert();
 await assert.rejects(()=>adapter.insertRecord({...p,physicalId:randomUUID()},payload),{code:'S06_RECORD_ID_INVALID'});
 await assert.rejects(()=>adapter.insertRecord(p,{...payload,vector:[5,4,3]}),{code:'S06_VECTOR_MISMATCH'});
 assert.equal(backend.calls.filter(x=>x.method==='PUT').length,0);
 await adapter.insertRecord(p,payload);
 const bad=mkPlan({action:'metadata',recordId:p.recordId,expectedRevision:10,metadata:{x:2}});
 await assert.rejects(()=>adapter.updateRecord(bad,{metadata:{x:2}}),{code:'S06_REVISION_CONFLICT'});
 assert.equal((await adapter.getRecord(p.recordId)).revision,1);
});
test('S06 backend write failure and partial acknowledgement never become verified',async()=>{
 const fail=mockBackend({fail:(m)=>m==='PUT'});
 await assert.rejects(()=>qdrantV2Adapter(fail,binding).insertRecord(planForInsert(),payload),/injected qdrant outage/);
 const ack=mockBackend({uncertain:true});
 await assert.rejects(()=>qdrantV2Adapter(ack,binding).insertRecord(planForInsert(),payload),{code:'S06_MUTATION_UNCERTAIN'});
});
test('S06 read errors and conflicting physical payload IDs are not treated as empty',async()=>{
 const backend=mockBackend(),plan=planForInsert(),adapter=qdrantV2Adapter(backend,binding);
 await adapter.insertRecord(plan,payload);
 const point=backend.points.get(plan.physicalId);point.payload.physicalId=randomUUID();
 await assert.rejects(()=>adapter.getRecord(plan.recordId),{code:'S05_PHYSICAL_ID_MISMATCH'});
 const fail=mockBackend({fail:(m,p)=>p.includes('scroll')});
 await assert.rejects(()=>qdrantV2Adapter(fail,binding).getRecord(plan.recordId),/injected qdrant outage/);
});

test('S06 unbranched records use explicit empty-branch value end-to-end',async()=>{
 const unbranched={...scope};delete unbranched.branchId;
 const col=collectionIdentity({backend:'qdrant',scope:unbranched,embedding});
 const b={...binding,scope:unbranched,collection:{key:col.key,physicalName:col.physicalName}};
 const p=planMutation(ctx,{backend:'qdrant',scope:unbranched,embedding,action:'insert',operationId:randomUUID(),...payload});
 const store=mockBackend(),adapter=qdrantV2Adapter(store,b);
 await adapter.insertRecord(p,payload);
 assert.equal((await adapter.getRecord(p.recordId)).scope.branchId,undefined);
 const record=store.points.get(p.physicalId);assert.equal(record.payload.branchId,'');
});
test('S06 schema mismatch and missing collection fail before insert or deletion',async()=>{
 const b=mockBackend({schema:5});
 await assert.rejects(()=>qdrantV2Adapter(b,binding).insertRecord(planForInsert(),payload),{code:'S06_SCHEMA_MISMATCH'});
 assert.ok(b.calls.every(c=>c.method==='GET'));
 const missing={s06DisposableFixture:true,_request:async()=>{throw Object.assign(new Error('missing'),{httpStatus:404})}};
 await assert.rejects(()=>qdrantV2Adapter(missing,binding).insertRecord(planForInsert(),payload),{code:'S06_COLLECTION_MISSING'});
});
test('S06 production provisioning prohibited without internal disposable fixture',async()=>{
 const {provisionDisposableQdrantV2Collection}=await import('../lib/s06-qdrant.js');
 await assert.rejects(()=>provisionDisposableQdrantV2Collection(mockBackend({disposable:false}),binding),{code:'S06_PROVISION_NOT_AUTHORIZED'});
});
test('S06 provisioning creates a brand-new disposable schema and owner indices, never resets existing',async()=>{
 const {provisionDisposableQdrantV2Collection}=await import('../lib/s06-qdrant.js');
 let exists=false;const calls=[];const fake={s06DisposableFixture:true,async _request(method,path,body){
  calls.push({method,path,body});
  if(method==='GET'&&!exists)throw Object.assign(new Error('missing'),{httpStatus:404});
  if(method==='GET')return{result:{config:{params:{vectors:{size:3,distance:'Cosine'}}}}};
  if(method==='PUT'&&path.endsWith('/index?wait=true'))return{result:{status:'completed',operation_id:6}};
  if(method==='PUT'&&path===`/collections/${binding.collection.physicalName}`){exists=true;return{result:true};}
  throw new Error('unknown request');
 }};
 const result=await provisionDisposableQdrantV2Collection(fake,binding);
 assert.equal(result.ownerIndexesRequested,true);
 assert.equal(calls.filter(x=>x.path.endsWith('/index?wait=true')).length,7);
 const count=calls.length;
 await assert.rejects(()=>provisionDisposableQdrantV2Collection(fake,binding),{code:'S06_COLLECTION_EXISTS'});
 assert.equal(calls.length,count+1);
 assert.equal(calls.filter(x=>x.method==='DELETE').length,0);
});

test('S06 S04 engine integrates with disposable Qdrant adapter and private operation ledger only',async()=>{
 const fs=(await import('node:fs/promises')).default,os=(await import('node:os')).default,path=(await import('node:path')).default;
 const {OperationLedger}=await import('../lib/s04-ledger.js');
 const {MutationEngine}=await import('../lib/s04-engine.js');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'s06-qdrant-engine-'));
 try{
  const context={userScopeId:scope.userScopeId,vectorsPath:dir};
  const backend=mockBackend();const adapter=qdrantV2Adapter(backend,binding);
  const ledger=new OperationLedger(context);
  const authorize=async(plan)=>({authorized:true,ownerVerified:true,mutationContractVerified:true,collectionKey:plan.collectionKey,backend:plan.backend});
  // This simulated authorization callback is deliberately NOT registered in index.js.
  const engine=new MutationEngine({ledger,adapter,authorize});
  const plan=planMutation(context,{backend:'qdrant',scope,embedding,action:'insert',operationId:randomUUID(),...payload});
  const done=await engine.execute(plan,payload);
  assert.equal(done.state,'VERIFIED');
  assert.equal((await ledger.read(plan.operationId)).state,'VERIFIED');
  assert.equal(backend.points.size,1);
  await assert.rejects(()=>engine.execute(plan,payload)); // existing operation ID must never replay
  assert.equal(backend.points.size,1);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
