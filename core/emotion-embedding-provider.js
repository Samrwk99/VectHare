/** C14 read-only Similharity contract: POST /batch-embeddings {texts,source,model}.
 * The supplied plugin's Transformers path needs no browser-provided secrets or URL.
 * Other sources stay unsupported until their effective provider fields and credentials
 * can be verified safely. This module does not mutate the Similharity plugin.
 */
export function emotionEmbeddingCapabilities(settings={}) {
    const source=settings.source||'transformers';
    if(source!=='transformers')return {supported:false,source,reason:'Only the plugin local Transformers embedding contract is verified for C14; change embedding source to Transformers or use classifier mode'};
    return {supported:true,source,model:'server-controlled',reason:null};
}
export function createPluginEmotionEmbedder({settings={},request,signal}={}) {
    const capability=emotionEmbeddingCapabilities(settings);
    if(!capability.supported)throw new Error(`C14 embedding similarity unavailable: ${capability.reason}`);
    if(typeof request!=='function')throw new Error('C14 missing authenticated request function');
    // No client-side model selector for similarity: plugin determines Transformers model.
    const profileKey=JSON.stringify(['similharity','transformers','server-model','ct-prototypes-v1']);
    async function embed(texts){
        if(!Array.isArray(texts) || !texts.length || texts.length>120 || texts.some(t=>typeof t!=='string'||!t.trim()))throw new Error('C14 invalid texts for embedding');
        const response=await request('/api/plugins/similharity/batch-embeddings', {
            method:'POST',body:JSON.stringify({texts,source:'transformers',model:''}),signal,
        });
        if(!response?.ok)throw new Error(`C14 embedding endpoint failed (HTTP ${response?.status ?? 'unknown'})`);
        const result=await response.json();
        if(result?.success!==true || !Array.isArray(result.embeddings) || result.embeddings.length!==texts.length)throw new Error('C14 embedding endpoint returned an invalid acknowledgement or batch');
        return result.embeddings;
    }
    return {embed,profileKey,capability};
}
