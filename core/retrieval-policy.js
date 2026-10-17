/** Pure, collection-aware ranking and chat-overlap utilities. */
export function isChatChunkInRecentContext(chunk, chatLength, depth) {
    if (!depth || !Number.isFinite(depth)) return false;
    const start = Math.max(0, chatLength - depth);
    const ids = chunk?.metadata?.messageIds ||
        (chunk?.metadata?.messageId != null ? [chunk.metadata.messageId] : []);
    return ids.some(id => Number.isInteger(Number(id)) && Number(id) >= start && Number(id) < chatLength);
}
export function rankEligibleChunks(chunks, policy={}, topK=5) {
    const selected = new Set((policy.selectedCollections || []).map(String));
    const mode = policy.mode || 'normal';
    return [...chunks].sort((a,b) => {
        // "Prefer Selected" is a real ranking preference, not just query order.
        if (mode === 'prefer_selected') {
            const pa = selected.has(String(a.collectionId)) ? 1 : 0;
            const pb = selected.has(String(b.collectionId)) ? 1 : 0;
            if (pa !== pb) return pb-pa;
        }
        return (b.score ?? 0)-(a.score ?? 0);
    }).slice(0, topK);
}

/** Request another backend page only if the previous page was full and too
 * few candidates survived ALL injection eligibility checks. */
export function nextCandidateLimit({eligible,target,requested,mayHaveMore,maxLimit}) {
    if(!Number.isSafeInteger(requested)||requested<1||!Number.isSafeInteger(maxLimit)||maxLimit<requested)
        throw new Error('Invalid retrieval candidate budget');
    if(eligible>=target || !mayHaveMore || requested>=maxLimit)return null;
    return Math.min(maxLimit,requested*2);
}

/** Each backend's previously returned prefix may be reused when it is
 * exhausted. A larger prefix is requested only when the last one was full.
 * Backends currently expose ranked Top-K prefixes, not portable cursors. */
export async function loadCachedCandidatePage(cache,collectionId,limit,query){
    if(!Number.isSafeInteger(limit)||limit<1)throw new Error('Invalid candidate limit');
    let snapshot=cache.get(collectionId);
    if(!snapshot || (snapshot.full && snapshot.limit<limit)){
        const result=await query(collectionId,limit);
        if(!Array.isArray(result?.hashes)||!Array.isArray(result?.metadata)||
            result.hashes.length!==result.metadata.length)
            throw new Error('Backend returned malformed candidate results');
        snapshot={result,limit,full:result.hashes.length>=limit};
        cache.set(collectionId,snapshot);
    }
    return snapshot;
}
/** Query safety guard, unrelated to the embedding tokenizer/context window.
 * Raise the old 4096 cutoff while still preventing unbounded memory/network
 * work when everything is filtered. Report incompleteness at this bound. */
export function getCandidateBudget(topK){
    const count=Number(topK);
    if(!Number.isSafeInteger(count)||count<0)throw new Error('Top-K must be a nonnegative integer');
    return Math.max(32,Math.min(65536,Math.max(count*512,8192)));
}
