/** F09c.3: Qdrant conditional request candidate. Offline transport only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {planMutation} from '../lib/s04-contract.js';
import {collectionIdentity} from '../lib/s02-identity.js';
import {qdrantV2ConditionalCandidateProbe} from '../lib/s06-qdrant.js';
const scope={userScopeId:'alice',collectionId:'chat',type:'chat',sourceId:'saved-one',branchId:'b-1'};
const embedding={source:'transformers',model:'test',dimension:3,metric:'cosine'};
const coll=collectionIdentity({backend:'qdrant',scope,embedding});
const binding={backend:'qdrant',authorized:true,provenance:'SERVER_VERIFIED',scope,embedding,collection:{key:coll.key,physicalName:coll.physicalName}};
const ctx={userScopeId:scope.userScopeId};
const mkPlan=(action,opts={})=>planMutation(ctx,{backend:'qdrant',scope,embedding,recordId:opts.recordId??randomUUID(),operationId:randomUUID(),action,...opts});
const p1={text:'first',vector:[0.2,0.3,0.4],metadata:{tag:'old'}};
const p2={text:'changed',vector:[0.1,0.8,0.2],metadata:{tag:'new'}};
function mock({version='1.17.0',consent=true,fixture=true,hook=null,unknown=false,down=false}={}) {
 const points=new Map(),calls=[];
 const backend={s06DisposableFixture:fixture,f09c3ConditionalProbeConsent:consent,points,calls,async _request(method,url,body){
  calls.push({method,url,body});
  if(method==='GET'&&url==='/')return {version};
  if(method==='GET'&&url.startsWith('/collections/'))return {result:{config:{params:{vectors:{size:3,distance:'Cosine'}}}}};
  if(url.includes('/points/scroll')){
   const selected=[...points.values()].filter(p=>body.filter.must.every(c=>p.payload[c.key]===c.match.value));
   return {result:{points:selected.slice(0,body.limit),next_page_offset:null}};
  }
  if(url.includes('/points?')||url.includes('/points/delete?')){
   if(hook)await hook({points,body,method});
   if(down)throw Error('network timeout after dispatch');
   const conditional=(item)=>!body.update_filter||body.update_filter.must.every(c=>item.payload[c.key]===c.match.value);
   if(method==='PUT')for(const item of body.points){
    const existing=points.get(item.id);
    if(body.update_mode==='insert_only'&&existing)continue;
    if(body.update_mode==='update_only'&&!existing)continue;
    if(existing&&!conditional(existing))continue;
    points.set(item.id,item);
   }
   if(method==='POST')for(const [id,existing] of points){if(body.filter.must.every(c=>existing.payload[c.key]===c.match.value))points.delete(id);}
   // Qdrant returns completion for conditional operations with no point changed.
   return {result:{status:unknown?'acknowledged':'completed',operation_id:42}};
  }
  throw Error(`Unexpected ${method} ${url}`);
 }};
 return backend;
}
const store=(backend,p,payload)=>{backend.points.set(p.physicalId,{id:p.physicalId,vector:payload.vector,payload:{
  ...scope,recordId:p.recordId,physicalId:p.physicalId,branchId:scope.branchId,revision:p.targetRevision,
  text:payload.text,textHash:p.textHash,vectorReference:payload.vector,vectorHash:p.vectorHash,
  metadata:payload.metadata,metadataHash:p.metadataHash,embedding}});};
test('candidate refuses all non-disposable/non-consented transports before network I/O',async()=>{
 const p=mkPlan('insert',p1);
 for(const transport of [mock({fixture:false}),mock({consent:false})]){
  await assert.rejects(()=>qdrantV2ConditionalCandidateProbe(transport,binding,p,p1),{code:'F09C3_DISPOSABLE_PROBE_ONLY'});
  assert.equal(transport.calls.length,0);
 }
});
test('candidate rejects pre-1.17, unknown and malformed server versions before writes',async()=>{
 for(const version of ['1.16.9','0.99.0','garbage','']){
  const transport=mock({version});
  await assert.rejects(()=>qdrantV2ConditionalCandidateProbe(transport,binding,mkPlan('insert',p1),p1),{code:'F09C3_QDRANT_VERSION_UNSUPPORTED'});
  assert.equal(transport.calls.filter(c=>c.method==='PUT').length,0);
 }
});
test('candidate insert uses insert_only and returns no applied proof even when readback matches',async()=>{
 const backend=mock(),p=mkPlan('insert',p1);
 const result=await qdrantV2ConditionalCandidateProbe(backend,binding,p,p1);
 assert.equal(result.applied,false);assert.equal(result.postconditionObserved,true);
 const call=backend.calls.find(c=>c.method==='PUT');
 assert.equal(call.body.update_mode,'insert_only');assert.equal(call.body.update_filter,undefined);
 assert.match(call.url,/ordering=strong/);
});
test('insert race against independent writer cannot overwrite existing physical id',async()=>{
 const p=mkPlan('insert',p1),backend=mock({hook:({points})=>store({points},p,p1)});
 const result=await qdrantV2ConditionalCandidateProbe(backend,binding,p,p1);
 assert.equal(result.applied,false);
 assert.equal(backend.points.get(p.physicalId).payload.revision,p.targetRevision);
});
test('stale conditional update does not overwrite independent revision',async()=>{
 const initial=mkPlan('insert',p1),update=mkPlan('update',{recordId:initial.recordId,expectedRevision:1,...p2});
 const backend=mock({hook:({points})=>{
  const prev=points.get(initial.physicalId);
  points.set(initial.physicalId,{...prev,payload:{...prev.payload,revision:2,text:'external-writer'}});
 }});
 store(backend,initial,p1);
 const result=await qdrantV2ConditionalCandidateProbe(backend,binding,update,p2);
 assert.equal(result.postconditionObserved,false);
 assert.equal(backend.points.get(initial.physicalId).payload.text,'external-writer');
 const call=backend.calls.find(c=>c.method==='PUT');
 assert.equal(call.body.update_mode,'update_only');
 assert.deepEqual(call.body.update_filter.must.map(x=>x.key),['userScopeId','collectionId','type','sourceId','branchId','recordId','physicalId','revision']);
});
test('metadata update preserves original text/vector and changes only the bound metadata',async()=>{
 const initial=mkPlan('insert',p1),metadata={tag:'updated'},p=mkPlan('metadata',{recordId:initial.recordId,expectedRevision:1,metadata});
 const backend=mock();store(backend,initial,p1);
 const result=await qdrantV2ConditionalCandidateProbe(backend,binding,p,{metadata});
 assert.equal(result.postconditionObserved,true);assert.equal(result.applied,false);
 const call=backend.calls.find(c=>c.method==='PUT');
 assert.deepEqual(call.body.points[0].vector,p1.vector);
 assert.equal(call.body.points[0].payload.text,'first');
 assert.deepEqual(call.body.points[0].payload.metadata,metadata);
});
test('stale conditional delete cannot erase independently advanced revision',async()=>{
 const initial=mkPlan('insert',p1),p=mkPlan('delete',{recordId:initial.recordId,expectedRevision:1});
 const backend=mock({hook:({points})=>{
  const prev=points.get(initial.physicalId);
  points.set(initial.physicalId,{...prev,payload:{...prev.payload,revision:2}});
 }});store(backend,initial,p1);
 const result=await qdrantV2ConditionalCandidateProbe(backend,binding,p);
 assert.equal(result.postconditionObserved,false);assert.equal(result.applied,false);
 const call=backend.calls.find(c=>c.method==='POST'&&c.url.includes('/delete?'));
 assert.equal(call.body.filter.must.at(-1).match.value,1);
 assert.equal(call.body.filter.must.at(-2).match.value,p.physicalId);
 assert.ok(backend.points.has(p.physicalId));
});
test('completed no-op due to another writer is never recognized as confirmed conditional apply',async()=>{
 const initial=mkPlan('insert',p1),p=mkPlan('update',{recordId:initial.recordId,expectedRevision:1,...p2});
 const backend=mock({hook:({points})=>{
  const row=points.get(initial.physicalId);
  points.set(initial.physicalId,{...row,payload:{...row.payload,revision:2}});
 }});store(backend,initial,p1);
 const result=await qdrantV2ConditionalCandidateProbe(backend,binding,p,p2);
 assert.equal(result.completionStatus,'completed');assert.equal(result.applied,false);
});
test('acknowledged-but-not-completed never allows verified mutation',async()=>{
 const backend=mock({unknown:true}),p=mkPlan('insert',p1);
 const result=await qdrantV2ConditionalCandidateProbe(backend,binding,p,p1);
 assert.equal(result.completionStatus,'acknowledged');assert.equal(result.applied,false);
});
test('transport failure after dispatch is uncertain and never retried',async()=>{
 const backend=mock({down:true}),p=mkPlan('insert',p1);
 await assert.rejects(()=>qdrantV2ConditionalCandidateProbe(backend,binding,p,p1),{code:'F09C3_DISPATCH_OUTCOME_UNCERTAIN'});
 assert.equal(backend.calls.filter(c=>c.method==='PUT').length,1);
});
test('wrong binding cannot access another collection or owner',async()=>{
 const backend=mock(),p=mkPlan('insert',p1),bad={...binding,scope:{...scope,userScopeId:'bob'}};
 await assert.rejects(()=>qdrantV2ConditionalCandidateProbe(backend,bad,p,p1));
 assert.equal(backend.calls.length,0);
});
test('conditional candidate is not exposed as a production atomicCompareAndMutate adapter method',async()=>{
 const {qdrantV2Adapter}=await import('../lib/s06-qdrant.js');
 const backend=mock();
 const adapter=qdrantV2Adapter(backend,binding);
 assert.equal(typeof adapter.atomicCompareAndMutate,'undefined');
 assert.equal(typeof adapter.insertRecord,'function');
});
test('negative control: an external writer bypassing revision rules still overwrites point',async()=>{
 const p=mkPlan('insert',p1),backend=mock();
 const candidate=await qdrantV2ConditionalCandidateProbe(backend,binding,p,p1);
 assert.equal(candidate.applied,false);
 const external={id:p.physicalId,vector:[0.6,0.6,0.6],payload:{...backend.points.get(p.physicalId).payload,revision:100,text:'external bypass'}};
 // A raw, unconditioned upsert can overwrite the same point: deployment
 // attestation must exclude unaudited writers before production CAS claims.
 await backend._request('PUT',`/collections/${coll.physicalName}/points?wait=true`,{points:[external]});
 assert.equal(backend.points.get(p.physicalId).payload.text,'external bypass');
});
