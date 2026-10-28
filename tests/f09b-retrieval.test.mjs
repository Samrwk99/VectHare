import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {registerF09WorkflowRoutes} from '../lib/f09-workflows.js';
const body={backend:'qdrant',source:{kind:'chat',avatar:'A.png',chatFile:'chat'},
 embedding:{source:'webllm',model:'m',dimension:3,metric:'cosine'},vector:[1,0,0],topK:2};
function res(){return {code:200,status(n){this.code=n;return this;},json(v){this.body=v;return this;}};}
test('F09b uses same F02 source authorization for normal retrieval, no mutation operations',async()=>{
 const routes=new Map(),calls=[];
 registerF09WorkflowRoutes({post:(path,fn)=>routes.set(path,fn)},
   {backendPool:{},readScoped:async(req,b,op)=>{calls.push([b,op]);return [{recordId:randomUUID(),revision:1,score:.8,text:'owned memory'}];}});
 const result=res();await routes.get('/v2/workflows/retrieve')({body,s03:{userScopeId:'s',vectorsPath:'/tmp'}},result);
 assert.equal(result.code,200);assert.equal(result.body.automaticInjectionEligible,true);
 assert.equal(result.body.productionWritesEnabled,false);assert.equal(calls[0][1],'query');
 const preview=res();await routes.get('/v2/workflows/preview')({body,s03:{userScopeId:'s',vectorsPath:'/tmp'}},preview);
 assert.equal(preview.body.automaticInjectionEligible,false);
 const unauthorized=res();await routes.get('/v2/workflows/retrieve')({body,s03:{}},unauthorized);
 assert.equal(unauthorized.code,403);
 const forged=res();await routes.get('/v2/workflows/retrieve')({body:{...body,ownerId:'victim'},s03:{userScopeId:'s',vectorsPath:'/tmp'}},forged);
 assert.equal(forged.code,400);
});
