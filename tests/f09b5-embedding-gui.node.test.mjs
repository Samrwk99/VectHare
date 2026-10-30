import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectVectorRequest} from '../utils/e02-vector-request-gateway.js';
import {getEmbeddingProfile,saveEmbeddingProfile,testEmbeddingProfile,deleteEmbeddingProfile} from '../utils/f09b5-embedding-gui.js';
const root='/api/plugins/similharity/v2/embeddings';
test('M0 F09b.5 browser transport permits inspection/test, blocks profile edits',()=>{
 for(const [suffix,method,body] of [['profile','GET',undefined],['test','POST',{}]]){
  const result=inspectVectorRequest(`${root}/${suffix}`,{method,...(body?{body:JSON.stringify(body)}:{})});
  assert.equal(result.allowed,true);assert.equal(result.operation,'f09b5EmbeddingConfiguration');
 }
 for(const [suffix,method,body] of [['profile','PUT',{source:'openai',model:'m',dimension:3,metric:'cosine'}],
  ['profile','DELETE',undefined],['test','POST',{text:'SECRET'}],['test','GET',null],
  ['profile','PUT',{apiUrl:'http://localhost'}],['profile','POST',{}]]){
  assert.throws(()=>inspectVectorRequest(`${root}/${suffix}`,{method,...(body?{body:JSON.stringify(body)}:{})}));
 }
});
test('M0 F09b.5 client refuses credential edits without network and detects response errors',async()=>{
 let calls=0;const fetched=async()=>{calls++;return {ok:true,json:async()=>({success:true,configured:true,profile:{source:'openai',model:'m',dimension:3,metric:'cosine'}})};};
 await getEmbeddingProfile({},fetched);
 await assert.rejects(()=>saveEmbeddingProfile({source:'openai',model:'m',dimension:3,metric:'cosine'},{},fetched),/m0-admin-embedding-profile-only/);
 await testEmbeddingProfile({},fetched);
 await assert.rejects(()=>deleteEmbeddingProfile({},fetched),/m0-admin-embedding-profile-only/);
 assert.equal(calls,2);
 await assert.rejects(()=>getEmbeddingProfile({},async()=>({ok:false,status:500,json:async()=>({success:false,code:'F09B5_REFUSED'})})),/F09B5_REFUSED/);
});
