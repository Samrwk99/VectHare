import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {F08_ACCEPTANCE_CONSENT,runF08MilvusAcceptance,renderF08MilvusAcceptance} from '../utils/f08-milvus-acceptance.js';
import {F08_PILOT_CONSENT,f08PilotMutation,renderF08PilotPanel} from '../utils/f08-milvus-pilot-client.js';
const ACCEPT='/api/plugins/similharity/v2/diagnostics/milvus-f08';
const PILOT='/api/plugins/similharity/v2/records/milvus-pilot-mutate';
const req={backend:'milvus',configId:'default',source:{kind:'chat',avatar:'hero.png',chatFile:'test'},
 embedding:{source:'transformers',model:'model',dimension:4,metric:'cosine'},action:'insert',
 recordId:randomUUID(),operationId:randomUUID(),expectedRevision:0,
 experimentalConsent:F08_PILOT_CONSENT,text:'record',vector:[.5,.25,.125,.0625]};
test('M0 Milvus diagnostic always refuses writes, even with former consent',()=>{
 assert.throws(()=>inspectVectorRequest(ACCEPT,{method:'POST',body:JSON.stringify({configId:'default',consent:F08_ACCEPTANCE_CONSENT})}),VectorOperationDenied);
});
test('M0 Milvus diagnostic cannot return a false capability claim',async()=>{
 let calls=0;await assert.rejects(()=>runF08MilvusAcceptance({},async()=>{calls++;return {ok:true};}),VectorOperationDenied);
 assert.equal(calls,0);
});
test('M0 Milvus pilot refuses previously valid and forged saved-source record writes',()=>{
 for(const body of [req,{...req,ownerId:'foreign'}])
  assert.throws(()=>inspectVectorRequest(PILOT,{method:'POST',body:JSON.stringify(body)}),VectorOperationDenied);
});
test('M0 Milvus pilot client makes no network request',async()=>{
 let calls=0;await assert.rejects(()=>f08PilotMutation(req,{},async()=>{calls++;return {ok:true};}),VectorOperationDenied);
 assert.equal(calls,0);
});
test('F08 GUI panels are inert until explicit button action',()=>{
 const doc={createElement:tag=>({tag,append(){},addEventListener(){},setAttribute(){}})};
 assert.equal(renderF08MilvusAcceptance({querySelector:()=>null,prepend(){}},doc),true);
 assert.equal(renderF08PilotPanel({querySelector:()=>null,prepend(){}},()=>({}),doc),true);
});
