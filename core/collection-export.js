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
import { getSavedHashes, insertVectorItems, purgeVectorIndex } from './core-vector-api.js';
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
import { discoverEmbeddingModel, makeCollectionProfile, saveCollectionProfile } from './vectorization-profile.js';
import { getBackend } from '../backends/backend-manager.js';
import { getModelField } from './providers.js';

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
    // A backend may multiplex logical collections inside one physical store.
    // Always use its own scoped listing API, never a bare plugin collection ID.
    const backend = await getBackend(settings);
    if (typeof backend.listChunks !== 'function') throw new Error('Backend does not support exporting complete chunks');
    const chunks=[];
    for(let offset=0;offset<100000;offset+=250) {
        const result=await backend.listChunks(collectionId,settings,{offset,limit:250,includeVectors:true});
        if(!Array.isArray(result?.items)) throw new Error('Chunk export listing failed');
        if(result.items.some(row=>!row.text))throw new Error('Backend cannot export complete chunk text');
        chunks.push(...result.items);
        if(result.items.length<250) return chunks;
    }
    throw new Error('Collection export exceeds safety pagination limit; no partial export produced');
}

/**
 * Exports a single collection to a portable JSON format (includes vectors)
 * @param {string} collectionId - The collection to export
 * @param {object} settings - VectHare settings
 * @param {object} collectionInfo - Optional collection info (backend, source, model)
 * @returns {Promise<object>} Export data object
 */
export async function exportCollection(collectionId, settings, collectionInfo = {}) {
    progressTracker.show('Exporting Collection', 3, 'Steps');
    progressTracker.updateCurrentItem(collectionId);

    // Use collection-specific settings if provided (for multi-backend support)
    const exportSettings = {
        ...settings,
        vector_backend: collectionInfo.backend || settings.vector_backend,
        source: collectionInfo.source || settings.source,
        model: collectionInfo.model || settings.model,
    };

    try {
        // Step 1: Get collection metadata
        progressTracker.updateProgress(1, 'Loading metadata...');
        const collectionMeta = getCollectionMeta(`${exportSettings.vector_backend || 'standard'}:${exportSettings.source || 'transformers'}:${collectionId}`) || {};

        // Step 2: Get all chunks WITH vectors
        progressTracker.updateProgress(2, 'Loading chunks and vectors...');
        const rawChunks = await fetchChunksWithVectors(collectionId, exportSettings);

        const chunks = rawChunks.map(item => {
            const meta = item.metadata || item;
            const chunk = {
                hash: meta.hash ?? item.hash,
                text: meta.text || item.text || '',
                index: meta.index ?? item.index,
                vector: item.vector || meta.vector || null, // The actual embedding!
                metadata: { ...meta, vector: undefined },
            };

            // Get per-chunk metadata from VectHare settings
            const chunkMeta = getChunkMetadata(chunk.hash, `${exportSettings.vector_backend || 'standard'}:${exportSettings.source || 'transformers'}:${collectionId}`);
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
                model: collectionMeta.vectorizationProfile?.embedding?.modelId || exportSettings.model || '',
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

            vectorizationProfile: collectionMeta.vectorizationProfile || null,
            chatChunkManifest: collectionMeta.chatChunkManifest || null,
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

        progressTracker.complete(true, `Exported ${chunks.length} chunks`);
        return exportData;

    } catch (error) {
        progressTracker.addError(error.message);
        progressTracker.complete(false, 'Export failed');
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

    for (let i = 0; i < collectionIds.length; i++) {
        const collectionId = collectionIds[i];
        progressTracker.updateProgress(i + 1, `Exporting: ${collectionId}`);
        progressTracker.updateCurrentItem(collectionId);

        try {
            // Export without showing nested progress
            const collectionMeta = getCollectionMeta(`${settings.vector_backend || 'standard'}:${settings.source || 'transformers'}:${collectionId}`) || {};
            const rawChunks = await fetchChunksWithVectors(collectionId, settings);
            const chunks = rawChunks.map(item => {
                const meta=item.metadata || item;
                const chunk = {
                    hash:meta.hash ?? item.hash,
                    text:meta.text ?? item.text ?? '',
                    index:meta.index ?? item.index,
                    vector:item.vector || meta.vector || null,
                    metadata:{...meta,vector:undefined},
                };
                const chunkMeta=getChunkMetadata(chunk.hash, `${settings.vector_backend || 'standard'}:${settings.source || 'transformers'}:${collectionId}`);
                if(chunkMeta)chunk.chunkMeta=chunkMeta;
                return chunk;
            });

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
                vectorizationProfile: collectionMeta.vectorizationProfile || null,
                chatChunkManifest: collectionMeta.chatChunkManifest || null,
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

    progressTracker.complete(errors.length === 0, `Exported ${exports.length}/${collectionIds.length} collections`);

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
                const field = getModelField(currentSettings.source);
                const activeModel = field ? currentSettings[field] : currentSettings.model;
                const modelMatch = !!col.vectorizationProfile?.embedding?.verified && !!activeModel && col.vectorizationProfile.embedding.modelId === activeModel;

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
    // Route through the selected backend so Qdrant shared-collection imports
    // acquire the mandatory content_type tenant filter and UUID point IDs.
    // Pre-computed vectors are passed through without embedding them again.
    const backend=await getBackend(settings);
    for(let i=0;i<chunks.length;i+=100) {
        await backend.insertVectorItems(collectionId,chunks.slice(i,i+100),settings);
    }
    return {success:true,count:chunks.length};
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
    const sourceCollection = exportData.collection || {};
    const collectionId = options.collectionId || sourceCollection.id;

    if (!collectionId) {
        throw new Error('No collection ID specified');
    }

    const chunks = exportData.chunks || [];
    const validChunks = chunks.filter(c => c.text && c.text.trim());

    if (validChunks.length === 0) {
        throw new Error('No valid chunks to import (all chunks missing text)');
    }

    // Check if we can use pre-computed vectors
    const embeddingInfo = exportData.embedding || {};
    const chunksWithVectors = validChunks.filter(c => c.vector && Array.isArray(c.vector));
    const actualModel=await discoverEmbeddingModel(settings);
    const originalProfile=exportData.vectorizationProfile;
    const canUseVectors = !options.forceReembed &&
        chunksWithVectors.length === validChunks.length &&
        originalProfile?.embedding?.verified === true && actualModel.verified &&
        originalProfile.embedding.provider === settings.source &&
        originalProfile.embedding.modelId === actualModel.modelId &&
        (!originalProfile.embedding.modelPath || !actualModel.modelPath || originalProfile.embedding.modelPath === actualModel.modelPath);
    if(!canUseVectors && !options.forceReembed && chunksWithVectors.length) {
        throw new Error('Imported vectors cannot be verified compatible with the active embedding model. Explicitly choose re-vectorization or restore the original model first.');
    }

    const totalSteps = 4;
    progressTracker.show('Importing Collection', totalSteps, 'Steps');
    progressTracker.updateCurrentItem(collectionId);
    progressTracker.updateChunks(validChunks.length);

    const errors = [];

    try {
        // Step 1: Handle existing collection
        progressTracker.updateProgress(1, 'Preparing collection...');

        if (options.overwrite) {
            try {
                if (await purgeVectorIndex(collectionId, settings) !== true) {
                    throw new Error(`Existing collection ${collectionId} was not safely deleted`);
                }
                console.log(`VectHare Import: Purged existing collection ${collectionId}`);
            } catch (e) {
                throw new Error(`Import overwrite aborted: ${e.message}`);
            }
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

        // Step 3: Insert chunks
        if (canUseVectors) {
            // Direct insert with pre-computed vectors (fast!)
            progressTracker.updateProgress(3, `Inserting ${preparedChunks.length} chunks (using existing vectors)...`);
            try {
                await insertChunksWithVectors(collectionId, preparedChunks, settings);
                console.log(`VectHare Import: Inserted ${preparedChunks.length} chunks with pre-computed vectors`);
            } catch (error) {
                throw new Error(`Failed to insert chunks: ${error.message}`);
            }
        } else {
            // Need to embed (slow)
            progressTracker.updateProgress(3, `Embedding ${preparedChunks.length} chunks...`);
            try {
                await insertVectorItems(collectionId, preparedChunks, settings);
                console.log(`VectHare Import: Embedded and inserted ${preparedChunks.length} chunks`);
            } catch (error) {
                throw new Error(`Failed to embed chunks: ${error.message}`);
            }
        }

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
                groups: exportData.settings.groups || [],
                context: exportData.settings.context || '',
                xmlTag: exportData.settings.xmlTag || '',
            });
        }

        importedMeta.vectorizationProfile = canUseVectors ? originalProfile : await makeCollectionProfile(settings);
        if(exportData.chatChunkManifest?.schemaVersion===1) importedMeta.chatChunkManifest = exportData.chatChunkManifest;
        setCollectionMeta(`${settings.vector_backend || 'standard'}:${settings.source || 'transformers'}:${collectionId}`, importedMeta);
        // Persist the validated profile + imported manifest in both ST metadata
        // and the plugin sidecar. Otherwise a fresh install cannot verify it.
        if(importedMeta.vectorizationProfile) await saveCollectionProfile(`${settings.vector_backend || 'standard'}:${settings.source || 'transformers'}:${collectionId}`, importedMeta.vectorizationProfile);

        // Per-chunk metadata
        for (const chunk of validChunks) {
            if (chunk.chunkMeta) {
                const newHash = getStringHash(chunk.text);
                saveChunkMetadata(newHash, chunk.chunkMeta, `${settings.vector_backend || 'standard'}:${settings.source || 'transformers'}:${collectionId}`);
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
    const collections = multiExportData.collections || [];

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
    const sourceCollection = exportData.collection || {};
    const collectionId = options.collectionId || sourceCollection.id;

    if (!collectionId) {
        throw new Error('No collection ID specified');
    }

    const chunks = exportData.chunks || [];
    const validChunks = chunks.filter(c => c.text && c.text.trim());

    if (validChunks.length === 0) {
        throw new Error('No valid chunks to import');
    }

    // Check if we can use pre-computed vectors
    const embeddingInfo = exportData.embedding || {};
    const chunksWithVectors = validChunks.filter(c => c.vector && Array.isArray(c.vector));
    const actualModel=await discoverEmbeddingModel(settings);
    const originalProfile=exportData.vectorizationProfile;
    const canUseVectors = !options.forceReembed &&
        chunksWithVectors.length === validChunks.length &&
        originalProfile?.embedding?.verified === true && actualModel.verified &&
        originalProfile.embedding.provider === settings.source &&
        originalProfile.embedding.modelId === actualModel.modelId &&
        (!originalProfile.embedding.modelPath || !actualModel.modelPath || originalProfile.embedding.modelPath === actualModel.modelPath);
    if(!canUseVectors && !options.forceReembed && chunksWithVectors.length) {
        throw new Error('Imported vectors cannot be verified compatible with the active embedding model. Explicitly choose re-vectorization or restore the original model first.');
    }

    // Handle existing collection
    if (options.overwrite) {
        try {
            if (await purgeVectorIndex(collectionId, settings) !== true) {
                throw new Error(`Existing collection ${collectionId} was not safely deleted`);
            }
        } catch (e) {
            throw new Error(`Import overwrite aborted: ${e.message}`);
        }
    }

    // Prepare chunks
    const preparedChunks = validChunks.map((chunk, index) => ({
        text: chunk.text,
        index: chunk.index ?? index,
        hash: getStringHash(chunk.text),
        vector: canUseVectors ? chunk.vector : undefined,
        metadata: chunk.metadata || {},
    }));

    // Insert
    if (canUseVectors) {
        await insertChunksWithVectors(collectionId, preparedChunks, settings);
    } else {
        await insertVectorItems(collectionId, preparedChunks, settings);
    }

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
            groups: exportData.settings.groups || [],
            context: exportData.settings.context || '',
            xmlTag: exportData.settings.xmlTag || '',
        });
    }

    importedMeta.vectorizationProfile = canUseVectors ? originalProfile : await makeCollectionProfile(settings);
    if(exportData.chatChunkManifest?.schemaVersion===1) importedMeta.chatChunkManifest=exportData.chatChunkManifest;
    setCollectionMeta(`${settings.vector_backend || 'standard'}:${settings.source || 'transformers'}:${collectionId}`, importedMeta);
    if(importedMeta.vectorizationProfile) await saveCollectionProfile(`${settings.vector_backend || 'standard'}:${settings.source || 'transformers'}:${collectionId}`, importedMeta.vectorizationProfile);

    for (const chunk of validChunks) {
        if (chunk.chunkMeta) {
            const newHash = getStringHash(chunk.text);
            saveChunkMetadata(newHash, chunk.chunkMeta, `${settings.vector_backend || 'standard'}:${settings.source || 'transformers'}:${collectionId}`);
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
