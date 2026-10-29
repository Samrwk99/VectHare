/** F09c.4 evidence and external-writer negative controls (offline only). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {planMutation} from '../lib/s04-contract.js';
import {collectionIdentity} from '../lib/s02-identity.js';
import {qdrantV2ConditionalCandidateProbe,qdrantV2Adapter} from '../lib/s06-qdrant.js';
import {classifyQdrantConditionalEvidence,assessExclusiveWriterEvidence} from '../lib/f09c4-qdrant-evidence.js';
const scope={userScopeId:'alice',collectionId:'chat',type:'chat',sourceId:'saved-one',branchId:'b-1'};
const embedding={source:'transformers',model:'test',dimension:3,metric:'cosine'};
const coll=collectionIdentity({backend:'qdrant',scope,embedding});
const binding={backend:'qdrant',authorized:true,provenance:'SERVER_VERIFIED',scope,embedding,collection:{key:coll.key,physicalName:coll.physicalName}};
const mkPlan=(action,opts={})=>planMutation({userScopeId:'alice'},{backend:'qdrant',scope,embedding,recordId:opts.recordId??randomUUID(),operationId:randomUUID(),action,...opts});
const original={text:'first',vector:[0.2,0.3,0.4],metadata:{tag:'old'}};
const changed={text:'changed',vector:[0.1,0.8,0.2],metadata:{tag:'new'}};
function pointFrom(plan,payload){return {id:plan.physicalId,vector:payload.vector,payload:{...scope,recordId:plan.recordId,physicalId:plan.physicalId,revision:plan.targetRevision,text:payload.text,textHash:plan.textHash,vectorReference:payload.vector,vectorHash:plan.vectorHash,metadata:payload.metadata,metadataHash:plan.metadataHash,embedding}};}
function transport({preloaded=[],hook=null,ack='completed',readFails=false}={}){
 const points=new Map(preloaded.map(p=>[p.id,p]));const calls=[];
 return {s06DisposableFixture:true,f09c3ConditionalProbeConsent:true,calls,points,
  async _request(method,url,body){
   calls.push({method,url,body});
   if(method==='GET'&&url==='/')return {version:'1.17.1'};
   if(method==='GET')return {result:{config:{params:{vectors:{size:3,distance:'Cosine'}}}}};
   if(url.includes('/points/scroll')){
    if(readFails)throw Error('readback unavailable');
    return {result:{points:[...points.values()].filter(p=>body.filter.must.every(c=>p.payload[c.key]===c.match.value)).slice(0,body.limit),next_page_offset:null}};
   }
   if(url.includes('/points?')||url.includes('/points/delete?')){
    if(hook)await hook(points,body);
    if(method==='PUT')for(const row of body.points){
     const current=points.get(row.id);
     if(body.update_mode==='insert_only'&&current)continue;
     if(body.update_mode==='update_only'&&!current)continue;
     if(current&&body.update_filter&&!body.update_filter.must.every(c=>current.payload[c.key]===c.match.value))continue;
     points.set(row.id,row);
    }
    if(method==='POST')for(const [id,row] of points){if(body.filter.must.every(c=>row.payload[c.key]===c.match.value))points.delete(id);}
    return {result:{status:ack,operation_id:12}};
   }
   throw Error('unhandled request '+method+' '+url);
  }};
}
test('completed status with matching poststate never proves a conditional match',()=>{
 const r=classifyQdrantConditionalEvidence({completionStatus:'completed',postconditionObserved:true,operationId:randomUUID()});
 assert.equal(r.classification,'COMPLETED_POSTSTATE_MATCH_UNATTRIBUTED');assert.equal(r.applied,false);assert.equal(r.productionPermission,false);
});
test('a completed no-op with different poststate remains unverified',()=>{
 const r=classifyQdrantConditionalEvidence({completionStatus:'completed',postconditionObserved:false,operationId:randomUUID()});
 assert.equal(r.classification,'COMPLETED_POSTSTATE_DIFFERENT');assert.equal(r.conditionMatched,'UNPROVEN');
});
test('acknowledged means dispatch acknowledgment only even when readback matches',()=>{
 const r=classifyQdrantConditionalEvidence({completionStatus:'acknowledged',postconditionObserved:true,operationId:randomUUID()});
 assert.equal(r.classification,'ONLY_DISPATCH_ACKNOWLEDGED');assert.equal(r.automaticRetryAllowed,false);
});
test('readback failures are not treated as mismatched physical state or success',()=>{
 const r=classifyQdrantConditionalEvidence({completionStatus:'completed',postconditionObserved:false,observationAvailable:false,operationId:randomUUID()});
 assert.equal(r.observation,'READBACK_INCONCLUSIVE');assert.equal(r.applied,false);
});
test('malformed acknowledgments cannot construct a success-looking classification',()=>{
 for(const status of ['verified','ok',null,1])assert.throws(()=>classifyQdrantConditionalEvidence({completionStatus:status,postconditionObserved:true,operationId:randomUUID()}),/F09C4_EVIDENCE_INVALID/);
 assert.throws(()=>classifyQdrantConditionalEvidence({completionStatus:'completed',postconditionObserved:1,operationId:randomUUID()}));
});
test('external writer can make matching update poststate while candidate conditional update is a no-op',async()=>{
 const first=mkPlan('insert',{...original}),next=mkPlan('update',{recordId:first.recordId,expectedRevision:1,...changed});
 const t=transport({preloaded:[pointFrom(first,original)],hook:async(points)=>{
  // Independent writer overwrites with exactly the desired poststate BEFORE
  // the revision-1 conditional update; the candidate must be skipped.
  points.set(first.physicalId,pointFrom(next,changed));
 }});
 const result=await qdrantV2ConditionalCandidateProbe(t,binding,next,changed);
 assert.equal(result.postconditionObserved,true);assert.equal(result.completionStatus,'completed');
 assert.equal(result.evidence.classification,'COMPLETED_POSTSTATE_MATCH_UNATTRIBUTED');
 assert.equal(result.evidence.applied,false);
});
test('external writer can preempt insert with same content while insert_only silently skips',async()=>{
 const p=mkPlan('insert',{...original}),t=transport({hook:async(points)=>points.set(p.physicalId,pointFrom(p,original))});
 const result=await qdrantV2ConditionalCandidateProbe(t,binding,p,original);
 assert.equal(result.postconditionObserved,true);assert.equal(result.evidence.applied,false);
 assert.equal(result.evidence.classification,'COMPLETED_POSTSTATE_MATCH_UNATTRIBUTED');
});
test('external writer can delete first while guarded delete silently finds no matching row',async()=>{
 const p=mkPlan('insert',{...original}),del=mkPlan('delete',{recordId:p.recordId,expectedRevision:1});
 const t=transport({preloaded:[pointFrom(p,original)],hook:async(points)=>points.delete(p.physicalId)});
 const result=await qdrantV2ConditionalCandidateProbe(t,binding,del);
 assert.equal(result.postconditionObserved,true);assert.equal(result.evidence.applied,false);
});
test('readback outage is classified independently from no-op update',async()=>{
 const p=mkPlan('insert',{...original});
 const t=transport();let reads=0;const previous=t._request.bind(t);
 t._request=async(method,url,body)=>{
  if(url.includes('/points/scroll')&&++reads===2)throw Error('post-dispatch read unavailable');
  return previous(method,url,body);
 };
 const result=await qdrantV2ConditionalCandidateProbe(t,binding,p,original);
 assert.equal(result.observationAvailable,false);
 assert.equal(result.evidence.observation,'READBACK_INCONCLUSIVE');
 assert.equal(result.applied,false);
});
test('self-reported exclusive writer checklist can never grant production permission',()=>{
 const keys=['privateWriteGateway','credentialsRestricted','legacyRoutesBlocked','rawUpsertsBlocked','independentWritersAudited','recoveryProcedureTested','realHostRaceTested'];
 const missing=assessExclusiveWriterEvidence({});assert.equal(missing.missing.length,7);
 const forged=assessExclusiveWriterEvidence(Object.fromEntries(keys.map(k=>[k,true])));
 assert.equal(forged.selfReportedChecklistComplete,true);assert.equal(forged.atomicBackendCertified,false);
 assert.equal(forged.productionPermission,false);
});
test('candidate remains disconnected from atomicOnly production adapter and no public route is added',()=>{
 const t=transport();assert.equal(typeof qdrantV2Adapter(t,binding).atomicCompareAndMutate,'undefined');
});
