/**
 * VH-042: the metadata stored with a chunk. VectHare fields may be given on the
 * item itself or inside item.metadata (Chunk Visualizer summaries, Repair's
 * carried annotations, imports). A field absent at the top level must not
 * overwrite the value inside metadata.
 */
const ITEM_FIELDS = ['importance', 'keywords', 'customWeights', 'disabledKeywords', 'chunkGroup',
    'conditions', 'summary', 'isSummaryChunk', 'parentHash'];

export function itemMetadata(item) {
    const metadata = { ...(item?.metadata || {}) };
    for (const field of ITEM_FIELDS) {
        const value = item?.[field] !== undefined ? item[field] : item?.metadata?.[field];
        if (value !== undefined) metadata[field] = value;
        else delete metadata[field];
    }
    return metadata;
}
