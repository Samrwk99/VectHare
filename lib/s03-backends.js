/** S03 per-authenticated-user backend pool. No module-level mutable backend
 * singleton can be reconfigured by another user's request. */
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AccessError } from './s03-security.js';

const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_POOL = 64;
const SERVER_CONFIG = 'server-connections.json';
function digest(obj) { return createHash('sha256').update(JSON.stringify(obj)).digest('hex'); }
const own = (o,k) => Object.hasOwn(o,k);

function validateRemoteSettings(backend, config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new AccessError('S03_SERVER_CONFIG_INVALID', 'Invalid server connection configuration');
    }
    if (backend === 'qdrant') {
        const allowed = ['url','apiKey'];
        if (Object.keys(config).some(k => !allowed.includes(k))) throw new AccessError('S03_SERVER_CONFIG_INVALID','Unexpected Qdrant config field');
        let u;
        try { u = new URL(config.url); } catch { throw new AccessError('S03_SERVER_CONFIG_INVALID','Qdrant URL invalid'); }
        const local = ['127.0.0.1','localhost','::1','[::1]'].includes(u.hostname);
        if (!['https:', ...(local?['http:']:[])].includes(u.protocol) || u.username || u.password ||
            u.search || u.hash || !['','/'].includes(u.pathname)) {
            throw new AccessError('S03_SERVER_CONFIG_INVALID', 'Qdrant URL must be HTTPS (HTTP loopback only), without credentials or path');
        }
        if (config.apiKey !== undefined && typeof config.apiKey !== 'string') throw new AccessError('S03_SERVER_CONFIG_INVALID','Invalid Qdrant credential');
    } else if (backend === 'milvus') {
        const allowed = ['address','token','ssl'];
        if (Object.keys(config).some(k => !allowed.includes(k)) || typeof config.address !== 'string' ||
            !/^[a-zA-Z0-9_.-]+:[0-9]{2,5}$/.test(config.address)) {
            throw new AccessError('S03_SERVER_CONFIG_INVALID','Invalid Milvus server address');
        }
        const hostname = config.address.slice(0,config.address.lastIndexOf(':'));
        const local = ['127.0.0.1','localhost','::1'].includes(hostname);
        if (!local && config.ssl !== true) throw new AccessError('S03_SERVER_CONFIG_INVALID','Remote Milvus requires TLS');
        if (config.token !== undefined && typeof config.token !== 'string') throw new AccessError('S03_SERVER_CONFIG_INVALID','Invalid Milvus token');
        if (config.ssl !== undefined && typeof config.ssl !== 'boolean') throw new AccessError('S03_SERVER_CONFIG_INVALID','Invalid TLS setting');
    }
    return config;
}

/** Config root is administrator-provisioned, inaccessible through user vectors.
 * SIMILHARITY_SERVER_CONFIG_DIR is an absolute path to a private directory.
 * Its per-user subfolder is SHA-256(userScopeId) (not a request path).
 * Absence of the setting fails closed; never accept browser credentials. */
export function configUserDirectory(root, userScopeId) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
        throw new AccessError('S03_SERVER_CONFIG_MISSING',
            'SIMILHARITY_SERVER_CONFIG_DIR is not configured by server administrator',409);
    }
    const idHash = createHash('sha256').update(userScopeId,'utf8').digest('hex');
    return path.join(root,idHash);
}

export async function readServerConnection(context, backend, configRoot = process.env.SIMILHARITY_SERVER_CONFIG_DIR) {
    const userDir = configUserDirectory(configRoot, context.userScopeId);
    const file = path.join(userDir, SERVER_CONFIG);
    let value;
    try {
        // No symlink components or loose permissions in admin configuration.
        for (const dirPath of [configRoot,userDir]) {
            const dir = await fs.lstat(dirPath);
            if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077)) {
                throw new AccessError('S03_SERVER_CONFIG_UNTRUSTED',
                    'Server configuration directory must be private (0700)');
            }
        }
        const prior = await fs.lstat(file);
        if (!prior.isFile() || prior.isSymbolicLink()) {
            throw new AccessError('S03_SERVER_CONFIG_UNTRUSTED','Symlinked/nonregular connection file prohibited');
        }
        // No-follow and descriptor-level checks defend against file replacement.
        const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.ino !== prior.ino || stat.dev !== prior.dev ||
                stat.size > MAX_CONFIG_BYTES || (stat.mode & 0o077)) {
                throw new AccessError('S03_SERVER_CONFIG_UNTRUSTED',
                    'Connection file must be private (0600), regular and stable');
            }
            value = JSON.parse(await handle.readFile('utf8'));
        } finally { await handle.close(); }
    } catch (error) {
        if (error.code === 'ENOENT') throw new AccessError('S03_SERVER_CONFIG_MISSING',
            'Private server-side connection file not provisioned',409);
        if (error.code === 'ELOOP') throw new AccessError('S03_SERVER_CONFIG_UNTRUSTED',
            'Symlinked connection files prohibited');
        if (error instanceof SyntaxError) throw new AccessError('S03_SERVER_CONFIG_INVALID',
            'Invalid server-side connection JSON');
        throw error;
    }
    if (value?.schemaVersion !== 1 || !value?.backends || typeof value.backends !== 'object') {
        throw new AccessError('S03_SERVER_CONFIG_INVALID','Unexpected server connection schema');
    }
    if (!own(value.backends, backend)) {
        throw new AccessError('S03_SERVER_CONFIG_MISSING', `${backend} not configured on server`,409);
    }
    return validateRemoteSettings(backend, value.backends[backend]);
}

/** Inject factories for isolation tests without network dependencies. */
async function defaultFactory(backend) {
    switch (backend) {
        case 'qdrant': return (await import('../qdrant-backend.js')).createQdrantBackend;
        case 'milvus': return (await import('../milvus-backend.js')).createMilvusBackend;
        case 'lancedb': return (await import('../lancedb-backend.js')).createLanceDBBackend;
        default: throw new AccessError('S03_BACKEND_UNKNOWN','Unknown backend',400);
    }
}

export class BackendPool {
    constructor(factories = {}) {
        this.factories = factories;
        this.instances = new Map();
    }
    async get(context, backend) {
        if (!['lancedb','qdrant','milvus'].includes(backend)) throw new AccessError('S03_BACKEND_UNKNOWN','Unknown backend',400);
        const config = backend === 'lancedb' ? {vectorsPath:context.vectorsPath} : await readServerConnection(context,backend);
        const key = digest([context.userScopeId,context.vectorsPath,backend,config]);
        if (this.instances.has(key)) return this.instances.get(key);
        // Refuse an unbounded number of cached credentials/connections.
        if (this.instances.size >= MAX_POOL) throw new AccessError('S03_POOL_LIMIT','Backend pool capacity reached',503);
        // Cache initialization promise to prevent cross-request reconfiguration races.
        const promise = (async () => {
            const factory = this.factories[backend] ?? (await defaultFactory(backend));
            const instance = await factory();
            await instance.initialize(backend === 'lancedb' ? context.vectorsPath : config);
            return instance;
        })();
        this.instances.set(key,promise);
        try { return await promise; }
        catch (error) { this.instances.delete(key); throw error; }
    }
    clear() { this.instances.clear(); }
}
