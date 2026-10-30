import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {saveEmbeddingProfile,getEmbeddingProfile,generateManagedEmbedding,registerF09b5EmbeddingRoutes} from '../lib/f09b5-embedding-profiles.js';
const profile={source:'llama_cpp',model:'nomic-embed',dimension:3,metric:'cosine'};
const endpoint='http://127.0.0.1:8181/v1/embeddings';
async function temp(fn){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vh-p03-'));await fs.mkdir(path.join(dir,'vectors'));try{return await fn({userScopeId:'owner',vectorsPath:path.join(dir,'vectors')});}finally{await fs.rm(dir,{recursive:true,force:true});}}
const response=vec=>({ok:true,headers:{get:()=>null},arrayBuffer:async()=>Buffer.from(JSON.stringify({data:[{embedding:vec}]}))});
test('P02 nondefault llama.cpp endpoint is invoked with exact configured model, no credentials or redirection',()=>temp(async ctx=>{
 await saveEmbeddingProfile(ctx,{...profile,endpoint});let calls=0;
 const opts={fetchImpl:async(url,init)=>{calls++;assert.equal(url,endpoint);assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,undefined);assert.deepEqual(JSON.parse(init.body),{model:profile.model,input:'test'});return response([1,2,3]);}};
 assert.deepEqual(await generateManagedEmbedding(ctx,profile,'test',opts),[1,2,3]);assert.equal(calls,1);
 await assert.rejects(()=>generateManagedEmbedding(ctx,{...profile,model:'wrong'},'test',opts),/F09B5_PROFILE_MISMATCH/);
 await assert.rejects(()=>generateManagedEmbedding(ctx,profile,'test',{fetchImpl:async()=>response([1,2])}),/F09B5_VECTOR_DIMENSION_OR_VALUES_INVALID/);
 await assert.rejects(()=>generateManagedEmbedding(ctx,profile,'test',{fetchImpl:async()=>{throw Error('ECONNREFUSED');}}),/F09B5_PROVIDER_REQUEST_FAILED/);
}));
test('P01 P03 preflight empty => explicit remediation; test verification survives reload and invalidates on profile edit',()=>temp(async ctx=>{
 const routes=new Map();const router=Object.fromEntries(['get','put','post','delete'].map(m=>[m,(path,fn)=>routes.set(m.toUpperCase()+' '+path,fn)]));
 registerF09b5EmbeddingRoutes(router,{fetchImpl:async()=>response([1,2,3])});
 const run=async(method,path,body,header=true)=>{let status=200,result;const headers=header?{'x-vecthare-configuration':'1'}:{};
  await routes.get(method+' /v2/embeddings/'+path)({s03:ctx,body,headers,get:key=>headers[key.toLowerCase()]}, {status(n){status=n;return this;},json(v){result=v;return this;}});
  return {status,...result};};
 const initial=await run('GET','preflight');assert.equal(initial.configured,false);assert.equal(initial.remediation,'CONFIGURE_SERVER_EMBEDDING_PROFILE');
 assert.equal((await run('PUT','profile',{...profile,endpoint},false)).status,403);
 const saved=await run('PUT','profile',{...profile,endpoint});assert.equal(saved.connectionState,'NOT_TESTED');
 const testResult=await run('POST','test',{});assert.equal(testResult.status,'VECTOR_DIMENSION_VERIFIED');
 const verified=await run('GET','preflight');assert.equal(verified.connectionState,'VERIFIED');assert.equal(verified.remediation,'NONE');
 assert.equal((await getEmbeddingProfile(ctx)).connectionState,'VERIFIED');
 await run('PUT','profile',{...profile,endpoint});assert.equal((await run('GET','preflight')).connectionState,'NOT_TESTED');
}));
test('P02 endpoint SSRF and silent port fallback refused; server credential never required for local source',()=>temp(async ctx=>{
 for(const url of ['http://127.0.0.1:8080/v1/embeddings?x=1','http://localhost:8181/v1/embeddings','http://127.0.0.1/v1/embeddings',
   'http://127.0.0.1:8181/embedding','http://127.0.0.1:8181@evil.invalid/v1/embeddings','https://127.0.0.1:8181/v1/embeddings']){
  await assert.rejects(()=>saveEmbeddingProfile(ctx,{...profile,endpoint:url}),/F09B5_ENDPOINT_INVALID/);
 }
 await assert.rejects(()=>saveEmbeddingProfile(ctx,{...profile,endpoint,credential:'x'}),/F09B5_LOCAL_CREDENTIAL_FORBIDDEN/);
 assert.equal((await getEmbeddingProfile(ctx)).configured,false);
}));
test('P02 loopback HTTP integration uses exact configured non-8080 port end-to-end',()=>temp(async ctx=>{
 const {createServer}=await import('node:http');
 let calls=0;const server=createServer(async(req,res)=>{
  calls++;assert.equal(req.url,'/v1/embeddings');assert.equal(req.method,'POST');
  assert.equal(req.headers.authorization,undefined);let body='';for await(const chunk of req)body+=chunk;
  assert.equal(JSON.parse(body).model,profile.model);
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{embedding:[0.1,0.2,0.3]}]}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const port=server.address().port;assert.notEqual(port,8080);
  await saveEmbeddingProfile(ctx,{...profile,endpoint:`http://127.0.0.1:${port}/v1/embeddings`});
  assert.deepEqual(await generateManagedEmbedding(ctx,profile,'smoke'),[0.1,0.2,0.3]);
  assert.equal(calls,1);
 }finally{await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()));}
}));

test('P02 Ollama native /api/embed and vLLM OpenAI-compatible providers obey exact loopback port, model and dimension',()=>temp(async ctx=>{
 const {createServer}=await import('node:http');
 const calls=[];const server=createServer(async(req,res)=>{
  let body='';for await(const b of req)body+=b;
  const data=JSON.parse(body);calls.push({url:req.url,model:data.model,authorization:req.headers.authorization});
  res.writeHead(200,{'Content-Type':'application/json'});
  res.end(JSON.stringify(req.url==='/api/embed'?{embeddings:[[0.2,0.3,0.4]]}:{data:[{embedding:[0.2,0.3,0.4]}]}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const port=server.address().port;
  for(const variant of [{source:'ollama',path:'/api/embed'},{source:'vllm',path:'/v1/embeddings'},
   {source:'koboldcpp',path:'/v1/embeddings'}]){
   const p={source:variant.source,model:'nomic-embed',dimension:3,metric:'cosine'};
   const endpoint=`http://127.0.0.1:${port}${variant.path}`;
   const stored=await saveEmbeddingProfile(ctx,{...p,endpoint});
   assert.equal(stored.connectionState,'NOT_TESTED');
   assert.deepEqual(await generateManagedEmbedding(ctx,p,'test'),[0.2,0.3,0.4]);
   await assert.rejects(()=>generateManagedEmbedding(ctx,{...p,dimension:5},'test'),/PROFILE_MISMATCH/);
   await assert.rejects(()=>saveEmbeddingProfile(ctx,{...p,endpoint:`http://127.0.0.1:${port}/forbidden`}),/ENDPOINT_INVALID/);
  }
  assert.deepEqual(calls.map(c=>c.model),['nomic-embed','nomic-embed','nomic-embed']);
  assert.ok(calls.every(c=>c.authorization===undefined));
 }finally{await new Promise(resolve=>server.close(resolve));}
}));


test('P-A.4 explicitly mismatched root or per-row provider model fails despite correct dimensions',()=>temp(async ctx=>{
 await saveEmbeddingProfile(ctx,{...profile,endpoint});
 for(const payload of [
  {model:'different-model',data:[{embedding:[1,2,3]}]},
  {model:profile.model,data:[{model:'different-model',embedding:[1,2,3]}]},
  {data:[{model:7,embedding:[1,2,3]}]}
 ]){
  await assert.rejects(()=>generateManagedEmbedding(ctx,profile,'test',{fetchImpl:async()=>({ok:true,headers:{get:()=>null},arrayBuffer:async()=>Buffer.from(JSON.stringify(payload))})}),
   /F09B5_PROVIDER_MODEL_MISMATCH/);
 }
 assert.deepEqual(await generateManagedEmbedding(ctx,profile,'test',{fetchImpl:async()=>({ok:true,headers:{get:()=>null},arrayBuffer:async()=>Buffer.from(JSON.stringify({model:profile.model,data:[{embedding:[1,2,3]}]}))})}),[1,2,3]);
}));
test('P-A.4 mismatched Ollama reported model is rejected even for correctly dimensioned vector',()=>temp(async ctx=>{
 const ollama={source:'ollama',model:'nomic-embed',dimension:3,metric:'cosine'};
 await saveEmbeddingProfile(ctx,{...ollama,endpoint:'http://127.0.0.1:11434/api/embed'});
 await assert.rejects(()=>generateManagedEmbedding(ctx,ollama,'hello',{fetchImpl:async()=>({ok:true,headers:{get:()=>null},arrayBuffer:async()=>Buffer.from(JSON.stringify({model:'wrong',embeddings:[[1,2,3]]}))})}),/F09B5_PROVIDER_MODEL_MISMATCH/);
}));
