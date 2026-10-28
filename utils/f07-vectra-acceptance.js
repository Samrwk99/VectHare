/** F07 — opt-in, local Vectra disposable acceptance only.
 * Never changes normal E02 write permissions or sends client-selected paths.
 */
import {guardedVectorFetch} from './e02-vector-request-gateway.js';
export const F07_ACCEPTANCE_CONSENT='I ACCEPT F07 DISPOSABLE VECTRA TEST';
const URL='/api/plugins/similharity/v2/diagnostics/vectra-f07';
export async function runF07VectraAcceptance(headers={},fetchImpl=globalThis.fetch){
 const r=await guardedVectorFetch(URL,{method:'POST',credentials:'same-origin',cache:'no-store',
  headers:{...headers,'Content-Type':'application/json','x-vecthare-f07-diagnostic':'1'},
  body:JSON.stringify({consent:F07_ACCEPTANCE_CONSENT})},fetchImpl);
 let data;try{data=await r.json();}catch{throw Error('F07_RESPONSE_INVALID');}
 if(!data||typeof data!=='object'||data.productionWritesEnabled!==false||data.backendCertified!==false||data.nativeStandardCertified!==false)
  throw Error('F07_CAPABILITY_OVERCLAIM');
 if(data.success){
  if(!r.ok||data.acceptance!=='F07_DISPOSABLE_CONTRACT_PASS'||
   data.externalWriterIsolationVerified!==false||data.restartPersistenceVerified!==false||
   !Array.isArray(data.stages)||data.stages.length!==11||data.stages.some(x=>x.status!=='PASS'))
   throw Error('F07_EVIDENCE_INVALID');
 }else if(r.ok)throw Error('F07_FALSE_SUCCESS');
 return data;
}
export function renderF07VectraAcceptance(root,doc=globalThis.document){
 if(!root||!doc?.createElement||root.querySelector?.('#vecthare_f07_vectra_acceptance'))return false;
 const panel=doc.createElement('div');panel.id='vecthare_f07_vectra_acceptance';
 const title=doc.createElement('div');title.textContent='F07 — Vectra local disposable acceptance (developer test)';
 const warning=doc.createElement('div');warning.textContent='Creates a NEW local Vectra test index and synthetic vectors under your authenticated user. No existing index is overwritten or purged. A test record may remain after errors. Does NOT enable normal memory writes.';
 const btn=doc.createElement('button');btn.type='button';btn.textContent='Run disposable Vectra lifecycle test';
 const output=doc.createElement('div');output.setAttribute('role','status');
 btn.addEventListener('click',async()=>{
  if(typeof globalThis.confirm==='function'&&!globalThis.confirm('Create a new disposable Vectra index and run the F07 synthetic insert/search/edit/delete test? Data may remain on errors.'))return;
  btn.disabled=true;output.textContent='Running isolated Vectra acceptance…';
  try{const {getRequestHeaders}=await import('../../../../script.js');
   const result=await runF07VectraAcceptance(getRequestHeaders());
   const stages=(result.stages||[]).map(s=>`${s.stage}: ${s.status}${s.code?' ('+s.code+')':''}`).join(', ');
   output.textContent=`F07 ${result.success?'PASS':'FAILED/UNCERTAIN'}: ${stages}. Index retained: ${result.collection||'unknown'}. Memory writes remain disabled.`;
  }catch(e){output.textContent=`F07 Vectra unavailable: ${e?.message||'unknown'}`;}
  finally{btn.disabled=false;}
 });
 panel.append(title,warning,btn,output);root.prepend(panel);return true;
}
