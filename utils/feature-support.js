/** Actual implementation support, not aspirational UI choices. */
const KNOWN = new Set(['per_message','conversation_turns','message_batch','per_scene','per_entry','per_field','per_page','adaptive','paragraph','section','sentence','dialogue']);
export function validateChunkStrategy(strategy, type, source={}) {
    if (!KNOWN.has(strategy)) return {supported:false,reason:'Strategy has no implementation'};
    if (strategy==='per_scene') {
        if (type!=='chat' || source.uploaded || source.kind==='upload') return {supported:false,reason:'Uploaded scene-marker parsing is not implemented'};
        if (source.sceneMarkersPresent===false) return {supported:false,reason:'No scene markers found'};
        return {supported:true}; // marked live-chat scenes handled by scene-marker subsystem
    }
    if (strategy==='adaptive' && type==='chat') return {supported:false,reason:'Adaptive chat grouping currently falls back to per-message and is unavailable'};
    if (['per_message','conversation_turns','message_batch'].includes(strategy) && type!=='chat') return {supported:false,reason:'Chat-only strategy'};
    if (strategy==='per_entry' && type!=='lorebook') return {supported:false,reason:'Lorebook-only strategy'};
    if (strategy==='per_field' && type!=='character') return {supported:false,reason:'Character-only strategy'};
    if (strategy==='per_page' && type!=='wiki') return {supported:false,reason:'Wiki-only strategy'};
    return {supported:true};
}
export function classifierCapabilities() {return {modes:['disabled','classifier'],modelSelectionSupported:false,similaritySupported:false};}
export function requireSupportedChunkStrategy(strategy,type,source={}) {
    const support=validateChunkStrategy(strategy,type,source);
    if(!support.supported)throw new Error(`Unsupported chunking strategy (${strategy}): ${support.reason}`);
    return true;
}
export function requireSupportedClassifierMode({useEmbeddingSimilarity=false}={}) {
    if(useEmbeddingSimilarity)throw new Error('Embedding similarity emotion classification is not implemented; choose classifier mode');
}
