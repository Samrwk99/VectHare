import { saveVectHareSettingsDebounced as saveSettingsDebounced } from './settings-durability.js';
/** Persisted crash-recovery journal. Database records are authoritative; this
 * journal is deliberately only progress metadata, never chat text or secrets.
 * Persist each accepted chunk synchronously where localStorage is available.
 */
import { extension_settings } from '../../../../extensions.js';


const PREFIX='vecthare:sync-checkpoint:v1:';
const storageKey=(key,chatUUID)=>`${PREFIX}${encodeURIComponent(key)}:${encodeURIComponent(chatUUID)}`;
const store=()=>{
    extension_settings.vecthare ||= {};
    return extension_settings.vecthare.syncCheckpoints ||= {};
};
function safeRead(key) {
    try {const raw=globalThis.localStorage?.getItem(key);return raw?JSON.parse(raw):null;}catch{return null;}
}
function persist(key,chatUUID,record) {
    const id=`${key}\u0000${chatUUID}`;
    store()[id]=structuredClone(record);
    try {globalThis.localStorage?.setItem(storageKey(key,chatUUID),JSON.stringify(record));} catch(error) {
        console.warn('[VectHare] Immediate checkpoint storage unavailable; database reconciliation remains authoritative:',error);
    }
    saveSettingsDebounced();
    return record;
}
export function getSyncCheckpoint(key,chatUUID) {
    if(!key||!chatUUID)return null;
    const record=safeRead(storageKey(key,chatUUID))||store()[`${key}\u0000${chatUUID}`];
    return record?.version===1 && record.registryKey===key && record.chatUUID===chatUUID ? structuredClone(record):null;
}
export function getCurrentSyncCheckpoint(binding,chatUUID) {
    return getSyncCheckpoint(binding?.registryKey,chatUUID);
}
export function beginSyncCheckpoint(key,chatUUID,total,verified=0) {
    const previous=getSyncCheckpoint(key,chatUUID);
    return persist(key,chatUUID,{version:1,registryKey:key,chatUUID,phase:'running',total,
        verified,updatedAt:Date.now(),lastHash:previous?.lastHash||null,activeHash:null,
        message:'Verifying database and continuing missing chunks'});
}
export function updateSyncCheckpoint(key,chatUUID,patch) {
    const old=getSyncCheckpoint(key,chatUUID);
    if(!old)throw new Error('Cannot update an absent sync checkpoint');
    return persist(key,chatUUID,{...old,...patch,updatedAt:Date.now()});
}
export function acknowledgeSyncChunk(key,chatUUID,hash,verified) {
    return updateSyncCheckpoint(key,chatUUID,{lastHash:String(hash),activeHash:null,verified,message:'Vector acknowledged and manifest persisted'});
}
export function finalizeSyncCheckpoint(key,chatUUID,phase,message) {
    const old=getSyncCheckpoint(key,chatUUID);
    if(!old)return null;
    return updateSyncCheckpoint(key,chatUUID,{phase,activeHash:null,message});
}
export function clearSyncCheckpoint(key,chatUUID) {
    delete store()[`${key}\u0000${chatUUID}`];
    try{globalThis.localStorage?.removeItem(storageKey(key,chatUUID));}catch{}
    saveSettingsDebounced();
}
/** Explicitly deleted collections must not retain resumable journal entries. */
export function clearRecoveryForCollection(key) {
    if(!key)return;
    for(const id of Object.keys(store()))if(id.startsWith(`${key}\u0000`))delete store()[id];
    const pending=extension_settings.vecthare?.pendingVectorizations||{};
    for(const [id,entry] of Object.entries(pending))if(entry?.registryKey===key)delete pending[id];
    try{
        const storage=globalThis.localStorage;
        if(storage){
            const keys=[];
            storage.removeItem('vecthare:native-profile:v1:'+encodeURIComponent(key));
            for(let i=0;i<storage.length;i++){
                const item=storage.key(i);
                if(item?.startsWith(`${PREFIX}${encodeURIComponent(key)}:`))keys.push(item);
                else if(item?.startsWith('vecthare:pending-content:v1:')){
                    try{if(JSON.parse(storage.getItem(item))?.registryKey===key)keys.push(item);}catch{}
                }
            }
            for(const item of keys)storage.removeItem(item);
        }
    }catch{}
    saveSettingsDebounced();
}
export function clearAllRecovery() {
    extension_settings.vecthare ||= {};
    extension_settings.vecthare.syncCheckpoints={};
    extension_settings.vecthare.pendingVectorizations={};
    try{
        const storage=globalThis.localStorage;
        if(storage){
            const keys=[];
            for(let i=0;i<storage.length;i++){
                const key=storage.key(i);
                if(key?.startsWith(PREFIX)||key?.startsWith('vecthare:pending-content:v1:')||key?.startsWith('vecthare:native-profile:v1:'))keys.push(key);
            }
            for(const key of keys)storage.removeItem(key);
        }
    }catch{}
    saveSettingsDebounced();
}
/** Discover a previously interrupted Content Vectorizer staging collection for
 * the current chat. This never adopts it or changes the original binding.
 */
export function getPendingContentForChat(chatUUID){
    if(!chatUUID)return null;
    const entries=Object.values(extension_settings.vecthare?.pendingVectorizations||{});
    try{
        const storage=globalThis.localStorage;
        if(storage)for(let i=0;i<storage.length;i++){
            const key=storage.key(i);
            if(key?.startsWith('vecthare:pending-content:v1:')){
                try{const entry=JSON.parse(storage.getItem(key));if(entry)entries.push(entry);}catch{}
            }
        }
    }catch{}
    const relevant=entries.filter(item=>{
        if(!item?.registryKey || !item?.fingerprint)return false;
        try{const fingerprint=JSON.parse(item.fingerprint);return fingerprint[3]===chatUUID && fingerprint[0]==='chat' && fingerprint[1]==='current';}
        catch{return false;}
    }).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    const found=relevant[0];
    if(!found)return null;
    const parsed=JSON.parse(found.fingerprint);
    return {registryKey:found.registryKey,previousCollectionKey:parsed[4]||null,
        strategy:parsed[5]||null,chunkSize:parsed[6]||null,batchSize:parsed[7]||null,
        checkpoint:getSyncCheckpoint(found.registryKey,chatUUID)};
}
