/** F09b.8 cross-route browser-side policy rehearsal (no actual server). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectVectorRequest} from '../utils/e02-vector-request-gateway.js';
import {validateF09b6Response} from '../utils/f09b6-saved-content-gui.js';
import {validateF09b7Response} from '../utils/f09b7-link-conditions-gui.js';
const path='/api/plugins/similharity';
const embedding={source:'transformers',model:'f09b8-fixture',dimension:3,metric:'dot'};
const chat={kind:'chat',avatar:'Nina.png',chatFile:'one'};
const lore={kind:'lorebook',name:'my_lore'};
const base=source=>({backend:'qdrant',configId:'local',source,embedding});
const fingerprint='a'.repeat(64);
const request=(route,body,method='POST')=>inspectVectorRequest(`${path}${route}`,{method,body:JSON.stringify(body)});
test('M0 F09b.8 only read-only workflow selectors survive the gateway freeze',()=>{
 for(const [endpoint,body] of [
  ['/v2/workflows/chat-sync-pilot-apply',{...base(chat),sourceRevisionFingerprint:fingerprint,experimentalConsent:'I ACCEPT LOCAL CHAT SYNC PILOT'}],
  ['/v2/workflows/saved-content-pilot',{...base(lore),mode:'preview'}],
  ['/v2/workflows/saved-content-pilot',{...base(lore),mode:'apply',itemIndex:0,sourceRevisionFingerprint:fingerprint,experimentalConsent:'I ACCEPT SAVED CONTENT VECTOR PILOT'}],
  ['/chunks/purge',{...base(chat),text:'unsafe'}]])
  assert.throws(()=>request(endpoint,body),{code:'VECTHARE_E02_OPERATION_DENIED'});
 assert.equal(request('/v2/workflows/link-condition-preview',base(lore)).operation,'f09b7LinkConditionPreview');
});
test('F09b.8 browser rejects cross-workflow attempts to nominate records, owners, text, or URLs',()=>{
 const requests=[
  ['/v2/workflows/chat-sync-pilot-apply',{...base(chat),sourceRevisionFingerprint:fingerprint,
   experimentalConsent:'I ACCEPT LOCAL CHAT SYNC PILOT',recordId:'client-picked'}],
  ['/v2/workflows/saved-content-pilot',{...base(lore),mode:'preview',ownerId:'another-user'}],
  ['/v2/workflows/link-condition-preview',{...base(lore),vector:[1,2,3]}],
  ['/v2/workflows/link-condition-preview',{...base(lore),source:{...lore,path:'/etc/passwd'}}],
  ['/v2/workflows/saved-content-pilot',{...base(lore),mode:'apply',itemIndex:0,
   sourceRevisionFingerprint:fingerprint,experimentalConsent:'I ACCEPT SAVED CONTENT VECTOR PILOT',text:'forged'}],
 ];
 for(const [endpoint,body] of requests)assert.throws(()=>request(endpoint,body),{code:'VECTHARE_E02_OPERATION_DENIED'});
});
test('F09b.8 GUI validators reject false write grants, activation, or leak-prone unexpected entries',()=>{
 const saved={success:true,experimental:true,status:'READ_ONLY_SAVED_CONTENT_PLAN',sourceVerified:true,sourceKind:'lorebook-entry',
  recordIdentity:'V2_STABLE_SAVED_SOURCE_UUID',completeInventory:false,deletionsPlanned:false,automaticMutationsEnabled:false,
  productionWritesEnabled:false,sourceRevisionFingerprint:fingerprint,sourceItemsChecked:1,
  actions:[{recordId:'aaaaaaaa-aaaa-8aaa-8aaa-aaaaaaaaaaaa',action:'CREATE_PENDING_EMBEDDING',expectedRevision:0}],
  counts:{create:1,update:0,inSync:0}};
 assert.equal(validateF09b6Response(saved,'preview'),saved);
 assert.throws(()=>validateF09b6Response({...saved,productionWritesEnabled:true},'preview'));
 const links={success:true,experimental:true,status:'READ_ONLY_LINK_CONDITION_LIFECYCLE_PREVIEW',sourceVerified:true,
  sourceRevisionFingerprint:fingerprint,recordIdentity:'F09B6_STABLE_LORE_UID',entries:[],
  counts:{eligible:0,disabled:0,empty:0,unresolvedLinks:0},conditionEvaluation:'NOT_EVALUATED',linkActivation:'NOT_PERFORMED',
  completeInventory:false,deletionAuthority:false,automaticMutationsEnabled:false,productionWritesEnabled:false};
 assert.equal(validateF09b7Response(links),links);
 for(const x of [{...links,deletionAuthority:true},{...links,linkActivation:'ACTIVATED'},
  {...links,automaticMutationsEnabled:true},{...links,entries:[{text:'private source'}]}])
  assert.throws(()=>validateF09b7Response(x));
});
