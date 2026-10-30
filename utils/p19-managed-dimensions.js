/** P-A.5: dimension diagnostics must not generate browser-selected embeddings,
 * inspect a shared legacy collection, or equate profile configuration with
 * physical schema proof. Saved source and configured backend are re-attested by
 * the M1 server; independent physical dimension evidence is still UNVERIFIED.
 */
import {m1Preflight,m1Preview} from './m1-record-gui.js';
import {f02CurrentChatSelector} from './f02-public-read-client.js';
export async function managedDimensionEvidence(settings,{
 getChatId, getContext=()=>globalThis.SillyTavern?.getContext?.(),
 getHeaders=()=>({}),preflight=m1Preflight,preview=m1Preview,selector=f02CurrentChatSelector
}={}){
 const backend=settings?.vector_backend;
 if(!['qdrant','lancedb','vectra','milvus'].includes(backend))
  return {status:'warning',message:'Legacy collection/model dimension comparison not certified; no legacy embedding or collection probe was sent.'};
 try{
  const source=await selector({getChatId,getContext});
  const configId=backend==='qdrant'&&settings?.qdrant_use_cloud!==true?'local':'default';
  const headers=getHeaders();
  const state=await preflight(source,configId,headers,globalThis.fetch,backend);
  if(!state.configured||!state.ready||!Number.isSafeInteger(state.profile?.dimension)||state.profile.dimension<1)
   return {status:'warning',message:`Managed embedding profile not verified (${state.connectionState||'NOT_CONFIGURED'}). Collection dimension UNVERIFIED.`};
  // Do not mistake profile dimensions for physical schema dimensions. This is a
  // server-authorized, source-bound read only; no vectors or credentials in body.
  const view=await preview(source,configId,headers,globalThis.fetch,backend);
  if(view.completeSavedSource!==true)
   return {status:'warning',message:'Saved-source preview incomplete; physical dimension UNVERIFIED.'};
  return {status:'warning',message:`Managed embedding profile verified (${state.profile.dimension}D) and source-bound preview available. Independent physical collection dimension comparison UNVERIFIED.`,
   data:{profileDimension:state.profile.dimension,backend,physicalDimensionVerified:false}};
 }catch(e){return {status:'warning',message:`Managed collection dimension UNVERIFIED: ${e?.message||'saved-source check unavailable'}`};}
}
