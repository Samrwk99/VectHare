import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectVectorRequest} from '../utils/e02-vector-request-gateway.js';
import {f03CollectionRequest,renderF03ProvisionPanel} from '../utils/f03-provision-client.js';
const source={kind:'chat',avatar:'a.png',chatFile:'b'};
const base={backend:'qdrant',source,embedding:{source:'transformers',model:'test',dimension:3,metric:'dot'},configId:'local'};
const url=s=>`/api/plugins/similharity/v2/collections/${s}`;
const opt=body=>({method:'POST',body:JSON.stringify(body)});
test('F03 GUI gateway allows only source-scoped preview and confirmed new schema provisioning',()=>{
 for(const op of ['preview','provision','status']){
  const body={...base,...(op==='provision'?{confirmProvision:true,expectedCollectionName:'vh2_'+'a'.repeat(48)}:{})};
  assert.equal(inspectVectorRequest(url(op),opt(body)).allowed,true);
 }
 for(const body of [{...base,collectionName:'arbitrary'},
  {...base,source:{kind:'chat',avatar:'a.png',chatFile:'b',userScopeId:'victim'}},
  {...base,confirmProvision:false,expectedCollectionName:'vh2_'+'a'.repeat(48)}]){
  assert.throws(()=>inspectVectorRequest(url('provision'),opt(body)));
 }
 assert.throws(()=>inspectVectorRequest(url('provision'),opt(base)));
 assert.throws(()=>inspectVectorRequest(url('delete'),opt({...base,confirmProvision:true})));
});
test('F03 GUI rejects overclaimed writes and fake physical provisioning',async()=>{
 const calls=[];const fetchImpl=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({success:true,backendCertified:false,
   productionWritesEnabled:false,collectionName:'vh2_'+'b'.repeat(48),physicalCollectionProvisioned:false,consentRequired:true})};};
 const result=await f03CollectionRequest('preview',base,{},fetchImpl);
 assert.equal(result.consentRequired,true);assert.equal(calls.length,1);
 assert.equal(calls[0].options.credentials,'same-origin');
 await assert.rejects(()=>f03CollectionRequest('provision',{...base,confirmProvision:true,expectedCollectionName:'vh2_'+'b'.repeat(48)}, {},fetchImpl),/F03_PROVISION_RESPONSE_UNVERIFIED/);
});
test('F03 GUI renders schema setup controls, no auto-execution',async()=>{
 let count=0;const doc={createElement(tag){const element={tag,style:{},children:[],setAttribute(){},addEventListener(){},append(...items){this.children.push(...items);},prepend(){}};count++;return element;}};
 const root={querySelector(){return null;},prepend(){}};
 assert.equal(renderF03ProvisionPanel(root,()=>({}),doc),true);assert.ok(count>=10);
});
