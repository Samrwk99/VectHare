import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const indexSource=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8');
const fnStart=indexSource.indexOf('async function getEmbeddingForSource(');
assert.ok(fnStart>0,'embedding source dispatch function present');
const caseStart=indexSource.indexOf("case 'llamacpp': {",fnStart);
const caseEnd=indexSource.indexOf("case 'bananabread':",caseStart);
assert.ok(caseStart>fnStart && caseEnd>caseStart,'llama.cpp dispatch branch present');
const branch=indexSource.slice(caseStart,caseEnd).replace(
 "const { getLlamaCppVector } = await import('../../src/vectors/llamacpp-vectors.js');",'');
const dispatch=new Function('req','text','directories','getLlamaCppVector',
 'return (async()=>{switch("llamacpp"){'+branch+' default: throw Error("unreachable")}})()');
test('plugin forwards the precise llama.cpp URL received from the diagnostic, including non-8080 ports',async()=>{
 const calls=[];
 const result=await dispatch({body:{apiUrl:'http://127.0.0.1:9117'}},'test',{},async(...args)=>{calls.push(args);return [0.1,0.2]});
 assert.deepEqual(result,[0.1,0.2]);
 assert.deepEqual(calls,[['test','http://127.0.0.1:9117',{}]]);
});
test('plugin refuses missing llama.cpp URL rather than attempting localhost:8080',async()=>{
 let called=false;
 await assert.rejects(dispatch({body:{}},'test',{},async()=>{called=true}),/LLAMACPP_EMBEDDING_URL_REQUIRED/);
 assert.equal(called,false);
});
