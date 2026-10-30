import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {F06_ACCEPTANCE_CONSENT,runF06LanceAcceptance,renderF06LanceAcceptance} from '../utils/f06-lancedb-acceptance.js';
const url='/api/plugins/similharity/v2/diagnostics/lancedb-f06';
test('M0 supersedes F06 diagnostics: no disposable database writes bypass the gateway',()=>{
 for(const body of [{consent:F06_ACCEPTANCE_CONSENT},{consent:'yes'}])
  assert.throws(()=>inspectVectorRequest(url,{method:'POST',body:JSON.stringify(body)}),VectorOperationDenied);
});
test('M0 F06 diagnostic GUI cannot dispatch vector mutations',async()=>{
 let calls=0;
 await assert.rejects(()=>runF06LanceAcceptance({},async()=>{calls++;return {ok:true};}),VectorOperationDenied);
 assert.equal(calls,0);
});
test('M0 F06 cannot claim success or capabilities because no request is sent',async()=>{
 await assert.rejects(()=>runF06LanceAcceptance({},async()=>({ok:true,json:async()=>({productionWritesEnabled:true})})),VectorOperationDenied);
});
test('F06 GUI remains opt-in; no automatic LanceDB mutation at render',()=>{
 let count=0;const doc={createElement:()=>({append(){},prepend(){},addEventListener(){count++},setAttribute(){}})};
 assert.equal(renderF06LanceAcceptance({querySelector:()=>null,prepend(){}},doc),true);assert.equal(count,1);
});
test('M0 F03 provisioning is refused until it is integrated with the trusted gateway',()=>{
 const b={backend:'lancedb',source:{kind:'chat',avatar:'x.png',chatFile:'test'},
  embedding:{source:'transformers',model:'test',dimension:3,metric:'dot'},configId:'default',
  confirmProvision:true,expectedCollectionName:'vh2_'+'a'.repeat(48)};
 assert.throws(()=>inspectVectorRequest('/api/plugins/similharity/v2/collections/provision',{method:'POST',body:JSON.stringify(b)}),VectorOperationDenied);
});
import {randomUUID} from 'node:crypto';
import {f06PilotMutation,renderF06PilotPanel,F06_PILOT_CONSENT} from '../utils/f06-lancedb-pilot-client.js';
const PILOT='/api/plugins/similharity/v2/records/lancedb-pilot-mutate';
const request={backend:'lancedb',configId:'default',source:{kind:'chat',avatar:'hero.png',chatFile:'test'},
 embedding:{source:'transformers',model:'model',dimension:3,metric:'dot'},action:'insert',
 recordId:randomUUID(),operationId:randomUUID(),expectedRevision:0,
 experimentalConsent:F06_PILOT_CONSENT,text:'record',vector:[.25,.5,.75]};
test('M0 F06 pilot gateway refuses even the previously valid disposable request',()=>{
 for(const b of [request,{...request,collectionName:'valuable'}, {...request,userScopeId:'other'}])
  assert.throws(()=>inspectVectorRequest(PILOT,{method:'POST',body:JSON.stringify(b)}),VectorOperationDenied);
});
test('M0 F06 pilot cannot dispatch a request',async()=>{
 let calls=0;await assert.rejects(()=>f06PilotMutation(request,{},async()=>{calls++;return {ok:true};}),VectorOperationDenied);
 assert.equal(calls,0);
});
test('F06 manual pilot GUI renders without automatic mutation',()=>{
 let count=0;const doc={createElement(tag){const obj={tag,children:[],setAttribute(){},addEventListener(){},append(...n){this.children.push(...n);}};count++;return obj;}};
 assert.equal(renderF06PilotPanel({querySelector:()=>null,prepend(){}},()=>({}),doc),true);assert.ok(count>=12);
});
