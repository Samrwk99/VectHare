/**
 * S02 canonical identity v2 — pure validation and deterministic mapping only.
 * This module does NOT authenticate a caller or permit server mutations.
 * S03 must derive `scope` from trusted host user context before calling it.
 */
import { createHash, randomUUID } from 'node:crypto';

export class IdentityError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'IdentityError';
        this.code = code;
    }
}

const BACKENDS = new Set(['vectra', 'lancedb', 'qdrant', 'milvus']);
const TYPES = new Set(['chat', 'lore', 'file', 'document', 'memory', 'scene', 'other']);
const ID_RE = /^[\p{L}\p{N}][\p{L}\p{N}_.:@/\- ]*$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_PHYSICAL_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/;

function requiredId(value, field) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 256 ||
        value.trim() !== value || !ID_RE.test(value) || value === '.' || value === '..') {
        throw new IdentityError('S02_INVALID_IDENTITY', `Invalid ${field}`);
    }
    return value.normalize('NFC');
}

export function canonicalScope(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new IdentityError('S02_SCOPE_REQUIRED', 'Canonical scope is required');
    }
    const type = requiredId(input.type, 'type');
    if (!TYPES.has(type)) throw new IdentityError('S02_INVALID_IDENTITY', 'Unknown scope type');
    const scope = {
        userScopeId: requiredId(input.userScopeId, 'userScopeId'),
        collectionId: requiredId(input.collectionId, 'collectionId'),
        type,
        sourceId: requiredId(input.sourceId, 'sourceId'),
    };
    if (input.branchId !== undefined && input.branchId !== null) {
        scope.branchId = requiredId(input.branchId, 'branchId');
        if (type !== 'chat') throw new IdentityError('S02_INVALID_IDENTITY', 'branchId requires chat type');
    }
    return Object.freeze(scope);
}

export function canonicalEmbedding(input) {
    if (!input || typeof input !== 'object') throw new IdentityError('S02_EMBEDDING_REQUIRED', 'Embedding configuration required');
    const dimension = input.dimension;
    if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 65536) {
        throw new IdentityError('S02_INVALID_EMBEDDING', 'Invalid vector dimension');
    }
    let source, model, metric;
    try {
        source = requiredId(input.source, 'embedding source');
        model = requiredId(input.model, 'embedding model');
        metric = requiredId(input.metric, 'metric').toLowerCase();
    } catch (error) {
        throw new IdentityError('S02_INVALID_EMBEDDING', error.message);
    }
    if (!['cosine', 'dot', 'euclid'].includes(metric)) throw new IdentityError('S02_INVALID_EMBEDDING', 'Unknown metric');
    return Object.freeze({
        source,
        model,
        dimension,
        metric,
    });
}

function canonicalJson(parts) {
    // Positional array serialization prevents separator ambiguity and property ordering effects.
    return JSON.stringify(parts);
}
function sha(data) { return createHash('sha256').update(data).digest('hex'); }

export function collectionIdentity({ backend, scope, embedding }) {
    if (!BACKENDS.has(backend)) throw new IdentityError('S02_BACKEND_UNSUPPORTED', 'Unknown backend');
    const s = canonicalScope(scope);
    const e = canonicalEmbedding(embedding);
    const key = sha(canonicalJson(['vh-collection-v2', backend, s.userScopeId, s.collectionId,
        s.type, s.sourceId, s.branchId ?? null, e.source, e.model, e.dimension, e.metric]));
    // Safe across Qdrant and LanceDB naming rules; never derived by stripping colons.
    return Object.freeze({ schemaVersion: 2, backend, scope: s, embedding: e,
        key, physicalName: `vh2_${key.slice(0, 48)}` });
}

export function recordIdentity(scopeInput, recordId = randomUUID()) {
    const scope = canonicalScope(scopeInput);
    if (typeof recordId !== 'string' || !UUID_RE.test(recordId)) {
        throw new IdentityError('S02_INVALID_RECORD_ID', 'New records require a stable UUID recordId');
    }
    const normalized = recordId.toLowerCase();
    const bytes = Buffer.from(sha(canonicalJson(['vh-record-v2', scope.userScopeId, scope.collectionId,
        scope.type, scope.sourceId, scope.branchId ?? null, normalized])).slice(0, 32), 'hex');
    // RFC 9562 UUID version 8, variant 10: suitable for Qdrant UUID point IDs.
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const h = bytes.toString('hex');
    const physicalId = `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
    return Object.freeze({ schemaVersion: 2, scope, recordId: normalized, physicalId });
}

export function contentFingerprint(text) {
    if (typeof text !== 'string') throw new IdentityError('S02_INVALID_CONTENT', 'Text must be a string');
    return sha(Buffer.from(text, 'utf8'));
}

/**
 * Accept only unambiguous physical legacy names. A lossy `source:id` must
 * be resolved via a reviewed migration manifest, NEVER silently truncated.
 * Does not establish tenant ownership of the accepted physical collection.
 */
export function safeLegacyPhysicalName(backend, name) {
    if (!BACKENDS.has(backend)) throw new IdentityError('S02_BACKEND_UNSUPPORTED', 'Unknown backend');
    if (typeof name !== 'string' || !name) {
        throw new IdentityError('S02_COLLECTION_NAME_REQUIRED', 'Collection name required');
    }
    let candidate = name;
    if (backend === 'qdrant' && name.startsWith('qdrant:')) candidate = name.slice('qdrant:'.length);
    if (!SAFE_PHYSICAL_RE.test(candidate) || candidate === '.' || candidate === '..') {
        throw new IdentityError('S02_AMBIGUOUS_LEGACY_NAME',
            'Ambiguous/unsafe legacy name; explicit reviewed mapping required');
    }
    return candidate;
}
