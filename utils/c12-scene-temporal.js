/** C12 scene/temporal primitives. No storage access, host APIs or network calls. */

/** The newest constituent determines a group's age, not its stale first index. */
export function calculateGroupAge(metadata = {}, currentMessageId) {
    const current = Number(currentMessageId);
    if (!Number.isSafeInteger(current) || current < 0) return null;
    const indices = Array.isArray(metadata.messageIds) && metadata.messageIds.length
        ? metadata.messageIds : [metadata.sceneEnd, metadata.messageId, metadata.index].filter(x => x != null);
    if (!indices.length || indices.length > 10000) return null;
    let newest = -1;
    for (const raw of indices) {
        if (raw === null || raw === '' || typeof raw === 'boolean') return null;
        const index = Number(raw);
        if (!Number.isSafeInteger(index) || index < 0 || index > current) return null;
        if (index > newest) newest = index;
    }
    return current - newest;
}

export function normalizeSceneTimeline(chatOriginId, collectionKey, entries, chatLength) {
    if (!chatOriginId || !collectionKey || !Array.isArray(entries)) return [];
    const timeline = [];
    for (const entry of entries) {
        if (!entry || entry.chatOriginId !== chatOriginId || entry.collectionKey !== collectionKey) continue;
        const start = Number(entry.sceneStart), end = Number(entry.sceneEnd);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= chatLength) continue;
        timeline.push({start, end, sceneId: String(entry.sceneId ?? '')});
    }
    timeline.sort((a,b) => a.start - b.start || a.end - b.end || a.sceneId.localeCompare(b.sceneId));
    // Do not interpret overlapping or duplicated boundaries as reliable context.
    for (let i = 1; i < timeline.length; i++) if (timeline[i].start <= timeline[i - 1].end) return [];
    return timeline;
}

/** Explicit collection metadata always takes precedence over the legacy global fallback. */
export function resolveTemporalPolicy(collectionKey, {getPolicy, legacyPolicy = {enabled:false}} = {}) {
    const policy = collectionKey && typeof getPolicy === 'function' ? getPolicy(collectionKey) : null;
    const value = policy && typeof policy === 'object' ? policy : legacyPolicy;
    const type = value?.type === 'nostalgia' ? 'nostalgia' : 'decay';
    const mode = value?.mode === 'linear' ? 'linear' : 'exponential';
    return {
        enabled: value?.enabled === true,
        type, mode,
        halfLife: Number.isFinite(Number(value?.halfLife)) && Number(value.halfLife) > 0 ? Number(value.halfLife) : 50,
        linearRate: Number.isFinite(Number(value?.linearRate)) && Number(value.linearRate) >= 0 ? Number(value.linearRate) : 0.01,
        minRelevance: Number.isFinite(Number(value?.minRelevance)) ? Math.min(1,Math.max(0,Number(value.minRelevance))) : 0.3,
        maxBoost: Number.isFinite(Number(value?.maxBoost)) ? Math.min(5,Math.max(1,Number(value.maxBoost))) : 2,
        sceneAware: value?.sceneAware === true && type === 'decay',
    };
}

/**
 * Collection-specific weighting; never pair results by physical hash, because
 * identical hashes can exist in multiple collections or distinct message groups.
 * The caller supplies the existing battle-tested decay/nostalgia implementations.
 */
export function weightChunksByCollection(chunks, currentMessageId, {
    getPolicy, getTimeline, legacyPolicy,
    applyDecay, applyNostalgia, applySceneDecay,
} = {}) {
    const groups = new Map();
    for (let i = 0; i < chunks.length; i++) {
        const key = chunks[i].collectionId || chunks[i].collectionKey || chunks[i].metadata?.collectionKey || null;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({index:i,chunk:chunks[i]});
    }
    const results = [...chunks];
    for (const [key, group] of groups) {
        const policy = resolveTemporalPolicy(key, {getPolicy,legacyPolicy});
        if (!policy.enabled) continue;
        const enriched = group.map(({chunk}) => {
            const age = calculateGroupAge(chunk.metadata, currentMessageId);
            const newestIndex = age === null ? null : currentMessageId - age;
            return {
                ...chunk,
                metadata: newestIndex === null ? {...chunk.metadata,source:undefined} : {...chunk.metadata,messageId:newestIndex},
            };
        });
        const timeline = policy.sceneAware && key && typeof getTimeline === 'function'
            ? getTimeline(key) : [];
        const weighted = policy.type === 'nostalgia' ? applyNostalgia(enriched,currentMessageId,policy)
            : policy.sceneAware && timeline.length ? applySceneDecay(enriched,currentMessageId,timeline,policy)
                : applyDecay(enriched,currentMessageId,policy);
        if (!Array.isArray(weighted) || weighted.length !== group.length) throw new Error('Temporal weighting changed candidate cardinality');
        for (let i = 0; i < group.length; i++) {
            const result = weighted[i];
            results[group[i].index] = {
                ...group[i].chunk,score:result.score,
                ...(result.decayApplied && {decayApplied:true}),
                ...(result.nostalgiaApplied && {nostalgiaApplied:true}),
                ...(result.sceneAwareDecay && {sceneAwareDecay:true}),
                ...(result.originalScore !== undefined && {originalScore:result.originalScore}),
                ...(result.messageAge !== undefined && {messageAge:result.messageAge}),
                ...(result.effectiveAge !== undefined && {messageAge:result.effectiveAge}),
                temporalPolicyCollection:key,
            };
        }
    }
    return results;
}
