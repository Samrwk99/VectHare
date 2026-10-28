/** F08 — opt-in, local Milvus disposable acceptance only.
 * Never changes normal E02 write permissions or sends client-selected paths.
 */
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
export const F08_ACCEPTANCE_CONSENT='I ACCEPT F08 DISPOSABLE MILVUS TEST';
const URL='/api/plugins/similharity/v2/diagnostics/milvus-f08';
export async function runF08MilvusAcceptance(headers={},fetchImpl=globalThis.fetch){
 const r=await guardedVectorFetch(URL,{method:'POST',credentials:'same-origin',cache:'no-store',
  headers:{...headers,'Content-Type':'application/json','x-vecthare-f08-diagnostic':'1'},
  body:JSON.stringify({configId:'default',consent:F08_ACCEPTANCE_CONSENT})},fetchImpl);
 let data;try{data=await r.json();}catch{throw Error('F08_RESPONSE_INVALID');}
 if(!data||typeof data!=='object'||data.productionWritesEnabled!==false||data.backendCertified!==false)
  throw Error('F08_CAPABILITY_OVERCLAIM');
 if(data.success){
  if(!r.ok||data.acceptance!=='F08_DISPOSABLE_CONTRACT_PASS'||
   data.externalWriterIsolationVerified!==false||data.restartPersistenceVerified!==false||
   !Array.isArray(data.stages)||data.stages.length!==11||data.stages.some(x=>x.status!=='PASS'))
   throw Error('F08_EVIDENCE_INVALID');
 }else if(r.ok)throw Error('F08_FALSE_SUCCESS');
 return data;
}
export function renderF08MilvusAcceptance(root,doc=globalThis.document){
 if(!root||!doc?.createElement||root.querySelector?.('#vecthare_f08_milvus_acceptance'))return false;
 const panel=doc.createElement('div');panel.id='vecthare_f08_milvus_acceptance';
 const title=doc.createElement('div');title.textContent='F08 — Milvus disposable acceptance (developer test)';
 const warning=doc.createElement('div');warning.textContent='Creates a NEW Milvus test collection and synthetic vectors on your configured Milvus server under the authenticated user. No existing collection is overwritten or purged. A test record may remain after errors. Does NOT enable normal memory writes.';
 const btn=doc.createElement('button');btn.type='button';btn.textContent='Run disposable Milvus lifecycle test';
 const output=doc.createElement('div');output.setAttribute('role','status');
 btn.addEventListener('click',async()=>{
  if(typeof globalThis.confirm==='function'&&!globalThis.confirm('Create a new disposable Milvus index and run the F08 synthetic insert/search/edit/delete test? Data may remain on errors.'))return;
  btn.disabled=true;output.textContent='Running isolated Milvus acceptance…';
  try{const {getRequestHeaders}=await import('../../../../script.js');
   const result=await runF08MilvusAcceptance(getRequestHeaders());
   const stages=(result.stages||[]).map(s=>`${s.stage}: ${s.status}${s.code?' ('+s.code+')':''}`).join(', ');
   output.textContent=`F08 ${result.success?'PASS':'FAILED/UNCERTAIN'}: ${stages}. Collection retained: ${result.collection||'unknown'}. Memory writes remain disabled.`;
  }catch(e){output.textContent=`F08 Milvus unavailable: ${e?.message||'unknown'}`;}
  finally{btn.disabled=false;}
 });
 panel.append(title,warning,btn,output);root.prepend(panel);return true;
}
