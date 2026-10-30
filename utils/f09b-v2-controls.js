/** F09b opt-in settings. Only nonsecret embedding identity/profile data is saved.
 * Setting a checkbox does NOT grant a server write capability.
 */
export function renderF09bV2Controls(root,getSettings,persist,doc=globalThis.document){
 if(!root||!doc?.createElement||root.querySelector?.('#vecthare_f09b_v2_controls'))return false;
 const panel=doc.createElement('section');panel.id='vecthare_f09b_v2_controls';
 const title=doc.createElement('h4');title.textContent='F09b — verified v2 chat-memory retrieval and prompt injection';
 const info=doc.createElement('p');info.textContent='Opt-in for newly provisioned, source-owned v2 collections. Queries use the server-managed embedding profile and source-selected identity; configure and test the server profile first. Never writes vectors; no legacy collection fallback. Prompt registration is not proof of final model inclusion.';
 const settings=getSettings?.()||{};
 const enabled=doc.createElement('input');enabled.type='checkbox';enabled.checked=settings.f09b_v2_prompt_enabled===true;
 const label=doc.createElement('label');label.textContent='Use verified v2 retrieval during generation';label.append(enabled);
 const backend=doc.createElement('select');for(const name of ['qdrant','lancedb','vectra','milvus']){
  const opt=doc.createElement('option');opt.value=name;opt.textContent=name;backend.append(opt);
 }backend.value=settings.f09b_backend||'qdrant';
 const save=doc.createElement('button');save.type='button';save.textContent='Save verified v2 retrieval settings';
 const status=doc.createElement('div');status.setAttribute('role','status');
 save.addEventListener('click',()=>{
  try{
   const profile=getSettings();
   if(enabled.checked && !['qdrant','lancedb','vectra','milvus'].includes(backend.value))
    throw Error('Select a supported managed database backend');
   Object.assign(profile,{f09b_v2_prompt_enabled:enabled.checked,f09b_backend:backend.value});
   persist?.();status.textContent=enabled.checked?'F09b v2 retrieval enabled; writes remain blocked.':'F09b v2 retrieval disabled.';
  }catch(error){status.textContent=`F09b not enabled: ${error.message}`;}
 });
 panel.append(title,info,label,backend,save,status);root.prepend(panel);return true;
}
