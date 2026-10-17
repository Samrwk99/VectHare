import { saveVectHareSettingsDebounced as saveSettingsDebounced } from './settings-durability.js';
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
import { getRequestHeaders } from '../../../../../script.js';
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
import { assignOccurrenceIds } from './chunk-identity.js';
import { parseRegistryKey } from './collection-ids.js';
import { settingsForCollectionQuery, hydrateChatChunkManifest, getChatChunkManifest, collectionPreferenceSnapshot } from './vectorization-profile.js';
import { discoverEmbeddingModel, makeCollectionProfile, saveCollectionProfile } from './vectorization-profile.js';
import { getBackend } from '../backends/backend-manager.js';
import { getModelField } from './providers.js';
import { getChatBinding, getCollectionOwner, bindChatCollection } from './collection-ownership.js';
import { assertQdrantIdentity, claimQdrantIdentity } from './physical-identity.js';
import {hasActiveVectorWrite,createOperationControl,detachOperationControl} from '../ui/operation-controls.js';

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

    // Resolve the EXACT backend/provider identity before exporting vectors.
    const parsedExport=parseRegistryKey(collectionId);
    const logicalId=parsedExport.collectionId;
    const exportRegistryKey=parsedExport.backend?collectionId:
        `${collectionInfo.backend||settings.vector_backend||'standard'}:${collectionInfo.source||settings.source||'transformers'}:${collectionId}`;
    collectionId=logicalId;
    // Use collection-specific settings if provided (for multi-backend support)
    const exportSettings = {
        ...settings,
        vector_backend: collectionInfo.backend || settings.vector_backend,
        source: collectionInfo.source || settings.source,
        model: collectionInfo.model || settings.model,
    };

    try {
        const ownSettings=settingsForCollectionQuery(exportRegistryKey,exportSettings);
        Object.assign(exportSettings,ownSettings);
        // Step 1: Get collection metadata
        progressTracker.updateProgress(1, 'Loading metadata...');
        // Export a complete verified manifest, never the lightweight settings
        // reference. A missing sidecar is an export error, not an empty backup.
        if(getCollectionMeta(exportRegistryKey)?.chatChunkManifest)
            await hydrateChatChunkManifest(exportRegistryKey);
        const collectionMeta = getCollectionMeta(exportRegistryKey) || {};

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
                triggerScanDepth: collectionMeta.triggerScanDepth ?? 5,
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
            chatChunkManifest: getChatChunkManifest(exportRegistryKey) || null,
            collectionConfiguration: {
                revision:collectionMeta.configurationRevision||0,
                lastUsedDraft:collectionMeta.lastUsedVectorizationDraft||{},
                preferences:collectionPreferenceSnapshot(collectionMeta),
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
            // Every selected collection retains its own backend and embedding provider.
            const parsed=parseRegistryKey(collectionId);
            const registryKey=parsed.backend?collectionId:
                `${settings.vector_backend||'standard'}:${settings.source||'transformers'}:${collectionId}`;
            const logicalId=parsed.collectionId;
            const ownSettings=settingsForCollectionQuery(registryKey,{...settings,
                ...(parsed.backend?{vector_backend:parsed.backend,source:parsed.source}:{})});
            if(getCollectionMeta(registryKey)?.chatChunkManifest)
                await hydrateChatChunkManifest(registryKey);
            const collectionMeta = getCollectionMeta(registryKey) || {};
            const rawChunks = await fetchChunksWithVectors(logicalId, ownSettings);
            const chunks = rawChunks.map(item => {
                const meta=item.metadata || item;
                const chunk = {
                    hash:meta.hash ?? item.hash,
                    text:meta.text ?? item.text ?? '',
                    index:meta.index ?? item.index,
                    vector:item.vector || meta.vector || null,
                    metadata:{...meta,vector:undefined},
                };
                const chunkMeta=getChunkMetadata(chunk.hash, registryKey);
                if(chunkMeta)chunk.chunkMeta=chunkMeta;
                return chunk;
            });

            exports.push({
                collection: {
                    id: logicalId,
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
                    triggerScanDepth: collectionMeta.triggerScanDepth ?? 5,
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
                chatChunkManifest: getChatChunkManifest(registryKey) || null,
                collectionConfiguration: {
                    revision:collectionMeta.configurationRevision||0,
                    lastUsedDraft:collectionMeta.lastUsedVectorizationDraft||{},
                    preferences:collectionPreferenceSnapshot(collectionMeta),
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

    progressTracker.complete(errors.length === 0, `Exported ${exports.length}/${collectionIds.length} collections`);
    // A multi-export file must not silently omit requested collections. Keep
    // existing collection data untouched and report the partial failure.
    if (errors.length) {
        throw new Error(`Multi-collection export incomplete (${errors.length}/${collectionIds.length} failed): ` +
            errors.map(e => `${e.collectionId}: ${e.error}`).join('; '));
    }

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
/** A replacement NEVER deletes the original. It stages under a fresh name. */
function replacementCollectionId(original) {
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    return `${original}_import_${id.replace(/-/g, '').slice(0,16)}`;
}

async function checkImportedChunks(collectionId, preparedChunks, settings) {
    const backend = await getBackend(settings);
    if (typeof backend.listChunks !== 'function') throw new Error('Backend cannot verify imported collection chunks');
    const actual=[];
    for(let offset=0;offset<100000;offset+=250) {
        const result=await backend.listChunks(collectionId,settings,{offset,limit:250});
        if(!Array.isArray(result?.items))throw new Error('Import verification returned no readable chunk list');
        actual.push(...result.items);
        if(result.items.length<250)break;
    }
    // Compare the stored content and ID, not just the count. A failed batch
    // write or silently replaced hash must never lead to a binding switch.
    const expected=new Map(preparedChunks.map(c=>[String(c.hash),c.text]));
    if(expected.size!==preparedChunks.length)throw new Error('Import contains duplicate chunk identities; safe replacement cannot certify it');
    const stored=new Map(actual.map(c=>[String(c.hash ?? c.metadata?.hash),c.text ?? c.metadata?.text]));
    if(stored.size!==preparedChunks.length || actual.length!==preparedChunks.length)
        throw new Error(`Import verification failed: expected ${preparedChunks.length} chunks, found ${actual.length}`);
    for(const [hash,text] of expected)if(stored.get(hash)!==text)
        throw new Error(`Import verification failed for chunk ${hash}; old collection remains intact`);
}

async function importCollectionSafely(exportData, settings, options={}) {
    if(hasActiveVectorWrite())throw new Error('Another vector-writing operation is running; wait before importing.');
    const lockId=`vecthare-import-${Date.now()}-${Math.random()}`;
    createOperationControl(lockId,{pausable:false,stoppable:false,writeOperation:true});
    try {
    const source = exportData.collection || {};
    const originalId = options.collectionId || source.id;
    if (!originalId || typeof originalId !== 'string') throw new Error('No collection identity provided');
    const chunks=(exportData.chunks||[]).filter(c=>typeof c.text==='string'&&c.text.trim());
    if(!chunks.length)throw new Error('No valid chunks to import');
    const backend=settings.vector_backend||'standard';
    const provider=settings.source||'transformers';
    const originalKey=`${backend}:${provider}:${originalId}`;
    const collectionId=options.overwrite?replacementCollectionId(originalId):originalId;
    const key=`${backend}:${provider}:${collectionId}`;
    if (!options.overwrite) {
        if(getCollectionRegistry().some(x=>x===key || x===collectionId))throw new Error('Collection already registered; use staged Replace instead of appending');
        const destination=await getBackend(settings);
        const listing=await destination.listChunks(collectionId,settings,{offset:0,limit:1});
        if(!Array.isArray(listing?.items) || listing.items.length)throw new Error('Collection already exists or cannot be verified empty; use staged Replace');
    }
    if(options.overwrite){
        // A newly allocated staging name must truly be empty; UUID collision,
        // old abandoned imports, or a backend routing error cannot be allowed
        // to overwrite an unrelated collection.
        const destination=await getBackend(settings);
        const listing=await destination.listChunks(collectionId,settings,{offset:0,limit:1});
        if(!Array.isArray(listing?.items) || listing.items.length)
            throw new Error('Replacement staging collection is not verified empty; original collection preserved');
    }
    if (backend === 'qdrant' && options.overwrite) assertQdrantIdentity(originalKey,settings);
    const existingOwner=options.overwrite?getCollectionOwner(originalKey):null;
    const actualModel=await discoverEmbeddingModel(settings);
    const profile=exportData.vectorizationProfile;
    const withVectors=chunks.filter(c=>Array.isArray(c.vector));
    const useVectors=!options.forceReembed && withVectors.length===chunks.length &&
        profile?.recipe?.version===2 && profile?.embedding?.verified===true && actualModel.verified===true &&
        profile.embedding.provider===provider && profile.embedding.modelId===actualModel.modelId &&
        (!profile.embedding.modelPath || !actualModel.modelPath || profile.embedding.modelPath===actualModel.modelPath);
    if(!useVectors && !options.forceReembed && withVectors.length)throw new Error('Cannot verify imported vector model. Choose re-vectorise explicitly. Original data remains unchanged.');
    const prepared=assignOccurrenceIds(chunks.map((c,i)=>({text:c.text,index:c.index??i,hash:c.hash??getStringHash(c.text),
        vector:useVectors?c.vector:undefined,metadata:c.metadata||{}})),getStringHash);
    if(new Set(prepared.map(c=>String(c.hash))).size!==prepared.length)
        throw new Error('Ambiguous duplicate chunk hashes in import: refusing destructive or mixed writes');
    // Before any insertion, validate the imported chunk references. Never
    // silently attach an incompatible old manifest to newly generated IDs.
    if (exportData.chatChunkManifest?.entries?.some(e=>
        !prepared.some(c=>String(c.hash)===String(e.hash)))) {
        throw new Error('Import manifest references chunks absent from imported content; repair the export first');
    }
    // A durable staging marker is written first so an interrupted import is
    // visible and recoverable, but it never becomes the chat's writable target.
    if(backend === 'qdrant') claimQdrantIdentity(key,settings);
    setCollectionMeta(key,{enabled:false,importPending:true,displayName:`Staging: ${source.name||originalId}`,
        importedFrom:originalKey,createdAt:new Date().toISOString()});
    registerCollection(key);
    try {
        if(useVectors) await insertChunksWithVectors(collectionId,prepared,settings);
        else await insertVectorItems(collectionId,prepared,settings);
        await checkImportedChunks(collectionId,prepared,settings);
        const savedProfile=useVectors?profile:await makeCollectionProfile(settings);
        const savedMeta={
            // A portable backup must restore every real per-collection retrieval
            // preference. NEVER automatically activate Auto-Sync on import:
            // ownership/binding must be verified and explicitly enabled.
            ...structuredClone(exportData.collectionConfiguration?.preferences||{}),
            enabled:true,autoSync:false,importPending:false,displayName:source.name||originalId,
            description:source.description||'',scope:source.scope||'global',tags:source.tags||[],
            color:source.color,contentType:source.contentType,importedFrom:originalKey,
            importedAt:new Date().toISOString(),createdAt:new Date().toISOString(),
            vectorizationProfile:savedProfile,
            lastUsedVectorizationDraft:structuredClone(exportData.collectionConfiguration?.lastUsedDraft||{}),
            collectionPreferences:structuredClone(exportData.collectionConfiguration?.preferences||{}),
        };
        if(exportData.settings)Object.assign(savedMeta,{
            alwaysActive:exportData.settings.alwaysActive, triggers:exportData.settings.triggers,
            triggerMatchMode:exportData.settings.triggerMatchMode,
            triggerCaseSensitive:exportData.settings.triggerCaseSensitive,
            triggerScanDepth:exportData.settings.triggerScanDepth,
            conditions:exportData.settings.conditions,
            temporalDecay:exportData.settings.temporalDecay,
            groups:exportData.settings.groups||[],context:exportData.settings.context||'',
            xmlTag:exportData.settings.xmlTag||'',
        });
        if(exportData.chatChunkManifest?.schemaVersion===1 && useVectors) {
            // Preserve chunk provenance only when every imported identity is
            // unambiguously retained; never attach a mismatched manifest.
            if(exportData.chatChunkManifest.entries.every(e=>prepared.some(c=>String(c.hash)===String(e.hash))))
                savedMeta.chatChunkManifest=structuredClone(exportData.chatChunkManifest);
        }
        setCollectionMeta(key,savedMeta);
        if(savedProfile)await saveCollectionProfile(key,savedProfile);
        // Importing a legacy/full backup must move its verified manifest into
        // the indexed store before making the replacement visible or writable.
        if(savedMeta.chatChunkManifest)await hydrateChatChunkManifest(key);
        for(const chunk of chunks)if(chunk.chunkMeta)
            saveChunkMetadata(chunk.hash??getStringHash(chunk.text),chunk.chunkMeta,key);
        // Re-check before switching: original stays active for every failure.
        await checkImportedChunks(collectionId,prepared,settings);
        if(existingOwner && getChatBinding(existingOwner)?.registryKey!==originalKey)
            throw new Error('Original chat binding changed during import');
        if(options.overwrite){
            const previousMeta=getCollectionMeta(originalKey);
            setCollectionMeta(originalKey,{enabled:false,replacedBy:key});
            try {
                if(existingOwner)bindChatCollection(existingOwner,key,{replace:true,writeVerified:!!savedProfile?.embedding?.verified});
            } catch(error) {
                // No new write binding was committed: restore previous retrieval
                // state rather than leaving the only known copy disabled.
                setCollectionMeta(originalKey,{enabled:previousMeta.enabled,replacedBy:previousMeta.replacedBy||null});
                setCollectionMeta(key,{enabled:false,importPending:true});
                throw error;
            }
        }
        saveSettingsDebounced();
        return {success:true,collectionId,previousCollectionId:options.overwrite?originalId:null,
            previousCollectionPreserved:!!options.overwrite,chunkCount:prepared.length,usedVectors:useVectors};
    }catch(error){
        // Staged chunks are never deleted automatically after an error. The
        // repair/backup UI can inspect them; original binding stays intact.
        setCollectionMeta(key,{enabled:false,importPending:true,importError:error.message});
        throw error;
    }
    }finally{detachOperationControl(lockId);}
}

export async function importCollection(exportData,settings,options={}) {
    progressTracker.show('Importing Collection',4,'Steps');
    try {
        progressTracker.updateProgress(1,'Validating source and staging collection');
        const result=await importCollectionSafely(exportData,settings,options);
        progressTracker.updateProgress(4,`Verified ${result.chunkCount} chunks; original preserved`);
        progressTracker.complete(true,`Imported ${result.chunkCount} chunks safely`);
        return {...result,errors:[]};
    }catch(error){
        progressTracker.addError(error.message);
        progressTracker.complete(false,'Import failed; original preserved');
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
async function importCollectionSilent(exportData,settings,options={}) {
    return importCollectionSafely(exportData,settings,options);
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
