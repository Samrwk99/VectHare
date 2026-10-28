import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {F12_BACKENDS,F12_REQUIRED_CHECKS,getF12Assessment,registerF12ReleaseRoutes} from '../lib/f12-release-assessment.js';
import {setGuiConnection} from '../lib/s10-gui-connections.js';
async function fixture(fn){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'f12-release-'));
 try{const vectors=path.join(root,'vectors');await fs.mkdir(vectors,{mode:0o700});
  return await fn({vectorsPath:vectors,userScopeId:'alice'});
 }finally{await fs.rm(root,{recursive:true,force:true});}
}
test('F12 release verdict is always NO_GO pending actual functionality and live evidence',()=>fixture(async context=>{
 const result=await getF12Assessment(context);
 assert.equal(result.success,true);assert.equal(result.verdict,'NO_GO');
 assert.equal(result.hostAcceptanceProven,false);assert.equal(result.productionWritesEnabled,false);
 assert.deepEqual(Object.keys(result.backends),F12_BACKENDS);
 assert.deepEqual(result.requiredChecks.map(x=>x.id),F12_REQUIRED_CHECKS);
 assert.ok(result.requiredChecks.every(x=>x.status==='NOT_VERIFIED'));
 assert.ok(Object.values(result.backends).every(x=>x.normalMutationsAllowed===false && x.releaseStatus==='NOT_CERTIFIED' && x.checks.every(c=>c.status==='NOT_VERIFIED')));
}));
test('F12 response is redacted even when GUI-managed endpoints and secrets are saved',()=>fixture(async context=>{
 await setGuiConnection(context,'qdrant',{configId:'default',url:'https://my-private-cluster.example.com',apiKey:'F12_PRIVATE_KEY'});
 await setGuiConnection(context,'milvus',{configId:'default',address:'127.0.0.1:19530',token:'F12_PRIVATE_TOKEN'});
 const str=JSON.stringify(await getF12Assessment(context));
 for(const item of ['F12_PRIVATE_KEY','F12_PRIVATE_TOKEN','my-private-cluster','19530','vectorsPath','userScopeId'])assert.equal(str.includes(item),false,item);
}));
test('F12 route rejects unauthenticated scope, query overrides and bodies',()=>fixture(async context=>{
 const routes=new Map();registerF12ReleaseRoutes({get:(p,h)=>routes.set(p,h)});
 const route=routes.get('/v2/release/assessment');assert.equal(typeof route,'function');
 const send=async(req)=>{const res={code:200,status(n){this.code=n;return this;},json(body){this.body=body;return this;}};await route(req,res);return res;};
 assert.equal((await send({s03:context})).body.verdict,'NO_GO');
 assert.equal((await send({s03:null})).code,403);
 assert.equal((await send({s03:context,query:{userScopeId:'victim'}})).code,400);
 assert.equal((await send({s03:context,body:{productionWritesEnabled:true}})).code,400);
}));
