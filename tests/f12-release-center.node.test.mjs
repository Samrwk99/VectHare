import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {f12AssessmentRequest,validateF12Assessment,renderF12ReleaseCenter} from '../utils/f12-release-center.js';
const route='/api/plugins/similharity/v2/release/assessment';
const ids=['host_authenticated_source_isolation','branch_identity_independence',
 'normal_memory_create_read_edit_delete','automatic_chat_sync_and_reindex',
 'summary_and_world_info_workflows','embedding_gui_credentials_and_generation',
 'retrieval_final_prompt_injection','external_writer_and_stale_revision_safety',
 'crash_restart_and_uncertain_operation_recovery','authoritative_inventory_and_full_backup_restore',
 'legacy_migration_and_rollback','windows_linux_termux_host_acceptance'];
const names=['qdrant','lancedb','vectra','standard-native','milvus'];
const report={success:true,schemaVersion:1,checkpoint:'F12',verdict:'NO_GO',releaseCertified:false,hostAcceptanceProven:false,
 liveEvidenceAttached:false,credentialsIncluded:false,productionWritesEnabled:false,userScopeVerified:true,
 evidenceSource:'SERVER_IMPLEMENTATION_STATE_ONLY',requiredChecks:ids.map(id=>({id,status:'NOT_VERIFIED'})),
 backends:Object.fromEntries(names.map(n=>[n,{backend:n,configured:'LOCAL_PLUGIN_MANAGED',health:'NOT_TESTED_BY_F12',releaseStatus:'NOT_CERTIFIED',normalMutationsAllowed:false,
 checks:Array.from({length:5},(_,i)=>({id:'test_'+i,status:'NOT_VERIFIED'}))}]))};
test('F12 gateway permits only GET with no arguments or body',()=>{
 assert.equal(inspectVectorRequest(route,{method:'GET'}).allowed,true);
 for(const [url,options] of [[route,{method:'POST'}],[route,{method:'GET',body:'{}'}],
  [route+'?certify=true',{method:'GET'}],[route.replace('assessment','activate'),{method:'POST',body:'{}'}]])
  assert.throws(()=>inspectVectorRequest(url,options),VectorOperationDenied);
});
test('F12 refuses optimistic verdicts or simulated green host status',()=>{
 assert.equal(validateF12Assessment(report).verdict,'NO_GO');
 for(const changed of [{...report,verdict:'GO'},{...report,releaseCertified:true},
  {...report,hostAcceptanceProven:true},{...report,productionWritesEnabled:true},
  {...report,requiredChecks:report.requiredChecks.map(x=>({...x,status:'PASS'}))},
  {...report,backends:{...report.backends,qdrant:{...report.backends.qdrant,normalMutationsAllowed:true}}}])
  assert.throws(()=>validateF12Assessment(changed),/F12_UNTRUSTED/);
});
test('F12 request performs authenticated, cache-bypassed read only',async()=>{
 const calls=[];const result=await f12AssessmentRequest({'X-CSRF-Token':'abc'},async(url,options)=>{calls.push([url,options]);return {ok:true,json:async()=>report};});
 assert.equal(result.verdict,'NO_GO');assert.equal(calls.length,1);assert.equal(calls[0][0],route);
 assert.equal(calls[0][1].method,'GET');assert.equal(calls[0][1].body,undefined);
 assert.equal(calls[0][1].credentials,'same-origin');assert.equal(calls[0][1].cache,'no-store');
});
test('F12 GUI is inert on render',()=>{
 const callbacks=[];const doc={createElement:tag=>({tag,append(){},addEventListener:event=>callbacks.push(event),setAttribute(){}})};
 assert.equal(renderF12ReleaseCenter({querySelector:()=>null,prepend(){}},{},doc),true);
 assert.deepEqual(callbacks,['click']);
});
