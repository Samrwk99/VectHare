/** F09b.5 — server-owned embedding profile and write-only credential GUI.
 * Profile configuration never grants production vector write permission.
 */
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
const ROOT='/api/plugins/similharity/v2/embeddings';
const SOURCES=['transformers','openai','togetherai','mistral','openrouter'];
async function verified(url,options,fetchImpl){
 const r=await guardedVectorFetch(url,{credentials:'same-origin',cache:'no-store',...options},fetchImpl);
 let result;try{result=await r.json();}catch{throw Error('F09B5_INVALID_RESPONSE');}
 if(!r.ok||result?.success!==true)throw Error(/^F09B5_[A-Z0-9_]+$/.test(result?.code||'')?result.code:'F09B5_SERVER_REFUSED');
 return result;
}
export function getEmbeddingProfile(headers={},fetchImpl=globalThis.fetch){
 return verified(`${ROOT}/profile`,{method:'GET',headers},fetchImpl);
}
export function saveEmbeddingProfile(body,headers={},fetchImpl=globalThis.fetch){
 if(!body||!SOURCES.includes(body.source)||typeof body.model!=='string'||
  !Number.isSafeInteger(body.dimension)||body.dimension<1||body.dimension>65536||
  !['cosine','dot','euclid'].includes(body.metric)||
  Object.keys(body).some(k=>!['source','model','dimension','metric','credential','clearCredential'].includes(k)))
  throw Error('F09B5_INVALID_PROFILE');
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
 const note=doc.createElement('p');note.textContent='M0: Embedding connection profiles and credentials are configured by the server administrator, not by this browser. Read or test the existing profile here. This does not enable production writes.';
 const settings=getSettings?.()||{};
 const source=doc.createElement('select');for(const name of SOURCES){const opt=doc.createElement('option');opt.value=name;opt.textContent=name;source.append(opt);}
 source.value=SOURCES.includes(settings.f09b_embedding_source)?settings.f09b_embedding_source:'transformers';
 const model=doc.createElement('input');model.type='text';model.placeholder='Exact server embedding model';model.value=settings.f09b_embedding_model||'';
 const dimension=doc.createElement('input');dimension.type='number';dimension.min='1';dimension.max='65536';dimension.value=settings.f09b_embedding_dimension||'';
 const metric=doc.createElement('select');for(const name of ['cosine','dot','euclid']){const opt=doc.createElement('option');opt.value=name;opt.textContent=name;metric.append(opt);}metric.value=settings.f09b_embedding_metric||'cosine';
 const secret=doc.createElement('input');secret.type='password';secret.autocomplete='new-password';secret.placeholder='API key (write-only; leave blank to retain)';
 const clear=doc.createElement('input');clear.type='checkbox';const clearLabel=doc.createElement('label');clearLabel.textContent='Clear saved API key';clearLabel.append(clear);
 const status=doc.createElement('div');status.setAttribute('role','status');status.textContent='Read server profile status before applying pilots.';
 const btn=(label,fn)=>{const b=doc.createElement('button');b.type='button';b.textContent=label;b.addEventListener('click',async()=>{b.disabled=true;try{await fn();}catch(e){status.textContent=`F09b.5 refused: ${e.message}`;}finally{b.disabled=false;}});return b;};
 const apply=profile=>{
  if(!profile)return;
  Object.assign(getSettings(),{f09b_embedding_source:profile.source,f09b_embedding_model:profile.model,
   f09b_embedding_dimension:profile.dimension,f09b_embedding_metric:profile.metric});persist?.();
  source.value=profile.source;model.value=profile.model;dimension.value=String(profile.dimension);metric.value=profile.metric;
 };
 const headers=()=>getHeaders?.()||{};
 const refresh=async()=>{const data=await getEmbeddingProfile(headers());if(data.configured)apply(data.profile);
  status.textContent=data.configured?`Server profile: ${data.profile.source} / ${data.profile.model} / ${data.profile.dimension} dimensions; credential ${data.hasCredential?'saved':'not saved'}. F03 collection match still needs verification.`:'No server-managed embedding profile configured.';};
 const load=btn('Load server embedding profile',refresh);
 const save=btn('Save server embedding profile',async()=>{
  const body={source:source.value,model:model.value.trim(),dimension:Number(dimension.value),metric:metric.value};
  if(secret.value)body.credential=secret.value;
  if(clear.checked)body.clearCredential=true;
  const data=await saveEmbeddingProfile(body,headers());secret.value='';clear.checked=false;apply(data.profile);
  status.textContent=`Server profile saved; API credential ${data.hasCredential?'configured':'not configured'}. This is not collection certification or mutation permission.`;
 });
 const test=btn('Test server embedding (provider request)',async()=>{
  status.textContent='Sending a fixed test sentence to the configured server provider…';
  const data=await testEmbeddingProfile(headers());
  status.textContent=`Server embedding verified: ${data.dimension} dimensions. F03 collection match and live backend writes remain unverified.`;
 });
 const remove=btn('Remove server embedding profile and key',async()=>{
  await deleteEmbeddingProfile(headers());status.textContent='Server embedding profile and credential removed. Existing collections were not touched.';
 });
 // M0 D6: avoid presenting nonfunctional secret-edit controls.
 for(const el of [source,model,dimension,metric,secret,clear,save,remove])el.disabled=true;
 save.textContent='Admin-managed profile (read-only)';
 remove.textContent='Admin-managed credentials (read-only)';
 panel.append(heading,note,source,model,dimension,metric,secret,clearLabel,load,save,test,remove,status);
 root.prepend(panel);void refresh().catch(()=>{status.textContent='Embedding profile unavailable; check plugin compatibility and server connection.';});return true;
}
