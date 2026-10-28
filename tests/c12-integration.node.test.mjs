import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {normalizeSceneTimeline,weightChunksByCollection} from '../utils/c12-scene-temporal.js';
const root=path.dirname(fileURLToPath(new URL('../package.json',import.meta.url)));
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const SCOPED='standard:transformers:chat-abc',OTHER='standard:transformers:other';
const settings={vecthare:{}};
let saves=0;
async function timelineRuntime(){
 const context=vm.createContext({console});
 const source=read('core/scene-timeline.js');
 const mod=new vm.SourceTextModule(source,{context});
 await mod.link(async spec=>{
  let mock;
  if(spec.endsWith('/extensions.js'))mock={extension_settings:settings};
  else if(spec.endsWith('/script.js'))mock={saveSettingsDebounced:()=>{saves++;}};
  else if(spec==='../utils/collection-keys.js')mock={parseCollectionKey:key=>typeof key==='string'&&key.split(':').length===3?{key}:null};
  else if(spec==='../utils/c12-scene-temporal.js')mock={normalizeSceneTimeline};
  else if(spec==='../utils/record-identity.js')mock={reconcileSceneBoundaries:(scenes,chatId,chat)=>scenes.map(scene=>{
    const start=chat.findIndex(m=>m.uid===scene.metadata.sceneStartRef);
    const end=chat.findIndex(m=>m.uid===scene.metadata.sceneEndRef);
    return start<0||end<start?{status:'blocked'}:{status:'ready',metadata:{...scene.metadata,sceneStart:start,sceneEnd:end}};
  })};
  else throw Error(`Unexpected scene-timeline dependency ${spec}`);
  return new vm.SyntheticModule(Object.keys(mock),function(){Object.entries(mock).forEach(([k,v])=>this.setExport(k,v));},{context});
 });
 await mod.evaluate();return mod.namespace;
}

test('C12 timeline: committed scene persists by stable chat + qualified collection, no cross-chat leak',async()=>{
 const runtime=await timelineRuntime();
 assert.equal(runtime.rememberCommittedScene('chat-abc',SCOPED,{isScene:true,hash:9,sceneStart:1,sceneEnd:3}),true);
 assert.equal(saves,1);
 assert.equal(runtime.getSceneTimeline('chat-abc',SCOPED,Array(7).fill(null)).length,1);
 assert.equal(runtime.getSceneTimeline('chat-else',SCOPED,Array(7).fill(null)).length,0);
 assert.equal(runtime.getSceneTimeline('chat-abc',OTHER,Array(7).fill(null)).length,0);
});
test('C12 timeline: UI snapshot independent of retrieval and requires stable chat ID',async()=>{
 const runtime=await timelineRuntime();
 assert.equal(runtime.acceptSceneTimelineSnapshot('chat-abc',OTHER,[{hash:10,sceneStart:0,sceneEnd:2}]),true);
 assert.equal(runtime.getSceneTimeline('chat-abc',OTHER,Array(5).fill(null)).length,1);
 assert.equal(runtime.acceptSceneTimelineSnapshot('',OTHER,[]),false);
});
test('C12 timeline: stale scene UID anchors cannot fall back to old indices',async()=>{
 const runtime=await timelineRuntime();
 runtime.acceptSceneTimelineSnapshot('chat-abc',OTHER,[{hash:12,sceneStart:0,sceneEnd:1,sceneStartRef:'old',sceneEndRef:'end'}]);
 assert.equal(runtime.getSceneTimeline('chat-abc',OTHER,[{uid:'new'},{uid:'end'}]).length,0);
});
test('C12 timeline: stable UID anchors follow messages after insertion',async()=>{
 const runtime=await timelineRuntime();
 runtime.acceptSceneTimelineSnapshot('chat-abc',OTHER,[{hash:12,sceneStart:0,sceneEnd:1,sceneStartRef:'start',sceneEndRef:'end'}]);
 const rows=runtime.getSceneTimeline('chat-abc',OTHER,[{uid:'extra'},{uid:'start'},{uid:'middle'},{uid:'end'}]);
 assert.equal(rows.length,1);assert.equal(rows[0].start,1);assert.equal(rows[0].end,3);
});
test('C12 timeline: confirmed scene delete only removes matching scene from that chat',async()=>{
 const runtime=await timelineRuntime();
 runtime.rememberCommittedScene('chat-abc',SCOPED,{isScene:true,hash:66,sceneStart:4,sceneEnd:6});
 assert.equal(runtime.forgetCommittedScene('chat-abc',SCOPED,66),true);
 const remaining=runtime.getSceneTimeline('chat-abc',SCOPED,Array(8).fill(null));
 assert.equal(remaining.length,1);assert.equal(remaining[0].sceneId,'9');
 assert.equal(runtime.forgetCommittedScene('chat-abc',SCOPED,66),false);
});
function extractedFunction(source,name,env){
 const start=source.indexOf(`function ${name}(`);
 assert.notEqual(start,-1);
 const brace=source.indexOf('{',start);let depth=0,i=brace;
 for(;i<source.length;i++){if(source[i]==='{')depth++;else if(source[i]==='}'&&--depth===0)break;}
 const text=source.slice(start,i+1);
 return vm.runInNewContext(`(${text})`,{console,...env});
}
test('C12 live stage uses collection policy and chat timeline independent of retrieved scenes',()=>{
 const traces=[];
 const base={enabled:true,type:'decay',mode:'exponential',halfLife:10,minRelevance:0,sceneAware:true};
 const raw=[{collectionId:SCOPED,hash:1,score:0.7,metadata:{source:'chat',messageId:0}},
            {collectionId:OTHER,hash:1,score:0.7,metadata:{source:'chat',messageId:0}}];
 let timelineCalls=0;
 const stage=extractedFunction(read('core/chat-vectorization.js'),'applyTemporalDecayStage',{
  getVerifiedChatOriginId:()=> 'chat-abc',
  getCollectionDecaySettings:key=>key===SCOPED?base:{enabled:false},
  getSceneTimeline:()=>{timelineCalls++;return [{start:0,end:4}];},
  parseCollectionKey:key=>key===SCOPED || key===OTHER?{key}:null,
  formatCollectionKey:()=>SCOPED,
  weightChunksByCollection,
  applyDecayToResults:(items,current,p)=>items.map(item=>({...item,score:item.score*0.5,originalScore:item.score,decayApplied:true})),
  applyNostalgiaToResults:(items)=>items,
  applySceneAwareDecay:(items,current,scenes,p)=>items.map(item=>({...item,score:item.score*0.25,originalScore:item.score,sceneAwareDecay:true})),
  addTrace:(...args)=>traces.push(args),recordChunkFate:()=>{},
 });
 const result=stage(raw,Array(20).fill({}),{temporal_decay:{enabled:false},vector_backend:'standard',source:'transformers'},0,{});
 assert.equal(timelineCalls,1);
 assert.equal(result.find(c=>c.collectionId===SCOPED).score,0.175);
 assert.equal(result.find(c=>c.collectionId===OTHER).score,0.7);
 assert.ok(traces.some(args=>args[3]?.sceneSource==='chat_owned_timeline'));
});
test('C12 deletion removes advisory-only scene even without a persisted scene entry',async()=>{
 const runtime=await timelineRuntime();
 runtime.acceptSceneTimelineSnapshot('chat-abc',OTHER,[{hash:900,sceneStart:2,sceneEnd:4}]);
 assert.equal(runtime.forgetCommittedScene('chat-abc',OTHER,900),true);
 assert.equal(runtime.getSceneTimeline('chat-abc',OTHER,Array(6).fill(null)).length,0);
});
