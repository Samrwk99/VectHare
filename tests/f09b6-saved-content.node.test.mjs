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
test('M0 F09b.6 saved-content pilot is blocked until its M1 gateway migration',()=>{
 for(const input of [{...base,mode:'preview'},{...base,mode:'apply',itemIndex:0,
  sourceRevisionFingerprint:'a'.repeat(64),experimentalConsent:F09B6_CONSENT}])
  assert.throws(()=>inspect(input),{code:'VECTHARE_E02_OPERATION_DENIED'});
});
test('M0 F09b.6 legacy API cannot dispatch even for a read-only workflow preview',async()=>{
 assert.equal(validateF09b6Response(fake,'preview').sourceKind,'lorebook-entry');
 let calls=0;await assert.rejects(()=>f09b6Request({...base,mode:'preview'},{},async()=>{calls++;return {ok:true};}),
  {code:'VECTHARE_E02_OPERATION_DENIED'});
 assert.equal(calls,0);
 assert.throws(()=>validateF09b6Response({...fake,productionWritesEnabled:true},'preview'));
});
