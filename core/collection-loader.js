import { vhLog } from '../utils/log.js';
import AsyncUtils from '../utils/async-utils.js';
/**
 * ============================================================================
 * VECTHARE COLLECTION LOADER
 * ============================================================================
 * Data access layer for managing vector collections and chunks
 *
 * @author Coneja Chibi
 * @version see manifest.json
 * ============================================================================
 */

import { extension_settings } from '../../../../extensions.js';
import { vecthareState, persistVectHareStore, assertStoreAuthoritative, flushVectHareStore, saveVerifiedDeletion } from './vecthare-store.js';
import { getContext } from '../../../../extensions.js';
import { characters, substituteParams, getRequestHeaders, saveSettingsDebounced } from '../../../../../script.js';
import { getSavedHashes, queryCollection, withCollectionModelForStandard } from './core-vector-api.js';
import { getStringHash } from '../../../../utils.js';
import {
    isCollectionEnabled,
    setCollectionEnabled,
    getChunkMetadata,
    saveChunkMetadata,
    deleteChunkMetadata,
    deleteCollectionMeta,
    recordVerifiedCollectionDeletion,
    getCollectionMeta,
    setCollectionMeta,
    getAllChunkMetadata,
    readInitialVectorizationConfig,
    verifyPhysicalCollectionExistence,
    getStoredCollectionRecord,
    findStoredCollectionKey,
    forgetLegacyCollectionKeys,
    hasLegacyCollectionKeys,
    getAnnotatedChunkHashes,
    locateQdrantCollectionByPresence,
} from './collection-metadata.js';
import { purgeVectorIndex } from './core-vector-api.js';
import { resolveStorage, getStorageLocator, locatorForPhysical, isV2Layout } from './storage-resolver.js';
// Import from collection-ids.js - single source of truth for collection ID operations
import {
    getChatUUID,
    buildChatCollectionId as getChatCollectionId,
    buildLegacyChatCollectionId as getLegacyChatCollectionId,
    parseCollectionId,
    buildChatSearchPatterns,
    matchesPatterns,
    parseRegistryKey,
    COLLECTION_PREFIXES,
    peekChatCollectionId,
    peekBoundCollectionIdForChat,
    getBoundChatDetails,
    isQuarantinedChatCollection,
    withChatCollectionPurgeGuard,
    removeChatBinding,
} from './collection-ids.js';

// Plugin detection state
let pluginAvailable = null;
let pluginAvailabilityCheckId = 0;

/**
 * Gets or initializes the collection registry
 * @returns {string[]} Array of collection IDs
 */
export function getCollectionRegistry() {
    if (!vecthareState().registry) {
        vecthareState().registry = [];
    }
    return vecthareState().registry;
}

/**
 * Registers a collection in the registry (idempotent)
 * @param {string} collectionId Collection identifier
 */
export function registerCollection(collectionId) {
    if (!collectionId) {
        console.warn('VectHare: Attempted to register null/undefined collectionId, skipping');
        return;
    }
    const registry = getCollectionRegistry();
    // VH-028: one entry per collection. A bare id is not added next to its
    // backend:source:id twin, and a prefixed key replaces a bare twin.
    const parsed = parseRegistryKey(collectionId);
    if (!parsed.backend) {
        if (registry.some(key => key !== collectionId && parseRegistryKey(key).backend &&
            parseRegistryKey(key).collectionId === collectionId)) return;
    } else if (parsed.collectionId && parsed.collectionId !== collectionId) {
        const bare = registry.indexOf(parsed.collectionId);
        if (bare !== -1) {
            registry.splice(bare, 1);
            vhLog(`VectHare: Registry: ${parsed.collectionId} replaced by ${collectionId}`);
        }
    }
    if (!registry.includes(collectionId)) {
        registry.push(collectionId);
        vhLog(`VectHare: Registered collection: ${collectionId}`);
        persistVectHareStore(); // Persist to collections.json
    } else if (parsed.backend) {
        persistVectHareStore();
    }
}

/**
 * Unregisters a collection from the registry
 * @param {string} collectionId Collection identifier (can be plain id or source:id format)
 */
export function unregisterCollection(collectionId) {
    const registry = getCollectionRegistry();
    const index = registry.indexOf(collectionId);
    if (index !== -1) {
        registry.splice(index, 1);
        vhLog(`VectHare: Unregistered collection: ${collectionId}`);
        persistVectHareStore(); // Persist to collections.json
    } else {
        vhLog(`VectHare: Collection not found in registry: ${collectionId}`);
    }
}

/**
 * Remove registry aliases for the destination that was actually purged.
 * Chat collection IDs can have both the old bare key and qualified keys.
 * Never erase another backend/source's qualified record just because it
 * shares this chat ID.
 */
export function unregisterCollectionDestination(collectionId, settings) {
    const backend = name => name === 'vectra' ? 'standard' : name;
    const selectedBackend = backend(settings?.vector_backend || 'standard');
    const selectedSource = settings?.source || 'transformers';
    const registry = [...getCollectionRegistry()];
    for (const key of registry) {
        const parsed = parseRegistryKey(key);
        if (parsed.collectionId !== collectionId) continue;
        if (parsed.backend && backend(parsed.backend) !== selectedBackend) continue;
        if (parsed.source && parsed.source !== selectedSource) continue;
        unregisterCollection(key);
    }
}

/**
 * Whether VectHare's registry holds a BACKEND-QUALIFIED entry for this
 * identity at exactly this destination. A bare, unqualified entry is not
 * evidence of a destination and never counts here.
 * @param {string} collectionId Bare collection identifier
 * @param {object} settings Settings addressing the destination in question
 * @returns {boolean}
 */
function registryRecordsThisDestination(collectionId, settings) {
    const normalize = name => (name === 'vectra' ? 'standard' : name);
    const selectedBackend = normalize(settings?.vector_backend || 'standard');
    const selectedSource = settings?.source || 'transformers';
    const matches = key => {
        const parsed = parseRegistryKey(key);
        if ((parsed.collectionId || key) !== collectionId) return false;
        if (!parsed.backend || !parsed.source) return false;
        return normalize(parsed.backend) === selectedBackend && parsed.source === selectedSource;
    };
    if (getCollectionRegistry().some(matches)) return true;
    // The backend's own inventory is the same evidence from the other side: it
    // reported this identity at this backend and source. A collection
    // discovered but never registered is not left undeletable for that.
    return Object.keys(pluginCollectionData || {}).some(matches);
}

/**
 * COMPLETE collection deletion - removes from ALL THREE stores:
 * 1. Vector backend (actual embeddings)
 * 2. Registry (collection tracking)
 * 3. Metadata (display names, settings, chunk info)
 *
 * This is the ONE function that should be called to fully delete a collection.
 * All other delete functions are partial and will leave ghosts.
 *
 * @param {string} collectionId - Collection ID to delete
 * @param {object} settings - VectHare settings (for backend routing)
 * @param {string} [registryKey] - Optional registry key (source:id format) if different from collectionId
 * @returns {Promise<{success: boolean, errors: string[], vectorsDeleted: boolean, registryDeleted: boolean, metadataDeleted: boolean}>}
 */
export async function deleteCollection(collectionId, settings, registryKey = null, options = {}) {
    try {
        return await withChatCollectionPurgeGuard(collectionId,
            () => deleteCollectionUnlocked(collectionId, settings, registryKey, options));
    } catch (error) {
        return { success: false, errors: [error.message], vectorsDeleted: false,
            registryDeleted: false, metadataDeleted: false };
    }
}

async function deleteCollectionUnlocked(collectionId, settings, registryKey = null, options = {}) {
    // VH-048: Standard keeps one copy per model; delete the one this collection
    // was made with, not today's model.
    settings = await withCollectionModelForStandard(parseRegistryKey(collectionId).collectionId || collectionId, settings);
    const errors = [];
    let vectorsDeleted = false;
    let registryDeleted = false;
    let metadataDeleted = false;

    vhLog(`VectHare: Deleting collection ${collectionId} (registry key: ${registryKey || collectionId})`);

    // VH-089: a Qdrant collection without a locator is found where it really is,
    // not where today's multitenancy switch points.
    await locateQdrantCollectionByPresence(registryKey || collectionId, settings).catch(() => null);

    // Step 0: establish, at the recorded destination and right now, whether
    // this is an existing collection that holds no vectors. An empty
    // collection must stay deletable even when it has no verifiable original
    // configuration - there are no vectors for that record to protect. A
    // failed read or a failed existence check is never treated as emptiness.
    const target = parseRegistryKey(collectionId).collectionId || collectionId;
    let verifiedEmpty = false;
    let presentHere = false;
    try {
        const before = await verifyPhysicalCollectionExistence(collectionId, settings);
        presentHere = before.existence === 'present';
        if (presentHere) {
            // P6: a trusted count from the existence check answers emptiness
            // without listing every hash.
            if (Number.isSafeInteger(before.count) && before.countTrusted === true) {
                verifiedEmpty = before.count === 0;
            } else {
                const hashes = await getSavedHashes(collectionId, settings);
                verifiedEmpty = Array.isArray(hashes) && hashes.length === 0;
            }
        }
    } catch (error) {
        console.debug(`VectHare: Could not establish emptiness for ${collectionId}: ${error.message}`);
    }

    // Independent proof of WHAT is being deleted and WHOSE it is, for a legacy
    // or incompatible collection whose original configuration cannot be read:
    // it exists at this exact recorded destination, the registry records that
    // destination for this identity, and the identity is VectHare-owned. This
    // authorizes deletion only - it is never used to embed, sync or repair.
    const identity = validateMetadataRecordIdentity(target, registryKey || collectionId);
    const ownershipVerified = presentHere && identity.owned &&
        registryRecordsThisDestination(target, settings);
    // The user confirmed a specific destination they recognise as theirs, for a
    // collection too old to carry VectHare's ownership markers. VectHare still
    // requires the destination itself to be proven: the collection must exist
    // at exactly this recorded destination. Nothing else relaxes.
    const onUserAuthority = options.userConfirmedUnownedDeletion === true && presentHere;
    if (options.userConfirmedUnownedDeletion === true && !presentHere) {
        errors.push('This collection was not confirmed present at its recorded destination, ' +
            'so it was not deleted on your authority alone.');
        return { success: false, errors, vectorsDeleted: false,
            registryDeleted: false, metadataDeleted: false };
    }

    // Step 0 (VH-053): old copies left by a storage move go first, while the
    // collection's current location is still recorded. If one cannot be
    // deleted, nothing else is, so the copy cannot be orphaned.
    try {
        const { deleteAllOldStorageCopies } = await import('./storage-move.js');
        const copies = await deleteAllOldStorageCopies(collectionId, settings);
        if (!copies.success) {
            errors.push(`Old copy: ${copies.reason}. Nothing else was deleted.`);
            return { success: false, errors, vectorsDeleted: false, registryDeleted: false, metadataDeleted: false };
        }
        errors.push(...copies.warnings);
    } catch (error) {
        errors.push(`Old copy: ${error.message}. Nothing else was deleted.`);
        return { success: false, errors, vectorsDeleted: false, registryDeleted: false, metadataDeleted: false };
    }

    // Step 1: Delete vectors from backend (most important - actual data)
    const purgeDiagnostics = {};
    try {
        if (!await purgeVectorIndex(collectionId, settings,
            { verifiedEmpty, ownershipVerified, userConfirmedUnownedDeletion: onUserAuthority,
                diagnostics: purgeDiagnostics })) {
            throw new Error(purgeDiagnostics.reason
                ? `${purgeDiagnostics.reason}${ownershipVerified || onUserAuthority ? '' : ' ' + [
                    presentHere ? '' : 'the collection was not confirmed present at this destination',
                    identity.owned ? '' : 'VectHare ownership could not be established',
                    registryRecordsThisDestination(target, settings) ? ''
                        : 'no backend-qualified registry entry records this destination',
                ].filter(Boolean).join('; ')}`.trim()
                : 'Backend did not confirm collection purge');
        }
        vectorsDeleted = true;
        invalidateCollectionInventory(collectionId);
        vhLog(`VectHare: ✓ Deleted vectors for ${collectionId}`);
    } catch (error) {
        errors.push(`Vectors: ${error.message}`);
        console.warn(`VectHare: ✗ Failed to delete vectors for ${collectionId}:`, error.message);
        // No registry or metadata cleanup if actual vectors may still exist.
        return { success: false, errors, vectorsDeleted: false,
            registryDeleted: false, metadataDeleted: false };
    }

    // Step 3: confirm the physical collection is really gone, then remove the
    // same VectHare-owned state Delete Metadata removes, so a successful
    // deletion cannot leave a stale metadata-only record behind.
    let absenceVerified = false;
    const notes = [];
    try {
        const verified = await verifyPhysicalCollectionExistence(collectionId, settings, { afterDelete: true });
        absenceVerified = verified.existence === 'absent';
        if (absenceVerified && verified.sharedLeftover) {
            // VH-011 (option B): Milvus' older shared store.
            notes.push(sharedLeftoverNote(verified.sharedLeftover));
        }
        if (!absenceVerified) {
            const standard = ['standard', 'vectra'].includes(settings?.vector_backend || 'standard');
            errors.push(`Deletion could not be verified (${verified.existence}` +
                `${verified.reason ? `: ${verified.reason}` : ''}); the collection's records were kept.` +
                (standard && verified.existence === 'present'
                    ? ' On the Standard backend each embedding model keeps its own copy: if this collection ' +
                      'was made with another model, switch to that model and delete again.' : ''));
        }
    } catch (error) {
        errors.push(`Deletion verification: ${error.message}`);
    }

    // VH-048: unregister only once the collection is confirmed gone, so a
    // deletion that could not be verified keeps its row and its records.
    if (absenceVerified) {
        try {
            // Only after confirmed backend deletion; keep unrelated destinations.
            unregisterCollectionDestination(collectionId, settings);
            registryDeleted = true;
            vhLog(`VectHare: ✓ Unregistered ${collectionId}`);
        } catch (error) {
            errors.push(`Registry: ${error.message}`);
            console.warn(`VectHare: ✗ Failed to unregister ${collectionId}:`, error.message);
        }
    }

    if (absenceVerified) {
        try {
            // Only a confirmed successful vector purge can authorize a fresh
            // start. This marker lives in VectHare-owned metadata, never in the
            // chat file, and is written before the record it refers to is gone.
            recordVerifiedCollectionDeletion(collectionId, settings);
            const cleanup = await deleteCollectionMetadataOnly(collectionId, settings, registryKey,
                { verifiedAbsent: true });
            metadataDeleted = cleanup.success;
            if (!cleanup.success) {
                errors.push(`Metadata cleanup incomplete: ${cleanup.errors.join(', ')}`);
                // Leave a record so the pending cleanup is visible after a
                // refresh or restart instead of disappearing silently.
                setCollectionMeta(collectionId, { pendingMetadataCleanup: true,
                    pendingMetadataCleanupAt: Date.now() });
                persistVectHareStore();
            } else {
                vhLog(`VectHare: ✓ Deleted metadata for ${collectionId} (${cleanup.removed.join(', ') || 'nothing left'})`);
            }
        } catch (error) {
            errors.push(`Metadata: ${error.message}`);
            console.warn(`VectHare: ✗ Failed to delete metadata for ${collectionId}:`, error.message);
            try {
                setCollectionMeta(collectionId, { pendingMetadataCleanup: true,
                    pendingMetadataCleanupAt: Date.now() });
                persistVectHareStore();
            } catch { /* the record is best effort; the error above is reported */ }
        }
    }

    const success = vectorsDeleted && absenceVerified && registryDeleted && metadataDeleted;

    if (metadataDeleted) {
        // VH-021: the deletion is saved at once, before any other tab's older
        // copy of the record can be merged back in.
        try { await saveVerifiedDeletion(); }
        catch (error) { errors.push(`Saving the deletion: ${error.message} (it is saved with the next change)`); }
    }

    if (success) {
        vhLog(`VectHare: ✓ Fully deleted collection ${collectionId}`);
    } else {
        // VEC-28: Warn about partial deletion to prevent zombie collections
        const warningMsg = `VectHare: ⚠️ PARTIAL DELETION of ${collectionId} - may create zombie collection. Errors: ${errors.join(', ')}`;
        console.error(warningMsg);
        // Only treat as critical failure if ALL steps failed
        if (!vectorsDeleted && !registryDeleted && !metadataDeleted) {
            throw new Error(`Complete deletion failure for ${collectionId}: ${errors.join(', ')}`);
        }
    }

    return {
        success,
        errors,
        notes,
        vectorsDeleted,
        absenceVerified,
        registryDeleted,
        metadataDeleted,
    };
}

/**
 * VH-011: what a user is told when rows had to stay in Milvus' older shared store.
 * @param {number} count
 * @returns {string}
 */
export function sharedLeftoverNote(count) {
    return `${count} chunk(s) with exactly the same text as another chat's chunk were left in place: Milvus' ` +
        'older shared storage keeps them under one key, so removing them would remove the other chat\'s too. ' +
        'VectHare no longer uses them; they stay in that older store.';
}

/**
 * Removes VectHare's own metadata for a collection whose physical absence has
 * been confirmed, so the associated chat behaves like a chat that was never
 * vectorized. Deletes NO vectors and never calls backend deletion: this is not
 * Delete Collection.
 *
 * Only state uniquely associated with this collection is removed. Chat
 * messages, characters, global settings and anything that might belong to
 * another collection are left untouched.
 *
 * @param {string} collectionId Collection identifier
 * @param {object} settings Settings addressing the collection's own destination
 * @param {string|null} registryKey Full registry key, when known
 * @param {object} options {verifiedAbsent, model} - verifiedAbsent skips the
 *   absence re-check for a caller that has just verified deletion itself
 * @returns {Promise<{success: boolean, removed: string[], errors: string[]}>}
 */
export async function deleteCollectionMetadataOnly(collectionId, settings, registryKey = null,
    options = {}) {
    assertStoreAuthoritative('Deleting collection metadata');
    const removed = [];
    const errors = [];

    // Source-of-truth guard for the Delete Metadata path: act only on an
    // identity VectHare's own metadata file actually holds a validated record
    // for. A discovered name or an unreadable entry is inspected, not deleted.
    // Delete Collection passes verifiedAbsent and has already established both
    // ownership and absence for the row it is cleaning up after.
    if (options.verifiedAbsent !== true) {
        const target = parseRegistryKey(collectionId).collectionId || collectionId;
        const identity = validateMetadataRecordIdentity(target, registryKey || collectionId);
        // This path removes only VectHare's OWN state - it deletes no vectors
        // and touches no other extension's data - so what it requires is that
        // there is something of VectHare's to remove, and that the collection's
        // absence is confirmed (verified immediately below, every time, never
        // taken from a cached row). Ownership is not required: an unowned entry
        // is still VectHare's own record to forget. Nor is a READABLE record:
        // an unreadable entry is precisely the ghost that needs clearing, and
        // it is matched by its key, not by its contents.
        const stale = [registryKey, collectionId, target].filter(Boolean);
        const hasRegistryEntry = getCollectionRegistry().some(key =>
            (parseRegistryKey(key).collectionId || key) === target || stale.includes(key));
        const hasAnnotations = getAnnotatedChunkHashes(target).length > 0 ||
            getAnnotatedChunkHashes(registryKey || collectionId).length > 0;
        if (!identity.hasRecord && !hasRegistryEntry && !hasAnnotations) {
            return {
                success: false, removed,
                errors: ['VectHare holds nothing of its own for this identity, so nothing was removed.'],
            };
        }
        if (identity.malformed) {
            console.warn(`VectHare: Removing an unreadable VectHare entry for ${collectionId}. ` +
                'No vectors are deleted.');
        }
        if (!identity.owned) {
            console.warn(`VectHare: Removing VectHare's own local record for ${collectionId}, ` +
                'which nothing identifies as VectHare-owned. No vectors are deleted.');
        }
    }

    // Re-check absence at the exact recorded destination immediately before
    // removing anything. A cached classification from the last refresh is not
    // good enough, and anything other than an explicit 'absent' stops here.
    // Delete Collection passes verifiedAbsent after its own verification.
    // allowWhilePresent is a deliberate LOCAL reset of a collection that still
    // exists: VectHare forgets its own records for it and the vectors stay
    // where they are. Only the Metadata window's own Delete Metadata sets it,
    // after a confirmation that says what Regenerate can and cannot recover.
    if (options.verifiedAbsent !== true && options.allowWhilePresent !== true) {
        // VH-089: absence counts only where the collection really is.
        await locateQdrantCollectionByPresence(registryKey || collectionId, settings).catch(() => null);
        const verified = await verifyPhysicalCollectionExistence(collectionId, settings, {
            backend: settings.vector_backend,
            source: settings.source,
            model: options.model ?? '',
        });
        if (verified.existence !== 'absent') {
            return {
                success: false, removed, errors: [verified.existence === 'present'
                    ? 'The physical collection still exists at its recorded destination; metadata was kept.'
                    : `Absence could not be confirmed (${verified.reason || 'unverified'}); metadata was kept.`],
            };
        }
    }

    // The ledger goes first: it is the only part held outside collections.json,
    // so a failure here must not leave a ledger behind with no record of it.
    try {
        // Imported lazily: chat-vectorization.js already imports this module.
        const { discardIdentityLedgerForCollection } = await import('./chat-vectorization.js');
        if (await discardIdentityLedgerForCollection(collectionId, settings)) {
            removed.push('identity ledger');
        }
    } catch (error) {
        errors.push(`Identity ledger: ${error.message}`);
        console.warn(`VectHare: Could not remove the identity ledger for ${collectionId}:`, error.message);
        return { success: false, removed, errors };
    }

    try {
        const registry = getCollectionRegistry();
        const target = parseRegistryKey(collectionId).collectionId || collectionId;
        const keep = registry.filter(key => (parseRegistryKey(key).collectionId || key) !== target);
        if (keep.length !== registry.length) {
            vecthareState().registry = keep;
            removed.push(`${registry.length - keep.length} registry entr${registry.length - keep.length === 1 ? 'y' : 'ies'}`);
        }
    } catch (error) {
        errors.push(`Registry: ${error.message}`);
    }

    try {
        deleteCollectionMeta(collectionId);
        if (registryKey && registryKey !== collectionId) deleteCollectionMeta(registryKey);
        removed.push('collection metadata');
    } catch (error) {
        errors.push(`Collection metadata: ${error.message}`);
    }

    // Chunk annotations scoped to this collection only; a shared (legacy)
    // record is left for whichever collection still uses it.
    try {
        let annotations = 0;
        for (const hash of Object.keys(vecthareState().chunkMetadata || {})) {
            const before = JSON.stringify(vecthareState().chunkMetadata[hash] || null);
            deleteChunkMetadata(hash, collectionId);
            if (JSON.stringify(vecthareState().chunkMetadata[hash] || null) !== before) annotations++;
        }
        if (annotations) removed.push(`${annotations} chunk annotation(s)`);
    } catch (error) {
        errors.push(`Chunk annotations: ${error.message}`);
    }

    // The binding last: while it exists the chat can rebind to this identity,
    // so removing it is what makes the chat fresh again.
    try {
        const target = parseRegistryKey(collectionId).collectionId || collectionId;
        if (getBoundChatDetails(target) || isQuarantinedChatCollection(target)) {
            removeChatBinding(target);
            removed.push('chat binding');
        }
    } catch (error) {
        errors.push(`Chat binding: ${error.message}`);
    }

    // Obsolete pre-migration keys for this identity. Left in place, the
    // startup migration recreates a collection record from them, which is how
    // a deleted record reappears after a restart.
    try {
        const legacy = forgetLegacyCollectionKeys(collectionId);
        if (legacy.length) removed.push(`${legacy.length} obsolete migration key(s)`);
    } catch (error) {
        errors.push(`Obsolete migration keys: ${error.message}`);
    }

    // Cached backend inventory for this identity: stale counts and
    // destinations must not reappear on the next refresh.
    try {
        invalidateCollectionInventory(collectionId);
    } catch (error) {
        errors.push(`Cached inventory: ${error.message}`);
    }

    // Nothing is reported as done until it is actually on disk.
    try {
        await flushVectHareStore();
    } catch (error) {
        errors.push(`Saving metadata: ${error.message}`);
        return { success: false, removed, errors };
    }

    // Read back what is now stored. "Deleted" is only reported when the
    // record, its registry entries, its binding and its obsolete migration
    // keys are actually absent from the persisted state.
    const target = parseRegistryKey(collectionId).collectionId || collectionId;
    const leftovers = [];
    try {
        if (findStoredCollectionKey(collectionId) || findStoredCollectionKey(registryKey || collectionId)) {
            leftovers.push('collection record');
        }
        if (getCollectionRegistry().some(key => (parseRegistryKey(key).collectionId || key) === target)) {
            leftovers.push('registry entry');
        }
        if (getBoundChatDetails(target)) leftovers.push('chat binding');
        if (hasLegacyCollectionKeys(collectionId)) leftovers.push('obsolete migration key');
    } catch (error) {
        leftovers.push(`verification failed (${error.message})`);
    }
    if (leftovers.length) {
        errors.push(`Still present after saving: ${leftovers.join(', ')}`);
    }

    const success = errors.length === 0;
    vhLog(`VectHare: Metadata reset for ${collectionId} - removed: ${removed.join(', ') || 'nothing'}` +
        (errors.length ? ` | errors: ${errors.join(', ')}` : ''));
    return { success, removed, errors, verified: leftovers.length === 0 };
}

/**
 * Rebuilds only the LOCAL VectHare metadata that can be independently
 * verified for one collection. It never vectorizes, never creates a physical
 * collection, and never invents original settings, chat ownership or ledger
 * history: anything that cannot be established is reported as unverified and
 * left exactly as it is.
 *
 * @param {string} collectionId Collection identifier
 * @param {object} settings Settings addressing the recorded destination
 * @param {string|null} registryKey Full registry key, when known
 * @returns {Promise<{success: boolean, restored: string[], preserved: string[],
 *   cleared: string[], unverified: string[]}>}
 */
export async function regenerateCollectionMetadata(collectionId, settings, registryKey = null) {
    assertStoreAuthoritative('Regenerating collection metadata');
    const restored = [];
    const preserved = [];
    const cleared = [];
    const unverified = [];

    const verified = await verifyPhysicalCollectionExistence(collectionId, settings, {
        backend: settings.vector_backend,
        source: settings.source,
    });
    if (verified.existence === 'unverified') {
        return { success: false, restored, preserved, cleared,
            unverified: [`physical existence (${verified.reason || 'could not be checked'})`] };
    }

    const target = parseRegistryKey(collectionId).collectionId || collectionId;
    const key = registryKey || collectionId;

    // Nothing to recover from: no record in VectHare's metadata file and
    // nothing at the recorded destination. Regeneration must never bring back
    // a record that was deliberately and successfully deleted, so this stops
    // before any write rather than recreating one from a stale row.
    if (verified.existence === 'absent' &&
        !getStoredCollectionRecord(key) && !getStoredCollectionRecord(collectionId)) {
        // An unreadable entry is a different situation from no entry, and
        // regeneration can repair neither: there is nothing at the destination
        // to verify anything against, and replacing an unreadable record with
        // a clean one would be inventing a record. Use Delete Metadata.
        const unreadable = Boolean(findStoredCollectionKey(key) || findStoredCollectionKey(collectionId));
        return { success: false, restored, preserved, cleared,
            unverified: [unreadable
                ? 'nothing to regenerate (this entry is unreadable and nothing exists at the recorded ' +
                  'destination to rebuild it from - use Delete Metadata to clear it)'
                : 'nothing to regenerate (no VectHare record, and nothing exists at the recorded destination)'] };
    }

    // 1. Registry entry: recoverable only for a collection that demonstrably
    //    exists at the destination the entry would name.
    if (verified.existence === 'present') {
        const registry = getCollectionRegistry();
        if (!registry.some(entry => (parseRegistryKey(entry).collectionId || entry) === target)) {
            const backend = settings.vector_backend || 'standard';
            const source = verified.model && settings.source ? settings.source : (settings.source || 'transformers');
            registerCollection(`${backend}:${source}:${target}`);
            restored.push('registry entry');
        } else {
            preserved.push('registry entry');
        }
    } else {
        unverified.push('registry entry (no physical collection to register)');
    }

    // 2. Physical presence and chunk count: refreshed from the backend only.
    if (verified.existence === 'present') {
        try {
            const hashes = await getSavedHashes(target, settings);
            if (Array.isArray(hashes)) {
                setCollectionMeta(key, { chunkCount: hashes.length });
                restored.push(`chunk count (${hashes.length})`);
            } else {
                unverified.push('chunk count');
            }
        } catch (error) {
            unverified.push(`chunk count (${error.message})`);
        }
    }

    // 3. The authoritative original configuration is backend-resident. It is
    //    read to report its state and NEVER written, reconstructed or guessed.
    try {
        const saved = await readInitialVectorizationConfig(target, settings, {
            backend: settings.vector_backend,
            source: settings.source,
        });
        if (saved.status === 'valid') {
            preserved.push('verified original configuration');
        } else {
            unverified.push(`original configuration (${saved.status})`);
        }
    } catch (error) {
        unverified.push(`original configuration (${error.message})`);
    }

    // 4. Local annotations are user data: kept untouched.
    const annotations = Object.keys(getAllChunkMetadata(target) || {}).length;
    if (annotations) preserved.push(`${annotations} chunk annotation(s)`);

    // 5. Chat binding: reconstructed only from an existing authoritative
    //    binding record, never inferred from a name or an id resemblance.
    const bound = getBoundChatDetails(target);
    if (bound) preserved.push('chat binding');
    else if (isQuarantinedChatCollection(target)) preserved.push('preserved (unassigned) binding');
    else unverified.push('chat binding (no authoritative ownership evidence)');

    // 6. Local metadata fields that are demonstrably invalid can be cleared;
    //    missing information is never treated as verified.
    const meta = getCollectionMeta(key) || {};
    const invalid = {};
    if (meta.chunkCount != null && !Number.isFinite(Number(meta.chunkCount))) invalid.chunkCount = null;
    if (meta.preferredModel != null && typeof meta.preferredModel !== 'string') invalid.preferredModel = null;
    if (meta.pendingMetadataCleanup === true && verified.existence === 'present') {
        // The collection is here after all, so a pending-cleanup flag is stale.
        invalid.pendingMetadataCleanup = false;
    }
    if (Object.keys(invalid).length) {
        setCollectionMeta(key, invalid);
        cleared.push(...Object.keys(invalid));
    }

    // 7. The identity ledger is never fabricated.
    unverified.push('identity ledger (never reconstructed)');

    try {
        await flushVectHareStore();
    } catch (error) {
        return { success: false, restored, preserved, cleared,
            unverified: [...unverified, `saving metadata (${error.message})`] };
    }

    vhLog(`VectHare: Regenerated metadata for ${target} - restored: ${restored.join(', ') || 'nothing'}` +
        ` | preserved: ${preserved.join(', ') || 'nothing'}` +
        ` | cleared: ${cleared.join(', ') || 'nothing'}`);
    return { success: true, restored, preserved, cleared, unverified };
}

/**
 * Clears the entire registry (useful for debugging/reset)
 */
export function clearCollectionRegistry() {
    vecthareState().registry = [];
    vhLog('VectHare: Cleared collection registry');
    persistVectHareStore(); // Persist to collections.json
}

/**
 * Cleans up registry by removing null entries and duplicates
 */
export function cleanupCollectionRegistry() {
    const registry = getCollectionRegistry();
    const cleaned = [...new Set(registry.filter(id => id != null && id !== ''))];
    vecthareState().registry = cleaned;
    const removed = registry.length - cleaned.length;
    if (removed > 0) {
        vhLog(`VectHare: Cleaned registry - removed ${removed} invalid/duplicate entries`);
        persistVectHareStore(); // Persist to collections.json
    }
    return removed;
}

/**
 * Cleans up test collections from registry (visualizer/production tests)
 * Call this to remove ghost test entries that weren't properly cleaned up
 * @returns {number} Number of test entries removed
 */
export function cleanupTestCollections() {
    const registry = getCollectionRegistry();
    const testPatterns = [
        'vecthare_visualizer_test_',
        '__vecthare_test_',
        'vecthare_test_',
    ];

    const cleaned = registry.filter(id => {
        if (!id) return false;
        // Check if this is a test collection
        for (const pattern of testPatterns) {
            if (id.includes(pattern)) {
                vhLog(`VectHare: Removing test collection from registry: ${id}`);
                return false;
            }
        }
        return true;
    });

    const removed = registry.length - cleaned.length;
    if (removed > 0) {
        vecthareState().registry = cleaned;
        vhLog(`VectHare: Cleaned ${removed} test collection entries from registry`);
        persistVectHareStore(); // Persist to collections.json
    }
    return removed;
}

// parseCollectionId is now imported from collection-ids.js

/**
 * Gets display name for a collection
 * @param {string} collectionId Collection identifier
 * @param {object} metadata Parsed collection metadata
 * @returns {string} Human-readable name
 */
function getCollectionDisplayName(collectionId, metadata) {
    // Check for custom display name first
    const collectionMeta = getCollectionMeta(collectionId);
    if (collectionMeta.displayName) {
        return collectionMeta.displayName;
    }

    // New opaque chat IDs have no name to decode. Use their verified binding.
    if (isQuarantinedChatCollection(collectionId)) return '💬 Unassigned (preserved)';
    const bound = getBoundChatDetails(collectionId);
    if (bound) return `💬 ${bound.chat}`;

    // Generate name based on type
    const context = getContext();

    switch (metadata.type) {
        case 'chat': {
            // Try to get chat name from ST
            const chatId = metadata.rawId;

            // Check if it's the current chat
            if (context.chatId === chatId && context.name2) {
                return `💬 Chat: ${context.name2}`;
            }

            // Try to find in characters list
            const character = characters.find(c => c.chat === chatId);
            if (character) {
                return `💬 Chat: ${character.name}`;
            }

              // Fallback: extract character name from rawId if it follows pattern: charName_uuid
            // Format: assistant_503c1099-b769-41e7-8e15-0d652cd6d1b4
            const underscoreIndex = chatId.lastIndexOf('_');
            if (underscoreIndex > 0) {
                // Extract everything before the last underscore (the character name)
                const charName = chatId.substring(0, underscoreIndex);
                return `💬 Chat: ${charName}`;
            }

            // Final fallback to just the ID
            return `💬 Chat #${chatId.substring(0, 8)}`;
        }

        case 'file':
            return `📄 File: ${metadata.rawId}`;

        case 'lorebook':
            return `📚 Lorebook: ${metadata.rawId}`;

        default:
            return collectionId;
    }
}

/**
 * Checks if VectHare server plugin is available
 * @returns {Promise<boolean>} True if plugin is available
 */
export async function checkPluginAvailable(forceRefresh = false) {
    if (!forceRefresh && pluginAvailable !== null) {
        return pluginAvailable;
    }

    // Prevent older requests from overwriting newer detection results.
    const checkId = ++pluginAvailabilityCheckId;
    let available = false;

    try {
        const response = await fetch('/api/plugins/similharity/health', {
            method: 'GET',
            headers: getRequestHeaders()
        });

        if (response.ok) {
            const data = await response.json();
            available = data.status === 'ok';

            vhLog(
                `VectHare: Plugin ${available ? 'detected' : 'not found'} (v${data.version || 'unknown'})`
            );
        }
    } catch (error) {
        available = false;
    }

    if (checkId === pluginAvailabilityCheckId) {
        pluginAvailable = available;
    }

    return available;
}

// Cache for plugin collection data
let pluginCollectionData = null;

/**
 * Drops the cached backend inventory and the cached plugin-availability answer,
 * so the next load re-reads both from the backends instead of reusing counts
 * and destinations gathered before a change. Touches no stored state.
 * @param {string} [collectionId] Only forget this identity's cached entries
 */
export function invalidateCollectionInventory(collectionId = null) {
    pluginAvailable = null;
    if (!collectionId || !pluginCollectionData) {
        pluginCollectionData = null;
        return;
    }
    const target = parseRegistryKey(collectionId).collectionId || collectionId;
    for (const key of Object.keys(pluginCollectionData)) {
        if ((parseRegistryKey(key).collectionId || key) === target) {
            delete pluginCollectionData[key];
        }
    }
}

/**
 * Discovers existing collections using server plugin (scans file system)
 * @param {object} settings VectHare settings
 * @returns {Promise<string[]>} Array of discovered collection IDs
 */
/**
 * VH-085: a collection found in a v2 store (listed by the plugin for this user
 * only, from the saved settings in that store) whose location VectHare does not
 * know - e.g. after Start fresh - gets its location recorded, so reads and
 * writes go to that store. Nothing is recorded when VectHare already has a
 * location, or when the same collection was found in more than one place.
 * @param {object[]} listed The plugin's collection list
 */
function recordDiscoveredV2Locations(listed) {
    const byId = new Map();
    for (const item of listed || []) {
        const backend = item?.backend;
        if (!['qdrant', 'milvus'].includes(backend) || typeof item.id !== 'string') continue;
        const key = `${backend}\u0000${item.id}`;
        const list = byId.get(key) || [];
        list.push(item);
        byId.set(key, list);
    }
    let recorded = 0;
    for (const [key, items] of byId) {
        const [backend, id] = key.split('\u0000');
        const v2 = items.filter(item => item.storage?.physical);
        if (v2.length !== 1 || items.length !== 1) continue; // none, or found in several places
        if (getStorageLocator(id)) continue;
        const { physical, dim } = v2[0].storage;
        const locator = locatorForPhysical(id, backend, physical, Number.isSafeInteger(dim) ? dim : null);
        if (!locator || !isV2Layout(backend, locator.layout)) continue;
        setCollectionMeta(id, { storage: locator });
        recorded++;
    }
    if (recorded) {
        persistVectHareStore();
        vhLog(`VectHare: Recorded where ${recorded} collection(s) in shared stores live (found again)`);
    }
}

/**
 * VH-089: Qdrant collections the server lists as collections of their own have
 * no locator when VectHare holds no record for them (made while the
 * multitenancy switch was off, by an older build, or before a Start fresh).
 * Record where they are, so today's switch does not send every lookup and
 * delete to the old shared store.
 */
async function recordDiscoveredOwnQdrantLocations(listed, settings) {
    const counts = new Map();
    for (const item of listed || []) {
        if (item?.backend === 'qdrant' && typeof item.id === 'string') counts.set(item.id, (counts.get(item.id) || 0) + 1);
    }
    const queue = (listed || []).filter(item => item?.backend === 'qdrant' && typeof item.id === 'string' &&
        !item.storage && counts.get(item.id) === 1 && item.id.startsWith('vecthare_') && !getStorageLocator(item.id));
    let recorded = 0;
    const worker = async () => {
        while (queue.length) {
            const item = queue.shift();
            const result = await locateQdrantCollectionByPresence(item.id, { ...settings, vector_backend: 'qdrant' },
                { ownPresent: true }).catch(() => null);
            if (result?.status === 'recorded') recorded++;
        }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (recorded) vhLog(`VectHare: Recorded where ${recorded} Qdrant collection(s) of their own live (found again)`);
}

async function discoverViaPlugin(settings, readOnly = false) {
    try {
        console.debug('🔍 VectHare: Requesting collection discovery from plugin...');

        // Plugin now scans ALL sources, not just the current one
        const response = await fetch(`/api/plugins/similharity/collections`, {
            method: 'GET',
            headers: getRequestHeaders()
        });

        if (!response.ok) {
            console.warn(`⚠️ VectHare: Plugin collections endpoint failed (status: ${response.status})`);
            vhLog('   💡 Make sure the Similharity plugin is installed and running');
            return [];
        }

        const data = await response.json();

        if (data.success && Array.isArray(data.collections)) {
            vhLog(`✅ VectHare: Plugin found ${data.collections.length} collections across all sources`);

            // Log the sources found
            const sourcesSummary = {};
            data.collections.forEach(c => {
                sourcesSummary[c.source] = (sourcesSummary[c.source] || 0) + 1;
            });
            console.debug('   Sources:', Object.entries(sourcesSummary).map(([s, count]) => `${s}: ${count}`).join(', '));

            // Cache the plugin data (includes chunk counts, sources, AND backends)
            // Key format: "backend:source:collectionId" to handle same collection in multiple backends
            pluginCollectionData = {};
            const uniqueKeys = [];

            for (const collection of data.collections) {
                const backend = collection.backend || 'standard';

                // Strip backend prefix from collection.id if it's already there
                // Some backends (like Qdrant) may return IDs with backend prefix
                let collectionId = collection.id;
                if (collectionId.startsWith(`${backend}:`)) {
                    collectionId = collectionId.substring(backend.length + 1);
                    console.debug(`   🔧 Stripped backend prefix from collection ID: ${collection.id} → ${collectionId}`);
                }

                console.debug(`   - ${backend}:${collection.source}:${collectionId} (${collection.chunkCount} chunks)`);

                const collectionData = {
                    chunkCount: collection.chunkCount,
                    source: collection.source,
                    backend: backend,
                    model: collection.model || '',  // Primary model path
                    models: collection.models || [],  // All available models
                    // VH-085: where a v2 collection lives (shared or own v2 store).
                    ...(collection.storage && typeof collection.storage === 'object' ? { storage: collection.storage } : {}),
                };

                // Cache by "backend:source:id" to uniquely identify each collection
                const cacheKey = `${backend}:${collection.source}:${collectionId}`;
                pluginCollectionData[cacheKey] = collectionData;
                uniqueKeys.push(cacheKey);

                // Also cache by sanitized version (for LanceDB lookups)
                const sanitized = collectionId.replace(/[^a-zA-Z0-9_.-]/g, '_');
                if (sanitized !== collectionId) {
                    pluginCollectionData[`${backend}:${collection.source}:${sanitized}`] = collectionData;
                }
            }

            if (readOnly) {
                // Display refresh: report what was found and change nothing.
                console.debug(`   Read-only discovery: ${uniqueKeys.length} collection(s) reported, registry untouched`);
                return uniqueKeys;
            }

            // IMPORTANT: Replace registry with what plugin found (removes stale entries)
            // This ensures the registry matches actual disk state
            const currentRegistry = getCollectionRegistry();
            const pluginKeySet = new Set(uniqueKeys);

            console.debug(`\n📋 VectHare: Updating registry...`);
            console.debug(`   Current registry has ${currentRegistry.length} entries`);
            console.debug(`   Plugin discovered ${uniqueKeys.length} collections`);

            // Migrate old registry entries (source:id or plain id) to new format (backend:source:id)
            // Match them to plugin-discovered collections
            const migratedEntries = [];
            for (const oldKey of [...currentRegistry]) {
                const parsed = parseRegistryKey(oldKey);

                // If already in new format (has backend), keep it
                if (parsed.backend) {
                    continue;
                }

                // Old format - try to find matching collection from plugin
                const collectionId = parsed.collectionId;
                const oldSource = parsed.source;

                // Find all plugin collections matching this ID
                const matchingPluginKeys = uniqueKeys.filter(key => {
                    const parts = key.split(':');
                    const pluginId = parts.slice(2).join(':');  // backend:source:id -> id
                    const pluginSource = parts[1];

                    // Match by ID and source (if source was known)
                    return pluginId === collectionId && (!oldSource || pluginSource === oldSource);
                });

                if (matchingPluginKeys.length > 0) {
                    console.debug(`   🔄 Migrating: ${oldKey} -> ${matchingPluginKeys.join(', ')}`);
                    unregisterCollection(oldKey);
                    migratedEntries.push(oldKey);
                    // Don't register here - will be registered in the main loop below
                } else {
                    console.debug(`   ❓ No matching plugin collection for old entry: ${oldKey}`);
                }
            }

            if (migratedEntries.length > 0) {
                vhLog(`   ✅ Migrated ${migratedEntries.length} old registry entries to new format`);
            }

            // Remove entries that no longer exist on disk. An inventory that
            // never covered a key's backend is not evidence about that key: an
            // unreachable or unconfigured backend reports nothing, and pruning
            // on that basis would silently drop a live collection's record.
            // VH-008: and only a listing the plugin reports complete for that
            // backend (older plugins do not report it: nothing is pruned).
            const incompleteBackends = new Set(data.inventoryReport === 1 && Array.isArray(data.incompleteBackends)
                ? data.incompleteBackends : ['vectra', 'standard', 'lancedb', 'qdrant', 'milvus']);
            if (incompleteBackends.has('vectra')) incompleteBackends.add('standard');
            const inventoriedBackends = new Set(uniqueKeys
                .map(key => parseRegistryKey(key).backend).filter(Boolean)
                .filter(backend => !incompleteBackends.has(backend)));
            const updatedRegistry = getCollectionRegistry();
            const staleEntries = updatedRegistry.filter(key => {
                if (pluginKeySet.has(key)) return false;
                const parsed = parseRegistryKey(key);
                if (parsed.collectionId.startsWith(COLLECTION_PREFIXES.VECTHARE_CHAT)) return false;
                // 9c fix: the plugin's scan lists physical stores by name. A
                // collection kept inside a shared store (Milvus, Qdrant
                // multitenancy old or v2) never appears in it, so its absence
                // there says nothing: such entries were dropped at every start-up
                // (lorebook/document/character collections vanished from RAG).
                const keyBackend = parsed.backend === 'vectra' ? 'standard' : (parsed.backend || settings?.vector_backend);
                if (keyBackend === 'milvus') return false;
                if (keyBackend === 'qdrant' && resolveStorage(parsed.collectionId, settings, 'qdrant').shared) return false;
                // A key without a backend belongs to today's backend (VH-008: pruned
                // only when that backend's listing is complete).
                return parsed.backend ? inventoriedBackends.has(parsed.backend)
                    : inventoriedBackends.has(keyBackend) || (keyBackend === 'standard' && inventoriedBackends.has('vectra'));
            });
            if (staleEntries.length > 0) {
                console.debug(`   🗑️  Removing ${staleEntries.length} stale registry entries:`);
                for (const staleKey of staleEntries) {
                    console.debug(`      - ${staleKey}`);
                    unregisterCollection(staleKey);
                }
            }

            // Register all discovered collections with backend:source:id format
            let newRegistrations = 0;
            for (const key of uniqueKeys) {
                if (!getCollectionRegistry().includes(key)) {
                    newRegistrations++;
                    console.debug(`   ➕ Registering: ${key}`);
                } else {
                    console.debug(`   ⏭️  Already registered: ${key}`);
                }
                registerCollection(key);
            }
            if (newRegistrations > 0) {
                vhLog(`   ✅ Registered ${newRegistrations} new collections`);
            }
            recordDiscoveredV2Locations(data.collections);
            await recordDiscoveredOwnQdrantLocations(data.collections, settings);

            vhLog(`   Final registry size: ${getCollectionRegistry().length}\n`);

            return uniqueKeys;
        }
    } catch (error) {
        console.error('VectHare: Plugin discovery failed:', error);
    }

    return [];
}

/**
 * Probes a collection ID to check if it exists
 * @param {string} collectionId - Collection ID to probe
 * @param {object} settings - VectHare settings
 * @returns {Promise<{exists: boolean, count: number}>}
 */
async function probeCollection(collectionId, settings) {
    // READ-ONLY. This used to ask getSavedHashes(), which goes through ST's
    // native list endpoint - and listing a Vectra collection that does not
    // exist CREATES it, so probing for a collection manufactured the very
    // thing it was looking for. The explicit existence check never creates
    // anything, and a count is only read once existence is confirmed.
    try {
        const verified = await verifyPhysicalCollectionExistence(collectionId, settings, {
            backend: settings.vector_backend,
            source: settings.source,
        });
        if (verified.existence !== 'present') return { exists: false, count: 0 };
        if (Number.isSafeInteger(verified.count) && verified.countTrusted) {
            return { exists: true, count: verified.count };
        }
        const hashes = await getSavedHashes(collectionId, settings);
        return { exists: true, count: Array.isArray(hashes) ? hashes.length : 0 };
    } catch (error) {
        console.debug(`VectHare: Could not probe ${collectionId}: ${error.message}`);
    }
    return { exists: false, count: 0 };
}

/**
 * Discovers existing collections by probing the registry and known patterns
 * Without the plugin, we can't scan the filesystem directly, so we:
 * 1. Check all collections already in the registry (may have been created before)
 * 2. Probe for current chat's collection
 * 3. Probe for collections based on known character names
 *
 * @param {object} settings VectHare settings
 * @returns {Promise<string[]>} Array of discovered collection IDs
 */
async function discoverViaFallback(settings, readOnly = false) {
    const context = getContext();
    const discovered = [];
    const probed = new Set();

    vhLog('VectHare: Running fallback discovery (no plugin)...');

    // 1. Validate existing registry entries - remove stale ones
    const registry = getCollectionRegistry();
    const validRegistryEntries = [];

    for (const registryKey of [...registry]) {
        if (probed.has(registryKey)) continue;
        probed.add(registryKey);

        // Parse the registry key to get the actual collection ID
        const parsed = parseRegistryKey(registryKey);
        const collectionId = parsed.collectionId;

        const result = await probeCollection(collectionId, settings);
        if (result.exists) {
            validRegistryEntries.push(registryKey);
            if (!discovered.includes(registryKey)) {
                discovered.push(registryKey);
            }
            vhLog(`VectHare: Verified registry entry: ${collectionId} (${result.count} chunks)`);
        } else if (!readOnly && !collectionId.startsWith(COLLECTION_PREFIXES.VECTHARE_CHAT)) {
            // Chat collections may be on an unavailable backend. Never prune
            // their registry entries on an inconclusive read. A display
            // refresh prunes nothing at all.
            unregisterCollection(registryKey);
            vhLog(`VectHare: Removed stale registry entry: ${registryKey}`);
        }
    }

    // 2. Probe for current chat's collection (both formats)
    if (context.chatId) {
        // New format: vecthare_chat_{charName}_{uuid}
        const newFormatId = getChatCollectionId();
        if (newFormatId && !probed.has(newFormatId)) {
            probed.add(newFormatId);
            const result = await probeCollection(newFormatId, settings);
            if (result.exists) {
                if (!readOnly) registerCollection(newFormatId);
                discovered.push(newFormatId);
                vhLog(`VectHare: Discovered current chat collection: ${newFormatId} (${result.count} chunks)`);
            }
        }

        // Legacy format: vecthare_chat_{chatId}
        const legacyFormatId = getLegacyChatCollectionId(context.chatId);
        if (legacyFormatId && !probed.has(legacyFormatId)) {
            probed.add(legacyFormatId);
            const result = await probeCollection(legacyFormatId, settings);
            if (result.exists) {
                if (!readOnly) registerCollection(legacyFormatId);
                discovered.push(legacyFormatId);
                vhLog(`VectHare: Discovered legacy chat collection: ${legacyFormatId} (${result.count} chunks)`);
            }
        }
    }

    // 3. Probe for character-based collections
    for (const char of characters) {
        if (!char.name) continue;

        const sanitizedName = char.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').substring(0, 30);

        // VectHare character collection format
        const charCollectionId = `${COLLECTION_PREFIXES.VECTHARE_CHARACTER}${sanitizedName}`;
        if (!probed.has(charCollectionId)) {
            probed.add(charCollectionId);
            const result = await probeCollection(charCollectionId, settings);
            if (result.exists) {
                if (!readOnly) registerCollection(charCollectionId);
                discovered.push(charCollectionId);
                vhLog(`VectHare: Discovered character collection: ${charCollectionId} (${result.count} chunks)`);
            }
        }
    }

    // 4. Probe for common content type patterns that might exist
    const contentPatterns = [
        // Lorebook patterns
        `${COLLECTION_PREFIXES.VECTHARE_LOREBOOK}`,
        // Document patterns
        `${COLLECTION_PREFIXES.VECTHARE_DOCUMENT}`,
        // File patterns (legacy)
        `${COLLECTION_PREFIXES.FILE}`,
    ];

    // Note: Without filesystem access, we can't discover collections with unknown IDs
    // The registry is our primary source of truth for non-current-chat collections

    vhLog(`VectHare: Fallback discovery complete. Found ${discovered.length} collections.`);
    return discovered;
}

/**
 * Discovers existing collections (uses plugin if available, fallback otherwise)
 * @param {object} settings VectHare settings
 * @returns {Promise<string[]>} Array of discovered collection IDs
 */
export async function discoverExistingCollections(settings, options = {}) {
    const hasPlugin = await checkPluginAvailable();

    if (hasPlugin) {
        vhLog('VectHare: Using plugin for collection discovery');
        return await discoverViaPlugin(settings, options.readOnly === true);
    } else {
        vhLog('VectHare: Plugin not available, using fallback discovery');
        return await discoverViaFallback(settings, options.readOnly === true);
    }
}

/**
 * SINGLE SOURCE OF TRUTH: Check if a specific chat has vectors
 * This runs discovery if needed and checks all possible locations
 * @param {object} settings VectHare settings
 * @param {string} [overrideChatId] Optional chat ID override
 * @param {string} [overrideUUID] Optional UUID override
 * @returns {Promise<{hasVectors: boolean, collectionId: string|null, chunkCount: number}>}
 */
export async function doesChatHaveVectors(settings, overrideChatId, overrideUUID) {
    // A foreign chat override must never silently fall back to this chat.
    // The UUID override is intentionally not used to infer ownership.
    const currentChat = getContext().chatId;
    const foreign = overrideChatId && String(overrideChatId).replace(/\.jsonl$/i, '') !==
        String(currentChat ?? '').replace(/\.jsonl$/i, '');
    const collectionId = foreign ? peekBoundCollectionIdForChat(overrideChatId) : peekChatCollectionId();
    if (!collectionId || isQuarantinedChatCollection(collectionId)) {
        return { hasVectors: false, collectionId: null, registryKey: null, chunkCount: 0, allMatches: [] };
    }
    // VH-052: vectors on another backend/server still count, so Vectorize asks
    // to re-vectorize (a new collection here) instead of starting a first run
    // on a collection id whose saved settings are elsewhere.
    if (!foreign) {
        const { collectionLivesElsewhere } = await import('./backend-elsewhere.js');
        if (collectionLivesElsewhere(collectionId, settings).length) {
            return { hasVectors: true, collectionId, registryKey: null, chunkCount: 0, allMatches: [], elsewhere: true };
        }
    }
    await discoverExistingCollections(settings);
    const matches = getCollectionRegistry().filter(key =>
        parseRegistryKey(key).collectionId === collectionId);
    const candidates = [];
    for (const key of matches) {
        const parsed = parseRegistryKey(key);
        let chunkCount = pluginCollectionData?.[key]?.chunkCount || 0;
        try {
            // Only count a collection the backend confirms is there. Counting
            // first would create a missing Vectra index through ST's native
            // list endpoint.
            if (!chunkCount) {
                const destinationSettings = {
                    ...settings,
                    vector_backend: parsed.backend || settings.vector_backend,
                    source: parsed.source || settings.source,
                };
                const verified = await verifyPhysicalCollectionExistence(collectionId,
                    destinationSettings, {
                        backend: destinationSettings.vector_backend,
                        source: destinationSettings.source,
                    });
                if (verified.existence !== 'present') continue;
                chunkCount = Number.isSafeInteger(verified.count) && verified.countTrusted
                    ? verified.count
                    : (await getSavedHashes(collectionId, destinationSettings)).length;
            }
        } catch (error) {
            console.debug('VectHare: Unable to confirm chat vector count', error);
            continue;
        }
        if (!chunkCount) continue;
        candidates.push({ collectionId, registryKey: key, chunkCount,
            source: parsed.source || settings.source,
            backend: parsed.backend || settings.vector_backend });
    }
    candidates.sort((a, b) => b.chunkCount - a.chunkCount);
    if (!candidates.length) {
        return { hasVectors: false, collectionId: null, registryKey: null, chunkCount: 0, allMatches: [] };
    }
    return { hasVectors: true, ...candidates[0], allMatches: candidates };
}

/**
 * Loads all collections with metadata
 * @param {object} settings VectHare settings
 * @param {boolean} autoDiscover If true, attempts to discover unregistered collections
 * @returns {Promise<object[]>} Array of collection objects
 */
/**
 * VH-064: recognises collections made by SillyTavern's own Vector Storage
 * extension, by shape, so the Browser can label them "SillyTavern built-in
 * vectors" instead of "SillyTavern itself or another extension".
 *
 * SillyTavern keeps its vectors in its own storage (VectHare's Standard
 * backend) and names them:
 *   - files and Data Bank attachments: file_<number>
 *   - World Info: world_<number>
 *   - chats: the chat's own id, which carries SillyTavern's date stamp
 *     ("2025-11-18@12h30m05s", or the older "2025-11-18 @12h 30m 05s 123ms").
 * Only collections with no VectHare marker are passed in. Anything else
 * (another backend, another extension's prefix, a renamed chat) answers null
 * and keeps the general wording.
 *
 * @param {string} collectionId Bare collection identifier
 * @param {string} backend Backend the row was found in
 * @returns {'file'|'world-info'|'chat'|null}
 */
export function sillyTavernBuiltInKind(collectionId, backend) {
    if (!['standard', 'vectra'].includes(String(backend || 'standard'))) return null;
    const id = String(collectionId || '');
    if (/^file_-?\d+$/.test(id)) return 'file';
    if (/^world_-?\d+$/.test(id)) return 'world-info';
    if (/\d{4}-\d{1,2}-\d{1,2}\s?@\s?\d{1,2}h\s?\d{1,2}m\s?\d{1,2}s/.test(id)) return 'chat';
    return null;
}

/**
 * Establishes whether a listed identity is backed by a real record in
 * VectHare's own metadata file, and whether that record is identifiably
 * VectHare's. Nothing here reads or trusts the backend: a collection folder,
 * a discovered collection name, a plugin cache entry or another extension's
 * collection is NOT a VectHare metadata record.
 *
 * Ownership evidence, any one of which is sufficient:
 *   - the collection ID carries a VectHare collection prefix;
 *   - the record carries an initial vectorization config (VectHare-authored);
 *   - VectHare holds a chat binding for the identity.
 *
 * @param {string} collectionId Bare collection identifier
 * @param {string} registryKey Key the row was listed under
 * @returns {{hasRecord: boolean, recordKey: string|null, fieldCount: number,
 *            owned: boolean, reason: string}}
 */
function validateMetadataRecordIdentity(collectionId, registryKey) {
    const stored = getStoredCollectionRecord(registryKey) || getStoredCollectionRecord(collectionId);
    const bound = Boolean(getBoundChatDetails(registryKey) || getBoundChatDetails(collectionId));
    // An entry present in the collections map whose value is not a readable
    // record: the record is broken, which is not the same as having no record.
    const brokenKey = !stored &&
        (findStoredCollectionKey(registryKey) || findStoredCollectionKey(collectionId));
    if (brokenKey) {
        return {
            hasRecord: true, recordKey: brokenKey, recordSource: 'collections (unreadable record)',
            fieldCount: 0, malformed: true, owned: false, foreign: false,
            reason: 'VectHare\'s metadata file holds an entry for this identity, but it is not a ' +
                'readable record.',
        };
    }
    // Both the collections map and the chat binding store live in VectHare's
    // own metadata file. A binding never creates a row of its own (every chat
    // VectHare has seen has one), but for an identity that is already listed it
    // is a real, identifiable record for that identity.
    const prefixed = Object.values(COLLECTION_PREFIXES).some(prefix =>
        typeof prefix === 'string' && prefix.startsWith('vecthare_') && collectionId.startsWith(prefix));
    const hasOwnConfig = Boolean(stored?.record?.initialVectorization);

    if (!stored && !bound) {
        return {
            hasRecord: false, recordKey: null, recordSource: 'none', fieldCount: 0,
            malformed: false,
            // Ownership is judged the same way with or without a record: a
            // VectHare-prefixed name is VectHare's own. Reporting a prefixed
            // collection as unowned here made a legitimate VectHare collection
            // with no metadata record undeletable.
            owned: prefixed,
            // Foreignness is a property of the identity, not of having a
            // record: an entry with NO record and no VectHare marker is as
            // much "not VectHare's" as one with a record, and must withhold
            // the same actions. Reporting it as owned here is what let the
            // Browser offer a Delete Collection the core then refused.
            foreign: !prefixed && !hasOwnConfig,
            reason: 'VectHare\'s metadata file holds no record for this identity.',
        };
    }
    const owned = prefixed || hasOwnConfig || bound;
    // No VectHare marker of any kind: not a VectHare name, no VectHare-authored
    // configuration and no chat binding. That is a collection belonging to
    // SillyTavern itself or to another extension, which is different from a
    // VectHare collection whose ownership is merely ambiguous.
    const foreign = !prefixed && !hasOwnConfig && !bound;

    return {
        hasRecord: true,
        recordKey: stored ? stored.key : registryKey,
        recordSource: stored ? (bound ? 'collections + chatCollectionBindings' : 'collections')
            : 'chatCollectionBindings',
        fieldCount: stored ? stored.fields.length : 0,
        malformed: false,
        owned,
        foreign,
        reason: owned ? '' : foreign
            ? 'This is not a VectHare collection: its name carries no VectHare marker, VectHare ' +
              'recorded no vectorization configuration for it and no chat is bound to it. It was ' +
              'most likely created by SillyTavern itself or by another extension.'
            : 'A metadata record exists, but nothing identifies this collection as VectHare\'s own.',
    };
}

/**
 * Classifies a browser row from an EXPLICIT backend existence check at the
 * recorded destination. A registry entry, a folder name or a count of zero is
 * never treated as evidence either way, and a failure is never absence.
 *
 * A confirmed absence is only shown as 'metadata-only' when VectHare's own
 * metadata file holds a validated, VectHare-owned record for the identity at a
 * backend-qualified destination. A record that fails validation is never
 * hidden: it is classified 'invalid-metadata' (broken or incomplete record) or
 * 'ownership-unverified' (record exists, ownership not established), stays
 * visible for inspection, and has its actions restricted accordingly.
 *
 * @param {string} collectionId Collection identifier or registry key
 * @param {object} destinationSettings Settings addressing the recorded destination
 * @param {object} location {backend, source, model} actually recorded for the row
 * @param {number} chunkCount Chunks counted, when the count succeeded
 * @param {boolean} countFailed Whether every count attempt failed
 * @param {object} identity Result of validateMetadataRecordIdentity() for the row
 * @param {boolean} destinationQualified Whether {backend, source} came from a record
 * @returns {Promise<{presence: string, detail: string, existence: string, countTrusted: boolean}>}
 *   presence is 'present' | 'empty' | 'count-unverified' | 'metadata-only' |
 *   'invalid-metadata' | 'ownership-unverified' | 'unverified'
 */
async function resolveCollectionPresence(collectionId, destinationSettings, location,
    chunkCount, countFailed, identity = { hasRecord: false, owned: false, reason: '' },
    destinationQualified = false) {
    const verified = await verifyPhysicalCollectionExistence(collectionId, destinationSettings, location);

    if (verified.existence === 'unverified') {
        return {
            presence: 'unverified', existence: 'unverified', countTrusted: false,
            detail: verified.reason ||
                'The recorded destination could not be checked, so nothing is assumed about this collection.',
        };
    }

    if (verified.existence === 'absent') {
        // Source-of-truth requirement: only an actual, validated record in
        // VectHare's metadata file may be presented as Metadata Only. A record
        // that fails validation is still listed, under a state that says so.
        if (identity.malformed) {
            return {
                presence: 'invalid-metadata', existence: 'absent', countTrusted: false,
                detail: identity.reason + ' Nothing exists at the checked destination. The entry is ' +
                    'listed so it can be inspected and cleaned up; its actions are withheld.',
            };
        }
        if (!identity.hasRecord) {
            return {
                presence: 'invalid-metadata', existence: 'absent', countTrusted: false,
                detail: 'Nothing exists at the checked destination, and VectHare\'s metadata file ' +
                    'holds no record for this identity - only its name, from collection discovery. ' +
                    'It is listed for inspection and is not VectHare metadata.',
            };
        }
        if (!destinationQualified) {
            return {
                presence: 'invalid-metadata', existence: 'absent', countTrusted: false,
                detail: 'A VectHare metadata record exists, but it records no backend-qualified ' +
                    'destination, so the destination that was checked is not known to be this ' +
                    'record\'s. Nothing is assumed about its vectors and its actions are withheld.',
            };
        }
        if (!identity.owned) {
            return {
                presence: 'ownership-unverified', existence: 'absent', countTrusted: false,
                detail: identity.reason + ' The record is listed for inspection and its actions ' +
                    'are withheld.',
            };
        }
        return {
            presence: 'metadata-only', existence: 'absent', countTrusted: false,
            detail: 'The physical collection was confirmed absent at its recorded destination. ' +
                'A VectHare metadata record for it still exists.',
        };
    }

    // Confirmed present. Only now does the count mean anything.
    if (countFailed) {
        return {
            presence: 'count-unverified', existence: 'present', countTrusted: false,
            detail: 'The physical collection exists at its recorded destination, but its chunk count ' +
                'could not be trusted.',
        };
    }
    if (chunkCount > 0) {
        return { presence: 'present', existence: 'present', countTrusted: true, detail: '' };
    }
    return {
        presence: 'empty', existence: 'present', countTrusted: true,
        detail: 'The physical collection exists at its recorded destination and has a verified count ' +
            'of zero chunks.',
    };
}

const BROWSER_CHECK_CONCURRENCY = 4;

export async function loadAllCollections(settings, autoDiscover = true, options = {}) {
    console.debug('🐰 VectHare: Loading all collections for Database Browser...');

    // A display refresh (the Database Browser, Resync) must not write to
    // VectHare's metadata document. In read-only mode nothing is cleaned up,
    // migrated, pruned or registered: discovery only reports what the backends
    // hold, and the discovered keys are listed alongside the stored ones.
    const readOnly = options.readOnly === true;
    if (!readOnly) {
        // Clean up registry first (remove nulls and duplicates)
        cleanupCollectionRegistry();
    }

    // Auto-discover existing collections on first load
    let discovered = [];
    if (autoDiscover) {
        discovered = await discoverExistingCollections(settings, { readOnly }) || [];
    }

    const registry = getCollectionRegistry();
    console.debug(`VectHare: Registry contains ${registry.length} collection(s):`, registry);

    // Phase 2: list the union of registered collections and collection
    // identities that exist only in local metadata, so a record whose physical
    // collection is gone stays visible and inspectable. Registered keys come
    // first, so a full backend:source:id key wins over a bare metadata key for
    // the same identity. (Chat bindings are not listed here - every chat
    // VectHare has seen has one; they are shown inside View Metadata.)
    const identityKeys = [];
    const seenIdentities = new Set();
    // The metadata side of this union is VectHare's own metadata file and
    // nothing else. Keys whose value is not a usable record are still listed -
    // broken metadata must stay visible so it can be inspected and cleaned up -
    // but they are classified as invalid, never as Metadata Only.
    const recordKeys = Object.keys(vecthareState().collections || {});
    // In read-only mode the discovered keys were not registered, so they are
    // listed from the inventory instead. They come first: a backend-qualified
    // key beats a bare one for the same identity.
    for (const key of [...(readOnly ? discovered : []), ...registry, ...recordKeys]) {
        if (typeof key !== 'string' || !key) continue;
        const identity = parseRegistryKey(key).collectionId || key;
        if (seenIdentities.has(identity)) continue;
        seenIdentities.add(identity);
        identityKeys.push(key);
    }
    if (identityKeys.length > registry.length) {
        console.debug(`VectHare: ${identityKeys.length - registry.length} collection(s) exist only in VectHare's metadata file`);
    }


    const hasPlugin = pluginAvailable === true;

    // P4: rows are checked 4 at a time instead of one after another. Each row
    // keeps its own existence-first checks; results keep the listing order.
    // S6: report "n of N checked" to a caller that shows progress (Resync).
    let checkedKeys = 0;
    options.onProgress?.({ done: 0, total: identityKeys.length });
    const perKey = await AsyncUtils.parallel(identityKeys.map(registryKey => async () => {
        try {
        const collections = [];
        try {
            // Use unified registry key parser from collection-ids.js
            const parsedKey = parseRegistryKey(registryKey);
            const collectionId = parsedKey.collectionId;
            const registrySource = parsedKey.source;
            const registryBackend = parsedKey.backend;

            vhLog(`VectHare: Loading collection: ${collectionId} (backend: ${registryBackend || 'unknown'}, source: ${registrySource || 'unknown'})`);

            // First check stored metadata for user-defined contentType (authoritative source)
            const storedMeta = getCollectionMeta(registryKey) || getCollectionMeta(collectionId);
            const parsedMeta = parseCollectionId(collectionId);

            // Use stored contentType if available, otherwise fall back to parsed
            const metadata = {
                type: storedMeta.contentType || parsedMeta.type,
                scope: storedMeta.scope || parsedMeta.scope,
                rawId: parsedMeta.rawId,
            };
            vhLog(`VectHare:   Type: ${metadata.type}, Scope: ${metadata.scope}${storedMeta.contentType ? ' (from stored meta)' : ' (parsed from ID)'}`);

            let chunkCount = 0;
            let readFailed = false;
            let hashes = [];
            let source = registrySource || 'unknown';
            let backend = registryBackend || 'standard';
            // True only when {backend, source} came from a record (the registry
            // key's qualification or the plugin's report), never from the
            // defaults above. An absence answer for a guessed destination says
            // nothing about where this record's collection was written.
            let destinationQualified = Boolean(registryBackend && registrySource);
            // Where {backend, source} came from, so the metadata viewer can
            // never present a backend query's answer as a stored field.
            let destinationOrigin = destinationQualified ? 'registry-key' : 'assumed';
            let model = '';
            let models = [];

            // If plugin is available, use chunk count, source, and backend from plugin cache
            // Cache key is "backend:source:collectionId"
            const cacheKey = registryKey;
            if (hasPlugin && pluginCollectionData && pluginCollectionData[cacheKey]) {
                vhLog(`VectHare:   Using plugin mode - getting data from cache`);
                const cacheData = pluginCollectionData[cacheKey];
                source = cacheData.source;
                backend = cacheData.backend;
                models = cacheData.models || [];
                destinationQualified = Boolean(cacheData.backend && cacheData.source);
                destinationOrigin = destinationQualified ? 'backend-query' : 'assumed';

                // Check if user has a preferred model saved
                const collectionMeta = getCollectionMeta(registryKey);
                const preferredModel = collectionMeta?.preferredModel;

                if (preferredModel !== undefined && models.some(m => m.path === preferredModel)) {
                    // User has a valid preferred model
                    model = preferredModel;
                    const modelInfo = models.find(m => m.path === preferredModel);
                    chunkCount = modelInfo?.chunkCount || 0;
                    vhLog(`VectHare:   Using user's preferred model: ${model}`);
                } else {
                    // Use plugin's default (most chunks)
                    model = cacheData.model || '';
                    chunkCount = cacheData.chunkCount || 0;
                }

                vhLog(`VectHare:   Plugin reported ${chunkCount} chunks (backend: ${backend}, source: ${source}, models: ${models.length})`);
            } else {
                // Fallback mode: the inventory has nothing for this identity, so
                // the backend it lives on is unknown.
                //
                // This used to count it with getSavedHashes() straight away.
                // That goes through ST's native list endpoint, which CREATES a
                // Vectra index that does not exist - so merely opening the
                // Database Browser materialised an empty collection for every
                // listed-but-missing identity, turning metadata-only rows into
                // real empty collections and recreating deleted ones on every
                // refresh. Existence is established read-only first, and a
                // count is only read once a destination is confirmed.
                vhLog(`VectHare:   Using fallback mode - checking standard first (read-only)`);
                const candidates = [{ ...settings, vector_backend: 'standard' }];
                if (settings.vector_backend && settings.vector_backend !== 'standard') {
                    candidates.push({ ...settings });
                }
                let located = null;
                let anyVerified = false;
                for (const candidate of candidates) {
                    try {
                        const verified = await verifyPhysicalCollectionExistence(collectionId, candidate, {
                            backend: candidate.vector_backend,
                            source: candidate.source,
                        });
                        if (verified.existence === 'unverified') continue;
                        anyVerified = true;
                        if (verified.existence === 'present') { located = { candidate, verified }; break; }
                    } catch (error) {
                        console.debug(`VectHare:   ${candidate.vector_backend} check failed for ${collectionId}: ${error.message}`);
                    }
                }
                if (located) {
                    backend = located.candidate.vector_backend;
                    if (Number.isSafeInteger(located.verified.count) && located.verified.countTrusted) {
                        chunkCount = located.verified.count;
                    } else {
                        try {
                            hashes = await getSavedHashes(collectionId, located.candidate);
                            chunkCount = hashes?.length || 0;
                        } catch (error) {
                            console.warn(`VectHare:   Count failed for ${collectionId}: ${error.message}`);
                            readFailed = true;
                        }
                    }
                    vhLog(`VectHare:   Found ${chunkCount} chunks via ${backend} backend`);
                } else if (anyVerified) {
                    // Confirmed absent everywhere checked: a real answer, and
                    // nothing was created to produce it.
                    chunkCount = 0;
                    vhLog(`VectHare:   Nothing exists for ${collectionId} at the destinations checked`);
                } else {
                    console.warn(`VectHare:   Could not verify any destination for ${collectionId}`);
                    readFailed = true;
                }
            }

            // An entry with local metadata is listed whatever the backend says,
            // with its state established by an explicit existence check at the
            // recorded destination.
            const presenceSettings = { ...settings, vector_backend: backend, source };
            const identity = validateMetadataRecordIdentity(collectionId, registryKey);
            const { presence, detail, existence, countTrusted } = await resolveCollectionPresence(
                collectionId, presenceSettings, { backend, source, model }, chunkCount, readFailed,
                identity, destinationQualified);
            const boundChat = getBoundChatDetails(registryKey) || getBoundChatDetails(collectionId);
            const quarantined = isQuarantinedChatCollection(collectionId);
            const isChatCollection = metadata.scope === 'chat' ||
                collectionId.startsWith('vecthare_chat_');
            // A chat collection with no binding is ambiguous; a collection with
            // no VectHare marker at all is not VectHare's to act on. Both
            // withhold destructive actions - the second is reported as what it
            // is (SillyTavern's own, or another extension's).
            const ownershipUnverified = (isChatCollection && !boundChat) || identity.foreign === true;
            // Ambiguous ownership withholds destructive actions, but it must not
            // mask a confirmed absence or an unverified destination.
            const presenceState = ownershipUnverified && ['present', 'empty', 'count-unverified'].includes(presence)
                ? 'ownership-unverified' : presence;

            const displayName = getCollectionDisplayName(collectionId, metadata);
            vhLog(`VectHare:   Display name: ${displayName}`);

            // Use registryKey (source:id) for internal tracking to keep collections unique
            const enabled = isCollectionEnabled(registryKey);
            // Listing never writes. Creating a metadata record here would make
            // every discovered name - including collections VectHare does not
            // own - look like a VectHare record on the next refresh.

            collections.push({
                id: collectionId,           // Original collection ID (for API calls)
                registryKey: registryKey,   // Full key with source (for internal tracking)
                name: displayName,
                type: metadata.type,
                scope: metadata.scope,
                presence: presenceState,    // present | empty | count-unverified | metadata-only | invalid-metadata | ownership-unverified | unverified
                presenceDetail: detail,
                existence,                  // present | absent | unverified (explicit backend answer)
                countTrusted,
                // Source-of-truth facts about VectHare's own metadata file.
                metadataRecord: {
                    present: identity.hasRecord,
                    key: identity.recordKey,
                    source: identity.recordSource,
                    fieldCount: identity.fieldCount,
                    malformed: identity.malformed === true,
                    ownershipValidated: identity.owned,
                    foreign: identity.foreign === true,
                    // VH-064: SillyTavern's own Vector Storage collection, by shape.
                    sillyTavernBuiltIn: identity.foreign === true
                        ? sillyTavernBuiltInKind(collectionId, backend) : null,
                },
                destinationQualified,
                destinationOrigin,
                boundChat: boundChat ? { owner: boundChat.owner, chat: boundChat.chat } : null,
                quarantined,
                chunkCount: chunkCount,
                enabled: enabled,
                hashes: hashes,
                rawId: metadata.rawId,
                source: source,
                backend: backend,
                model: model,               // Primary model path for vectra lookups
                models: models              // All available models [{name, path, chunkCount}]
            });
            vhLog(`VectHare:   ✓ Added to collections list`);
        } catch (error) {
            console.error(`VectHare: Failed to load collection ${registryKey}`, error);
            console.error(`VectHare:   Error details:`, error.message);
            console.error(`VectHare:   Stack:`, error.stack);
            // Continue loading other collections
        }
        return collections;
        } finally {
            checkedKeys++;
            options.onProgress?.({ done: checkedKeys, total: identityKeys.length });
        }
    }), BROWSER_CHECK_CONCURRENCY);
    const collections = perKey.flat();

    const byPresence = collections.reduce((acc, item) => {
        acc[item.presence] = (acc[item.presence] || 0) + 1;
        return acc;
    }, {});
    vhLog(`\n✅ VectHare: Loaded ${collections.length} collection(s) for Database Browser`, byPresence);
    if (collections.length === 0 && registry.length > 0) {
        console.debug(`⚠️ VectHare: ${registry.length} collections in registry but all are empty!`);
        console.debug(`   💡 Collections need to have vectorized chunks to appear in Database Browser`);
        console.debug(`   💡 Try vectorizing your chat or content first`);
    } else if (collections.length === 0 && registry.length === 0) {
        console.debug(`ℹ️ VectHare: No collections registered yet`);
        console.debug(`   💡 Collections are created when you vectorize chat messages or documents`);
    }

    return collections;
}

// Re-export from collection-metadata.js for backwards compatibility
export { setCollectionEnabled, isCollectionEnabled } from './collection-metadata.js';

/**
 * Loads chunks for a specific collection
 * @param {string} collectionId Collection identifier
 * @param {object} settings VectHare settings
 * @returns {Promise<object[]>} Array of chunk objects
 */
export async function loadCollectionChunks(collectionId, settings) {
    const context = getContext();
    const result = await getSavedHashes(collectionId, settings, true); // includeMetadata = true

    vhLog(`VectHare DEBUG: loadCollectionChunks result type:`, Array.isArray(result) ? 'array' : 'object');
    if (!Array.isArray(result)) {
        vhLog(`VectHare DEBUG: result.metadata length:`, result.metadata?.length);
        if (result.metadata?.length > 0) {
            vhLog(`VectHare DEBUG: First item metadata:`, result.metadata[0]);
        }
    }

    // Handle both old format (array) and new format (object with hashes + metadata)
    const hashes = Array.isArray(result) ? result : result.hashes;
    const metadataArray = result.metadata || [];

    if (hashes.length === 0) {
        return [];
    }

    const chunks = [];
    const collectionMetadata = parseCollectionId(collectionId);

    // For chat collections, we can get text from chat messages
    if (collectionMetadata.type === 'chat' && context.chatId === collectionMetadata.rawId) {
        const chat = context.chat;

        for (let i = 0; i < hashes.length; i++) {
            const hash = hashes[i];
            const dbMetadata = metadataArray[i] || {};

            // Find message by hash
            const message = chat.find(msg => {
                if (!msg.mes || msg.is_system) return false;
                const msgText = substituteParams(msg.mes);
                return getStringHash(msgText) === hash;
            });

            if (message) {
                chunks.push({
                    text: substituteParams(message.mes),
                    hash: hash,
                    index: chat.indexOf(message),
                    metadata: {
                        messageId: chat.indexOf(message),
                        source: 'chat',
                        // Include keywords and other metadata from DB
                        keywords: dbMetadata.keywords || [],
                        ...dbMetadata
                    }
                });
            }
        }
    } else {
        // For other collection types or inactive chats, text is stored in the vector backend
        // and retrieved via the chunks visualizer's query functionality
        console.warn(`VectHare: Cannot load chunk text for non-active collection: ${collectionId}`);

        // Return minimal data with metadata
        for (let i = 0; i < hashes.length; i++) {
            const hash = hashes[i];
            const dbMetadata = metadataArray[i] || {};

            chunks.push({
                text: dbMetadata.text || '(Text not available - collection not active)',
                hash: hash,
                index: -1,
                metadata: {
                    source: collectionMetadata.type,
                    keywords: dbMetadata.keywords || [],
                    ...dbMetadata
                }
            });
        }
    }

    vhLog(`VectHare: Loaded ${chunks.length} chunks for ${collectionId}`);
    return chunks;
}

// Re-export chunk metadata functions from collection-metadata.js for backwards compatibility
export { getChunkMetadata, saveChunkMetadata, deleteChunkMetadata } from './collection-metadata.js';
