import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectVectorRequest} from '../utils/e02-vector-request-gateway.js';
import {f03CollectionRequest,renderF03ProvisionPanel} from '../utils/f03-provision-client.js';
const source={kind:'chat',avatar:'a.png',chatFile:'b'};
const base={backend:'qdrant',source,embedding:{source:'transformers',model:'test',dimension:3,metric:'dot'},configId:'local'};
const url=s=>`/api/plugins/similharity/v2/collections/${s}`;
const opt=body=>({method:'POST',body:JSON.stringify(body)});
test('M0 F03 preview/status remain accessible but schema write goes through gateway',()=>{
 for(const op of ['preview','status'])assert.equal(inspectVectorRequest(url(op),opt(base)).allowed,true);
 const provision={...base,confirmProvision:true,expectedCollectionName:'vh2_'+'a'.repeat(48)};
 assert.throws(()=>inspectVectorRequest(url('provision'),opt(provision)));
 assert.throws(()=>inspectVectorRequest(url('provision'),opt({...provision,userScopeId:'attacker'})));
});
test('M0 F03 client cannot dispatch a provision mutation',async()=>{
 let calls=0;await assert.rejects(()=>f03CollectionRequest('provision',
  {...base,confirmProvision:true,expectedCollectionName:'vh2_'+'b'.repeat(48)}, {},async()=>{calls++;return {ok:true};}));
 assert.equal(calls,0);
});
test('F03 GUI renders schema setup controls, no auto-execution',async()=>{
 let count=0;const doc={createElement(tag){const element={tag,style:{},children:[],setAttribute(){},addEventListener(){},append(...items){this.children.push(...items);},prepend(){}};count++;return element;}};
 const root={querySelector(){return null;},prepend(){}};
 assert.equal(renderF03ProvisionPanel(root,()=>({}),doc),true);assert.ok(count>=10);
});
