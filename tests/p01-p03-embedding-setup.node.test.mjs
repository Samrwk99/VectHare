import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectVectorRequest} from '../utils/e02-vector-request-gateway.js';
import {getEmbeddingProfile,preflightEmbeddingProfile,saveEmbeddingProfile,testEmbeddingProfile,deleteEmbeddingProfile} from '../utils/f09b5-embedding-gui.js';
const root='/api/plugins/similharity/v2/embeddings';
test('P03 owned configuration and read-only preflight are permitted; arbitrary destinations and vector payloads denied',()=>{
 for(const [path,method,body] of [['profile','GET'],['preflight','GET'],['test','POST',{}],
  ['profile','PUT',{source:'llama_cpp',model:'embed-model',dimension:384,metric:'cosine',endpoint:'http://127.0.0.1:8181/v1/embeddings'}],['profile','DELETE']]){
  assert.equal(inspectVectorRequest(`${root}/${path}`,{method,...(body?{body:JSON.stringify(body)}:{})}).allowed,true);
 }
 for(const [path,method,body] of [['test','POST',{text:'SECRET'}],['preflight','PUT',{}],['profile','POST',{}],
  ['profile','PUT',{source:'llama_cpp',model:'m',dimension:3,metric:'cosine',endpoint:'http://169.254.169.254/v1/embeddings'}],
  ['profile','PUT',{source:'openai',model:'m',dimension:3,metric:'cosine',apiUrl:'http://localhost'}]]){
  assert.throws(()=>inspectVectorRequest(`${root}/${path}`,{method,...(body?{body:JSON.stringify(body)}:{})}));
 }
});
test('P03 browser setup has explicit scoped methods; remote-only secret never in URL or readback',async()=>{
 const requests=[];const fetched=async(url,init)=>{requests.push({url,init});return {ok:true,json:async()=>({success:true,configured:true,profile:{source:'openai',model:'m',dimension:3,metric:'cosine'}})};};
 await getEmbeddingProfile({},fetched);await preflightEmbeddingProfile({},fetched);
 await saveEmbeddingProfile({source:'openai',model:'m',dimension:3,metric:'cosine',credential:'synthetic-secret'},{},fetched);
 await testEmbeddingProfile({},fetched);await deleteEmbeddingProfile({},fetched);
 assert.equal(requests.length,5);
 assert.deepEqual(requests.map(x=>x.init.method),['GET','GET','PUT','POST','DELETE']);
 assert.equal(requests[2].init.headers['X-VectHare-Configuration'],'1');
 assert.equal(requests.every(x=>!x.url.includes('synthetic-secret')),true);
 assert.throws(()=>saveEmbeddingProfile({source:'llama_cpp',model:'m',dimension:3,metric:'cosine',endpoint:'http://evil.example/v1/embeddings'},{},fetched),/F09B5_LOCAL_ENDPOINT_REQUIRED/);
 assert.equal(requests.length,5);
});

test('P-A.5 four local providers can be saved through gateway with only exact loopback endpoints',async()=>{
 for(const provider of ['llama_cpp','ollama','vllm','koboldcpp']){
  const endpoint=`http://127.0.0.1:8123/${provider==='ollama'?'api/embed':'v1/embeddings'}`;
  const profile={source:provider,model:'m',dimension:3,metric:'cosine',endpoint};
  assert.equal(inspectVectorRequest(`${root}/profile`,{method:'PUT',body:JSON.stringify(profile)}).allowed,true);
  const requests=[];
  await saveEmbeddingProfile(profile,{},async(url,init)=>{requests.push({url,body:JSON.parse(init.body)});return {ok:true,json:async()=>({success:true})};});
  assert.equal(requests.length,1);assert.equal(requests[0].body.endpoint,endpoint);
  for(const badEndpoint of ['http://169.254.169.254/v1/embeddings','https://127.0.0.1:8123/v1/embeddings',
   'http://127.0.0.1:8123/private','http://localhost:8123/v1/embeddings']){
   assert.throws(()=>inspectVectorRequest(`${root}/profile`,{method:'PUT',body:JSON.stringify({...profile,endpoint:badEndpoint})}));
  }
 }
});
test('P-A.5 saved local profile refresh enables its endpoint immediately without toggling source',async()=>{
 const {renderF09b5EmbeddingGui}=await import('../utils/f09b5-embedding-gui.js');
 const events=new Map();
 class Element{
  constructor(tag){this.tag=tag;this.children=[];this.disabled=false;this.value='';this.style={};}
  append(...nodes){this.children.push(...nodes);}prepend(node){this.children.unshift(node);}
  setAttribute(){}addEventListener(type,fn){events.set(`${this.tag}:${type}`,fn);}
 }
 const container=new Element('root');container.querySelector=()=>null;
 const doc={createElement:tag=>new Element(tag)};
 const getSettings=()=>({f09b_embedding_source:'transformers'});
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async()=>({ok:true,json:async()=>({success:true,configured:true,connectionState:'VERIFIED',profileRevision:'a'.repeat(64),
  profile:{source:'ollama',model:'embed-fixture',dimension:384,metric:'cosine'},endpoint:'http://127.0.0.1:11434/api/embed'})});
 try{
  assert.equal(renderF09b5EmbeddingGui(container,getSettings,()=>{},()=>({}),doc),true);
  await new Promise(resolve=>setTimeout(resolve,20));
  const elements=container.children[0].children;
  const source=elements.find(x=>x.tag==='select'&&x.value==='ollama');
  const endpoint=elements.find(x=>x.tag==='input'&&x.type==='url');
  assert.ok(source);assert.ok(endpoint);
  assert.equal(endpoint.value,'http://127.0.0.1:11434/api/embed');
  assert.equal(endpoint.disabled,false);
 }finally{globalThis.fetch=originalFetch;}
});
