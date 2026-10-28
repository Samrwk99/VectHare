/** Exercise actual E04 World Info module against simulated host and read-only backend. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import * as identities from '../utils/world-info-identity.js';
import {resolveExclusiveCollections} from '../core/retrieval-planner.js';

const source=fs.readFileSync(new URL('../core/world-info-integration.js',import.meta.url),'utf8');
async function host({metas={},results={}}={}) {
 const requests=[];
 const exports={
  '../../../../extensions.js':{extension_settings:{},getContext:()=>({chat:[],groupId:null,name2:'Bob',characterId:'char'})},
  './core-vector-api.js':{queryCollection:async(id,q,k)=>{requests.push({id,q,k});return results[id]||{metadata:[]};}},
  './collection-metadata.js':{getCollectionMeta:id=>metas[id]||{},isCollectionEnabled:()=>true,shouldCollectionActivate:async()=>true,
   applyChatCollectionPolicy:ids=>ids},
  './collection-ids.js':{parseRegistryKey:id=>({collectionId:id}),buildLorebookCollectionId:n=>`lorebook_${n}`},
  '../../../../../script.js':{setExtensionPrompt(){},getCurrentChatId:()=> 'chat-a'},
  './constants.js':{LEGACY_WORLD_INFO_PROMPT_TAG:'legacy-wi'},
  './conditional-activation.js':{buildSearchContext:()=>({currentChatId:'chat-a'})},
  '../utils/world-info-identity.js':identities,
  './retrieval-planner.js':{resolveExclusiveCollections}
 };
 const context=vm.createContext({console:{log(){},warn(){},error(){}},Date});
 const mod=new vm.SourceTextModule(source,{context});
 await mod.link(async spec=>{
  const e=exports[spec];
  if(!e)throw Error(`Unstubbed import ${spec}`);
  const names=Object.keys(e);
  return new vm.SyntheticModule(names,function(){for(const name of names)this.setExport(name,e[name]);},{context});
 });
 await mod.evaluate();return {getSemanticWorldInfoEntries:mod.namespace.getSemanticWorldInfoEntries,requests};
}
const settings=(ids,changes={})=>({enabled_world_info:true,vecthare_collection_registry:ids,world_info_threshold:.2,world_info_top_k:3,...changes});
test('E04 WI runtime: selects exactly one of two active exclusive lorebooks using priority',async()=>{
 const a='lorebook_a',b='lorebook_b',c='lorebook_c';
 const {getSemanticWorldInfoEntries,requests}=await host({metas:{[a]:{exclusiveWhenActive:true,retrievalPriority:2},[b]:{exclusiveWhenActive:true,retrievalPriority:8}},
  results:{[a]:{metadata:[{uid:'a',score:.9,text:'a'}]},[b]:{metadata:[{uid:'b',score:.8,text:'b'}]}}});
 const items=await getSemanticWorldInfoEntries(['q'],[],settings([a,b,c]));
 assert.equal(items.length,1);assert.deepEqual(requests.map(r=>r.id),[b]);
});
test('E04 WI runtime: multiple exclusives with equal priority pick deterministic ID',async()=>{
 const a='lorebook_a',b='lorebook_b';const {getSemanticWorldInfoEntries,requests}=await host({
  metas:{[a]:{exclusiveWhenActive:true},[b]:{exclusiveWhenActive:true}},
  results:{[a]:{metadata:[{uid:1,score:.9,text:'a'}]}}});
 await getSemanticWorldInfoEntries(['q'],[],settings([b,a]));
 assert.deepEqual(requests.map(r=>r.id),[a]);
});
test('E04 WI runtime: semantic duplicates within one world keep the highest score',async()=>{
 const id='lorebook_alpha';const {getSemanticWorldInfoEntries}=await host({
  metas:{[id]:{sourceName:'World'}},
  results:{[id]:{metadata:[{uid:7,score:.8,text:'best'},{uid:7,score:.6,text:'weaker'},{uid:8,score:.4,text:'distinct'}]}}});
 const records=await getSemanticWorldInfoEntries(['q'],[],settings([id]));
 assert.deepEqual(Array.from(records,r=>r.content),['best','distinct']);
});
test('E04 WI runtime: non-array keyword activation does not crash deduplication',async()=>{
 const id='lorebook_alpha';const {getSemanticWorldInfoEntries}=await host({
  metas:{[id]:{sourceName:'World'}},results:{[id]:{metadata:[{uid:7,score:.8,text:'keep'}]}}});
 const records=await getSemanticWorldInfoEntries(['q'],{activatedEntries:[]},settings([id]));
 assert.equal(records.length,1);
});
test('E04 WI runtime: topK and max entries are clamped to safe bounds',async()=>{
 const id='lorebook_alpha';const {getSemanticWorldInfoEntries,requests}=await host({
  results:{[id]:{metadata:[{uid:7,score:.8,text:'never injected'}]}}});
 const records=await getSemanticWorldInfoEntries(['q'],[],settings([id],{world_info_top_k:100000,world_info_max_entries:-1}));
 assert.equal(requests[0].k,100);assert.equal(records.length,0);
});
