/** Phase 0: unambiguous identities. This module has no host dependencies. */
export const COLLECTION_BACKENDS = Object.freeze(['standard', 'vectra', 'lancedb', 'milvus', 'qdrant']);
export const COLLECTION_SOURCES = Object.freeze(['transformers','openai','cohere','ollama','llamacpp','vllm','koboldcpp','webllm','bananabread','openrouter','electronhub','mistral','nomicai','palm','vertexai','togetherai','extras']);
const valid = (s, values) => typeof s === 'string' && values.includes(s);
export function formatCollectionKey({backend, source, collectionId} = {}) {
    if (!valid(backend, COLLECTION_BACKENDS) || !valid(source, COLLECTION_SOURCES) || typeof collectionId !== 'string' || !collectionId.length) {
        throw new Error('Invalid qualified collection identity');
    }
    return `${backend}:${source}:${collectionId}`;
}
export function parseCollectionKey(value) {
    if (typeof value !== 'string') return null;
    const first = value.indexOf(':');
    const second = first < 0 ? -1 : value.indexOf(':', first + 1);
    if (first < 0 || second < 0) return null;
    const parsed = {backend:value.slice(0,first),source:value.slice(first+1,second),collectionId:value.slice(second+1)};
    try { if (formatCollectionKey(parsed) === value) return parsed; } catch (_) { /* invalid */ }
    return null;
}
/** Registry entries retain their original spelling; never auto-migrate them. */
export function resolveCollectionKey(input, {registry = [], backend, source} = {}) {
    if (typeof input !== 'string' || !input || !Array.isArray(registry)) return {status:'none', candidates:[]};
    const matches = new Set();
    for (const entry of registry) {
        if (typeof entry !== 'string') continue;
        const parsed = parseCollectionKey(entry);
        if (parsed) {
            if ((entry === input || parsed.collectionId === input) && (!backend || parsed.backend === backend) && (!source || parsed.source === source)) matches.add(entry);
        } else if (entry === input) {
            // Legacy entries cannot prove their backend/source. Never silently qualify.
            matches.add(entry);
        }
    }
    const candidates = [...matches];
    // A legacy bare entry is independent from a qualified one, even if it has the same text.
    if (candidates.length > 1) return {status:'ambiguous', candidates};
    if (candidates.length === 1 && parseCollectionKey(candidates[0])) return {status:'unique',key:candidates[0],candidates};
    return {status:'none',candidates};
}
