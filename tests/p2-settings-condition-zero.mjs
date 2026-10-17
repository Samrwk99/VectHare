import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../core/conditional-activation.js',import.meta.url),'utf8');
function extract(name){
 const start=source.indexOf(`function ${name}(`);
 assert(start>=0,name);
 const open=source.indexOf('{',start);let depth=0,end=-1;
 for(let i=open;i<source.length;i++){
  if(source[i]==='{')depth++;
  if(source[i]==='}'&&!--depth){end=i+1;break;}
 }
 assert(end>open,name);return source.slice(start,end);
}
const context=vm.createContext({console,Math:Object.assign(Object.create(Math),{random:()=>0.5}),Number,parseFloat,parseInt});
vm.runInContext(['evaluateRandomChanceCondition','evaluateScoreThresholdCondition','evaluateRecencyCondition'].map(extract).join('\n'),context);
const run=(expression)=>vm.runInContext(expression,context);
assert.equal(run('evaluateRandomChanceCondition({settings:{probability:0}},{})'),false,'0% must always exclude');
assert.equal(run('evaluateRandomChanceCondition({settings:{probability:100}},{})'),true);
assert.equal(run('evaluateScoreThresholdCondition({settings:{threshold:0}},{currentChunkScore:0})'),true,'Threshold 0 must survive');
assert.equal(run('evaluateScoreThresholdCondition({settings:{threshold:0.5}},{currentChunkScore:0})'),false);
assert.equal(run('evaluateRecencyCondition({settings:{messagesAgo:0,operator:"eq"}},{currentChunkMessageIndex:10,messageCount:10})'),true,'Zero-message recency must survive');
console.log('PASS: conditional activation preserves 0% probability, zero score threshold and zero-message recency');
