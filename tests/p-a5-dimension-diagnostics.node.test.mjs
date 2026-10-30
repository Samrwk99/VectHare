import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {managedDimensionEvidence} from '../utils/p19-managed-dimensions.js';
const source={kind:'chat',avatar:'Jane.png',chatFile:'chat-1'};
const settings={vector_backend:'qdrant',qdrant_use_cloud:false};
const fixture={getChatId:()=>source.chatFile,selector:async()=>source,getHeaders:()=>({'X-CSRF-Token':'fixture'}),
 preflight:async()=>({configured:true,ready:true,profile:{source:'llama_cpp',model:'model',dimension:384,metric:'cosine'}}),
 preview:async()=>({completeSavedSource:true,records:[],totalRecords:0})};
test('P19 managed dimension diagnostics never infer physical match from model dimension',async()=>{
 const result=await managedDimensionEvidence(settings,fixture);
 assert.equal(result.status,'warning');assert.equal(result.data.physicalDimensionVerified,false);
 assert.match(result.message,/UNVERIFIED/);
});
test('P19 missing profile / ownership errors and unsupported backends never show a false PASS',async()=>{
 const denied=await managedDimensionEvidence(settings,{...fixture,preflight:async()=>({configured:true,ready:false,connectionState:'NOT_TESTED'})});
 assert.equal(denied.status,'warning');assert.match(denied.message,/UNVERIFIED/);
 const broken=await managedDimensionEvidence(settings,{...fixture,preview:async()=>{throw Error('SCHEMA_UNVERIFIED');}});
 assert.equal(broken.status,'warning');assert.match(broken.message,/SCHEMA_UNVERIFIED/);
 const legacy=await managedDimensionEvidence({vector_backend:'standard'},fixture);
 assert.equal(legacy.status,'warning');assert.match(legacy.message,/no legacy/);
});
test('P19 target diagnostics no longer call browser-side legacy get-embedding or shared collection info',()=>{
 for(const path of ['../diagnostics/infrastructure.js','../diagnostics/production-tests.js']){
  const src=readFileSync(new URL(path,import.meta.url),'utf8');
  const name=path.includes('infrastructure')?'checkQdrantDimensionMatch':'testVectorDimensions';
  const start=src.indexOf(`export async function ${name}(`);const end=src.indexOf('\n}',start);
  assert.ok(start>=0&&end>start);
  const code=src.slice(start,end);
  assert.doesNotMatch(code,/get-embedding|chunks\/stats|collection-info|body:\s*JSON\.stringify\(\{\s*text/);
  assert.match(code,/managedDimensionEvidence/);
 }
});
