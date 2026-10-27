/** Phase 0 pinned evidence is deliberately conservative: adapter calls alone are NOT server contracts. */
export const BACKEND_CAPABILITIES=Object.freeze(Object.fromEntries(['standard','qdrant','milvus','lancedb'].map(backend=>[
    backend, Object.freeze({
        listPagination:'unknown',completeInventory:'unknown',count:'unknown',getByIds:'unknown',
        updatePayload:'unknown',clientVectors:'unknown',tenantFilter:'unknown',pointTenantFilter:'unknown',purgeAcknowledgement:'unknown',
        c01ScopedDeleteGate:'unknown',globalDeleteGate:'unknown',
        insertAcknowledgement:'unknown',deleteAcknowledgement:'unknown'
    })
])));
export function hasVerifiedCapability(backend,capability){return BACKEND_CAPABILITIES[backend]?.[capability]==='verified';}
