import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {attestHostSource,registerF01HostRoutes} from '../lib/f01-host-sources.js';

async function fixture(fn){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vh-f01-'));
 try{
  const root=path.join(dir,'alice');const chats=path.join(root,'chats');const groupChats=path.join(root,'group chats');const worlds=path.join(root,'worlds');const vectors=path.join(root,'vectors');const groups=path.join(root,'groups');const characters=path.join(root,'characters');
  for(const folder of [chats,groupChats,worlds,vectors,groups,characters,path.join(chats,'Nina')])await fs.mkdir(folder,{recursive:true});
  await fs.writeFile(path.join(characters,'Nina.png'),'avatar');
  await fs.writeFile(path.join(groups,'group-1.json'),JSON.stringify({id:'group-1',chats:['shared']}));
  const req={user:{profile:{handle:'alice'},directories:{root,chats,groupChats,worlds,vectors,groups,characters}},s03:{userScopeId:'alice',vectorsPath:vectors}};
  const writeChat=(name,meta={integrity:'copied-uuid'},folder=path.join(chats,'Nina'))=>fs.writeFile(path.join(folder,`${name}.jsonl`),JSON.stringify({chat_metadata:meta})+'\n'+JSON.stringify({mes:'example'})+'\n');
  await fn({root,chats,groupChats,worlds,vectors,groups,characters,req,writeChat,dir});
 }finally{await fs.rm(dir,{force:true,recursive:true});}
}
const select=name=>({kind:'chat',avatar:'Nina.png',chatFile:name});
async function rejected(p,code){await assert.rejects(p,e=>e?.code===code,`expected ${code}`);}

test('F01 persists distinct branches even when SillyTavern copies integrity',()=>fixture(async({req,writeChat})=>{
 await writeChat('original');await writeChat('branch',{integrity:'copied-uuid',main_chat:'original'});
 const a=await attestHostSource(req,select('original'));
 const b=await attestHostSource(req,select('branch'));
 assert.notEqual(a.scope.sourceId,b.scope.sourceId);assert.notEqual(a.scope.collectionId,b.scope.collectionId);
 assert.equal(b.scope.branchId,b.scope.sourceId);assert.equal(a.scope.branchId,undefined);
 assert.equal(b.copiedIntegrityObserved,true);assert.equal(a.publicWritesEnabled,false);
 const again=await attestHostSource(req,select('original'));assert.equal(a.sourceId,again.sourceId);
}));
test('F01 stable across atomic chat file replacement with unchanged metadata',()=>fixture(async({req,writeChat,chats})=>{
 await writeChat('one');const first=await attestHostSource(req,select('one'));
 const other=path.join(chats,'Nina','other.jsonl');await fs.writeFile(other,JSON.stringify({chat_metadata:{integrity:'copied-uuid'}})+'\n');
 await fs.rename(other,path.join(chats,'Nina','one.jsonl'));
 const again=await attestHostSource(req,select('one'));assert.equal(again.sourceId,first.sourceId);
}));
test('F01 preserves identity on verified same-file rename',()=>fixture(async({req,writeChat,chats})=>{
 await writeChat('old');const a=await attestHostSource(req,select('old'));
 await fs.rename(path.join(chats,'Nina','old.jsonl'),path.join(chats,'Nina','new.jsonl'));
 const b=await attestHostSource(req,select('new'));assert.equal(a.sourceId,b.sourceId);
}));
test('F01 fails closed when a different chat replaces registered file',()=>fixture(async({req,writeChat})=>{
 await writeChat('old');await attestHostSource(req,select('old'));
 await writeChat('old',{integrity:'different'});
 await rejected(attestHostSource(req,select('old')),'F01_SOURCE_CHANGED');
}));
test('F01 rejects traversal and invalid avatar, unknown kinds',()=>fixture(async({req})=>{
 await rejected(attestHostSource(req,select('../escape')),'F01_INVALID_SELECTOR');
 await rejected(attestHostSource(req,{kind:'chat',chatFile:'test',avatar:'../Nina.png'}),'F01_INVALID_SELECTOR');
 await rejected(attestHostSource(req,{kind:'scene',sceneId:'anything'}),'F01_INVALID_SELECTOR');
 await rejected(attestHostSource(req,{kind:'lorebook',name:'foo',userScopeId:'other'}),'F01_INVALID_SELECTOR');
}));
test('F01 confirms a lorebook only inside authenticated worlds directory',()=>fixture(async({req,worlds})=>{
 await fs.writeFile(path.join(worlds,'adventure.json'),'{}');
 const lore=await attestHostSource(req,{kind:'lorebook',name:'adventure'});
 assert.equal(lore.scope.type,'lore');assert.equal(lore.publicReadsEnabled,false);
 await rejected(attestHostSource(req,{kind:'lorebook',name:'missing'}),'F01_SOURCE_NOT_FOUND');
}));
test('F01 group chats are separate from solo chats',()=>fixture(async({req,writeChat,groupChats})=>{
 await writeChat('shared');await writeChat('shared',{integrity:'copied-uuid'},groupChats);
 const a=await attestHostSource(req,select('shared'));
 const b=await attestHostSource(req,{kind:'group-chat',chatFile:'shared',groupId:'group-1'});
 assert.notEqual(a.sourceId,b.sourceId);
}));
test('F01 detects missing registry after initialization',()=>fixture(async({req,writeChat,vectors})=>{
 await writeChat('one');await attestHostSource(req,select('one'));
 await fs.unlink(path.join(vectors,'.similharity','f01-host-sources.json'));
 await rejected(attestHostSource(req,select('one')),'F01_REGISTRY_LOST');
}));
test('F01 denies symlinked source and cross-user source dir',()=>fixture(async({req,writeChat,dir,chats})=>{
 await writeChat('one');await fs.symlink(path.join(chats,'Nina','one.jsonl'),path.join(chats,'Nina','linked.jsonl'));
 await rejected(attestHostSource(req,select('linked')),'F01_SOURCE_LINK_REJECTED');
 const other=path.join(dir,'bob');await fs.mkdir(other);
 req.user.directories.chats=other;
 await rejected(attestHostSource(req,select('one')),'F01_SOURCE_OUTSIDE_USER_ROOT');
}));
test('F01 public route stays read-only and hides host paths',()=>fixture(async({req,writeChat})=>{
 await writeChat('one');const routes={};registerF01HostRoutes({post:(p,f)=>routes[p]=f});
 const res={statusCode:200,status(x){this.statusCode=x;return this;},json(x){this.payload=x;return this;}};
 await routes['/v2/sources/attest']({...req,body:select('one')},res);
 assert.equal(res.statusCode,200);assert.equal(res.payload.hostSourceOwnerVerified,true);
 assert.equal(res.payload.activeChatVerified,false);assert.equal(res.payload.publicWritesEnabled,false);
 assert.ok(!JSON.stringify(res.payload).includes(req.user.directories.root));
}));
test('F01 permits a newly saved empty chat containing only a metadata header',()=>fixture(async({req,chats})=>{
 await fs.writeFile(path.join(chats,'Nina','empty.jsonl'),JSON.stringify({chat_metadata:{integrity:'empty-id'}}));
 const result=await attestHostSource(req,select('empty'));assert.equal(result.hostSourceOwnerVerified,true);
}));
test('F01 refuses group claims when chat is not a member of that group',()=>fixture(async({req,groupChats,writeChat})=>{
 await writeChat('foreign',{integrity:'id'},groupChats);
 await rejected(attestHostSource(req,{kind:'group-chat',chatFile:'foreign',groupId:'group-1'}),'F01_GROUP_UNVERIFIED');
}));
test('F01 refuses mismatched host user context before touching source files',()=>fixture(async({req,writeChat})=>{
 await writeChat('one');req.s03.userScopeId='bob';
 await rejected(attestHostSource(req,select('one')),'F01_AUTH_REQUIRED');
}));
test('F01 refuses a character directory symlink escaping the authenticated root',()=>fixture(async({req,dir,characters,chats,writeChat})=>{
 await writeChat('one');
 const outside=path.join(dir,'outside-characters');await fs.mkdir(outside);
 await fs.writeFile(path.join(outside,'Nina.png'),'outside');
 await fs.rm(characters,{recursive:true});await fs.symlink(outside,characters);
 await rejected(attestHostSource(req,select('one')),'F01_SOURCE_OUTSIDE_USER_ROOT');
}));
