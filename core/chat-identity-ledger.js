/**
 * P2 #59: permanent first-seen provenance of the current SillyTavern chat UUID.
 * Does not create a vector collection. Renaming changes only the filename;
 * branching/duplication requires SillyTavern 1.19+ to mint a fresh UUID.
 * Old copied UUIDs are quarantined for manual migration, never auto-adopted.
 */
import { extension_settings, getContext } from '../../../../extensions.js';
import { chat_metadata, getCurrentChatId } from '../../../../../script.js';
import { saveVectHareSettingsDebounced } from './settings-durability.js';
// A same-session CHAT_CHANGED callback is not proof that a repaired file was
// reopened. Require an observed departure, or a genuinely new page session.
const pendingThisSession = new Set();
const leftThisSession = new Set();
export function observeChatIdentityTransition() {
    const file=String(getCurrentChatId()||'');
    const scope=currentChatScope();
    for(const uuid of pendingThisSession) {
        const entry=ledger()[uuid];
        if(entry && (entry.file!==file || (entry.scope && scope && entry.scope!==scope)))
            leftThisSession.add(uuid);
    }
}
function ledger(){
    extension_settings.vecthare ||= {};
    return extension_settings.vecthare.chatIdentityLedger ||= {};
}
export function currentChatScope(){
    const ctx=getContext();
    if(ctx?.groupId!=null && ctx.groupId!=='')return `group:${String(ctx.groupId)}`;
    if(ctx?.characterId!=null && ctx.characterId!=='')return `character:${String(ctx.characterId)}`;
    // A missing character/group scope is not proof of identity. The filename
    // and UUID must still match, and we don't guess a character from its name.
    return null;
}
function effectiveCurrentUUID(){
    // Modern ST branches copy arbitrary metadata but create a NEW integrity
    // UUID. The copied VectHare override must not carry the parent identity.
    const original=String(chat_metadata?.integrity||'');
    if(chat_metadata?.vecthare_instance_uuid &&
       String(chat_metadata?.vecthare_instance_integrity||'')===original)
        return String(chat_metadata.vecthare_instance_uuid);
    return original;
}
export function recordCurrentChatIdentity(){
    const uuid=effectiveCurrentUUID(),file=String(getCurrentChatId()||'');
    if(!uuid||!file)return {verified:false,reason:'Chat UUID and original chat filename are required'};
    const scope=currentChatScope(), entries=ledger(),old=entries[uuid];
    if(old){
        if(old.file!==file || (old.scope && scope && old.scope!==scope)){
            return {verified:false,reason:'Chat/branch identity collision: integrity UUID is already registered to another file or character. Existing vectors remain untouched. Create a new SillyTavern 1.19+ branch or explicitly migrate the legacy identity.'};
        }
        if(old.migrationPending)return {verified:false,reason:'A repaired legacy chat must be reopened before its new identity can authorise collection writes.'};
        if(!old.scope && scope){old.scope=scope;saveVectHareSettingsDebounced();}
        return {verified:true,uuid,file,scope};
    }
    entries[uuid]={file,scope,firstSeenAt:new Date().toISOString()};
    saveVectHareSettingsDebounced();
    return {verified:true,uuid,file,scope};
}
export function assertCurrentChatIdentity(){
    const result=recordCurrentChatIdentity();
    if(!result.verified)throw new Error(result.reason);
    return result;
}
/** Only an authoritative SillyTavern CHAT_RENAMED event may update the ledger. */
export function recordVerifiedChatRename(uuid,oldFile,newFile){
    const old=ledger()[uuid];
    if(!old || old.file!==oldFile || !newFile || getCurrentChatId()!==newFile)return false;
    if(old.scope && currentChatScope() && old.scope!==currentChatScope())return false;
    old.file=newFile;old.renamedAt=new Date().toISOString();
    saveVectHareSettingsDebounced();
    return true;
}

/**
 * An older branch may share its parent's SillyTavern integrity UUID.
 * Repair ONLY VectHare's per-chat identity. Do not edit host integrity,
 * reuse the parent's writable binding, create a vector collection, or copy
 * vectors. Requires explicit user agreement, an active chat file, and an
 * acknowledged host metadata save. Until reopen, the new ID is quarantined.
 */
export async function repairCurrentLegacyBranchIdentity({confirm}={}) {
    const before=recordCurrentChatIdentity();
    if(before.verified)throw new Error('This chat already has a verified identity; no migration is necessary');
    const file=String(getCurrentChatId()||''),scope=currentChatScope(),ctx=getContext();
    if(!file || !scope || !ctx?.chatMetadata || typeof ctx.saveMetadata!=='function')
        throw new Error('Cannot safely repair: current chat, owner scope or SillyTavern metadata-save API is unavailable');
    if(!String(before.reason).includes('collision') && !String(before.reason).includes('required'))
        throw new Error('This identity requires manual inspection rather than automatic repair');
    if(typeof confirm!=='function' || await confirm()!==true)
        return {repaired:false,cancelled:true};
    if(file!==String(getCurrentChatId()||'') || scope!==currentChatScope())
        throw new Error('Chat changed during confirmation; nothing was modified');
    const newId=globalThis.crypto?.randomUUID?.();
    if(!newId)throw new Error('Secure UUID generation is unavailable');
    const oldValue=ctx.chatMetadata.vecthare_instance_uuid;
    const oldOrigin=ctx.chatMetadata.vecthare_instance_integrity;
    const existing=ledger();
    if(existing[newId])throw new Error('Unexpected new identity collision');
    // Persist the new per-file identity before recording it as pending.
    ctx.chatMetadata.vecthare_instance_uuid=newId;
    ctx.chatMetadata.vecthare_instance_integrity=String(ctx.chatMetadata.integrity||'');
    try {await ctx.saveMetadata();}
    catch(error) {
        if(file===String(getCurrentChatId()||'') && ctx.chatMetadata.vecthare_instance_uuid===newId){
            if(oldValue===undefined)delete ctx.chatMetadata.vecthare_instance_uuid;
            else ctx.chatMetadata.vecthare_instance_uuid=oldValue;
            if(oldOrigin===undefined)delete ctx.chatMetadata.vecthare_instance_integrity;
            else ctx.chatMetadata.vecthare_instance_integrity=oldOrigin;
        }
        throw new Error(`SillyTavern did not acknowledge the identity save: ${error.message}`);
    }
    if(file!==String(getCurrentChatId()||'') || scope!==currentChatScope())
        throw new Error('Chat changed while saving; new identity requires explicit reopening and verification');
    existing[newId]={file,scope,firstSeenAt:new Date().toISOString(),migrationPending:true,origin:'legacy-branch-repair'};
    pendingThisSession.add(newId);
    saveVectHareSettingsDebounced();
    return {repaired:true,pending:true,uuid:newId,reason:'Identity saved; switch away and reopen this chat before vectorisation. Parent collection was not modified.'};
}
/** Call only after SillyTavern has loaded a chat on CHAT_CHANGED. */
export function confirmReopenedLegacyBranchIdentity() {
    const uuid=effectiveCurrentUUID();
    if(!uuid || uuid===String(chat_metadata?.integrity||''))return recordCurrentChatIdentity();
    const old=ledger()[uuid];
    if(!old?.migrationPending)return recordCurrentChatIdentity();
    if(pendingThisSession.has(uuid) && !leftThisSession.has(uuid))
        return {verified:false,reason:'Repaired chat must be left and reopened before it can write vectors'};
    const file=String(getCurrentChatId()||'');
    if(old.file!==file || (old.scope && currentChatScope()!==old.scope))
        return {verified:false,reason:'Repaired chat provenance mismatch; writes blocked'};
    old.migrationPending=false;old.verifiedReopenAt=new Date().toISOString();
    pendingThisSession.delete(uuid);leftThisSession.delete(uuid);
    saveVectHareSettingsDebounced();
    return recordCurrentChatIdentity();
}
