/** C04-B: activation and import ownership are not the same as search relevance.
 * IDs are opaque persisted IDs; names and filenames cannot prove an owner.
 */
import {parseCollectionKey} from './collection-keys.js';
const norm = id => typeof id==='string' && id.trim() ? id : null;
export function verifyCollectionOwner({collectionKey,metadata,chatId,characterId}={}) {
    if (!parseCollectionKey(collectionKey)) return {allowed:false,reason:'unqualified-collection'};
    if (!metadata || typeof metadata!=='object') return {allowed:false,reason:'ownership-metadata-unavailable'};
    if (metadata.enabled===false || metadata.ownershipReviewRequired===true || metadata.ownerStatus==='unverified')
        return {allowed:false,reason:'disabled-or-owner-unverified'};
    const originChat=norm(metadata.originChatId),originCharacter=norm(metadata.originCharacterId);
    if(metadata.scope==='chat' && !originChat) return {allowed:false,reason:'chat-origin-unverified'};
    if(metadata.scope==='character' && !originCharacter) return {allowed:false,reason:'character-origin-unverified'};
    if(originChat && originChat!==norm(chatId)) return {allowed:false,reason:'different-origin-chat'};
    if(originCharacter && originCharacter!==norm(characterId)) return {allowed:false,reason:'different-origin-character'};
    if(metadata.lockMode==='exclusive') {
        const chats=[...(Array.isArray(metadata.lockedToChatIds)?metadata.lockedToChatIds:[]),...(metadata.lockedToChatId?[metadata.lockedToChatId]:[])].map(String);
        const chars=(Array.isArray(metadata.lockedToCharacterIds)?metadata.lockedToCharacterIds:[]).map(String);
        if ((chats.length || chars.length) && !chats.includes(String(chatId)) && !chars.includes(String(characterId)))
            return {allowed:false,reason:'exclusive-owner-mismatch'};
    }
    return {allowed:true,reason:'verified-owner-policy'};
}
/** Imported owner claims must be verified against independently known IDs. */
export function quarantineImportedOwnership(metadata, {verifiedChatIds=[],verifiedCharacterIds=[],approved=false,requireRemapApproval=false}={}) {
    if(!metadata || typeof metadata!=='object' || Array.isArray(metadata)) return {enabled:false,ownerStatus:'unverified',ownershipReviewRequired:true};
    const clean={...metadata};
    const chats=new Set(verifiedChatIds.map(String)), chars=new Set(verifiedCharacterIds.map(String));
    const lockChats=[...(Array.isArray(clean.lockedToChatIds)?clean.lockedToChatIds:[]),...(clean.lockedToChatId?[clean.lockedToChatId]:[])].map(String);
    const lockChars=(Array.isArray(clean.lockedToCharacterIds)?clean.lockedToCharacterIds:[]).map(String);
    const mapped=lockChats.every(id=>chats.has(id))&&lockChars.every(id=>chars.has(id))
      &&(!clean.originChatId||chats.has(String(clean.originChatId)))
      &&(!clean.originCharacterId||chars.has(String(clean.originCharacterId)));
    if((requireRemapApproval && approved!==true) || !mapped || (clean.scope==='chat'&&!clean.originChatId) || (clean.scope==='character'&&!clean.originCharacterId))
        return {...clean,enabled:false,ownerStatus:'unverified',ownershipReviewRequired:true};
    return clean;
}
