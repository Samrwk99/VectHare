import {redactSecrets} from '../utils/security.js';
import {quarantineImportedOwnership} from '../utils/c04-ownership.js';
import {adapterCollectionId} from '../utils/tenant-route.js';
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
 * @version 1.0.0
 * ============================================================================
 */

import { extension_settings } from '../../../../extensions.js';
import { getRequestHeaders, saveSettingsDebounced } from '../../../../../script.js';
import { getSavedHashes, insertVectorItems, purgeVectorIndex, replaceVectorRecords } from './core-vector-api.js';
import {
    getCollectionMeta,
    setCollectionMeta,
    getChunkMetadata,
    saveChunkMetadata,
    getAllChunkMetadata,
} from './collection-metadata.js';
import {
    registerCollection,
    getCollectionRegistry,
} from './collection-loader.js';
import { progressTracker } from '../ui/progress-tracker.js';
import { getStringHash } from '../../../../utils.js';
import { getConfiguredEmbeddingModel } from './providers.js';

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
    // A qualified key must never be forwarded as a physical collection name,
    // and cannot be silently re-routed to a different backend.
    const physicalId=adapterCollectionId(collectionId,backendName,settings.source || 'transformers');
    const response = await fetch('/api/plugins/similharity/chunks/list', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            backend: backendName === 'standard' ? 'vectra' : backendName,
            collectionId: physicalId,
            source: settings.source || 'transformers',
            model: settings.model || getConfiguredEmbeddingModel(settings),
            limit: 50000, // High limit to get all chunks
            includeVectors: true, // Include the actual embedding vectors
        }),
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch chunks: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    if (data?.success !== true || !Array.isArray(data.items)) {
        throw new Error('Invalid response from chunks API');
    }
    // A server that hits the legacy cap may have silently truncated an export.
    // Refuse to create a purported backup from capped data. The full paginated
    // exporter (C11 final) will replace this path after its server contract is pinned.
    if (data.items.length >= 50000) {
        throw new Error('Collection export refused: reached 50,000-record API cap; complete paginated export is not yet available');
    }
    return data.items;
}

/** Preserve all supported search, scene and group fields in exported chunk metadata. */
const EXPORTED_CHUNK_FIELDS = [
    'contentType', 'sourceName', 'entryName', 'entryUid', 'keywords', 'customWeights',
    'disabledKeywords', 'keywordLevel', 'keywordBaseWeight', 'importance', 'conditions',
    'chunkGroup', 'summary', 'isSummaryChunk', 'parentHash', 'speaker', 'isUser',
    'messageId', 'messageIds', 'messageHashes', 'startIndex', 'endIndex', 'strategy',
    'recordId', 'logicalGroupIds', 'contentFingerprint', 'messageRef', 'messageRefs', 'speakers', 'sceneStartRef', 'sceneEndRef',
    'chunkingStrategy', 'isScene', 'sceneStart', 'sceneEnd', 'sceneId', 'sceneIndex',
    'groupId', 'parentId', 'linkedChunks', 'linkedHashes', 'isGrouped',
];
function exportChunkMetadata(meta) {
    return Object.fromEntries(EXPORTED_CHUNK_FIELDS
        .filter(key => meta[key] !== undefined)
        .map(key => [key, meta[key]]));
}

const BACKUP_SETTINGS_FIELDS = [
    'enabled', 'lockMode', 'forceMode', 'exclusiveWhenActive', 'exclusiveScope',
    'alwaysActive', 'triggers', 'triggerMatchMode', 'triggerCaseSensitive',
    'lockedToChatIds','lockedToChatId','lockedToCharacterIds','originChatId','originCharacterId',
    'triggerScanDepth', 'conditions', 'temporalDecay', 'groups', 'context', 'xmlTag',
];
function exportBehaviorSettings(meta) {
    return Object.fromEntries(BACKUP_SETTINGS_FIELDS
        .filter(key => meta[key] !== undefined)
        .map(key => [key, meta[key]]));
}
function importBehaviorSettings(settings) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return {};
    return Object.fromEntries(BACKUP_SETTINGS_FIELDS
        .filter(key => Object.hasOwn(settings, key) && settings[key] !== undefined)
        .map(key => [key, settings[key]]));
}

/** Validate vectors as a *whole* before permitting any direct-vector insertion. */
export function validatePrecomputedVectors(chunks, embedding = {}) {
    if (!Array.isArray(chunks)) return { valid: false, reason: 'Invalid chunks array' };
    const withVectors = chunks.filter(chunk => chunk.vector !== undefined && chunk.vector !== null);
    if (withVectors.length === 0) return { valid: true, dimension: null, count: 0 };
    if (!chunks.every(chunk => Array.isArray(chunk.vector))) {
        return { valid: false, reason: 'Incomplete precomputed vectors' };
    }
    const expected = embedding.dimension ?? chunks[0].vector.length;
    if (!Number.isSafeInteger(expected) || expected <= 0) {
        return { valid: false, reason: 'Invalid embedding dimension' };
    }
    if (!chunks.every(chunk => chunk.vector.length === expected &&
        chunk.vector.every(n => typeof n === 'number' && Number.isFinite(n)))) {
        return { valid: false, reason: 'Precomputed vectors have inconsistent dimensions or non-finite values' };
    }
    return { valid: true, dimension: expected, count: chunks.length };
}

function assertCollectionShape(exportData) {
    if (!exportData || typeof exportData !== 'object' || Array.isArray(exportData) ||
        !exportData.collection || typeof exportData.collection.id !== 'string' ||
        !exportData.collection.id.trim() || !Array.isArray(exportData.chunks) ||
        exportData.chunks.some(c => !c || typeof c !== 'object' || Array.isArray(c) ||
            typeof c.text !== 'string')) {
        throw new Error('Invalid collection backup structure');
    }
}

/**
 * Exports a single collection to a portable JSON format (includes vectors)
 * @param {string} collectionId - The collection to export
 * @param {object} settings - VectHare settings
 * @param {object} collectionInfo - Optional collection info (backend, source, model)
 * @returns {Promise<object>} Export data object
 */
export async function exportCollection(collectionId, settings, collectionInfo = {}, { silent = false } = {}) {
    if (!silent) progressTracker.show('Exporting Collection', 3, 'Steps');
    if (!silent) progressTracker.updateCurrentItem(collectionId);

    // Use collection-specific settings if provided (for multi-backend support)
    const exportSettings = {
        ...settings,
        vector_backend: collectionInfo.backend || settings.vector_backend,
        source: collectionInfo.source || settings.source,
        model: collectionInfo.model || getConfiguredEmbeddingModel(settings, collectionInfo.source || settings.source),
    };

    try {
        // Step 1: Get collection metadata
        if (!silent) progressTracker.updateProgress(1, 'Loading metadata...');
        const collectionMeta = getCollectionMeta(collectionId) || {};

        // Step 2: Get all chunks WITH vectors
        if (!silent) progressTracker.updateProgress(2, 'Loading chunks and vectors...');
        const rawChunks = await fetchChunksWithVectors(collectionId, exportSettings);

        const chunks = rawChunks.map(item => {
            const meta = { ...item, ...(item.metadata || {}) };
            const chunk = {
                hash: item.hash ?? meta.hash,
                text: item.text ?? meta.text ?? '',
                index: item.index ?? meta.index,
                vector: item.vector ?? meta.vector ?? null, // The actual embedding!
                metadata: exportChunkMetadata(meta),
            };

            // Get per-chunk metadata from VectHare settings
            const chunkMeta = getChunkMetadata(chunk.hash);
            if (chunkMeta) {
                chunk.chunkMeta = chunkMeta;
            }

            return chunk;
        });

        if (!silent) progressTracker.updateChunks(chunks.length);

        // Step 3: Build export object
        if (!silent) progressTracker.updateProgress(3, 'Building export...');

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
            settings: exportBehaviorSettings(collectionMeta),

            // Chunks (text + metadata + vectors)
            chunks: chunks,

            // Stats
            stats: {
                chunkCount: chunks.length,
                inventoryComplete: false, // legacy uncapped API has no verified end-of-list receipt
                inventoryStatus: 'unverified',
                chunksWithVectors,
                hasText: chunks.filter(c => c.text).length,
                hasKeywords: chunks.filter(c => c.metadata?.keywords?.length > 0).length,
            },
        };

        if (!silent) progressTracker.complete(true, `Exported ${chunks.length} listed chunks (completeness unverified)`);
        return exportData;

    } catch (error) {
        if (!silent) progressTracker.addError(error.message);
        if (!silent) progressTracker.complete(false, 'Export failed');
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
    progressTracker.show('Exporting Collections', collectionIds.length, 'Collections');
    const exports = [];
    const errors = [];
    const registry = getCollectionRegistry();
    for (let i = 0; i < collectionIds.length; i++) {
        const collectionId = collectionIds[i];
        progressTracker.updateProgress(i + 1, `Exporting: ${collectionId}`);
        progressTracker.updateCurrentItem(collectionId);
        try {
            // Share the exact vector/metadata export path with single-collection backup.
            const info = Array.isArray(registry) ? registry.find(c =>
                (typeof c === 'string' ? c : c.id || c.collectionId) === collectionId) :
                registry?.[collectionId];
            exports.push(await exportCollection(collectionId, settings,
                info && typeof info === 'object' ? info : {}, { silent: true }));
        } catch (error) {
            errors.push({ collectionId, error: error.message });
        }
    }
    progressTracker.complete(errors.length === 0,
        `Exported ${exports.length}/${collectionIds.length} collections`);
    return {
        version: EXPORT_VERSION,
        exportDate: new Date().toISOString(),
        generator: 'VectHare',
        type: 'multi',
        collections: exports,
        errors,
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

    if (exportData?.stats?.inventoryComplete === false ||
        exportData?.collections?.some(c=>c?.stats?.inventoryComplete===false)) {
        console.warn('VectHare: export inventory completeness is unverified; do not use this as a complete backup');
    }
    const blob = new Blob([JSON.stringify(redactSecrets(exportData), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = finalFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log(`VectHare Export: Downloaded ${finalFilename}`);
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
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { valid: false, errors: ['Backup must be a JSON object'], warnings,
            compatible: false, embeddingInfo: null,
            stats: { collectionCount: 0, totalChunks: 0, chunksWithVectors: 0 } };
    }
    if (typeof data.version !== 'string' || !data.version) {
        errors.push('Missing or invalid version field');
    } else if (!data.version.startsWith('1.')) {
        warnings.push(`Export version ${data.version} may not be fully compatible`);
    }
    const isMulti = data.type === 'multi';
    const collections = isMulti ? data.collections : [data];
    if (!Array.isArray(collections) || collections.length === 0) {
        errors.push('No valid collections array found in export file');
    }
    const safeCollections = Array.isArray(collections) ? collections : [];
    let compatible = true;
    let embeddingInfo = null;
    let totalChunks = 0;
    let chunksWithVectors = 0;
    for (const [i, col] of safeCollections.entries()) {
        if (!col || typeof col !== 'object' || Array.isArray(col)) {
            errors.push(`Collection ${i + 1} must be an object`);
            continue;
        }
        const id = col.collection?.id;
        if (typeof id !== 'string' || !id.trim()) errors.push(`Collection ${i + 1} missing valid ID`);
        if (!Array.isArray(col.chunks)) {
            errors.push(`Collection ${id || i + 1} has no chunks array`);
            continue;
        }
        totalChunks += col.chunks.length;
        let withoutText = 0;
        const validChunks = [];
        for (const [j, chunk] of col.chunks.entries()) {
            if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk) || typeof chunk.text !== 'string') {
                errors.push(`Collection ${id || i + 1} chunk ${j + 1} has invalid text or structure`);
            } else {
                validChunks.push(chunk);
                if (!chunk.text.trim()) withoutText++;
                if (chunk.vector !== undefined && chunk.vector !== null) chunksWithVectors++;
            }
        }
        if (withoutText) warnings.push(`${id || i + 1}: ${withoutText} chunks have no text (will be skipped)`);
        const embedding = col.embedding || data.embedding || {};
        if (col.embedding || data.embedding) embeddingInfo = embedding;
        const usable = validChunks.filter(c => c.text.trim());
        const vectors = validatePrecomputedVectors(usable, embedding);
        if (!vectors.valid) {
            errors.push(`${id || i + 1}: ${vectors.reason}`);
        }
        if (vectors.count && currentSettings.source) {
            const sourceMatch = embedding.source === currentSettings.source;
            const currentModel = getConfiguredEmbeddingModel(currentSettings);
            const modelMatch = (embedding.model || '') === currentModel;
            if (!sourceMatch || !modelMatch) {
                compatible = false;
                warnings.push(`Embedding mismatch for ${id}: export used ${embedding.source}/${embedding.model || 'default'}; current settings use ${currentSettings.source}/${currentSettings.model || 'default'}. Vectors will be re-embedded.`);
            }
        }
    }
    return { valid: errors.length === 0, errors, warnings, compatible,
        embeddingInfo, stats: { collectionCount: safeCollections.length,
            totalChunks, chunksWithVectors } };
}

/**
 * Inserts chunks directly with pre-computed vectors (bypasses embedding)
 * @param {string} collectionId - Collection to insert into
 * @param {Array} chunks - Chunks with vectors
 * @param {object} settings - VectHare settings
 */
async function insertChunksWithVectors(collectionId, chunks, settings) {
    const backendName = settings.vector_backend || 'standard';
    const response = await fetch('/api/plugins/similharity/chunks/insert', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            backend: backendName === 'standard' ? 'vectra' : backendName,
            collectionId: adapterCollectionId(collectionId,backendName,settings.source || 'transformers'),
            source: settings.source || 'transformers',
            model: getConfiguredEmbeddingModel(settings),
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

    const result = await response.json();
    if (!result || result.success !== true || result.error ||
        (typeof result.inserted === 'number' && result.inserted !== chunks.length)) {
        throw new Error(result?.error || 'Server did not confirm all imported vector writes');
    }
    return result;
}

/** C02: stage a single import in the durable ID-only journal before any
 * backend write. Never call metadata/register on an unverified result. */
async function stageC02Import(collectionId,preparedChunks,settings,canUseVectors){
    const result=await replaceVectorRecords(collectionId,[],preparedChunks,settings,{
        kind:'import',
        ...(canUseVectors ? {upsertOverride:items=>insertChunksWithVectors(collectionId,items,settings)} : {}),
    });
    if(result?.status!=='committed'){
        const id=result?.operationId ? ` (operation ${result.operationId})`:'';
        throw new Error(`Import requires reconciliation${id}; metadata not activated and existing records preserved`);
    }
    return result;
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
    assertCollectionShape(exportData);
    const sourceCollection = exportData.collection || {};
    const collectionId = options.collectionId || sourceCollection.id;

    if (!collectionId) {
        throw new Error('No collection ID specified');
    }

    const chunks = exportData.chunks || [];
    const validChunks = chunks.filter(c => c.text && c.text.trim());

    if (validChunks.length === 0 && chunks.length !== 0) {
        throw new Error('No valid chunks to import (all chunks missing text)');
    }

    // Check if we can use pre-computed vectors
    const embeddingInfo = exportData.embedding || {};
    const chunksWithVectors = validChunks.filter(c => c.vector && Array.isArray(c.vector));
    const vectorValidation = validatePrecomputedVectors(validChunks, embeddingInfo);
    if (!vectorValidation.valid) throw new Error(vectorValidation.reason);
    const canUseVectors = !options.forceReembed &&
        chunksWithVectors.length > 0 && chunksWithVectors.length === validChunks.length &&
        embeddingInfo.source === settings.source &&
        (embeddingInfo.model || '') === getConfiguredEmbeddingModel(settings);

    const totalSteps = 4;
    progressTracker.show('Importing Collection', totalSteps, 'Steps');
    progressTracker.updateCurrentItem(collectionId);
    progressTracker.updateChunks(validChunks.length);

    const errors = [];

    try {
        // Step 1: Handle existing collection
        progressTracker.updateProgress(1, 'Preparing collection...');

        if (options.overwrite) {
            throw new Error('Overwrite blocked: full collection inventory and verified purge acknowledgement unavailable; originals preserved');
        }

        // Step 2: Prepare chunks
        progressTracker.updateProgress(2, 'Preparing chunks...');

        const preparedChunks = validChunks.map((chunk, index) => ({
            text: chunk.text,
            index: chunk.index ?? index,
            hash: getStringHash(chunk.text),
            vector: canUseVectors ? chunk.vector : undefined,
            metadata: chunk.metadata || {},
        }));

        if(new Map(preparedChunks.map(c=>[String(c.hash),c.text])).size!==preparedChunks.length)
            throw new Error('Import contains duplicate content hashes; explicit deduplication and collision review required');

        // Step 3: journal every non-empty import before the first write. A
        // non-authoritative ACK cannot grant a successful import or activation.
        progressTracker.updateProgress(3, 'Journalled import (verification required)...');
        if(preparedChunks.length)await stageC02Import(collectionId,preparedChunks,settings,canUseVectors);

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
            Object.assign(importedMeta, importBehaviorSettings(exportData.settings));
        }

        // C04-B: file-supplied identity, locks and enabled flags are not
        // verified authorization. Restore disabled until explicit owner remap.
        setCollectionMeta(collectionId, quarantineImportedOwnership(importedMeta, {
            ...options.verifiedOwnershipRemap, requireRemapApproval:true,
        }));

        // Per-chunk metadata
        for (const chunk of validChunks) {
            if (chunk.chunkMeta) {
                const newHash = getStringHash(chunk.text);
                saveChunkMetadata(newHash, chunk.chunkMeta);
            }
        }

        // Register collection
        registerCollection(collectionId);
        saveSettingsDebounced();

        const statusMsg = canUseVectors
            ? `Imported ${preparedChunks.length} chunks (used existing vectors)`
            : `Imported ${preparedChunks.length} chunks (re-embedded)`;
        progressTracker.complete(true, statusMsg);

        return {
            success: true,
            collectionId,
            chunkCount: preparedChunks.length,
            usedVectors: canUseVectors,
            errors,
        };

    } catch (error) {
        progressTracker.addError(error.message);
        progressTracker.complete(false, 'Import failed');
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
    if (!multiExportData || !Array.isArray(multiExportData.collections)) {
        throw new Error('Invalid multi-collection backup');
    }
    if (options.collectionId && multiExportData.collections.length > 1) {
        throw new Error('A single collection ID override cannot be used for multiple collections');
    }
    const collections = multiExportData.collections;

    if (collections.length === 0) {
        throw new Error('No collections in export file');
    }

    progressTracker.show('Importing Collections', collections.length, 'Collections');

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
            const itemWithEmbedding = exportItem.embedding ? exportItem :
                { ...exportItem, embedding: multiExportData.embedding };
            const result = await importCollectionSilent(itemWithEmbedding, settings, options);
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

    progressTracker.complete(failed === 0, `Imported ${imported}/${collections.length} collections`);

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
    assertCollectionShape(exportData);
    const sourceCollection = exportData.collection || {};
    const collectionId = options.collectionId || sourceCollection.id;

    if (!collectionId) {
        throw new Error('No collection ID specified');
    }

    const chunks = exportData.chunks || [];
    const validChunks = chunks.filter(c => c.text && c.text.trim());

    if (validChunks.length === 0 && chunks.length !== 0) {
        throw new Error('No valid chunks to import');
    }

    // Check if we can use pre-computed vectors
    const embeddingInfo = exportData.embedding || {};
    const chunksWithVectors = validChunks.filter(c => c.vector && Array.isArray(c.vector));
    const vectorValidation = validatePrecomputedVectors(validChunks, embeddingInfo);
    if (!vectorValidation.valid) throw new Error(vectorValidation.reason);
    const canUseVectors = !options.forceReembed &&
        chunksWithVectors.length > 0 && chunksWithVectors.length === validChunks.length &&
        embeddingInfo.source === settings.source &&
        (embeddingInfo.model || '') === getConfiguredEmbeddingModel(settings);

    // Handle existing collection
    if (options.overwrite) {
        throw new Error('Overwrite blocked: full collection inventory and verified purge acknowledgement unavailable; originals preserved');
    }

    // Prepare chunks
    const preparedChunks = validChunks.map((chunk, index) => ({
        text: chunk.text,
        index: chunk.index ?? index,
        hash: getStringHash(chunk.text),
        vector: canUseVectors ? chunk.vector : undefined,
        metadata: chunk.metadata || {},
    }));

    if(new Map(preparedChunks.map(c=>[String(c.hash),c.text])).size!==preparedChunks.length)
        throw new Error('Import contains duplicate content hashes; review required');

    // C02: abort before metadata registration if writes are uncertain.
    if(preparedChunks.length)await stageC02Import(collectionId,preparedChunks,settings,canUseVectors);

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
        Object.assign(importedMeta, importBehaviorSettings(exportData.settings));
    }

    setCollectionMeta(collectionId, quarantineImportedOwnership(importedMeta, {
        ...options.verifiedOwnershipRemap, requireRemapApproval:true,
    }));

    for (const chunk of validChunks) {
        if (chunk.chunkMeta) {
            const newHash = getStringHash(chunk.text);
            saveChunkMetadata(newHash, chunk.chunkMeta);
        }
    }

    registerCollection(collectionId);
    saveSettingsDebounced();

    return {
        success: true,
        collectionId,
        chunkCount: preparedChunks.length,
        usedVectors: canUseVectors,
    };
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
    const validation = validateImportData(data);
    if (!validation.valid) throw new Error(`Invalid export: ${validation.errors.join('; ')}`);
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
