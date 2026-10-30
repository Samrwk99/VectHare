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
test('M0 supersedes F04 pilot: all legacy pilot requests are blocked at browser boundary',()=>{
 for(const input of [base,{...base,experimentalConsent:false},{...base,ownerId:'other'}])
  assert.throws(()=>inspect(input),VectorOperationDenied);
 assert.throws(()=>inspectVectorRequest('/api/plugins/similharity/chunks/insert',{method:'POST',body:JSON.stringify(base)}),VectorOperationDenied);
});
test('M0 F04 client makes no network request, even with matching legacy consent',async()=>{
 let sent=0;await assert.rejects(()=>f04PilotMutation(base,{},async()=>{sent++;return {ok:true};}),VectorOperationDenied);
 assert.equal(sent,0);
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
