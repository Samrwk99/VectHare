/** Chat-wide, read-only reconciliation scan and confirmed two-phase repair. */
import { getContext } from '../../../../extensions.js';
import { getChatUUID } from './collection-ids.js';
import { getChatBinding, resolveChatWriteTarget } from './collection-ownership.js';
import { getChatChunkManifest, saveChatChunkManifest, applyAndVerifyProfile } from './vectorization-profile.js';
import { getBackend } from '../backends/backend-manager.js';
import { insertVectorItems, deleteVectorItems } from './core-vector-api.js';
import { buildExpectedChatItems } from './chat-vectorization.js';

async function inventory(collectionId, settings) {
    const backend=await getBackend(settings);
    if(typeof backend.listChunks!=='function') throw new Error('Backend does not support complete chunk inspection');
    const rows=[];
    for(let offset=0;offset<100000;offset+=200) {
        const response=await backend.listChunks(collectionId,settings,{offset,limit:200});
        if(!Array.isArray(response?.items)) throw new Error('Chunk listing unavailable: cannot assert All Clear');
        rows.push(...response.items);
        if(response.items.length < 200) break;
        if(offset>=99800)throw new Error('Collection exceeds safety inspection limit; scan not complete');
    }
    return rows;
}
export async function scanCurrentChat(settings) {
    const chatUUID=getChatUUID();
    const binding=getChatBinding(chatUUID);
    if(!chatUUID || !binding) throw new Error('Connect and verify a collection for this chat before scanning');
    const target=resolveChatWriteTarget(settings,chatUUID);
    const {settings:effective,profile}=await applyAndVerifyProfile(target.registryKey,settings);
    const startChatId=chatUUID;
    const expected=await buildExpectedChatItems(getContext()?.chat,effective);
    if(getChatUUID()!==startChatId)throw new Error('Chat changed during scan');
    const actual=await inventory(target.collectionId,effective);
    const manifest=getChatChunkManifest(target.registryKey);
    if(!manifest || manifest.chatUUID !== chatUUID)throw new Error('Chat lacks a verifiable chunk manifest. Do not repair automatically; re-vectorize safely or restore metadata.');
    if(actual.some(row=>!row.text || !row.metadata || (!Array.isArray(row.metadata.messageIds) && row.metadata.messageId == null))) throw new Error('Backend cannot return source text/metadata; full verification unavailable');
    // A hash alone is insufficient: backend payload metadata may have been
    // modified independently or the original text could include stale suffixes.
    const matchesExpected = (old, item) => {
        const keywords=(item.keywords||[]).map(k=>k.text||k).join(' ');
        const appended=keywords ? `${item.text} [KEYWORDS: ${keywords}]` : String(item.text);
        const exactText=String(old.text)===String(item.text) || String(old.text)===appended;
        const ids=meta=>(meta?.messageIds||[meta?.messageId]).filter(x=>x!=null).map(String);
        const hashes=meta=>Array.isArray(meta?.messageHashes)?meta.messageHashes.map(String):[];
        return exactText && JSON.stringify(ids(old.metadata))===JSON.stringify(ids(item.metadata)) &&
            JSON.stringify(hashes(old.metadata))===JSON.stringify(hashes(item.metadata));
    };
    const wanted=new Map(expected.map(e=>[String(e.hash),e]));
    const current=new Map();
    const duplicates=[];
    for(const item of actual){
        const key=String(item.hash);
        if(current.has(key))duplicates.push(key);
        else current.set(key,item);
    }
    const missing=[];
    for(const [hash,item] of wanted) {
        const old=current.get(hash);
        if(!old)missing.push(item);
        else if(!matchesExpected(old,item)) {
            // Metadata mismatch cannot be corrected by overwriting a hash safely.
            missing.push(item);
        }
    }
    const stale=actual.filter(a=>!wanted.has(String(a.hash)));
    const issues=[...missing.map(item=>({type:'missing_or_mismatched',hash:item.hash})),...stale.map(item=>({type:'outdated_or_deleted',hash:item.hash})),...duplicates.map(hash=>({type:'duplicate',hash}))];
    return {chatUUID,target,profile,effective,expected,actual,missing,stale,duplicates,issues,scannedAt:Date.now()};
}
export async function repairCurrentChat(settings, scan) {
    if(!scan || !scan.scannedAt || Date.now()-scan.scannedAt>300000) throw new Error('Scan expired. Scan again before repairing.');
    if(getChatUUID()!==scan.chatUUID)throw new Error('Chat changed. Repair cancelled.');
    // Detect edits or swipes between scan and repair, before modifying storage.
    const updated=await buildExpectedChatItems(getContext()?.chat,scan.effective);
    if(JSON.stringify(updated.map(i=>[i.hash,i.text]))!==JSON.stringify(scan.expected.map(i=>[i.hash,i.text])))throw new Error('Chat changed since scan. Scan again.');
    const target=resolveChatWriteTarget(settings,scan.chatUUID);
    if(target.registryKey!==scan.target.registryKey)throw new Error('Collection binding changed since scan');
    const {settings:effective}=await applyAndVerifyProfile(target.registryKey,settings);
    // First write missing/current chunks. Never remove a valid old vector
    // before the new embedding has been durably acknowledged and verified.
    if(scan.missing.length){
        await insertVectorItems(target.collectionId,scan.missing,effective);
        const verify=await inventory(target.collectionId,effective);
        const hashes=new Set(verify.map(row=>String(row.hash)));
        for(const item of scan.missing)if(!hashes.has(String(item.hash)))throw new Error(`Replacement embedding ${item.hash} not confirmed in database; older chunks retained.`);
    }
    if(scan.duplicates.length)throw new Error('Duplicate point hashes cannot be safely distinguished by the current backend; no destructive duplicate cleanup attempted.');
    const obsolete=[...new Set(scan.stale.map(x=>x.hash))];
    if(obsolete.length){
        await deleteVectorItems(target.collectionId,obsolete,effective);
        const verify=await inventory(target.collectionId,effective);
        const remaining=new Set(verify.map(x=>String(x.hash)));
        if(obsolete.some(x=>remaining.has(String(x))))throw new Error('Some stale vectors remained after deletion. Not marking repair complete.');
    }
    await saveChatChunkManifest(target.registryKey,updated,scan.chatUUID);
    return scanCurrentChat(settings);
}
/** Automatic message-delete cleanup: do nothing on unverified/legacy data. */
export async function reconcileDeletedMessages(settings) {
    try {
        const scan=await scanCurrentChat(settings);
        const manifest=getChatChunkManifest(scan.target.registryKey);
        // SillyTavern renumbers all message indices after deleting from the
        // middle. An index-set comparison misses that change. Use actual source
        // hashes and references instead. Restrict automatic repair to the
        // previously vectorized part of the chat; do not silently enable full
        // chat vectorization merely because a message was deleted.
        const trackedIds=(manifest.entries||[]).flatMap(e=>e.messageIds||[]).filter(Number.isInteger);
        if(!trackedIds.length)return;
        const lastPreviouslyEmbedded=Math.max(...trackedIds);
        const affectedMissing=scan.missing.filter(item=>{
            const ids=item.metadata?.messageIds || [item.metadata?.messageId];
            return ids.some(index=>Number.isInteger(index) && index<=lastPreviouslyEmbedded);
        });
        if(!scan.stale.length && !affectedMissing.length)return;
        if(!scan.stale.length)return; // New unsynced messages alone aren't a deletion.
        const narrowed={...scan,missing:affectedMissing};
        await repairCurrentChat(settings,narrowed);
    } catch(e) {console.warn('[VectHare] Automatic deletion reconciliation pending a manual Scan/Repair:',e.message);}
}
