import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {F07_ACCEPTANCE_CONSENT,runF07VectraAcceptance,renderF07VectraAcceptance} from '../utils/f07-vectra-acceptance.js';
import {F07_PILOT_CONSENT,f07PilotMutation,renderF07PilotPanel} from '../utils/f07-vectra-pilot-client.js';
const ACCEPT='/api/plugins/similharity/v2/diagnostics/vectra-f07';
const PILOT='/api/plugins/similharity/v2/records/vectra-pilot-mutate';
const request={backend:'vectra',configId:'default',source:{kind:'chat',avatar:'hero.png',chatFile:'test'},
 embedding:{source:'transformers',model:'model',dimension:3,metric:'dot'},action:'insert',
 recordId:randomUUID(),operationId:randomUUID(),expectedRevision:0,
 experimentalConsent:F07_PILOT_CONSENT,text:'record',vector:[.25,.5,.75]};
test('M0 Vectra diagnostic cannot bypass the new trusted gateway',()=>{
 assert.throws(()=>inspectVectorRequest(ACCEPT,{method:'POST',body:JSON.stringify({consent:F07_ACCEPTANCE_CONSENT})}),VectorOperationDenied);
});
test('M0 Vectra diagnostic GUI cannot send a write',async()=>{
 let calls=0;await assert.rejects(()=>runF07VectraAcceptance({},async()=>{calls++;return {ok:true};}),VectorOperationDenied);
 assert.equal(calls,0);
});
test('M0 Vectra pilot refuses the formerly valid and forged record write',()=>{
 for(const b of [request,{...request,userScopeId:'other'}])
  assert.throws(()=>inspectVectorRequest(PILOT,{method:'POST',body:JSON.stringify(b)}),VectorOperationDenied);
});
test('M0 Vectra pilot client cannot dispatch even a previously consented write',async()=>{
 let calls=0;await assert.rejects(()=>f07PilotMutation(request,{},async()=>{calls++;return {ok:true};}),VectorOperationDenied);
 assert.equal(calls,0);
});
test('F07 panels render without dispatching any mutation or diagnostic',()=>{
 const doc={createElement:tag=>({tag,append(){},addEventListener(){},setAttribute(){}})};
 assert.equal(renderF07VectraAcceptance({querySelector:()=>null,prepend(){}},doc),true);
 assert.equal(renderF07PilotPanel({querySelector:()=>null,prepend(){}},()=>({}),doc),true);
});
test('M0 F03 Vectra provision and native Standard writes both remain blocked',()=>{
 const b={backend:'vectra',configId:'default',source:request.source,embedding:request.embedding,
  confirmProvision:true,expectedCollectionName:'vh2_'+'a'.repeat(48)};
 assert.throws(()=>inspectVectorRequest('/api/plugins/similharity/v2/collections/provision',{method:'POST',body:JSON.stringify(b)}),VectorOperationDenied);
 assert.throws(()=>inspectVectorRequest('/api/vector/insert',{method:'POST',body:'{}'}),VectorOperationDenied);
});
