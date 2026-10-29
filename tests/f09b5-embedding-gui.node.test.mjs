import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectVectorRequest} from '../utils/e02-vector-request-gateway.js';
import {getEmbeddingProfile,saveEmbeddingProfile,testEmbeddingProfile,deleteEmbeddingProfile} from '../utils/f09b5-embedding-gui.js';
const root='/api/plugins/similharity/v2/embeddings';
test('F09b.5 browser transport permits only narrow configuration/test endpoints',()=>{
 for(const [suffix,method,body] of [['profile','GET',undefined],['profile','PUT',{source:'openai',model:'m',dimension:3,metric:'cosine'}],['profile','DELETE',undefined],['test','POST',{}]]){
  const result=inspectVectorRequest(`${root}/${suffix}`,{method,...(body?{body:JSON.stringify(body)}:{})});
  assert.equal(result.allowed,true);assert.equal(result.operation,'f09b5EmbeddingConfiguration');
 }
 for(const [suffix,method,body] of [['test','POST',{text:'SECRET'}],['test','GET',null],['profile','PUT',{apiUrl:'http://localhost'}],['profile','POST',{}]]){
  assert.throws(()=>inspectVectorRequest(`${root}/${suffix}`,{method,...(body?{body:JSON.stringify(body)}:{})}));
 }
});
test('F09b.5 browser client does not trust error or malformed response',async()=>{
 const fetched=async(url,opts)=>{assert.ok(url.startsWith(root));
  if(opts.method==='PUT')assert.equal(opts.headers['X-VectHare-Configuration'],'1');
  return {ok:true,json:async()=>({success:true,configured:true,profile:{source:'openai',model:'m',dimension:3,metric:'cosine'}})};};
 await getEmbeddingProfile({},fetched);
 await saveEmbeddingProfile({source:'openai',model:'m',dimension:3,metric:'cosine'},{},fetched);
 await testEmbeddingProfile({},fetched);await deleteEmbeddingProfile({},fetched);
 await assert.rejects(()=>getEmbeddingProfile({},async()=>({ok:false,status:500,json:async()=>({success:false,code:'F09B5_REFUSED'})})),/F09B5_REFUSED/);
});
