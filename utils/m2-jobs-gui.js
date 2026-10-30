/** M2 saved-source batch jobs. Exact source selectors and UUIDs only;
 * the plugin derives text, ownership, embedding and target collection.
 */
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
import {f02CurrentChatSelector} from './f02-public-read-client.js';
import {m1Preview} from './m1-record-gui.js';
const ROOT='/api/plugins/similharity/v2/m2/jobs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function request(path,body,headers={},fetchImpl=globalThis.fetch){
 const r=await guardedVectorFetch(ROOT+path,{method:body===undefined?'GET':'POST',
  credentials:'same-origin',cache:'no-store',headers:{...headers,...(body===undefined?{}:{'Content-Type':'application/json'})},
  ...(body===undefined?{}:{body:JSON.stringify(body)})},fetchImpl);
 let data;try{data=await r.json();}catch{throw Error('M2_INVALID_SERVER_RESPONSE');}
 if(!r.ok||data?.success!==true)throw Error(data?.code||'M2_REQUEST_REFUSED');return data;
}
export async function m2Preview(intent,headers={},fetchImpl=globalThis.fetch){
 const r=await request('/preview',intent,headers,fetchImpl);
 if(!r.logicalKey||!Array.isArray(r.items)||r.items.length>80||r.counts?.eligible!==r.items.length)throw Error('M2_INVALID_PREVIEW');
 return r;
}
export async function m2Create(intent,headers={},fetchImpl=globalThis.fetch){
 const r=await request('/create',{intent,confirmation:'CREATE BOUNDED SAVED-SOURCE JOB'},headers,fetchImpl);
 if(!UUID.test(r.jobId??'')||r.state!=='PAUSED')throw Error('M2_INVALID_JOB');return r;
}
export async function m2Action(jobId,action,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(jobId??'')||!['resume','pause','cancel','step'].includes(action))throw Error('M2_INVALID_ACTION');
 const r=await request(`/${jobId}/${action}`,{},headers,fetchImpl);
 if(r.jobId!==jobId||!['PAUSED','READY','COMPLETED','CANCELLED','BLOCKED_UNCERTAIN'].includes(r.state))throw Error('M2_INVALID_JOB_STATE');
 return r;
}
export async function m2Status(jobId,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(jobId??''))throw Error('M2_INVALID_JOB_ID');return request(`/${jobId}`,undefined,headers,fetchImpl);
}
export async function m2Evidence(jobId,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(jobId??''))throw Error('M2_INVALID_JOB_ID');return request(`/${jobId}/evidence`,undefined,headers,fetchImpl);
}
export async function m2RequestAdminReview(jobId,headers={},fetchImpl=globalThis.fetch){
 if(!UUID.test(jobId??''))throw Error('M2_INVALID_JOB_ID');
 const r=await request(`/${jobId}/review`,{},headers,fetchImpl);
 if(r.jobId!==jobId||r.state!=='BLOCKED_UNCERTAIN'||r.lockQuarantined!==true)throw Error('M2_ADMIN_REVIEW_UNVERIFIED');return r;
}
export function renderM2JobsPanel(root,doc=globalThis.document){
 if(!root||!doc?.createElement||root.querySelector?.('#vecthare_m2_jobs'))return false;
 const wrap=doc.createElement('section');wrap.id='vecthare_m2_jobs';
 const title=doc.createElement('h4');title.textContent='M2 — saved-source batch vectorization (Qdrant)';
 const help=doc.createElement('p');help.textContent='Durable, one-record-at-a-time jobs. No browser vectors or text. Requires M1 live Qdrant certification before physical writes; uncertainties stop without retry.';
 const modes=doc.createElement('select');
 const choices=[['vectorize-current','Vectorize current saved chat'],['vectorize-selected','Vectorize selected saved messages'],['vectorize-lorebook','Vectorize saved lorebook'],['revectorize-changed','Revectorize changed saved chat records']];
 for(const [value,label] of choices){const opt=doc.createElement('option');opt.value=value;opt.textContent=label;modes.append(opt);}
 const lore=doc.createElement('input');lore.type='text';lore.placeholder='Exact saved lorebook name';
 const selected=doc.createElement('input');selected.type='text';selected.placeholder='Selected UUIDs, comma separated';
 const loadIds=doc.createElement('button');loadIds.type='button';loadIds.textContent='Load saved message IDs';
 const checks=doc.createElement('div');checks.setAttribute('aria-label','Select saved messages');
 const limit=doc.createElement('input');limit.type='number';limit.min='1';limit.max='80';limit.value='40';
 const savedJob=doc.createElement('input');savedJob.type='text';savedJob.placeholder='Existing durable job UUID';
 const loadJob=doc.createElement('button');loadJob.type='button';loadJob.textContent='Load saved job';
 const previewBtn=doc.createElement('button');previewBtn.type='button';previewBtn.textContent='Dry run';
 const createBtn=doc.createElement('button');createBtn.type='button';createBtn.textContent='Create confirmed job';createBtn.disabled=true;
 const resume=doc.createElement('button');resume.type='button';resume.textContent='Resume';resume.disabled=true;
 const step=doc.createElement('button');step.type='button';step.textContent='Run next saved record';step.disabled=true;
 const all=doc.createElement('button');all.type='button';all.textContent='Run approved job (bounded)';all.disabled=true;
 const pause=doc.createElement('button');pause.type='button';pause.textContent='Pause';pause.disabled=true;
 const cancel=doc.createElement('button');cancel.type='button';cancel.textContent='Cancel';cancel.disabled=true;
 const evidence=doc.createElement('button');evidence.type='button';evidence.textContent='Show recovery evidence';evidence.disabled=true;
 const review=doc.createElement('button');review.type='button';review.textContent='Apply reviewed admin evidence';review.disabled=true;
 const recover=doc.createElement('textarea');recover.readOnly=true;recover.rows=5;recover.placeholder='Recovery evidence is read-only. Admin proof is required out of band.';
 const status=doc.createElement('p');status.setAttribute('role','status');
 let intent=null,preview=null,job=null,running=false,stop=false;
 const headers=async()=>{const mod=await import('../../../../../script.js');return mod.getRequestHeaders();};
 const derive=async()=>{
  let source;
  if(modes.value==='vectorize-lorebook'){
   if(!lore.value.trim()||lore.value.trim().length>220)throw Error('Exact saved lorebook name required');
   source={kind:'lorebook',name:lore.value.trim()};
  }else{
   const mod=await import('../../../../../script.js');
   source=f02CurrentChatSelector({getChatId:mod.getCurrentChatId,getContext:()=>globalThis.SillyTavern?.getContext?.()});
  }
  const n=Number(limit.value);if(!Number.isInteger(n)||n<1||n>80)throw Error('Batch limit must be 1–80');
  const i={backend:'qdrant',configId:'default',source,mode:modes.value,maxItems:n,maxEmbeddings:n,ratePerMinute:120};
  if(modes.value==='vectorize-selected'){
   const ids=[...checks.querySelectorAll('input[type=checkbox]:checked')].map(el=>el.value);
   if(!ids.length)ids.push(...selected.value.split(',').map(x=>x.trim()).filter(Boolean));
   if(!ids.length||ids.length>80||ids.some(id=>!UUID.test(id)))throw Error('Enter exact comma-separated saved record UUIDs');
   i.selectedIds=ids;
  }return i;
 };
 const render=()=>{
  const active=job&&job.state==='READY';
  resume.disabled=!job||!['PAUSED'].includes(job.state)||running;
  step.disabled=!active||running;all.disabled=!active||running;
  pause.disabled=!job||!['READY','PAUSED'].includes(job.state);
  cancel.disabled=!job||!['READY','PAUSED'].includes(job.state);
  evidence.disabled=!job||job.state!=='BLOCKED_UNCERTAIN';review.disabled=evidence.disabled;
  status.textContent=job?`Job ${job.jobId}: ${job.state} — ${job.completed}/${job.total} verified; ${job.dispatched} dispatched.${job.recoveryRequired?' Recovery review required; do not retry.':''}`:preview?
   `Dry run: ${preview.counts.eligible} eligible, ${preview.counts.excluded} excluded, ${preview.counts.embeddingCalls} embedding calls. Confirm to create a durable paused job.`:'No M2 job selected.';
 };
 loadIds.addEventListener('click',async()=>{
  loadIds.disabled=true;checks.replaceChildren();try{
   const src=(await derive()).source;const rows=await m1Preview(src,'default',await headers());
   rows.records.forEach((r,i)=>{const line=doc.createElement('label');const cb=doc.createElement('input');
    cb.type='checkbox';cb.value=r.recordId;line.append(cb,doc.createTextNode(` Saved message ${i+1} — ${r.recordId.slice(0,8)} (${r.managedState})`));checks.append(line);});
   status.textContent=`Loaded ${rows.records.length} saved message IDs for selection.`;
  }catch(e){status.textContent=`Saved-message selection failed: ${e.message}`;}finally{loadIds.disabled=false;}
 });
 previewBtn.addEventListener('click',async()=>{previewBtn.disabled=true;createBtn.disabled=true;try{
  intent=await derive();preview=await m2Preview(intent,await headers());
  createBtn.disabled=!preview.items.length;job=null;render();
 }catch(e){preview=null;status.textContent=`M2 preview refused: ${e.message}`;}finally{previewBtn.disabled=false;}});
 createBtn.addEventListener('click',async()=>{createBtn.disabled=true;try{
  if(JSON.stringify(intent)!==JSON.stringify(await derive()))throw Error('Source/options changed; dry run again');
  if(!globalThis.confirm?.(`Create a bounded job for ${preview.counts.eligible} saved records? This queues NO write until resumed. Source: ${intent.source.kind}.`))return;
  job=await m2Create(intent,await headers());savedJob.value=job.jobId;render();
 }catch(e){status.textContent=`M2 creation refused: ${e.message}`;}});
 loadJob.addEventListener('click',async()=>{try{
  job=await m2Status(savedJob.value.trim(),await headers());render();
 }catch(e){status.textContent=`M2 job status refused: ${e.message}`;}});
 async function act(action){try{job=await m2Action(job.jobId,action,await headers());render();}catch(e){status.textContent=`M2 ${action} refused: ${e.message}`;}}
 resume.addEventListener('click',()=>act('resume'));
 step.addEventListener('click',()=>act('step'));
 pause.addEventListener('click',()=>{stop=true;act('pause');});
 cancel.addEventListener('click',()=>{stop=true;if(globalThis.confirm?.(`Cancel job ${job.jobId}? Completed writes remain, and unstarted items will be abandoned.`))act('cancel');});
 all.addEventListener('click',async()=>{
  if(!globalThis.confirm?.(`Process up to ${job.total-job.cursor} remaining saved-source records? Each record is individually checked and can stop for recovery.`))return;
  running=true;stop=false;render();try{
   for(let count=0;count<240&&!stop&&job?.state==='READY';count++){
    const before=job.completed;job=await m2Action(job.jobId,'step',await headers());render();
    if(job.state==='READY'&&job.completed===before&&job.nextDispatchAt>Date.now()){
     await new Promise(resolve=>setTimeout(resolve,Math.min(1500,job.nextDispatchAt-Date.now()+50)));
    }
   }
  }catch(e){status.textContent=`M2 run stopped: ${e.message}. Check job status before further action.`;}
  finally{running=false;render();}
 });
 evidence.addEventListener('click',async()=>{try{recover.value=JSON.stringify(await m2Evidence(job.jobId,await headers()),null,2);}catch(e){recover.value=`Evidence refused: ${e.message}`;}});
 review.addEventListener('click',async()=>{try{
  if(!globalThis.confirm?.('Request verification of an independently prepared, private administrator evidence file? This does not replay uncertain writes or release a physical database lock.'))return;
  const r=await m2RequestAdminReview(job.jobId,await headers());
  recover.value=JSON.stringify(r,null,2);status.textContent=`Admin adjudication ${r.decision} recorded. Physical recovery remains separately controlled.`;
 }catch(e){status.textContent=`Admin review refused: ${e.message}`;}});
 wrap.append(title,help,modes,lore,selected,loadIds,checks,limit,savedJob,loadJob,previewBtn,createBtn,resume,step,all,pause,cancel,evidence,review,recover,status);
 root.append(wrap);render();return true;
}
