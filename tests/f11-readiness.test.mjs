import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {getF11Readiness,registerF11ReadinessRoutes} from '../lib/f11-readiness.js';
import {setGuiConnection} from '../lib/s10-gui-connections.js';
async function fixture(fn){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'f11-readiness-'));
 try{const vectors=path.join(root,'vectors');await fs.mkdir(vectors,{mode:0o700});
  return await fn({vectorsPath:vectors,userScopeId:'alice'});
 }finally{await fs.rm(root,{force:true,recursive:true});}
}
test('F11 redacted readiness keeps all backend normal operations denied',()=>fixture(async context=>{
 const result=await getF11Readiness(context);
 assert.equal(result.success,true);assert.equal(result.backendHealthMeasured,false);
 assert.equal(result.backends.qdrant.connection,'LOCAL_DEFAULT_AVAILABLE');
 assert.equal(result.backends.milvus.connection,'NOT_CONFIGURED');
 for(const backend of Object.values(result.backends)){
  for(const op of ['normalInsert','normalUpdate','normalDelete','automaticVectorization','automaticPromptInjection','authoritativeInventory','verifiedFullBackup','restore','migration','purge','productionCertified'])assert.equal(backend[op],false,op);
  assert.equal(backend.connectionHealth,'NOT_TESTED');
 }
 assert.equal(result.backends['standard-native'].mutations,'NATIVE_MUTATION_CONTRACT_UNPROBED');
 assert.equal(JSON.stringify(result).includes('apiKey'),false);
}));
test('F11 per-user saved profile status never reveals saved secrets or endpoints',()=>fixture(async context=>{
 await setGuiConnection(context,'qdrant',{configId:'default',url:'https://example.com',apiKey:'PRIVATE_SECRET'});
 await setGuiConnection(context,'milvus',{configId:'default',address:'localhost:19530',token:'SENSITIVE_TOKEN'});
 const result=await getF11Readiness(context);const serialized=JSON.stringify(result);
 assert.equal(result.backends.qdrant.remoteProfileConfigured,true);
 assert.equal(result.backends.milvus.connection,'SAVED_PROFILE');
 for(const secret of ['PRIVATE_SECRET','SENSITIVE_TOKEN','example.com','19530'])assert.equal(serialized.includes(secret),false);
}));
test('F11 route requires authenticated context; never accepts query ownership overrides',()=>fixture(async context=>{
 const routes=new Map();registerF11ReadinessRoutes({get:(p,h)=>routes.set(p,h)});
 assert.equal(routes.has('/v2/setup/readiness'),true);
 const request=async s03=>{const res={statusCode:200,status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};
  await routes.get('/v2/setup/readiness')({s03,query:{owner:'victim',userScopeId:'bob'}},res);return res;};
 const ok=await request(context);assert.equal(ok.statusCode,200);assert.equal(ok.body.userScopeVerified,true);
 const no=await request(null);assert.equal(no.statusCode,403);assert.equal(no.body.success,false);
}));
