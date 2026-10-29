import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectVectorRequest} from '../utils/e02-vector-request-gateway.js';
import {validateF09b7Response,f09b7Preview} from '../utils/f09b7-link-conditions-gui.js';
const payload={backend:'qdrant',configId:'local',source:{kind:'lorebook',name:'test'},embedding:{source:'transformers',model:'host',dimension:3,metric:'dot'}};
const response={success:true,experimental:true,status:'READ_ONLY_LINK_CONDITION_LIFECYCLE_PREVIEW',sourceVerified:true,
 sourceRevisionFingerprint:'a'.repeat(64),recordIdentity:'F09B6_STABLE_LORE_UID',entries:[],
 counts:{eligible:0,disabled:0,empty:0,unresolvedLinks:0},conditionEvaluation:'NOT_EVALUATED',linkActivation:'NOT_PERFORMED',
 completeInventory:false,deletionAuthority:false,automaticMutationsEnabled:false,productionWritesEnabled:false};
test('F09b.7 gateway permits only read-only owned lorebook selector',()=>{
 const p='/api/plugins/similharity/v2/workflows/link-condition-preview';
 assert.equal(inspectVectorRequest(p,{method:'POST',body:JSON.stringify(payload)}).operation,'f09b7LinkConditionPreview');
 for(const b of [{...payload,text:'fake'},{...payload,source:{...payload.source,recordId:'fake'}},
  {...payload,embedding:{...payload.embedding,apiKey:'secret'}}]){
  assert.throws(()=>inspectVectorRequest(p,{method:'POST',body:JSON.stringify(b)}));
 }
});
test('F09b.7 GUI request and strict response validation preserve read-only status',async()=>{
 assert.equal(validateF09b7Response(response),response);
 await f09b7Preview(payload,{},async(url,options)=>{
  assert.match(url,/link-condition-preview/);assert.equal(options.method,'POST');
  assert.equal(options.headers['X-VectHare-F09b7-Preview'],'1');
  return {ok:true,json:async()=>response};
 });
 for(const bad of [{...response,productionWritesEnabled:true},{...response,conditionEvaluation:'ALLOWED'},
  {...response,entries:[{recordId:'fake'}]}])assert.throws(()=>validateF09b7Response(bad));
});
