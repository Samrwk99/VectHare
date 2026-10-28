/** S11.4: authenticated GUI connection management; write-only secrets.
 * This is configuration, not permission to write vectors. The plugin will
 * persist credentials in a private per-user server file; none are returned.
 */
import { guardedVectorFetch } from './e02-vector-request-gateway.js';
const ROOT='/api/plugins/similharity/v2/connections';
const VALID_BACKENDS=new Set(['qdrant','milvus']);
function route(backend,configId){
  if(!VALID_BACKENDS.has(backend))throw Error('Unsupported database');
  if(!['default','local'].includes(configId))throw Error('Invalid database profile');
  if(backend==='milvus'&&configId!=='default')throw Error('Milvus profile invalid');
  return `${ROOT}/${backend}`;
}
async function checked(response){
  let data=null;try{data=await response.json();}catch{}
  if(!response.ok||data?.success!==true){
    const code=typeof data?.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(data.code)?data.code:`HTTP_${response.status}`;
    throw Error(`Database configuration failed (${code})`);
  }
  return data;
}
export async function getGuiConnectionStatus(backend,configId,headers,fetchImpl=globalThis.fetch){
  const path=route(backend,configId);
  return checked(await guardedVectorFetch(`${path}?configId=${configId}`,{method:'GET',headers,credentials:'same-origin',cache:'no-store'},fetchImpl));
}
export async function saveGuiConnection(backend,config,headers,fetchImpl=globalThis.fetch){
  const path=route(backend,config?.configId);
  return checked(await guardedVectorFetch(path,{method:'PUT',headers:{...headers,'X-VectHare-Configuration':'1'},credentials:'same-origin',cache:'no-store',body:JSON.stringify(config)},fetchImpl));
}
export async function removeGuiConnection(backend,configId,headers,fetchImpl=globalThis.fetch){
  const path=route(backend,configId);
  return checked(await guardedVectorFetch(`${path}?configId=${configId}`,{method:'DELETE',headers:{...headers,'X-VectHare-Configuration':'1'},credentials:'same-origin',cache:'no-store'},fetchImpl));
}

/** Verify the exact server-saved profile using the plugin's health endpoint. */
export async function testGuiConnection(backend,configId,headers,fetchImpl=globalThis.fetch){
  route(backend,configId);
  const prefix='/api/plugins/similharity';
  const response=await guardedVectorFetch(`${prefix}/backend/init/${backend}`,{
    method:'POST',headers,credentials:'same-origin',body:JSON.stringify({configId})},fetchImpl);
  if(!response.ok){
    const data=typeof response.json==='function'?await response.json().catch(()=>null):null;
    const code=typeof data?.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(data.code)?data.code:`HTTP_${response.status}`;
    throw Error(`Backend init refused (HTTP ${response.status}; ${code})`);
  }
  const health=await guardedVectorFetch(`${prefix}/backend/health/${backend}?configId=${configId}`,{
    method:'GET',headers,credentials:'same-origin'},fetchImpl);
  if(!health.ok)throw Error(`Backend health failed (HTTP ${health.status})`);
  const data=await health.json();
  if(data.healthy!==true)throw Error('Backend did not report healthy');
  return true;
}
