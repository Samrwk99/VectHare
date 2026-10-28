/** F09b opt-in settings. Only nonsecret embedding identity/profile data is saved.
 * Setting a checkbox does NOT grant a server write capability.
 */
export function renderF09bV2Controls(root,getSettings,persist,doc=globalThis.document){
 if(!root||!doc?.createElement||root.querySelector?.('#vecthare_f09b_v2_controls'))return false;
 const panel=doc.createElement('section');panel.id='vecthare_f09b_v2_controls';
 const title=doc.createElement('h4');title.textContent='F09b — verified v2 chat-memory retrieval and prompt injection';
 const info=doc.createElement('p');info.textContent='Opt-in for newly provisioned, source-owned v2 collections. WebLLM-only text embeddings for this checkpoint. Never writes vectors; no legacy collection fallback. Prompt registration is not proof of final model inclusion.';
 const settings=getSettings?.()||{};
 const enabled=doc.createElement('input');enabled.type='checkbox';enabled.checked=settings.f09b_v2_prompt_enabled===true;
 const label=doc.createElement('label');label.textContent='Use verified v2 retrieval during generation';label.append(enabled);
 const backend=doc.createElement('select');for(const name of ['qdrant','lancedb','vectra','milvus']){
  const opt=doc.createElement('option');opt.value=name;opt.textContent=name;backend.append(opt);
 }backend.value=settings.f09b_backend||'qdrant';
 const model=doc.createElement('input');model.type='text';model.placeholder='Exact F03 collection embedding model';model.value=settings.f09b_embedding_model||'';
 const dimension=doc.createElement('input');dimension.type='number';dimension.min='1';dimension.max='65536';dimension.value=settings.f09b_embedding_dimension||'';
 const metric=doc.createElement('select');for(const name of ['cosine','dot','euclid']){
  const opt=doc.createElement('option');opt.value=name;opt.textContent=name;metric.append(opt);
 }metric.value=settings.f09b_embedding_metric||'cosine';
 const save=doc.createElement('button');save.type='button';save.textContent='Save verified v2 retrieval settings';
 const status=doc.createElement('div');status.setAttribute('role','status');
 save.addEventListener('click',()=>{
  try{
   const profile=getSettings();const dim=Number(dimension.value);
   if(enabled.checked && (profile.source!=='webllm'||!profile.webllm_model||profile.webllm_model!==model.value.trim()||!model.value.trim()||!Number.isSafeInteger(dim)||dim<1||dim>65536))
    throw Error('F09b currently requires WebLLM and a valid matching collection model/dimension');
   Object.assign(profile,{f09b_v2_prompt_enabled:enabled.checked,f09b_backend:backend.value,
    f09b_embedding_model:model.value.trim(),f09b_embedding_dimension:dim,
    f09b_embedding_metric:metric.value});
   persist?.();status.textContent=enabled.checked?'F09b v2 retrieval enabled; writes remain blocked.':'F09b v2 retrieval disabled.';
  }catch(error){status.textContent=`F09b not enabled: ${error.message}`;}
 });
 panel.append(title,info,label,backend,model,dimension,metric,save,status);root.prepend(panel);return true;
}
