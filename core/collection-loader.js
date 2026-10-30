import {withCrossTabMutationLock} from '../utils/e03-mutation-lock.js';
import { guardedVectorFetch as fetch } from '../utils/e02-vector-request-gateway.js';
import {getBackendForCollection} from '../backends/backend-manager.js';
import {inspectAdapterInventory} from '../utils/c11-adapter-inventory.js';
import {withCollectionLock} from '../utils/keyed-mutex.js';
import {guardDelete} from './destructive-safety.js';
import {deleteCollectionSafely, recoverTombstones as inspectDeletionTombstones} from '../utils/c01-deletion.js';
import {hasVerifiedCapability} from '../utils/backend-contracts.js';
/**
 * ============================================================================
 * VECTHARE COLLECTION LOADER
 * ============================================================================
 * Data access layer for managing vector collections and chunks
 *
 * @author Coneja Chibi
 * @version 2.2.0-alpha
 * ============================================================================
 */

import { extension_settings } from '../../../../extensions.js';
import { getContext } from '../../../../extensions.js';
import { characters, substituteParams, getRequestHeaders, saveSettingsDebounced } from '../../../../../script.js';
import { getSavedHashes, queryCollection } from './core-vector-api.js';
import { getStringHash } from '../../../../utils.js';
import {
    isCollectionEnabled,
    setCollectionEnabled,
    getChunkMetadata,
    saveChunkMetadata,
    deleteChunkMetadata,
    deleteCollectionMeta,
    ensureCollectionMeta,
    getCollectionMeta,
} from './collection-metadata.js';
import { purgeVectorIndex } from './core-vector-api.js';
import { isGeneratedDiagnosticCollectionId } from './destructive-safety.js';
// Import from collection-ids.js - single source of truth for collection ID operations
import {
    getChatUUID,
    buildChatCollectionId as getChatCollectionId,
    buildLegacyChatCollectionId as getLegacyChatCollectionId,
    parseCollectionId,
    parseRegistryKey,
    resolveCollectionKey,
    parseCollectionKey,
    COLLECTION_PREFIXES,
} from './collection-ids.js';

// Current discovery result only. Never pin a failed health check forever:
// the plugin can start, stop or restart while SillyTavern remains open.
let pluginAvailable = null;
// Only the most recently started discovery may publish its health/catalogue.
let discoveryEpoch = 0;

/**
 * Gets or initializes the collection registry
 * @returns {string[]} Array of collection IDs
 */
export function getCollectionRegistry() {
    if (!extension_settings.vecthare.vecthare_collection_registry) {
        extension_settings.vecthare.vecthare_collection_registry = [];
    }
    return extension_settings.vecthare.vecthare_collection_registry;
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
    if (!registry.includes(collectionId)) {
        registry.push(collectionId);
        console.log(`VectHare: Registered collection: ${collectionId}`);
        saveSettingsDebounced(); // Persist to disk!
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
        console.log(`VectHare: Unregistered collection: ${collectionId}`);
        saveSettingsDebounced(); // Persist to disk!
    } else {
        console.log(`VectHare: Collection not found in registry: ${collectionId}`);
    }
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
export async function deleteCollection(collectionId, settings, registryKey = null) {
    const registry=getCollectionRegistry();
    const resolved=resolveCollectionKey(registryKey || collectionId,{registry});
    const blocked=reason=>({success:false,status:'blocked',errors:[reason],vectorsDeleted:false,registryDeleted:false,metadataDeleted:false,requiresReconciliation:true});
    if (resolved.status!=='unique') return blocked(`Collection deletion blocked: ${resolved.status} qualified ownership`);
    const target=parseCollectionKey(resolved.key);
    if (!target || target.collectionId!==collectionId) return blocked('Collection identity mismatch');
    // Never route a qualified collection through a different physical backend or
    // embedding tenant provided by stale browser state.
    if ((settings?.vector_backend || 'standard')!==target.backend || settings?.source!==target.source)
        return blocked('Backend/source mismatch: deletion requires the exact qualified target');
    const capabilityVerified=['purgeAcknowledgement','completeInventory','tenantFilter','count']
        .every(cap=>hasVerifiedCapability(target.backend,cap));
    const ext=extension_settings.vecthare;
    const store={registry,collections:ext.collections,
        tombstones:(ext.vecthare_delete_tombstones ||= {}),
        recordMetadata:ext.vecthare_chunk_meta_by_collection,chatCollectionPolicies:ext.chatCollectionPolicies};
    const result=await deleteCollectionSafely({
        mutationLock:withCrossTabMutationLock,
        key:resolved.key,store,contractVerified:capabilityVerified,
        inventory:async key=>{
            // Only reached if independently verified capabilities are enabled.
            // A plugin response without explicit scope and end evidence stays partial.
            try {
                const backend=await getBackendForCollection(target.backend,settings);
                return await inspectAdapterInventory({key,adapter:backend,settings});
            } catch (_) {
                return {status:'unavailable',complete:false,scope:key,errors:['adapter-inventory-unavailable']};
            }
        },
        // No pinned provider currently proves that a debounced ST save reached
        // durable storage. Do not issue a purge based on that assumption.
        persist:async()=>{saveSettingsDebounced();return false;},
        purge:async()=>({status:'unverified'}),
        verifyEmpty:async()=>({status:'unavailable',complete:false}),
        protectedCollection:ext.collections?.[resolved.key]?.protected===true,
    });
    return {success:result.success===true,status:result.status,
        errors:result.success?[]:[result.reason],vectorsDeleted:result.success===true,
        registryDeleted:result.success===true,metadataDeleted:result.success===true,
        requiresReconciliation:result.requiresReconciliation===true};
}

/** C01 recovery discovery: show tombstones on the next load, never auto-purge. */
export function getPendingCollectionDeletions() {
    return inspectDeletionTombstones({tombstones:extension_settings?.vecthare?.vecthare_delete_tombstones});
}

/**
 * Clears the entire registry (useful for debugging/reset)
 */
export function clearCollectionRegistry() {
    extension_settings.vecthare.vecthare_collection_registry = [];
    console.log('VectHare: Cleared collection registry');
    saveSettingsDebounced(); // Persist to disk!
}

/**
 * Cleans up registry by removing null entries and duplicates
 */
export function cleanupCollectionRegistry() {
    const registry = getCollectionRegistry();
    const cleaned = [...new Set(registry.filter(id => id != null && id !== ''))];
    extension_settings.vecthare.vecthare_collection_registry = cleaned;
    const removed = registry.length - cleaned.length;
    if (removed > 0) {
        console.log(`VectHare: Cleaned registry - removed ${removed} invalid/duplicate entries`);
        saveSettingsDebounced(); // Persist to disk!
    }
    return removed;
}

/**
 * Cleans up test collections from registry (visualizer/production tests)
 * Call this to remove ghost test entries that weren't properly cleaned up
 * @returns {number} Number of test entries removed
 */
/**
 * Marks a collection as created by the diagnostic suite. Only explicitly
 * registered test collections can be removed by automatic registry cleanup.
 * A collection merely containing "test" in its user-controlled ID is not
 * proof of ownership.
 */
export function markDiagnosticTestCollection(collectionId) {
    if (!isGeneratedDiagnosticCollectionId(collectionId)) {
        throw new Error(`Unrecognized diagnostic collection ID: ${collectionId}`);
    }
    const settings = extension_settings.vecthare;
    const verified = Array.isArray(settings.vecthare_diagnostic_test_ids)
        ? settings.vecthare_diagnostic_test_ids : [];
    if (!verified.includes(collectionId)) {
        settings.vecthare_diagnostic_test_ids = [...verified, collectionId];
        saveSettingsDebounced();
    }
}

/**
 * Clean only entries demonstrably registered by our diagnostics. Legacy
 * prefix-like IDs without a tracking marker are preserved for manual review.
 * This only changes registry entries: it never claims to purge backend data.
 */
export function cleanupTestCollections() {
    const registry = getCollectionRegistry();
    const settings = extension_settings.vecthare;
    const tracked = new Set(Array.isArray(settings.vecthare_diagnostic_test_ids)
        ? settings.vecthare_diagnostic_test_ids : []);
    const cleaned = registry.filter(key => {
        const { collectionId } = parseRegistryKey(key);
        const owned = tracked.has(collectionId) && isGeneratedDiagnosticCollectionId(collectionId);
        if (owned) {
            console.log(`VectHare: Removing verified diagnostic collection from registry: ${key}`);
        }
        return !owned;
    });
    const removed = registry.length - cleaned.length;
    // Prune markers for absent test entries too, so these cannot accumulate.
    const remainingIds = new Set(cleaned.map(key => parseRegistryKey(key).collectionId));
    const remainingTracked = [...tracked].filter(id =>
        isGeneratedDiagnosticCollectionId(id) && remainingIds.has(id));
    if (removed > 0 || remainingTracked.length !== tracked.size) {
        settings.vecthare_collection_registry = cleaned;
        settings.vecthare_diagnostic_test_ids = remainingTracked;
        saveSettingsDebounced();
    }
    if (removed) console.log(`VectHare: Cleaned ${removed} verified diagnostic registry entries`);
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
async function checkPluginAvailable(epoch) {
    let available = false;
    try {
        const response = await fetch('/api/plugins/similharity/health', {
            method: 'GET',
            headers: getRequestHeaders()
        });

        if (response.ok) {
            const data = await response.json();
            available = data.status === 'ok';
            console.log(`VectHare: Plugin ${available ? 'detected' : 'not found'} (v${data.version || 'unknown'})`);
        } else {
        }
    } catch (error) {
        // Treat network/parse errors as unavailable for this request.
    }

    if (epoch === discoveryEpoch) pluginAvailable = available;
    return available;
}

// Cache for plugin collection data
let pluginCollectionData = null;

/**
 * Discovers existing collections using server plugin (scans file system)
 * @param {object} settings VectHare settings
 * @returns {Promise<string[]>} Array of discovered collection IDs
 */
async function discoverViaPlugin(settings, epoch) {
    // Treat each discovery as a fresh snapshot. On any HTTP, parsing, or
    // network failure a previous count must not look like current evidence.
    pluginCollectionData = null;
    try {
        console.debug('🔍 VectHare: Requesting collection discovery from plugin...');

        // Plugin now scans ALL sources, not just the current one
        const response = await fetch(`/api/plugins/similharity/collections`, {
            method: 'GET',
            headers: getRequestHeaders()
        });

        if (!response.ok) {
            console.warn(`⚠️ VectHare: Plugin collections endpoint failed (status: ${response.status})`);
            console.log('   💡 Make sure the Similharity plugin is installed and running');
            return null; // Catalogue failed; attempt scoped legacy probes.
        }

        const data = await response.json();

        if (data.success && Array.isArray(data.collections)) {
            console.log(`✅ VectHare: Plugin found ${data.collections.length} collections across all sources`);

            // Log the sources found
            const sourcesSummary = {};
            data.collections.forEach(c => {
                sourcesSummary[c.source] = (sourcesSummary[c.source] || 0) + 1;
            });
            console.debug('   Sources:', Object.entries(sourcesSummary).map(([s, count]) => `${s}: ${count}`).join(', '));

            // Cache the plugin data (includes chunk counts, sources, AND backends)
            // Key format: "backend:source:collectionId" to handle same collection in multiple backends
            const freshCollectionData = {};
            const ambiguousKeys = new Set();
            const uniqueKeys = [];

            for (const collection of data.collections) {
                // A plugin catalogue is untrusted/advisory: never guess a
                // missing backend or silently coalesce two physical owners.
                const backend = collection?.backend;
                if (!['standard','vectra','qdrant','milvus','lancedb'].includes(backend) ||
                    typeof collection.id !== 'string' || !collection.id ||
                    typeof collection.source !== 'string' || !collection.source ||
                    // This catalogue is only advisory. A string, negative or
                    // unsafe count must not become a browser row (or corrupt
                    // the total); use a backend-scoped probe instead.
                    !Number.isSafeInteger(collection.chunkCount) || collection.chunkCount < 0 ||
                    (collection.model !== undefined && typeof collection.model !== 'string') ||
                    (collection.models !== undefined && (!Array.isArray(collection.models) ||
                        collection.models.some(model => !model || typeof model.path !== 'string' ||
                            !Number.isSafeInteger(model.chunkCount) || model.chunkCount < 0)))) continue;

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
                    models: collection.models || []  // All available models
                };

                // Cache by "backend:source:id" to uniquely identify each collection
                const cacheKey = `${backend}:${collection.source}:${collectionId}`;
                if (!parseCollectionKey(cacheKey)) continue;
                // An advisory response with duplicate owner keys is ambiguous.
                // Do not let the last row silently win with an arbitrary count.
                if (Object.hasOwn(freshCollectionData, cacheKey)) {
                    delete freshCollectionData[cacheKey];
                    ambiguousKeys.add(cacheKey);
                    continue;
                }
                if (ambiguousKeys.has(cacheKey)) continue;
                freshCollectionData[cacheKey] = collectionData;
                uniqueKeys.push(cacheKey);

            }

            // C04-B/C11-B: plugin discovery is advisory. It is neither an
            // authoritative exhaustive inventory nor ownership proof. Never
            // delete, remap or enable registry entries based on this response.
            // Legacy mappings require reviewed C04 migration with durable backup.
            if (epoch === discoveryEpoch) pluginCollectionData = freshCollectionData;
            console.debug(`VectHare: Discovered ${Object.keys(freshCollectionData).length} candidate collections; registry unchanged pending verification`);

            return {
                keys: uniqueKeys.filter(key => Object.hasOwn(freshCollectionData, key)),
                blockedKeys: [...ambiguousKeys],
                // Only a declared, strictly validated coverage list can
                // suppress extra reads. No field means unknown coverage.
                coverage: data.catalogueComplete === true && data.ownershipVerified === true ? null :
                    (data.catalogueComplete === false && Array.isArray(data.coverage) &&
                     data.coverage.every(value => ['vectra', 'lancedb', 'qdrant', 'milvus', 'standard'].includes(value)))
                        ? data.coverage : [],
                complete: data.catalogueComplete === true && data.ownershipVerified === true,
            };
        }
    } catch (error) {
        console.error('VectHare: Plugin discovery failed:', error);
    }

    // Failed / invalid catalogue is unknown, NOT an authoritative empty list.
    return null;
}

/**
 * Probes a collection ID to check if it exists
 * @param {string} collectionId - Collection ID to probe
 * @param {object} settings - VectHare settings
 * @returns {Promise<{exists: boolean, count: number}>}
 */
async function probeCollection(collectionId, settings) {
    try {
        const hashes = await getSavedHashes(collectionId, settings);
        if (hashes && hashes.length > 0) {
            return { exists: true, count: hashes.length };
        }
    } catch (error) {
        // Collection doesn't exist or error - that's fine
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
async function discoverViaFallback(settings) {
    const context = getContext();
    const discovered = [];
    const probed = new Set();

    console.log('VectHare: Running fallback discovery (no plugin)...');

    // 1. Validate existing registry entries - remove stale ones
    const registry = getCollectionRegistry();
    const validRegistryEntries = [];

    for (const registryKey of [...registry]) {
        if (probed.has(registryKey)) continue;
        probed.add(registryKey);

        // A qualified key is only probed using its exact configured backend
        // and embedding source. A mismatched probe could find a homonymous
        // collection belonging to a completely different owner.
        const qualified = parseCollectionKey(registryKey);
        if (qualified && (qualified.backend !== (settings?.vector_backend || 'standard') ||
            qualified.source !== settings?.source)) continue;
        const parsed = parseRegistryKey(registryKey);
        const collectionId = parsed.collectionId;

        const result = await probeCollection(collectionId, settings);
        if (result.exists) {
            validRegistryEntries.push(registryKey);
            if (!discovered.includes(registryKey)) {
                discovered.push(registryKey);
            }
            console.log(`VectHare: Verified registry entry: ${collectionId} (${result.count} chunks)`);
        } else {
            // Failed/empty probes cannot prove absence. Leave the registry
            // untouched and make the missing result visible to diagnostics.
            console.warn(`VectHare: Registry entry not proven by fallback probe (preserved): ${registryKey}`);
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
                // Discovery is not authorization to create/enable an owner.
                discovered.push(newFormatId);
                console.log(`VectHare: Discovered current chat collection: ${newFormatId} (${result.count} chunks)`);
            }
        }

        // Legacy format: vecthare_chat_{chatId}
        const legacyFormatId = getLegacyChatCollectionId(context.chatId);
        if (legacyFormatId && !probed.has(legacyFormatId)) {
            probed.add(legacyFormatId);
            const result = await probeCollection(legacyFormatId, settings);
            if (result.exists) {
                // Legacy origin IDs remain advisory until owner remapping.
                discovered.push(legacyFormatId);
                console.log(`VectHare: Discovered legacy chat collection: ${legacyFormatId} (${result.count} chunks)`);
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
                discovered.push(charCollectionId);
                console.log(`VectHare: Discovered character collection: ${charCollectionId} (${result.count} chunks)`);
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

    console.log(`VectHare: Fallback discovery complete. Found ${discovered.length} collections.`);
    return discovered;
}

/**
 * The legacy plugin catalogue covers only selected local backends. A healthy
 * response is not evidence that registered remote collections are absent.
 * Supplement only uncovered backend entries already in the user's registry,
 * by reading their physical hashes on the currently selected backend/source.
 * This is advisory discovery, never managed ownership or mutation authority.
 */
async function discoverUncoveredRegisteredCollections(settings, coveredBackends, knownKeys, epoch) {
    const backend = settings?.vector_backend || 'standard';
    const source = settings?.source;
    if (coveredBackends.has(backend)) return [];
    const selected = { ...settings, vector_backend: backend, source };
    const additional = [];
    const seen = new Set(knownKeys);
    for (const key of [...getCollectionRegistry()]) {
        if (epoch !== discoveryEpoch || (settings?.vector_backend || 'standard') !== backend ||
            settings?.source !== source) return [];
        const owner = parseCollectionKey(key);
        if (!owner || owner.backend !== backend || owner.source !== source || seen.has(key)) continue;
        seen.add(key);
        try {
            const hashes = await getSavedHashes(owner.collectionId, selected);
            if (epoch !== discoveryEpoch || (settings?.vector_backend || 'standard') !== backend ||
                settings?.source !== source) return [];
            if (Array.isArray(hashes) && hashes.length > 0) additional.push(key);
        } catch (_) {
            // Unreachable or empty is UNKNOWN, not proof of deletion.
        }
    }
    return additional;
}

/**
 * Discovers existing collections (uses plugin if available, fallback otherwise)
 * @param {object} settings VectHare settings
 * @returns {Promise<string[]>} Array of discovered collection IDs
 */
export async function discoverExistingCollections(settings, {probeUncovered = true} = {}) {
    // A healthy plugin can disappear between calls. No retained discovery
    // results survive a failed health check or an unavailable plugin.
    const epoch = ++discoveryEpoch;
    pluginAvailable = null;
    pluginCollectionData = null;
    const hasPlugin = await checkPluginAvailable(epoch);
    if (epoch !== discoveryEpoch) return [];

    if (hasPlugin) {
        console.log('VectHare: Using plugin for collection discovery');
        const discovered = await discoverViaPlugin(settings, epoch);
        if (epoch !== discoveryEpoch) return [];
        if (discovered !== null) {
            if (discovered.complete) return discovered.keys;
            const extra = probeUncovered ? await discoverUncoveredRegisteredCollections(
                settings, new Set(discovered.coverage), [...discovered.keys, ...discovered.blockedKeys], epoch) : [];
            return epoch === discoveryEpoch ? [...discovered.keys, ...extra] : [];
        }
        console.warn('VectHare: Plugin catalogue unavailable; trying scoped legacy reads');
    } else {
        console.log('VectHare: Plugin not available, using fallback discovery');
    }
    const discovered = await discoverViaFallback(settings);
    return epoch === discoveryEpoch ? discovered : [];
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
    // Snapshot the selected tenant and chat before network reads. A late
    // result for an earlier chat/backend must never trigger an auto-sync UI.
    const selectedBackend = settings?.vector_backend || 'standard';
    const selectedSource = settings?.source;
    const chatId = overrideChatId || getContext().chatId;
    const uuid = overrideUUID || getChatUUID();
    const missing = () => ({hasVectors:false, collectionId:null, registryKey:null, chunkCount:0});
    const stillSelected = () =>
        (settings?.vector_backend || 'standard') === selectedBackend &&
        settings?.source === selectedSource &&
        (overrideChatId || getContext().chatId) === chatId &&
        (overrideUUID || getChatUUID()) === uuid;
    if (!chatId && !uuid) return missing();
    // Chat presence has its own exact-identity physical checks below; avoid
    // probing every registered remote collection on each auto-sync check.
    await discoverExistingCollections(settings, {probeUncovered:false});
    const readEpoch = discoveryEpoch;
    if (!stillSelected()) return missing();
    const registry = getCollectionRegistry();
    const legacyId = chatId ? getLegacyChatCollectionId(chatId) : null;
    const uuidSuffix = uuid ? `_${String(uuid).toLowerCase()}` : null;
    const belongsToChat = id => typeof id === 'string' && (
        (legacyId && id.toLowerCase() === legacyId.toLowerCase()) ||
        // New format is vecthare_chat_<character>_<uuid>. Never match a
        // character name, UUID substring, or a different chat's UUID prefix.
        (uuidSuffix && id.toLowerCase().startsWith(COLLECTION_PREFIXES.VECTHARE_CHAT) &&
            id.toLowerCase().endsWith(uuidSuffix))
    );
    console.log(`VectHare: Checking exact chat identity: ${chatId || '(none)'} / ${uuid || '(none)'}`);

    // Collect ALL matching collections, then pick the best one
    // This handles ghost collections (empty) vs real collections (has chunks)
    const matchingCollections = [];

    for (const registryKey of registry) {
        const parsed = parseRegistryKey(registryKey);
        const collectionId = parsed.collectionId;
        if (!belongsToChat(collectionId)) continue;

        // A collection registered for another backend or embedding source is
        // not evidence that the selected chat has any vectors here.
        const owner = parseCollectionKey(registryKey);
        if (owner && (owner.backend !== selectedBackend ||
            owner.source !== selectedSource)) continue;

        // Local registry entries and the legacy plugin catalogue can survive
        // physical deletion, restart or a backend switch. Confirm presence on
        // the *selected* backend before offering auto-sync/reconnection.
        let hashes;
        try {
            hashes = await getSavedHashes(collectionId, {...settings,vector_backend:selectedBackend,source:selectedSource});
        } catch (error) {
            console.warn(`VectHare: Chat collection ${registryKey} could not be checked: ${error.message}`);
            continue;
        }
        if (!stillSelected() || readEpoch !== discoveryEpoch) return missing();
        if (!Array.isArray(hashes) || hashes.length === 0) continue;
        matchingCollections.push({
            collectionId,
            registryKey,
            chunkCount: hashes.length,
            source: owner?.source || parsed.source || selectedSource || 'unknown',
            backend: owner?.backend || parsed.backend || selectedBackend,
        });
    }

    // If we found matches, return ALL of them sorted by chunk count (best first)
    if (matchingCollections.length > 0) {
        // Sort by chunk count descending
        matchingCollections.sort((a, b) => b.chunkCount - a.chunkCount);

        if (!stillSelected() || readEpoch !== discoveryEpoch) return missing();
        const best = matchingCollections[0];
        console.log(`VectHare: Found ${matchingCollections.length} matching collection(s), best is ${best.collectionId} with ${best.chunkCount} chunks`);

        return {
            hasVectors: true,
            collectionId: best.collectionId,
            registryKey: best.registryKey,
            chunkCount: best.chunkCount,
            allMatches: matchingCollections  // Return ALL matches for user selection
        };
    }

    // Not found in registry - try direct query as last resort
    const newFormatId = getChatCollectionId(uuid);
    const legacyFormatId = getLegacyChatCollectionId(chatId);

    for (const id of [newFormatId, legacyFormatId].filter(Boolean)) {
        try {
            const hashes = await getSavedHashes(id, {...settings,vector_backend:selectedBackend,source:selectedSource});
            if (!stillSelected() || readEpoch !== discoveryEpoch) return missing();
            if (Array.isArray(hashes) && hashes.length > 0) {
                // A hash-only fallback is not proof of managed ownership.
                // Preserve discovery for existing legacy users, but do not
                // silently enroll an unqualified key in the durable registry.
                console.log(`VectHare: Found ${hashes.length} legacy vectors via direct read for ${id}`);
                return {
                    hasVectors: true,
                    collectionId: id,
                    registryKey: id,
                    chunkCount: hashes.length,
                    unregisteredLegacy: true
                };
            }
        } catch (e) {
            // Query failed, continue to next format
        }
    }

    if (!stillSelected() || readEpoch !== discoveryEpoch) return missing();
    console.log('VectHare: No vectors found for current chat');
    return missing();
}

/**
 * Loads all collections with metadata
 * @param {object} settings VectHare settings
 * @param {boolean} autoDiscover If true, attempts to discover unregistered collections
 * @returns {Promise<object[]>} Array of collection objects
 */
export async function loadAllCollections(settings, autoDiscover = true) {
    console.debug('🐰 VectHare: Loading all collections for Database Browser...');

    // Clean up registry first (remove nulls and duplicates)
    cleanupCollectionRegistry();

    // Auto-discover existing collections on first load
    if (autoDiscover) {
        // Every qualified registry row is checked below when absent from the
        // local catalogue; do not duplicate those reads during discovery.
        await discoverExistingCollections(settings, {probeUncovered:false});
    }

    const registry = getCollectionRegistry();
    console.debug(`VectHare: Registry contains ${registry.length} collection(s):`, registry);

    const collections = [];
    const hasPlugin = pluginAvailable === true;

    for (const registryKey of registry) {
        try {
            // Use unified registry key parser from collection-ids.js
            const parsedKey = parseRegistryKey(registryKey);
            const collectionId = parsedKey.collectionId;
            const registrySource = parsedKey.source;
            const registryBackend = parsedKey.backend;

            console.log(`VectHare: Loading collection: ${collectionId} (backend: ${registryBackend || 'unknown'}, source: ${registrySource || 'unknown'})`);

            // First check stored metadata for user-defined contentType (authoritative source)
            const storedMeta = getCollectionMeta(registryKey) || getCollectionMeta(collectionId);
            const parsedMeta = parseCollectionId(collectionId);

            // Use stored contentType if available, otherwise fall back to parsed
            const metadata = {
                type: storedMeta.contentType || parsedMeta.type,
                scope: storedMeta.scope || parsedMeta.scope,
                rawId: parsedMeta.rawId,
            };
            console.log(`VectHare:   Type: ${metadata.type}, Scope: ${metadata.scope}${storedMeta.contentType ? ' (from stored meta)' : ' (parsed from ID)'}`);

            let chunkCount = 0;
            let hashes = [];
            let source = registrySource || 'unknown';
            let backend = registryBackend || 'standard';
            let model = '';
            let models = [];

            // If plugin is available, use chunk count, source, and backend from plugin cache
            // Cache key is "backend:source:collectionId"
            const cacheKey = registryKey;
            if (hasPlugin && pluginCollectionData && pluginCollectionData[cacheKey]) {
                console.log(`VectHare:   Using plugin mode - getting data from cache`);
                const cacheData = pluginCollectionData[cacheKey];
                source = cacheData.source;
                backend = cacheData.backend;
                models = cacheData.models || [];

                // Check if user has a preferred model saved
                const collectionMeta = getCollectionMeta(registryKey);
                const preferredModel = collectionMeta?.preferredModel;

                if (preferredModel !== undefined && models.some(m => m.path === preferredModel)) {
                    // User has a valid preferred model
                    model = preferredModel;
                    const modelInfo = models.find(m => m.path === preferredModel);
                    chunkCount = modelInfo?.chunkCount || 0;
                    console.log(`VectHare:   Using user's preferred model: ${model}`);
                } else {
                    // Use plugin's default (most chunks)
                    model = cacheData.model || '';
                    chunkCount = cacheData.chunkCount || 0;
                }

                console.log(`VectHare:   Plugin reported ${chunkCount} chunks (backend: ${backend}, source: ${source}, models: ${models.length})`);
            } else {
                // Qualified entries must never be probed through another
                // backend/source after a plugin failure or missing catalogue
                // row. That can display another tenant's collection as this one.
                const qualified = parseCollectionKey(registryKey);
                if (qualified) {
                    if (qualified.backend !== (settings?.vector_backend || 'standard') ||
                        qualified.source !== settings?.source) {
                        console.warn(`VectHare: Qualified collection ${registryKey} unverified for current backend/source; skipping`);
                        continue;
                    }
                    try {
                        hashes = await getSavedHashes(collectionId, settings);
                        chunkCount = hashes?.length || 0;
                    } catch (err) {
                        console.warn(`VectHare: Qualified collection ${registryKey} unavailable: ${err.message}`);
                        continue;
                    }
                } else {
                // Only legacy, unqualified registry entries retain the old
                // standard-first compatibility probe. This is display-only,
                // NOT evidence for destructive managed operations.
                console.log(`VectHare:   Using legacy fallback mode - trying standard backend first`);
                const standardSettings = { ...settings, vector_backend: 'standard' };
                try {
                    hashes = await getSavedHashes(collectionId, standardSettings);
                    chunkCount = hashes?.length || 0;
                    console.log(`VectHare:   Found ${chunkCount} hashes via standard backend`);
                } catch (standardError) {
                    // Standard failed, try the configured backend if different
                    if (settings.vector_backend && settings.vector_backend !== 'standard') {
                        console.log(`VectHare:   Standard backend failed, trying ${settings.vector_backend}`);
                        try {
                            hashes = await getSavedHashes(collectionId, settings);
                            chunkCount = hashes?.length || 0;
                            console.log(`VectHare:   Found ${chunkCount} hashes via ${settings.vector_backend}`);
                        } catch (altError) {
                            console.warn(`VectHare:   Both backends failed for ${collectionId}`);
                            chunkCount = 0;
                        }
                    } else {
                        console.warn(`VectHare:   Standard backend failed for ${collectionId}`);
                        chunkCount = 0;
                    }
                }
                }
            }

            // Skip empty collections (no point showing them)
            if (chunkCount === 0) {
                console.debug(`⚠️ VectHare: Skipping empty collection "${collectionId}" (0 chunks)`);
                console.debug(`   💡 This collection exists but has no vectorized data`);
                console.debug(`   💡 To see it in Database Browser, you need to vectorize some content first`);
                continue;
            }

            const displayName = getCollectionDisplayName(collectionId, metadata);
            console.log(`VectHare:   Display name: ${displayName}`);

            // Use registryKey (source:id) for internal tracking to keep collections unique
            const enabled = isCollectionEnabled(registryKey);
            ensureCollectionMeta(registryKey, { scope: metadata.scope });

            collections.push({
                id: collectionId,           // Original collection ID (for API calls)
                registryKey: registryKey,   // Full key with source (for internal tracking)
                name: displayName,
                type: metadata.type,
                scope: metadata.scope,
                chunkCount: chunkCount,
                enabled: enabled,
                hashes: hashes,
                rawId: metadata.rawId,
                source: source,
                backend: backend,
                model: model,               // Primary model path for vectra lookups
                models: models              // All available models [{name, path, chunkCount}]
            });
            console.log(`VectHare:   ✓ Added to collections list`);
        } catch (error) {
            console.error(`VectHare: Failed to load collection ${registryKey}`, error);
            console.error(`VectHare:   Error details:`, error.message);
            console.error(`VectHare:   Stack:`, error.stack);
            // Continue loading other collections
        }
    }

    console.log(`\n✅ VectHare: Loaded ${collections.length} non-empty collections for Database Browser`);
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

    console.log(`VectHare DEBUG: loadCollectionChunks result type:`, Array.isArray(result) ? 'array' : 'object');
    if (!Array.isArray(result)) {
        console.log(`VectHare DEBUG: result.metadata length:`, result.metadata?.length);
        if (result.metadata?.length > 0) {
            console.log(`VectHare DEBUG: First item metadata:`, result.metadata[0]);
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

    console.log(`VectHare: Loaded ${chunks.length} chunks for ${collectionId}`);
    return chunks;
}

// Re-export chunk metadata functions from collection-metadata.js for backwards compatibility
export { getChunkMetadata, saveChunkMetadata, deleteChunkMetadata } from './collection-metadata.js';
