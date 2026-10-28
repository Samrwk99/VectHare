import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {f04PilotMutation,f04OperationReceipt,renderF04PilotPanel,F04_PILOT_CONSENT} from '../utils/f04-pilot-client.js';
const ROOT='/api/plugins/similharity/v2/records/pilot-mutate';
const base={backend:'qdrant',configId:'local',source:{kind:'chat',avatar:'test.png',chatFile:'chat'},
 embedding:{source:'transformers',model:'f04',dimension:3,metric:'dot'},action:'insert',
 recordId:randomUUID(),operationId:randomUUID(),expectedRevision:0,
 experimentalConsent:F04_PILOT_CONSENT,text:'new',vector:[1,2,3]};
const inspect=b=>inspectVectorRequest(ROOT,{method:'POST',body:JSON.stringify(b)});
test('F04 gateway requires narrow disposable consent and refuses owner spoof and general routes',()=>{
 assert.equal(inspect(base).allowed,true);
 for(const bad of [{...base,experimentalConsent:false},{...base,configId:'default'},
  {...base,collectionId:'legacy'},{...base,scope:{userScopeId:'wrong'}},
  {...base,backend:'milvus'},{...base,recordId:'not-uuid'},
  {...base,action:'delete',text:'unexpected'},
  {...base,source:{...base.source,userScopeId:'other'}}]){
  assert.throws(()=>inspect(bad),VectorOperationDenied);
 }
 assert.throws(()=>inspectVectorRequest('/api/plugins/similharity/v2/records/insert',{method:'POST',body:JSON.stringify(base)}),VectorOperationDenied);
 assert.throws(()=>inspectVectorRequest('/api/plugins/similharity/chunks/insert',{method:'POST',body:JSON.stringify(base)}),VectorOperationDenied);
});
test('F04 response requires verified identity and explicitly nonproduction capability',async()=>{
 const calls=[];
 const fake=(value,status=200)=>async(u,o)=>{calls.push({u,o});return {status,ok:status<400,json:async()=>value};};
 const valid={success:true,state:'VERIFIED',recordId:base.recordId,operationId:base.operationId,
  productionWritesEnabled:false,experimental:true,retryable:false,targetRevision:1};
 const result=await f04PilotMutation(base,{'X-CSRF-Token':'sample'},fake(valid));
 assert.equal(result.state,'VERIFIED');assert.equal(calls.length,1);
 assert.equal(calls[0].o.credentials,'same-origin');assert.equal(calls[0].o.method,'POST');
 assert.equal(calls[0].o.headers['x-vecthare-f04-pilot'],'1');
 await assert.rejects(()=>f04PilotMutation(base,{},fake({...valid,productionWritesEnabled:true})),/F04_RESPONSE_CONTRACT_INVALID/);
 await assert.rejects(()=>f04PilotMutation(base,{},fake({...valid,recordId:randomUUID()})),/F04_RESULT_ID_MISMATCH/);
 const uncertain=await f04PilotMutation(base,{},fake({...valid,success:false,state:'UNCERTAIN'},202));
 assert.equal(uncertain.state,'UNCERTAIN');
 await assert.rejects(()=>f04PilotMutation(base,{},fake({success:false,experimental:true,productionWritesEnabled:false,retryable:false,code:'S04_REVISION_OR_OWNER_MISMATCH'},409)),/S04_REVISION_OR_OWNER_MISMATCH/);
});
test('F04 renders a clearly marked opt-in pilot control, not auto-dispatched operations',()=>{
 let count=0;const doc={createElement(tag){const el={tag,children:[],setAttribute(){},addEventListener(){},append(...x){this.children.push(...x);}};count++;return el;}};
 const root={querySelector(){return null;},prepend(node){this.node=node;}};
 assert.equal(renderF04PilotPanel(root,()=>({}),doc),true);assert.ok(count>=12);
 assert.ok(root.node.children.some(c=>typeof c.textContent==='string'&&c.textContent.includes('PILOT')));
});

test('F04 operation receipt is GET-only, scoped by server and refuses forged statuses',async()=>{
 const id=randomUUID(),url=`/api/plugins/similharity/v2/operations/${id}`;
 assert.equal(inspectVectorRequest(url,{method:'GET'}).allowed,true);
 assert.throws(()=>inspectVectorRequest(url,{method:'POST',body:'{}'}),VectorOperationDenied);
 assert.throws(()=>inspectVectorRequest('/api/plugins/similharity/v2/operations/not-uuid',{method:'GET'}),VectorOperationDenied);
 const result=await f04OperationReceipt(id,{},async(u,opts)=>{
  assert.equal(u,url);assert.equal(opts.method,'GET');assert.equal(opts.credentials,'same-origin');
  return {ok:true,json:async()=>({success:true,state:'UNCERTAIN',operationId:id,executionAllowed:false})};
 });
 assert.equal(result.state,'UNCERTAIN');
 await assert.rejects(()=>f04OperationReceipt(id,{},async()=>({ok:true,json:async()=>({success:true,state:'VERIFIED',operationId:id,executionAllowed:true})})),/F04_RECEIPT_INVALID/);
});
