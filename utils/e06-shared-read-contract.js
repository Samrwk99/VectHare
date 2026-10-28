/** E06 — shared-collection read boundary for the unchanged Similharity source.
 *
 * Qdrant exposes payload ownership in most read responses. Milvus 3.2.0
 * projects only hash/text/metadata from its scalar columns; legacy records
 * typically lack type/sourceId inside metadata. Do not infer ownership from
 * collectionId, a successful HTTP status, or a filter sent to the server.
 *
 * This does not certify the server's filtering or its error handling.
 */
import {adapterCollectionId} from './tenant-route.js';

export class SharedReadUnverified extends Error {
    constructor(backend, reason) {
        super(`${backend}: shared-collection read unverified (${reason})`);
        this.name = 'SharedReadUnverified';
        this.code = 'VECTHARE_E06_UNVERIFIED_READ';
        this.backend = backend;
        this.reason = reason;
    }
}

/** Fail closed for ambiguous or unqualified tenant identifiers. */
export function sharedTenantFromCollection(collectionId, backend, source='transformers') {
    if (backend !== 'qdrant' && backend !== 'milvus') throw new Error('E06: not a shared backend');
    const raw = adapterCollectionId(collectionId, backend, source);
    let type, sourceId;
    const canonical = /^vh:([^:]+):(.+)$/.exec(raw);
    const legacy = /^vecthare_([^_]+)_(.+)$/.exec(raw);
    if (canonical) [,type,sourceId] = canonical;
    else if (legacy) [,type,sourceId] = legacy;
    if (!type || !sourceId || !/^[a-z][a-z0-9_-]*$/i.test(type) ||
        !sourceId.trim() || type.toLowerCase() === 'unknown' || sourceId.trim().toLowerCase() === 'unknown' ||
        /[\x00-\x1f]/.test(sourceId)) {
        throw new SharedReadUnverified(backend, 'ambiguous-tenant-identity');
    }
    return {type,sourceId};
}

/** The plugin can return ownership only when it appears in the point payload.
 * Missing owner fields mean that even a tenant-filtered response is not proof.
 */
export function assertSharedReadOwnership(items, filters, backend) {
    if (!Array.isArray(items)) throw new SharedReadUnverified(backend,'invalid-results');
    if (!filters || typeof filters.type !== 'string' || typeof filters.sourceId !== 'string' ||
        !filters.type || !filters.sourceId) throw new SharedReadUnverified(backend,'missing-request-tenant');
    for (const item of items) {
        const owner = item?.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
            ? item.metadata : item;
        if (owner?.type !== filters.type || owner?.sourceId !== filters.sourceId) {
            throw new SharedReadUnverified(backend,'missing-or-conflicting-record-owner');
        }
    }
    return items;
}

/** Never use Similharity 3.2.0 shared-backend list output as a full inventory:
 * Qdrant and Milvus swallow backend read errors, and Milvus reports a page
 * length as total. A valid empty list may be the result of a failed query.
 */
export function denyUnverifiedSharedInventory(backend) {
    throw new SharedReadUnverified(backend,'authoritative-inventory-contract-unavailable');
}

/** A display page may contain valid scoped records, but it is not a proof of
 * completeness, including when its HTTP envelope contains total/hasMore.
 */
export function markSharedDisplayPage(page, filters, backend) {
    if (!page || typeof page !== 'object' || page.success === false || page.error || !Array.isArray(page.items))
        throw new SharedReadUnverified(backend,'failed-or-malformed-list');
    assertSharedReadOwnership(page.items, filters, backend);
    return {
        ...page,
        complete: false,
        verifiedInventory: false,
        e06Evidence: 'NOT_AUTHORITATIVE_SHARED_BACKEND',
    };
}

/** Querying zero matches can be useful for retrieval, but is not evidence
 * that a collection is empty or an external backend is healthy. */
export function labelSharedQuery(items, backend) {
    return { readVerification: items.length === 0 ? 'UNVERIFIED_EMPTY' : 'OWNER_FIELDS_CHECKED',
        inventoryComplete: false, backend };
}
