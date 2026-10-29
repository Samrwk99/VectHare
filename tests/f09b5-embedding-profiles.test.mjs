import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {getEmbeddingProfile,saveEmbeddingProfile,deleteEmbeddingProfile,generateManagedEmbedding,
 registerF09b5EmbeddingRoutes} from '../lib/f09b5-embedding-profiles.js';
const profile={source:'openai',model:'text-embedding-3-small',dimension:3,metric:'cosine'};
async function temp(fn){const root=await fs.mkdtemp(path.join(os.tmpdir(),'vh-f09b5-'));const vec=path.join(root,'vectors');await fs.mkdir(vec);try{return await fn({userScopeId:'first',vectorsPath:vec},root);}finally{await fs.rm(root,{recursive:true,force:true});}}
const response=(vector)=>({ok:true,headers:{get:()=>null},arrayBuffer:async()=>Buffer.from(JSON.stringify({data:[{embedding:vector}]}))});
test('F09b.5 per-user redacted private profile and no cross-provider secret retention',()=>temp(async(ctx,root)=>{
 const stored=await saveEmbeddingProfile(ctx,{...profile,credential:'sk-dummy-secret'});
 assert.equal(stored.hasCredential,true);assert.equal(JSON.stringify(stored).includes('sk-dummy'),false);
 const dir=path.join(root,'.similharity-private');const stat=await fs.stat(path.join(dir,'embedding-profile.json'));
 if(process.platform!=='win32')assert.equal(stat.mode&0o077,0);
 assert.equal((await getEmbeddingProfile(ctx)).profile.model,profile.model);
 await saveEmbeddingProfile(ctx,{...profile,source:'mistral'});
 assert.equal((await getEmbeddingProfile(ctx)).hasCredential,false);
 await saveEmbeddingProfile(ctx,{...profile,credential:'sk-dummy-secret'});
 await saveEmbeddingProfile(ctx,profile);assert.equal((await getEmbeddingProfile(ctx)).hasCredential,true);
 await saveEmbeddingProfile(ctx,{...profile,clearCredential:true});assert.equal((await getEmbeddingProfile(ctx)).hasCredential,false);
 await deleteEmbeddingProfile(ctx);assert.equal((await getEmbeddingProfile(ctx)).configured,false);
}));
test('F09b.5 fixed endpoint, bounded request, dimension and nonfinite checks',()=>temp(async ctx=>{
 await saveEmbeddingProfile(ctx,{...profile,credential:'sk-fixture'});
 let invoked=0;
 const mock=async(url,init)=>{invoked++;assert.equal(url,'https://api.openai.com/v1/embeddings');
  assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Bearer sk-fixture');
  assert.deepEqual(JSON.parse(init.body),{model:profile.model,input:'test'});return response([0.1,0.2,0.3]);};
 assert.deepEqual(await generateManagedEmbedding(ctx,profile,'test',{fetchImpl:mock}),[0.1,0.2,0.3]);
 assert.equal(invoked,1);
 await assert.rejects(()=>generateManagedEmbedding(ctx,{...profile,model:'other'},'test',{fetchImpl:mock}),/F09B5_PROFILE_MISMATCH/);
 await assert.rejects(()=>generateManagedEmbedding(ctx,profile,'test',{fetchImpl:async()=>response([1,2])}),/F09B5_VECTOR_DIMENSION_OR_VALUES_INVALID/);
 await assert.rejects(()=>generateManagedEmbedding(ctx,profile,'test',{fetchImpl:async()=>response([1,null,3])}),/F09B5_VECTOR_DIMENSION_OR_VALUES_INVALID/);
 await assert.rejects(()=>generateManagedEmbedding(ctx,profile,'test',{fetchImpl:async()=>({ok:false})}),/F09B5_PROVIDER_REQUEST_FAILED/);
}));
test('F09b.5 rejects credentials, unknown fields, invalid source, and symlinked store',()=>temp(async(ctx,root)=>{
 await assert.rejects(()=>saveEmbeddingProfile(ctx,{...profile,apiUrl:'http://127.0.0.1'}),/F09B5_FIELDS_FORBIDDEN/);
 await assert.rejects(()=>saveEmbeddingProfile(ctx,{...profile,source:'ollama'}),/F09B5_PROVIDER_MODEL_UNSUPPORTED/);
 await assert.rejects(()=>saveEmbeddingProfile(ctx,{...profile,credential:'abc\r\n'}),/F09B5_CREDENTIAL_INVALID/);
 await saveEmbeddingProfile(ctx,{...profile,credential:'x'});
 const file=path.join(root,'.similharity-private','embedding-profile.json');
 await fs.rename(file,file+'.original');await fs.symlink(file+'.original',file);
 await assert.rejects(()=>getEmbeddingProfile(ctx),/F09B5_FILE_UNTRUSTED/);
}));
test('F09b.5 route GET is redacted; CSRF config header required; test returns no vectors',()=>temp(async ctx=>{
 const routes=new Map();const router={get:(r,h)=>routes.set('GET '+r,h),put:(r,h)=>routes.set('PUT '+r,h),delete:(r,h)=>routes.set('DELETE '+r,h),post:(r,h)=>routes.set('POST '+r,h)};
 registerF09b5EmbeddingRoutes(router,{fetchImpl:async()=>response([1,2,3])});
 const run=async(method,url,body,headers={})=>{
  let status=200,result;const res={status(s){status=s;return this;},json(data){result=data;return this;}};
  await routes.get(method+' '+url)({s03:ctx,body,headers,get:k=>headers[k.toLowerCase()]},res);
  return {status,result};
 };
 let result=await run('PUT','/v2/embeddings/profile',{...profile,credential:'secret'});
 assert.equal(result.status,403);
 result=await run('PUT','/v2/embeddings/profile',{...profile,credential:'secret'},{'x-vecthare-configuration':'1'});
 assert.equal(result.status,200);assert.equal(JSON.stringify(result.result).includes('secret'),false);
 result=await run('GET','/v2/embeddings/profile');assert.equal(result.result.hasCredential,true);
 result=await run('POST','/v2/embeddings/test',{}, {'x-vecthare-configuration':'1'});
 assert.equal(result.result.status,'VECTOR_DIMENSION_VERIFIED');assert.equal(JSON.stringify(result.result).includes('embedding:['),false);
 result=await run('POST','/v2/embeddings/test',{text:'sensitive'}, {'x-vecthare-configuration':'1'});
 assert.equal(result.status,403);
}));
