/** C04-A / C06-A: never reinterpret a qualified collection as a different tenant. */
import {parseCollectionKey, COLLECTION_BACKENDS, COLLECTION_SOURCES} from './collection-keys.js';
import {hasVerifiedCapability} from './backend-contracts.js';

/** Adapter requests may still contain old bare IDs, but qualified IDs are authoritative. */
export function adapterCollectionId(input, backend, source) {
    if (typeof input !== 'string' || !input.trim()) throw new Error('Invalid collection identity');
    const qualified = parseCollectionKey(input);
    if (qualified) {
        if (qualified.backend !== backend || qualified.source !== source)
            throw new Error('Collection route mismatch: backend/source differs from qualified identity');
        return qualified.collectionId;
    }
    // Do not treat a malformed or alien backend-qualified key as a raw ID.
    const parts = input.split(':');
    if (parts.length > 1 && COLLECTION_BACKENDS.includes(parts[0]))
        throw new Error('Malformed or unsupported backend-qualified collection identity');
    if (parts.length > 1 && COLLECTION_SOURCES.includes(parts[0])) {
        if (parts[0] !== source || !parts.slice(1).join(':'))
            throw new Error('Legacy source-qualified collection route mismatch');
        return parts.slice(1).join(':');
    }
    return input;
}

/** Shared physical collections require independent proof that the server enforces tenant filters. */
export function requireTenantScope(backend, operation, {point=false}={}) {
    const capability = point ? 'pointTenantFilter' : 'tenantFilter';
    if (!hasVerifiedCapability(backend, capability))
        throw new Error(`${backend}: ${operation} blocked; verified ${capability} contract unavailable`);
}

/** A single-item endpoint without scoped request semantics must not be used on shared collections. */
export function rejectUnscopedPointOperation(backend, operation) {
    throw new Error(`${backend}: ${operation} blocked; point endpoint does not carry verified tenant scope`);
}
