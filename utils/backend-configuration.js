/** C06 #7: invalidate backend instances when relevant provider/server settings change.
 * Fingerprints are opaque, held in memory only, and never logged or persisted.
 * The comparison includes credentials so a rotated key cannot reuse an old
 * connection, but credentials are not returned by this function.
 */
import {fingerprint} from './record-identity.js';
const SHARED = new Set(['source','vector_backend','embedding_model','model','model_id','provider','provider_model',
    'embedding_dimensions','embedding_provider','embedding_settings','api_url','api_key',
    'openai_model','cohere_model','ollama_model','ollama_url','transformers_model',
    'nomicai_model','openrouter_model','llamacpp_model','vllm_model','koboldcpp_model']);
const PREFIXES = ['qdrant_','milvus_','lancedb_','vectra_','embedding_','provider_'];
export function backendConfigurationFingerprint(backend, settings={}) {
    if (typeof backend!=='string'|| !backend.length) throw new Error('Backend required');
    if (!settings || typeof settings!=='object' || Array.isArray(settings)) throw new Error('Settings required');
    const picked={};
    for (const name of Object.keys(settings).sort()) {
        if (!SHARED.has(name) && !PREFIXES.some(prefix=>name.startsWith(prefix))) continue;
        const v=settings[name];
        if (v === undefined || typeof v==='function' || typeof v==='symbol') continue;
        // Only stable JSON values are relevant for settings. Nonserializable
        // data must not silently match a prior configuration.
        try {picked[name]=JSON.parse(JSON.stringify(v));}catch(_){throw new Error('Unserializable backend settings');}
    }
    return fingerprint({backend,settings:picked});
}
