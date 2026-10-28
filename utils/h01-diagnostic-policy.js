/** Diagnostic gating mirrors runtime E02 policy. A blocked mutation test must
 * never send its first write just to discover that the server refuses it. */
import {E02_MATRIX_STATUS} from './e02-matrix-status.js';
export function mutationDiagnosticRestriction(settings,label,category='visualizer'){
 const backend=settings?.vector_backend==='vectra'?'standard':settings?.vector_backend || 'standard';
 const cell=E02_MATRIX_STATUS[backend]?.insert;
 if(cell==='DENIED'||cell==='UNPROBED'||!cell){
  return {name:label,status:'skipped',category,
   message:`${backend}: vector writes are intentionally disabled (${cell||'UNKNOWN'}). Use the disposable Qdrant contract test to check actual backend behavior; this is not a production write grant.`};
 }
 return null;
}
