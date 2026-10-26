/** I04: validate read responses before treating them as empty data. */
export function requireListedItems(payload, backend) {
    if (!payload || typeof payload !== 'object' || payload.success === false ||
        payload.error || !Array.isArray(payload.items)) {
        throw new Error(`${backend}: invalid or unsuccessful collection-list response`);
    }
    return payload.items;
}

export function requireQueryItems(payload, backend) {
    if (!payload || typeof payload !== 'object' || payload.success === false || payload.error) {
        throw new Error(`${backend}: unsuccessful collection-query response`);
    }
    const items = payload.results ?? payload.chunks;
    if (!Array.isArray(items)) {
        throw new Error(`${backend}: collection-query response has no results array`);
    }
    return items;
}

// Fall back only when the hybrid route is absent or explicitly unsupported.
export function hybridEndpointUnsupported(status) {
    return status === 404 || status === 405 || status === 501;
}
