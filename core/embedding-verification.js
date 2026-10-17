/** Optional read-only numerical audit. This cannot prove semantic correctness. */
import { getBackend } from '../backends/backend-manager.js';
import { getProviderSpecificParams } from '../backends/provider-params.js';
import { getModelField } from './providers.js';
import { getRequestHeaders } from '../../../../../script.js';
import { parseRegistryKey } from './collection-ids.js';
import { getCollectionProfile, applyAndVerifyProfile, settingsForSavedCollection } from './vectorization-profile.js';

export function cosineSimilarity(a,b) {
    if(!Array.isArray(a)||!Array.isArray(b)||a.length!==b.length||!a.length)return null;
    let dot=0,an=0,bn=0;
    for(let i=0;i<a.length;i++) {
        if(!Number.isFinite(a[i])||!Number.isFinite(b[i]))return null;
        dot+=a[i]*b[i];an+=a[i]*a[i];bn+=b[i]*b[i];
    }
    return an>0&&bn>0?dot/(Math.sqrt(an)*Math.sqrt(bn)):null;
}
/** Sample a few unchanged vectors; never writes or automatically repairs vectors. */
export async function verifyEmbeddingSamples(key, settings, {maxSamples=3, threshold=0.995}={}) {
    const parsed=parseRegistryKey(key);
    if(!parsed.backend || !parsed.source)throw new Error('A qualified collection identity is required');
    const saved=getCollectionProfile(key);
    if(!saved?.embedding?.verified)throw new Error('Original embedding settings are unknown; use Legacy Recovery or a new collection');
    const effectiveSettings={...settings,vector_backend:parsed.backend,source:parsed.source};
    const {settings:effective}=await applyAndVerifyProfile(key,settingsForSavedCollection(key,effectiveSettings));
    const backend=await getBackend(effective);
    if(typeof backend.listChunks!=='function')throw new Error('Backend does not expose stored vectors');
    const response=await backend.listChunks(parsed.collectionId,effective,{offset:0,limit:Math.max(1,Math.min(10,maxSamples)),includeVectors:true});
    if(!Array.isArray(response?.items))throw new Error('Could not read vector samples');
    if(!response.items.length)return {sampled:0,passed:0,suspicious:[],unverifiable:[],message:'No vectors present; cannot assess embedding compatibility'};
    const result={sampled:0,passed:0,suspicious:[],unverifiable:[]};
    const {apiUrl,...providerParams}=getProviderSpecificParams(effective);
    const field=getModelField(effective.source);
    for(const sample of response.items.slice(0,maxSamples)) {
        const hash=String(sample.hash??'unknown');
        if(typeof sample.text!=='string'||!Array.isArray(sample.vector)||!sample.vector.length) {
            result.unverifiable.push({hash,reason:'Backend did not return stored text and numerical vector'});continue;
        }
        const response=await fetch('/api/plugins/similharity/get-embedding',{
            method:'POST',headers:getRequestHeaders(),body:JSON.stringify({source:effective.source,
                model:field?effective[field]||'':'',...(apiUrl?{apiUrl}:{}),...providerParams,text:sample.text}),
        });
        if(!response.ok)throw new Error(`Embedding verification provider request failed (HTTP ${response.status})`);
        const body=await response.json();
        const similarity=cosineSimilarity(sample.vector,body.embedding);
        result.sampled++;
        if(similarity===null)result.unverifiable.push({hash,reason:'Dimension mismatch, invalid values or zero-length vector'});
        else if(similarity<threshold)result.suspicious.push({hash,similarity});
        else result.passed++;
    }
    return result;
}
