/** F03 verified physical vector readback.
 * Original-vector digest and backend-stored values are separate evidence.
 * Never equate a copied payload hash with a vector stored by a backend.
 */
import {createHash} from 'node:crypto';
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function compareStoredVector({backend,metric,expected,actual,dimension,expectedHash}={}){
 if(!Array.isArray(expected)||!Array.isArray(actual)||!Number.isSafeInteger(dimension)||dimension<1||
  expected.length!==dimension||actual.length!==dimension||
  !expected.every(Number.isFinite)||!actual.every(Number.isFinite))
  return {verified:false,reason:'VECTOR_EVIDENCE_INVALID'};
 if(typeof expectedHash==='string'&&digest(expected)!==expectedHash)
  return {verified:false,reason:'VECTOR_REFERENCE_HASH_MISMATCH'};
 const candidates=[expected];
 if(backend==='qdrant'&&metric==='cosine'){
  const squared=expected.reduce((sum,value)=>sum+value*value,0);
  if(!Number.isFinite(squared)||squared<=0)return {verified:false,reason:'ZERO_COSINE_VECTOR'};
  const norm=Math.sqrt(squared);
  // Qdrant normally normalizes cosine vectors, but mock and some API layers
  // may return the original. Both must numerically match the claimed input.
  candidates.unshift(expected.map(value=>value/norm));
 }
 const absolute=3e-6,relative=2e-5;
 for(const reference of candidates){
  let largest=0,valid=true;
  for(let i=0;i<dimension;i++){
   const delta=Math.abs(actual[i]-reference[i]);
   const tolerance=absolute+relative*Math.max(Math.abs(reference[i]),Math.abs(actual[i]));
   if(delta>tolerance){valid=false;break;}
   largest=Math.max(largest,delta);
  }
  if(valid)return {verified:true,mode:'NUMERIC_READBACK',maxAbsoluteError:largest};
 }
 return {verified:false,reason:'VECTOR_VALUES_MISMATCH'};
}
