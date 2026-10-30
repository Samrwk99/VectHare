import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {saveGuiConnection,getGuiConnectionStatus,removeGuiConnection} from '../utils/s11-gui-connections.js';
const base='/api/plugins/similharity/v2/connections';
const hdr={'Content-Type':'application/json','X-CSRF-Token':'test'};
const json=(value,ok=true,status=200)=>({ok,status,json:async()=>value});
test('M0 D6 connection inspection remains read-only; browser endpoint writes are forbidden',()=>{
 assert.equal(inspectVectorRequest(base+'/qdrant?configId=local',{method:'GET'}).allowed,true);
 assert.throws(()=>inspectVectorRequest(base+'/qdrant',{method:'PUT',body:JSON.stringify({configId:'local',host:'127.0.0.1',port:6333})}),VectorOperationDenied);
 assert.throws(()=>inspectVectorRequest(base+'/milvus?configId=default',{method:'DELETE'}),VectorOperationDenied);
});
test('M0 D6 browser cannot send remote database credentials; no dispatch occurs',async()=>{
 let calls=0;await assert.rejects(()=>saveGuiConnection('qdrant',
  {configId:'default',url:'https://example.qdrant.io',apiKey:'SECRET'},hdr,async()=>{calls++;return json({success:true});}),VectorOperationDenied);
 assert.equal(calls,0);
 const ui=fs.readFileSync(new URL('../ui/ui-manager.js',import.meta.url),'utf8');
 assert.match(ui,/vecthare_qdrant_save_connection[^>]+disabled/);
 assert.match(ui,/vecthare_milvus_save_connection[^>]+disabled/);
});
test('M0 D6 read-only status allowed; browser remote connection removal denied',async()=>{
 const received=[];const transport=async(url,opts)=>{received.push({url,opts});return json({success:true,endpoint:'server-configured',hasCredential:false});};
 const status=await getGuiConnectionStatus('qdrant','local',hdr,transport);
 assert.equal(status.endpoint,'server-configured');
 await assert.rejects(()=>removeGuiConnection('qdrant','local',hdr,transport),VectorOperationDenied);
 assert.equal(received.length,1);
});
test('S11.4 both backends use only server-side configuration selectors for initialization',()=>{
 const q=fs.readFileSync(new URL('../backends/qdrant.js',import.meta.url),'utf8');
 const m=fs.readFileSync(new URL('../backends/milvus.js',import.meta.url),'utf8');
 assert.match(q,/body: JSON\.stringify\(\{ configId: this\._qdrantConfigId \}\)/);
 assert.match(m,/body: JSON\.stringify\(\{configId:'default'\}\)/);
 assert.doesNotMatch(m,/body: JSON\.stringify\(config\)/);
});
