import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {registerS04Routes} from '../lib/s04-routes.js';
import {sample} from './s04-contract.test.mjs';
function setup(){const routes=new Map();const router={post:(p,f)=>routes.set(`POST ${p}`,f),get:(p,f)=>routes.set(`GET ${p}`,f)};registerS04Routes(router);return routes;}
function res(){return{code:200,data:null,status(n){this.code=n;return this;},json(d){this.data=d;return this;}};}
test('S04 public preflight validates but does not authorize or dispatch a mutation',async()=>{
 const routes=setup(),r=res(),req={s03:{userScopeId:'alice'},body:sample()};
 await routes.get('POST /v2/operations/preflight')(req,r);
 assert.equal(r.code,200);assert.equal(r.data.authorized,false);assert.equal(r.data.executionAllowed,false);
 assert.ok(!JSON.stringify(r.data).includes('hello'));
 const wrong=res();await routes.get('POST /v2/operations/preflight')({s03:{userScopeId:'bob'},body:{...sample(),scope:{...sample().scope,userScopeId:'alice'}}},wrong);
 assert.equal(wrong.code,403);assert.equal(wrong.data.code,'S04_SCOPE_MISMATCH');
});
test('S04 public submit/reconcile refuse even if client provides forged attestation',async()=>{
 const routes=setup();
 for(const [endpoint,code] of [['/v2/operations/submit','S04_MUTATION_NOT_ACTIVATED'],['/v2/operations/reconcile','S04_RECONCILE_NOT_ACTIVATED']]){
  const r=res();await routes.get(`POST ${endpoint}`)({s03:{userScopeId:'alice'},body:{authorized:true,mutationContractVerified:true}},r);
  assert.equal(r.code,409);assert.equal(r.data.code,code);
 }
});
test('S04 status endpoint fails closed for missing operations',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'s04-route-'));
 try{const r=res();await setup().get('GET /v2/operations/:id')({s03:{userScopeId:'alice',vectorsPath:dir},params:{id:sample().operationId}},r);
  assert.equal(r.code,404);assert.equal(r.data.code,'S04_OPERATION_UNAVAILABLE');}
 finally{await fs.rm(dir,{recursive:true,force:true});}
});
