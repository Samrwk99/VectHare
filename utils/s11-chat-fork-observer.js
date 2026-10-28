/** S11: detect copied chat UUIDs, without altering SillyTavern metadata.
 * This is a conservative LOCAL collision detector, NOT a trusted host ownership
 * attestation. It may quarantine renames; never use it to grant server access.
 */
const KEY='vecthare:s11:observed-chat-identities:v1';
const MAX=2048;
const norm=value=>typeof value==='string' && value.trim() && value.length<=256 ? value.trim() : '';
const empty=()=>({version:1,origins:{},quarantined:[]});
function parse(raw){
    if(!raw)return empty();
    try{
        const obj=JSON.parse(raw);
        if(obj?.version!==1 || !obj.origins || typeof obj.origins!=='object' || !Array.isArray(obj.quarantined))return null;
        if(Object.keys(obj.origins).length>MAX || obj.quarantined.length>MAX)return null;
        return obj;
    }catch{return null;}
}
function result(status,reason,originId=null){return Object.freeze({status,reason,originId,authorized:false});}
/** Storage may be absent or untrusted. A broken existing registry must not be silently recreated. */
export function observeChatFork({chatId,integrity,storage}={}){
    const chat=norm(chatId),origin=norm(integrity);
    if(!chat||!origin)return result('UNVERIFIED','missing-host-chat-or-integrity');
    if(!storage || typeof storage.getItem!=='function'||typeof storage.setItem!=='function')return result('UNVERIFIED','observation-storage-unavailable');
    let raw;
    try{raw=storage.getItem(KEY);}catch{return result('UNVERIFIED','observation-storage-unavailable');}
    const state=parse(raw);
    if(!state)return result('QUARANTINED','invalid-identity-registry');
    if(state.quarantined.includes(origin))return result('QUARANTINED','copied-or-conflicting-origin');
    const existing=state.origins[origin];
    if(existing!==undefined && (typeof existing!=='string'||!existing))return result('QUARANTINED','invalid-identity-registry');
    if(existing && existing!==chat){
        state.quarantined.push(origin);
        try{storage.setItem(KEY,JSON.stringify(state));}catch{ /* still refuse */ }
        return result('QUARANTINED','copied-or-conflicting-origin');
    }
    if(!existing){
        if(Object.keys(state.origins).length>=MAX)return result('UNVERIFIED','registry-capacity');
        state.origins[origin]=chat;
        try{storage.setItem(KEY,JSON.stringify(state));}catch{return result('UNVERIFIED','observation-storage-unavailable');}
    }
    return result('OBSERVED_UNIQUE','local-observation-only',origin);
}
export function getObservedChatOrigin({chatId,integrity,storage}={}){
    return observeChatFork({chatId,integrity,storage}).originId;
}
export const S11_CHAT_OBSERVATION_KEY=KEY;
