/** S03: fail-closed authentication/scope boundary. req.user must be set by the
 * authenticated SillyTavern router. Never use body/query/header user IDs. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalScope, collectionIdentity } from './s02-identity.js';
import { CollectionRegistry } from './s02-registry.js';

export class AccessError extends Error {
    constructor(code, message, status = 403) {
        super(message);
        this.name = 'AccessError';
        this.code = code;
        this.status = status;
    }
}
const OWNERS = ['userScopeId', 'userId', 'ownerId', 'tenantId'];
const CLIENT_SECRETS = ['apiKey','token','password','secret','authorization','credentials','host','port','url','address','ssl','baseUrl'];
const ROOT_OWNER = new Map(); // In-process host isolation audit; live multi-process proof still required.
const SOURCE_SAFE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/;

export function trustedUserId(req) {
    // These are documented adapter candidates, not proof of any particular host
    // shape. An unknown SillyTavern revision must fail closed until validated.
    const profile = req?.user?.profile;
    const id = profile?.handle ?? req?.user?.id;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]{0,127}$/.test(id)) {
        throw new AccessError('S03_HOST_IDENTITY_UNVERIFIED', 'Authenticated SillyTavern user identity unavailable', 401);
    }
    return id;
}

export async function authenticatedContext(req) {
    const id = trustedUserId(req);
    const declared = req.user?.directories?.vectors;
    if (typeof declared !== 'string' || !path.isAbsolute(declared)) {
        throw new AccessError('S03_USER_DIRECTORY_UNVERIFIED', 'User vectors directory is unavailable');
    }
    let resolved;
    try { resolved = await fs.realpath(declared); }
    catch { throw new AccessError('S03_USER_DIRECTORY_UNVERIFIED', 'User vectors directory cannot be verified'); }
    const stat = await fs.lstat(resolved);
    if (!stat.isDirectory()) throw new AccessError('S03_USER_DIRECTORY_UNVERIFIED', 'Invalid vectors directory');
    // A single physical user directory must not be assigned to two different
    // authenticated profiles in the same host process. Cross-process identity
    // and directory guarantees still need actual SillyTavern verification.
    const owner = ROOT_OWNER.get(resolved);
    if (owner && owner !== id) {
        throw new AccessError('S03_SHARED_USER_ROOT', 'Host mapped distinct users to the same vectors directory');
    }
    ROOT_OWNER.set(resolved, id);
    return Object.freeze({ userScopeId: id, vectorsPath: resolved });
}

export function forbidOwnerSpoof(input, identity) {
    if (!input || typeof input !== 'object') return;
    for (const name of OWNERS) {
        if (Object.hasOwn(input, name) && input[name] !== identity.userScopeId) {
            throw new AccessError('S03_OWNER_CONFLICT', `Caller supplied conflicting ${name}`);
        }
    }
    if (input.scope && typeof input.scope === 'object') forbidOwnerSpoof(input.scope, identity);
    if (input.filters && typeof input.filters === 'object') forbidOwnerSpoof(input.filters, identity);
}

export function validateClientConfig(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new AccessError('S03_INVALID_CONFIG_REQUEST', 'Expected configuration selector object', 400);
    }
    for (const key of Object.keys(body)) {
        if (CLIENT_SECRETS.includes(key) || key !== 'configId') {
            throw new AccessError('S03_CLIENT_CONFIG_FORBIDDEN', 'Connection settings must be server-provisioned', 403);
        }
    }
    if (body.configId !== undefined && body.configId !== 'default') {
        throw new AccessError('S03_CONFIG_SELECTOR_UNKNOWN', 'Only server-provisioned default configuration is available', 400);
    }
    return 'default';
}

export async function lookupAuthorizedReservation(context, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new AccessError('S03_INVALID_IDENTITY_REQUEST', 'Collection identity request required', 400);
    }
    forbidOwnerSpoof(input, context);
    if (!input.scope || typeof input.scope !== 'object') {
        throw new AccessError('S03_SCOPE_REQUIRED', 'Collection scope required', 400);
    }
    const scope = canonicalScope({ ...input.scope, userScopeId: context.userScopeId });
    const identity = collectionIdentity({backend: input.backend, scope, embedding: input.embedding});
    // Registry file cannot be selected by HTTP clients. S02 reservations do not
    // certify backend ownership, physical existence or read/write permission.
    const registry = new CollectionRegistry(path.join(context.vectorsPath, '.similharity'));
    const entry = await registry.lookup(identity);
    return { identity, entry, operational: false };
}

/** Deny risky S02 legacy reads: they have no server-attested owner proof. */
export function legacyReadBoundary(req, res, next) {
    const pathname = String(req.path || req.url?.split('?')[0] || '');
    if (/^\/chunks\/(?:list|query|hybrid-query|stats)\/?$/.test(pathname) ||
        /^\/chunks\/[^/]+\/?$/.test(pathname)) {
        const body = req.method === 'GET' ? req.query : req.body;
        const backend = body?.backend || 'vectra';
        if (backend === 'qdrant' || backend === 'milvus') {
            return res.status(409).json({ success: false, code: 'S03_SHARED_LEGACY_READ_UNVERIFIED',
                error: 'Shared-backend legacy reads require S05 authoritative ownership and isolation verification.' });
        }
    }
    return next();
}

export function s03SensitiveRouteBoundary(req, res, next) {
    const pathname = String(req.path || req.url?.split('?')[0] || '');
    if (req.method === 'POST' && (pathname === '/open-folder' || pathname === '/rerank')) {
        return res.status(409).json({success:false, code:'S03_SENSITIVE_ROUTE_BLOCKED',
            error:'Legacy shell/remote-rerank route requires a separately reviewed host policy.'});
    }
    // Embedding requests with caller supplied network locations/credentials
    // cannot bypass server-side configuration by changing source providers.
    if (req.method === 'POST' && (pathname === '/get-embedding' || pathname === '/batch-embeddings')) {
        const dangerous = ['apiUrl','apiKey','extrasUrl','extrasKey','token','url','host','address'];
        if (dangerous.some(k => Object.hasOwn(req.body || {}, k))) {
            return res.status(403).json({success:false, code:'S03_CLIENT_EMBEDDING_CONNECTION_FORBIDDEN',
                error:'Use host/server-managed embedding endpoint and credentials.'});
        }
    }
    return next();
}

export function exposedSafeSource(source) {
    if (typeof source !== 'string' || !SOURCE_SAFE.test(source)) {
        throw new AccessError('S03_INVALID_SOURCE', 'Unsafe backend source name', 400);
    }
    return source;
}
