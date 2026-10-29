import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectVectorRequest} from '../utils/e02-vector-request-gateway.js';
import {f09b6Request,validateF09b6Response,F09B6_CONSENT} from '../utils/f09b6-saved-content-gui.js';
const root='/api/plugins/similharity/v2/workflows/saved-content-pilot';
const embedding={source:'transformers',model:'model-1',dimension:3,metric:'dot'};
const base={backend:'qdrant',configId:'local',source:{kind:'lorebook',name:'lore'},embedding};
const recordId='bbbbbbbb-bbbb-8bbb-8bbb-bbbbbbbbbbbb';
const fake={success:true,experimental:true,productionWritesEnabled:false,
 status:'READ_ONLY_SAVED_CONTENT_PLAN',sourceVerified:true,sourceKind:'lorebook-entry',recordIdentity:'V2_STABLE_SAVED_SOURCE_UUID',
 completeInventory:false,deletionsPlanned:false,automaticMutationsEnabled:false,sourceRevisionFingerprint:'a'.repeat(64),
 actions:[{recordId,action:'CREATE_PENDING_EMBEDDING',expectedRevision:0}],counts:{create:1,update:0,inSync:0},sourceItemsChecked:1};
const inspect=body=>inspectVectorRequest(root,{method:'POST',body:JSON.stringify(body)});
test('F09b.6 gateway permits only explicit server-source preview/one-item pilots',()=>{
 assert.equal(inspect({...base,mode:'preview'}).operation,'f09b6SavedContentPilot');
 assert.equal(inspect({...base,mode:'apply',itemIndex:0,sourceRevisionFingerprint:'a'.repeat(64),experimentalConsent:F09B6_CONSENT}).allowed,true);
 for(const bad of [{text:'forged'}, {vector:[1,2,3]},{recordId}, {ownerId:'fake'}, {physicalCollection:'private'},
  {source:{kind:'lorebook',name:'../secret'}}, {source:{kind:'lorebook',name:'lore',filepath:'/tmp/x'}},
  {mode:'apply',itemIndex:0,experimentalConsent:F09B6_CONSENT,sourceRevisionFingerprint:'bad'}]){
   assert.throws(()=>inspect({...base,mode:'preview',...bad}));
  }
});
test('F09b.6 browser accepts only fully validated read-only previews',async()=>{
 assert.equal(validateF09b6Response(fake,'preview').sourceKind,'lorebook-entry');
 await f09b6Request({...base,mode:'preview'},{},async(url,options)=>{
  assert.equal(url,root);assert.equal(options.headers['X-VectHare-F09b6-Pilot'],'1');
  return {ok:true,json:async()=>fake};
 });
 for(const changes of [{productionWritesEnabled:true},{completeInventory:true},{sourceVerified:false},
  {actions:[{recordId,action:'DELETE',expectedRevision:1}]}, {sourceRevisionFingerprint:'bad'}])
  assert.throws(()=>validateF09b6Response({...fake,...changes},'preview'));
 await assert.rejects(f09b6Request({...base,mode:'preview'},{},async()=>({ok:false,json:async()=>({code:'F09B6_REFUSED'})})),/F09B6_REFUSED/);
});
