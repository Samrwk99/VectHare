import { vhLog } from '../utils/log.js';
/**
 * VectHare Collection Metadata Manager
 *
 * Manages collection-level metadata in vecthareState().collections
 * This is the "settings layer" - user preferences for collections.
 *
 * Separation of concerns:
 * - collection-loader.js = Discovery & loading (talks to vector backends)
 * - collection-metadata.js = Settings & state (talks to extension_settings)
 */

import { extension_settings, getContext } from '../../../../extensions.js';
// Phase 1: VectHare's own collection state is persisted to collections.json,
// not to SillyTavern's settings. vecthareState() is the working copy.
import { vecthareState, persistVectHareStore } from './vecthare-store.js';
import { isQuarantinedChatCollection, peekChatCollectionId, getBoundChatDetails, getChatOwner, normChat } from './collection-ids.js';
import { getRequestHeaders, saveSettingsDebounced } from '../../../../../script.js';
import { parseRegistryKey } from './collection-ids.js';
import { getModelField, isValidProvider } from './providers.js';
import {
    resolveStorage, getStorageLocator, locatorForPhysical, candidateLocations,
    markStorageConflict, clearStorageConflict, getStorageConflict, StorageConflictError,
    normalizeBackend, bareCollectionId, LOCATED_BACKENDS, QDRANT_LEGACY_MT, MILVUS_LEGACY_SHARED,
    isV2Layout, v2StorageParam, expectedStorageAt, newCollectionLayout, scopedTenancySupported,
    assertStorageWritable,
} from './storage-resolver.js';
import { getCleaningSettings, getActivePatterns } from './text-cleaning.js';
import { textgen_types, textgenerationwebui_settings } from '../../../../textgen-settings.js';
import { oai_settings } from '../../../../openai.js';

// ============================================================================
// COLLECTION METADATA CRUD
// ============================================================================

/**
 * Default metadata for a new collection
 */
const defaultCollectionMeta = {
    enabled: true,
    autoSync: false,  // Per-collection auto-sync for chat vectorization
    scope: 'unknown',
    displayName: null,
    description: '',
    tags: [],
    color: null,
    createdAt: null,
    lastUsed: null,
    queryCount: 0,

    // =========================================================================
    // ACTIVATION TRIGGERS (PRIMARY METHOD - Like Lorebook)
    // =========================================================================
    // Simple keyword-based activation. If ANY trigger matches recent messages,
    // the collection activates. This is the primary, user-friendly method.
    //
    // Priority order:
    // 1. alwaysActive=true → Collection always queries (ignores triggers)
    // 2. triggers[] not empty → Match keywords in recent messages
    // 3. conditions.enabled=true → Advanced rules (secondary method)
    // 4. No triggers + no conditions → Inactive unless forced/locked/always active
    alwaysActive: false,           // If true, ignores triggers and conditions
    lockMode: 'prefer',            // 'prefer' = locks activate here; 'exclusive' = only activate in locked chats/chars
    forceMode: 'normal',           // 'normal' or 'forced' for explicitly pinned collections
    exclusiveWhenActive: false,    // If true, this collection can suppress peers in the same exclusive scope
    exclusiveScope: 'lorebook',    // 'lorebook' or 'all'
    triggers: [],                  // Array of trigger keywords (case-insensitive)
    triggerMatchMode: 'any',       // 'any' = OR logic, 'all' = AND logic
    triggerCaseSensitive: false,   // Case sensitivity for trigger matching
    triggerScanDepth: 5,           // How many recent messages to scan for triggers

    // =========================================================================
    // CONDITIONAL ACTIVATION (ADVANCED METHOD - Secondary)
    // =========================================================================
    // Complex rule-based activation. Only evaluated if triggers don't match
    // or if no triggers are set. Use for sophisticated activation logic.
    conditions: {
        enabled: false,
        logic: 'AND', // 'AND' = all rules must pass, 'OR' = any rule passes
        rules: [],    // Array of condition rules
    },

    // =========================================================================
    // TEMPORAL DECAY (Per-Collection)
    // =========================================================================
    // Controls how older chunks lose relevance over time.
    // Chat collections default to enabled; others default to disabled.
    temporalDecay: {
        enabled: false,           // Enable temporal decay for this collection
        type: 'decay',            // 'decay' (favor recent) or 'nostalgia' (favor old)
        mode: 'exponential',      // 'exponential' or 'linear'
        halfLife: 50,             // Messages until 50% relevance (exponential)
        linearRate: 0.01,         // % per message (linear mode)
        minRelevance: 0.3,        // Never decay below this (0-1) - decay mode only
        maxBoost: 2.0,            // Maximum boost multiplier (1-5) - nostalgia mode only
        sceneAware: false,        // Reset decay at scene boundaries
    },

    // =========================================================================
    // CHUNK GROUPS (Per-Collection)
    // =========================================================================
    // Groups chunks together for collective activation or mutual exclusion.
    // - Inclusive mode: When any member matches, affect other members
    //   - Soft link: Other members get score boost
    //   - Hard link: Other members are force-included
    // - Exclusive mode: Only highest-scoring member passes through
    //   - Mandatory: At least one member MUST be included
    groups: [],  // Array of ChunkGroup objects (see core/chunk-groups.js)

    // =========================================================================
    // PROMPT CONTEXT (Per-Collection)
    // =========================================================================
    // Wraps all chunks from this collection with context/guidance for the AI.
    // Supports {{user}} and {{char}} variables.
    // Example: "Things {{char}} remembers about {{user}}:"
    context: '',      // Natural language context shown before this collection's chunks
    xmlTag: '',       // XML tag to wrap this collection's chunks (e.g., "memories")
};

const defaultChatCollectionPolicy = {
    mode: 'normal', // 'normal', 'prefer_selected', 'only_selected'
    selectedCollections: [],
};

/**
 * Gets default temporal decay settings based on collection type
 * Uses global defaults from settings, with chat collections getting scene-awareness
 * @param {string} collectionType - 'chat', 'lorebook', 'file', 'document', etc.
 * @returns {object} Default decay settings for this type
 */
export function getDefaultDecayForType(collectionType) {
    // Get global defaults from settings
    const globalSettings = extension_settings.vecthare || {};
    const globalEnabled = globalSettings.default_decay_enabled ?? false;
    const globalType = globalSettings.default_decay_type || 'decay';

    const baseDefaults = {
        enabled: globalEnabled,
        type: globalType,
        mode: 'exponential',
        halfLife: 50,
        linearRate: 0.01,
        minRelevance: 0.3,
        maxBoost: 2.0,
        sceneAware: false,
    };

    // Chat collections get scene-awareness by default (if decay is enabled)
    if (collectionType === 'chat') {
        return {
            ...baseDefaults,
            sceneAware: globalEnabled, // Only enable scene-aware if decay is enabled
        };
    }

    return baseDefaults;
}

/**
 * ============================================================================
 * CONDITION TYPES
 * ============================================================================
 *
 * COLLECTION & CHUNK CONDITIONS (11 types):
 * Can be used at both collection-level and chunk-level.
 * Collection-level: Determines if a collection should be queried
 * Chunk-level: Determines if a specific chunk should be included
 *
 * - pattern:          Advanced regex/pattern matching (replaces keyword)
 * - speaker:          Match by who spoke last
 * - characterPresent: Check if specific character(s) spoke recently
 * - messageCount:     Conversation length pacing (eq, gte, lte, between)
 * - emotion:          Hybrid emotion detection (Expressions + patterns)
 * - isGroupChat:      Group vs 1-on-1 chat
 * - generationType:   Normal, swipe, continue, regenerate, impersonate
 * - lorebookActive:   Specific lorebook entries are triggered
 * - swipeCount:       Number of swipes on last message
 * - timeOfDay:        Real-world time window (supports midnight crossing)
 * - randomChance:     Probabilistic activation (0-100%)
 *
 * CHUNK-ONLY FEATURES:
 * Only make sense at chunk-level, not collection-level.
 *
 * - links:            Hard/soft links to other chunks
 *                     - hard: Target chunk MUST appear if source appears
 *                     - soft: Target chunk gets score boost if source appears
 *                     Each chunk defines its own links independently.
 *                     For two-way linking, add links on both chunks.
 * - scoreThreshold:   Per-chunk minimum similarity score override
 * - recency:          Filter by message age (messagesAgo)
 * - frequency:        Limit activations (maxActivations, cooldownMessages)
 *
 * EMOTION DETECTION:
 * Uses hybrid approach with Character Expressions extension + keyword/regex patterns.
 * Detection methods: 'auto' (recommended), 'expressions', 'patterns', 'both'
 * - Character Expressions: Uses sprite-based emotion from last message
 * - Pattern matching: Keywords + regex patterns (wrapped in forward slashes)
 * Call getExpressionsExtensionStatus() to check if extension is available.
 * See: conditional-activation.js for full implementation.
 * ============================================================================
 */

/**
 * Condition rule structure (for reference):
 * {
 *     type: 'keyword',           // Condition type
 *     negate: false,             // Invert the result
 *     settings: {                // Type-specific settings
 *         values: ['combat'],
 *         matchMode: 'contains', // contains, exact, startsWith, endsWith
 *         caseSensitive: false,
 *     }
 * }
 */

/**
 * Ensures the collections object exists in extension_settings
 */
function ensureCollectionsObject() {
    // VEC-26: Add proper null checks to prevent crashes
    if (!extension_settings) {
        console.error('VectHare: extension_settings is null/undefined - cannot access collections');
        return false;
    }
    if (!extension_settings.vecthare) {
        extension_settings.vecthare = {};
    }
    if (!vecthareState().collections) {
        vecthareState().collections = {};
    }
    return true;
}


/**
 * Finds the actual extension_settings key a collection's metadata is stored under.
 * Supports bare IDs, full registry keys (backend:source:id), and legacy keys (source:id).
 * @param {string} collectionId Collection identifier in any supported key form
 * @returns {string|null} The stored key, or null if no equivalent record exists
 */
function resolveStoredCollectionKey(collectionId) {
    if (!collectionId || !vecthareState().collections) {
        return null;
    }

    const collections = vecthareState().collections;
    if (Object.prototype.hasOwnProperty.call(collections, collectionId)) {
        return collectionId;
    }

    const targetBareId = parseRegistryKey(collectionId).collectionId || collectionId;
    for (const key of Object.keys(collections)) {
        const bareId = parseRegistryKey(key).collectionId || key;
        if (bareId === targetBareId) {
            return key;
        }
    }

    return null;
}

/**
 * Gets metadata for a collection
 * @param {string} collectionId Collection identifier
 * @returns {object} Collection metadata (with defaults applied)
 */
export function getCollectionMeta(collectionId) {
    // VEC-26: Add comprehensive null checks
    if (!ensureCollectionsObject()) {
        return { ...defaultCollectionMeta };
    }

    const key = resolveStoredCollectionKey(collectionId);
    const stored = key ? vecthareState().collections[key] : null;

    if (!stored) {
        return { ...defaultCollectionMeta };
    }

    // Merge with defaults to ensure all fields exist
    return {
        ...defaultCollectionMeta,
        ...stored,
    };
}

/**
 * Reads the record a collection actually has in VectHare's own metadata file,
 * with NO defaults merged in. This is the source-of-truth test for a
 * metadata-only row: a registry name, a backend folder, a plugin cache entry
 * or another extension's collection is not a VectHare metadata record, and
 * must never be displayed as one. getCollectionMeta() cannot be used for this
 * because it returns defaults for an identity VectHare has never recorded.
 * @param {string} collectionId Collection identifier in any supported key form
 * @returns {{key: string, record: object, fields: string[]}|null} Stored record, or null
 */
export function getStoredCollectionRecord(collectionId) {
    if (!collectionId || !ensureCollectionsObject()) {
        return null;
    }

    const key = resolveStoredCollectionKey(collectionId);
    if (!key) {
        return null;
    }

    const record = vecthareState().collections[key];
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return null;
    }

    return { key, record, fields: Object.keys(record) };
}

/**
 * Whether VectHare's metadata file holds a record for this identity.
 * @param {string} collectionId Collection identifier in any supported key form
 * @returns {boolean}
 */
export function hasStoredCollectionRecord(collectionId) {
    return getStoredCollectionRecord(collectionId) !== null;
}

/**
 * Removes the obsolete pre-migration keys for one collection identity from
 * VectHare's own settings namespace. migrateOldEnabledKeys() recreates a
 * collection record from any 'vecthare_collection_enabled_<id>' key it finds,
 * so a deliberately deleted record would otherwise come back at the next
 * startup. Nothing writes these keys any more; they are migration input only.
 * @param {string} collectionId Collection identifier in any supported key form
 * @returns {string[]} Keys that were removed
 */
export function forgetLegacyCollectionKeys(collectionId) {
    if (!collectionId || !extension_settings?.vecthare) return [];
    const target = parseRegistryKey(collectionId).collectionId || collectionId;
    const removed = [];
    for (const key of Object.keys(extension_settings.vecthare)) {
        if (!key.startsWith('vecthare_collection_enabled_')) continue;
        const suffix = key.slice('vecthare_collection_enabled_'.length);
        if ((parseRegistryKey(suffix).collectionId || suffix) !== target) continue;
        delete extension_settings.vecthare[key];
        removed.push(key);
    }
    if (removed.length) saveSettingsDebounced();
    return removed;
}

/**
 * Removes every obsolete pre-migration key, for all identities. Used by a full
 * purge that keeps VectHare's settings: left behind, these keys would have the
 * startup migration rebuild collection records that were just deleted.
 * @returns {string[]} Keys that were removed
 */
export function forgetAllLegacyCollectionKeys() {
    if (!extension_settings?.vecthare) return [];
    const removed = Object.keys(extension_settings.vecthare)
        .filter(key => key.startsWith('vecthare_collection_enabled_'));
    for (const key of removed) delete extension_settings.vecthare[key];
    if (removed.length) saveSettingsDebounced();
    return removed;
}

/**
 * Whether any obsolete pre-migration key still exists for this identity.
 * Read-only counterpart to forgetLegacyCollectionKeys, for verifying a delete.
 * @param {string} collectionId Collection identifier in any supported key form
 * @returns {boolean}
 */
export function hasLegacyCollectionKeys(collectionId) {
    if (!collectionId || !extension_settings?.vecthare) return false;
    const target = parseRegistryKey(collectionId).collectionId || collectionId;
    return Object.keys(extension_settings.vecthare).some(key => {
        if (!key.startsWith('vecthare_collection_enabled_')) return false;
        const suffix = key.slice('vecthare_collection_enabled_'.length);
        return (parseRegistryKey(suffix).collectionId || suffix) === target;
    });
}

/**
 * Collection fields that describe how the USER configured a collection, not
 * how its vectors were made. Only these carry over to a verified rebuild
 * replacement; everything else (chunk counts, timestamps, saved vectorization
 * settings, fingerprints, purge markers, rebuild bookkeeping) belongs to the
 * vectors that were replaced and is deliberately left behind.
 */
export const TRANSFERABLE_COLLECTION_FIELDS = [
    'displayName', 'description', 'tags', 'color', 'enabled', 'autoSync',
    'alwaysActive', 'lockMode', 'forceMode', 'exclusiveWhenActive', 'exclusiveScope',
    'triggers', 'triggerMatchMode', 'triggerCaseSensitive', 'triggerScanDepth',
    'conditions', 'temporalDecay', 'context', 'xmlTag',
];

/**
 * Copies the user's collection preferences onto a replacement collection.
 * Vectorization-specific fields are never copied, and nothing is removed from
 * the source record.
 * @param {string} fromCollectionId Collection being replaced
 * @param {string} toCollectionId Verified replacement collection
 * @returns {string[]} Field names that were carried over
 */
export function carryOverCollectionPreferences(fromCollectionId, toCollectionId) {
    if (!fromCollectionId || !toCollectionId) return [];
    const stored = getStoredCollectionRecord(fromCollectionId);
    if (!stored) return [];

    const carried = {};
    for (const field of TRANSFERABLE_COLLECTION_FIELDS) {
        if (stored.record[field] === undefined) continue;
        try {
            carried[field] = JSON.parse(JSON.stringify(stored.record[field]));
        } catch {
            // An unserializable value is left behind rather than half-copied.
        }
    }
    const fields = Object.keys(carried);
    if (fields.length) setCollectionMeta(toCollectionId, carried);
    return fields;
}

/**
 * Chunk hashes this collection holds its own annotations for.
 * @param {string} collectionId Collection identifier
 * @returns {string[]}
 */
export function getAnnotatedChunkHashes(collectionId) {
    const scope = chunkMetaScope(collectionId);
    if (!scope) return [];
    const store = vecthareState().chunkMetadata || {};
    return Object.keys(store).filter(hash => {
        const { byCollection } = splitChunkMetaEntry(store[hash]);
        return Boolean(byCollection[scope]);
    });
}

/**
 * Moves one collection's own chunk annotations onto a replacement collection,
 * but only for chunks the replacement actually contains. An annotation
 * describes a specific chunk's text, so a hash the rebuild did not reproduce
 * cannot be associated with anything and is left where it is.
 * @param {string} fromCollectionId Collection being replaced
 * @param {string} toCollectionId Verified replacement collection
 * @param {string[]} availableHashes Hashes stored in the replacement
 * @returns {{transferred: number, skipped: number}}
 */
export function transferCollectionAnnotations(fromCollectionId, toCollectionId, availableHashes) {
    const fromScope = chunkMetaScope(fromCollectionId);
    const toScope = chunkMetaScope(toCollectionId);
    if (!fromScope || !toScope || fromScope === toScope) return { transferred: 0, skipped: 0 };

    const allowed = new Set((availableHashes || []).map(String));
    const store = vecthareState().chunkMetadata || {};
    let transferred = 0;
    let skipped = 0;
    for (const hash of getAnnotatedChunkHashes(fromCollectionId)) {
        const { byCollection } = splitChunkMetaEntry(store[hash]);
        const annotation = byCollection[fromScope];
        if (!annotation) continue;
        if (!allowed.has(String(hash))) {
            skipped++;
            continue;
        }
        // The source annotation is kept: the replaced collection is retained
        // as a cleanup candidate and must stay inspectable as it was.
        saveChunkMetadata(hash, annotation, toCollectionId);
        transferred++;
    }
    return { transferred, skipped };
}

/**
 * The key VectHare's metadata file holds an entry under for this identity,
 * whether or not that entry is a readable record. Used to tell a broken record
 * apart from no record at all.
 * @param {string} collectionId Collection identifier in any supported key form
 * @returns {string|null}
 */
export function findStoredCollectionKey(collectionId) {
    if (!collectionId || !ensureCollectionsObject()) {
        return null;
    }
    return resolveStoredCollectionKey(collectionId);
}

/**
 * Sets metadata for a collection (merges with existing)
 * @param {string} collectionId Collection identifier
 * @param {object} data Metadata to set (partial or full)
 */
export function setCollectionMeta(collectionId, data) {
    if (!collectionId) {
        console.warn('VectHare: setCollectionMeta called with null/undefined collectionId');
        return;
    }

    ensureCollectionsObject();

    const key = resolveStoredCollectionKey(collectionId) || collectionId;
    const existing = vecthareState().collections[key] || {};

    vecthareState().collections[key] = {
        ...defaultCollectionMeta,
        ...existing,
        ...data,
    };

    persistVectHareStore();
    vhLog(`VectHare: Updated metadata for collection ${key}`);
}

/**
 * A collection's initial configuration is only known for a verified first
 * write. An empty backend response alone does not make an old collection new:
 * its vectors may have been removed, or its storage backend may have changed.
 */
// A confirmed VectHare purge may leave an old chat's registry aliases in
// memory (discovery can restore them). Keep only the verified destination here;
// disappearance without this record is NOT permission to reset provenance.
function deletionDestination(settings) {
    if (!settings) return null;
    const config = createInitialVectorizationConfig(settings, {
        pipeline: 'sync-chat', strategy: 'per_message',
    });
    return config ? JSON.stringify([
        config.storage, config.embedding.provider, config.embedding.model || '',
    ]) : null;
}

export function recordVerifiedCollectionDeletion(collectionId, settings) {
    const destination = deletionDestination(settings);
    if (!destination) throw new Error('Cannot record verified deletion destination');
    // 9b: the collection's locator pointed at the store that was just emptied;
    // a fresh start follows today's settings again.
    setCollectionMeta(collectionId, { verifiedPurgeDestination: destination,
        createdAt: null, chunkCount: 0, vectorizationConfigFingerprint: null, storage: null });
}

export function canRecordInitialVectorizationConfig(collectionId, settings = null) {
    if (!collectionId || !ensureCollectionsObject()) return false;
    const collections = vecthareState().collections;
    const key = resolveStoredCollectionKey(collectionId);
    const previous = key ? collections[key] : null;
    const confirmedDeletion = previous?.verifiedPurgeDestination &&
        previous.verifiedPurgeDestination === deletionDestination(settings);
    if (confirmedDeletion) return true;
    if (previous?.initialVectorizationConfig || previous?.createdAt ||
        (Number(previous?.chunkCount) > 0)) return false;

    const bareId = parseRegistryKey(collectionId).collectionId || collectionId;
    const registry = vecthareState().registry || [];
    return !registry.some(id => (parseRegistryKey(id).collectionId || id) === bareId);
}

/**
 * Record the settings used to build the first vectors. This is historical
 * provenance only; no existing Sync/Repair/RAG behavior is changed.
 * Do not save credentials, access tokens or operational rate limits.
 */
function buildInitialVectorizationConfig(settings, chunking) {
    const provider = settings.source || 'transformers';
    // 9c: the collection's v2 layout (existing: from its saved settings / locator;
    // new: chosen for this first write). Legacy layouts record no layout field.
    const requestedLayout = settings.__storageLayout ?? settings.__newStorageLayout?.layout ?? null;
    const storageLayout = isV2Layout(settings.vector_backend, requestedLayout) ? requestedLayout : null;
    const modelField = getModelField(provider);
    const cleaningApplied = chunking.pipeline !== 'scene-markers';
    const cleaning = cleaningApplied ? getCleaningSettings() : null;
    const safeUrl = (value) => {
        if (!value) return null;
        try {
            const text = String(value);
            const url = new URL(text.includes('://') ? text : `http://${text}`);
            if (!url.host) return null;
            url.username = '';
            url.password = '';
            url.search = '';
            url.hash = '';
            return url.toString();
        } catch {
            return null;
        }
    };

    const hashInput = chunking.pipeline === 'content-vectorizer'
        ? 'prepared chunk text'
        : chunking.pipeline === 'scene-markers'
            ? 'raw scene text with speaker names'
            : 'raw chat message text/group text';

    const endpointType = {
        ollama: textgen_types.OLLAMA,
        llamacpp: textgen_types.LLAMACPP,
        vllm: textgen_types.VLLM,
        koboldcpp: textgen_types.KOBOLDCPP,
    }[provider];
    const endpointProvider = ['ollama', 'llamacpp', 'vllm', 'koboldcpp', 'bananabread'].includes(provider);
    const useAlternateEndpoint = endpointProvider && !!settings.use_alt_endpoint;
    const effectiveEndpoint = useAlternateEndpoint ? settings.alt_endpoint_url
        : provider === 'bananabread' ? 'http://localhost:8008'
        : provider === 'extras' ? extension_settings.apiUrl
        : endpointType ? textgenerationwebui_settings.server_urls?.[endpointType]
        : null;

    return {
        schemaVersion: 1,
        recordedAt: new Date().toISOString(),
        embedding: {
            provider,
            model: modelField ? (settings[modelField] || null) :
                (provider === 'koboldcpp' ? (settings.koboldcpp_model || 'koboldcpp') :
                provider === 'bananabread' ? (settings.bananabread_model || 'bananabread') : null),
            useAlternateEndpoint,
            endpoint: safeUrl(effectiveEndpoint),
            configuredDimensions: settings.vector_backend === 'milvus'
                ? (settings.milvus_dimensions ?? null) : null,
            preprocessing: ['webllm', 'koboldcpp', 'bananabread'].includes(provider)
                ? 'stripHtmlAndMarkdown' : null,
            ...(provider === 'vertexai' ? {
                region: oai_settings.vertexai_region || null,
                authMode: oai_settings.vertexai_auth_mode || null,
            } : {}),
        },
        storage: {
            backend: settings.vector_backend || 'standard',
            ...(settings.vector_backend === 'qdrant' ? {
                multitenancy: storageLayout === 'mt-v2' ? true : !!settings.qdrant_multitenancy,
                address: safeUrl(settings.qdrant_use_cloud ? settings.qdrant_url
                    : `${settings.qdrant_host || 'localhost'}:${settings.qdrant_port || 6333}`),
            } : {}),
            ...(settings.vector_backend === 'milvus' ? {
                address: safeUrl(settings.milvus_address ||
                    `${settings.milvus_host || 'localhost'}:${settings.milvus_port || 19530}`),
            } : {}),
            // 9c: only the new layouts record one (existing snapshots are unchanged).
            ...(storageLayout ? { layout: storageLayout } : {}),
        },
        chunking: JSON.parse(JSON.stringify(chunking)),
        hashing: { algorithm: 'getStringHash', input: hashInput },
        textCleaning: {
            applied: cleaningApplied,
            preset: cleaning?.selectedPreset || 'none',
            activePatterns: cleaningApplied
                ? (settings.__collectionCleaningPatterns ?? getActivePatterns()).map(({ pattern, flags, replacement }) => ({
                    pattern, flags: flags || 'g', replacement: replacement || '',
                })) : [],
        },
        keywordExtraction: chunking.pipeline === 'scene-markers' ? null : {
            level: chunking.keywordLevel ?? settings.keyword_extraction_level ?? 'balanced',
            baseWeight: chunking.keywordBaseWeight ?? null,
            customStopwords: settings.custom_stopwords || '',
        },
    };
}

/** A snapshot failure must not block the vectorization it describes. */
export function createInitialVectorizationConfig(settings, chunking) {
    try {
        return buildInitialVectorizationConfig(settings, chunking);
    } catch (error) {
        console.warn('VectHare: Could not build initial collection configuration:', error);
        return null;
    }
}

/**
 * Write a first-vectorization record into the vector backend itself.
 * Never put this record into extension_settings (a settings-only backup must
 * not be mistaken for a database collection backup).
 * The server performs the write-once check against existing backend metadata.
 */
export async function saveInitialVectorizationConfig(collectionId, snapshot, settings) {
    if (!collectionId || !snapshot || !settings) return false;
    const logicalId = parseRegistryKey(collectionId).collectionId || collectionId;
    const backend = snapshot.storage?.backend || settings.vector_backend || 'standard';
    const source = snapshot.embedding?.provider || settings.source || 'transformers';
    // Use the same model folder identifier as the actual insert adapters.
    // A descriptive provider fallback (e.g. KoboldCpp) is not a folder name.
    const modelField = getModelField(source);
    const model = modelField ? (settings[modelField] || '') : '';
    const recorded = LOCATED_BACKENDS.includes(normalizeBackend(backend)) ? getStorageLocator(logicalId) : null;
    const v2Layout = snapshot.storage?.layout || null;
    let physicalCollectionId;
    if (v2Layout) {
        // 9c: a v2 collection is named by the plugin at its first insert, which
        // records the locator; the saved settings go to that same store.
        if (!recorded || recorded.backend !== normalizeBackend(backend) || recorded.layout !== v2Layout) {
            console.error(`VectHare: Initial collection configuration was NOT saved for ${logicalId}: ` +
                'its new storage has not been located yet');
            return false;
        }
        physicalCollectionId = recorded.physical;
    } else {
        physicalCollectionId = backend === 'qdrant' && snapshot.storage?.multitenancy
            ? QDRANT_LEGACY_MT : backend === 'milvus' ? MILVUS_LEGACY_SHARED : logicalId;
        // 9b: a collection with a locator keeps its saved settings where its
        // locator says. A snapshot describing another place is never written.
        if (recorded && recorded.backend === normalizeBackend(backend) && recorded.physical !== physicalCollectionId) {
            console.error(`VectHare: Initial collection configuration was NOT saved for ${logicalId}: ` +
                `it is stored in ${recorded.physical}, not ${physicalCollectionId}`);
            return false;
        }
    }
    const v2Storage = v2Layout ? v2StorageParam({ ...recorded, v2: true }) : null;

    try {
        // Recording is best-effort; a stalled metadata request must not hang Sync.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        try {
            const response = await fetch('/api/plugins/similharity/collections/initial-config', {
                method: 'POST',
                headers: getRequestHeaders(),
                signal: controller.signal,
                body: JSON.stringify({
                    backend, collectionId: logicalId, physicalCollectionId,
                    source, model, snapshot, ...(v2Storage ? { storage: v2Storage } : {}),
                }),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
            const result = await response.json();
            if (!result.success || typeof result.saved !== 'boolean') {
                throw new Error('Backend did not confirm configuration storage');
            }
        } finally {
            clearTimeout(timeout);
        }
        // 9b: the place the saved settings are now known to be is the
        // collection's locator (recorded once; routine metadata write).
        if (!v2Layout) {
            const located = locatorForPhysical(logicalId, backend, physicalCollectionId);
            if (located) recordStorageLocator(logicalId, located);
        }
        // Both a new write and a verified existing record mean provenance is present.
        return true;
    } catch (error) {
        // Metadata storage must not alter the result of a successful vector write.
        console.error(`VectHare: Initial collection configuration was NOT saved for ${logicalId}:`, error);
        return false;
    }
}

/**
 * Asks the recorded backend whether a collection physically exists.
 *
 * A registry entry, a folder name or a chunk count of zero is not evidence of
 * existence, and a failure is not evidence of absence: anything that cannot be
 * established explicitly comes back as 'unverified'.
 *
 * @param {string} collectionId Collection identifier or registry key
 * @param {object} settings VectHare settings addressing the recorded destination
 * @param {object} location Optional {backend, source, model, physicalCollectionId, signal}
 * @returns {Promise<{existence: 'present'|'absent'|'unverified', reason?: string,
 *   count?: number, countTrusted?: boolean, backend: string, source: string, model: string}>}
 */
export async function verifyPhysicalCollectionExistence(collectionId, settings, location = {}) {
    const parsed = parseRegistryKey(collectionId);
    const logicalId = parsed.collectionId || collectionId;
    const backend = location.backend || parsed.backend || settings?.vector_backend || 'standard';
    const source = location.source || parsed.source || settings?.source || 'transformers';
    const model = location.model ?? '';
    // 9b: the collection's locator, or today's settings-based rule.
    const resolvedStorage = resolveStorage(logicalId, settings, backend);
    const physicalCollectionId = location.physicalCollectionId || resolvedStorage.physical;
    const v2Storage = location.physicalCollectionId ? null : v2StorageParam(resolvedStorage);
    const describe = { backend, source, model };

    if (!logicalId) {
        return { ...describe, existence: 'unverified', reason: 'No collection identity was given' };
    }
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        if (location.signal?.aborted) controller.abort();
        else location.signal?.addEventListener('abort', () => controller.abort(), { once: true });
        let result;
        try {
            const response = await fetch('/api/plugins/similharity/collections/exists', {
                method: 'POST',
                headers: getRequestHeaders(),
                signal: controller.signal,
                body: JSON.stringify({
                    backend: backend === 'standard' ? 'vectra' : backend,
                    collectionId: logicalId, physicalCollectionId, source, model,
                    ...(v2Storage ? { storage: v2Storage } : {}),
                }),
            });
            if (!response.ok) {
                return { ...describe, existence: 'unverified',
                    reason: `The backend check returned HTTP ${response.status}` };
            }
            result = await response.json();
        } finally {
            clearTimeout(timeout);
        }
        if (result?.success !== true || !['present', 'absent', 'unverified'].includes(result.existence)) {
            return { ...describe, existence: 'unverified', reason: 'The backend gave no usable answer' };
        }
        return {
            ...describe,
            existence: result.existence,
            reason: result.reason || '',
            ...(Number.isFinite(result.count) ? { count: result.count } : {}),
            ...(result.countTrusted === true ? { countTrusted: true } : {}),
            ...(result.model ? { model: result.model } : {}),
        };
    } catch (error) {
        return { ...describe, existence: 'unverified',
            reason: `The backend could not be reached: ${error.message}` };
    }
}

/**
 * Read and validate the original configuration from backend storage only.
 * This does not compare current settings, save metadata, or change any operation.
 * `location` can identify the original source/model if global settings changed.
 * @returns {Promise<{status: 'valid'|'missing'|'invalid'|'unavailable', config?: object, reason?: string}>}
 */
export async function readInitialVectorizationConfig(collectionId, settings, location = {}) {
    if (!collectionId || !settings) return { status: 'unavailable', reason: 'Collection or settings missing' };
    const parsed = parseRegistryKey(collectionId);
    const logicalId = parsed.collectionId || collectionId;
    const backend = location.backend || parsed.backend || settings.vector_backend || 'standard';
    const source = location.source || parsed.source ||
        (['standard', 'vectra', 'lancedb'].includes(backend) ? '*' : (settings.source || 'transformers'));
    // An unspecified model searches existing Vectra model folders; it must not
    // depend on today's global model selection.
    const model = location.model ?? '';
    // 9b: the collection's locator, or today's settings-based rule. 9c: a v2
    // location is named by layout (the plugin finds or derives the physical store).
    const resolvedStorage = resolveStorage(logicalId, settings, backend);
    const v2Storage = location.storage !== undefined ? location.storage
        : location.physicalCollectionId ? null : v2StorageParam(resolvedStorage);
    let physicalCollectionId = location.physicalCollectionId || (v2Storage ? v2Storage.physical || null : resolvedStorage.physical);
    const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const sameBackend = stored => stored === backend ||
        (['standard', 'vectra'].includes(stored) && ['standard', 'vectra'].includes(backend));

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        // An optional run-control signal (Stop) cancels this read too.
        if (location.signal?.aborted) controller.abort();
        else location.signal?.addEventListener('abort', () => controller.abort(), { once: true });
        let result;
        try {
            const response = await fetch('/api/plugins/similharity/collections/initial-config/read', {
                method: 'POST',
                headers: getRequestHeaders(),
                signal: controller.signal,
                body: JSON.stringify({ backend, collectionId: logicalId, physicalCollectionId, source, model,
                    ...(v2Storage ? { storage: v2Storage } : {}) }),
            });
            if (!response.ok) {
                // Only the plugin's explicit physical-collection 404 proves
                // absence. An older/missing read endpoint may also return 404.
                if (response.status === 404) {
                    const error = await response.json().catch(() => null);
                    if (error?.error === 'Collection not found') {
                        return { status: 'missing', physicalAbsent: true };
                    }
                }
                return { status: 'unavailable', reason: `Backend returned HTTP ${response.status}` };
            }
            result = await response.json();
        } finally {
            clearTimeout(timeout);
        }
        if (!result?.success) return { status: 'unavailable', reason: 'Backend did not confirm the read' };
        // 9c: where the plugin found (or would put) a v2 collection.
        const foundAt = v2Storage && result.location && typeof result.location.physical === 'string'
            ? { layout: result.location.layout, physical: result.location.physical,
                dim: Number.isSafeInteger(result.location.dim) ? result.location.dim : null } : null;
        if (foundAt) physicalCollectionId = foundAt.physical;
        if (result.status === 'missing') return { status: 'missing', ...(foundAt ? { location: foundAt } : {}) };
        if (result.status === 'invalid') return { status: 'invalid', reason: 'Stored configuration cannot be decoded' };
        if (result.status === 'ambiguous') return { status: 'unavailable', reason: 'Multiple model configurations exist; specify the original model location' };
        if (result.status !== 'found') return { status: 'unavailable', reason: 'Unexpected backend response' };

        const record = result.record;
        const config = record?.snapshot;
        if (!isObject(record) || record.collectionId !== logicalId || !isObject(config) ||
            config.schemaVersion !== 1 || typeof config.recordedAt !== 'string' ||
            !Number.isFinite(Date.parse(config.recordedAt)) ||
            !isObject(config.embedding) || typeof config.embedding.provider !== 'string' ||
            !config.embedding.provider || !isObject(config.storage) ||
            !sameBackend(config.storage.backend) || !isObject(config.chunking) ||
            !['sync-chat', 'content-vectorizer', 'scene-markers'].includes(config.chunking.pipeline) ||
            typeof config.chunking.strategy !== 'string' || !config.chunking.strategy ||
            !isObject(config.hashing) || config.hashing.algorithm !== 'getStringHash' ||
            typeof config.hashing.input !== 'string' || !config.hashing.input ||
            !isObject(config.textCleaning) || typeof config.textCleaning.applied !== 'boolean' ||
            typeof config.textCleaning.preset !== 'string' ||
            !Array.isArray(config.textCleaning.activePatterns) ||
            !config.textCleaning.activePatterns.every(pattern => isObject(pattern) &&
                typeof pattern.pattern === 'string' && typeof pattern.flags === 'string' &&
                typeof pattern.replacement === 'string') ||
            (config.keywordExtraction !== null && !isObject(config.keywordExtraction)) ||
            !storageMatchesLocation(backend, physicalCollectionId, config.storage, logicalId)) {
            return { status: 'invalid', reason: 'Stored configuration is malformed or has a different collection identity' };
        }
        // For local storage, the embedding source is part of the physical directory.
        if (['standard', 'vectra', 'lancedb'].includes(backend) && source !== '*' &&
            config.embedding.provider !== source) {
            return { status: 'invalid', reason: 'Stored embedding source does not match collection storage' };
        }
        return { status: 'valid', config, ...(foundAt ? { location: foundAt } : {}) };
    } catch (error) {
        return { status: 'unavailable', reason: error.message || 'Backend read failed' };
    }
}

/**
 * 9b/9c: a saved configuration must describe the place it was read from:
 * Qdrant legacy multitenancy <-> multitenancy on, no layout; own collection <->
 * off; vecthare_mt_<dim> <-> layout mt-v2. Milvus: vecthare_main <-> no layout;
 * vecthare_mt_<dim> <-> mt-v2; vh_<hash> <-> per-collection.
 */
function storageMatchesLocation(backend, physical, storage, logicalId) {
    const name = normalizeBackend(backend);
    if (name !== 'qdrant' && name !== 'milvus') return true;
    if (typeof physical !== 'string' || !physical) return false;
    const expected = expectedStorageAt(name, physical, logicalId);
    if (!expected) return false;
    if ((storage?.layout ?? null) !== expected.layout) return false;
    if (name === 'qdrant' && (storage?.multitenancy === true) !== expected.multitenancy) return false;
    return true;
}

/**
 * 9c: sets, on an operation's settings copy, the layout a NEW collection gets.
 * Only the new layouts need it (legacy layouts follow today's rule anyway).
 */
export async function chooseNewCollectionStorage(collectionId, settings) {
    delete settings.__newStorageLayout;
    const backend = normalizeBackend(settings.vector_backend);
    if (!LOCATED_BACKENDS.includes(backend) || getStorageLocator(collectionId)?.backend === backend) return settings;
    const layout = newCollectionLayout(settings, await scopedTenancySupported(), backend);
    if (isV2Layout(backend, layout)) settings.__newStorageLayout = { backend, layout };
    return settings;
}

/**
 * 9c: for writers that create collections without the saved-settings flow
 * (import): a collection that has no locator, no saved settings anywhere and no
 * vectors where today's rule looks is new, and gets today's new layout.
 * Anything else is left exactly as it is.
 * @returns {Promise<object>} settings (a copy when changed)
 */
export async function prepareNewCollectionStorage(collectionId, settings) {
    const backend = normalizeBackend(settings?.vector_backend);
    if (!LOCATED_BACKENDS.includes(backend) || getStorageLocator(collectionId)?.backend === backend) return settings;
    const layout = newCollectionLayout(settings, await scopedTenancySupported(), backend);
    if (!isV2Layout(backend, layout)) return settings;
    const located = await ensureStorageLocator(collectionId, settings);
    if (located.status !== 'none') return settings;
    const { getSavedHashes } = await import('./core-vector-api.js');
    const hashes = await getSavedHashes(collectionId, settings);
    if (!Array.isArray(hashes) || hashes.length) return settings;
    return { ...settings, __newStorageLayout: { backend, layout } };
}

/**
 * 9b: records a collection's locator (a pointer only) with a routine metadata
 * write. Never overwrites an equal locator; never creates a record unless asked.
 * @returns {boolean} whether a change was written
 */
export function recordStorageLocator(collectionId, locator, { createRecord = true } = {}) {
    const id = bareCollectionId(collectionId);
    if (!id || !locator) return false;
    const current = getStoredCollectionRecord(id);
    if (!current && !createRecord) return false;
    if (JSON.stringify(current?.record?.storage ?? null) === JSON.stringify(locator)) return false;
    setCollectionMeta(current?.key || id, { storage: locator });
    for (const key of [...locatorNone.keys()]) if (key.split('\u0000')[1] === id) locatorNone.delete(key);
    return true;
}

/**
 * 9b: find where a collection without a locator is stored, read-only, and record
 * it. Probes today's settings-based location first, then the other legacy
 * locations of the same backend.
 *  - exactly one valid saved configuration -> locator recorded ('recorded')
 *  - none -> nothing recorded; the collection behaves exactly as before ('none')
 *  - more than one -> nothing recorded, writes blocked for this session ('conflict')
 *  - a location could not be read -> nothing recorded ('unavailable')
 * Local backends (Standard/Vectra, LanceDB) have one layout: 'not-applicable'.
 * @returns {Promise<{status: string, locator?: object, locations?: string[], reason?: string}>}
 */
// A collection found nowhere is re-probed at most once a minute (Sync runs on
// every chat event); 'none' changes nothing, it only avoids repeated reads.
const LOCATOR_NONE_TTL_MS = 60 * 1000;
const locatorNone = new Map();

export async function ensureStorageLocator(collectionId, settings, { signal, createRecord = true, backend } = {}) {
    // Same backend choice as readInitialVectorizationConfig: explicit, then the
    // registry key's own backend, then today's setting.
    const parsedKey = parseRegistryKey(collectionId);
    const name = normalizeBackend(backend ?? parsedKey.backend ?? settings?.vector_backend);
    const id = bareCollectionId(parsedKey.collectionId || collectionId);
    if (!LOCATED_BACKENDS.includes(name) || !id) return { status: 'not-applicable' };
    const present = getStorageLocator(id);
    if (present && present.backend === name) return { status: 'present', locator: present };
    const known = getStorageConflict(id, name);
    if (known) return { status: 'conflict', locations: known };
    const v2 = await scopedTenancySupported();
    const candidates = candidateLocations(id, settings, name, { v2 });
    const noneKey = `${name}\u0000${id}\u0000${JSON.stringify(candidates)}`;
    if ((locatorNone.get(noneKey) ?? 0) > Date.now()) return { status: 'none' };

    const results = [];
    for (const candidate of candidates) {
        const read = await readInitialVectorizationConfig(id, settings, candidate.physical
            ? { backend: name, physicalCollectionId: candidate.physical, ...(signal ? { signal } : {}) }
            : { backend: name, storage: { layout: candidate.layout }, ...(signal ? { signal } : {}) });
        // 9c: a v2 location is named by the plugin's answer.
        results.push({ physical: candidate.physical || read.location?.physical || `${candidate.layout} (not found)`,
            dim: read.location?.dim ?? null, read });
    }
    const valid = results.filter(r => r.read.status === 'valid');
    if (valid.length > 1) {
        const locations = valid.map(r => r.physical);
        markStorageConflict(id, name, locations);
        console.warn(`VectHare: ${id} has saved settings in more than one place (${locations.join(', ')}); writes blocked`);
        return { status: 'conflict', locations };
    }
    clearStorageConflict(id, name);
    if (valid.length === 1) {
        const locator = locatorForPhysical(id, name, valid[0].physical, valid[0].dim);
        if (!locator) return { status: 'unavailable', reason: 'unknown location' };
        // Another backend's locator is never replaced in the background.
        if (present && !createRecord) return { status: 'none' };
        recordStorageLocator(id, locator, { createRecord });
        return { status: 'recorded', locator };
    }
    const failed = results.find(r => !['missing', 'valid'].includes(r.read.status));
    if (failed) return { status: 'unavailable', reason: `${failed.physical}: ${failed.read.status}${failed.read.reason ? ` (${failed.read.reason})` : ''}` };
    locatorNone.set(noneKey, Date.now() + LOCATOR_NONE_TTL_MS);
    return { status: 'none' };
}

/**
 * 9b: records locators for this backend's collections that have none yet
 * (read-only probes; low concurrency). Only collections that already have a
 * metadata record get one. Used shortly after start-up and from the Storage tab.
 * @returns {Promise<{checked:number, recorded:number, conflicts:string[], unavailable:number}>}
 */
export async function fillStorageLocators(settings, { signal, onProgress } = {}) {
    const name = normalizeBackend(settings?.vector_backend);
    const out = { checked: 0, recorded: 0, conflicts: [], unavailable: 0 };
    if (!LOCATED_BACKENDS.includes(name)) return out;
    const state = vecthareState();
    const ids = new Set();
    for (const key of [...(state.registry || []), ...Object.keys(state.collections || {})]) {
        const parsed = parseRegistryKey(key);
        const backendOfKey = parsed.backend ? normalizeBackend(parsed.backend) : null;
        if (backendOfKey && backendOfKey !== name) continue;
        const id = parsed.collectionId || key;
        if (typeof id === 'string' && id.startsWith('vecthare_') && getStoredCollectionRecord(id) && !getStorageLocator(id)) ids.add(id);
    }
    const queue = [...ids];
    const total = queue.length;
    const worker = async () => {
        while (queue.length) {
            if (signal?.aborted) return;
            const id = queue.shift();
            try {
                const result = await ensureStorageLocator(id, settings, { signal, createRecord: false });
                out.checked++;
                if (result.status === 'recorded') out.recorded++;
                else if (result.status === 'conflict') out.conflicts.push(id);
                else if (result.status === 'unavailable') out.unavailable++;
            } catch {
                out.unavailable++;
            }
            onProgress?.({ done: out.checked, total });
        }
    };
    await Promise.all([worker(), worker()]);
    return out;
}

/**
 * Compare an operation's intended settings with a Stage 2A collection record.
 * Pure comparison only: no backend reads, settings changes, or enforcement.
 * "compatible" means the recorded, comparable settings match; it cannot
 * establish an unrecorded model revision or prove historical vector contents.
 *
 * @param {object} original Stage 2A result or its validated .config
 * @param {object} intended Snapshot made with createInitialVectorizationConfig()
 * @param {'sync-chat'|'content-vectorizer'|'scene-markers'|'rag'|'repair'} operation
 * @returns {{status: 'compatible'|'incompatible'|'cannot_verify', differences: object[], unverifiable: string[]}}
 */
export function compareInitialVectorizationConfig(original, intended, operation) {
    const differences = [];
    const unverifiable = [];
    const result = () => ({
        status: differences.length ? 'incompatible' : unverifiable.length ? 'cannot_verify' : 'compatible',
        differences,
        unverifiable,
    });
    const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const same = (a, b) => {
        if (Object.is(a, b)) return true;
        if (Array.isArray(a) && Array.isArray(b)) {
            return a.length === b.length && a.every((value, i) => same(value, b[i]));
        }
        if (isObject(a) && isObject(b)) {
            const keys = Object.keys(a);
            return keys.length === Object.keys(b).length &&
                keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
        }
        return false;
    };
    const check = (field, saved, current, { required = false, nullIsValue = false } = {}) => {
        if (!nullIsValue && (saved == null || current == null)) {
            if (required || saved != null || current != null) unverifiable.push(field);
        } else if (nullIsValue && (saved === undefined || current === undefined)) {
            unverifiable.push(field);
        } else if (!same(saved, current)) {
            differences.push({ field, saved, intended: current });
        }
    };
    const operations = ['sync-chat', 'content-vectorizer', 'scene-markers', 'rag', 'repair'];
    if (!operations.includes(operation)) {
        unverifiable.push('operation');
        return result();
    }
    if (original?.status) {
        if (original.status !== 'valid') {
            unverifiable.push(`original configuration: ${original.status}`);
            return result();
        }
        original = original.config;
    }
    if (!isObject(original) || original.schemaVersion !== 1 ||
        !isObject(original.embedding) || !isObject(original.storage) ||
        !isObject(intended) || !isObject(intended.embedding) || !isObject(intended.storage)) {
        unverifiable.push('configuration structure');
        return result();
    }

    // Standard and Vectra name the same backend. Other backend changes are real.
    const backendName = name => name === 'vectra' ? 'standard' : name;
    check('storage.backend', backendName(original.storage.backend),
        backendName(intended.storage.backend), { required: true });
    if (backendName(original.storage.backend) === 'qdrant' ||
        backendName(intended.storage.backend) === 'qdrant') {
        check('storage.multitenancy', original.storage.multitenancy,
            intended.storage.multitenancy, { required: true });
    }
    if (['qdrant', 'milvus'].includes(backendName(original.storage.backend)) ||
        ['qdrant', 'milvus'].includes(backendName(intended.storage.backend))) {
        check('storage.address', original.storage.address,
            intended.storage.address, { required: true });
        // 9c: the storage layout (absent = legacy) must be the same.
        check('storage.layout', original.storage.layout ?? null, intended.storage.layout ?? null,
            { nullIsValue: true });
    }

    check('embedding.provider', original.embedding.provider,
        intended.embedding.provider, { required: true });
    if (!isValidProvider(original.embedding.provider) || !isValidProvider(intended.embedding.provider)) {
        unverifiable.push('embedding.provider identity');
    }
    // A provider with no configurable model can legitimately record null.
    const modelRequired = !!getModelField(original.embedding.provider) ||
        !!getModelField(intended.embedding.provider);
    check('embedding.model', original.embedding.model, intended.embedding.model,
        { required: modelRequired });
    // The alternate-endpoint toggle is only a routing mechanism. If the
    // effective provider URL matches, the embedding destination is identical.
    const urlRequired = ['ollama', 'llamacpp', 'vllm', 'koboldcpp', 'bananabread', 'extras']
        .includes(original.embedding.provider);
    check('embedding.endpoint', original.embedding.endpoint, intended.embedding.endpoint,
        { required: urlRequired });
    check('embedding.configuredDimensions', original.embedding.configuredDimensions,
        intended.embedding.configuredDimensions);
    check('embedding.preprocessing', original.embedding.preprocessing,
        intended.embedding.preprocessing, { nullIsValue: true });
    if (original.embedding.provider === 'vertexai' || intended.embedding.provider === 'vertexai') {
        check('embedding.region', original.embedding.region, intended.embedding.region, { required: true });
        check('embedding.authMode', original.embedding.authMode,
            intended.embedding.authMode, { required: true });
    }

    // RAG only embeds queries. Scene markers are independent, protected chunks:
    // they can coexist with chat chunks and need the same embedding space, but
    // their intentionally different chunking/hashing pipeline is not a mismatch.
    if (operation === 'rag' || operation === 'scene-markers') return result();
    if (!isObject(original.chunking) || !isObject(intended.chunking) ||
        !isObject(original.hashing) || !isObject(intended.hashing) ||
        !isObject(original.textCleaning) || !isObject(intended.textCleaning)) {
        unverifiable.push('chunk preparation configuration');
        return result();
    }
    const expectedPipeline = operation === 'repair' ? 'sync-chat' : operation;
    if (intended.chunking.pipeline !== expectedPipeline) {
        unverifiable.push('intended chunking.pipeline');
    }
    if (original.chunking.pipeline !== intended.chunking.pipeline) {
        // Different pipelines can have different algorithms behind the same
        // strategy name. Their equivalence is not established by Stage 1.
        unverifiable.push('chunking.pipeline');
        return result();
    }
    check('chunking.strategy', original.chunking.strategy,
        intended.chunking.strategy, { required: true });
    if (original.chunking.strategy === 'message_batch' ||
        intended.chunking.strategy === 'message_batch') {
        check('chunking.batchSize', original.chunking.batchSize,
            intended.chunking.batchSize, { required: true });
    }
    if (original.chunking.strategy === 'conversation_turns' ||
        intended.chunking.strategy === 'conversation_turns') {
        check('chunking.conversationTurnOrder', original.chunking.conversationTurnOrder,
            intended.chunking.conversationTurnOrder, { required: true });
    }
    if (operation === 'content-vectorizer' && original.chunking.pipeline === 'content-vectorizer') {
        check('chunking.contentType', original.chunking.contentType,
            intended.chunking.contentType, { required: true });
        if (original.chunking.contentType === 'character' || intended.chunking.contentType === 'character') {
            check('chunking.fields', original.chunking.fields,
                intended.chunking.fields, { required: true });
        }
        // These strategies actually use the chunk size in chunking.js.
        const sized = ['adaptive', 'combined', 'sentence', 'dialogue'];
        if (sized.includes(original.chunking.strategy) || sized.includes(intended.chunking.strategy)) {
            check('chunking.chunkSize', original.chunking.chunkSize,
                intended.chunking.chunkSize, { required: true });
        }
        // chunkOverlap is recorded but not consumed by current chunkText strategies.
    }
    check('hashing.algorithm', original.hashing.algorithm,
        intended.hashing.algorithm, { required: true });
    check('hashing.input', original.hashing.input,
        intended.hashing.input, { required: true });
    check('textCleaning.applied', original.textCleaning.applied,
        intended.textCleaning.applied, { required: true });
    if (original.textCleaning.applied || intended.textCleaning.applied) {
        // Effective patterns matter; different preset names alone do not.
        check('textCleaning.activePatterns', original.textCleaning.activePatterns,
            intended.textCleaning.activePatterns, { required: true });
    }
    return result();
}

/** Copy the operation's settings so later UI changes cannot retarget its requests. */
export function snapshotCollectionOperationSettings(settings) {
    return JSON.parse(JSON.stringify(settings));
}

/** Refuse a mid-run change to settings still read from global provider/cleaning state. */
export function assertCollectionOperationSettingsStable(captured, settings, chunking) {
    const current = createInitialVectorizationConfig(settings, chunking);
    // The preset label is not used to clean text once the effective patterns
    // are captured. Changing that UI label must not interrupt a saved-settings
    // operation; a change to effective rules or the embedding destination must.
    const comparable = config => ({
        embedding: config.embedding,
        storage: config.storage,
        ...(chunking?.pipeline === 'rag' ? {} : {
            cleaningApplied: config.textCleaning?.applied,
            cleaningPatterns: config.textCleaning?.activePatterns,
        }),
    });
    if (!captured || !current ||
        JSON.stringify(comparable(captured)) !== JSON.stringify(comparable(current))) {
        throw new Error('Relevant embedding or text-preparation settings changed during this operation.');
    }
}

/**
 * Check Stage 1 provenance without modifying it. Only a genuinely unregistered
 * and empty collection can start its first write without a saved record.
 * A missing legacy record is usable for read-only RAG, but never for writes.
 */
export async function checkCollectionOperationSettings(collectionId, settings, operation, chunking = null,
    { allowNew = false, readOnly = false } = {}) {
    const intended = createInitialVectorizationConfig(settings, chunking || { pipeline: operation, strategy: 'query' });
    if (!intended) return { status: 'cannot_verify', reason: 'Could not capture operation settings' };

    const saved = await readInitialVectorizationConfig(collectionId, settings);
    if (saved.status === 'valid') {
        return compareInitialVectorizationConfig(saved, intended, operation);
    }
    if (readOnly && saved.status === 'missing') {
        return { status: 'legacy_readonly', reason: 'Legacy collection has no initial configuration' };
    }
    // A missing record in an EXISTING local physical collection isn't proof
    // of first use: the current provider/model's hash list can be empty while
    // another provider/model folder contains historical vectors. For local
    // backends, only the plugin's verified physical absence is eligible.
    // Shared backends use a logical-collection hash check below.
    const local = ['standard', 'vectra', 'lancedb'].includes(settings.vector_backend || 'standard');
    const eligibleAbsence = saved.status === 'missing' && (!local || saved.physicalAbsent);
    if (allowNew && canRecordInitialVectorizationConfig(collectionId, settings) && eligibleAbsence) {
        try {
            const { getSavedHashes } = await import('./core-vector-api.js');
            const hashes = await getSavedHashes(collectionId, settings);
            if (Array.isArray(hashes) && hashes.length === 0) return { status: 'new' };
        } catch (error) {
            return { status: 'cannot_verify', reason: `Could not confirm empty collection: ${error.message}` };
        }
    }
    return { status: 'cannot_verify', reason: `Original configuration ${saved.status}: ${saved.reason || 'not verified'}` };
}

/**
 * Resolve an operation against the saved collection settings without changing
 * SillyTavern preferences. Saved values take precedence where the current
 * pipeline can reproduce them; global-only settings must still agree or we
 * refuse the operation rather than silently embedding incompatible vectors.
 */
export async function resolveCollectionOperationSettings(collectionId, currentSettings, operation, chunking,
    options = {}) {
    // 9b: before a write, make sure the collection's location is known (read-
    // only probe; records a locator when exactly one place holds its saved
    // settings). Reads (RAG) never probe: they use the local locator only.
    if (!options.readOnly) {
        const located = await ensureStorageLocator(collectionId, currentSettings, { signal: options.signal });
        if (located.status === 'conflict') throw new StorageConflictError(collectionId, located.locations);
    }
    const saved = await readInitialVectorizationConfig(collectionId, currentSettings,
        options.signal ? { signal: options.signal } : {});
    if (saved.status !== 'valid') {
        if (options.readOnly && saved.status === 'missing') {
            return { status: 'legacy_readonly', settings: snapshotCollectionOperationSettings(currentSettings), chunking };
        }
        // A transient error (including a 404 from an absent plugin endpoint)
        // never qualifies a collection for a first write.
        if (options.allowNew && saved.status === 'missing') {
            const result = await checkCollectionOperationSettings(collectionId, currentSettings, operation,
                chunking, { allowNew: true });
            if (result.status === 'new') {
                const settings = snapshotCollectionOperationSettings(currentSettings);
                // 9c: a new collection goes to the layout today's switches choose
                // (the new layouts when the plugin offers them).
                await chooseNewCollectionStorage(collectionId, settings);
                return { ...result, settings, chunking };
            }
        }
        throw new Error(`Collection ${collectionId}: original configuration ${saved.status} (${saved.reason || 'not verified'}).`);
    }

    const original = saved.config;
    const settings = snapshotCollectionOperationSettings(currentSettings);
    // A change of storage backend or physical server could target a different
    // collection. Never "restore" those values without locating that store.
    settings.source = original.embedding.provider;
    // 9b (flagged verification change): the Qdrant layout of an existing
    // collection is where its saved settings were read from (its locator, or
    // today's rule), exactly like the source above. The read already refused a
    // record whose multitenancy flag disagrees with that location, so this only
    // stops a later toggle of the checkbox from blocking the collection.
    // Backend and address are still compared as before.
    if (normalizeBackend(settings.vector_backend) === 'qdrant' && original.storage?.backend === 'qdrant') {
        settings.qdrant_multitenancy = original.storage.multitenancy === true;
    }
    // 9c: a v2 collection's layout is part of its storage, exactly as saved.
    if (isV2Layout(settings.vector_backend, original.storage?.layout)) settings.__storageLayout = original.storage.layout;
    else delete settings.__storageLayout;
    delete settings.__newStorageLayout;
    // 9c (P7): legacy Qdrant multitenancy is read-only once the plugin offers
    // the new layouts; a v2 collection needs a plugin that scopes it.
    if (!options.readOnly) await assertStorageWritable(collectionId, settings);
    if (original.textCleaning?.applied) {
        // Per-operation cleaning reproduces the original rules without
        // changing the user's current cleaning preset.
        settings.__collectionCleaningPatterns = snapshotCollectionOperationSettings(
            original.textCleaning.activePatterns);
    }
    if (original.keywordExtraction) {
        settings.keyword_extraction_level = original.keywordExtraction.level;
        settings.custom_stopwords = original.keywordExtraction.customStopwords;
    }
    const modelField = getModelField(settings.source);
    if (modelField && original.embedding.model != null) settings[modelField] = original.embedding.model;
    if (settings.source === 'koboldcpp' && original.embedding.model != null) {
        settings.koboldcpp_model = original.embedding.model;
    }
    if (settings.source === 'bananabread' && original.embedding.model != null) {
        settings.bananabread_model = original.embedding.model;
    }
    // Use the saved local provider address without changing ST's global URL.
    // A configured alternate URL with credentials is preserved when it already
    // points at the right host. Credentials are never restored from metadata.
    const alternateProviders = ['ollama', 'llamacpp', 'vllm', 'koboldcpp', 'bananabread'];
    if (alternateProviders.includes(settings.source) && original.embedding.endpoint) {
        const currentEndpoint = createInitialVectorizationConfig(settings, chunking)?.embedding?.endpoint;
        if (currentEndpoint !== original.embedding.endpoint) {
            settings.use_alt_endpoint = true;
            settings.alt_endpoint_url = original.embedding.endpoint;
        }
    }
    if (original.embedding.configuredDimensions != null && settings.vector_backend === 'milvus') {
        settings.milvus_dimensions = original.embedding.configuredDimensions;
    }

    const effectiveChunking = { ...chunking };
    if ((operation === 'sync-chat' || operation === 'repair') &&
        original.chunking?.pipeline === 'sync-chat') {
        settings.chunking_strategy = original.chunking.strategy;
        if (original.chunking.batchSize != null) settings.batch_size = original.chunking.batchSize;
        if (original.chunking.conversationTurnOrder != null) {
            settings.conversation_turn_order = original.chunking.conversationTurnOrder;
        }
        effectiveChunking.strategy = settings.chunking_strategy;
        effectiveChunking.batchSize = settings.batch_size || 4;
        effectiveChunking.conversationTurnOrder = settings.conversation_turn_order || 'user_character';
        effectiveChunking.keywordLevel = settings.keyword_extraction_level || 'balanced';
    } else if (operation === 'content-vectorizer' &&
        original.chunking?.pipeline === 'content-vectorizer') {
        // The type-specific Content Vectorizer settings are supplied by its
        // caller; it must apply the returned chunking options before preparing text.
        for (const key of ['strategy', 'chunkSize', 'chunkOverlap', 'conversationTurnOrder',
            'batchSize', 'fields', 'keywordLevel', 'keywordBaseWeight']) {
            if (original.chunking[key] !== undefined) effectiveChunking[key] =
                JSON.parse(JSON.stringify(original.chunking[key]));
        }
    }

    const intended = createInitialVectorizationConfig(settings, effectiveChunking);
    const comparison = compareInitialVectorizationConfig(saved, intended, operation);
    if (comparison.status !== 'compatible') {
        const reasons = [...comparison.differences.map(item => item.field), ...comparison.unverifiable];
        throw new Error(`Collection ${collectionId}: cannot reproduce saved ${operation} settings (${reasons.join(', ') || comparison.status}).`);
    }
    // Keep the backend-recorded identity-ledger capability on this verified
    // operation snapshot; callers must never infer it from today's settings.
    return { status: 'compatible', settings, chunking: effectiveChunking,
        config: original.identityLedger === 1 ? { ...intended, identityLedger: 1 } : intended };
}

/** Reject incompatible or unverifiable writes before insertion or deletion. */
export async function requireCollectionOperationSettings(collectionId, settings, operation, chunking, options = {}) {
    const result = await checkCollectionOperationSettings(collectionId, settings, operation, chunking, options);
    if (result.status === 'compatible' || result.status === 'new') return result;
    const reasons = result.differences?.map(change => change.field) || [];
    if (result.unverifiable?.length) reasons.push(...result.unverifiable);
    const explanation = reasons.length ? reasons.join(', ') : (result.reason || 'unknown settings');
    throw new Error(`Collection ${collectionId}: ${result.status} configuration (${explanation}). This check did not modify vectors.`);
}

/**
 * Deletes metadata for a collection
 * @param {string} collectionId Collection identifier
 */
export function deleteCollectionMeta(collectionId) {
    ensureCollectionsObject();

    const key = resolveStoredCollectionKey(collectionId);
    if (key) {
        delete vecthareState().collections[key];
        persistVectHareStore();
        vhLog(`VectHare: Deleted metadata for collection ${key}`);
    }
}

/**
 * Gets all collection metadata
 * @returns {object} Map of collectionId -> metadata
 */
export function getAllCollectionMeta() {
    ensureCollectionsObject();
    return vecthareState().collections;
}

// ============================================================================
// ENABLED STATE (convenience wrappers)
// ============================================================================

/**
 * Sets whether a collection is enabled
 * @param {string} collectionId Collection identifier
 * @param {boolean} enabled Whether collection is enabled
 */
export function setCollectionEnabled(collectionId, enabled) {
    setCollectionMeta(collectionId, { enabled: enabled });
}

/**
 * Checks if a collection is enabled
 * @param {string} collectionId Collection identifier
 * @returns {boolean} Whether collection is enabled (default: true)
 */
export function isCollectionEnabled(collectionId) {
    if (isQuarantinedChatCollection(collectionId)) return false;
    const meta = getCollectionMeta(collectionId);
    return meta.enabled !== false;
}

// ============================================================================
// CHAT-SCOPED COLLECTION POLICIES
// ============================================================================

function normalizeCollectionKey(collectionId) {
    if (!collectionId) return '';
    const parsed = parseRegistryKey(collectionId);
    return parsed.collectionId || collectionId;
}

function collectionKeysMatch(a, b) {
    if (!a || !b) return false;
    return String(a) === String(b) || normalizeCollectionKey(a) === normalizeCollectionKey(b);
}

function ensureChatCollectionPoliciesObject() {
    if (!ensureCollectionsObject()) {
        return false;
    }
    if (!vecthareState().chatCollectionPolicies) {
        vecthareState().chatCollectionPolicies = {};
    }
    return true;
}

/**
 * Gets the collection policy for a chat.
 * @param {string} chatId Chat identifier
 * @returns {{mode: string, selectedCollections: string[]}}
 */
// U5: a chat filename is not unique (two characters can each have "Branch 1"),
// so policies are keyed by the chat's identity [ownerType, ownerId, chat].
// The old filename key is still read as a fallback and is left in place, so a
// chat with the same filename under another owner keeps what it had.
function chatPolicyIdentityKey(owner, chat) {
    return owner && chat ? JSON.stringify([owner.type, String(owner.id), normChat(chat)]) : null;
}
function chatPolicyKeys(chatId) {
    const legacy = String(chatId);
    let identity = null;
    try {
        const ctx = getContext();
        if (ctx && normChat(ctx.chatId) === normChat(chatId)) {
            identity = chatPolicyIdentityKey(getChatOwner(ctx), chatId);
        }
    } catch { identity = null; }
    return { identity, legacy };
}
function readStoredChatPolicy(chatId) {
    const policies = vecthareState().chatCollectionPolicies;
    const { identity, legacy } = chatPolicyKeys(chatId);
    if (identity && policies[identity]) return policies[identity];
    return policies[legacy] || {};
}

/**
 * U5: keeps a chat's collection policy when the chat file or its character is
 * renamed. Only identity-keyed policies move; nothing is deleted.
 */
export function renameChatPolicy({ avatarId, groupId, oldFileName, newFileName } = {}) {
    if (!ensureChatCollectionPoliciesObject()) return;
    const owner = groupId != null ? { type: 'group', id: String(groupId) }
        : avatarId ? { type: 'character', id: String(avatarId) } : null;
    const from = chatPolicyIdentityKey(owner, oldFileName);
    const to = chatPolicyIdentityKey(owner, newFileName);
    const policies = vecthareState().chatCollectionPolicies;
    if (!from || !to || from === to || !policies[from] || policies[to]) return;
    policies[to] = policies[from];
    delete policies[from];
    persistVectHareStore();
}
export function renameCharacterPolicies(oldAvatar, newAvatar) {
    if (!oldAvatar || !newAvatar || oldAvatar === newAvatar || !ensureChatCollectionPoliciesObject()) return;
    const policies = vecthareState().chatCollectionPolicies;
    let changed = false;
    for (const key of Object.keys(policies)) {
        let parsed = null;
        try { parsed = key.startsWith('[') ? JSON.parse(key) : null; } catch { parsed = null; }
        if (!Array.isArray(parsed) || parsed[0] !== 'character' || parsed[1] !== String(oldAvatar)) continue;
        const to = JSON.stringify(['character', String(newAvatar), parsed[2]]);
        if (policies[to]) continue;
        policies[to] = policies[key];
        delete policies[key];
        changed = true;
    }
    if (changed) persistVectHareStore();
}

export function getChatCollectionPolicy(chatId) {
    if (!chatId || !ensureChatCollectionPoliciesObject()) {
        return { ...defaultChatCollectionPolicy, selectedCollections: [] };
    }

    const stored = readStoredChatPolicy(chatId);
    // A copy: callers modify the returned list before saving it, and the
    // stored list may be another chat's (filename fallback, U5).
    const selectedCollections = Array.isArray(stored.selectedCollections) ? [...stored.selectedCollections] : [];

    return {
        ...defaultChatCollectionPolicy,
        ...stored,
        selectedCollections,
    };
}

/**
 * Sets the collection policy for a chat.
 * @param {string} chatId Chat identifier
 * @param {object} policy Partial policy data
 */
export function setChatCollectionPolicy(chatId, policy) {
    if (!chatId || !ensureChatCollectionPoliciesObject()) {
        return;
    }

    const existing = getChatCollectionPolicy(chatId);
    const selectedCollections = Array.isArray(policy.selectedCollections)
        ? [...new Set(policy.selectedCollections.map(String))]
        : existing.selectedCollections;

    // U5: written under the chat's identity when it is known (the current
    // chat); otherwise under the filename as before.
    const { identity, legacy } = chatPolicyKeys(chatId);
    vecthareState().chatCollectionPolicies[identity || legacy] = {
        ...existing,
        ...policy,
        selectedCollections,
    };

    persistVectHareStore();
    vhLog(`VectHare: Updated collection policy for chat ${chatId}`);
}

/**
 * Adds a collection to the current chat's selected/forced collection list.
 * @param {string} chatId Chat identifier
 * @param {string} collectionId Collection identifier or registry key
 */
export function addCollectionToChatPolicy(chatId, collectionId) {
    if (!chatId || !collectionId) return;
    const policy = getChatCollectionPolicy(chatId);
    if (!policy.selectedCollections.some(id => collectionKeysMatch(id, collectionId))) {
        policy.selectedCollections.push(String(collectionId));
    }
    setChatCollectionPolicy(chatId, policy);
}

/**
 * Removes a collection from the current chat's selected/forced collection list.
 * @param {string} chatId Chat identifier
 * @param {string} collectionId Collection identifier or registry key
 */
export function removeCollectionFromChatPolicy(chatId, collectionId) {
    if (!chatId || !collectionId) return;
    const policy = getChatCollectionPolicy(chatId);
    policy.selectedCollections = policy.selectedCollections.filter(id => !collectionKeysMatch(id, collectionId));
    setChatCollectionPolicy(chatId, policy);
}

/**
 * Checks whether a collection is selected/forced for a chat.
 * @param {string} collectionId Collection identifier or registry key
 * @param {string} chatId Chat identifier
 * @returns {boolean}
 */
export function isCollectionSelectedForChat(collectionId, chatId) {
    const policy = getChatCollectionPolicy(chatId);
    return policy.selectedCollections.some(id => collectionKeysMatch(id, collectionId));
}

/**
 * Applies the chat-level selected-collection policy to a candidate list.
 * @param {string[]} collectionIds Candidate collection IDs/registry keys
 * @param {string} chatId Chat identifier
 * @param {object} options Options
 * @param {boolean} options.lorebooksOnly Restrict policy to lorebook collections only
 * @returns {string[]} Filtered collection IDs
 */
export function applyChatCollectionPolicy(collectionIds, chatId, options = {}) {
    const policy = getChatCollectionPolicy(chatId);
    const mode = policy.mode || 'normal';

    if (mode === 'normal' || !Array.isArray(collectionIds)) {
        return collectionIds || [];
    }

    const isSelected = (id) => policy.selectedCollections.some(selected => collectionKeysMatch(selected, id));
    const inScope = (id) => !options.lorebooksOnly || String(id).includes('lorebook') || normalizeCollectionKey(id).includes('lorebook');

    if (mode === 'only_selected') {
        return collectionIds.filter(id => !inScope(id) || isSelected(id));
    }

    if (mode === 'prefer_selected') {
        const selected = collectionIds.filter(id => inScope(id) && isSelected(id));
        const selectedKeys = new Set(selected.map(id => normalizeCollectionKey(id)));
        const rest = collectionIds.filter(id => !selectedKeys.has(normalizeCollectionKey(id)));
        return [...selected, ...rest];
    }

    return collectionIds;
}

// ============================================================================
// AUTO-SYNC STATE (per-collection auto-sync for chat vectorization)
// ============================================================================

/**
 * Sets whether auto-sync is enabled for a collection
 * @param {string} collectionId Collection identifier
 * @param {boolean} autoSync Whether auto-sync is enabled
 */
export function setCollectionAutoSync(collectionId, autoSync) {
    setCollectionMeta(collectionId, { autoSync: autoSync });
}

/**
 * Checks if auto-sync is enabled for a collection
 * @param {string} collectionId Collection identifier
 * @returns {boolean} Whether auto-sync is enabled (default: false)
 */
export function isCollectionAutoSyncEnabled(collectionId) {
    if (!collectionId) {
        return false;
    }
    const meta = getCollectionMeta(collectionId);
    return meta.autoSync === true;
}

// ============================================================================
// CHUNK METADATA (per-chunk settings, stored separately)
// ============================================================================
// Chunk metadata is stored per-hash and can include:
// - conditions: { ... }     - Conditional activation rules
// - sceneId: string         - Scene boundary marker
// - links: []               - Soft/hard links to other chunks
// - disabled: boolean       - Exclude from results
// - isSummary: boolean      - Dual-vector summary chunk
// - parentHash: string      - Parent chunk for summaries
// - context: string         - Prompt context text (supports {{user}}/{{char}})
// - xmlTag: string          - XML tag to wrap this chunk
// ============================================================================

/**
 * Gets metadata for a specific chunk
 * @param {string} hash Chunk hash
 * @returns {object|null} Chunk metadata or null if not found
 */
export function getChunkMetadata(hash, collectionId = null) {
    const key = String(hash);
    const { shared, byCollection } = splitChunkMetaEntry(vecthareState().chunkMetadata[key]);
    const scope = chunkMetaScope(collectionId);
    if (scope && byCollection[scope]) return byCollection[scope];
    if (!shared) return null;
    // Callers without a collection context keep seeing the shared record.
    if (!scope) return shared;
    // C12: with a collection context the pre-#23 shared record is only this
    // collection's when it is the single collection that holds the hash.
    // Otherwise another collection's annotation (e.g. "disabled") would leak in.
    if (!sharedRecordBelongsToCollection(key, scope)) return null;
    // First scoped read: the collection takes its own copy of the shared record.
    const chunkMetadata = vecthareState().chunkMetadata;
    const copy = { ...shared };
    chunkMetadata[key] = { ...shared, __byCollection: { ...byCollection, [scope]: copy } };
    persistVectHareStore();
    return copy;
}

// ---------------------------------------------------------------------------
// C12: which collections hold a hash? The shared (pre-#23) record carries no
// collection of its own, so claims come from the collections' own hash lists.
// The index is in-memory only and filled by primeChunkHashClaims()
// (core-vector-api.js) / noteCollectionHashClaims(). Unknown means "not
// proven", and not proven means the shared record is ignored (fail closed).
// ---------------------------------------------------------------------------
const hashClaims = new Map();      // hash -> Set(collection scope)
const claimsLoaded = new Set();    // scopes whose complete hash list was read

function registryScopes() {
    const entries = Array.isArray(vecthareState().registry) ? vecthareState().registry : [];
    return [...new Set(entries.map(entry => String(parseRegistryKey(entry).collectionId || entry)))];
}

/** Records the complete hash list of one collection. */
export function noteCollectionHashClaims(collectionId, hashes) {
    const scope = chunkMetaScope(collectionId);
    if (!scope || !Array.isArray(hashes)) return;
    forgetCollectionHashClaims(scope);
    for (const hash of hashes) {
        const key = String(hash);
        if (!hashClaims.has(key)) hashClaims.set(key, new Set());
        hashClaims.get(key).add(scope);
    }
    claimsLoaded.add(scope);
}

/** Drops what is known about one collection (or all), e.g. after it changed. */
export function forgetCollectionHashClaims(collectionId = null) {
    if (collectionId === null) {
        hashClaims.clear();
        claimsLoaded.clear();
        return;
    }
    const scope = chunkMetaScope(collectionId);
    if (!scope) return;
    claimsLoaded.delete(scope);
    for (const [hash, holders] of hashClaims) {
        holders.delete(scope);
        if (!holders.size) hashClaims.delete(hash);
    }
}

/** True when any hash still has a pre-#23 shared record. */
export function hasSharedChunkRecords() {
    return Object.values(vecthareState().chunkMetadata || {}).some(entry => splitChunkMetaEntry(entry).shared);
}

/** Registry entries whose hash list has not been read yet this session. */
export function registryEntriesMissingHashClaims() {
    const entries = Array.isArray(vecthareState().registry) ? vecthareState().registry : [];
    return entries.filter(entry => !claimsLoaded.has(String(parseRegistryKey(entry).collectionId || entry)));
}

function sharedRecordBelongsToCollection(hash, scope) {
    const others = registryScopes().filter(other => other !== scope);
    const holders = hashClaims.get(hash);
    // A collection that was read and does not hold the hash has no claim on it.
    if (claimsLoaded.has(scope) && !holders?.has(scope)) return false;
    // Only collection known to exist: nothing else can hold the hash.
    if (others.length === 0) return true;
    // Every other collection must have been read, otherwise a holder could exist.
    if (others.some(other => !claimsLoaded.has(other))) return false;
    return !holders || !others.some(other => holders.has(other));
}

// #23: identical text in two collections shares one hash, so annotations keyed
// by hash alone leaked between collections. Each collection now keeps its own
// record; the shared (pre-existing) record is the fallback for callers without
// a collection context and seeds a collection's first annotation.
function chunkMetaScope(collectionId) {
    if (!collectionId) return null;
    return String(parseRegistryKey(collectionId).collectionId || collectionId);
}
function splitChunkMetaEntry(entry) {
    if (!entry || typeof entry !== 'object') return { shared: null, byCollection: {} };
    const { __byCollection, ...shared } = entry;
    return {
        shared: Object.keys(shared).length ? shared : null,
        byCollection: __byCollection && typeof __byCollection === 'object' ? __byCollection : {},
    };
}

/**
 * Saves metadata for a specific chunk
 * @param {string} hash Chunk hash
 * @param {object} metadata Chunk metadata
 */
export function saveChunkMetadata(hash, metadata, collectionId = null) {
    const chunkMetadata = vecthareState().chunkMetadata;
    const key = String(hash);
    const { shared, byCollection } = splitChunkMetaEntry(chunkMetadata[key]);
    const { __byCollection: _ignored, ...fields } = metadata || {};
    const record = { ...fields, updatedAt: Date.now() };
    const scope = chunkMetaScope(collectionId);
    if (scope) {
        chunkMetadata[key] = {
            ...(shared || {}),
            __byCollection: { ...byCollection, [scope]: record },
        };
    } else {
        chunkMetadata[key] = Object.keys(byCollection).length
            ? { ...record, __byCollection: byCollection } : record;
    }

    persistVectHareStore();
}

/**
 * Deletes metadata for a specific chunk
 * @param {string} hash Chunk hash
 */
export function deleteChunkMetadata(hash, collectionId = null) {
    const chunkMetadata = vecthareState().chunkMetadata;
    const key = String(hash);
    if (!chunkMetadata[key]) return;
    const { shared, byCollection } = splitChunkMetaEntry(chunkMetadata[key]);
    const scope = chunkMetaScope(collectionId);
    // Never discard other collections' annotations for the same hash.
    if (scope) {
        if (!byCollection[scope]) return;
        const remaining = { ...byCollection };
        delete remaining[scope];
        if (!shared && !Object.keys(remaining).length) delete chunkMetadata[key];
        else if (Object.keys(remaining).length) {
            chunkMetadata[key] = { ...(shared || {}), __byCollection: remaining };
        } else {
            chunkMetadata[key] = { ...shared };
        }
    } else if (Object.keys(byCollection).length) {
        if (!shared) return;
        chunkMetadata[key] = { __byCollection: byCollection };
    } else {
        delete chunkMetadata[key];
    }
    persistVectHareStore();
}

/**
 * Gets all chunk metadata entries
 * @returns {object} Map of hash -> metadata
 */
export function getAllChunkMetadata(collectionId = null) {
    const result = {};

    for (const hash of Object.keys(vecthareState().chunkMetadata)) {
        const meta = getChunkMetadata(hash, collectionId);
        if (meta) result[hash] = meta;
    }

    return result;
}

// ============================================================================
// MIGRATION & CLEANUP
// ============================================================================

/**
 * Migrates old scattered enabled keys to new collections structure
 * Old format: vecthare_collection_enabled_{collectionId} = true/false
 * New format: collections[collectionId].enabled = true/false
 */
export function migrateOldEnabledKeys() {
    if (!extension_settings.vecthare) {
        return { migrated: 0 };
    }

    ensureCollectionsObject();

    let migrated = 0;
    const keysToDelete = [];

    for (const key in extension_settings.vecthare) {
        if (key.startsWith('vecthare_collection_enabled_')) {
            const collectionId = key.replace('vecthare_collection_enabled_', '');
            const enabled = extension_settings.vecthare[key];

            // Only migrate if we don't already have metadata for this collection
            if (!vecthareState().collections[collectionId]) {
                vecthareState().collections[collectionId] = {
                    ...defaultCollectionMeta,
                    enabled: enabled !== false,
                };
                vhLog(`VectHare: Migrated enabled key for ${collectionId}`);
            }

            keysToDelete.push(key);
            migrated++;
        }
    }

    // Delete old keys
    for (const key of keysToDelete) {
        delete extension_settings.vecthare[key];
    }

    if (migrated > 0) {
        saveSettingsDebounced();
        persistVectHareStore();
        vhLog(`VectHare: Migrated ${migrated} old enabled keys to new collections structure`);
    }

    return { migrated };
}

/**
 * Cleans up orphaned metadata entries (collections that no longer exist)
 * @param {string[]} actualCollectionIds Array of collection IDs that actually exist
 * @returns {object} Cleanup stats
 */
/**
 * Phase 2: no longer called from the Database Browser refresh. Removing a
 * record because a listing did not mention it would turn a backend error or an
 * incomplete listing into a claim of absence. Metadata-only entries are now
 * shown in the Browser and removed deliberately with Delete Metadata
 * (deleteCollectionMetadataOnly), which requires confirmed physical absence.
 * Kept for explicit, caller-verified cleanup only.
 */
export function cleanupOrphanedMeta(actualCollectionIds) {
    ensureCollectionsObject();

    const actualSet = new Set(actualCollectionIds);
    const orphaned = [];

    for (const collectionId in vecthareState().collections) {
        if (!actualSet.has(collectionId)) {
            orphaned.push(collectionId);
        }
    }

    for (const collectionId of orphaned) {
        delete vecthareState().collections[collectionId];
        vhLog(`VectHare: Removed orphaned metadata for ${collectionId}`);
    }

    if (orphaned.length > 0) {
        persistVectHareStore();
        vhLog(`VectHare: Cleaned up ${orphaned.length} orphaned metadata entries`);
    }

    return { removed: orphaned.length, orphanedIds: orphaned };
}

// ============================================================================
// COLLECTION LOCKING (Bind collection to one or more chats)
// ============================================================================

/**
 * Adds a chat to the collection's lock list. Supports multiple chats per collection.
 * Stores chat IDs in metadata field `lockedToChatIds` (array).
 * Automatically migrates old single-value `lockedToChatId` to array format.
 * @param {string} collectionId
 * @param {string|null} chatId - Chat ID to lock to, or null to remove all locks
 */
export function setCollectionLock(collectionId, chatId) {
    if (!collectionId) return;
    const meta = getCollectionMeta(collectionId);
    const update = {};

    if (chatId === null) {
        // Clear all locks
        update.lockedToChatIds = [];
        update.lockedToChatId = null; // Clear old format for backward compat
    } else {
        chatId = String(chatId);
        let locks = Array.isArray(meta.lockedToChatIds) ? [...meta.lockedToChatIds] : [];

        // Migrate old single-value format if present
        if (meta.lockedToChatId && !locks.includes(String(meta.lockedToChatId))) {
            locks.push(String(meta.lockedToChatId));
        }

        // Add chat if not already present
        if (!locks.includes(chatId)) {
            locks.push(chatId);
        }

        update.lockedToChatIds = locks;
        update.lockedToChatId = null; // Clear old format
    }

    setCollectionMeta(collectionId, update);
    vhLog(`VectHare: Collection ${collectionId} locks updated:`, update.lockedToChatIds);
}

/**
 * Removes a specific chat from a collection's lock list
 * @param {string} collectionId
 * @param {string} chatId - Chat ID to remove from lock list
 */
export function removeCollectionLock(collectionId, chatId) {
    if (!collectionId || !chatId) return;
    const meta = getCollectionMeta(collectionId);
    const update = {};

    let locks = Array.isArray(meta.lockedToChatIds) ? [...meta.lockedToChatIds] : [];

    // Migrate old format if present
    if (meta.lockedToChatId && !locks.includes(String(meta.lockedToChatId))) {
        locks.push(String(meta.lockedToChatId));
    }

    // Remove the chat
    locks = locks.filter(id => String(id) !== String(chatId));

    update.lockedToChatIds = locks;
    update.lockedToChatId = null; // Clear old format

    setCollectionMeta(collectionId, update);
    vhLog(`VectHare: Removed chat ${chatId} from collection ${collectionId} locks`);
}

/**
 * Clears all locks for a collection (removes from all chats)
 * @param {string} collectionId
 */
export function clearCollectionLock(collectionId) {
    setCollectionLock(collectionId, null);
}

/**
 * Gets the array of locked chat IDs for a collection, or empty array if not locked
 * Includes backward compatibility for old single-value `lockedToChatId` format
 * @param {string} collectionId
 * @returns {string[]}
 */
export function getCollectionLocks(collectionId) {
    const meta = getCollectionMeta(collectionId);
    let locks = Array.isArray(meta.lockedToChatIds) ? [...meta.lockedToChatIds] : [];

    // Backward compatibility: if old format exists and not already in new format, include it
    if (meta.lockedToChatId && !locks.includes(String(meta.lockedToChatId))) {
        locks.push(String(meta.lockedToChatId));
    }

    return locks;
}

/**
 * Gets the first locked chat ID (for backward compat with single-lock code)
 * @param {string} collectionId
 * @returns {string|null}
 */
export function getCollectionLock(collectionId) {
    const locks = getCollectionLocks(collectionId);
    return locks.length > 0 ? locks[0] : null;
}

/**
 * Checks whether the collection is locked to the provided chatId
 * @param {string} collectionId
 * @param {string} chatId
 * @returns {boolean}
 */
export function isCollectionLockedToChat(collectionId, chatId) {
    if (!collectionId || !chatId) return false;
    const locks = getCollectionLocks(collectionId);
    return locks.some(id => String(id) === String(chatId));
}

/**
 * Gets the count of chats this collection is locked to
 * @param {string} collectionId
 * @returns {number}
 */
export function getCollectionLockCount(collectionId) {
    return getCollectionLocks(collectionId).length;
}

// ============================================================================
// CHARACTER LOCKING (Bind collection to one or more character cards)
// ============================================================================

/**
 * Adds a character to the collection's character lock list. Supports multiple characters per collection.
 * Stores character IDs in metadata field `lockedToCharacterIds` (array).
 * @param {string} collectionId
 * @param {string} characterId - Character ID to lock to
 */
export function setCollectionCharacterLock(collectionId, characterId) {
    if (!collectionId || !characterId) return;
    const meta = getCollectionMeta(collectionId);
    const update = {};

    characterId = String(characterId);
    let locks = Array.isArray(meta.lockedToCharacterIds) ? [...meta.lockedToCharacterIds] : [];

    // Add character if not already present
    if (!locks.includes(characterId)) {
        locks.push(characterId);
    }

    update.lockedToCharacterIds = locks;
    setCollectionMeta(collectionId, update);
    vhLog(`VectHare: Collection ${collectionId} character locks updated:`, update.lockedToCharacterIds);
}

/**
 * Removes a specific character from a collection's character lock list
 * @param {string} collectionId
 * @param {string} characterId - Character ID to remove from lock list
 */
export function removeCollectionCharacterLock(collectionId, characterId) {
    if (!collectionId || !characterId) return;
    const meta = getCollectionMeta(collectionId);
    const update = {};

    let locks = Array.isArray(meta.lockedToCharacterIds) ? [...meta.lockedToCharacterIds] : [];

    // Remove the character
    locks = locks.filter(id => String(id) !== String(characterId));

    update.lockedToCharacterIds = locks;
    setCollectionMeta(collectionId, update);
    vhLog(`VectHare: Removed character ${characterId} from collection ${collectionId} locks`);
}

/**
 * Clears all character locks for a collection
 * @param {string} collectionId
 */
export function clearCollectionCharacterLocks(collectionId) {
    if (!collectionId) return;
    setCollectionMeta(collectionId, { lockedToCharacterIds: [] });
    vhLog(`VectHare: Cleared all character locks for collection ${collectionId}`);
}

/**
 * Gets the array of locked character IDs for a collection, or empty array if not locked
 * @param {string} collectionId
 * @returns {string[]}
 */
export function getCollectionCharacterLocks(collectionId) {
    const meta = getCollectionMeta(collectionId);
    return Array.isArray(meta.lockedToCharacterIds) ? [...meta.lockedToCharacterIds] : [];
}

/**
 * Checks whether the collection is locked to the provided character ID
 * @param {string} collectionId
 * @param {string} characterId
 * @returns {boolean}
 */
export function isCollectionLockedToCharacter(collectionId, characterId) {
    if (!collectionId || !characterId) return false;
    const locks = getCollectionCharacterLocks(collectionId);
    return locks.some(id => String(id) === String(characterId));
}

/**
 * Gets the count of characters this collection is locked to
 * @param {string} collectionId
 * @returns {number}
 */
export function getCollectionCharacterLockCount(collectionId) {
    return getCollectionCharacterLocks(collectionId).length;
}

/**
 * Ensures a collection has metadata (creates with defaults if missing)
 * Called when a collection is discovered/created
 * @param {string} collectionId Collection identifier
 * @param {object} initialData Optional initial data to set (can include 'type' for collection type)
 */
export function ensureCollectionMeta(collectionId, initialData = {}) {
    if (!collectionId) {
        return;
    }

    ensureCollectionsObject();

    if (!vecthareState().collections[collectionId]) {
        // Determine collection type for temporal decay defaults
        // Check initialData.type, or infer from scope, or parse from collectionId
        let collectionType = initialData.type || initialData.scope || 'unknown';
        if (collectionType === 'unknown' && collectionId.includes('_chat_')) {
            collectionType = 'chat';
        } else if (collectionType === 'unknown' && collectionId.includes('_lorebook_')) {
            collectionType = 'lorebook';
        }

        vecthareState().collections[collectionId] = {
            ...defaultCollectionMeta,
            temporalDecay: getDefaultDecayForType(collectionType),
            createdAt: Date.now(),
            ...initialData,
        };
        persistVectHareStore();
        vhLog(`VectHare: Created metadata for new collection ${collectionId} (type: ${collectionType})`);
    }
}

/**
 * Updates lastUsed timestamp and increments queryCount
 * Called when a collection is queried
 * @param {string} collectionId Collection identifier
 */
export function recordCollectionUsage(collectionId) {
    if (!collectionId) {
        return;
    }

    ensureCollectionsObject();

    const existing = vecthareState().collections[collectionId];
    if (existing) {
        existing.lastUsed = Date.now();
        existing.queryCount = (existing.queryCount || 0) + 1;
        persistVectHareStore();
    }
}

// ============================================================================
// ACTIVATION TRIGGERS (Primary Method)
// ============================================================================

/**
 * Checks if any activation triggers match the recent messages
 * @param {string[]} triggers Array of trigger keywords
 * @param {object} context Search context containing recentMessages
 * @param {object} options Matching options
 * @returns {boolean} Whether triggers matched
 */
function checkTriggers(triggers, context, options = {}) {
    if (!triggers || triggers.length === 0) {
        return false;
    }

    const {
        matchMode = 'any',
        caseSensitive = false,
        scanDepth = 5,
    } = options;

    // Get recent message text to scan
    const recentMessages = context.recentMessages || [];
    const messagesToScan = recentMessages.slice(-scanDepth);
    const searchText = messagesToScan.join('\n');

    if (!searchText) {
        return false;
    }

    const textToSearch = caseSensitive ? searchText : searchText.toLowerCase();

    // Check each trigger
    const results = triggers.map(trigger => {
        const triggerText = caseSensitive ? trigger : trigger.toLowerCase();

        // Support regex triggers (wrapped in /.../)
        if (trigger.startsWith('/') && trigger.lastIndexOf('/') > 0) {
            try {
                const lastSlash = trigger.lastIndexOf('/');
                const pattern = trigger.slice(1, lastSlash);
                const flags = trigger.slice(lastSlash + 1) || (caseSensitive ? '' : 'i');
                const regex = new RegExp(pattern, flags);
                return regex.test(searchText);
            } catch (e) {
                console.warn(`VectHare: Invalid trigger regex: ${trigger}`);
                return false;
            }
        }

        // Plain text matching
        return textToSearch.includes(triggerText);
    });

    // Apply match mode
    if (matchMode === 'all') {
        return results.every(r => r);
    }
    return results.some(r => r); // 'any' mode (default)
}

// ============================================================================
// CONDITIONAL ACTIVATION (Advanced Method - Secondary)
// ============================================================================

// Import condition evaluator (lazy loaded to avoid circular deps)
let evaluateConditionRule = null;

/**
 * Lazily loads the condition evaluator
 */
async function getConditionEvaluator() {
    if (!evaluateConditionRule) {
        const module = await import('./conditional-activation.js');
        evaluateConditionRule = module.evaluateConditionRule;
    }
    return evaluateConditionRule;
}

/**
 * Evaluates advanced conditions for a collection
 * @param {object} meta Collection metadata
 * @param {object} context Search context
 * @param {string} collectionId Collection identifier (for logging)
 * @returns {Promise<boolean>} Whether conditions pass
 */
async function evaluateAdvancedConditions(meta, context, collectionId) {
    if (!meta.conditions || !meta.conditions.enabled) {
        return true; // No conditions = pass
    }

    const rules = meta.conditions.rules || [];
    if (rules.length === 0) {
        return true; // Enabled but no rules = pass
    }

    const evaluate = await getConditionEvaluator();

    const results = rules.map(rule => {
        const result = evaluate(rule, context);
        vhLog(`VectHare: Collection ${collectionId} condition ${rule.type}: ${result}`);
        return result;
    });

    const logic = meta.conditions.logic || 'AND';
    return logic === 'AND' ? results.every(r => r) : results.some(r => r);
}

/**
 * Checks if a collection should activate based on triggers and conditions
 *
 * ACTIVATION PRIORITY:
 * 1. Disabled (enabled=false) → Never activate
 * 2. Always Active → Always activate (ignores triggers and conditions)
 * 2.5. Locked to current chat → Activate (overrides triggers/conditions)
 * 2.6. Locked to current character → Activate (overrides triggers/conditions)
 * 3. Triggers match → Activate (primary method)
 * 4. Advanced conditions pass → Activate (secondary method)
 * 5. No triggers AND no conditions → Inactive unless forced/locked/always active
 *
 * @param {string} collectionId Collection identifier
 * @param {object} context Search context (from buildSearchContext)
 * @returns {Promise<boolean>} Whether the collection should be queried
 */
export async function shouldCollectionActivate(collectionId, context) {
    if (isQuarantinedChatCollection(collectionId)) return false;
    const meta = getCollectionMeta(collectionId);
    const currentChatId = context?.currentChatId;
    const currentCharacterId = context?.currentCharacterId;
    const chatLocks = getCollectionLocks(collectionId);
    const characterLocks = getCollectionCharacterLocks(collectionId);
    const lockMode = meta.lockMode || 'prefer';
    const forcedForChat = currentChatId && isCollectionSelectedForChat(collectionId, currentChatId);
    const recordDecision = (decision, reason, extra = {}) => {
        if (Array.isArray(context?.collectionDecisions)) {
            context.collectionDecisions.push({
                collectionId,
                decision,
                reason,
                enabled: meta.enabled !== false,
                alwaysActive: meta.alwaysActive === true,
                lockMode,
                forceMode: forcedForChat || meta.forceMode === 'forced' ? 'forced' : (meta.forceMode || 'normal'),
                chatLocks,
                characterLocks,
                currentChatId,
                currentCharacterId,
                exclusiveWhenActive: meta.exclusiveWhenActive === true,
                exclusiveScope: meta.exclusiveScope || 'lorebook',
                ...extra,
            });
        }
    };

    // Priority 1: Check if collection is disabled entirely
    if (meta.enabled === false) {
        vhLog(`[VectHare Activation Filter] Collection ${collectionId}: ✗ DISABLED`);
        recordDecision('skipped', 'Collection is disabled');
        return false;
    }

    // Priority 1.5: Strict locks are allow-lists. If a collection is locked
    // exclusively and the current chat/character is not in that lock list, it
    // must not activate through Always Active, triggers, or conditions.
    if (lockMode === 'exclusive') {
        const hasChatLocks = chatLocks.length > 0;
        const hasCharacterLocks = characterLocks.length > 0;
        const chatAllowed = hasChatLocks && currentChatId && chatLocks.some(id => String(id) === String(currentChatId));
        const characterAllowed = hasCharacterLocks && currentCharacterId && characterLocks.some(id => String(id) === String(currentCharacterId));

        if ((hasChatLocks || hasCharacterLocks) && !chatAllowed && !characterAllowed) {
            vhLog(`[VectHare Activation Filter] Collection ${collectionId}: ✗ LOCKED_TO_OTHER_CONTEXT`);
            recordDecision('skipped', 'Collection is locked to another chat/character');
            return false;
        }
    }

    // Priority 1.6: A chat's own collection is bound to exactly one chat.
    // - Bound to the current chat -> it activates (memories of this chat).
    // - Bound to a different chat -> it only activates when explicitly forced,
    //   selected, or locked for THIS chat/character. Always Active is ignored
    //   for it, so another chat's memories never leak in by default.
    // Lorebooks, documents and unbound (legacy) collections are unchanged.
    const boundChat = getBoundChatDetails(collectionId);
    if (boundChat) {
        let ownChatCollection = null;
        try { ownChatCollection = peekChatCollectionId(); } catch { ownChatCollection = null; }
        const thisId = parseRegistryKey(collectionId).collectionId || collectionId;
        if (ownChatCollection && ownChatCollection === thisId) {
            vhLog(`[VectHare Activation Filter] Collection ${collectionId}: ✓ CURRENT_CHAT_COLLECTION`);
            recordDecision('queried', 'Current chat');
            return true;
        }
        const explicitForThisChat = forcedForChat
            || meta.forceMode === 'forced'
            || (currentChatId && isCollectionLockedToChat(collectionId, currentChatId))
            || (currentCharacterId && isCollectionLockedToCharacter(collectionId, currentCharacterId));
        if (!explicitForThisChat) {
            vhLog(`[VectHare Activation Filter] Collection ${collectionId}: ✗ BOUND_TO_OTHER_CHAT`);
            recordDecision('skipped', 'Belongs to another chat (not forced, selected or locked for this chat)');
            return false;
        }
    }

    // Priority 1.75: Explicitly selected/forced collections for this chat bypass
    // triggers and conditions but still respect disabled state and strict locks.
    if (forcedForChat || meta.forceMode === 'forced') {
        vhLog(`[VectHare Activation Filter] Collection ${collectionId}: ✓ FORCED_FOR_CHAT`);
        recordDecision('queried', 'Forced for current chat');
        return true;
    }

    // Priority 2: Check if always active (ignores everything else)
    if (meta.alwaysActive === true) {
        vhLog(`[VectHare Activation Filter] Collection ${collectionId}: ✓ ALWAYS_ACTIVE`);
        recordDecision('queried', 'Always Active');
        return true;
    }

    // Priority 2.5: Check if locked to current chat (overrides other conditions)
    if (currentChatId && isCollectionLockedToChat(collectionId, currentChatId)) {
        vhLog(`[VectHare Activation Filter] Collection ${collectionId}: ✓ LOCKED_TO_CURRENT_CHAT (${currentChatId})`);
        recordDecision('queried', 'Locked to current chat');
        return true;
    }

    // Priority 2.6: Check if locked to current character (overrides other conditions)
    if (currentCharacterId && isCollectionLockedToCharacter(collectionId, currentCharacterId)) {
        vhLog(`[VectHare Activation Filter] Collection ${collectionId}: ✓ LOCKED_TO_CURRENT_CHARACTER (${currentCharacterId})`);
        recordDecision('queried', 'Locked to current character');
        return true;
    }

    const hasTriggers = meta.triggers && meta.triggers.length > 0;
    const hasConditions = meta.conditions?.enabled && meta.conditions?.rules?.length > 0;

    vhLog(`[VectHare Activation Filter] Collection ${collectionId}: hasTriggers=${hasTriggers}, hasConditions=${hasConditions}`);

    // Priority 3: Check activation triggers (PRIMARY method)
    if (hasTriggers) {
        const triggersMatch = checkTriggers(meta.triggers, context, {
            matchMode: meta.triggerMatchMode || 'any',
            caseSensitive: meta.triggerCaseSensitive || false,
            scanDepth: meta.triggerScanDepth || 5,
        });

        if (triggersMatch) {
            vhLog(`[VectHare Activation Filter] Collection ${collectionId}: ✓ TRIGGERS_MATCHED (${meta.triggers.join(', ')})`);
            recordDecision('queried', 'Triggers matched', { matchedTriggers: meta.triggers });
            return true;
        }

        // Triggers set but didn't match - check if we should fall through to conditions
        if (!hasConditions) {
            vhLog(`[VectHare Activation Filter] Collection ${collectionId}: ✗ TRIGGERS_NOT_MATCHED (no conditions to fallthrough)`);
            recordDecision('skipped', 'Triggers did not match');
            return false;
        }
    }

    // Priority 4: Check advanced conditions (SECONDARY method)
    if (hasConditions) {
        const conditionsPass = await evaluateAdvancedConditions(meta, context, collectionId);
        vhLog(`[VectHare Activation Filter] Collection ${collectionId}: ${conditionsPass ? '✓' : '✗'} CONDITIONS_${conditionsPass ? 'PASS' : 'FAIL'}`);
        recordDecision(conditionsPass ? 'queried' : 'skipped', conditionsPass ? 'Conditions passed' : 'Conditions failed');
        return conditionsPass;
    }

    // Priority 5: No triggers AND no conditions = do not activate
    vhLog(`[VectHare Activation Filter] Collection ${collectionId}: ✗ NO_TRIGGERS_OR_CONDITIONS (not activating)`);
    recordDecision('skipped', 'No activation triggers or conditions configured');
    return false;
}

/**
 * Filters a list of collection IDs to only those that should activate
 * @param {string[]} collectionIds Array of collection IDs to check
 * @param {object} context Search context (from buildSearchContext)
 * @returns {Promise<string[]>} Collection IDs that should be queried
 */
export async function filterActiveCollections(collectionIds, context) {
    const results = await Promise.all(
        collectionIds.map(async (id) => ({
            id,
            active: await shouldCollectionActivate(id, context)
        }))
    );

    const activeIds = results.filter(r => r.active).map(r => r.id);
    const exclusiveActiveIds = activeIds.filter(id => getCollectionMeta(id).exclusiveWhenActive === true);
    let finalActiveIds = activeIds;

    if (exclusiveActiveIds.length > 0) {
        const suppressAll = exclusiveActiveIds.some(id => (getCollectionMeta(id).exclusiveScope || 'lorebook') === 'all');
        finalActiveIds = activeIds.filter(id => {
            if (exclusiveActiveIds.includes(id)) return true;
            if (suppressAll) return false;
            const normalized = normalizeCollectionKey(id);
            return !String(id).includes('lorebook') && !normalized.includes('lorebook');
        });

        vhLog(`[VectHare Activation Filter] Exclusive collection(s) active, suppressed ${activeIds.length - finalActiveIds.length} peer collection(s)`);
    }

    vhLog(`[VectHare Activation Filter] Summary: ${collectionIds.length} collections → ${finalActiveIds.length} active`);
    if (finalActiveIds.length > 0) {
        vhLog(`[VectHare Activation Filter] Active collections:`, finalActiveIds);
    }

    return finalActiveIds;
}

// ============================================================================
// ACTIVATION TRIGGER HELPERS
// ============================================================================

/**
 * Sets activation triggers for a collection
 * @param {string} collectionId Collection identifier
 * @param {string[]} triggers Array of trigger keywords
 * @param {object} options Optional: matchMode, caseSensitive, scanDepth
 */
export function setCollectionTriggers(collectionId, triggers, options = {}) {
    const update = { triggers };
    if (options.matchMode !== undefined) update.triggerMatchMode = options.matchMode;
    if (options.caseSensitive !== undefined) update.triggerCaseSensitive = options.caseSensitive;
    if (options.scanDepth !== undefined) update.triggerScanDepth = options.scanDepth;
    setCollectionMeta(collectionId, update);
}

/**
 * Gets activation triggers for a collection
 * @param {string} collectionId Collection identifier
 * @returns {object} { triggers, matchMode, caseSensitive, scanDepth }
 */
export function getCollectionTriggers(collectionId) {
    const meta = getCollectionMeta(collectionId);
    return {
        triggers: meta.triggers || [],
        matchMode: meta.triggerMatchMode || 'any',
        caseSensitive: meta.triggerCaseSensitive || false,
        scanDepth: meta.triggerScanDepth || 5,
    };
}

/**
 * Sets the always active flag for a collection
 * @param {string} collectionId Collection identifier
 * @param {boolean} alwaysActive Whether to always activate
 */
export function setCollectionAlwaysActive(collectionId, alwaysActive) {
    setCollectionMeta(collectionId, { alwaysActive });
}

/**
 * Checks if a collection is set to always active
 * @param {string} collectionId Collection identifier
 * @returns {boolean} Whether collection is always active
 */
export function isCollectionAlwaysActive(collectionId) {
    const meta = getCollectionMeta(collectionId);
    return meta.alwaysActive === true;
}

/**
 * Gets a summary of a collection's activation settings
 * @param {string} collectionId Collection identifier
 * @returns {object} Summary of activation state
 */
export function getCollectionActivationSummary(collectionId) {
    const meta = getCollectionMeta(collectionId);
    const triggers = meta.triggers || [];
    const hasConditions = meta.conditions?.enabled && meta.conditions?.rules?.length > 0;

    let mode = 'auto'; // No triggers, no conditions = auto-activate
    if (meta.alwaysActive) {
        mode = 'always';
    } else if (triggers.length > 0) {
        mode = 'triggers';
    } else if (hasConditions) {
        mode = 'conditions';
    }

    return {
        mode,
        alwaysActive: meta.alwaysActive || false,
        triggerCount: triggers.length,
        conditionCount: meta.conditions?.rules?.length || 0,
        conditionsEnabled: hasConditions,
    };
}

// ============================================================================
// ADVANCED CONDITIONS HELPERS
// ============================================================================

/**
 * Sets conditions for a collection
 * @param {string} collectionId Collection identifier
 * @param {object} conditions Conditions object { enabled, logic, rules }
 */
export function setCollectionConditions(collectionId, conditions) {
    setCollectionMeta(collectionId, { conditions });
}

/**
 * Gets conditions for a collection
 * @param {string} collectionId Collection identifier
 * @returns {object} Conditions object
 */
export function getCollectionConditions(collectionId) {
    const meta = getCollectionMeta(collectionId);
    return meta.conditions || { enabled: false, logic: 'AND', rules: [] };
}

// ============================================================================
// TEMPORAL DECAY HELPERS (Per-Collection)
// ============================================================================

/**
 * Default temporal decay settings
 */
const defaultTemporalDecay = {
    enabled: false,
    mode: 'exponential',
    halfLife: 50,
    linearRate: 0.01,
    minRelevance: 0.3,
    sceneAware: false,
};

/**
 * Gets temporal decay settings for a collection
 * Uses type-aware defaults (chat = enabled by default)
 * @param {string} collectionId Collection identifier
 * @returns {object} Decay settings for this collection
 */
export function getCollectionDecaySettings(collectionId) {
    const meta = getCollectionMeta(collectionId);
    const collectionType = meta.scope === 'chat' ? 'chat' : (meta.type || 'unknown');
    const typeDefaults = getDefaultDecayForType(collectionType);

    const key = resolveStoredCollectionKey(collectionId);
    const rawStored = key ? vecthareState().collections?.[key] : null;

    if (rawStored?.temporalDecay) {
        return {
            ...typeDefaults,
            ...rawStored.temporalDecay,
        };
    }

    return typeDefaults;
}

/**
 * Sets temporal decay settings for a collection
 * @param {string} collectionId Collection identifier
 * @param {object} decaySettings Temporal decay settings
 */
export function setCollectionDecaySettings(collectionId, decaySettings) {
    const existing = getCollectionMeta(collectionId);
    const merged = {
        ...defaultTemporalDecay,
        ...existing.temporalDecay,
        ...decaySettings,
    };
    setCollectionMeta(collectionId, { temporalDecay: merged });
}

/**
 * Checks if a collection has custom (non-default) decay settings
 * @param {string} collectionId Collection identifier
 * @returns {boolean} Whether collection has custom decay configuration
 */
export function hasCustomDecaySettings(collectionId) {
    const meta = getCollectionMeta(collectionId);
    return meta.temporalDecay !== undefined && meta.temporalDecay !== null;
}

/**
 * Gets a summary of temporal decay for display
 * @param {string} collectionId Collection identifier
 * @returns {object} Summary { isCustom, enabled, mode, description }
 */
export function getCollectionDecaySummary(collectionId) {
    const meta = getCollectionMeta(collectionId);
    const isCustom = hasCustomDecaySettings(collectionId);
    const settings = getCollectionDecaySettings(collectionId);

    let description = 'Disabled';
    if (settings.enabled) {
        if (settings.mode === 'exponential') {
            description = `Exponential (half-life: ${settings.halfLife} msgs)`;
        } else {
            description = `Linear (${(settings.linearRate * 100).toFixed(1)}% per msg)`;
        }
        if (settings.sceneAware) {
            description += ', scene-aware';
        }
    }

    return {
        isCustom,
        enabled: settings.enabled,
        mode: settings.mode,
        description,
    };
}

// ============================================================================
// TEMPORALLY BLIND CHUNKS
// ============================================================================
// Chunks marked as "temporally blind" are immune to temporal decay.
// Their relevance score will not decrease over time regardless of age.
// Useful for important context that should always remain relevant.

/**
 * Marks a chunk as temporally blind (immune to decay)
 * @param {string} hash Chunk hash
 * @param {boolean} isBlind Whether the chunk is temporally blind
 */
export function setChunkTemporallyBlind(hash, isBlind, collectionId = null) {
    const existing = getChunkMetadata(hash, collectionId) || {};
    saveChunkMetadata(hash, {
        ...existing,
        temporallyBlind: isBlind,
    }, collectionId);
    vhLog(`VectHare: Chunk ${hash} temporally blind: ${isBlind}`);
}

/**
 * Checks if a chunk is temporally blind
 * @param {string} hash Chunk hash
 * @returns {boolean} Whether the chunk is immune to decay
 */
export function isChunkTemporallyBlind(hash, collectionId = null) {
    const meta = getChunkMetadata(hash, collectionId);
    return meta?.temporallyBlind === true;
}

/**
 * Gets all temporally blind chunk hashes
 * @returns {string[]} Array of chunk hashes that are temporally blind
 */
export function getTemporallyBlindChunks() {
    const blindChunks = [];
    for (const [hash, entry] of Object.entries(vecthareState().chunkMetadata)) {
        const { shared, byCollection } = splitChunkMetaEntry(entry);
        if (shared?.temporallyBlind === true ||
            Object.values(byCollection).some(meta => meta?.temporallyBlind === true)) {
            blindChunks.push(hash);
        }
    }
    return blindChunks;
}

/**
 * Gets count of temporally blind chunks
 * @returns {number} Number of temporally blind chunks
 */
export function getTemporallyBlindCount() {
    return getTemporallyBlindChunks().length;
}
