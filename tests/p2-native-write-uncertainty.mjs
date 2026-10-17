/** A browser-side fetch error does not prove native SillyTavern stopped writing. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const file=fs.readFileSync(new URL('../ui/shared-operations.js',import.meta.url),'utf8');
const segment=file.slice(file.indexOf('export async function runExclusiveNativeMutation'))
    .replace(/^export /,'');
let begun=0,ended=0;
const owner={id:'lease-a',token:'secret',phase:'running',closed:false};
const context={owned:new Map([['lease-a',owner]]),
  checkpointSharedOperation:async()=>{},
  acquireSharedOperation:async()=>{throw new Error('unexpected new lease')},
  finishSharedOperation:async()=>{throw new Error('unexpected finish')},
  api:async(name)=>{if(name==='native-begin'){begun++;return {markerId:`marker-${begun}`};}if(name==='native-end'){ended++;return {released:true};}throw Error(name)},
  console};
vm.createContext(context);vm.runInContext(`${segment}\nthis.mutate=runExclusiveNativeMutation`,context);
await assert.rejects(context.mutate('ST write','chat:a',async()=>{throw new Error('network disconnected')}),/network disconnected/);
assert.equal(begun,1);assert.equal(ended,0,'unknown write outcome must retain its durable in-flight marker');
assert.equal(await context.mutate('ST write','chat:a',async()=>42),42);
assert.equal(begun,2);assert.equal(ended,1,'only successfully settled work may release its marker');
console.log('PASS native-write failures retain in-flight fencing; only successful completion releases a marker');
