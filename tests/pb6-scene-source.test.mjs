import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePb6SceneSnapshot,readPb6SavedScenes,registerPb6SceneRoutes} from '../lib/pb6-scene-source.js';
const source={kind:'chat',avatar:'alice.png',chatFile:'Day1'};
const a={send_date:'2026-01-01',name:'Alice',is_user:true,mes:'hello'};
const b={send_date:'2026-01-02',name:'Bob',is_user:false,mes:'there'};
const c={send_date:'2026-01-03',name:'Alice',is_user:true,mes:'end'};
const loc=m=>({sendDate:m.send_date,name:m.name,isUser:m.is_user});
const scene={id:'123e4567-e89b-42d3-a456-426614174000',start:loc(a),end:loc(c),title:'Morning'};
const bytes=(scenes=[scene],messages=[a,b,c])=>Buffer.from([JSON.stringify({chat_metadata:{vecthareManagedScenes:scenes}}),...messages.map(m=>JSON.stringify(m))].join('\n')+'\n');
test('P-B.6 saved scene annotations parse from the actual chat header, not vectors',()=>{
 const result=parsePb6SceneSnapshot(bytes());
 assert.deepEqual(result.scenes,[scene]);assert.equal(result.messageCount,3);
 assert.match(result.sceneRevision,/^[a-f0-9]{64}$/);
});
test('P-B.6 saved scene validation refuses ambiguous identities, missing boundaries, overlap and malformed metadata',()=>{
 const other={id:'123e4567-e89b-42d3-a456-426614174001',start:loc(a),end:loc(b),title:'Overlap'};
 for(const args of [
  {scenes:[scene,other]},
  {scenes:[scene],messages:[a,b,{...c,send_date:'other'}]},
  {scenes:[scene],messages:[a,b,c,{...c}]},
  {scenes:[{...scene,title:''}]},
  {scenes:[{...scene,start:loc(c),end:loc(a)}]},
  {scenes:[{...scene,foreign:true}]},
 ])assert.throws(()=>parsePb6SceneSnapshot(bytes(args.scenes,args.messages)),/PB6_/);
 assert.deepEqual(parsePb6SceneSnapshot(bytes([])).scenes,[]);
});
test('P-B.6 read verifies authenticated scope and exact saved-chat selector, never accepts arbitrary file path',async()=>{
 const req={s03:{userScopeId:'owner'},body:{source}};
 const read=async(request,actual)=>{assert.equal(request,req);assert.deepEqual(actual,source);return {fileHash:'a'.repeat(64),bytes:bytes()};};
 const value=await readPb6SavedScenes(req,{read});
 assert.equal(value.readOnly,true);assert.equal(value.vectorSceneRecordsVerified,false);
 assert.equal(value.fileFingerprint,'a'.repeat(64));
 for(const body of [{source:{...source,filepath:'/etc/passwd'}},{source:{kind:'lorebook',name:'x'}},{source,vector:[1,2]}])
  await assert.rejects(()=>readPb6SavedScenes({...req,body},{read}),/PB6_SOURCE_SELECTOR_INVALID/);
 await assert.rejects(()=>readPb6SavedScenes({...req,s03:null},{read}),/PB6_AUTH_REQUIRED/);
});
test('P-B.6 registered route is only a read and returns structured failures',async()=>{
 const routes={};registerPb6SceneRoutes({post:(p,fn)=>routes[p]=fn},{read:async()=>({fileHash:'b'.repeat(64),bytes:bytes()})});
 const res={statusCode:200,status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}};
 await routes['/v2/pb6/scenes/read']({s03:{userScopeId:'u'},body:{source}},res);
 assert.equal(res.statusCode,200);assert.equal(res.body.success,true);
 await routes['/v2/pb6/scenes/read']({s03:{userScopeId:'u'},body:{source:{kind:'bogus'}}},res);
 assert.equal(res.statusCode,400);assert.equal(res.body.code,'PB6_SOURCE_SELECTOR_INVALID');
});
