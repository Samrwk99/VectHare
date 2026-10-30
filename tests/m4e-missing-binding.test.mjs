import test from 'node:test';
import assert from 'node:assert/strict';
import {registerM1Routes} from '../lib/m1-saved-records.js';
const source={kind:'chat',avatar:'Jane.png',chatFile:'saved'};
async function call(code){
 let handler;
 const router={post(path,fn){if(path==='/v2/m1/records/preview')handler=fn;},get(){}};
 registerM1Routes(router,{getProfile:async()=>({configured:true,profile:{source:'transformers',model:'host',dimension:3,metric:'cosine'},connectionState:'VERIFIED'}),
  bind:async()=>{throw Object.assign(new Error('private server text'),{code,status:409});},
  readSnapshot:async()=>({sourceId:'saved',fileHash:'hash',messages:[],sourceKind:'chat'})});
 let sent,status=200;
 await handler({s03:{userScopeId:'owner',vectorsPath:'/disposable'},user:{directories:{}},body:{backend:'qdrant',configId:'default',source}},
  {status(n){status=n;return this;},json(x){sent=x;return this;}});
 return {status,sent};
}
test('M4e exposes ONLY explicit unbound collection as a safe provisioning-required code',async()=>{
 const r=await call('F02_COLLECTION_NOT_BOUND');
 assert.equal(r.status,409);assert.equal(r.sent.code,'M1_COLLECTION_UNPROVISIONED');
 assert.equal(r.sent.executionAllowed,false);assert.equal(r.sent.success,false);
 assert.ok(!JSON.stringify(r.sent).includes('private server text'));
});
test('M4e does not reclassify unknown read or ownership errors as unprovisioned',async()=>{
 for(const code of ['F02_OWNER_UNVERIFIED','F02_SCHEMA_UNVERIFIED','F02_READ_FAILED']){
  const r=await call(code);assert.equal(r.sent.code,'M1_OPERATION_REFUSED');
 }
});
