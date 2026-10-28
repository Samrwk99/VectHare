import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {f11ReadinessRequest,validateF11Readiness,renderF11SetupCenter,groupF11DeveloperPanels} from '../utils/f11-setup-center.js';
const root='/api/plugins/similharity/v2/setup/readiness';
const backendNames=['qdrant','milvus','lancedb','vectra','standard-native'];
const denied={normalInsert:false,normalUpdate:false,normalDelete:false,automaticVectorization:false,
 automaticPromptInjection:false,authoritativeInventory:false,verifiedFullBackup:false,restore:false,
 migration:false,purge:false,productionCertified:false};
const backend=name=>({backend:name,connection:'LOCAL_PLUGIN_MANAGED',connectionHealth:'NOT_TESTED',
 reads:'GUARDED',mutations:'PILOT_ONLY',...denied});
const report={success:true,schemaVersion:1,mode:'GUARDED_DEVELOPMENT_ONLY',userScopeVerified:true,
 backendHealthMeasured:false,productionWritesEnabled:false,backendCapabilitiesArePermissions:false,
 fullBackupAvailable:false,legacyMigrationAvailable:false,embeddingCredentialsManagedByPlugin:false,
 backends:Object.fromEntries(backendNames.map(n=>[n,backend(n)]))};
test('F11 readiness is GET only, rejects body, URL query and dangerous routes',()=>{
 assert.equal(inspectVectorRequest(root,{method:'GET'}).allowed,true);
 for(const [url,opt] of [[root,{method:'POST'}],[root,{method:'GET',body:'{}'}],
  [root+'?owner=other',{method:'GET'}]])assert.throws(()=>inspectVectorRequest(url,opt),VectorOperationDenied);
 assert.throws(()=>inspectVectorRequest(root.replace('readiness','enable'),{method:'GET'}),VectorOperationDenied);
});
test('F11 client never treats optimistic readiness or backend permission as valid',()=>{
 assert.equal(validateF11Readiness(report).backendHealthMeasured,false);
 for(const changed of [{...report,productionWritesEnabled:true},
  {...report,backendHealthMeasured:true},{...report,fullBackupAvailable:true},
  {...report,embeddingCredentialsManagedByPlugin:true},
  {...report,backends:{...report.backends,qdrant:{...report.backends.qdrant,normalInsert:true}}},
  {...report,backends:{...report.backends,qdrant:{...report.backends.qdrant,connectionHealth:'HEALTHY'}}}])
  assert.throws(()=>validateF11Readiness(changed),/F11_UNVERIFIED/);
});
test('F11 refresh requests only authenticated GET; never sends secret or payload',async()=>{
 const calls=[];const result=await f11ReadinessRequest({'X-CSRF-Token':'token'},async(url,opt)=>{
  calls.push({url,opt});return {ok:true,json:async()=>report};});
 assert.equal(result.success,true);assert.equal(calls.length,1);
 assert.equal(calls[0].url,root);assert.equal(calls[0].opt.method,'GET');
 assert.equal(calls[0].opt.credentials,'same-origin');assert.equal(calls[0].opt.body,undefined);
});
test('F11 UI is inert until explicit refresh, never runs diagnostic mutation automatically',()=>{
 let counter=0;const elements=[];
 const doc={createElement:tag=>{const e={tag,append(){},addEventListener(event,cb){if(event==='click')counter++;},
  setAttribute(){},style:{}};elements.push(e);return e;}};
 const root={querySelector:()=>null,prepend(){}};
 assert.equal(renderF11SetupCenter(root,{},doc),true);
 assert.equal(counter,1);
});
test('F11 developer tool grouping moves existing controls without deleting them',()=>{
 const old={id:'vecthare_f10_recovery'},children=[],root={querySelector:selector=>selector==='#vecthare_f10_recovery'?old:selector==='#vecthare_f11_developer_tools'?null:null,prepend(item){children.push(item)}};
 const doc={createElement:tag=>({tag,append(item){this.children??=[];this.children.push(item);item.parentElement=this;}})};
 assert.equal(groupF11DeveloperPanels(root,doc),1);
 assert.equal(children.length,1);assert.ok(children[0].children.includes(old));
});
