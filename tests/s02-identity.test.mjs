import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import qdrant from '../qdrant-backend.js';
import { canonicalScope, canonicalEmbedding, collectionIdentity, recordIdentity,
    contentFingerprint, safeLegacyPhysicalName } from '../lib/s02-identity.js';
import { CollectionRegistry } from '../lib/s02-registry.js';
import { planLegacyMigration } from '../lib/s02-migration.js';

const scope = { userScopeId:'user1',collectionId:'chat:Alice:chat123',type:'chat',sourceId:'chat-123',branchId:'branch-A' };
const embedding = { source:'transformers',model:'all-MiniLM-L6-v2',dimension:384,metric:'cosine' };
const input = { backend:'qdrant',scope,embedding };
const rid = '123e4567-e89b-42d3-a456-426614174000';
const denial = (fn,code) => assert.throws(fn,e => e.code===code);
const denialAsync = (fn,code) => assert.rejects(fn,e => e.code===code);

async function tmpRegistry(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(),'s02-test-'));
    try { await fn(new CollectionRegistry(dir),dir); }
    finally { await fs.rm(dir,{recursive:true,force:true}); }
}

test('S02 canonical scope preserves full path-like names without lossy splitting',()=>{
    const s=canonicalScope(scope);
    assert.equal(s.collectionId,'chat:Alice:chat123');
    assert.equal(s.branchId,'branch-A');
    assert.deepEqual(Object.keys(s),['userScopeId','collectionId','type','sourceId','branchId']);
});
test('S02 scope rejects missing owner, unknown type, paths and bogus branch type',()=>{
    for(const bad of [ {...scope,userScopeId:''},{...scope,type:'__weird'}, {...scope,sourceId:'../escape'}, {...scope,type:'lore'} ])
        denial(()=>canonicalScope(bad),'S02_INVALID_IDENTITY');
});
test('S02 embedding requires explicit source/model/dimension/metric',()=>{
    assert.equal(canonicalEmbedding(embedding).dimension,384);
    for (const e of [{...embedding,dimension:0},{...embedding,dimension:1.5},{...embedding,metric:'foo'},{...embedding,model:''}])
        denial(()=>canonicalEmbedding(e),'S02_INVALID_EMBEDDING');
});
test('S02 collection key stable across object property order',()=>{
    const a=collectionIdentity(input);
    const b=collectionIdentity({backend:'qdrant',scope:{sourceId:scope.sourceId,...scope},embedding:{metric:'cosine',...embedding}});
    assert.deepEqual(a,b);
    assert.match(a.physicalName,/^vh2_[a-f0-9]{48}$/);
});
test('S02 collection IDs are separated across users, branches, backends and models',()=>{
    const a=collectionIdentity(input);
    for(const changed of [
        { ...input,scope:{...scope,userScopeId:'user2'} },
        { ...input,scope:{...scope,branchId:'branch-B'} },
        { ...input,scope:{...scope,sourceId:'chat-124'} },
        { ...input,backend:'milvus' },
        { ...input,embedding:{...embedding,model:'different'} },
        { ...input,embedding:{...embedding,dimension:768} },
    ]) assert.notEqual(a.physicalName, collectionIdentity(changed).physicalName);
});
test('S02 record IDs are stable across text edits and backend-UUID compatible',()=>{
    const first=recordIdentity(scope,rid);
    const second=recordIdentity({...scope},rid);
    assert.deepEqual(first,second);
    assert.match(first.physicalId,/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(contentFingerprint('before edit'),contentFingerprint('after edit'));
});
test('S02 duplicate content across scopes and branches has distinct physical IDs',()=>{
    const a=recordIdentity(scope,rid);
    const b=recordIdentity({...scope,branchId:'branch-B'},rid);
    const c=recordIdentity({...scope,userScopeId:'user2'},rid);
    assert.notEqual(a.physicalId,b.physicalId);
    assert.notEqual(a.physicalId,c.physicalId);
});
test('S02 record ID format enforced, with UUID generated only when absent',()=>{
    denial(()=>recordIdentity(scope,'123'),'S02_INVALID_RECORD_ID');
    const generated=recordIdentity(scope);
    assert.match(generated.recordId,/^[0-9a-f-]{36}$/);
});
test('S02 no parseInt or hash as primary ID, content fingerprint remains separate',()=>{
    assert.notEqual(recordIdentity(scope,rid).physicalId, '123');
    assert.equal(contentFingerprint('same'),contentFingerprint('same'));
    denial(()=>contentFingerprint({text:'wrong'}),'S02_INVALID_CONTENT');
});
test('S02 accepts safe physical legacy names without rewriting',()=>{
    assert.equal(safeLegacyPhysicalName('qdrant','vecthare_main'),'vecthare_main');
    assert.equal(safeLegacyPhysicalName('qdrant','qdrant:vecthare_main'),'vecthare_main');
    assert.equal(safeLegacyPhysicalName('lancedb','chat_abc'),'chat_abc');
});
test('S02 denies ambiguous old names rather than collapsing unrelated collections',()=>{
    for(const name of ['qdrant:transformers:chat:abc','source:chat','other:chat','../escape','hello/world','..','foo?x'])
        denial(()=>safeLegacyPhysicalName('qdrant',name),'S02_AMBIGUOUS_LEGACY_NAME');
    for(const name of ['chat:abc','chat/abc'])
        denial(()=>safeLegacyPhysicalName('lancedb',name),'S02_AMBIGUOUS_LEGACY_NAME');
});
test('S02 Qdrant adapter rejects lossy paths before any backend request',async()=>{
    const old=qdrant._request;let calls=0;
    qdrant.baseUrl='http://local';qdrant._request=async()=>{calls++;return {};};
    try { await denialAsync(()=>qdrant.getItem('x:shared',123,{}),'S02_AMBIGUOUS_LEGACY_NAME'); assert.equal(calls,0); }
    finally { qdrant._request=old; }
});
test('S02 registry reservation persists and returns identical mapping across instances',async()=>{
    await tmpRegistry(async(reg,dir)=>{
        const a=await reg.reserve(input);
        assert.equal(a.status,'RESERVED_NOT_ACTIVE');
        const next=new CollectionRegistry(dir);
        assert.deepEqual(await next.lookup(input),a);
        assert.deepEqual(await next.reserve(input),a);
        assert.equal((await next.read()).entries.length,1);
    });
});
test('S02 registry reserves distinct source/branch identities without collision',async()=>{
    await tmpRegistry(async reg=>{
        const a=await reg.reserve(input);
        const b=await reg.reserve({...input,scope:{...scope,branchId:'branch-B'}});
        assert.notEqual(a.physicalName,b.physicalName);
        assert.equal((await reg.read()).entries.length,2);
    });
});
test('S02 registry lock contention fails closed, no overwrites',async()=>{
    await tmpRegistry(async(reg,dir)=>{
        await fs.mkdir(path.join(dir,'s02-registry.lock'));
        await denialAsync(()=>reg.reserve(input),'S02_REGISTRY_LOCKED');
        assert.equal((await reg.read()).entries.length,0);
        await fs.rmdir(path.join(dir,'s02-registry.lock'));
    });
});
test('S02 registry modified fingerprint refuses access, never silently repairs',async()=>{
    await tmpRegistry(async(reg,dir)=>{
        await reg.reserve(input);
        const file=path.join(dir,'s02-collection-registry.json');
        const data=JSON.parse(await fs.readFile(file,'utf8'));
        data.entries[0].physicalName='vh2_'+'0'.repeat(48);
        await fs.writeFile(file,JSON.stringify(data));
        await denialAsync(()=>reg.read(),'S02_REGISTRY_UNVERIFIABLE');
        await denialAsync(()=>reg.reserve(input),'S02_REGISTRY_UNVERIFIABLE');
    });
});
test('S02 registry rejects symlink file, instead of following it',async()=>{
    await tmpRegistry(async(reg,dir)=>{
        const target=path.join(dir,'target');
        await fs.writeFile(target,'{}');
        await fs.symlink(target,path.join(dir,'s02-collection-registry.json'));
        await denialAsync(()=>reg.read(),'S02_REGISTRY_UNVERIFIABLE');
    });
});
test('S02 legacy migration manifest refuses unknown ownership without guessing',()=>{
    const result=planLegacyMigration({backend:'qdrant',embedding,records:[{legacyHash:'55',legacyPhysicalName:'vecthare_main',scope,recordId:rid,ownerVerified:false}]});
    assert.equal(result.recordsMapped,0);assert.equal(result.recordsUnresolved,1);
    assert.equal(result.cutoverAllowed,false);
});
test('S02 migration allows duplicate content from separate scopes but no duplicate target ID',()=>{
    const result=planLegacyMigration({backend:'qdrant',embedding,records:[
        {legacyHash:'55',legacyPhysicalName:'vecthare_main',scope,recordId:rid,ownerVerified:true},
        {legacyHash:'55',legacyPhysicalName:'vecthare_main',scope:{...scope,branchId:'branch-B'},recordId:rid,ownerVerified:true},
        {legacyHash:'55',legacyPhysicalName:'vecthare_main',scope,recordId:rid,ownerVerified:true}
    ]});
    assert.equal(result.recordsMapped,2);assert.equal(result.recordsUnresolved,1);
    assert.equal(result.unresolved[0].reason,'S02_DUPLICATE_RECORD');
    assert.equal(result.cutoverAllowed,false);
});
test('S02 migration only emits planning evidence, no backend/cutover action',()=>{
    const result=planLegacyMigration({backend:'lancedb',embedding,records:[]});
    assert.equal(result.mode,'READ_ONLY_DRY_RUN');
    assert.equal(result.backupVerified,false);
    assert.equal(result.dataCopied,false);
    assert.equal(result.cutoverAllowed,false);
});

test('S02 deleted registry cannot be recreated silently after initialization',async()=>{
    await tmpRegistry(async(reg,dir)=>{
        await reg.reserve(input);
        await fs.rm(path.join(dir,'s02-collection-registry.json'));
        await denialAsync(()=>reg.read(),'S02_REGISTRY_LOST');
        await denialAsync(()=>reg.reserve(input),'S02_REGISTRY_LOST');
    });
});

test('S02 registry cannot accept fabricated mapping that changes owner or source',async()=>{
    await tmpRegistry(async(reg,dir)=>{
        await reg.reserve(input);
        const file=path.join(dir,'s02-collection-registry.json');
        const data=JSON.parse(await fs.readFile(file,'utf8'));
        data.entries[0].scope.sourceId='someone-elses-source';
        await fs.writeFile(file,JSON.stringify(data));
        await denialAsync(()=>reg.read(),'S02_REGISTRY_UNVERIFIABLE');
    });
});

test('S02 normalized names with ambiguous separators cannot collide in new IDs',()=>{
    const a=collectionIdentity({...input,scope:{...scope,collectionId:'A:B'}});
    const b=collectionIdentity({...input,scope:{...scope,collectionId:'A/B'}});
    const c=collectionIdentity({...input,scope:{...scope,collectionId:'A_B'}});
    assert.equal(new Set([a.key,b.key,c.key]).size,3);
});

test('S02 legacy hash zero is preserved without integer coercion',()=>{
    const r=planLegacyMigration({backend:'qdrant',embedding,records:[{legacyHash:0,legacyPhysicalName:'vecthare_main',scope,recordId:rid,ownerVerified:true}]});
    assert.equal(r.recordsMapped,1);
    assert.equal(r.mappings[0].legacyHash,'0');
    assert.equal(r.cutoverAllowed,false);
});
