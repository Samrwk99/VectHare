/** M0 versioned, server-computed capability model. Capability evidence is
 * not writable through any browser request; an offline test never enables it.
 */
import {createHash} from 'node:crypto';
export const CAPABILITY_VERSION=2;
export const MODES=Object.freeze(['BLOCKED','PREVIEW','PILOT','ENABLED','UNSUPPORTED_BY_DESIGN']);
export const BACKENDS=Object.freeze(['qdrant','milvus','lancedb','vectra','standard']);
export const OPERATIONS=Object.freeze(['insert','update','revectorize','delete','collection-delete','scoped-purge',
 'auto-chat-sync','auto-lorebook-sync','orphan-delete','backup','restore','native-standard','migration','uncertain-recovery']);
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
/** Caller can supply only internally-verified evidence. No evidence -> fail closed. */
export function capability({backend,operation,transport,adapterVersion='m0-contract-1',hostVersion=null,
 prerequisites=[],evidence=null,implementationEvidence=null,policy='BLOCKED'}={}){
 if(!BACKENDS.includes(backend)||!OPERATIONS.includes(operation))throw Error('M0_CAPABILITY_CELL_INVALID');
 const native=backend==='standard';
 const unsupported=operation==='scoped-purge'&&backend==='standard' || operation==='native-standard'&&!native;
 const evidenceVerified=evidence?.realHostAccepted===true&&evidence?.disposableBackendAccepted===true&&
 evidence?.operation===operation&&evidence?.backend===backend&&
 typeof evidence?.hostVersion==='string'&&evidence.hostVersion===hostVersion&&
 typeof evidence?.testRunId==='string'&&evidence.testRunId.length>0;
 // Manual-test readiness is independent from host certification. Only
 // server-maintained implementation evidence may be passed to this helper.
 const required=['gateway','ui','conformance','faultTests','securityTests'];
 const codeVerified=required.every(k=>implementationEvidence?.[k]==='passed');
 const canEnable=policy==='ENABLED'&&(evidenceVerified||codeVerified)&&prerequisites.length===0;
 const mode=unsupported?'UNSUPPORTED_BY_DESIGN':canEnable?'ENABLED':
  policy==='PREVIEW'?'PREVIEW':policy==='PILOT'?'PILOT':'BLOCKED';
 return Object.freeze({contractVersion:CAPABILITY_VERSION,backend,transport:transport??(native?'native':'plugin'),
  adapterVersion,hostVersion,operation,mode,prerequisites:[...prerequisites],enabled:mode==='ENABLED',
  validationStatus:mode==='ENABLED'?(evidenceVerified?'VERIFIED':'AWAITING_MANUAL_TEST'):'NOT_READY',
  validationEvidenceFingerprint:evidenceVerified?sha(evidence):null,
  implementationEvidence:codeVerified?{...implementationEvidence}:null,
  runtimePreflightRequired:true,
  reasonCode:mode==='ENABLED'?null:unsupported?'M0_UNSUPPORTED_BY_DESIGN':
   policy==='ENABLED'&&!evidenceVerified&&!codeVerified?'M0_CODE_OR_HOST_EVIDENCE_REQUIRED':'M0_PRODUCTION_GATE_NOT_CERTIFIED',
  evidenceFingerprint:evidenceVerified?sha(evidence):codeVerified?sha(implementationEvidence):null});
}
export function capabilityMatrix({hostVersion=null,evidenceByOperation={},implementationEvidenceByOperation={}}={}){
 // Only trusted server routes may supply evidence. This pure formatter does
 // not load/accept evidence from HTTP bodies, headers or query parameters.
 return BACKENDS.flatMap(backend=>OPERATIONS.map(operation=>{
  const evidence=evidenceByOperation[`${backend}:${operation}`]??null;
  const implementationEvidence=implementationEvidenceByOperation[`${backend}:${operation}`]??null;
  const eligible=Boolean(evidence||implementationEvidence);
  return capability({backend,operation,hostVersion,evidence,implementationEvidence,
   policy:eligible?'ENABLED':'BLOCKED',
   prerequisites:eligible?[]:['M0_IMPLEMENTATION_NOT_PROVEN']});
 }));
}
