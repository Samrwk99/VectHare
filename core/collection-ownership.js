import { saveVectHareSettingsDebounced as saveSettingsDebounced } from './settings-durability.js';
/**
 * Persistent, independent write ownership of chat vector collections.
 * Reading a collection (including an activation lock) never grants write access.
 * A full backend:source:collectionId key is required for new bindings.
 */
import { extension_settings, getContext } from '../../../../extensions.js';
import { getCurrentChatId } from '../../../../../script.js';
import { getChatUUID, parseRegistryKey } from './collection-ids.js';
import { getCollectionMeta } from './collection-metadata.js';
import { assertQdrantIdentity } from './physical-identity.js';
import { assertCurrentChatIdentity,currentChatScope,recordVerifiedChatRename } from './chat-identity-ledger.js';

function store() {
    extension_settings.vecthare ||= {};
    extension_settings.vecthare.chatCollectionBindings ||= {};
    return extension_settings.vecthare.chatCollectionBindings;
}

export function getChatBinding(chatId = getChatUUID()) {
    const binding = chatId ? store()[chatId] || null : null;
    // SillyTavern legacy branching can copy a parent's integrity UUID. Do not
    // allow a copied identity to adopt its parent's writable binding.
    if(binding && chatId===getChatUUID())assertCurrentChatIdentity();
    if(binding?.sourceScope && currentChatScope() && binding.sourceScope!==currentChatScope())
        throw new Error('Chat/branch owner character or group differs from the saved collection. Write binding refused.');
    if (binding?.sourceChatId && chatId === getChatUUID() &&
        binding.sourceChatId !== getCurrentChatId()) {
        throw new Error('Chat/branch identity collision: this chat shares an integrity ID with a different chat file. Collection access is blocked until its identity is safely reconciled.');
    }
    return binding;
}

/**
 * SillyTavern 1.19 emits CHAT_RENAMED after it has saved the new file and
 * reloaded the active chat. A confirmed same-UUID rename is not a new branch:
 * update only the recorded filename, preserving the existing collection.
 * Never infer identity from two same-named chats or a filename alone.
 */
export function reconcileActiveChatRename(event) {
    const oldFile = String(event?.oldFileName || '').replace(/\.jsonl$/i, '');
    const newFile = String(event?.newFileName || '').replace(/\.jsonl$/i, '');
    const uuid = getChatUUID();
    if (!oldFile || !newFile || !uuid || getCurrentChatId() !== newFile) return false;
    // A chat can have an identity ledger entry without ever having been
    // vectorised. Its verified rename must advance that ledger even when no
    // writable collection or binding exists; otherwise a future first Sync
    // mistakes this chat for a copied-UUID branch.
    // Do not create an empty binding (or vector collection) just to rename it.
    const binding = extension_settings.vecthare?.chatCollectionBindings?.[uuid] || null;
    // When a writable binding exists, both sources of provenance must agree
    // BEFORE either is changed. A branch must not relabel another chat's
    // collection by presenting a mismatched filename.
    if (binding && binding.sourceChatId !== oldFile) return false;
    if (!recordVerifiedChatRename(uuid, oldFile, newFile)) return false;
    if (binding) {
        binding.sourceChatId = newFile;
        binding.renamedAt = new Date().toISOString();
        saveSettingsDebounced();
    }
    return true;
}

export function getCollectionOwner(registryKey) {
    for (const [chatId, binding] of Object.entries(store())) {
        if (binding?.registryKey === registryKey) return chatId;
    }
    return null;
}

/** Exclusive retrieval locks also restrict write connection to their subject. */
function assertLockAllowsWrite(registryKey, chatId) {
    const meta = getCollectionMeta(registryKey);
    if (meta.lockMode !== 'exclusive') return;
    const chatLocks = meta.lockedToChatIds?.length ? meta.lockedToChatIds :
        (meta.lockedToChatId ? [meta.lockedToChatId] : []);
    const context = getContext();
    const matchesChat = !chatLocks.length || chatLocks.some(id =>
        String(id) === String(chatId) || String(id) === String(getCurrentChatId()));
    const characterLocks = meta.lockedToCharacterIds || [];
    const presentCharacters = [context?.characterId, context?.character?.avatar,
        context?.name2, ...(context?.group?.members || [])].filter(x => x != null).map(String);
    const matchesCharacter = !characterLocks.length || characterLocks.some(id => presentCharacters.includes(String(id)));
    if (!matchesChat || !matchesCharacter) {
        throw new Error('Collection is exclusively locked to another chat or character; write connection refused.');
    }
}

/** Explicit binding; caller must verify legacy collection compatibility before calling. */
export function bindChatCollection(chatId, registryKey, { replace = false, writeVerified = false } = {}) {
    if (!chatId || !registryKey) throw new Error('Chat identity and collection are required for write binding');
    if(chatId===getChatUUID())assertCurrentChatIdentity();
    const parsed = parseRegistryKey(registryKey);
    if (!parsed.backend || !parsed.source || !parsed.collectionId) {
        throw new Error('A complete backend:source:collection identity is required');
    }
    if(parsed.backend === 'qdrant') assertQdrantIdentity(registryKey,{...extension_settings.vecthare,vector_backend:'qdrant'});
    assertLockAllowsWrite(registryKey, chatId);
    const bindings = store();
    const otherOwner = getCollectionOwner(registryKey);
    if (otherOwner && otherOwner !== chatId) {
        throw new Error(`Collection is already writable by another chat (${otherOwner}). Explicit ownership transfer is required.`);
    }
    if (bindings[chatId] && bindings[chatId].registryKey !== registryKey && !replace) {
        throw new Error('Chat already owns another collection. Explicit replacement is required.');
    }
    // Never downgrade a verified binding merely because it is re-selected in the UI.
    if (bindings[chatId]?.sourceChatId && bindings[chatId].sourceChatId !== getCurrentChatId())
        throw new Error('Chat/branch file identity changed; refusing to reuse an existing collection write binding. Explicit recovery or rebind is required.');
    const alreadyVerified = bindings[chatId]?.registryKey === registryKey && bindings[chatId]?.writeVerified === true;
    bindings[chatId] = { registryKey, sourceChatId:getCurrentChatId(), sourceScope:currentChatScope(), boundAt: new Date().toISOString(), writeVerified: writeVerified || alreadyVerified };
    saveSettingsDebounced();
    return bindings[chatId];
}

/** Never infer ownership from character name or fuzzy matching. */
export function resolveChatWriteTarget(settings, chatId = getChatUUID(), generatedCollectionId = null) {
    if (!chatId) throw new Error('Chat identity unavailable; cannot select safe vector write target');
    if(chatId===getChatUUID())assertCurrentChatIdentity();
    const binding = getChatBinding(chatId);
    if (binding && binding.sourceChatId && binding.sourceChatId !== getCurrentChatId())
        throw new Error('Chat/branch identity collision: the connected collection belongs to a different chat file. Writes blocked.');
    if (!binding) {
        if (!generatedCollectionId) throw new Error('No writable collection connected to this chat');
        // A generated ID is allowed for initial creation only; existing unbound collections
        // must be explicitly connected, not silently adopted.
        return { collectionId: generatedCollectionId, registryKey: `${settings.vector_backend || 'standard'}:${settings.source || 'transformers'}:${generatedCollectionId}`, newCollection: true };
    }
    const parsed = parseRegistryKey(binding.registryKey);
    if (parsed.backend !== (settings.vector_backend || 'standard') || parsed.source !== (settings.source || 'transformers')) {
        throw new Error(`Connected collection uses ${parsed.backend}/${parsed.source}; switch backend and provider before syncing (currently ${settings.vector_backend || 'standard'}/${settings.source || 'transformers'}).`);
    }
    if (getCollectionOwner(binding.registryKey) !== chatId) throw new Error('Collection write ownership conflict');
    if (binding.writeVerified !== true) {
        throw new Error('Collection is connected read-only: original embedding and chunking configuration is not verified. Re-vectorize safely before writing.');
    }
    if(parsed.backend === 'qdrant') assertQdrantIdentity(binding.registryKey,settings);
    assertLockAllowsWrite(binding.registryKey, chatId);
    return { collectionId: parsed.collectionId, registryKey: binding.registryKey, newCollection: false };
}

/** Called ONLY after confirmed explicit deletion of the physical collection. */
export function forgetDeletedCollection(registryKey) {
    const bindings = store();
    for (const [chatId, binding] of Object.entries(bindings)) {
        if (binding.registryKey === registryKey) delete bindings[chatId];
    }
    saveSettingsDebounced();
}
