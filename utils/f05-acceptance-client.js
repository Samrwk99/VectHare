/** F05 host acceptance: fixed disposable Qdrant route, explicitly confirmed.
 * This is testing and must never toggle E02 memory-write permissions.
 */
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
export const F05_ACCEPTANCE_CONSENT='I ACCEPT F05 DISPOSABLE QDRANT TEST';
const URL='/api/plugins/similharity/v2/diagnostics/qdrant-f05';
export async function runF05QdrantAcceptance(headers={},fetchImpl=globalThis.fetch){
 const response=await guardedVectorFetch(URL,{method:'POST',credentials:'same-origin',cache:'no-store',
  headers:{...headers,'Content-Type':'application/json','x-vecthare-f05-diagnostic':'1'},
  body:JSON.stringify({configId:'local',consent:F05_ACCEPTANCE_CONSENT})},fetchImpl);
 let data;try{data=await response.json();}catch{throw Error('F05_RESPONSE_INVALID');}
 if(!data||typeof data!=='object'||data.productionWritesEnabled!==false)
  throw Error('F05_RESPONSE_CONTRACT_INVALID');
 if(data.success===true){
  if(!response.ok||data.acceptance!=='F05_DISPOSABLE_CONTRACT_PASS'||
    data.externalWriterIsolationVerified!==false||!Array.isArray(data.stages)||
    data.stages.length<10||data.stages.some(s=>s.status!=='PASS'))
   throw Error('F05_ACCEPTANCE_EVIDENCE_INVALID');
 }else if(response.ok)throw Error('F05_FALSE_SUCCESS');
 return data;
}
export function renderF05QdrantAcceptance(root,doc=globalThis.document){
 if(!root||!doc?.createElement||root.querySelector?.('#vecthare_f05_acceptance'))return false;
 const section=doc.createElement('div');section.id='vecthare_f05_acceptance';
 const title=doc.createElement('div');title.textContent='F05 — Qdrant extended live acceptance (disposable only)';
 const warning=doc.createElement('div');warning.textContent='Creates a NEW local Qdrant test collection and synthetic vectors. The collection is retained. A test record may remain after errors. This does not activate normal memory writes or certify external-writer concurrency.';
 const button=doc.createElement('button');button.type='button';button.textContent='Run extended disposable Qdrant acceptance';
 const output=doc.createElement('div');output.setAttribute('role','status');
 button.addEventListener('click',async()=>{
  if(typeof globalThis.confirm==='function'&&!globalThis.confirm('Run F05 against local Qdrant? This creates a NEW disposable collection and changes synthetic records in it. Failed writes can leave a record behind; nothing is purged automatically.'))return;
  button.disabled=true;output.textContent='Running F05 disposable contract checks…';
  try{
   const {getRequestHeaders}=await import('../../../../script.js');
   const r=await runF05QdrantAcceptance(getRequestHeaders());
   const detail=(r.stages||[]).map(s=>`${s.stage}: ${s.status}`).join(', ');
   output.textContent=r.success?`F05 disposable acceptance PASS (${detail}). Collection retained: ${r.collection}. Production writes remain disabled.`:
    `F05 failed/uncertain (${detail}). Collection: ${r.collection||'unknown'}. Do not retry uncertain operations or purge automatically.`;
  }catch(error){output.textContent=`F05 acceptance unavailable: ${error?.message||'unknown'}`;}
  finally{button.disabled=false;}
 });
 section.append(title,warning,button,output);root.prepend(section);return true;
}
