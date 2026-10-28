import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inspectVectorRequest,VectorOperationDenied} from '../utils/e02-vector-request-gateway.js';
import {saveGuiConnection,getGuiConnectionStatus,removeGuiConnection} from '../utils/s11-gui-connections.js';
const base='/api/plugins/similharity/v2/connections';
const hdr={'Content-Type':'application/json','X-CSRF-Token':'test'};
const json=(value,ok=true,status=200)=>({ok,status,json:async()=>value});
test('S11.4 GUI connection routes are explicitly allowed without enabling vector operations',()=>{
 assert.equal(inspectVectorRequest(base+'/qdrant?configId=local',{method:'GET'}).allowed,true);
 assert.equal(inspectVectorRequest(base+'/qdrant',{method:'PUT',body:JSON.stringify({configId:'local',host:'127.0.0.1',port:6333})}).allowed,true);
 assert.equal(inspectVectorRequest(base+'/milvus?configId=default',{method:'DELETE'}).allowed,true);
 assert.throws(()=>inspectVectorRequest(base+'/qdrant',{method:'POST',body:'{}'}),VectorOperationDenied);
 assert.throws(()=>inspectVectorRequest('/api/plugins/similharity/v2/records/insert',{method:'POST',body:'{}'}),VectorOperationDenied);
});
test('S11.4 GUI submits secure one-time key without storing it in regular extension settings',async()=>{
 const received=[];const transport=async(url,options)=>{received.push({url,options});return json({success:true,configured:true,hasCredential:true});};
 const config={configId:'default',url:'https://example.qdrant.io',apiKey:'SECRET'};
 const result=await saveGuiConnection('qdrant',config,hdr,transport);
 assert.equal(result.hasCredential,true);
 assert.equal(received.length,1);
 assert.equal(received[0].options.method,'PUT');
 assert.equal(received[0].options.credentials,'same-origin');
 assert.equal(received[0].options.headers['X-VectHare-Configuration'],'1');
 assert.equal(JSON.parse(received[0].options.body).apiKey,'SECRET');
 const ui=fs.readFileSync(new URL('../ui/ui-manager.js',import.meta.url),'utf8');
 assert.doesNotMatch(ui,/bindProtectedCredentialInput\('vecthare_qdrant_api_key'/);
 assert.doesNotMatch(ui,/settings\.qdrant_api_key\s*=/);
 assert.doesNotMatch(ui,/settings\.milvus_token\s*=/);
});
test('S11.4 status and removal do not expose secrets',async()=>{
 const received=[];const transport=async(url,opts)=>{received.push({url,opts});return json({success:true,configured:true,endpoint:'http://127.0.0.1:6333',hasCredential:false});};
 const status=await getGuiConnectionStatus('qdrant','local',hdr,transport);
 await removeGuiConnection('qdrant','local',hdr,transport);
 assert.equal(status.endpoint,'http://127.0.0.1:6333');
 assert.equal(received[0].opts.method,'GET');
 assert.equal(received[1].opts.method,'DELETE');
 assert.equal(received[1].opts.headers['X-VectHare-Configuration'],'1');
});
test('S11.4 both backends use only server-side configuration selectors for initialization',()=>{
 const q=fs.readFileSync(new URL('../backends/qdrant.js',import.meta.url),'utf8');
 const m=fs.readFileSync(new URL('../backends/milvus.js',import.meta.url),'utf8');
 assert.match(q,/body: JSON\.stringify\(\{ configId: this\._qdrantConfigId \}\)/);
 assert.match(m,/body: JSON\.stringify\(\{configId:'default'\}\)/);
 assert.doesNotMatch(m,/body: JSON\.stringify\(config\)/);
});
