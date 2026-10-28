/** F12 read-only release assessment. No production authorization is possible. */
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
const ENDPOINT='/api/plugins/similharity/v2/release/assessment';
const BACKENDS=['qdrant','lancedb','vectra','standard-native','milvus'];
const REQUIRED=['host_authenticated_source_isolation','branch_identity_independence',
 'normal_memory_create_read_edit_delete','automatic_chat_sync_and_reindex',
 'summary_and_world_info_workflows','embedding_gui_credentials_and_generation',
 'retrieval_final_prompt_injection','external_writer_and_stale_revision_safety',
 'crash_restart_and_uncertain_operation_recovery','authoritative_inventory_and_full_backup_restore',
 'legacy_migration_and_rollback','windows_linux_termux_host_acceptance'];
const isObject=x=>x&&typeof x==='object'&&!Array.isArray(x);
export function validateF12Assessment(data){
 if(!isObject(data)||data.success!==true||data.schemaVersion!==1||data.checkpoint!=='F12'||
    data.verdict!=='NO_GO'||data.releaseCertified!==false||data.hostAcceptanceProven!==false||
    data.liveEvidenceAttached!==false||data.credentialsIncluded!==false||
    data.productionWritesEnabled!==false||data.userScopeVerified!==true||
    data.evidenceSource!=='SERVER_IMPLEMENTATION_STATE_ONLY'||
    !Array.isArray(data.requiredChecks)||!isObject(data.backends)||
    Object.keys(data.backends).sort().join('|')!==BACKENDS.slice().sort().join('|')||
    data.requiredChecks.map(x=>x?.id).join('|')!==REQUIRED.join('|')||
    data.requiredChecks.some(x=>x.status!=='NOT_VERIFIED'))
    throw Error('F12_UNTRUSTED_ASSESSMENT');
 for(const name of BACKENDS){
  const item=data.backends[name];
  if(!isObject(item)||item.backend!==name||item.releaseStatus!=='NOT_CERTIFIED'||
     item.normalMutationsAllowed!==false||item.health!=='NOT_TESTED_BY_F12'||
     !Array.isArray(item.checks)||item.checks.length!==5||
     item.checks.some(x=>x.status!=='NOT_VERIFIED'))throw Error('F12_UNTRUSTED_BACKEND_ASSESSMENT');
 }
 return data;
}
export async function f12AssessmentRequest(headers={},fetchImpl=globalThis.fetch){
 const response=await guardedVectorFetch(ENDPOINT,{method:'GET',credentials:'same-origin',
  cache:'no-store',headers},fetchImpl);
 if(!response?.ok)throw Error(`F12_ASSESSMENT_HTTP_${response?.status??'UNKNOWN'}`);
 let data;try{data=await response.json();}catch{throw Error('F12_ASSESSMENT_INVALID_JSON');}
 return validateF12Assessment(data);
}
export function renderF12ReleaseCenter(root,{getHeaders=()=>({}),fetchImpl=globalThis.fetch}={},doc=globalThis.document){
 if(!root||!doc?.createElement||root.querySelector?.('#vecthare_f12_release'))return false;
 const panel=doc.createElement('section');panel.id='vecthare_f12_release';panel.className='vecthare-card';
 const heading=doc.createElement('h3');heading.textContent='F12 — Release acceptance and remaining blockers';
 const intro=doc.createElement('p');intro.textContent='This is an authenticated read-only release gate, not a backend health test. F09b ordinary memory workflows and full F10 recovery are still incomplete; no production writes are activated.';
 const button=doc.createElement('button');button.type='button';button.textContent='Check release assessment';
 const state=doc.createElement('div');state.setAttribute('role','status');state.textContent='Not checked. Requires no backend mutations.';
 const result=doc.createElement('div');result.id='vecthare_f12_release_report';
 button.addEventListener('click',async()=>{
  button.disabled=true;state.textContent='Reading server release assessment (no backend writes)…';
  try{
   const data=await f12AssessmentRequest(getHeaders(),fetchImpl);result.replaceChildren();
   const headline=doc.createElement('strong');headline.textContent='Release decision: NO GO — development/testing only';result.append(headline);
   const list=doc.createElement('ul');for(const check of data.requiredChecks){const li=doc.createElement('li');li.textContent=check.id.replaceAll('_',' ')+' — not verified';list.append(li);}result.append(list);
   const p=doc.createElement('p');p.textContent='All five backends remain uncertified for ordinary memory operations. Existing disposable diagnostics are available in Advanced development tools; they do not certify a production release.';result.append(p);
   state.textContent='Assessment received. No operation permissions changed.';
  }catch(e){result.replaceChildren();state.textContent=`Release assessment unavailable: ${e?.message||'unknown error'}. Release remains blocked.`;}
  finally{button.disabled=false;}
 });
 panel.append(heading,intro,button,state,result);root.prepend(panel);return true;
}
