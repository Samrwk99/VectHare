/** GUI-backed connections for an authenticated SillyTavern user.
 * These are SERVER-side files under the authenticated user's private data root.
 * Passwords/tokens never appear in GET responses, URLs, diagnostics, or logs.
 * Ordinary vector records and all public mutation gates remain untouched.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants as C } from 'node:fs';
import { AccessError } from './s03-security.js';

const FILENAME='connections.json';
const MAX_BYTES=8192;
const LOCAL_HOSTS=new Set(['127.0.0.1','localhost','[::1]']);
function own(o,k){return Object.hasOwn(o,k);}
function fail(code,status=400){throw new AccessError(code,code,status);}
function requirePlain(x){if(!x||typeof x!=='object'||Array.isArray(x))fail('GUI_CONFIG_INVALID');return x;}
function validatePort(value){const n=Number(value);if(!Number.isInteger(n)||n<1||n>65535)fail('GUI_PORT_INVALID');return n;}
function localQdrant(body){
  requirePlain(body);
  if(Object.keys(body).some(k=>!['configId','host','port'].includes(k)))fail('GUI_LOCAL_FIELDS_INVALID');
  if(body.configId!=='local')fail('GUI_SELECTOR_INVALID');
  const host=body.host??'127.0.0.1';
  if(typeof host!=='string'||!LOCAL_HOSTS.has(host))fail('GUI_LOCAL_HOST_RESTRICTED');
  const port=validatePort(body.port??6333);
  const url=`http://${host}:${port}`;
  return {url};
}
function remoteQdrant(body){
  requirePlain(body);
  if(Object.keys(body).some(k=>!['configId','url','apiKey'].includes(k))||body.configId!=='default')fail('GUI_REMOTE_FIELDS_INVALID');
  let u;try{u=new URL(body.url);}catch{fail('GUI_REMOTE_URL_INVALID');}
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash|| !['','/'].includes(u.pathname))fail('GUI_REMOTE_URL_INVALID');
  const host=u.hostname.toLowerCase();
  if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||
     host==='[::1]'||host==='169.254.169.254'||host==='metadata.google.internal'||
     /^\d+\.\d+\.\d+\.\d+$/.test(host)||host.startsWith('['))fail('GUI_REMOTE_HOST_RESTRICTED');
  if(!/^[a-z0-9][a-z0-9.-]{0,252}$/.test(host))fail('GUI_REMOTE_URL_INVALID');
  if(body.apiKey!==undefined && (typeof body.apiKey!=='string'||body.apiKey.length>4096))fail('GUI_REMOTE_CREDENTIAL_INVALID');
  return {url:u.origin,...(body.apiKey?{apiKey:body.apiKey}:{})};
}
function milvusConfig(body){
  requirePlain(body);
  if(Object.keys(body).some(k=>!['configId','address','ssl','token'].includes(k))||body.configId!=='default')fail('GUI_MILVUS_FIELDS_INVALID');
  if(typeof body.address!=='string'||!/^([a-zA-Z0-9_.-]+):([0-9]{1,5})$/.test(body.address))fail('GUI_MILVUS_ADDRESS_INVALID');
  const host=body.address.slice(0,body.address.lastIndexOf(':'));
  validatePort(body.address.slice(body.address.lastIndexOf(':')+1));
  if(!LOCAL_HOSTS.has(host) && body.ssl!==true)fail('GUI_MILVUS_TLS_REQUIRED');
  if(!LOCAL_HOSTS.has(host) && (/^(?:\d+\.){3}\d+$/.test(host)||host.endsWith('.local')||host.endsWith('.internal')))fail('GUI_MILVUS_HOST_RESTRICTED');
  if(body.token!==undefined&&(typeof body.token!=='string'||body.token.length>4096))fail('GUI_REMOTE_CREDENTIAL_INVALID');
  return {address:body.address,ssl:body.ssl===true,...(body.token?{token:body.token}:{})};
}
export function validateGuiConnection(backend,body){
  if(backend==='qdrant')return body?.configId==='local'?localQdrant(body):remoteQdrant(body);
  if(backend==='milvus')return milvusConfig(body);
  fail('GUI_BACKEND_UNSUPPORTED');
}
export function scopeConfigKey(backend,configId){
  if(backend==='qdrant'&&['local','default'].includes(configId))return `${backend}:${configId}`;
  if(backend==='milvus'&&configId==='default')return `${backend}:${configId}`;
  fail('GUI_SELECTOR_INVALID');
}
function configDir(context){
  if(typeof context?.vectorsPath!=='string'||!path.isAbsolute(context.vectorsPath))fail('GUI_HOST_IDENTITY_REQUIRED',403);
  // authenticatedContext already confirms vectorsPath equals a host-authorized child.
  return path.join(path.dirname(context.vectorsPath),'.similharity-private');
}
async function ensureDir(context,create){
  const directory=configDir(context);
  try{
    if(create){try{await fs.mkdir(directory,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}}
    const st=await fs.lstat(directory);
    if(!st.isDirectory()||st.isSymbolicLink()||(process.platform!=='win32'&&(st.mode&0o077)))fail('GUI_CONFIG_DIRECTORY_UNTRUSTED',403);
  }catch(e){if(e.code==='ENOENT'&&!create)return null;throw e;}
  return directory;
}
async function readFile(context){
  const dir=await ensureDir(context,false);if(!dir)return {};
  const file=path.join(dir,FILENAME);
  try{
    const stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_BYTES||(process.platform!=='win32'&&(stat.mode&0o077)))fail('GUI_CONFIG_FILE_UNTRUSTED',403);
    const handle=await fs.open(file,C.O_RDONLY|(C.O_NOFOLLOW??0));
    try{
      const check=await handle.stat();
      if(!check.isFile()||check.ino!==stat.ino||check.dev!==stat.dev||check.size>MAX_BYTES)fail('GUI_CONFIG_FILE_UNTRUSTED',403);
      const data=JSON.parse(await handle.readFile('utf8'));
      if(data.schemaVersion!==1||!data.connections||typeof data.connections!=='object'||Array.isArray(data.connections))fail('GUI_CONFIG_CORRUPT',409);
      return data.connections;
    }finally{await handle.close();}
  }catch(e){if(e.code==='ENOENT')return {};if(e instanceof SyntaxError)fail('GUI_CONFIG_CORRUPT',409);throw e;}
}
const LOCKS=new Map();
async function exclusive(context,fn){
  const key=configDir(context);const prior=LOCKS.get(key)||Promise.resolve();
  let release;const current=new Promise(resolve=>{release=resolve;});LOCKS.set(key,current);
  await prior;try{return await fn();}finally{release();if(LOCKS.get(key)===current)LOCKS.delete(key);}
}
async function writeFile(context,data){
  const dir=await ensureDir(context,true);const filename=path.join(dir,FILENAME);
  const bytes=JSON.stringify({schemaVersion:1,connections:data});
  if(Buffer.byteLength(bytes)>MAX_BYTES)fail('GUI_CONFIG_TOO_LARGE');
  // Atomic replace; same-process writes serialized. Filesystem-level security
  // depends on authenticated SillyTavern per-user directories and host OS ACLs.
  const temporary=path.join(dir,`.connection-${process.pid}-${(await import('node:crypto')).randomBytes(8).toString('hex')}.tmp`);
  const fd=await fs.open(temporary,'wx',0o600);
  try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}
  try{await fs.rename(temporary,filename);if(process.platform!=='win32')await fs.chmod(filename,0o600);}
  catch(e){await fs.rm(temporary,{force:true});throw e;}
}
export async function getGuiConnection(context,backend,configId){
  const key=scopeConfigKey(backend,configId);return (await readFile(context))[key]??null;
}
export async function setGuiConnection(context,backend,body){
  const key=scopeConfigKey(backend,body?.configId);const value=validateGuiConnection(backend,body);
  await exclusive(context,async()=>{
    const all=await readFile(context);
    // An empty credential field means retain a previously saved key; omission
    // is never treated as permission to clear an existing credential.
    const prior=all[key];
    if(prior&&(backend==='qdrant'||backend==='milvus')){
      const field=backend==='qdrant'?'apiKey':'token';
      if(!own(value,field)&&prior[field]&&
          (backend==='qdrant'?prior.url===value.url:prior.address===value.address))value[field]=prior[field];
    }
    await writeFile(context,{...all,[key]:value});
  });
  return describeConnection(backend,body.configId,value);
}
export async function deleteGuiConnection(context,backend,configId){
  const key=scopeConfigKey(backend,configId);
  await exclusive(context,async()=>{const all=await readFile(context);delete all[key];await writeFile(context,all);});
}
export function describeConnection(backend,configId,value){
  return {backend,configId,configured:!!value,
    ...(value?{endpoint:backend==='qdrant'?value.url:value.address,hasCredential:Boolean(value.apiKey||value.token)}:{})};
}
export function validateGuiMutationRequest(req){
  const site=String(req.headers?.['sec-fetch-site']||'');
  if(site && !['same-origin','none'].includes(site))fail('GUI_ORIGIN_REJECTED',403);
  const origin=req.headers?.origin;
  if(origin){
    const host=req.get?.('host')||req.headers?.host;
    if(!host||!['http','https'].some(s=>origin===`${s}://${host}`))fail('GUI_ORIGIN_REJECTED',403);
  }
  if(req.get?.('x-vecthare-configuration')!=='1'&&req.headers?.['x-vecthare-configuration']!=='1')fail('GUI_CONFIG_HEADER_REQUIRED',403);
}
export function registerGuiConnectionRoutes(router,{backendPool}){
  const err=(res,e)=>res.status(e.status||500).json({success:false,code:e.code||'GUI_CONFIG_FAILURE'});
  router.get('/v2/connections/:backend',async(req,res)=>{
    try{
      const b=req.params.backend,c=req.query?.configId??'local';
      const value=await getGuiConnection(req.s03,b,c);
      res.json({success:true,...describeConnection(b,c,value),localDefault:b==='qdrant'&&c==='local'&&!value});
    }catch(e){err(res,e);}
  });
  router.put('/v2/connections/:backend',async(req,res)=>{
    try{
      validateGuiMutationRequest(req);
      const b=req.params.backend;
      const result=await setGuiConnection(req.s03,b,req.body);
      backendPool.clear();
      res.json({success:true,...result,writesEnabled:false});
    }catch(e){err(res,e);}
  });
  router.delete('/v2/connections/:backend',async(req,res)=>{
    try{
      validateGuiMutationRequest(req);
      const b=req.params.backend,c=req.query?.configId??'local';
      await deleteGuiConnection(req.s03,b,c);backendPool.clear();
      res.json({success:true,backend:b,configId:c,writesEnabled:false});
    }catch(e){err(res,e);}
  });
}
