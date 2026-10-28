/** F11: authenticated, read-only GUI capability/readiness snapshot.
 * This is NOT a health probe, backend attestation, production authorization or
 * an inventory/snapshot guarantee. Never return connection addresses or keys.
 */
import {getGuiConnection} from './s10-gui-connections.js';

export const F11_STATES=Object.freeze({
  QDRANT:'qdrant',MILVUS:'milvus',LANCEDB:'lancedb',VECTRA:'vectra',NATIVE:'standard-native'
});
const SAFE_MODE='GUARDED_DEVELOPMENT_ONLY';
const pending=Object.freeze({normalInsert:false,normalUpdate:false,normalDelete:false,
  automaticVectorization:false,automaticPromptInjection:false,
  authoritativeInventory:false,verifiedFullBackup:false,restore:false,migration:false,purge:false});
function state(backend,connection,details={}){
  return {backend,connection,connectionHealth:'NOT_TESTED',...details,
    reads:'SOURCE_BOUND_V2_GUARDED',mutations:'DISPOSABLE_MANUAL_PILOT_ONLY',
    ...pending,productionCertified:false};
}
export async function getF11Readiness(context){
  if(!context?.userScopeId||!context?.vectorsPath)throw Error('F11_AUTHENTICATED_CONTEXT_REQUIRED');
  const [ql,qr,m]=await Promise.all([
    getGuiConnection(context,'qdrant','local'),
    getGuiConnection(context,'qdrant','default'),
    getGuiConnection(context,'milvus','default')
  ]);
  return {success:true,schemaVersion:1,mode:SAFE_MODE,
    userScopeVerified:true,backendHealthMeasured:false,productionWritesEnabled:false,
    backendCapabilitiesArePermissions:false,embeddingCredentialsManagedByPlugin:false,
    fullBackupAvailable:false,legacyMigrationAvailable:false,
    backends:{
      qdrant:state('qdrant',ql?'LOCAL_SAVED':'LOCAL_DEFAULT_AVAILABLE',{
        remoteProfileConfigured:!!qr,localProfileConfigured:!!ql,
        provisioning:'NEW_V2_COLLECTION_EXPLICIT_CONSENT',
        acceptance:'DISPOSABLE_LOCAL_ACCEPTANCE_ONLY'}),
      milvus:state('milvus',m?'SAVED_PROFILE':'NOT_CONFIGURED',{
        provisioning:'NEW_V2_COLLECTION_EXPLICIT_CONSENT',
        acceptance:'DISPOSABLE_LOCAL_ACCEPTANCE_ONLY'}),
      lancedb:state('lancedb','LOCAL_PLUGIN_MANAGED',{
        provisioning:'NEW_V2_TABLE_EXPLICIT_CONSENT',
        acceptance:'DISPOSABLE_SDK_HOST_TEST_REQUIRED'}),
      vectra:state('vectra','LOCAL_PLUGIN_MANAGED',{
        provisioning:'NEW_V2_INDEX_EXPLICIT_CONSENT',
        acceptance:'DISPOSABLE_SDK_HOST_TEST_REQUIRED'}),
      'standard-native':{
        backend:'standard-native',connection:'SILLYTAVERN_HOST_MANAGED',
        connectionHealth:'NOT_TESTED',reads:'NATIVE_LIST_QUERY_UNVERIFIED',
        mutations:'NATIVE_MUTATION_CONTRACT_UNPROBED',...pending,
        productionCertified:false
      }
    }};
}
export function registerF11ReadinessRoutes(router){
  router.get('/v2/setup/readiness',async(req,res)=>{
    try{res.json(await getF11Readiness(req.s03));}
    catch(e){res.status(e?.status||403).json({success:false,code:e?.code||'F11_READINESS_UNAVAILABLE'});}
  });
}
