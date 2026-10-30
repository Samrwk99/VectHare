/**
 * S02 offline-only durable collection mapping registry.
 * No HTTP route exposes it. S03 must add host authorization before use.
 * A reservation DOES NOT create a physical collection or enable writes.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { collectionIdentity, IdentityError } from './s02-identity.js';
import { randomUUID } from 'node:crypto';

const FILE = 's02-collection-registry.json';
const LOCK = 's02-registry.lock';
const ANCHOR = 's02-registry.initialized';
const MAX_SIZE = 10 * 1024 * 1024;

export class CollectionRegistry {
    constructor(directory) {
        if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
            throw new IdentityError('S02_REGISTRY_PATH_REQUIRED', 'Registry requires an absolute trusted directory');
        }
        this.directory = directory;
        this.filename = path.join(directory, FILE);
        this.lockPath = path.join(directory, LOCK);
    }

    async read() {
        let data;
        try {
            const stat = await fs.lstat(this.filename);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SIZE) throw new Error('Invalid registry file');
            data = JSON.parse(await fs.readFile(this.filename, 'utf8'));
        } catch (error) {
            if (error.code === 'ENOENT') {
                // A vanished registry must not silently be recreated over existing mappings.
                try {
                    await fs.lstat(path.join(this.directory, ANCHOR));
                    throw new IdentityError('S02_REGISTRY_LOST', 'Registry missing after prior initialization');
                } catch (anchorError) {
                    if (anchorError.code !== 'ENOENT') throw anchorError;
                }
                return { schemaVersion: 2, entries: [] };
            }
            throw new IdentityError('S02_REGISTRY_UNVERIFIABLE', `Registry cannot be read/verified: ${error.message}`);
        }
        if (data?.schemaVersion !== 2 || !Array.isArray(data.entries) || data.entries.length > 100000) {
            throw new IdentityError('S02_REGISTRY_UNVERIFIABLE', 'Unexpected registry structure');
        }
        const keys = new Set();
        const destinations = new Set();
        for (const entry of data.entries) {
            if (!entry || !['RESERVED_NOT_ACTIVE','DELETED'].includes(entry.status) ||
                (entry.status === 'DELETED' && (!entry.deletion ||
                    !/^[a-f0-9-]{36}$/i.test(entry.deletion.operationId ?? '') ||
                    !/^[a-f0-9-]{36}$/i.test(entry.deletion.backupId ?? '') ||
                    typeof entry.deletion.deletedAt !== 'string')) ||
                !/^[a-f0-9]{64}$/.test(entry.key || '') ||
                !/^vh2_[a-f0-9]{48}$/.test(entry.physicalName || '') ||
                typeof entry.backend !== 'string') {
                throw new IdentityError('S02_REGISTRY_UNVERIFIABLE', 'Unexpected mapping entry');
            }
            const expected = collectionIdentity(entry);
            if (expected.key !== entry.key || expected.physicalName !== entry.physicalName) {
                throw new IdentityError('S02_REGISTRY_UNVERIFIABLE', 'Registry mapping has invalid fingerprint');
            }
            const target = `${entry.backend}:${entry.physicalName}`;
            if (keys.has(entry.key) || destinations.has(target)) {
                throw new IdentityError('S02_REGISTRY_COLLISION', 'Duplicate/colliding persisted mapping');
            }
            keys.add(entry.key);
            destinations.add(target);
        }
        return data;
    }

    async lookup(input) {
        const identity = collectionIdentity(input);
        const data = await this.read();
        return data.entries.find(e => e.key === identity.key) ?? null;
    }

    async reserve(input) {
        const identity = collectionIdentity(input);
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        // Exclusive directory lock: other processes fail closed rather than overwrite.
        try { await fs.mkdir(this.lockPath, { mode: 0o700 }); }
        catch (error) {
            if (error.code === 'EEXIST') throw new IdentityError('S02_REGISTRY_LOCKED', 'Registry locked; investigate before retry');
            throw error;
        }
        let temp;
        try {
            const data = await this.read();
            const existing = data.entries.find(e => e.key === identity.key);
            if (existing?.status === 'DELETED') {
                throw new IdentityError('S02_COLLECTION_TOMBSTONED', 'Deleted logical collection cannot be silently recreated');
            }
            if (existing) return existing;
            if (data.entries.some(e => e.backend === identity.backend && e.physicalName === identity.physicalName)) {
                throw new IdentityError('S02_REGISTRY_COLLISION', 'Physical namespace already mapped');
            }
            const entry = { ...identity, status: 'RESERVED_NOT_ACTIVE' };
            const next = { schemaVersion: 2, entries: [...data.entries, entry] };
            const output = JSON.stringify(next, null, 2) + '\n';
            if (Buffer.byteLength(output) > MAX_SIZE) throw new IdentityError('S02_REGISTRY_LIMIT', 'Registry too large');
            temp = path.join(this.directory, `.s02-${process.pid}-${randomUUID()}.tmp`);
            const handle = await fs.open(temp, 'wx', 0o600);
            try { await handle.writeFile(output, 'utf8'); await handle.sync(); }
            finally { await handle.close(); }
            await fs.rename(temp, this.filename);
            temp = null;
            // Durable marker detects later accidental registry loss.
            const anchorHandle = await fs.open(path.join(this.directory, ANCHOR), 'a', 0o600);
            try { await anchorHandle.sync(); } finally { await anchorHandle.close(); }
            const dir = await fs.open(this.directory, 'r');
            try { await dir.sync(); } finally { await dir.close(); }
            return entry;
        } finally {
            if (temp) await fs.rm(temp, { force: true });
            await fs.rmdir(this.lockPath);
        }
    }

    /** Durable terminal binding state; only a trusted gateway with independent
     * physical absence readback may invoke this. The deterministic identity
     * stays reserved so future auto-sync/provision cannot resurrect it.
     * A retained/uncertain deletion never calls this method.
     */
    async tombstone(input, { operationId, backupId, physicalAbsent = false } = {}) {
        const identity = collectionIdentity(input);
        const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
        if (!uuid.test(operationId ?? '') || !uuid.test(backupId ?? '') || physicalAbsent !== true) {
            throw new IdentityError('S02_DELETE_PROOF_REQUIRED', 'Verified physical absence and operation provenance required');
        }
        await fs.mkdir(this.directory, {recursive:true, mode:0o700});
        try { await fs.mkdir(this.lockPath, {mode:0o700}); }
        catch(error){
            if(error.code === 'EEXIST') throw new IdentityError('S02_REGISTRY_LOCKED', 'Registry under review');
            throw error;
        }
        let temp;
        try{
            const data=await this.read();
            const i=data.entries.findIndex(e=>e.key===identity.key);
            if(i<0 || data.entries[i].physicalName!==identity.physicalName ||
               data.entries[i].backend!==identity.backend ||
               data.entries[i].status!=='RESERVED_NOT_ACTIVE') {
                throw new IdentityError('S02_DELETE_STATE_INVALID', 'Collection must have its active reservation');
            }
            const next={schemaVersion:2,entries:[...data.entries]};
            next.entries[i]={...next.entries[i],status:'DELETED',deletion:{operationId,backupId,deletedAt:new Date().toISOString()}};
            const output=JSON.stringify(next,null,2)+'\n';
            if(Buffer.byteLength(output)>MAX_SIZE)throw new IdentityError('S02_REGISTRY_LIMIT','Registry too large');
            temp=path.join(this.directory,`.s02-${process.pid}-${randomUUID()}.tmp`);
            const f=await fs.open(temp,'wx',0o600);
            try{await f.writeFile(output,'utf8');await f.sync();}finally{await f.close();}
            await fs.rename(temp,this.filename);temp=null;
            const anchor=await fs.open(path.join(this.directory,ANCHOR),'a',0o600);
            try{await anchor.sync();}finally{await anchor.close();}
            const dir=await fs.open(this.directory,'r');try{await dir.sync();}finally{await dir.close();}
            return next.entries[i];
        }finally{
            if(temp)await fs.rm(temp,{force:true});
            await fs.rmdir(this.lockPath);
        }
    }

}

