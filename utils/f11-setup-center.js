/** F11 unified GUI-first setup/readiness view. Never grants capabilities.
 * Readiness is user-scoped server configuration, NOT a backend health test.
 */
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
const ENDPOINT='/api/plugins/similharity/v2/setup/readiness';
const BACKENDS=['qdrant','milvus','lancedb','vectra','standard-native'];
const LABELS={qdrant:'Qdrant',milvus:'Milvus',lancedb:'LanceDB',vectra:'Plugin Vectra',
 'standard-native':'SillyTavern Standard (native)'};
const TARGETS={qdrant:'vecthare_qdrant_settings',milvus:'vecthare_milvus_settings',
 lancedb:'vecthare_f06_lancedb_acceptance',vectra:'vecthare_f07_vectra_acceptance',
 'standard-native':'vecthare_vector_backend'};
const falseFlags=['normalInsert','normalUpdate','normalDelete','automaticVectorization',
 'automaticPromptInjection','authoritativeInventory','verifiedFullBackup',
 'restore','migration','purge','productionCertified'];
const isObj=x=>x&&typeof x==='object'&&!Array.isArray(x);
export function validateF11Readiness(value){
 if(!isObj(value)||value.success!==true||value.schemaVersion!==1||
    value.mode!=='GUARDED_DEVELOPMENT_ONLY'||value.userScopeVerified!==true||
    value.backendHealthMeasured!==false||value.productionWritesEnabled!==false||
    value.backendCapabilitiesArePermissions!==false||
    value.fullBackupAvailable!==false||value.legacyMigrationAvailable!==false||
    value.embeddingCredentialsManagedByPlugin!==false||!isObj(value.backends)||
    Object.keys(value.backends).sort().join('|')!==[...BACKENDS].sort().join('|'))
  throw Error('F11_UNVERIFIED_READINESS_RESPONSE');
 for(const backend of BACKENDS){
  const item=value.backends[backend];
  if(!isObj(item)||item.backend!==backend||typeof item.connection!=='string'||
     item.connection.length>100||item.connectionHealth!=='NOT_TESTED'||
     typeof item.reads!=='string'||typeof item.mutations!=='string'||
     falseFlags.some(key=>item[key]!==false))
   throw Error('F11_UNVERIFIED_BACKEND_STATUS');
 }
 return value;
}
export async function f11ReadinessRequest(headers={},fetchImpl=globalThis.fetch){
 const response=await guardedVectorFetch(ENDPOINT,{method:'GET',credentials:'same-origin',
  cache:'no-store',headers},fetchImpl);
 if(!response?.ok)throw Error(`F11_STATUS_HTTP_${response?.status??'UNKNOWN'}`);
 let data;try{data=await response.json();}catch{throw Error('F11_STATUS_INVALID_JSON');}
 return validateF11Readiness(data);
}
export const F11_DEVELOPER_PANELS=Object.freeze([
 'vecthare_f10_recovery','vecthare_f09_memory_preview','vecthare_f08_pilot',
 'vecthare_f08_milvus_acceptance','vecthare_f07_pilot',
 'vecthare_f07_vectra_acceptance','vecthare_f06_pilot',
 'vecthare_f06_lancedb_acceptance','vecthare_f05_acceptance',
 'vecthare_f04_pilot','vecthare_f03_provision','vecthare_f02_reads',
 'vecthare_h01_test'
]);
/** Reparent previously rendered panels (preserves event listeners and state).
 * Any missing panel is left absent; no capability is inferred from UI presence.
 */
export function groupF11DeveloperPanels(root,doc=globalThis.document){
 if(!root||!doc?.createElement)return 0;
 let details=root.querySelector?.('#vecthare_f11_developer_tools');
 if(!details){
  details=doc.createElement('details');details.id='vecthare_f11_developer_tools';
  const summary=doc.createElement('summary');summary.textContent='Advanced F02–F10 development tools (disposable data only)';
  details.append(summary);root.prepend(details);
 }
 let count=0;
 for(const id of F11_DEVELOPER_PANELS){
  const item=root.querySelector?.('#'+id);
  if(item&&item!==details&&item.parentElement!==details){details.append(item);count++;}
 }
 return count;
}
export function renderF11SetupCenter(root,{getHeaders=()=>({}),fetchImpl=globalThis.fetch}={},doc=globalThis.document){
 if(!root||!doc?.createElement||root.querySelector?.('#vecthare_f11_setup'))return false;
 const panel=doc.createElement('section');panel.id='vecthare_f11_setup';
 panel.className='vecthare-card';
 const heading=doc.createElement('h3');heading.textContent='F11 — Setup & capability center';
 const description=doc.createElement('p');description.textContent=
  'Configure Qdrant and Milvus above. LanceDB and plugin Vectra are local plugin backends; native Standard is a separate SillyTavern service. Configuration does not certify read/write operations. The F09 automatic memory pipeline and F10 production backup/restore are unfinished.';
 const refresh=doc.createElement('button');refresh.type='button';refresh.textContent='Refresh authenticated setup status';
 const status=doc.createElement('div');status.setAttribute('role','status');
 status.textContent='Not checked. Choose Refresh to inspect per-user setup (no database mutations).';
 const table=doc.createElement('div');table.id='vecthare_f11_backend_states';
 const embedding=doc.createElement('p');embedding.textContent=
  'Embeddings: use the existing VectHare/SillyTavern provider controls. Server-managed embedding credentials and automatic v2 embedding workflows are NOT verified; do not place API keys in unsecured fields.';
 function show(value){
  table.replaceChildren();
  for(const backend of BACKENDS){
   const item=value.backends[backend];const row=doc.createElement('div');row.className='vecthare-f11-backend-row';
   const title=doc.createElement('strong');title.textContent=LABELS[backend]+' — ';
   const text=doc.createElement('span');text.textContent=`${item.connection.replaceAll('_',' ').toLowerCase()}; connection not health-tested. Reads: ${item.reads}; writes: ${item.mutations}.`;
   const link=doc.createElement('button');link.type='button';link.textContent='Show controls';
   link.addEventListener('click',()=>{
    const target=doc.getElementById?.(TARGETS[backend]);
    if(!target){status.textContent='Controls are not available in this installation.';return;}
    const ancestor=target.closest?.('details');if(ancestor)ancestor.open=true;
    if(target.style&&target.style.display==='none'){
     // The main backend selector owns its visibility; never override the selected backend.
     status.textContent='Select the matching backend in Core Settings to display its controls.';
     doc.getElementById?.('vecthare_vector_backend')?.scrollIntoView?.({block:'center'});return;
    }
    target.scrollIntoView?.({block:'center'});
   });
   row.append(title,text,link);table.append(row);
  }
 }
 refresh.addEventListener('click',async()=>{
  refresh.disabled=true;status.textContent='Reading authenticated server setup (not probing backends)…';
  try{show(await f11ReadinessRequest(getHeaders(),fetchImpl));
   status.textContent='Setup inspected. All backend operations remain guarded; health, normal writes, full backups and restore are unverified.';
  }catch(e){table.replaceChildren();status.textContent=`Setup inspection unavailable: ${e?.message||'unknown error'}. No backend capability granted.`;}
  finally{refresh.disabled=false;}
 });
 panel.append(heading,description,refresh,status,table,embedding);
 root.prepend(panel);return true;
}
