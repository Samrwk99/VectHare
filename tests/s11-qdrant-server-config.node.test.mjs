import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectVectorRequest } from '../utils/e02-vector-request-gateway.js';
const src = p => readFileSync(new URL(p,import.meta.url),'utf8');
const endpoint='/api/plugins/similharity/backend/init/qdrant';
const valid={method:'POST',body:JSON.stringify({configId:'local'})};
test('S11.3 plugin accepts the server-side configuration selector through gateway',()=>{
    assert.equal(inspectVectorRequest(endpoint,valid).allowed,true);
});
test('S11.3 browser Qdrant initializer uses only server config selector',()=>{
    const s=src('../backends/qdrant.js');
    assert.match(s,/backend\/init\/qdrant[\s\S]*?body: JSON\.stringify\(\{ configId: this\._qdrantConfigId \}\)/);
    assert.match(s,/settings\?\.qdrant_use_cloud \? 'default' : 'local'/);
    assert.doesNotMatch(s,/body: JSON\.stringify\(config\)/);
});
test('S11.3 diagnostics uses only server config selector and no raw error body',()=>{
    const s=src('../diagnostics/infrastructure.js');
    const area=s.slice(s.indexOf('export async function checkQdrantBackend('),s.indexOf('export async function',s.indexOf('export async function checkQdrantBackend(')+15));
    assert.match(area,/backend\/init\/qdrant[\s\S]*?body: JSON\.stringify\(\{ configId \}\)/);
    assert.doesNotMatch(area,/apiKey: settings\.qdrant_api_key/);
    assert.match(area,/const configId = isCloud \? 'default' : 'local'/);
    assert.doesNotMatch(area,/initResponse\.text\(\)/);
});
test('S11.3 never sends browser credentials on Qdrant init',()=>{
    assert.throws(()=>inspectVectorRequest(endpoint,{method:'POST',body:JSON.stringify({apiKey:'do-not-send'})}),/browser-credential-forwarding/);
});
