/** F09c.4: non-authorizing Qdrant conditional-operation evidence classifier.
 * Completed acknowledges execution of the update operation, NOT that its
 * conditional filter matched. Physical readback is a snapshot, not causal proof.
 * This module never grants atomic mutation privileges and is deliberately
 * independent of browser input, HTTP routes, and production adapter methods.
 */
const isObj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const VALID_STATUS=new Set(['completed','acknowledged']);

export function classifyQdrantConditionalEvidence({completionStatus,postconditionObserved,observationAvailable=true,operationId}={}) {
 if(!VALID_STATUS.has(completionStatus) || typeof postconditionObserved!=='boolean' ||
    typeof observationAvailable!=='boolean' || typeof operationId!=='string' ||
    !/^[0-9a-f-]{36}$/i.test(operationId)) throw new TypeError('F09C4_EVIDENCE_INVALID');
 const observation=observationAvailable
  ? (postconditionObserved?'MATCHING_POSTSTATE_UNATTRIBUTED':'POSTSTATE_NOT_MATCHING')
  : 'READBACK_INCONCLUSIVE';
 const classification=completionStatus==='acknowledged'?'ONLY_DISPATCH_ACKNOWLEDGED'
  : observation==='MATCHING_POSTSTATE_UNATTRIBUTED'?'COMPLETED_POSTSTATE_MATCH_UNATTRIBUTED'
  : observation==='POSTSTATE_NOT_MATCHING'?'COMPLETED_POSTSTATE_DIFFERENT'
  : 'COMPLETED_READBACK_INCONCLUSIVE';
 return Object.freeze({classification,observation,completionStatus,operationId,
  conditionMatched:'UNPROVEN',applied:false,atomicBackendCertified:false,
  productionPermission:false,automaticRetryAllowed:false,
  reason:'QDRANT_OPERATION_STATUS_HAS_NO_PER_POINT_CONDITION_MATCH_PROOF'});
}

/** Local audit of the minimum external-writer controls; never an attestation.
 * A boolean supplied by an application is not a network ACL or write audit.
 * All checks must be evidenced by the real host and reviewed independently.
 */
export function assessExclusiveWriterEvidence(evidence={}) {
 if(!isObj(evidence))throw new TypeError('F09C4_EXCLUSIVE_WRITER_EVIDENCE_INVALID');
 const required={
  privateWriteGateway:'NO_EXTERNAL_DIRECT_WRITE_REACHABILITY_PROVEN',
  credentialsRestricted:'BACKEND_WRITE_CREDENTIALS_NOT_IN_CLIENTS',
  legacyRoutesBlocked:'ALL_LEGACY_OR_BYPASS_MUTATORS_DISABLED',
  rawUpsertsBlocked:'RAW_BACKEND_UPSERT_PATHS_BLOCKED_OR_CONTROLLED',
  independentWritersAudited:'INDEPENDENT_WRITERS_DISCOVERED_AND_CONTROLLED',
  recoveryProcedureTested:'CRASH_UNCERTAIN_RECOVERY_PROVEN',
  realHostRaceTested:'REAL_CONCURRENT_WRITER_TESTS_PASSED'
 };
 const missing=Object.entries(required).filter(([key])=>evidence[key]!==true).map(([,name])=>name);
 // Even all self-reported flags are not sufficient proof; independent host
 // enforcement and a reviewed operational attestation are out of this module.
 return Object.freeze({stage:'F09C4',status:'INDEPENDENT_HOST_CERTIFICATION_REQUIRED',
  selfReportedChecklistComplete:missing.length===0,missing:Object.freeze(missing),
  atomicBackendCertified:false,productionPermission:false,
  requires:'NETWORK_ACL_AND_WRITER_CONTROL_VERIFICATION_PLUS_BACKEND_ACCEPTANCE'});
}
