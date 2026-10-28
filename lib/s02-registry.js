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
            if (!entry || entry.status !== 'RESERVED_NOT_ACTIVE' ||
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
}

