import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {attestF01Source} from '../utils/s11-plugin-compatibility.js';
const url='/api/plugins/similharity/v2/sources/attest';
const chat={kind:'chat',avatar:'Nina.png',chatFile:'Nina - Branch #1'};
test('F01 permits only strict source attestation without opening any record operation',()=>{
 assert.equal(inspectVectorRequest(url,{method:'POST',body:JSON.stringify(chat)}).allowed,true);
 for(const body of [{}, {...chat,sourceId:'spoof'}, {...chat,userScopeId:'bob'}, {kind:'scene',name:'abc'}])
  assert.throws(()=>inspectVectorRequest(url,{method:'POST',body:JSON.stringify(body)}),VectorOperationDenied);
 assert.throws(()=>inspectVectorRequest(url,{method:'GET'}),VectorOperationDenied);
 assert.throws(()=>inspectVectorRequest('/api/plugins/similharity/v2/records/insert',{method:'POST',body:'{}'}),VectorOperationDenied);
});
test('F01 client sends only selector, no arbitrary owner credentials or collection',async()=>{
 let seen;
 const ok=await attestF01Source(chat,{'X-CSRF-Token':'abc'},async(u,options)=>{
  seen={u,options};return {ok:true,json:async()=>({success:true,hostSourceOwnerVerified:true,activeChatVerified:false,
     publicReadsEnabled:false,publicWritesEnabled:false,sourceId:'f01_abcd',scope:{type:'chat'}})};
 });
 assert.equal(ok.hostSourceOwnerVerified,true);
 assert.deepEqual(JSON.parse(seen.options.body),chat);
 assert.equal(seen.options.credentials,'same-origin');
 await assert.rejects(()=>attestF01Source({...chat,apiKey:'secret'}, {},async()=>{}),VectorOperationDenied);
});
test('F01 client never converts an optimistic server result into authorization',async()=>{
 await assert.rejects(()=>attestF01Source(chat,{},async()=>({ok:true,json:async()=>({success:true,
 hostSourceOwnerVerified:true,activeChatVerified:true,publicReadsEnabled:false,publicWritesEnabled:false,
 sourceId:'f01_abc',scope:{}})})),/F01_RESPONSE_UNVERIFIED/);
 await assert.rejects(()=>attestF01Source(chat,{},async()=>({ok:false,status:409,json:async()=>({code:'F01_SOURCE_NOT_FOUND'})})),/F01_SOURCE_NOT_FOUND/);
});
