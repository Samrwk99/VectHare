// Updated for P03: authenticated, scoped configuration is enabled without granting vector mutation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectVectorRequest} from '../utils/e02-vector-request-gateway.js';
import {getEmbeddingProfile,saveEmbeddingProfile,testEmbeddingProfile,deleteEmbeddingProfile} from '../utils/f09b5-embedding-gui.js';
const root='/api/plugins/similharity/v2/embeddings';
test('P03 narrow embedding profile setup permitted, arbitrary requests blocked',()=>{
 for(const [suffix,method,body] of [['profile','GET'],['test','POST',{}],['preflight','GET'],
 ['profile','PUT',{source:'openai',model:'m',dimension:3,metric:'cosine'}],['profile','DELETE']]){
  const result=inspectVectorRequest(`${root}/${suffix}`,{method,...(body?{body:JSON.stringify(body)}:{})});
  assert.equal(result.allowed,true);assert.equal(result.operation,'f09b5EmbeddingConfiguration');
 }
 for(const [suffix,method,body] of [['test','POST',{text:'SECRET'}],['test','GET'],
  ['profile','PUT',{apiUrl:'http://localhost'}],['profile','POST',{}]]){
  assert.throws(()=>inspectVectorRequest(`${root}/${suffix}`,{method,...(body?{body:JSON.stringify(body)}:{})}));
 }
});
test('P03 credential setup is bounded; provider errors are not hidden',async()=>{
 let calls=0;const fetched=async()=>{calls++;return {ok:true,json:async()=>({success:true,configured:true,profile:{source:'openai',model:'m',dimension:3,metric:'cosine'}})};};
 await getEmbeddingProfile({},fetched);await saveEmbeddingProfile({source:'openai',model:'m',dimension:3,metric:'cosine'},{},fetched);
 await testEmbeddingProfile({},fetched);await deleteEmbeddingProfile({},fetched);
 assert.equal(calls,4);
 assert.throws(()=>saveEmbeddingProfile({source:'openai',model:'m',dimension:-2,metric:'cosine'},{},fetched),/F09B5_INVALID_PROFILE/);
 await assert.rejects(()=>getEmbeddingProfile({},async()=>({ok:false,status:500,json:async()=>({success:false,code:'F09B5_REFUSED'})})),/F09B5_REFUSED/);
});
