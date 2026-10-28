/** S10: versioned public capability statements, never runtime authorizations. */
import {S10_CONTRACT_VERSION} from './s10-build.js';
const BACKENDS=Object.freeze(['standard','lancedb','qdrant','milvus']);
const DENIED='DENIED_NOT_LIVE_CERTIFIED';
const GUARDED='GUARDED_UNVERIFIED';
const UNPROBED='UNPROBED';
const RISKY=Object.freeze(['insert','updateText','updateMetadata','delete','scopedClear',
  'verifiedInventory','verifiedExport','migrationCutover','operationSubmit','operationReconcile']);
const DENIED_ENDPOINTS=Object.freeze([
  '/v2/records/insert','/v2/records/update','/v2/records/delete',
  '/v2/collections/clear','/v2/collections/migrate','/v2/operations/execute'
]);
export function S10Capabilities(build){
  if(!build||!build.fingerprint)throw new Error('S10_BUILD_REQUIRED');
  const backends={};
  for(const backend of BACKENDS){
    const operations={health:GUARDED,connection:GUARDED,
      list:backend==='qdrant'||backend==='milvus'?DENIED:GUARDED,
      get:backend==='qdrant'||backend==='milvus'?DENIED:GUARDED,
      query:backend==='qdrant'||backend==='milvus'?DENIED:GUARDED,
      hybrid:UNPROBED,embeddings:GUARDED,stats:'NONAUTHORITATIVE',
      ...Object.fromEntries(RISKY.map(op=>[op,DENIED]))};
    backends[backend]={operations, transport:backend==='standard'?'PLUGIN_VECTRA_NOT_NATIVE_SILLYTAVERN_STANDARD':'SIMILHARITY_PLUGIN', schema:'V2_INTERNAL_FIXTURE_ONLY',
      backendAcceptance:'UNPROBED',sourceOwnership:'NOT_HOST_ATTESTED',
      concurrency:'NOT_LIVE_CERTIFIED',completeSnapshot:'NOT_PROVEN'};
  }
  return {schemaVersion:1,contractVersion:S10_CONTRACT_VERSION,
    pluginVersion:build.pluginVersion,checkpoint:'S10',
    sourceFingerprint:build.fingerprint,manifestFingerprint:build.manifestFingerprint,
    buildVerification:build.verification,sourceFiles:build.sourceFiles,
    deployedSourceAttested:false,liveBackendCertified:false,productionCertified:false,
    extensionCertified:false, publicV2ReadsEnabled:false,publicV2MutationsEnabled:false,
    legacyMutationRoutes:'DENIED_S01',legacySharedReads:'DENIED_S03',
    physicalPurge:'PROHIBITED',capabilityClaimsArePermissions:false,
    backends};
}
export function S10Contracts(){
  return {contractVersion:S10_CONTRACT_VERSION,status:'FINALIZED_FAIL_CLOSED_V2_SURFACE',
    executionCertified:false,
    requestRules:['Authenticated host context required','Browser cannot assign server user identity',
      'Client preflight is not source authorization','Unverified operations never dispatch'],
    responseRules:{
      success:'boolean',code:'stable machine-readable string on refusal',
      retryable:'boolean for refused operations',
      executionAllowed:'false for disabled operation endpoints'},
    routes:{
      'GET /v2/build':'runtime checked source manifest; self-report only',
      'GET /v2/capabilities':'per-backend conservative capability states',
      'GET /v2/contracts':'v2 request/response description',
      'GET /v2/connections/:backend':'authenticated per-user redacted connection state',
      'PUT /v2/connections/:backend':'authenticated server-side configuration; no vector mutations',
      'DELETE /v2/connections/:backend':'authenticated removal of per-user connection configuration',
      'POST /v2/operations/preflight':'validate only; no host source grant',
      'GET /v2/operations/:id':'scoped receipt display; no execution',
      'POST /v2/reads/preflight':'validate only; no backend read',
      'POST /v2/reads/get':'DENIED',
      'POST /v2/reads/list':'DENIED',
      'POST /v2/reads/query':'DENIED',
      'POST /v2/reads/inventory':'DENIED',
      'POST /v2/operations/submit':'DENIED',
      'POST /v2/operations/reconcile':'DENIED',
      ...Object.fromEntries(DENIED_ENDPOINTS.map(v=>[`POST ${v}`,'DENIED']))
    },
    unsafeLegacyRoutes:'DENIED',physicalPurge:'PROHIBITED',
    errorCodes:{
      S01_MUTATION_BLOCKED:409,S03_SHARED_LEGACY_READ_UNVERIFIED:409,
      S04_MUTATION_NOT_ACTIVATED:409,S05_READ_NOT_ACTIVATED:409,
      S10_OPERATION_NOT_CERTIFIED:409}
  };
}
export function registerS10Routes(router,build){
  const caps=S10Capabilities(build),contracts=S10Contracts();
  router.get('/capabilities',(_req,res)=>res.json(caps));
  router.get('/v2/capabilities',(_req,res)=>res.json(caps));
  router.get('/v2/contracts',(_req,res)=>res.json(contracts));
  router.get('/v2/build',(_req,res)=>res.json({
    pluginVersion:build.pluginVersion,contractVersion:build.contractVersion,
    sourceFingerprint:build.fingerprint,manifestFingerprint:build.manifestFingerprint,
    sourceFiles:build.sourceFiles,verification:build.verification,
    deployedSourceAttested:false,dependenciesAttested:false,
    hostAttested:false,liveBackendsCertified:false}));
  for(const route of DENIED_ENDPOINTS){
    router.post(route,(_req,res)=>res.status(409).json({
      success:false,code:'S10_OPERATION_NOT_CERTIFIED',
      error:'Host source ownership and real backend operation contracts are not certified.',
      executionAllowed:false,retryable:false}));
  }
}
