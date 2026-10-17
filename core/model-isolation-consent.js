/**
 * Acknowledgement gate for NEW embedding spaces. This is deliberately separate
 * from compatibility validation: acknowledgement never authorizes mixing
 * embeddings or writing to a physically incompatible Qdrant vector field.
 */
export function modelIsolationDecision(provider, model, savedProfiles = []) {
    const selectedProvider = String(provider || '').trim();
    const selectedModel = String(model || '').trim();
    const token = JSON.stringify([selectedProvider, selectedModel]);
    const others = savedProfiles.filter(p => {
        if (!p?.embedding) return false;
        const priorProvider = String(p.embedding.provider || '').trim();
        const priorModel = String(p.embedding.configuredModel || p.embedding.modelId || '').trim();
        return priorProvider !== selectedProvider || (priorModel && (!selectedModel || priorModel !== selectedModel));
    });
    return {requiresConfirmation:others.length>0,token,otherCount:others.length};
}
