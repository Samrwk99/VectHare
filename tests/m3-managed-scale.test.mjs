import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ManagedChatRegistry} from '../lib/f09b4-managed-registry.js';
const key='a'.repeat(64),hash='b'.repeat(64);
test('managed record registry durably supports >2000 bounded records for larger M3 rebuilds',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'m3-registry-scale-'));await fs.chmod(dir,0o700);
 try{
  const ctx={userScopeId:'alice',vectorsPath:dir};
  const binding={scope:{userScopeId:'alice',sourceId:'source'},collection:{key}};
  const store=new ManagedChatRegistry(ctx,binding),doc=store.empty();
  for(let i=0;i<2500;i++){const id=randomUUID();doc.records[id]={recordId:id,contentHash:hash,
   revision:1,state:'ACTIVE',operationId:null};}
  await store.setup();await store.save(doc);
  const restored=await new ManagedChatRegistry(ctx,binding).read();
  assert.equal(Object.keys(restored.records).length,2500);
  await store.save({...restored,records:{...restored.records}});
  assert.equal(Object.keys((await store.read()).records).length,2500);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
