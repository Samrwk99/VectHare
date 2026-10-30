/** F09b.5 — server-owned embedding profile and write-only credential GUI.
 * Profile configuration never grants production vector write permission.
 */
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
const ROOT='/api/plugins/similharity/v2/embeddings';
const LOCAL_SOURCES=['llama_cpp','ollama','vllm','koboldcpp'];
const SOURCES=['transformers',...LOCAL_SOURCES,'openai','togetherai','mistral','openrouter'];
async function verified(url,options,fetchImpl){
 const r=await guardedVectorFetch(url,{credentials:'same-origin',cache:'no-store',...options},fetchImpl);
 let result;try{result=await r.json();}catch{throw Error('F09B5_INVALID_RESPONSE');}
 if(!r.ok||result?.success!==true)throw Error(/^F09B5_[A-Z0-9_]+$/.test(result?.code||'')?result.code:'F09B5_SERVER_REFUSED');
 return result;
}
export function getEmbeddingProfile(headers={},fetchImpl=globalThis.fetch){
 return verified(`${ROOT}/profile`,{method:'GET',headers},fetchImpl);
}
export function preflightEmbeddingProfile(headers={},fetchImpl=globalThis.fetch){
 return verified(`${ROOT}/preflight`,{method:'GET',headers},fetchImpl);
}
export function saveEmbeddingProfile(body,headers={},fetchImpl=globalThis.fetch){
 if(!body||!SOURCES.includes(body.source)||typeof body.model!=='string'||
  !Number.isSafeInteger(body.dimension)||body.dimension<1||body.dimension>65536||
  !['cosine','dot','euclid'].includes(body.metric)||
  Object.keys(body).some(k=>!['source','model','dimension','metric','endpoint','credential','clearCredential'].includes(k)))
  throw Error('F09B5_INVALID_PROFILE');
 if(LOCAL_SOURCES.includes(body.source)&&!new RegExp(`^http://127\\.0\\.0\\.1:[0-9]{1,5}/${body.source==='ollama'?'api/embed':'v1/embeddings'}$`).test(body.endpoint||''))
  throw Error('F09B5_LOCAL_ENDPOINT_REQUIRED');
 if(!LOCAL_SOURCES.includes(body.source)&&body.endpoint!==undefined)throw Error('F09B5_ENDPOINT_FORBIDDEN');
 return verified(`${ROOT}/profile`,{method:'PUT',headers:{...headers,'Content-Type':'application/json','X-VectHare-Configuration':'1'},body:JSON.stringify(body)},fetchImpl);
}
export function deleteEmbeddingProfile(headers={},fetchImpl=globalThis.fetch){
 return verified(`${ROOT}/profile`,{method:'DELETE',headers:{...headers,'X-VectHare-Configuration':'1'}},fetchImpl);
}
export function testEmbeddingProfile(headers={},fetchImpl=globalThis.fetch){
 return verified(`${ROOT}/test`,{method:'POST',headers:{...headers,'Content-Type':'application/json','X-VectHare-Configuration':'1'},body:'{}'},fetchImpl);
}
export function renderF09b5EmbeddingGui(root,getSettings,persist,getHeaders,doc=globalThis.document){
 if(!root||!doc?.createElement||root.querySelector?.('#vecthare_f09b5_embeddings'))return false;
 const panel=doc.createElement('section');panel.id='vecthare_f09b5_embeddings';
 const heading=doc.createElement('h4');heading.textContent='F09b.5 — server-managed embeddings';
 const note=doc.createElement('p');note.textContent='P03: Configure your authenticated, server-owned embedding profile here. Local providers (llama.cpp, Ollama, vLLM, KoboldCpp) must run on the plugin host; configure the exact 127.0.0.1 port. This does not enable or certify vector writes.';
 const settings=getSettings?.()||{};
 const source=doc.createElement('select');for(const name of SOURCES){const opt=doc.createElement('option');opt.value=name;opt.textContent=name;source.append(opt);}
 source.value=SOURCES.includes(settings.f09b_embedding_source)?settings.f09b_embedding_source:'transformers';
 const model=doc.createElement('input');model.type='text';model.placeholder='Exact server embedding model';model.value=settings.f09b_embedding_model||'';
 const dimension=doc.createElement('input');dimension.type='number';dimension.min='1';dimension.max='65536';dimension.value=settings.f09b_embedding_dimension||'';
 const metric=doc.createElement('select');for(const name of ['cosine','dot','euclid']){const opt=doc.createElement('option');opt.value=name;opt.textContent=name;metric.append(opt);}metric.value=settings.f09b_embedding_metric||'cosine';
 const endpoint=doc.createElement('input');endpoint.type='url';endpoint.placeholder='http://127.0.0.1:8081/v1/embeddings (Ollama: /api/embed)';endpoint.value='';
 const secret=doc.createElement('input');secret.type='password';secret.autocomplete='new-password';secret.placeholder='API key (write-only; leave blank to retain)';
 const clear=doc.createElement('input');clear.type='checkbox';const clearLabel=doc.createElement('label');clearLabel.textContent='Clear saved API key';clearLabel.append(clear);
 const status=doc.createElement('div');status.setAttribute('role','status');status.textContent='Read server profile status before applying pilots.';
 const btn=(label,fn)=>{const b=doc.createElement('button');b.type='button';b.textContent=label;b.addEventListener('click',async()=>{b.disabled=true;try{await fn();}catch(e){status.textContent=`F09b.5 refused: ${e.message}`;}finally{b.disabled=false;}});return b;};
 const syncProviderInputs=()=>{endpoint.disabled=!LOCAL_SOURCES.includes(source.value);secret.disabled=['transformers',...LOCAL_SOURCES].includes(source.value);};
 const apply=profile=>{
  if(!profile)return;
  Object.assign(getSettings(),{f09b_embedding_source:profile.source,f09b_embedding_model:profile.model,
   f09b_embedding_dimension:profile.dimension,f09b_embedding_metric:profile.metric});persist?.();
  source.value=profile.source;model.value=profile.model;dimension.value=String(profile.dimension);metric.value=profile.metric;syncProviderInputs();
 };
 const headers=()=>getHeaders?.()||{};
 const refresh=async()=>{const data=await preflightEmbeddingProfile(headers());if(data.configured){apply(data.profile);endpoint.value=data.endpoint||'';}
  status.textContent=data.configured?`Server profile: ${data.profile.source} / ${data.profile.model} / ${data.profile.dimension} dimensions; ${data.connectionState}. Revision ${data.profileRevision?.slice(0,12)}. Test provider before vectorization; collection ownership still requires verification.`:'No server-managed embedding profile. Set up and test one here before trying Vectorize.';};
 const load=btn('Load server embedding profile',refresh);
 const save=btn('Save server embedding profile',async()=>{
  const body={source:source.value,model:model.value.trim(),dimension:Number(dimension.value),metric:metric.value};
  if(LOCAL_SOURCES.includes(source.value))body.endpoint=endpoint.value.trim();
  if(secret.value)body.credential=secret.value;
  if(clear.checked)body.clearCredential=true;
  if(!globalThis.confirm?.('Save this server-owned embedding profile? Changing the model or dimensions may require a new owned vector collection. Credentials remain on the server.')){status.textContent='Profile setup cancelled.';return;}
  const data=await saveEmbeddingProfile(body,headers());secret.value='';clear.checked=false;apply(data.profile);
  status.textContent=`Server profile saved; API credential ${data.hasCredential?'configured':'not configured'}. This is not collection certification or mutation permission.`;
 });
 const test=btn('Test server embedding (provider request)',async()=>{
  status.textContent='Sending a fixed test sentence to the configured server provider…';
  const data=await testEmbeddingProfile(headers());
  status.textContent=`Server embedding verified: ${data.dimension} dimensions. F03 collection match and live backend writes remain unverified.`;
 });
 const remove=btn('Remove server embedding profile and key',async()=>{
  if(!globalThis.confirm?.('Remove your server embedding profile? This stops future managed embedding until you configure another profile.'))return;
  await deleteEmbeddingProfile(headers());status.textContent='Server embedding profile and credential removed. Existing collections were not touched.';
 });
 source.addEventListener('change',syncProviderInputs);
 syncProviderInputs();
 panel.append(heading,note,source,model,dimension,metric,endpoint,secret,clearLabel,load,save,test,remove,status);
 root.prepend(panel);void refresh().catch(()=>{status.textContent='Embedding profile unavailable; check plugin compatibility and server connection.';});return true;
}
