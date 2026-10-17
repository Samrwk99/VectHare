/**
 * Settings editor isolation: a UI form is NOT an authoritative snapshot.
 * Apply only user-edited paths, rather than copying stale defaults from a
 * panel opened before another collection, tab or modal changed the store.
 * Arrays are atomic; nested plain objects are merged by edited leaf.
 */
const IMMUTABLE_SYSTEM_KEYS=new Set(['collections','vecthare_collection_registry','chatCollectionBindings','chatCollectionPolicies','pendingVectorizations']);
function plain(value){return value!==null && typeof value==='object' && !Array.isArray(value) && Object.getPrototypeOf(value)===Object.prototype;}
function same(a,b){return JSON.stringify(a)===JSON.stringify(b);}
function copy(value){return structuredClone(value);}
function applyLeaves(next,previous,destination){
    for(const key of Object.keys(next)){
        if(IMMUTABLE_SYSTEM_KEYS.has(key))continue;
        const value=next[key];
        const old=previous?.[key];
        if(same(value,old))continue;
        if(plain(value)&&plain(old)&&plain(destination[key])){
            applyLeaves(value,old,destination[key]);
        } else destination[key]=copy(value);
    }
}
/** Persist changes from an editor without touching unrelated system metadata.
 * The baseline is mutable and tracks the last UI-confirmed snapshot.
 * Reconcile the local draft to the effective shared settings after each edit.
 */
export function applyEditedSettings(draft,destination,baseline){
    if(!plain(draft)||!plain(destination)||!plain(baseline))throw new Error('Invalid settings editor state');
    const edited=copy(draft);
    applyLeaves(edited,baseline,destination);
    for(const [key,value] of Object.entries(destination)){
        if(IMMUTABLE_SYSTEM_KEYS.has(key))continue;
        draft[key]=copy(value);
    }
    for(const key of Object.keys(baseline))delete baseline[key];
    Object.assign(baseline,copy(draft));
}
