/** Keep semantically activated WI vectors from appearing twice in retrieval. */
export function mergeSemanticWorldInfoChunks(chunks, wiChunks) {
    const key = chunk => `${String(chunk.collectionId)}:${String(chunk.metadata?.hash ?? chunk.hash)}`;
    const seen = new Set(chunks.map(key));
    const uniqueWIChunks = wiChunks.filter(chunk => {
        const id = key(chunk);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
    });
    return { chunks: uniqueWIChunks.concat(chunks), uniqueWIChunks };
}
