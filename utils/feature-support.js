/** Actual implementation support, not aspirational UI choices. */
const KNOWN = new Set(['per_message','conversation_turns','message_batch','per_scene','per_entry','per_field','per_page','adaptive','paragraph','section','sentence','dialogue']);
export function validateChunkStrategy(strategy, type, source={}) {
    if (!KNOWN.has(strategy)) return {supported:false,reason:'Strategy has no implementation'};
    if (strategy==='per_scene') {
        if (type!=='chat') return {supported:false,reason:'Per-scene is chat-only'};
        if (source.kind==='live_chat' || (!source.uploaded && source.kind!=='upload'))
            return {supported:true}; // existing live-chat scene marker subsystem
        if (source.sceneMarkersPresent !== true)
            return {supported:false,reason:'Select an uploaded chat containing complete scene markers first'};
        return {supported:true};
    }
    if (strategy==='adaptive' && type==='chat') {
        if (source.kind==='live_chat' || source.existingCollection)
            return {supported:false,reason:'Adaptive changes record identities; create a new versioned collection through the Content Vectorizer'};
        return {supported:true}; // new uploaded-chat collection only
    }
    if (['per_message','conversation_turns','message_batch'].includes(strategy) && type!=='chat') return {supported:false,reason:'Chat-only strategy'};
    if (strategy==='per_entry' && type!=='lorebook') return {supported:false,reason:'Lorebook-only strategy'};
    if (strategy==='per_field' && type!=='character') return {supported:false,reason:'Character-only strategy'};
    if (strategy==='per_page' && type!=='wiki') return {supported:false,reason:'Wiki-only strategy'};
    return {supported:true};
}
export function classifierCapabilities({source='transformers'}={}) {return {modes:['disabled','classifier',...(source==='transformers'?['similarity']:[])],modelSelectionSupported:false,similaritySupported:source==='transformers',similarityRequiresPlugin:true};}
export function requireSupportedChunkStrategy(strategy,type,source={}) {
    const support=validateChunkStrategy(strategy,type,source);
    if(!support.supported)throw new Error(`Unsupported chunking strategy (${strategy}): ${support.reason}`);
    return true;
}
export function requireSupportedClassifierMode({useEmbeddingSimilarity=false,source='transformers'}={}) {
    if(useEmbeddingSimilarity && source!=='transformers') throw new Error('Embedding similarity requires the verified local Transformers source');
    return true;
}
