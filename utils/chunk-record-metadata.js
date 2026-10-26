/** Metadata transport helpers. Keep stored optional values unless the caller explicitly supplies a replacement. */
const OVERRIDE_FIELDS = [
    'importance', 'keywords', 'customWeights', 'disabledKeywords',
    'chunkGroup', 'conditions', 'summary', 'isSummaryChunk', 'parentHash',
];

/** Keep nested properties when the corresponding top-level field is absent. */
export function mergeDefinedChunkMetadata(item = {}) {
    const metadata = item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
        ? { ...item.metadata } : {};
    for (const name of OVERRIDE_FIELDS) {
        if (item[name] !== undefined) metadata[name] = item[name];
    }
    return metadata;
}

/** Payload is untrusted for the identity and similarity of a query result. */
export function trustedQueryMetadata(item) {
    return {
        ...(item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata) ? item.metadata : {}),
        hash: item.hash,
        text: item.text,
        score: item.score,
    };
}

/** Keep the complete saved chunk record, including fields stored outside metadata. */
export function completeSavedChunkMetadata(item = {}) {
    const metadata = item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
        ? { ...item.metadata } : {};
    for (const name of ['hash', 'text', 'index']) {
        if (item[name] !== undefined) metadata[name] = item[name];
    }
    return metadata;
}
