import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {f02Read,f02CurrentChatSelector} from '../utils/f02-public-read-client.js';
const root='/api/plugins/similharity/v2/reads/';
const base={backend:'qdrant',source:{kind:'chat',avatar:'Nina.png',chatFile:'one'},
 embedding:{source:'transformers',model:'exact-model',dimension:3,metric:'cosine'},configId:'local'};
test('F02 allows only scoped read and binding routes; no inferred global write/legacy permission',()=>{
 for(const suffix of ['bind','list','query','get']){
  const body={...base,...(suffix==='list'?{page:{limit:2}}:suffix==='query'?{vector:[1,2,3]}:suffix==='get'?{recordId:'00000000-0000-4000-8000-000000000000'}:{})};
  assert.equal(inspectVectorRequest(root+suffix,{method:'POST',body:JSON.stringify(body)}).allowed,true);
  assert.throws(()=>inspectVectorRequest(root+suffix,{method:'GET'}),VectorOperationDenied);
  for(const injected of ['userScopeId','scope','physicalCollectionName','apiKey'])
   assert.throws(()=>inspectVectorRequest(root+suffix,{method:'POST',body:JSON.stringify({...body,[injected]:'spoof'})}),VectorOperationDenied);
 }
 for(const forbidden of ['inventory','export','delete','insert','clear'])
  assert.throws(()=>inspectVectorRequest(root+forbidden,{method:'POST',body:JSON.stringify(base)}),VectorOperationDenied);
});
test('F02 read uses same-origin headers and refuses overclaimed permissions',async()=>{
 let called;
 const output=await f02Read('list',{...base,page:{limit:3}},{'X-CSRF-Token':'test'},async(u,o)=>{
  called={u,o};return {ok:true,json:async()=>({success:true,scopeVerified:true,inventoryVerified:false,productionWritesEnabled:false,data:{items:[]}})};
 });
 assert.deepEqual(output.data.items,[]);
 assert.equal(called.u,root+'list');assert.equal(called.o.credentials,'same-origin');
 assert.deepEqual(JSON.parse(called.o.body).source,base.source);
 await assert.rejects(()=>f02Read('list',base,{},async()=>({ok:true,json:async()=>({success:true,scopeVerified:true,inventoryVerified:true,productionWritesEnabled:false})})),/F02_CAPABILITY_OVERCLAIM/);
 await assert.rejects(()=>f02Read('bind',base,{},async()=>({ok:true,json:async()=>({success:true,inventoryVerified:false,productionWritesEnabled:false,physicalCollectionProvisioned:true})})),/F02_BIND_OVERCLAIM/);
 await assert.rejects(()=>f02Read('list',base,{},async()=>({ok:false,status:409,json:async()=>({code:'F02_COLLECTION_NOT_BOUND'})})),/F02_COLLECTION_NOT_BOUND/);
});
test('F02 active chat selector is a hint; copied ID never becomes authorization',async()=>{
 const context={characters:[{avatar:'Nina.png'}],characterId:0};
 const s=await f02CurrentChatSelector({getChatId:()=> 'one',getContext:()=>context});
 assert.deepEqual(s,{kind:'chat',avatar:'Nina.png',chatFile:'one'});
 assert.deepEqual(await f02CurrentChatSelector({getChatId:()=> 'branch',getContext:()=>({...context,groupId:'group-1'})}),
  {kind:'group-chat',chatFile:'branch',groupId:'group-1'});
 await assert.rejects(()=>f02CurrentChatSelector({getChatId:()=>null,getContext:()=>context}),/F02_CHAT_UNSAVED/);
});
test('F02 controls render in the existing SillyTavern GUI without executing mutations',async()=>{
 const {renderF02ReadPanel}=await import('../utils/f02-public-read-client.js');
 const registry=new Map();
 const make=(tag)=>({tag,children:[],attrs:{},addEventListener(name,fn){this['on_'+name]=fn;},
   setAttribute(name,value){this.attrs[name]=value;},append(...values){this.children.push(...values);},
   prepend(...values){this.children.unshift(...values);},querySelector(sel){return registry.get(sel)||null;}});
 const root=make('root');root.prepend=(item)=>{registry.set('#'+item.id,item);root.children.unshift(item);};
 const doc={createElement:make};
 assert.equal(renderF02ReadPanel(root,()=>({source:'transformers'}),doc),true);
 assert.equal(renderF02ReadPanel(root,()=>({source:'transformers'}),doc),false);
 const controls=root.children[0].children.filter(c=>c.tag==='button');
 assert.equal(controls.length,4);
 assert.ok(controls.every(b=>typeof b.on_click==='function'));
});
