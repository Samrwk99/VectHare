/** Chat-wide, read-only reconciliation scan and confirmed two-phase repair. */
import { getContext } from '../../../../extensions.js';
import { getCurrentChatId } from '../../../../../script.js';
import { getChatUUID } from './collection-ids.js';
import { getChatBinding, resolveChatWriteTarget } from './collection-ownership.js';
import { getChatChunkManifest, saveChatChunkManifest, applyAndVerifyProfile } from './vectorization-profile.js';
import { getBackend } from '../backends/backend-manager.js';
import { insertVectorItems, deleteVectorItems } from './core-vector-api.js';
import { chunkMatchesExpected, inspectCollectionChunks } from './chunk-integrity.js';
import {startActivity,updateActivity,finishActivity} from '../ui/activity-status.js';
import {acquireSharedOperation,finishSharedOperation,SharedOperationStoppedError} from '../ui/shared-operations.js';
import {createOperationControl,detachOperationControl,hasActiveVectorWrite,OperationStoppedError} from '../ui/operation-controls.js';
import { buildExpectedChatItems } from './chat-vectorization.js';

async function inventory(collectionId, settings, onProgress = null, control=null) {
    const backend=await getBackend(settings);
    if(typeof backend.listChunks!=='function') throw new Error('Backend does not support complete chunk inspection');
    const rows=[];
    const cursorMode=settings.vector_backend==='qdrant';
    let cursor=null;
    const seenCursors=new Set();
    for(let offset=0;offset<100000;offset+=200) {
        await control?.checkpoint();
        const response=await backend.listChunks(collectionId,settings,
            cursorMode?{cursor,pageSize:200}:{offset,limit:200});
        if(!Array.isArray(response?.items)) throw new Error('Chunk listing unavailable: cannot assert All Clear');
        rows.push(...response.items);
        onProgress?.({detail:`Inspecting stored embeddings · ${rows.length} chunks read`});
        if(cursorMode) {
            if(response.pageMode!=='cursor') throw new Error('Matching Qdrant plugin cursor pagination is required for safe scan');
            if(!response.hasMore)break;
            cursor=response.cursor;
            const key=JSON.stringify(cursor);
            if(cursor==null || seenCursors.has(key))throw new Error('Invalid/repeated Qdrant cursor; cannot report complete scan');
            seenCursors.add(key);
        }else if(response.items.length<200)break;
        if(offset>=99800)throw new Error('Collection exceeds safety inspection limit; scan not complete');
    }
    return rows;
}
export async function scanCurrentChat(settings, {onProgress,control} = {}) {
    await control?.checkpoint();
    const chatUUID=getChatUUID();
    const binding=getChatBinding(chatUUID);
    if(!chatUUID || !binding) throw new Error('Connect and verify a collection for this chat before scanning');
    const target=resolveChatWriteTarget(settings,chatUUID);
    const {settings:effective,profile}=await applyAndVerifyProfile(target.registryKey,settings);
    const startChatId=chatUUID;
    onProgress?.({detail:'Checking expected chat chunks'});
    const expected=await buildExpectedChatItems(getContext()?.chat,effective);
    await control?.checkpoint();
    if(getChatUUID()!==startChatId)throw new Error('Chat changed during scan');
    onProgress?.({detail:'Reading stored embeddings'});
    const actual=await inventory(target.collectionId,effective,onProgress,control);
    const manifest=getChatChunkManifest(target.registryKey);
    if(!manifest || manifest.chatUUID !== chatUUID)throw new Error('Chat lacks a verifiable chunk manifest. Do not repair automatically; re-vectorize safely or restore metadata.');
    if(actual.some(row=>!row.text || !row.metadata || (!Array.isArray(row.metadata.messageIds) && row.metadata.messageId == null))) throw new Error('Backend cannot return source text/metadata; full verification unavailable');
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
        else if(!chunkMatchesExpected(old,item)) {
            // Metadata mismatch cannot be corrected by overwriting a hash safely.
            missing.push(item);
        }
    }
    const stale=actual.filter(a=>!wanted.has(String(a.hash)));
    const issues=[...missing.map(item=>({type:'missing_or_mismatched',hash:item.hash})),...stale.map(item=>({type:'outdated_or_deleted',hash:item.hash})),...duplicates.map(hash=>({type:'duplicate',hash}))];
    onProgress?.({detail:`Scan complete · ${issues.length} issue(s)`,completed:expected.length,total:expected.length});
    return {chatUUID,target,profile,effective,expected,actual,missing,stale,duplicates,issues,scannedAt:Date.now()};
}
export async function repairCurrentChat(settings, scan, {onProgress,control} = {}) {
    await control?.checkpoint();
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
    const totalActions=scan.missing.length+new Set(scan.stale.map(item=>item.hash)).size+1;
    let completedActions=0;
    onProgress?.({detail:`Writing ${scan.missing.length} replacement chunks`,completed:completedActions,total:totalActions});
    if(scan.missing.length){
        await control?.checkpoint();
        await insertVectorItems(target.collectionId,scan.missing,effective);
        const verify=await inventory(target.collectionId,effective,null,control);
        const hashes=new Set(verify.map(row=>String(row.hash)));
        for(const item of scan.missing)if(!hashes.has(String(item.hash)))throw new Error(`Replacement embedding ${item.hash} not confirmed in database; older chunks retained.`);
        completedActions+=scan.missing.length;
        onProgress?.({detail:'Replacement embeddings verified',completed:completedActions,total:totalActions});
    }
    if(scan.duplicates.length)throw new Error('Duplicate point hashes cannot be safely distinguished by the current backend; no destructive duplicate cleanup attempted.');
    const obsolete=[...new Set(scan.stale.map(x=>x.hash))];
    if(obsolete.length){
        await control?.checkpoint();
        onProgress?.({detail:`Removing ${obsolete.length} obsolete chunks`,completed:completedActions,total:totalActions});
        await deleteVectorItems(target.collectionId,obsolete,effective);
        const verify=await inventory(target.collectionId,effective,null,control);
        const remaining=new Set(verify.map(x=>String(x.hash)));
        if(obsolete.some(x=>remaining.has(String(x))))throw new Error('Some stale vectors remained after deletion. Not marking repair complete.');
        completedActions+=obsolete.length;
        onProgress?.({detail:'Obsolete chunks removed and verified',completed:completedActions,total:totalActions});
    }
    await saveChatChunkManifest(target.registryKey,updated,scan.chatUUID);
    onProgress?.({detail:'Final full-chat verification',completed:completedActions,total:totalActions});
    const result=await scanCurrentChat(settings,{control});
    onProgress?.({detail:result.issues.length?`${result.issues.length} issue(s) remain`:'Repair verified',completed:totalActions,total:totalActions});
    return result;
}
/** Automatic message-delete cleanup: do nothing on unverified/legacy data. */
export async function reconcileDeletedMessages(settings, {sourceChatId=getCurrentChatId(),sourceChatUUID=getChatUUID()} = {}) {
    // If the user left the originating branch, leave its data intact.
    // We cannot safely repair it against the *new* active chat transcript.
    if(!sourceChatUUID || sourceChatUUID!==getChatUUID() || sourceChatId!==getCurrentChatId())return;
    // If another writer is active, its next reconciliation pass will also
    // remove stale messages; never race destructive writes from two workers.
    if(hasActiveVectorWrite())return;
    const activityId=startActivity('Reconcile Deleted Messages',{category:'repair',detail:'Scanning deleted-message references'});
    const control=createOperationControl(activityId,{pausable:false,stoppable:true,writeOperation:true});
    let shared=null,outcome='failed';
    try {
        shared=await acquireSharedOperation('Reconcile Deleted Messages',{activityId,category:'repair',resourceKey:sourceChatUUID,queue:false});
        control.bindSharedOperation(shared);
        if(getChatUUID()!==sourceChatUUID || getCurrentChatId()!==sourceChatId)
            throw new Error('Originating chat switched while waiting for the backend job; no repair attempted');
        const scan=await scanCurrentChat(settings,{control,onProgress:({detail,completed,total})=>updateActivity(activityId,{detail,completed,total})});
        if(getChatUUID()!==sourceChatUUID || getCurrentChatId()!==sourceChatId)
            throw new Error('Originating chat changed during delete scan; no repair allowed');
        const manifest=getChatChunkManifest(scan.target.registryKey);
        // SillyTavern renumbers all message indices after deleting from the
        // middle. An index-set comparison misses that change. Use actual source
        // hashes and references instead. Restrict automatic repair to the
        // previously vectorized part of the chat; do not silently enable full
        // chat vectorization merely because a message was deleted.
        const trackedIds=(manifest.entries||[]).flatMap(e=>e.messageIds||[]).filter(Number.isInteger);
        if(!trackedIds.length){outcome='completed';finishActivity(activityId,true,'No previously tracked messages');return true;}
        const lastPreviouslyEmbedded=Math.max(...trackedIds);
        const affectedMissing=scan.missing.filter(item=>{
            const ids=item.metadata?.messageIds || [item.metadata?.messageId];
            return ids.some(index=>Number.isInteger(index) && index<=lastPreviouslyEmbedded);
        });
        if(!scan.stale.length && !affectedMissing.length){outcome='completed';finishActivity(activityId,true,'No deleted vectors remain');return true;}
        if(!scan.stale.length){outcome='completed';finishActivity(activityId,true,'No stale vectors found');return true;} // New unsynced messages alone aren't a deletion.
        const narrowed={...scan,missing:affectedMissing};
        if(getChatUUID()!==sourceChatUUID || getCurrentChatId()!==sourceChatId)
            throw new Error('Originating branch changed before deletion repair');
        await repairCurrentChat(settings,narrowed,{control,onProgress:({detail,completed,total})=>updateActivity(activityId,{detail,completed,total})});
        outcome='completed';finishActivity(activityId,true,'Deleted vectors reconciled');
        return true;
    } catch(e) {
        outcome=e instanceof OperationStoppedError || e instanceof SharedOperationStoppedError?'stopped':'failed';
        finishActivity(activityId,outcome==='stopped'?'stopped':false,e.message);
        console.warn('[VectHare] Automatic deletion reconciliation pending a manual Scan/Repair:',e.message);
        return false;
    }finally{
        if(shared)try{await finishSharedOperation(shared,outcome);}catch(e){console.warn('VectHare: delete reconciliation shared lease must be recovered',e);}
        detachOperationControl(activityId);
    }
}
