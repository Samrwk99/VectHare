import test from 'node:test';import assert from 'node:assert/strict';
import {registerS05Routes} from '../lib/s05-routes.js';
import {scope,embedding} from './s05-contract.test.mjs';
function setup(){const routes=new Map(),router={post:(k,fn)=>routes.set(k,fn)};registerS05Routes(router);return routes;}
const response=()=>({code:200,data:null,status(s){this.code=s;return this},json(v){this.data=v;return this}});
test('S05 public v2 read APIs are disabled regardless of forged attestations',async()=>{
 const routes=setup();for(const name of ['/v2/reads/get','/v2/reads/list','/v2/reads/query','/v2/reads/inventory']) {
  const res=response();await routes.get(name)({s03:{userScopeId:'alice'},body:{authorized:true,provenance:'SERVER_VERIFIED'}},res);
  assert.equal(res.code,409);assert.equal(res.data.code,'S05_READ_NOT_ACTIVATED');
 }
});
test('S05 preflight validates query dimension but does not authorize source',async()=>{
 const routes=setup(),res=response();
 await routes.get('/v2/reads/preflight')({s03:{userScopeId:'alice'},body:{backend:'qdrant',scope,embedding,page:{limit:40},queryVector:[1,2,3]}},res);
 assert.equal(res.code,200);assert.equal(res.data.authorized,false);assert.equal(res.data.executionAllowed,false);
 const bad=response();await routes.get('/v2/reads/preflight')({s03:{userScopeId:'alice'},body:{backend:'qdrant',scope,embedding,queryVector:[1,2]}},bad);
 assert.equal(bad.code,400);assert.equal(bad.data.code,'S05_VECTOR_INVALID');
 const spoof=response();await routes.get('/v2/reads/preflight')({s03:{userScopeId:'bob'},body:{backend:'qdrant',scope,embedding}},spoof);
 assert.equal(spoof.code,403);assert.equal(spoof.data.code,'S05_OWNER_CONFLICT');
});
