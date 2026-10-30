/** F09b.5: authenticated, per-user server-managed embedding identity and secrets.
 * Never returns credentials, vectors or arbitrary external network destinations.
 * Configuration/test routes cannot authorize any v2 record mutation.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {constants as C} from 'node:fs';
import {canonicalEmbedding} from './s02-identity.js';
import {validateGuiMutationRequest} from './s10-gui-connections.js';

const ENDPOINTS=Object.freeze({
 openai:'https://api.openai.com/v1/embeddings',
 togetherai:'https://api.together.xyz/v1/embeddings',
 mistral:'https://api.mistral.ai/v1/embeddings',
 openrouter:'https://openrouter.ai/api/v1/embeddings',
});
const LOCAL_SOURCES=Object.freeze(['llama_cpp','ollama','vllm','koboldcpp']);
const SOURCES=Object.freeze(['transformers',...LOCAL_SOURCES,...Object.keys(ENDPOINTS)]);
const PROFILE_FIELDS=['source','model','dimension','metric'];
const CONFIG_FIELDS=[...PROFILE_FIELDS,'endpoint','credential','clearCredential'];
function localEmbeddingEndpoint(endpoint,source='llama_cpp'){
 if(typeof endpoint!=='string'||endpoint.length>200)fail('F09B5_ENDPOINT_INVALID',400);
 let url;try{url=new URL(endpoint);}catch{fail('F09B5_ENDPOINT_INVALID',400);}
 // Only an explicitly configured server-loopback service; no DNS, redirects, query or credentials.
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||
    !Number.isInteger(Number(url.port))||Number(url.port)<1||Number(url.port)>65535||
    url.pathname!==(source==='ollama'?'/api/embed':'/v1/embeddings')||url.search||url.hash||url.username||url.password||
    url.href!==endpoint)fail('F09B5_ENDPOINT_INVALID',400);
 return endpoint;
}
function publicProfileRevision(data){return data?(data.revision??createHash('sha256').update(JSON.stringify([data.profile,data.endpoint??null])).digest('hex')):null;}

const MAX_BYTES=8192;
const fail=(code,status=409)=>{throw Object.assign(new Error(code),{code,status});};
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
const keys=(x,allowed)=>!Object.keys(x).some(k=>!allowed.includes(k));
const mutexes=new Map();
function location(ctx){
 if(typeof ctx?.vectorsPath!=='string'||!path.isAbsolute(ctx.vectorsPath)||!ctx.userScopeId)fail('F09B5_HOST_IDENTITY_REQUIRED',403);
 return path.join(path.dirname(ctx.vectorsPath),'.similharity-private');
}
async function directory(ctx,create=false){
 const dir=location(ctx);
 try{
  if(create)await fs.mkdir(dir,{recursive:false,mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
  const st=await fs.lstat(dir);
  if(!st.isDirectory()||st.isSymbolicLink()||(process.platform!=='win32'&&(st.mode&0o077)))fail('F09B5_DIRECTORY_UNTRUSTED',403);
  return dir;
 }catch(e){if(e.code==='ENOENT'&&!create)return null;throw e;}
}
async function load(ctx,filename='embedding-profile.json'){
 const dir=await directory(ctx);if(!dir)return null;
 const file=path.join(dir,filename);
 try{
  const st=await fs.lstat(file);
  if(!st.isFile()||st.isSymbolicLink()||st.size>MAX_BYTES||(process.platform!=='win32'&&(st.mode&0o077)))fail('F09B5_FILE_UNTRUSTED',403);
  const fh=await fs.open(file,C.O_RDONLY|(C.O_NOFOLLOW??0));
  try{
   const check=await fh.stat();
   if(check.ino!==st.ino||check.dev!==st.dev||check.size>MAX_BYTES)fail('F09B5_FILE_UNTRUSTED',403);
   const obj=JSON.parse(await fh.readFile('utf8'));
   if(obj?.version!==1||!plain(obj.profile)||typeof obj.credential!=='string')fail('F09B5_FILE_CORRUPT');
   validateProfile(obj.profile);
   if(LOCAL_SOURCES.includes(obj.profile.source))localEmbeddingEndpoint(obj.endpoint,obj.profile.source);
   else if(obj.endpoint!==undefined)fail('F09B5_FILE_CORRUPT');
   return obj;
  }finally{await fh.close();}
 }catch(e){if(e.code==='ENOENT')return null;if(e instanceof SyntaxError)fail('F09B5_FILE_CORRUPT');throw e;}
}
async function persist(ctx,data,filename='embedding-profile.json'){
 const dir=await directory(ctx,true),file=path.join(dir,filename);
 const payload=JSON.stringify(data);
 if(Buffer.byteLength(payload)>MAX_BYTES)fail('F09B5_FILE_TOO_LARGE',400);
 const temp=path.join(dir,`.embedding-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
 const fh=await fs.open(temp,'wx',0o600);
 try{await fh.writeFile(payload);await fh.sync();}finally{await fh.close();}
 try{
  const current=await fs.lstat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(current&&(!current.isFile()||current.isSymbolicLink()))fail('F09B5_FILE_UNTRUSTED',403);
  await fs.rename(temp,file);
  if(process.platform!=='win32')await fs.chmod(file,0o600);
  const dh=await fs.open(dir,'r');try{await dh.sync();}finally{await dh.close();}
 }catch(e){await fs.rm(temp,{force:true});throw e;}
}
async function exclusive(ctx,fn){
 const key=location(ctx),prior=mutexes.get(key)||Promise.resolve();
 let release;const pending=new Promise(r=>release=r);mutexes.set(key,pending);
 await prior;try{return await fn();}finally{release();if(mutexes.get(key)===pending)mutexes.delete(key);}
}
export function validateProfile(profile){
 if(!plain(profile)||!keys(profile,PROFILE_FIELDS))fail('F09B5_PROFILE_FIELDS_INVALID',400);
 if(!SOURCES.includes(profile.source)||typeof profile.model!=='string'||!profile.model.trim()||
  !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(profile.model))fail('F09B5_PROVIDER_MODEL_UNSUPPORTED',400);
 try{return canonicalEmbedding(profile);}catch{fail('F09B5_PROFILE_INVALID',400);}
}
export function describeProfile(data){
 return {configured:!!data,profile:data?.profile??null,hasCredential:!!data?.credential,
  endpoint:LOCAL_SOURCES.includes(data?.profile?.source)?data.endpoint:null,
  profileRevision:publicProfileRevision(data),
  connectionState:!data?'NOT_CONFIGURED':
   data.lastVerified?.revision===publicProfileRevision(data)&&Number.isSafeInteger(data.lastVerified.at)&&
   Date.now()-data.lastVerified.at>=0&&Date.now()-data.lastVerified.at<86400000?'VERIFIED':
   data.profile.source==='transformers'?'HOST_TEST_REQUIRED':
   (LOCAL_SOURCES.includes(data.profile.source)||data.credential)?'NOT_TESTED':'CREDENTIAL_REQUIRED',
  lastVerifiedAt:data?.lastVerified?.revision===publicProfileRevision(data)?data.lastVerified.at:null,
  providerSupported:!!data,serverManaged:true,productionWritesEnabled:false,
  supportedSources:SOURCES,storage:'HOST_USER_PRIVATE_FILE'};
}
export async function getEmbeddingProfile(ctx){return describeProfile(await load(ctx));}
export async function saveEmbeddingProfile(ctx,body){
 if(!plain(body)||!keys(body,CONFIG_FIELDS))fail('F09B5_FIELDS_FORBIDDEN',403);
 const profile=validateProfile({source:body.source,model:body.model,dimension:body.dimension,metric:body.metric});
 const endpoint=LOCAL_SOURCES.includes(profile.source)?localEmbeddingEndpoint(body.endpoint,profile.source):undefined;
 if(!LOCAL_SOURCES.includes(profile.source)&&body.endpoint!==undefined)fail('F09B5_ENDPOINT_FORBIDDEN',400);
 if(body.clearCredential!==undefined&&body.clearCredential!==true)fail('F09B5_CLEAR_INVALID',400);
 if(body.credential!==undefined&&(typeof body.credential!=='string'||body.credential.length>4096||/[\r\n\x00-\x1f]/.test(body.credential)))fail('F09B5_CREDENTIAL_INVALID',400);
 if(body.clearCredential&&body.credential)fail('F09B5_CREDENTIAL_CONFLICT',400);
 return exclusive(ctx,async()=>{
  const old=await load(ctx);
  // Reusing a credential for a different provider is prohibited.
  const credential=body.clearCredential?'':body.credential?.trim()||
   (old?.profile?.source===profile.source?old.credential:'');
  if(['transformers',...LOCAL_SOURCES].includes(profile.source)&&credential)fail('F09B5_LOCAL_CREDENTIAL_FORBIDDEN',400);
  const data={version:1,profile,credential,revision:randomBytes(16).toString('hex'),...(endpoint?{endpoint}:{})};
  await persist(ctx,data);
  return describeProfile(data);
 });
}
export async function deleteEmbeddingProfile(ctx){
 return exclusive(ctx,async()=>{
  const dir=await directory(ctx);if(!dir)return;
  const file=path.join(dir,'embedding-profile.json');
  const st=await fs.lstat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(st&&(!st.isFile()||st.isSymbolicLink()))fail('F09B5_FILE_UNTRUSTED',403);
  if(st)await fs.unlink(file);
 });
}
export async function recordVerifiedEmbeddingTest(ctx,expectedRevision){
 return exclusive(ctx,async()=>{
  const data=await load(ctx);
  if(!data||publicProfileRevision(data)!==expectedRevision)fail('F09B5_PROFILE_CHANGED_DURING_TEST',409);
  data.lastVerified={revision:expectedRevision,at:Date.now()};
  await persist(ctx,data);return describeProfile(data);
 });
}
export async function generateManagedEmbedding(ctx,identity,text,options={}){
 return generateM3ConfiguredEmbedding(await load(ctx),identity,text,options);
}
/** A staged profile is inert for normal M1 writes until a verified atomic cutover. */
export async function getStagedEmbeddingProfile(ctx){return describeProfile(await load(ctx,'staged-embedding-profile.json'));}
export async function saveStagedEmbeddingProfile(ctx,body){
 if(!plain(body)||!keys(body,CONFIG_FIELDS))fail('F09B5_FIELDS_FORBIDDEN',403);
 const profile=validateProfile({source:body.source,model:body.model,dimension:body.dimension,metric:body.metric});
 const endpoint=LOCAL_SOURCES.includes(profile.source)?localEmbeddingEndpoint(body.endpoint,profile.source):undefined;
 if(!LOCAL_SOURCES.includes(profile.source)&&body.endpoint!==undefined)fail('F09B5_ENDPOINT_FORBIDDEN',400);
 if(body.clearCredential!==undefined&&body.clearCredential!==true)fail('F09B5_CLEAR_INVALID',400);
 if(body.credential!==undefined&&(typeof body.credential!=='string'||body.credential.length>4096||/[\r\n\x00-\x1f]/.test(body.credential)))fail('F09B5_CREDENTIAL_INVALID',400);
 if(body.clearCredential&&body.credential)fail('F09B5_CREDENTIAL_CONFLICT',400);
 return exclusive(ctx,async()=>{
  const active=await load(ctx),previous=await load(ctx,'staged-embedding-profile.json');
  if(!active)fail('F09B5_ACTIVE_PROFILE_REQUIRED');
  if(JSON.stringify(active.profile)===JSON.stringify(profile))fail('F09B5_STAGED_PROFILE_NOT_DISTINCT');
  const credential=body.clearCredential?'':body.credential?.trim()||
   (previous?.profile?.source===profile.source?previous.credential:'');
  if(['transformers',...LOCAL_SOURCES].includes(profile.source)&&credential)fail('F09B5_LOCAL_CREDENTIAL_FORBIDDEN',400);
  await persist(ctx,{version:1,profile,credential,...(endpoint?{endpoint}:{})},'staged-embedding-profile.json');
  return describeProfile({profile,credential,...(endpoint?{endpoint}:{})});
 });
}
export async function readM3StagedProviderConfiguration(ctx){
 return load(ctx,'staged-embedding-profile.json');
}
export async function generateStagedEmbedding(ctx,identity,text,options={}){
 return generateM3ConfiguredEmbedding(await load(ctx,'staged-embedding-profile.json'),identity,text,options);
}
export async function generateM3ConfiguredEmbedding(data,identity,text,{fetchImpl=globalThis.fetch,hostEmbed,timeoutMs=15000}={}){
 if(!data)fail('F09B5_PROFILE_NOT_CONFIGURED',403);
 const profile=validateProfile(data.profile);
 if(!plain(identity)||JSON.stringify(profile)!==JSON.stringify(validateProfile(identity)))fail('F09B5_PROFILE_MISMATCH',409);
 if(typeof text!=='string'||text.length<1||text.length>10000)fail('F09B5_TEXT_LENGTH_INVALID',400);
 let vector;
 if(profile.source==='transformers'){
  if(typeof hostEmbed!=='function')fail('F09B5_HOST_EMBEDDER_MISSING',503);
  vector=await hostEmbed(profile.source,text,profile.model);
 }else{
  if(!LOCAL_SOURCES.includes(profile.source)&&!data.credential)fail('F09B5_CREDENTIAL_REQUIRED',403);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const destination=LOCAL_SOURCES.includes(profile.source)?localEmbeddingEndpoint(data.endpoint,profile.source):ENDPOINTS[profile.source];
   const response=await fetchImpl(destination,{
    method:'POST',redirect:'error',signal:controller.signal,
    headers:{'Content-Type':'application/json',...(LOCAL_SOURCES.includes(profile.source)?{}:{'Authorization':`Bearer ${data.credential}`})},
    body:JSON.stringify({model:profile.model,input:text})});
   if(!response?.ok)fail('F09B5_PROVIDER_REQUEST_FAILED',502);
   const size=Number(response.headers?.get?.('content-length'));
   if(Number.isFinite(size)&&size>1048576)fail('F09B5_RESPONSE_TOO_LARGE',502);
   // Cap body even if response lacks Content-Length.
   let bytes;
   if(response.body?.getReader){
    const reader=response.body.getReader();const chunks=[];let total=0;
    try{
     while(true){const {done,value}=await reader.read();if(done)break;
      total+=value.byteLength;if(total>1048576){await reader.cancel();fail('F09B5_RESPONSE_TOO_LARGE',502);}
      chunks.push(Buffer.from(value));
     }
    }finally{reader.releaseLock();}
    bytes=Buffer.concat(chunks,total);
   }else{
    bytes=Buffer.from(await response.arrayBuffer());
    if(bytes.byteLength>1048576)fail('F09B5_RESPONSE_TOO_LARGE',502);
   }
   const json=JSON.parse(Buffer.from(bytes).toString('utf8'));
   // Some servers return a model ID at the response root, in the data row,
   // or both. If present, *all* advertised IDs must match the pinned profile.
   // Other providers omit an ID: dimension verification is then the extent
   // of evidence, and the profile revision still fences future writes.
   for(const advertised of [json?.model,json?.data?.[0]?.model]){
    if(advertised!==undefined&&advertised!==null&&advertised!==profile.model)
     fail('F09B5_PROVIDER_MODEL_MISMATCH',409);
   }
   vector=profile.source==='ollama'?json?.embeddings?.[0]:json?.data?.[0]?.embedding;
  }catch(e){
   if(e?.code?.startsWith?.('F09B5_'))throw e;
   fail('F09B5_PROVIDER_REQUEST_FAILED',502);
  }finally{clearTimeout(timer);}
 }
 if(!Array.isArray(vector)||vector.length!==profile.dimension||!vector.every(x=>typeof x==='number'&&Number.isFinite(x)))
  fail('F09B5_VECTOR_DIMENSION_OR_VALUES_INVALID',409);
 return vector;
}
function err(res,e){return res.status(e?.status&&e.status>=400&&e.status<=599?e.status:409).json({success:false,code:/^F09B5_[A-Z0-9_]+$/.test(e?.code||'')?e.code:'F09B5_REFUSED',productionWritesEnabled:false});}
export function registerF09b5EmbeddingRoutes(router,options={}){
 router.get('/v2/embeddings/profile',async(req,res)=>{
  try{res.json({success:true,...await getEmbeddingProfile(req.s03)});}catch(e){err(res,e);}
 });
 router.get('/v2/embeddings/preflight',async(req,res)=>{
  try{
   const state=await getEmbeddingProfile(req.s03);
   res.json({success:true,...state,readyForProviderTest:['NOT_TESTED','HOST_TEST_REQUIRED'].includes(state.connectionState),
    remediation:!state.configured?'CONFIGURE_SERVER_EMBEDDING_PROFILE':state.connectionState==='CREDENTIAL_REQUIRED'?'SAVE_PROVIDER_CREDENTIAL':state.connectionState==='VERIFIED'?'NONE':'RUN_EMBEDDING_CONNECTION_TEST',
    sourceBoundCollectionVerified:false,productionWritesEnabled:false});
  }catch(e){err(res,e);}
 });
 router.put('/v2/embeddings/profile',async(req,res)=>{
  try{validateGuiMutationRequest(req);res.json({success:true,...await saveEmbeddingProfile(req.s03,req.body)});}catch(e){err(res,e);}
 });
 router.delete('/v2/embeddings/profile',async(req,res)=>{
  try{validateGuiMutationRequest(req);await deleteEmbeddingProfile(req.s03);res.json({success:true,...describeProfile(null)});}catch(e){err(res,e);}
 });
 router.get('/v2/embeddings/staged-profile',async(req,res)=>{
  try{res.json({success:true,...await getStagedEmbeddingProfile(req.s03)});}catch(e){err(res,e);}
 });
 router.put('/v2/embeddings/staged-profile',async(req,res)=>{
  try{validateGuiMutationRequest(req);res.json({success:true,...await saveStagedEmbeddingProfile(req.s03,req.body)});}catch(e){err(res,e);}
 });
 router.post('/v2/embeddings/test',async(req,res)=>{
  try{
   validateGuiMutationRequest(req);
   if(!plain(req.body)||Object.keys(req.body).length!==0)fail('F09B5_TEST_BODY_FORBIDDEN',403);
   const result=await getEmbeddingProfile(req.s03);
   if(!result.configured)fail('F09B5_PROFILE_NOT_CONFIGURED',403);
   await generateManagedEmbedding(req.s03,result.profile,'VectHare embedding connection test',
    {...options,hostEmbed:options.hostEmbed?((s,t,m)=>options.hostEmbed(req,s,t,m)):undefined});
   const verified=await recordVerifiedEmbeddingTest(req.s03,result.profileRevision);
   res.json({success:true,status:'VECTOR_DIMENSION_VERIFIED',profile:result.profile,profileRevision:verified.profileRevision,dimension:result.profile.dimension,
    sourceConfigured:true,collectionMatchNotProven:true,productionWritesEnabled:false});
  }catch(e){err(res,e);}
 });
}
