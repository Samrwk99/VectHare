import { vhLog } from '../utils/log.js';
/**
 * ============================================================================
 * VECTHARE COLLECTION EXPORT/IMPORT
 * ============================================================================
 * Handles exporting collections to portable JSON files and importing them back.
 *
 * Exports include:
 * - Full chunk text and metadata
 * - Vector embeddings (for direct import without re-embedding)
 * - Embedding source/model info (so user knows what settings to use)
 *
 * On import, if user's settings match the export's source/model, vectors are
 * imported directly. Otherwise, user is warned to switch settings.
 *
 * @author Coneja Chibi
 * @version see manifest.json
 * ============================================================================
 */

import { addInsertionProvenance, metadataForImport } from './vector-provenance.js';
import { extension_settings } from '../../../../extensions.js';
import { getRequestHeaders, saveSettingsDebounced } from '../../../../../script.js';
import { getSavedHashes, insertVectorItems, purgeVectorIndex, assertVectHareCollectionForWrite, resolveEmbeddingSettingsForEdit } from './core-vector-api.js';
import {
    getCollectionMeta,
    setCollectionMeta,
    getChunkMetadata,
    saveChunkMetadata,
    getAllChunkMetadata,
    prepareNewCollectionStorage,
    createInitialVectorizationConfig as createImportConfig,
    saveInitialVectorizationConfig as saveImportConfig,
    readInitialVectorizationConfig as readImportConfig,
    verifyPhysicalCollectionExistence,
    ensureStorageLocator,
} from './collection-metadata.js';
import {
    registerCollection,
    getCollectionRegistry,
} from './collection-loader.js';
import { progressTracker } from '../ui/progress-tracker.js';
import { getStringHash } from '../../../../utils.js';
import { withChatCollectionPurgeGuard, withChatCollectionWriteGuard } from './collection-ids.js';
import { getModelField } from './providers.js';
import { getBackend } from '../backends/backend-manager.js';
import { assertStorageWritable, settingsForCollectionStorage } from './storage-resolver.js';
import { stripGeneratedKeywordSuffix } from '../utils/keyword-suffix.js';

// #25: `settings.model` does not exist - each provider stores its model in its
// own field. Comparing or sending an undefined model made export/import treat
// any two models as interchangeable and addressed the wrong Vectra folder.
function providerModel(settings) {
    if (!settings) return '';
    // An explicit `model` (e.g. a per-collection export/import override) wins;
    // otherwise read the provider's own model field.
    if (settings.model != null && String(settings.model) !== '') return String(settings.model);
    const field = getModelField(settings.source);
    const value = field ? settings[field] : null;
    return value == null ? '' : String(value);
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Current export format version */
const EXPORT_VERSION = '1.0.0';

/** File extension for VectHare exports */
export const EXPORT_FILE_EXTENSION = '.vecthare.json';

/** Maximum chunks to export at once (for progress updates) */
const EXPORT_BATCH_SIZE = 100;

// ============================================================================
// EXPORT FUNCTIONS
// ============================================================================

/**
 * Fetches chunks with vectors from the backend
 * @param {string} collectionId - Collection to fetch from
 * @param {object} settings - VectHare settings
 * @returns {Promise<Array>} Chunks with vectors
 */
async function fetchChunksWithVectors(collectionId, settings) {
    const backendName = settings.vector_backend || 'standard';
    const pageSize = 50000;
    const items = [];
    let expected = null;
    // 9c: Qdrant/Milvus collections are read through their adapter, which takes
    // the physical store and scope from the storage resolver. This read went to
    // a store named after the logical id (empty under Qdrant multitenancy,
    // refused by Milvus).
    const adapter = ['qdrant', 'milvus'].includes(backendName) ? await getBackend(settings) : null;
    // #73: one page is not a collection. Follow pagination and require the
    // backend's own reported total, so a truncated listing can never pass as
    // a complete export (or as a complete pre-replacement snapshot, #19).
    for (let page = 0; ; page++) {
        if (adapter) {
            const data = await adapter.listChunks(collectionId, settings,
                { offset: items.length, limit: pageSize, includeVectors: true, strictRead: true });
            if (!data?.success || !Array.isArray(data.items)) throw new Error('Invalid response from chunks API');
            const total = Number(data.total);
            if (!Number.isSafeInteger(total) || total < 0) throw new Error('Chunk listing did not report a usable collection total');
            if (expected === null) expected = total;
            else if (expected !== total) throw new Error('The collection changed while it was being read; listing abandoned');
            items.push(...data.items);
            if (items.length >= expected) break;
            if (data.items.length === 0) throw new Error(`Chunk listing stopped at ${items.length}/${expected} records`);
            continue;
        }
        const response = await fetch('/api/plugins/similharity/chunks/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: backendName === 'standard' ? 'vectra' : backendName,
                collectionId: collectionId,
                source: settings.source || 'transformers',
                model: providerModel(settings),
                offset: items.length,
                limit: pageSize,
                includeVectors: true, // Include the actual embedding vectors
                strictRead: true,     // Require independent completeness evidence
            }),
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch chunks: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        if (!data.success || !Array.isArray(data.items)) {
            throw new Error('Invalid response from chunks API');
        }
        const total = Number(data.total);
        if (!Number.isSafeInteger(total) || total < 0) {
            throw new Error('Chunk listing did not report a usable collection total');
        }
        if (expected === null) expected = total;
        else if (expected !== total) {
            throw new Error('The collection changed while it was being read; listing abandoned');
        }
        items.push(...data.items);
        if (items.length >= expected) break;
        if (data.items.length === 0) {
            throw new Error(`Chunk listing stopped at ${items.length}/${expected} records`);
        }
    }
    if (items.length !== expected) {
        throw new Error(`Incomplete chunk listing: ${items.length}/${expected} records`);
    }

    return items;
}

/**
 * #19: a replacement must never be the only copy. Reads the collection's
 * current chunks WITH their vectors so the caller can restore them if the
 * replacement fails. Throws when the snapshot cannot be proven complete -
 * an unverifiable snapshot must block the replacement, not permit a blind purge.
 * @returns {Promise<object[]|null>} Snapshot chunks, or null for an empty collection
 */
export async function snapshotCollectionForReplace(collectionId, settings) {
    const items = await fetchChunksWithVectors(collectionId, settings);
    if (!items.length) return null;
    const snapshot = items.map(item => {
        const text = item.text ?? item.metadata?.text;
        const vector = item.vector ?? item.metadata?.vector;
        if (typeof text !== 'string' || !Array.isArray(vector) || !vector.length) {
            throw new Error('Existing vectors cannot be snapshotted for rollback');
        }
        const { vector: _v, ...metadata } = item.metadata || {};
        return { hash: item.hash ?? getStringHash(text), text, index: item.index ?? 0, vector, metadata };
    });
    vhLog(`VectHare: Snapshotted ${snapshot.length} chunk(s) of ${collectionId} before replacement`);
    return snapshot;
}

/**
 * #19: puts a pre-replacement snapshot back after a failed replacement.
 * Reports failure instead of throwing, so the original error still surfaces.
 * @returns {Promise<boolean>} Whether every snapshotted chunk was restored
 */
export async function restoreCollectionSnapshot(collectionId, snapshot, settings) {
    if (!snapshot?.length) return true;
    try {
        await insertChunksWithVectors(collectionId, snapshot, settings);
        vhLog(`VectHare: Restored ${snapshot.length} chunk(s) of ${collectionId} after a failed replacement`);
        return true;
    } catch (error) {
        console.error(`VectHare: Could not restore ${collectionId} after a failed replacement:`, error);
        return false;
    }
}

/**
 * Exports a single collection to a portable JSON format (includes vectors)
 * @param {string} collectionId - The collection to export
 * @param {object} settings - VectHare settings
 * @param {object} collectionInfo - Optional collection info (backend, source, model)
 * @returns {Promise<object>} Export data object
 */
export async function exportCollection(collectionId, settings, collectionInfo = {}) {
    const panelRunId = progressTracker.show('Exporting Collection', 3, 'Steps');
    progressTracker.updateCurrentItem(collectionId);

    // Use collection-specific settings if provided (for multi-backend support)
    const exportSettings = {
        ...settings,
        vector_backend: collectionInfo.backend || settings.vector_backend,
        source: collectionInfo.source || settings.source,
        model: collectionInfo.model || providerModel(settings),
    };

    try {
        // Step 1: Get collection metadata
        progressTracker.updateProgress(1, 'Loading metadata...');
        const collectionMeta = getCollectionMeta(collectionId) || {};

        // Step 2: Get all chunks WITH vectors
        progressTracker.updateProgress(2, 'Loading chunks and vectors...');
        const rawChunks = await fetchChunksWithVectors(collectionId, exportSettings);

        const chunks = rawChunks.map(item => {
            const meta = item.metadata || item;
            // #26: a field-by-field copy silently dropped grouping identity
            // (strategy, messageIds, messageHashes) and scene flags, so an
            // import could not reproduce the original chunks. Keep the stored
            // metadata as it is; the embedding is carried separately.
            const { vector: _vectorInMeta, ...fullMetadata } = meta || {};
            const chunk = {
                hash: meta.hash || item.hash,
                // VH-059: the original text, without Qdrant's generated keyword suffix
                text: stripGeneratedKeywordSuffix(meta.text || item.text || '', meta.keywords || item.keywords),
                index: meta.index ?? item.index,
                vector: item.vector || meta.vector || null, // The actual embedding!
                metadata: {
                    ...fullMetadata,
                    contentType: meta.contentType,
                    sourceName: meta.sourceName,
                    entryName: meta.entryName,
                    entryUid: meta.entryUid,
                    keywords: meta.keywords || [],
                    customWeights: meta.customWeights,
                    disabledKeywords: meta.disabledKeywords,
                    keywordLevel: meta.keywordLevel,
                    keywordBaseWeight: meta.keywordBaseWeight,
                    importance: meta.importance,
                    conditions: meta.conditions,
                    chunkGroup: meta.chunkGroup,
                    summary: meta.summary,
                    isSummaryChunk: meta.isSummaryChunk,
                    parentHash: meta.parentHash,
                    speaker: meta.speaker,
                    isUser: meta.isUser,
                    messageId: meta.messageId,
                    vecthareProvenance: meta.vecthareProvenance,
                    vecthareImportedProvenance: meta.vecthareImportedProvenance,
                },
            };

            // Get per-chunk metadata from VectHare settings
            const chunkMeta = getChunkMetadata(chunk.hash, collectionId);
            if (chunkMeta) {
                chunk.chunkMeta = chunkMeta;
            }

            return chunk;
        });

        progressTracker.updateChunks(chunks.length);

        // Step 3: Build export object
        progressTracker.updateProgress(3, 'Building export...');

        // Get vector dimension from first chunk that has a vector
        const sampleVector = chunks.find(c => c.vector)?.vector;
        const vectorDimension = sampleVector ? sampleVector.length : null;
        const chunksWithVectors = chunks.filter(c => c.vector).length;

        const exportData = {
            // Header
            version: EXPORT_VERSION,
            exportDate: new Date().toISOString(),
            generator: 'VectHare',

            // Embedding info - CRITICAL for import compatibility
            // NOTE: source + model must match for vectors to be compatible
            // backend is just storage location - vectors work across backends
            embedding: {
                source: exportSettings.source || 'transformers',
                model: exportSettings.model || '',
                backend: exportSettings.vector_backend || 'standard', // For reference only
                dimension: vectorDimension,
                hasVectors: chunksWithVectors > 0,
            },

            // Collection info
            collection: {
                id: collectionId,
                name: collectionMeta.displayName || collectionId,
                description: collectionMeta.description || '',
                contentType: collectionMeta.contentType || detectContentType(collectionId),
                scope: collectionMeta.scope || 'global',
                tags: collectionMeta.tags || [],
                color: collectionMeta.color,
                createdAt: collectionMeta.createdAt,
            },

            // Settings that affect behavior
            settings: {
                // Activation
                alwaysActive: collectionMeta.alwaysActive || false,
                triggers: collectionMeta.triggers || [],
                triggerMatchMode: collectionMeta.triggerMatchMode || 'any',
                triggerCaseSensitive: collectionMeta.triggerCaseSensitive || false,
                triggerScanDepth: collectionMeta.triggerScanDepth || 5,
                conditions: collectionMeta.conditions || { enabled: false, logic: 'AND', rules: [] },

                // Temporal decay
                temporalDecay: collectionMeta.temporalDecay || {
                    enabled: false,
                    mode: 'exponential',
                    halfLife: 50,
                    linearRate: 0.01,
                    minRelevance: 0.3,
                    sceneAware: false,
                },

                // Chunk groups
                groups: collectionMeta.groups || [],

                // Prompt context
                context: collectionMeta.context || '',
                xmlTag: collectionMeta.xmlTag || '',
            },

            // Chunks (text + metadata + vectors)
            chunks: chunks,

            // Stats
            stats: {
                chunkCount: chunks.length,
                chunksWithVectors,
                hasText: chunks.filter(c => c.text).length,
                hasKeywords: chunks.filter(c => c.metadata?.keywords?.length > 0).length,
            },
        };

        progressTracker.complete(true, `Exported ${chunks.length} chunks`, panelRunId);
        return exportData;

    } catch (error) {
        progressTracker.addError(error.message);
        progressTracker.complete(false, 'Export failed', panelRunId);
        throw error;
    }
}

/**
 * Exports multiple collections to a single file
 * @param {string[]} collectionIds - Collections to export
 * @param {object} settings - VectHare settings
 * @returns {Promise<object>} Export data with multiple collections
 */
export async function exportMultipleCollections(collectionIds, settings) {
    const panelRunId = progressTracker.show('Exporting Collections', collectionIds.length, 'Collections');

    const exports = [];
    const errors = [];

    for (let i = 0; i < collectionIds.length; i++) {
        const collectionId = collectionIds[i];
        progressTracker.updateProgress(i + 1, `Exporting: ${collectionId}`);
        progressTracker.updateCurrentItem(collectionId);

        try {
            // Export without showing nested progress
            const collectionMeta = getCollectionMeta(collectionId) || {};
            const chunksResult = await getSavedHashes(collectionId, settings, true);

            let chunks = [];
            if (chunksResult && chunksResult.metadata) {
                chunks = chunksResult.metadata.map(meta => ({
                    hash: meta.hash,
                    text: stripGeneratedKeywordSuffix(meta.text || '', meta.keywords), // VH-059
                    index: meta.index,
                    metadata: {
                        // #26: keep grouping identity and scene flags too.
                        ...(({ vector: _v, ...rest }) => rest)(meta || {}),
                        contentType: meta.contentType,
                        sourceName: meta.sourceName,
                        entryName: meta.entryName,
                        entryUid: meta.entryUid,
                        keywords: meta.keywords || [],
                        customWeights: meta.customWeights,
                        disabledKeywords: meta.disabledKeywords,
                        keywordLevel: meta.keywordLevel,
                        keywordBaseWeight: meta.keywordBaseWeight,
                        importance: meta.importance,
                        conditions: meta.conditions,
                        chunkGroup: meta.chunkGroup,
                        summary: meta.summary,
                        isSummaryChunk: meta.isSummaryChunk,
                        parentHash: meta.parentHash,
                        speaker: meta.speaker,
                        isUser: meta.isUser,
                        messageId: meta.messageId,
                    },
                }));

                for (const chunk of chunks) {
                    const chunkMeta = getChunkMetadata(chunk.hash, collectionId);
                    if (chunkMeta) {
                        chunk.chunkMeta = chunkMeta;
                    }
                }
            }

            exports.push({
                collection: {
                    id: collectionId,
                    name: collectionMeta.displayName || collectionId,
                    description: collectionMeta.description || '',
                    contentType: collectionMeta.contentType || detectContentType(collectionId),
                    scope: collectionMeta.scope || 'global',
                    tags: collectionMeta.tags || [],
                    color: collectionMeta.color,
                    createdAt: collectionMeta.createdAt,
                },
                settings: {
                    alwaysActive: collectionMeta.alwaysActive || false,
                    triggers: collectionMeta.triggers || [],
                    triggerMatchMode: collectionMeta.triggerMatchMode || 'any',
                    triggerCaseSensitive: collectionMeta.triggerCaseSensitive || false,
                    triggerScanDepth: collectionMeta.triggerScanDepth || 5,
                    conditions: collectionMeta.conditions || { enabled: false, logic: 'AND', rules: [] },
                    temporalDecay: collectionMeta.temporalDecay || {
                        enabled: false,
                        mode: 'exponential',
                        halfLife: 50,
                        linearRate: 0.01,
                        minRelevance: 0.3,
                        sceneAware: false,
                    },
                    groups: collectionMeta.groups || [],
                    context: collectionMeta.context || '',
                    xmlTag: collectionMeta.xmlTag || '',
                },
                chunks: chunks,
                stats: {
                    chunkCount: chunks.length,
                    hasText: chunks.filter(c => c.text).length,
                    hasKeywords: chunks.filter(c => c.metadata?.keywords?.length > 0).length,
                },
            });
        } catch (error) {
            console.error(`VectHare Export: Failed to export ${collectionId}:`, error);
            errors.push({ collectionId, error: error.message });
        }
    }

    progressTracker.complete(errors.length === 0, `Exported ${exports.length}/${collectionIds.length} collections`, panelRunId);

    return {
        version: EXPORT_VERSION,
        exportDate: new Date().toISOString(),
        generator: 'VectHare',
        type: 'multi',
        collections: exports,
        errors: errors,
        stats: {
            totalCollections: exports.length,
            totalChunks: exports.reduce((sum, e) => sum + e.chunks.length, 0),
            failedCollections: errors.length,
        },
    };
}

/**
 * Downloads export data as a JSON file
 * @param {object} exportData - The export data object
 * @param {string} filename - Optional filename (without extension)
 */
export function downloadExport(exportData, filename = null) {
    const defaultName = exportData.type === 'multi'
        ? `vecthare-export-${exportData.stats.totalCollections}-collections`
        : `vecthare-${exportData.collection?.id || 'collection'}`;

    const finalFilename = (filename || defaultName) + EXPORT_FILE_EXTENSION;

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = finalFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    vhLog(`VectHare Export: Downloaded ${finalFilename}`);
}

// ============================================================================
// IMPORT FUNCTIONS
// ============================================================================

/**
 * Validates an import file structure and checks embedding compatibility
 * @param {object} data - Parsed JSON data
 * @param {object} currentSettings - Current VectHare settings (to check compatibility)
 * @returns {{ valid: boolean, errors: string[], warnings: string[], compatible: boolean, embeddingInfo: object }}
 */
export function validateImportData(data, currentSettings = {}) {
    const errors = [];
    const warnings = [];

    // Check version
    if (!data.version) {
        errors.push('Missing version field');
    } else if (!data.version.startsWith('1.')) {
        warnings.push(`Export version ${data.version} may not be fully compatible`);
    }

    // Check for collections
    const isMulti = data.type === 'multi';
    const collections = isMulti ? data.collections : [data];

    if (!collections || collections.length === 0) {
        errors.push('No collections found in export file');
    }

    // Check embedding compatibility
    let embeddingInfo = null;
    let compatible = true;

    for (const col of collections) {
        if (!col.collection?.id) {
            errors.push('Collection missing ID');
        }
        if (!col.chunks || !Array.isArray(col.chunks)) {
            errors.push(`Collection ${col.collection?.id || 'unknown'} has no chunks array`);
        } else {
            const chunksWithoutText = col.chunks.filter(c => !c.text);
            if (chunksWithoutText.length > 0) {
                warnings.push(`${col.collection?.id}: ${chunksWithoutText.length} chunks have no text (will be skipped)`);
            }
        }

        // Check embedding info
        if (col.embedding) {
            embeddingInfo = col.embedding;
            const hasVectors = col.chunks?.some(c => c.vector);

            if (hasVectors && currentSettings.source) {
                // Check if current settings match export
                const sourceMatch = col.embedding.source === currentSettings.source;
                const modelMatch = !col.embedding.model || !currentSettings.model ||
                    col.embedding.model === currentSettings.model;

                if (!sourceMatch || !modelMatch) {
                    compatible = false;
                    warnings.push(
                        `Embedding mismatch: Export used ${col.embedding.source}/${col.embedding.model || 'default'}, ` +
                        `but you're using ${currentSettings.source}/${currentSettings.model || 'default'}. ` +
                        `Switch your settings to match, or vectors will be re-embedded.`
                    );
                }
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
        compatible,
        embeddingInfo,
        stats: {
            collectionCount: collections.length,
            totalChunks: collections.reduce((sum, c) => sum + (c.chunks?.length || 0), 0),
            chunksWithVectors: collections.reduce((sum, c) =>
                sum + (c.chunks?.filter(ch => ch.vector)?.length || 0), 0),
        },
    };
}

/**
 * Inserts chunks directly with pre-computed vectors (bypasses embedding)
 * @param {string} collectionId - Collection to insert into
 * @param {Array} chunks - Chunks with vectors
 * @param {object} settings - VectHare settings
 */
async function insertChunksWithVectors(collectionId, chunks, settings) {
    assertVectHareCollectionForWrite(collectionId);
    const backendName = settings.vector_backend || 'standard';
    if (['qdrant', 'milvus'].includes(backendName)) {
        // 9c: through the adapter (resolver + scope), with the vectors as they are.
        await assertStorageWritable(collectionId, settings);
        const adapter = await getBackend(settings);
        await adapter.insertVectorItems(collectionId, chunks.map(c => ({
            hash: c.hash, text: c.text, index: c.index, vector: c.vector, metadata: c.metadata || {},
            ...(Array.isArray(c.metadata?.keywords) && c.metadata.keywords.length ? { keywords: c.metadata.keywords } : {}), // VH-103
        })), settings);
        return { success: true };
    }
    const response = await fetch('/api/plugins/similharity/chunks/insert', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            backend: backendName === 'standard' ? 'vectra' : backendName,
            collectionId: collectionId,
            source: settings.source || 'transformers',
            model: providerModel(settings),
            items: chunks.map(c => ({
                hash: c.hash,
                text: c.text,
                index: c.index,
                vector: c.vector, // Pre-computed vector!
                metadata: c.metadata || {},
            })),
        }),
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to insert chunks: ${error}`);
    }

    return await response.json();
}

/**
 * VH-059: the hash an imported chunk gets. The exported hash is kept when it is
 * the hash of the (suffix-free) text, so ids, groups, scenes, summaries and the
 * chat ledger keep matching; otherwise the text is re-hashed and links are remapped.
 */
function importHashes(validChunks) {
    const remap = new Map();
    const hashes = validChunks.map(chunk => {
        const text = stripGeneratedKeywordSuffix(chunk.text, chunk.metadata?.keywords || chunk.keywords);
        const computed = getStringHash(text);
        const exported = Number(chunk.hash);
        if (Number.isSafeInteger(exported) && exported !== computed) remap.set(exported, computed);
        chunk.text = text;
        return computed;
    });
    const map = value => (remap.has(Number(value)) ? remap.get(Number(value)) : value);
    return { hashes, remap, map };
}

function remapImportedMetadata(metadata, map) {
    if (!metadata || typeof metadata !== 'object') return metadata;
    const next = { ...metadata };
    if (next.parentHash !== undefined && next.parentHash !== null) next.parentHash = map(next.parentHash);
    if (Array.isArray(next.containedHashes)) next.containedHashes = next.containedHashes.map(map);
    return next;
}

function remapImportedGroups(groups, map) {
    if (!Array.isArray(groups)) return groups;
    return groups.map(group => (group && Array.isArray(group.members)) ? { ...group, members: group.members.map(map) } : group);
}

/**
 * VH-057: an imported collection gets saved settings, like a first vectorization,
 * describing what was just written (reused vectors only when the export's
 * provider/model equal today's, so `settings` describes them either way).
 * Chat collections record today's chat chunking so Sync can go on.
 */
async function recordImportedConfiguration(collectionId, settings) {
    const chunking = /^vecthare_chat_/.test(collectionId)
        ? {
            pipeline: 'sync-chat', // same fields as chat-vectorization's chatConfigChunking()
            strategy: settings.chunking_strategy || 'per_message',
            batchSize: settings.batch_size || 4,
            conversationTurnOrder: settings.conversation_turn_order || 'user_character',
            keywordLevel: settings.keyword_extraction_level || 'balanced',
        }
        : { pipeline: 'content-vectorizer', strategy: 'imported' };
    const storageSettings = settingsForCollectionStorage(collectionId, settings); // where the rows really went
    const snapshot = createImportConfig(storageSettings, chunking);
    if (!snapshot) throw new Error('Could not describe the imported collection\'s settings');
    if (await saveImportConfig(collectionId, snapshot, storageSettings)) return;
    const existing = await readImportConfig(collectionId, storageSettings).catch(() => null);
    if (existing?.status !== 'valid') {
        throw new Error(`The imported collection's saved settings could not be written (${existing?.status || 'unavailable'})`);
    }
}

/**
 * Imports a collection from export data
 * Uses pre-computed vectors if available and settings match, otherwise re-embeds
 *
 * @param {object} exportData - Single collection export data (or one item from multi-export)
 * @param {object} settings - VectHare settings
 * @param {object} options - Import options
 * @param {string} options.collectionId - Override collection ID (for rename/duplicate)
 * @param {boolean} options.overwrite - If true, purge existing collection first
 * @param {boolean} options.forceReembed - If true, re-embed even if vectors exist
 * @returns {Promise<{ success: boolean, collectionId: string, chunkCount: number, usedVectors: boolean, errors: string[] }>}
 */
export async function importCollection(exportData, settings, options = {}) {
    const id = options.collectionId || exportData.collection?.id;
    const guard = options.overwrite ? withChatCollectionPurgeGuard : withChatCollectionWriteGuard;
    return guard(id, () => importCollectionUnlocked(exportData, settings, options));
}

/**
 * VH-046: the Import button. A collection that does not exist here is imported
 * as new (so it gets today's new-collection layout); one that exists is only
 * replaced after `confirmReplace(collectionId)` answers true. When it cannot be
 * checked, nothing is imported.
 * @returns {Promise<object>} importCollection's result, or { success: false, cancelled: true }
 */
export async function importCollectionFromFile(exportData, settings, { confirmReplace } = {}) {
    const collectionId = exportData?.collection?.id;
    if (!collectionId) throw new Error('No collection ID specified');
    const existence = await importTargetExistence(collectionId, settings);
    if (existence.state === 'unverified') {
        throw new Error(`Could not check whether "${collectionId}" already exists here (${existence.reason || 'no answer'}). Nothing was imported; try again.`);
    }
    if (existence.state === 'present') {
        const replace = typeof confirmReplace === 'function' ? await confirmReplace(collectionId) : false;
        if (!replace) return { success: false, cancelled: true, collectionId };
        return importCollection(exportData, settings, { overwrite: true });
    }
    return importCollection(exportData, settings, { overwrite: false });
}

/**
 * VH-047: settings that reach the existing copy of a collection. On backends
 * that keep one folder per provider/model (Standard, LanceDB) the existing copy
 * may sit under the provider it was made with, not today's; it is read, purged
 * and (after a failure) restored there.
 */
async function existingCopySettings(collectionId, settings) {
    const backend = String(settings?.vector_backend || 'standard').toLowerCase();
    if (!['standard', 'vectra', 'lancedb'].includes(backend)) return settings;
    const own = await resolveEmbeddingSettingsForEdit(collectionId, settings);
    return own || settings;
}

/**
 * VH-046: does the import target exist here? A store shared by many collections
 * cannot answer for one of them, so its saved-settings record and stored rows
 * (the same tests a new collection's first write uses) decide there.
 * @returns {Promise<{state: 'present'|'absent'|'unverified', reason?: string}>}
 */
async function importTargetExistence(collectionId, settings) {
    try {
        settings = await existingCopySettings(collectionId, settings); // VH-047
    } catch (error) {
        return { state: 'unverified', reason: error.message };
    }
    const found = await verifyPhysicalCollectionExistence(collectionId, settings);
    if (found.existence !== 'unverified') return { state: found.existence };
    const located = await ensureStorageLocator(collectionId, settings);
    if (['present', 'recorded', 'conflict'].includes(located.status)) return { state: 'present' };
    if (located.status !== 'none') return { state: 'unverified', reason: located.reason || found.reason };
    try {
        const hashes = await getSavedHashes(collectionId, settings);
        if (!Array.isArray(hashes)) return { state: 'unverified', reason: found.reason };
        return { state: hashes.length ? 'present' : 'absent' };
    } catch (error) {
        return { state: 'unverified', reason: error.message };
    }
}

async function importCollectionUnlocked(exportData, settings, options = {}) {
    const sourceCollection = exportData.collection || {};
    const collectionId = options.collectionId || sourceCollection.id;

    if (!collectionId) {
        throw new Error('No collection ID specified');
    }

    // VH-046: "overwrite" of a collection that does not exist here is a new import.
    if (options.overwrite && (await importTargetExistence(collectionId, settings)).state === 'absent') {
        options = { ...options, overwrite: false };
    }
    // 9c: an import into a collection that exists nowhere yet goes to the
    // layout today's switches choose for new collections.
    if (!options.overwrite) settings = await prepareNewCollectionStorage(collectionId, settings);
    const chunks = exportData.chunks || [];
    const validChunks = chunks.filter(c => c.text && c.text.trim());

    if (validChunks.length === 0) {
        throw new Error('No valid chunks to import (all chunks missing text)');
    }

    // Check if we can use pre-computed vectors
    const embeddingInfo = exportData.embedding || {};
    const chunksWithVectors = validChunks.filter(c => c.vector && Array.isArray(c.vector));
    const canUseVectors = !options.forceReembed &&
        chunksWithVectors.length === validChunks.length &&
        embeddingInfo.source === settings.source &&
        // #25: compare the provider's real model field. An unknown model on
        // either side is not proof of compatibility, so vectors are re-embedded.
        Boolean(embeddingInfo.model) && embeddingInfo.model === providerModel(settings);

    const totalSteps = 4;
    const panelRunId = progressTracker.show('Importing Collection', totalSteps, 'Steps');
    progressTracker.updateCurrentItem(collectionId);
    progressTracker.updateChunks(validChunks.length);

    const errors = [];
    let rollback = null;
    let existingSettings = settings;

    try {
        // Step 1: Handle existing collection
        progressTracker.updateProgress(1, 'Preparing collection...');

        if (options.overwrite) {
            // #19: keep a verified copy of what is about to be replaced. A
            // snapshot that cannot be proven complete blocks the overwrite
            // rather than allowing an unrecoverable purge.
            existingSettings = await existingCopySettings(collectionId, settings); // VH-047
            rollback = await snapshotCollectionForReplace(collectionId, existingSettings);
            if (!await purgeVectorIndex(collectionId, existingSettings)) {
                throw new Error(`VectHare Import: Could not safely purge ${collectionId}`);
            }
            vhLog(`VectHare Import: Purged existing collection ${collectionId}`);
        }

        // Step 2: Prepare chunks
        progressTracker.updateProgress(2, 'Preparing chunks...');

        const imported = importHashes(validChunks); // VH-059
        const preparedChunks = validChunks.map((chunk, index) => ({
            text: chunk.text,
            index: chunk.index ?? index,
            hash: imported.hashes[index],
            vector: canUseVectors ? chunk.vector : undefined,
            // VH-103: keywords at the top level too, as fresh vectorization sends
            // them - Qdrant embeds them with the text ("[KEYWORDS: …]"), and
            // imported chunks were embedded without them.
            ...(Array.isArray(chunk.metadata?.keywords) && chunk.metadata.keywords.length ? { keywords: chunk.metadata.keywords } : {}),
            metadata: remapImportedMetadata(metadataForImport(chunk.metadata, collectionId), imported.map),
        }));

        // Preserve imported provenance; new legacy imports get clearly
        // unverified import-origin metadata, never invented message UIDs.
        const provenanceChunks = await addInsertionProvenance(collectionId, preparedChunks,
            { writer: 'import', sourceType: 'import' });

        // Step 3: Insert chunks
        if (canUseVectors) {
            // Direct insert with pre-computed vectors (fast!)
            progressTracker.updateProgress(3, `Inserting ${provenanceChunks.length} chunks (using existing vectors)...`);
            try {
                await insertChunksWithVectors(collectionId, provenanceChunks, settings);
                vhLog(`VectHare Import: Inserted ${provenanceChunks.length} chunks with pre-computed vectors`);
            } catch (error) {
                throw new Error(`Failed to insert chunks: ${error.message}`);
            }
        } else {
            // Need to embed (slow)
            progressTracker.updateProgress(3, `Embedding ${provenanceChunks.length} chunks...`);
            try {
                await insertVectorItems(collectionId, provenanceChunks, settings);
                vhLog(`VectHare Import: Embedded and inserted ${provenanceChunks.length} chunks`);
            } catch (error) {
                throw new Error(`Failed to embed chunks: ${error.message}`);
            }
        }
        await recordImportedConfiguration(collectionId, settings); // VH-057

        // Step 4: Save metadata
        progressTracker.updateProgress(4, 'Saving metadata...');

        // Collection-level metadata
        const importedMeta = {
            enabled: true,
            displayName: sourceCollection.name || collectionId,
            description: sourceCollection.description || '',
            scope: sourceCollection.scope || 'global',
            tags: sourceCollection.tags || [],
            color: sourceCollection.color,
            contentType: sourceCollection.contentType,
            createdAt: new Date().toISOString(),
            importedFrom: exportData.exportDate,
            importedAt: new Date().toISOString(),
        };

        // Merge with exported settings
        if (exportData.settings) {
            Object.assign(importedMeta, {
                alwaysActive: exportData.settings.alwaysActive,
                triggers: exportData.settings.triggers,
                triggerMatchMode: exportData.settings.triggerMatchMode,
                triggerCaseSensitive: exportData.settings.triggerCaseSensitive,
                triggerScanDepth: exportData.settings.triggerScanDepth,
                conditions: exportData.settings.conditions,
                temporalDecay: exportData.settings.temporalDecay,
                groups: remapImportedGroups(exportData.settings.groups || [], imported.map),
                context: exportData.settings.context || '',
                xmlTag: exportData.settings.xmlTag || '',
            });
        }

        setCollectionMeta(collectionId, importedMeta);

        // Per-chunk metadata
        validChunks.forEach((chunk, index) => {
            if (chunk.chunkMeta) saveChunkMetadata(imported.hashes[index], remapImportedMetadata(chunk.chunkMeta, imported.map), collectionId);
        });

        // Register collection
        registerCollection(`${settings.vector_backend || 'standard'}:${settings.source || 'transformers'}:${collectionId}`); // VH-028
        saveSettingsDebounced();

        const statusMsg = canUseVectors
            ? `Imported ${preparedChunks.length} chunks (used existing vectors)`
            : `Imported ${preparedChunks.length} chunks (re-embedded)`;
        progressTracker.complete(true, statusMsg, panelRunId);

        return {
            success: true,
            collectionId,
            chunkCount: preparedChunks.length,
            usedVectors: canUseVectors,
            errors,
        };

    } catch (error) {
        // #19: an overwrite that failed after the purge must not leave the
        // collection empty. Put the snapshot back before reporting the failure.
        if (rollback) {
            const restored = await restoreCollectionSnapshot(collectionId, rollback, existingSettings);
            errors.push(restored
                ? 'Replacement failed; the previous vectors were restored.'
                : 'Replacement failed and the previous vectors could NOT be restored.');
            if (!restored) {
                progressTracker.addError('Previous vectors could not be restored');
            }
        }
        progressTracker.addError(error.message);
        progressTracker.complete(false, 'Import failed', panelRunId);
        throw error;
    }
}

/**
 * Imports multiple collections from a multi-export file
 * @param {object} multiExportData - Multi-collection export data
 * @param {object} settings - VectHare settings
 * @param {object} options - Import options
 * @returns {Promise<{ success: boolean, imported: number, failed: number, results: object[] }>}
 */
export async function importMultipleCollections(multiExportData, settings, options = {}) {
    const collections = multiExportData.collections || [];

    if (collections.length === 0) {
        throw new Error('No collections in export file');
    }

    const panelRunId = progressTracker.show('Importing Collections', collections.length, 'Collections');

    const results = [];
    let imported = 0;
    let failed = 0;

    for (let i = 0; i < collections.length; i++) {
        const exportItem = collections[i];
        const collectionId = exportItem.collection?.id;

        progressTracker.updateProgress(i + 1, `Importing: ${collectionId || 'unknown'}`);
        progressTracker.updateCurrentItem(collectionId || `Collection ${i + 1}`);

        try {
            // Don't show nested progress tracker
            const result = await importCollectionSilent(exportItem, settings, options);
            results.push(result);
            imported++;
        } catch (error) {
            console.error(`VectHare Import: Failed to import ${collectionId}:`, error);
            results.push({
                success: false,
                collectionId,
                error: error.message,
            });
            failed++;
        }
    }

    progressTracker.complete(failed === 0, `Imported ${imported}/${collections.length} collections`, panelRunId);

    return {
        success: failed === 0,
        imported,
        failed,
        results,
    };
}

/**
 * Silent import (no progress tracker) for batch operations
 */
async function importCollectionSilent(exportData, settings, options = {}) {
    const id = options.collectionId || exportData.collection?.id;
    const guard = options.overwrite ? withChatCollectionPurgeGuard : withChatCollectionWriteGuard;
    return guard(id, () => importCollectionSilentUnlocked(exportData, settings, options));
}

async function importCollectionSilentUnlocked(exportData, settings, options = {}) {
    const sourceCollection = exportData.collection || {};
    const collectionId = options.collectionId || sourceCollection.id;

    if (!collectionId) {
        throw new Error('No collection ID specified');
    }

    // VH-046: "overwrite" of a collection that does not exist here is a new import.
    if (options.overwrite && (await importTargetExistence(collectionId, settings)).state === 'absent') {
        options = { ...options, overwrite: false };
    }
    // 9c: an import into a collection that exists nowhere yet goes to the
    // layout today's switches choose for new collections.
    if (!options.overwrite) settings = await prepareNewCollectionStorage(collectionId, settings);
    const chunks = exportData.chunks || [];
    const validChunks = chunks.filter(c => c.text && c.text.trim());

    if (validChunks.length === 0) {
        throw new Error('No valid chunks to import');
    }

    // Check if we can use pre-computed vectors
    const embeddingInfo = exportData.embedding || {};
    const chunksWithVectors = validChunks.filter(c => c.vector && Array.isArray(c.vector));
    const canUseVectors = !options.forceReembed &&
        chunksWithVectors.length === validChunks.length &&
        embeddingInfo.source === settings.source &&
        // #25: compare the provider's real model field. An unknown model on
        // either side is not proof of compatibility, so vectors are re-embedded.
        Boolean(embeddingInfo.model) && embeddingInfo.model === providerModel(settings);

    // Handle existing collection. #19: snapshot first, restore on failure.
    let rollback = null;
    const existingSettings = options.overwrite ? await existingCopySettings(collectionId, settings) : settings; // VH-047
    if (options.overwrite) rollback = await snapshotCollectionForReplace(collectionId, existingSettings);

    try {
    // VH-026: the purge is inside the try, so a purge that fails part-way is rolled back.
    if (options.overwrite && !await purgeVectorIndex(collectionId, existingSettings)) {
        throw new Error(`VectHare Import: Could not safely purge ${collectionId}`);
    }
    // Prepare chunks
    const imported = importHashes(validChunks); // VH-059
    const preparedChunks = validChunks.map((chunk, index) => ({
        text: chunk.text,
        index: chunk.index ?? index,
        hash: imported.hashes[index],
        vector: canUseVectors ? chunk.vector : undefined,
        ...(Array.isArray(chunk.metadata?.keywords) && chunk.metadata.keywords.length ? { keywords: chunk.metadata.keywords } : {}), // VH-103
        metadata: remapImportedMetadata(metadataForImport(chunk.metadata, collectionId), imported.map),
    }));

    const provenanceChunks = await addInsertionProvenance(collectionId, preparedChunks,
        { writer: 'import', sourceType: 'import' });

    // Insert
    if (canUseVectors) {
        await insertChunksWithVectors(collectionId, provenanceChunks, settings);
    } else {
        await insertVectorItems(collectionId, provenanceChunks, settings);
    }
    await recordImportedConfiguration(collectionId, settings); // VH-057

    // Save metadata
    const importedMeta = {
        enabled: true,
        displayName: sourceCollection.name || collectionId,
        description: sourceCollection.description || '',
        scope: sourceCollection.scope || 'global',
        tags: sourceCollection.tags || [],
        color: sourceCollection.color,
        contentType: sourceCollection.contentType,
        createdAt: new Date().toISOString(),
        importedFrom: exportData.exportDate,
        importedAt: new Date().toISOString(),
    };

    if (exportData.settings) {
        Object.assign(importedMeta, {
            alwaysActive: exportData.settings.alwaysActive,
            triggers: exportData.settings.triggers,
            triggerMatchMode: exportData.settings.triggerMatchMode,
            triggerCaseSensitive: exportData.settings.triggerCaseSensitive,
            triggerScanDepth: exportData.settings.triggerScanDepth,
            conditions: exportData.settings.conditions,
            temporalDecay: exportData.settings.temporalDecay,
            groups: remapImportedGroups(exportData.settings.groups || [], imported.map),
            context: exportData.settings.context || '',
            xmlTag: exportData.settings.xmlTag || '',
        });
    }

    setCollectionMeta(collectionId, importedMeta);

    validChunks.forEach((chunk, index) => {
        if (chunk.chunkMeta) saveChunkMetadata(imported.hashes[index], remapImportedMetadata(chunk.chunkMeta, imported.map), collectionId);
    });

    registerCollection(`${settings.vector_backend || 'standard'}:${settings.source || 'transformers'}:${collectionId}`); // VH-028
    saveSettingsDebounced();

    return {
        success: true,
        collectionId,
        chunkCount: preparedChunks.length,
        usedVectors: canUseVectors,
    };
    } catch (error) {
        if (rollback) await restoreCollectionSnapshot(collectionId, rollback, existingSettings);
        throw error;
    }
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Detects content type from collection ID pattern
 * @param {string} collectionId
 * @returns {string}
 */
function detectContentType(collectionId) {
    if (collectionId.startsWith('vecthare_chat_') || collectionId.includes('_chat_')) {
        return 'chat';
    }
    if (collectionId.startsWith('vecthare_lorebook_') || collectionId.includes('lorebook')) {
        return 'lorebook';
    }
    if (collectionId.startsWith('file_') || collectionId.includes('_file_')) {
        return 'file';
    }
    return 'unknown';
}

/**
 * Reads and parses an import file
 * @param {File} file - File object from input
 * @returns {Promise<object>} Parsed JSON data
 */
export async function readImportFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                resolve(data);
            } catch (error) {
                reject(new Error('Invalid JSON file'));
            }
        };

        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsText(file);
    });
}

/**
 * Gets info about an export file without full import
 * @param {object} data - Parsed export data
 * @returns {object} Summary info
 */
export function getExportInfo(data) {
    const isMulti = data.type === 'multi';
    const collections = isMulti ? data.collections : [data];

    // Get embedding info from first collection
    const firstCollection = collections[0] || {};
    const embeddingInfo = firstCollection.embedding || data.embedding || null;

    return {
        version: data.version,
        exportDate: data.exportDate,
        generator: data.generator,
        isMulti,
        collectionCount: collections.length,
        // Embedding info for compatibility check
        embedding: embeddingInfo,
        collections: collections.map(c => ({
            id: c.collection?.id,
            name: c.collection?.name || c.collection?.id,
            contentType: c.collection?.contentType,
            scope: c.collection?.scope,
            chunkCount: c.chunks?.length || 0,
            chunksWithVectors: c.chunks?.filter(ch => ch.vector)?.length || 0,
            hasSettings: !!c.settings,
            embedding: c.embedding,
        })),
        totalChunks: collections.reduce((sum, c) => sum + (c.chunks?.length || 0), 0),
        totalChunksWithVectors: collections.reduce((sum, c) =>
            sum + (c.chunks?.filter(ch => ch.vector)?.length || 0), 0),
    };
}
