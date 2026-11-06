/**
 * ============================================================================
 * VECTHARE COLLECTION ID UTILITIES
 * ============================================================================
 * Single source of truth for all collection ID operations:
 * - Building/generating collection IDs
 * - Parsing collection IDs (all formats)
 * - Pattern matching for discovery
 *
 * ALL other files should import from here instead of rolling their own.
 * ============================================================================
 */

import { getContext, extension_settings } from '../../../../extensions.js';
import { getCurrentChatId, chat_metadata, getRequestHeaders, saveSettingsDebounced } from '../../../../../script.js';
import { getStringHash } from '../../../../utils.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Prefix for new VectHare format (not currently used for chats, but available) */
export const VH_PREFIX = 'vh';

/** All known collection prefixes for backwards compatibility */
export const COLLECTION_PREFIXES = {
    // VectHare formats
    VECTHARE_CHAT: 'vecthare_chat_',
    VECTHARE_LOREBOOK: 'vecthare_lorebook_',
    VECTHARE_CHARACTER: 'vecthare_character_',
    VECTHARE_DOCUMENT: 'vecthare_document_',

    // Legacy/external formats
    FILE: 'file_',
    LOREBOOK: 'lorebook_',
    RAGBOOKS_LOREBOOK: 'ragbooks_lorebook_',
    CARROTKERNEL_CHAR: 'carrotkernel_char_',
};

/** Collection types */
export const COLLECTION_TYPES = {
    CHAT: 'chat',
    LOREBOOK: 'lorebook',
    CHARACTER: 'character',
    DOCUMENT: 'document',
    FILE: 'file',
    URL: 'url',
    WIKI: 'wiki',
    YOUTUBE: 'youtube',
    UNKNOWN: 'unknown',
};

/** Collection scopes */
export const COLLECTION_SCOPES = {
    GLOBAL: 'global',
    CHARACTER: 'character',
    CHAT: 'chat',
    UNKNOWN: 'unknown',
};

// ============================================================================
// CHAT UUID UTILITIES
// ============================================================================

/**
 * Gets the unique chat UUID from chat_metadata.integrity
 * This is the authoritative identifier for a chat.
 * @returns {string|null} Chat UUID or null if no chat
 */
export function getChatUUID() {
    const integrity = chat_metadata?.integrity;
    if (integrity) {
        return integrity;
    }
    // Fallback: use chatId (less ideal but works for old chats)
    const chatId = getCurrentChatId();
    if (chatId) {
        console.warn('VectHare: chat_metadata.integrity not found, falling back to chatId');
        return chatId;
    }
    return null;
}

// ============================================================================
// COLLECTION ID BUILDERS
// ============================================================================

/**
 * Builds a chat collection ID using UUID for uniqueness
 * Format: vecthare_chat_{charName}_{uuid}
 * @param {string} [chatUUID] Optional UUID override
 * @returns {string|null} Collection ID or null if no chat
 */
export function buildChatCollectionId(_chatUUID) {
    // IDs are no longer derived from names or UUIDs. The argument is deliberately
    // ignored: callers must resolve the exact chat before using its collection.
    return peekChatCollectionId();
}

/** The file claim survives ordinary chat and character renames. */
export const normChat = name => String(name ?? '').replace(/\\/g, '/').split('/').pop().replace(/\.jsonl$/i, '');

export function getChatOwner(ctx = getContext()) {
    if (ctx?.groupId !== undefined && ctx.groupId !== null && ctx.groupId !== '') {
        return { type: 'group', id: String(ctx.groupId) };
    }
    const avatar = ctx?.characters?.[ctx.characterId]?.avatar;
    return avatar ? { type: 'character', id: String(avatar) } : null;
}

const sameOwner = (a, b) => Boolean(a && b && a.type === b.type && a.id === b.id);
const ownerKey = owner => owner ? `${owner.type === 'group' ? 'group' : 'char'}:${owner.id}` : null;
const claimOwnerKey = claim => claim?.ownerId?.startsWith?.('char:') || claim?.ownerId?.startsWith?.('group:')
    ? claim.ownerId : claim?.ownerType && claim?.ownerId != null
        ? ownerKey({ type: claim.ownerType, id: claim.ownerId }) : null;
const claimMatchesRecord = (claim, id, record) => Boolean(
    claim?.collectionId === id && record &&
    (claimOwnerKey(claim) === ownerKey(record.owner) ||
        record.renamedOwners?.includes(claimOwnerKey(claim))) &&
    (normChat(claim.chat) === record.chat ||
        record.renamedChats?.includes(normChat(claim.chat)))
);

const sameChat = (a, b) => sameOwner(a.owner, b.owner) && a.chat === b.chat;
const emptyBindingStore = { version: 1, byCollection: {} };
const readBindingStore = () => extension_settings.vecthare?.chatCollectionBindings || emptyBindingStore;
const bindingStore = () => (extension_settings.vecthare.chatCollectionBindings ??= {
    version: 1, byCollection: {},
});
const entries = () => Object.entries(readBindingStore().byCollection);
const currentSnapshot = (ctx = getContext()) => ({
    owner: getChatOwner(ctx),
    chat: normChat(ctx.chatId),
    uuid: ctx.chatMetadata?.integrity ? String(ctx.chatMetadata.integrity) : null,
    claim: ctx.chatMetadata?.vecthare_binding ?? null,
    mainChat: normChat(ctx.chatMetadata?.main_chat),
    name: String(ctx.name2 || ''),
});
const liveSnapshotMatches = snap => sameChat(snap, currentSnapshot());
const matchesClaim = (claim, id) => claim && claim.collectionId === id;
const findBound = (owner, chat) => entries().filter(([, rec]) =>
    rec.status === 'active' && sameOwner(rec.owner, owner) && rec.chat === chat);

/** Synchronous and read-only, including for UI / retrieval. */
export function peekChatCollectionId(ctx = getContext()) {
    const snap = currentSnapshot(ctx);
    if (!snap.owner || !snap.chat) return null;
    const hits = findBound(snap.owner, snap.chat);
    if (hits.length !== 1) return null;
    const [id] = hits[0];
    // A restored or overwritten filename without its own claim must never
    // inherit the previously bound chat's vectors.
    return claimMatchesRecord(snap.claim, id, hits[0][1]) ? id : null;
}

/** Exact, read-only lookup for a different filename under the known current owner. */
export function peekBoundCollectionIdForChat(chat, ctx = getContext()) {
    const owner = getChatOwner(ctx), name = normChat(chat);
    if (!owner || !name) return null;
    const hits = findBound(owner, name);
    return hits.length === 1 ? hits[0][0] : null;
}

export function isQuarantinedChatCollection(id) {
    return readBindingStore().byCollection[parseRegistryKey(id).collectionId || id]?.status === 'quarantined';
}

export function getBoundChatDetails(id) {
    const rec = readBindingStore().byCollection[parseRegistryKey(id).collectionId || id];
    return rec?.status === 'active' ? rec : null;
}

function freshId() {
    let id;
    do {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes); // Also works in insecure HTTP LAN contexts.
        id = COLLECTION_PREFIXES.VECTHARE_CHAT + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    } while (bindingStore().byCollection[id]);
    return id;
}

function quarantine(id, registryKeys = []) {
    const old = bindingStore().byCollection[id];
    if (old?.status === 'active') return false; // Never revoke a confirmed current owner here.
    bindingStore().byCollection[id] = {
        owner: null, chat: null, origin: old?.origin || 'legacy',
        status: 'quarantined', stores: old?.stores || storeHints(id, registryKeys),
        createdAt: old?.createdAt || Date.now(),
    };
    saveSettingsDebounced();
    return true;
}

/** Preserve an old collection but free its owner/filename for a new chat. */
export function releaseToQuarantine(id) {
    const rec = bindingStore().byCollection[id];
    if (!rec) return;
    bindingStore().byCollection[id] = {
        ...rec, owner: null, chat: null, status: 'quarantined',
    };
    saveSettingsDebounced();
}

function storeHints(id, keys = []) {
    const relevant = [...new Set([
        ...(extension_settings.vecthare.vecthare_collection_registry || []),
        ...discoveredLegacyKeys, ...keys,
    ])]
        .filter(key => parseRegistryKey(key).collectionId === id)
        .map(key => parseRegistryKey(key));
    return [...new Map(relevant.filter(p => p.backend && p.source)
        .map(p => [`${p.backend}:${p.source}`, { backend: p.backend, source: p.source }])).values()];
}

async function postJson(path, payload) {
    const response = await fetch(path, {
        method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json();
}

/** Complete list, or null on errors/incomplete or malformed chat headers. */
async function ownerChats(owner, ctx = getContext()) {
    try {
        if (owner.type === 'character') {
            const [simple, detailed] = await Promise.all([
                postJson('/api/characters/chats', { avatar_url: owner.id, simple: true }),
                postJson('/api/characters/chats', { avatar_url: owner.id, metadata: true }),
            ]);
            if (!Array.isArray(simple) || !Array.isArray(detailed)) return null;
            const known = new Map(detailed.map(item => [normChat(item.file_name), item.chat_metadata]));
            const result = [];
            // An unparseable header or a server ignoring metadata:true must not
            // silently hide a competing chat; read its header directly instead.
            for (let i = 0; i < simple.length; i += 4) {
                const batch = await Promise.all(simple.slice(i, i + 4).map(async item => {
                    const chat = normChat(item.file_name);
                    if (known.get(chat)) return { chat, meta: known.get(chat) };
                    const data = await postJson('/api/chats/get', { avatar_url: owner.id, file_name: chat });
                    if (!Array.isArray(data) || !data[0] || typeof data[0] !== 'object') return null;
                    return { chat, meta: data[0].chat_metadata ?? {} };
                }));
                if (batch.includes(null)) return null;
                result.push(...batch);
            }
            return result;
        }
        const group = ctx.groups?.find(group => String(group.id) === owner.id);
        if (!Array.isArray(group?.chats)) return null;
        const result = [];
        // Bounded concurrency: 4 group header reads maximum at once.
        for (let i = 0; i < group.chats.length; i += 4) {
            // /group/info omits chat_metadata; read the actual saved header.
            const batch = await Promise.all(group.chats.slice(i, i + 4).map(chat =>
                postJson('/api/chats/group/get', { id: chat })));
            if (batch.some(data => !Array.isArray(data) || !data[0] || typeof data[0] !== 'object')) return null;
            result.push(...batch.map((data, j) => ({ chat: normChat(group.chats[i + j]), meta: data[0].chat_metadata ?? {} })));
        }
        return result;
    } catch (error) {
        console.warn('VectHare: Could not inspect sibling chat identities:', error);
        return null;
    }
}

/** true = exists, false = absent, null = cannot safely determine. */
export async function chatFileExists(owner, chat, ctx = getContext()) {
    if (!owner || !chat) return null;
    try {
        if (owner.type === 'character') {
            if (!(ctx.characters || []).some(c => c.avatar === owner.id)) return null;
            const files = await postJson('/api/characters/chats', { avatar_url: owner.id, simple: true });
            if (!Array.isArray(files)) return null;
            return files.some(file => normChat(file.file_name) === normChat(chat));
        }
        const group = ctx.groups?.find(g => String(g.id) === owner.id);
        if (!Array.isArray(group?.chats)) return null;
        // Group deletion updates this list; a surviving entry needs a file check.
        if (!group.chats.some(name => normChat(name) === normChat(chat))) return false;
        const data = await postJson('/api/chats/group/get', { id: chat });
        return Array.isArray(data) && data[0] && typeof data[0] === 'object' ? true : null;
    } catch (e) {
        return null;
    }
}

/** Legacy name-prefixed IDs have an extra separator after the prefix. */
function legacyNameSuffixMatches(id, snap) {
    const prefix = COLLECTION_PREFIXES.VECTHARE_CHAT;
    if (!id?.startsWith(prefix)) return [];
    const matches = [];
    for (const [kind, value] of [['uuid', snap.uuid], ['chat', snap.chat]]) {
        if (!value) continue;
        const suffix = `_${value}`;
        // A bare vecthare_chat_<filename> ID has no room for this separator.
        if (id.length >= prefix.length + suffix.length && id.endsWith(suffix)) {
            matches.push({ kind, slug: id.slice(prefix.length, -suffix.length) });
        }
    }
    return matches;
}

/** Other live chat files with the same UUID or copied collection claim. */
async function competingChats(snap, candidateId = null, ctx = getContext()) {
    const owners = [snap.owner];
    const addOwner = owner => {
        if (!owners.some(existing => sameOwner(existing, owner))) owners.push(owner);
    };
    const bareId = snap.chat ? buildLegacyChatCollectionId(snap.chat) : null;
    const bareLegacy = Boolean(candidateId && bareId && candidateId === bareId);
    const matches = bareLegacy ? [] : legacyNameSuffixMatches(candidateId, snap);
    // A filename-suffixed collection can predate its chat's current UUID.
    const ownSlug = sanitizeLegacyName(snap.name || 'chat');
    const selected = matches.find(match => match.slug === ownSlug) || matches[0];
    const byFilename = bareLegacy || selected?.kind === 'chat' || (!selected && !snap.uuid);

    if (bareLegacy) {
        // No character scope in the historical ID; all owners can collide.
        for (const c of ctx.characters || []) if (c.avatar) addOwner({ type: 'character', id: c.avatar });
        for (const g of ctx.groups || []) if (g.id != null) addOwner({ type: 'group', id: String(g.id) });
    } else {
        // Include every current owner whose sanitized historical name matches
        // any plausible slug (including the empty slug).
        for (const match of matches) {
            for (const c of ctx.characters || []) {
                if (c.avatar && sanitizeLegacyName(c.name || 'chat') === match.slug) {
                    addOwner({ type: 'character', id: c.avatar });
                }
            }
            for (const g of ctx.groups || []) {
                if (g.id != null && sanitizeLegacyName(g.name || 'chat') === match.slug) {
                    addOwner({ type: 'group', id: String(g.id) });
                }
            }
        }
    }
    const found = [];
    for (const owner of owners) {
        const list = await ownerChats(owner, ctx);
        if (list === null) return null;
        for (const file of list) {
            if (sameOwner(owner, snap.owner) && file.chat === snap.chat) continue;
            const peerClaim = file.meta?.vecthare_binding?.collectionId;
            // Existing independent bindings stay independent. Unbound files
            // only compete when their matching identifier is the same.
            const sameIdentifier = byFilename
                ? file.chat === snap.chat
                : !!snap.uuid && String(file.meta?.integrity) === snap.uuid;
            if ((candidateId && peerClaim === candidateId) || (!peerClaim && sameIdentifier)) {
                found.push({ owner, chat: file.chat });
            }
        }
    }
    return found;
}

const sanitizeLegacyName = name => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '').substring(0, 30);

// Original VectHare: name + integrity UUID, falling back to the filename.
function oldNamedChatCollectionId(snap, suffix = snap.uuid || snap.chat) {
    return suffix ? `${COLLECTION_PREFIXES.VECTHARE_CHAT}${sanitizeLegacyName(snap.name || 'chat')}_${suffix}` : null;
}

function legacyIdBelongsToOtherOwner(id, snap, ctx = getContext()) {
    const bareId = snap.chat ? buildLegacyChatCollectionId(snap.chat) : null;
    if (id === bareId) return false; // Bare IDs never carry an owner slug.
    const matches = legacyNameSuffixMatches(id, snap);
    const ownSlug = sanitizeLegacyName(snap.name || 'chat');
    if (matches.some(match => match.slug === ownSlug)) return false;
    return matches.some(match => [...(ctx.characters || []), ...(ctx.groups || [])]
        .some(owner => sanitizeLegacyName(owner?.name || 'chat') === match.slug));
}

const inflight = new Map();
export function ensureChatBinding(ctx = getContext(), opts = {}) {
    const snap = currentSnapshot(ctx);
    if (!snap.owner || !snap.chat) return Promise.resolve({ state: 'unbound', writable: false });
    const create = opts.create !== false;
    const key = JSON.stringify([snap.owner.type, snap.owner.id, snap.chat]);
    if (inflight.has(key)) {
        return inflight.get(key).then(result =>
            create && result.state === 'unbound' ? ensureChatBinding(ctx, { create: true }) : result);
    }
    const promise = resolveChatBinding(snap, { create }).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
}

/** Save a new claim first; update the reverse index only after disk verification. */
async function commit(snap, id, rec, retireId = null) {
    if (!liveSnapshotMatches(snap)) return { state: 'changed', writable: false };
    const ctx = getContext();
    if (!ctx.chatMetadata || typeof ctx.saveMetadata !== 'function') {
        return { state: 'provisional', writable: false };
    }
    const originalClaim = ctx.chatMetadata.vecthare_binding;
    const claim = { collectionId: id, chat: snap.chat, ownerId: ownerKey(snap.owner) };
    ctx.chatMetadata.vecthare_binding = claim; // Fresh reference for ST change tracking.
    try {
        await ctx.saveMetadata();
        if (!liveSnapshotMatches(snap)) return { state: 'changed', writable: false };
        const data = snap.owner.type === 'character'
            ? await postJson('/api/chats/get', { avatar_url: snap.owner.id, file_name: snap.chat })
            : await postJson('/api/chats/group/get', { id: snap.chat });
        const saved = Array.isArray(data) ? data[0]?.chat_metadata?.vecthare_binding : null;
        if (!matchesClaim(saved, id) || claimOwnerKey(saved) !== ownerKey(snap.owner) ||
            normChat(saved.chat) !== snap.chat || !liveSnapshotMatches(snap)) {
            return { state: 'provisional', writable: false };
        }
        // One synchronous settings transition: no two active records claim a filename.
        if (retireId && bindingStore().byCollection[retireId]) {
            const old = bindingStore().byCollection[retireId];
            bindingStore().byCollection[retireId] = { ...old, owner: null, chat: null, status: 'quarantined' };
        }
        bindingStore().byCollection[id] = rec;
        saveSettingsDebounced();
        return { state: 'active', collectionId: id, writable: true };
    } catch (error) {
        console.warn('VectHare: Chat binding could not be persisted:', error);
        return { state: 'provisional', writable: false };
    } finally {
        if (ctx.chatMetadata.vecthare_binding === claim && !bindingStore().byCollection[id]) {
            ctx.chatMetadata.vecthare_binding = originalClaim;
        }
    }
}

// Read-only discovery: never alter persisted registry during identity checks.
// The plugin may be absent (Standard backend works without it).
let legacyDiscoveryPromise;
let discoveredLegacyKeys = [];
function discoverLegacyCollectionsOnce() {
    if (!legacyDiscoveryPromise) {
        legacyDiscoveryPromise = (async () => {
            try {
                const response = await fetch('/api/plugins/similharity/collections', {
                    method: 'GET', headers: getRequestHeaders(),
                });
                if (!response.ok) return false;
                const data = await response.json();
                if (!data?.success || !Array.isArray(data.collections)) return false;
                discoveredLegacyKeys = data.collections
                    .filter(item => item?.id && item?.source)
                    .map(item => {
                        const backend = item.backend || 'standard';
                        const raw = String(item.id);
                        const id = raw.startsWith(`${backend}:`) ? raw.slice(backend.length + 1) : raw;
                        return `${backend}:${item.source}:${id}`;
                    });
                return true;
            } catch (error) {
                return false;
            }
        })().then(success => {
            if (!success) legacyDiscoveryPromise = null; // Retry on next use.
            return success;
        });
    }
    return legacyDiscoveryPromise;
}

async function resolveChatBinding(snap, opts = { create: true }) {
    const hits = findBound(snap.owner, snap.chat);
    if (hits.length > 1) return { state: 'provisional', writable: false };
    if (hits.length === 1) {
        const [id, rec] = hits[0];
        if (claimMatchesRecord(snap.claim, id, rec)) {
            // Heal stale owner/chat fields following a confirmed rename event.
            if (claimOwnerKey(snap.claim) !== ownerKey(snap.owner) || normChat(snap.claim.chat) !== snap.chat) {
                return commit(snap, id, rec);
            }
            return { state: 'active', collectionId: id, writable: true };
        }
        // A replacement file with the same filename *and UUID* cannot inherit
        // old vectors on that evidence alone. Preserve the old record until a
        // new claim is successfully saved.
        return commitFresh(snap, opts, id);
    }

    const claimId = typeof snap.claim?.collectionId === 'string' ? snap.claim.collectionId : null;
    if (claimId) {
        if (!claimId.startsWith(COLLECTION_PREFIXES.VECTHARE_CHAT)) {
            return { state: 'provisional', writable: false };
        }
        const previous = bindingStore().byCollection[claimId];
        // Cross-owner imports and copied branches never inherit their source's
        // collection. An old claim is trusted only through an explicit rename.
        const sameOwnerClaim = claimOwnerKey(snap.claim) === ownerKey(snap.owner);
        const renamedOwner = previous?.renamedOwners?.includes(claimOwnerKey(snap.claim)) &&
            sameOwner(previous.owner, snap.owner);
        if (!sameOwnerClaim && !renamedOwner) {
            // If the original owner still exists, the file is an import/copy.
            // If it is missing, this could be a missed character rename:
            // preserving the old vectors is safer than guessing.
            const original = previous?.owner;
            const knownOwner = original && (
                original.type === 'character'
                    ? (getContext().characters || []).some(char => char.avatar === original.id)
                    : (getContext().groups || []).some(group => String(group.id) === original.id)
            );
            return knownOwner ? commitFresh(snap, opts) : { state: 'provisional', writable: false };
        }
        if (previous?.status === 'quarantined') return commitFresh(snap, opts);
        if (previous) {
            if (sameOwner(previous.owner, snap.owner) && previous.chat === snap.chat &&
                claimMatchesRecord(snap.claim, claimId, previous)) {
                return commit(snap, claimId, previous); // Heal old filename/owner in saved claim.
            }
            // Same collection claimed under a different filename: if the old
            // file exists, this is a copied branch; otherwise the distinction
            // between missed rename and copy is unknowable (fail closed).
            const copiedBranch = snap.mainChat && snap.mainChat === normChat(snap.claim.chat) &&
                snap.chat !== snap.mainChat;
            if (copiedBranch) return commitFresh(snap, opts);
            const originalExists = await chatFileExists(previous.owner, previous.chat);
            if (originalExists === true) return commitFresh(snap, opts);
            return { state: 'provisional', writable: false };
        }
        // An unregistered claim naming another file may be a copied branch
        // whose parent was deleted. Never silently adopt that old collection.
        if (normChat(snap.claim.chat) !== snap.chat) return commitFresh(snap, opts);
        // Registry lost but claim survived: inspect all competing files first.
        const peers = await competingChats(snap, claimId);
        if (peers === null) return { state: 'provisional', writable: false };
        if (peers.length) return commitFresh(snap, opts);
        return commit(snap, claimId, { owner: snap.owner, chat: snap.chat,
            origin: 'legacy', status: 'active', uuid: snap.uuid,
            stores: storeHints(claimId), createdAt: Date.now() });
    }

    // Use persisted candidates first. A failed backend discovery must never
    // unregister an existing chat's registry entry or change ownership.
    const discovered = await discoverLegacyCollectionsOnce();
    // A failed discovery is not conclusive: inspect persisted evidence first.
    // A new chat with no legacy evidence should not stay blocked forever.
    // Legacy collection discovery is limited to old UUID/filename formats.
    const known = new Set([
        ...discoveredLegacyKeys,
        ...(extension_settings.vecthare.vecthare_collection_registry || []),
        ...Object.keys(extension_settings.vecthare.collections || {}),
    ].map(key => parseRegistryKey(key).collectionId));
    const oldNamedId = oldNamedChatCollectionId(snap);
    const oldNamedFilenameId = oldNamedChatCollectionId(snap, snap.chat);
    const bareLegacyId = snap.chat ? buildLegacyChatCollectionId(snap.chat) : null;
    const preferredIds = [oldNamedId, oldNamedFilenameId, bareLegacyId].filter(Boolean);
    const candidates = [...known].filter(id => id && id.startsWith(COLLECTION_PREFIXES.VECTHARE_CHAT) &&
        ((snap.uuid && id.endsWith('_' + snap.uuid)) || preferredIds.includes(id)) &&
        !bindingStore().byCollection[id] && !legacyIdBelongsToOtherOwner(id, snap));
    // Keep all matching historical formats for this chat. If more than one
    // exists, don't silently adopt one and strand the other.
    const narrowed = candidates.length > 1 && candidates.some(id => preferredIds.includes(id))
        ? candidates.filter(id => preferredIds.includes(id)) : candidates;
    if (narrowed.length > 1) {
        // Historical character rename or duplicated candidates: no safe guess.
        for (const id of narrowed) quarantine(id);
        return commitFresh(snap, opts);
    }
    if (!discovered && !narrowed.length &&
        extension_settings.vecthare.vector_backend !== 'standard') {
        // The plugin's discovery endpoint is unavailable. Probe only the two
        // deterministic old IDs before assuming there is no legacy data.
        // Unknown old renamed-character IDs still require manual recovery.
        const legacyIds = [...new Set(preferredIds)];
        const { getSavedHashes } = await import('./core-vector-api.js');
        const s = extension_settings.vecthare;
        try {
            for (const legacyId of legacyIds) {
                const hashes = await getSavedHashes(legacyId, s);
                if (!Array.isArray(hashes)) return { state: 'provisional', writable: false };
                if (hashes.length) return { state: 'provisional', writable: false };
            }
        } catch (error) {
            return { state: 'provisional', writable: false };
        }
    }
    if (narrowed.length === 1) {
        const id = narrowed[0];
        const peers = await competingChats(snap, id);
        if (peers === null) return { state: 'provisional', writable: false };
        // A missing parent does not prove a unique-UUID branch's collection
        // is shared. Only live competing claims/UUIDs justify quarantine.
        if (peers.length) {
            quarantine(id);
            return commitFresh(snap, opts);
        }

        // Old registry entries may be bare IDs with no backend/source. Probe
        // those using the current store, without treating an unknown hint as
        // proof of ownership or causing a permanent provisional state.
        const cur = extension_settings.vecthare;
        const probe = storeHints(id).map(store => ({ ...store, hinted: true }));
        const currentStore = { backend: cur.vector_backend || 'standard', source: cur.source || 'transformers' };
        if (!probe.some(store => store.backend === currentStore.backend && store.source === currentStore.source)) {
            probe.push(currentStore);
        }
        const { getSavedHashes } = await import('./core-vector-api.js');
        const stores = [];
        for (const store of probe) {
            try {
                const hashes = await getSavedHashes(id, { ...cur, vector_backend: store.backend, source: store.source });
                if (!Array.isArray(hashes)) return { state: 'provisional', writable: false };
                if (hashes.length) stores.push({ backend: store.backend, source: store.source });
            } catch (error) {
                return { state: 'provisional', writable: false }; // Backend unavailable, not empty.
            }
        }
        // A registered legacy ID must remain attached to its uniquely verified
        // chat even when hashes are empty. Standard's vector/list endpoint can
        // report some read errors as [], so [] cannot justify a new identity.
        return commit(snap, id, { owner: snap.owner, chat: snap.chat, origin: 'legacy', uuid: snap.uuid,
            status: 'active', stores: stores.length ? stores : storeHints(id), createdAt: Date.now() });
    }
    return commitFresh(snap, opts);
}

function commitFresh(snap, opts = { create: true }, retireId = null) {
    if (!opts.create) return Promise.resolve({ state: 'unbound', writable: false });
    const id = freshId();
    return commit(snap, id, { owner: snap.owner, chat: snap.chat, origin: 'created', uuid: snap.uuid,
        status: 'active', stores: [], createdAt: Date.now() }, retireId);
}

/** Small local guard: a known collection must not be purged during a write. */
const activeChatCollectionWrites = new Map();
const deletingChatCollections = new Set();
export function beginChatCollectionWrite(id) {
    if (id && deletingChatCollections.has(id)) {
        throw new Error('Chat collection is being deleted; write cancelled');
    }
    if (id) activeChatCollectionWrites.set(id, (activeChatCollectionWrites.get(id) || 0) + 1);
}
/** Exclusive lock, acquired synchronously before any asynchronous delete checks. */
export function tryBeginChatCollectionDelete(id) {
    if (!id || deletingChatCollections.has(id) || isChatCollectionWriteActive(id)) return false;
    deletingChatCollections.add(id);
    return true;
}
export function endChatCollectionDelete(id) { deletingChatCollections.delete(id); }
export function endChatCollectionWrite(id) {
    const count = activeChatCollectionWrites.get(id) || 0;
    if (count > 1) activeChatCollectionWrites.set(id, count - 1);
    else activeChatCollectionWrites.delete(id);
}
export function isChatCollectionWriteActive(id) { return (activeChatCollectionWrites.get(id) || 0) > 0; }

/** Exclusively guards a destructive operation on a chat collection. */
export async function withChatCollectionPurgeGuard(id, task) {
    if (!id?.startsWith(COLLECTION_PREFIXES.VECTHARE_CHAT)) return await task();
    if (!tryBeginChatCollectionDelete(id)) throw new Error('Chat collection is busy; operation cancelled');
    try { return await task(); }
    finally { endChatCollectionDelete(id); }
}

/** Keeps an import's writes from overlapping automatic chat deletion. */
export async function withChatCollectionWriteGuard(id, task) {
    if (!id?.startsWith(COLLECTION_PREFIXES.VECTHARE_CHAT)) return await task();
    beginChatCollectionWrite(id);
    try { return await task(); }
    finally { endChatCollectionWrite(id); }
}

/** Identifies the configured destination; does not store Qdrant credentials. */
export function chatStoreDestination(settings) {
    const backend = settings.vector_backend || 'standard';
    if (backend === 'qdrant') {
        return JSON.stringify([
            settings.qdrant_use_cloud, settings.qdrant_url || '',
            settings.qdrant_host || '', settings.qdrant_port || '',
            // Deterministic change detector, not an authentication mechanism.
            getStringHash(String(settings.qdrant_api_key || '')),
            Boolean(settings.qdrant_multitenancy),
        ]);
    }
    if (backend === 'milvus') return JSON.stringify([
        settings.milvus_address || '', settings.milvus_host || '', settings.milvus_port || '',
        settings.milvus_username || '', getStringHash(String(settings.milvus_token || '')),
    ]);
    return backend;
}

/** Record every destination before its first write, even if that write fails. */
export function recordChatStore(id, settings) {
    const rec = bindingStore().byCollection[id];
    if (!rec || rec.status !== 'active') return;
    const backend = settings.vector_backend || 'standard';
    const source = settings.source || 'transformers';
    const destination = chatStoreDestination(settings);
    rec.stores ??= [];
    if (!rec.stores.some(s => s.backend === backend && s.source === source && s.destination === destination)) {
        rec.stores.push({ backend, source, destination });
        saveSettingsDebounced();
    }
}

/** Rename events update the registry; the saved claim is healed on next load. */
export function onChatBindingRenamed({ avatarId, groupId, oldFileName, newFileName } = {}) {
    const owner = groupId != null ? { type: 'group', id: String(groupId) }
        : avatarId ? { type: 'character', id: String(avatarId) } : null;
    if (!owner) return;
    const oldName = normChat(oldFileName);
    const hits = findBound(owner, oldName);
    if (hits.length !== 1) return;
    const [id, rec] = hits[0];
    // ST may sanitize a requested filename server-side while its rename event
    // still contains the requested spelling. The selected chat is authoritative
    // only if it is demonstrably the chat carrying this exact claim.
    const live = getContext();
    const selected = getChatOwner(live);
    const currentClaim = live.chatMetadata?.vecthare_binding?.collectionId;
    const actual = sameOwner(owner, selected) && currentClaim === id ? normChat(live.chatId) : null;
    const newName = actual || normChat(newFileName);
    if (findBound(owner, newName).length) return;
    rec.renamedChats = [...new Set([...(rec.renamedChats || []), oldName])];
    rec.chat = newName;
    saveSettingsDebounced();
}
export function onCharacterBindingRenamed(oldAvatar, newAvatar) {
    if (!oldAvatar || !newAvatar || oldAvatar === newAvatar) return;
    for (const [, rec] of entries()) {
        if (!sameOwner(rec.owner, { type: 'character', id: oldAvatar })) continue;
        if (findBound({ type: 'character', id: newAvatar }, rec.chat).length) continue;
        rec.renamedOwners = [...new Set([...(rec.renamedOwners || []), ownerKey(rec.owner)])];
        rec.owner = { type: 'character', id: String(newAvatar) };
    }
    saveSettingsDebounced();
}

export async function anotherChatClaimsCollection(rec, id, ctx = getContext()) {
    const owners = [
        ...(ctx.characters || []).filter(char => char.avatar)
            .map(char => ({ type: 'character', id: String(char.avatar) })),
        ...(ctx.groups || []).filter(group => group.id != null)
            .map(group => ({ type: 'group', id: String(group.id) })),
    ];
    if (!owners.some(owner => sameOwner(owner, rec.owner))) return null;
    for (const owner of owners) {
        const all = await ownerChats(owner, ctx);
        if (all === null) return null;
        if (all.some(file => !(sameOwner(owner, rec.owner) && file.chat === rec.chat) &&
            file.meta?.vecthare_binding?.collectionId === id)) return true;
    }
    return false;
}

export function deletionCandidates(filename, type) {
    const chat = normChat(filename);
    return entries().filter(([, rec]) => rec.status === 'active' && rec.owner?.type === type && rec.chat === chat);
}
export function removeChatBinding(id) {
    delete bindingStore().byCollection[id];
    saveSettingsDebounced();
}


/**
 * Builds a legacy chat collection ID (for backwards compatibility checks)
 * Format: vecthare_chat_{chatId}
 * @param {string} [chatId] Optional chatId override
 * @returns {string|null} Legacy collection ID or null
 */
export function buildLegacyChatCollectionId(chatId) {
    const id = chatId || getCurrentChatId();
    if (!id) {
        return null;
    }
    return `${COLLECTION_PREFIXES.VECTHARE_CHAT}${id}`;
}

/**
 * Builds a lorebook collection ID
 * @param {string} lorebookName Lorebook name
 * @param {number} [timestamp] Optional timestamp, defaults to Date.now()
 * @returns {string} Collection ID
 */
export function buildLorebookCollectionId(lorebookName, timestamp) {
    const sanitizedName = lorebookName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .substring(0, 50);
    return `${COLLECTION_PREFIXES.VECTHARE_LOREBOOK}${sanitizedName}_${timestamp || Date.now()}`;
}

/**
 * Builds a character collection ID
 * @param {string} characterName Character name
 * @param {number} [timestamp] Optional timestamp
 * @returns {string} Collection ID
 */
export function buildCharacterCollectionId(characterName, timestamp) {
    const sanitizedName = characterName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .substring(0, 50);
    return `${COLLECTION_PREFIXES.VECTHARE_CHARACTER}${sanitizedName}_${timestamp || Date.now()}`;
}

/**
 * Builds a document collection ID
 * @param {string} documentName Document name
 * @param {number} [timestamp] Optional timestamp
 * @returns {string} Collection ID
 */
export function buildDocumentCollectionId(documentName, timestamp) {
    const sanitizedName = documentName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .substring(0, 50);
    return `${COLLECTION_PREFIXES.VECTHARE_DOCUMENT}${sanitizedName}_${timestamp || Date.now()}`;
}

/**
 * Gets all possible collection IDs for the current chat (for discovery)
 * @param {string} [chatId] Optional chatId override
 * @param {string} [chatUUID] Optional UUID override
 * @returns {{current: string|null, legacy: string|null}} Both format IDs
 */
export function getAllChatCollectionIds(chatId, _chatUUID) {
    const current = chatId ? peekBoundCollectionIdForChat(chatId) : peekChatCollectionId();
    return { current, legacy: null }; // Keep the existing return shape; never guess a shared legacy ID.
}

// ============================================================================
// COLLECTION ID PARSER
// ============================================================================

/**
 * Parses any collection ID format and returns structured info
 * Handles all legacy and current formats.
 *
 * @param {string} collectionId Collection ID to parse
 * @returns {{type: string, rawId: string, scope: string, format: string}} Parsed info
 */
export function parseCollectionId(collectionId) {
    if (!collectionId || typeof collectionId !== 'string') {
        return {
            type: COLLECTION_TYPES.UNKNOWN,
            rawId: 'unknown',
            scope: COLLECTION_SCOPES.UNKNOWN,
            format: 'invalid',
        };
    }

    // New VH format: vh:type:sourceId
    if (collectionId.startsWith(`${VH_PREFIX}:`)) {
        const parts = collectionId.split(':');
        if (parts.length >= 3) {
            return {
                type: parts[1],
                rawId: parts.slice(2).join(':'),
                scope: parts[1] === 'chat' ? COLLECTION_SCOPES.CHAT : COLLECTION_SCOPES.GLOBAL,
                format: 'vh',
            };
        }
    }

    // VectHare chat format: vecthare_chat_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.VECTHARE_CHAT)) {
        return {
            type: COLLECTION_TYPES.CHAT,
            rawId: collectionId.replace(COLLECTION_PREFIXES.VECTHARE_CHAT, ''),
            scope: COLLECTION_SCOPES.CHAT,
            format: 'vecthare',
        };
    }

    // VectHare lorebook format: vecthare_lorebook_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.VECTHARE_LOREBOOK)) {
        return {
            type: COLLECTION_TYPES.LOREBOOK,
            rawId: collectionId.replace(COLLECTION_PREFIXES.VECTHARE_LOREBOOK, ''),
            scope: COLLECTION_SCOPES.GLOBAL,
            format: 'vecthare',
        };
    }

    // VectHare character format: vecthare_character_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.VECTHARE_CHARACTER)) {
        return {
            type: COLLECTION_TYPES.CHARACTER,
            rawId: collectionId.replace(COLLECTION_PREFIXES.VECTHARE_CHARACTER, ''),
            scope: COLLECTION_SCOPES.CHARACTER,
            format: 'vecthare',
        };
    }

    // VectHare document format: vecthare_document_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.VECTHARE_DOCUMENT)) {
        return {
            type: COLLECTION_TYPES.DOCUMENT,
            rawId: collectionId.replace(COLLECTION_PREFIXES.VECTHARE_DOCUMENT, ''),
            scope: COLLECTION_SCOPES.GLOBAL,
            format: 'vecthare',
        };
    }

    // Legacy file format: file_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.FILE)) {
        return {
            type: COLLECTION_TYPES.FILE,
            rawId: collectionId.replace(COLLECTION_PREFIXES.FILE, ''),
            scope: COLLECTION_SCOPES.GLOBAL,
            format: 'legacy',
        };
    }

    // Legacy lorebook format: lorebook_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.LOREBOOK)) {
        return {
            type: COLLECTION_TYPES.LOREBOOK,
            rawId: collectionId.replace(COLLECTION_PREFIXES.LOREBOOK, ''),
            scope: COLLECTION_SCOPES.GLOBAL,
            format: 'legacy',
        };
    }

    // Ragbooks lorebook format: ragbooks_lorebook_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.RAGBOOKS_LOREBOOK)) {
        return {
            type: COLLECTION_TYPES.LOREBOOK,
            rawId: collectionId.replace(COLLECTION_PREFIXES.RAGBOOKS_LOREBOOK, ''),
            scope: COLLECTION_SCOPES.GLOBAL,
            format: 'ragbooks',
        };
    }

    // CarrotKernel/Fullsheet character format: carrotkernel_char_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.CARROTKERNEL_CHAR)) {
        return {
            type: COLLECTION_TYPES.CHARACTER,
            rawId: collectionId.replace(COLLECTION_PREFIXES.CARROTKERNEL_CHAR, ''),
            scope: COLLECTION_SCOPES.CHARACTER,
            format: 'fullsheet',
        };
    }

    // Heuristic: date/timestamp patterns suggest chat
    if (collectionId.includes('@') || /\d{4}-\d{2}-\d{2}/.test(collectionId)) {
        return {
            type: COLLECTION_TYPES.CHAT,
            rawId: collectionId,
            scope: COLLECTION_SCOPES.CHAT,
            format: 'legacy_chat',
        };
    }

    // Default: unknown
    return {
        type: COLLECTION_TYPES.UNKNOWN,
        rawId: collectionId,
        scope: COLLECTION_SCOPES.UNKNOWN,
        format: 'unknown',
    };
}

// ============================================================================
// PATTERN MATCHING FOR DISCOVERY
// ============================================================================

/**
 * Builds search patterns for finding a chat's collections
 * Used by doesChatHaveVectors and similar discovery functions
 *
 * @param {string} [chatId] Chat ID (filename)
 * @param {string} [chatUUID] Chat UUID
 * @returns {string[]} Array of patterns to search for (all lowercase)
 */
export function buildChatSearchPatterns(chatId, chatUUID) {
    const patterns = [];
    const uuid = chatUUID || getChatUUID();
    const id = chatId || getCurrentChatId();

    // Primary: UUID (the unique identifier)
    if (uuid) {
        patterns.push(uuid.toLowerCase());
    }

    // Legacy: full chatId
    if (id) {
        patterns.push(`${COLLECTION_PREFIXES.VECTHARE_CHAT}${id}`.toLowerCase());

        // Extract character name (before " - " in filename)
        const charNameMatch = id.match(/^([^-]+)/);
        if (charNameMatch) {
            const charName = charNameMatch[1].trim().toLowerCase();
            if (charName) {
                patterns.push(`${COLLECTION_PREFIXES.VECTHARE_CHAT}${charName}`.toLowerCase());
            }
        }
    }

    return patterns;
}

/**
 * Checks if a collection ID matches any of the given patterns
 * Case-insensitive, uses substring matching for flexibility
 *
 * @param {string} collectionId Collection ID to check
 * @param {string[]} patterns Patterns to match against
 * @returns {boolean} True if matches any pattern
 */
export function matchesPatterns(collectionId, patterns) {
    if (!collectionId || !patterns || patterns.length === 0) {
        return false;
    }

    const idLower = collectionId.toLowerCase();

    return patterns.some(pattern =>
        idLower === pattern ||
        idLower.includes(pattern)
    );
}

/**
 * Extracts backend and source from a registry key
 * Registry keys can be:
 * - "backend:source:collectionId" (new format)
 * - "source:collectionId" (migration format)
 * - "collectionId" (legacy format)
 *
 * @param {string} registryKey Registry key to parse
 * @returns {{backend: string|null, source: string|null, collectionId: string}} Parsed key
 */
export function parseRegistryKey(registryKey) {
    if (!registryKey || typeof registryKey !== 'string') {
        return { backend: null, source: null, collectionId: '' };
    }

    // Known backends and embedding sources
    const knownBackends = ['standard', 'lancedb', 'vectra', 'milvus', 'qdrant'];
    const knownSources = ['transformers', 'openai', 'cohere', 'ollama', 'llamacpp',
        'vllm', 'koboldcpp', 'webllm', 'bananabread', 'openrouter',
        'electronhub', 'mistral', 'nomicai', 'palm', 'vertexai', 'togetherai', 'extras'];

    const parts = registryKey.split(':');

    // New format: backend:source:collectionId (3+ parts)
    if (parts.length >= 3 && knownBackends.includes(parts[0]) && knownSources.includes(parts[1])) {
        return {
            backend: parts[0],
            source: parts[1],
            collectionId: parts.slice(2).join(':'),  // Rest is collection ID (may contain colons)
        };
    }

    // Migration format: source:collectionId (2+ parts, starts with source)
    if (parts.length >= 2 && knownSources.includes(parts[0])) {
        return {
            backend: null,  // Backend unknown in old format
            source: parts[0],
            collectionId: parts.slice(1).join(':'),
        };
    }

    // Legacy format: just collectionId (no colons, or unknown prefix)
    return { backend: null, source: null, collectionId: registryKey };
}
