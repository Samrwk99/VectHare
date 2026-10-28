/** F12: fail-closed, read-only release readiness assessment.
 * This route is a list of known blockers. It is not host acceptance, a
 * certificate, a backend health check, or permission to enable any mutation.
 */
import {getF11Readiness} from './f11-readiness.js';

export const F12_BACKENDS=Object.freeze(['qdrant','lancedb','vectra','standard-native','milvus']);
export const F12_REQUIRED_CHECKS=Object.freeze([
  'host_authenticated_source_isolation',
  'branch_identity_independence',
  'normal_memory_create_read_edit_delete',
  'automatic_chat_sync_and_reindex',
  'summary_and_world_info_workflows',
  'embedding_gui_credentials_and_generation',
  'retrieval_final_prompt_injection',
  'external_writer_and_stale_revision_safety',
  'crash_restart_and_uncertain_operation_recovery',
  'authoritative_inventory_and_full_backup_restore',
  'legacy_migration_and_rollback',
  'windows_linux_termux_host_acceptance',
]);
const BACKEND_CHECKS=Object.freeze([
  'live_disposable_crud_reopen',
  'live_source_and_cross_user_isolation',
  'live_stale_revision_and_external_writer',
  'live_restart_recovery_and_readback',
  'normal_pipeline_activation',
]);
const check=(id,status='NOT_VERIFIED')=>({id,status});

export async function getF12Assessment(context){
  const readiness=await getF11Readiness(context);
  const backends={};
  for(const id of F12_BACKENDS){
    if(!readiness.backends?.[id] || readiness.backends[id].productionCertified!==false)
      throw Error('F12_BACKEND_STATE_UNVERIFIED');
    backends[id]={
      backend:id,
      configured:readiness.backends[id].connection,
      health:'NOT_TESTED_BY_F12',
      releaseStatus:'NOT_CERTIFIED',
      normalMutationsAllowed:false,
      checks:BACKEND_CHECKS.map(x=>check(x)),
    };
  }
  return {
    success:true,schemaVersion:1,checkpoint:'F12',verdict:'NO_GO',
    releaseCertified:false,hostAcceptanceProven:false,liveEvidenceAttached:false,
    credentialsIncluded:false,productionWritesEnabled:false,
    evidenceSource:'SERVER_IMPLEMENTATION_STATE_ONLY',
    userScopeVerified:true,
    requiredChecks:F12_REQUIRED_CHECKS.map(id=>check(id)),
    backends,
    note:'Live host tests, F09b automatic CRUD/summary/World Info and provider integration, full F10 recovery and independent approval remain outstanding. Opt-in verified v2 prompt retrieval is development-only. A connection, simulated test or self-reported result cannot activate operations.',
  };
}
export function registerF12ReleaseRoutes(router){
  router.get('/v2/release/assessment',async(req,res)=>{
    try{
      if(Object.keys(req.query||{}).length || req.body!==undefined && req.body!==null && Object.keys(req.body).length)
        return res.status(400).json({success:false,code:'F12_READ_ONLY_NO_CLIENT_EVIDENCE'});
      return res.json(await getF12Assessment(req.s03));
    }catch(e){return res.status(e?.status||403).json({success:false,code:e?.code||'F12_ASSESSMENT_UNAVAILABLE'});}
  });
}
