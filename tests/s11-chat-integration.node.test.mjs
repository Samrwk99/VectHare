import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {observeChatFork} from '../utils/s11-chat-fork-observer.js';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function load(){
 const data=new Map(),storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
 const host={chatId:'chat-one',chat_metadata:{integrity:'copied-uuid'}, name2:'Alice'};
 const context=vm.createContext({console,localStorage:storage});
 const source=await fs.readFile(path.join(ROOT,'core/collection-ids.js'),'utf8');
 const file=new vm.SourceTextModule(source,{context,identifier:'collection-ids.js'});
 await file.link(async spec=>{
  const values=spec==='../../../../extensions.js'?{getContext:()=>({name2:host.name2})}:
   spec==='../../../../../script.js'?{getCurrentChatId:()=>host.chatId,chat_metadata:host.chat_metadata}:
   spec==='../utils/s11-chat-fork-observer.js'?{observeChatFork}:null;
  if(!values)throw new Error(`unexpected import ${spec}`);
  return new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v] of Object.entries(values))this.setExport(k,v);},{context});
 });
 await file.evaluate();return {ids:file.namespace,host};
}
test('S11 collection IDs stop using a reused chat integrity',async()=>{
 const {ids,host}=await load();
 assert.equal(ids.getVerifiedChatOriginId(),'copied-uuid');
 assert.match(ids.buildChatCollectionId(),/copied-uuid$/);
 host.chatId='chat-two';
 assert.equal(ids.getVerifiedChatOriginId(),null);
 assert.equal(ids.getChatIdentityObservation().status,'QUARANTINED');
 assert.equal(ids.getChatUUID(),null);
 assert.equal(ids.buildChatCollectionId(),null);
 host.chatId='chat-one';
 assert.equal(ids.getVerifiedChatOriginId(),null,'original chat also quarantined');
});
test('S11 independent fork integrity provides independent collection IDs',async()=>{
 const {ids,host}=await load();
 const a=ids.buildChatCollectionId();
 host.chatId='chat-two';host.chat_metadata.integrity='new-uuid';
 const b=ids.buildChatCollectionId();
 assert.notEqual(a,b);assert.ok(a);assert.ok(b);
});
