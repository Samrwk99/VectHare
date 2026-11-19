import { itemMetadata } from './item-metadata.js';
import { readInitResponse } from './init-response.js';
import { vhLog } from '../utils/log.js';
/**
 * ============================================================================
 * MILVUS BACKEND (via Unified Plugin API)
 * ============================================================================
 * Uses the Similharity plugin's unified /chunks/* endpoints.
 * Backend: Milvus (external vector database server)
 *
 * MULTITENANCY SUPPORT:
 * - Step 9b: the physical store comes from the storage resolver; until 9c every
 *   collection resolves to ONE shared collection ("vecthare_main") with payload filters
 * - Passes type and sourceId for data isolation
 * - Supports all VectHare features via payload metadata
 *
 * Requires either a local Milvus instance or Milvus Cloud account.
 *
 * @author VectHare
 * @version 3.0.0
 * ============================================================================
 */

import { getRequestHeaders } from '../../../../../script.js';
import { VectorBackend } from './backend-interface.js';
import { getModelField, getValidProviderIds } from '../core/providers.js';
import { VECTOR_LIST_LIMIT } from '../core/constants.js';
import { resolveStorage, v2StorageParam, scopedTenancySupported, locatorForPhysical } from '../core/storage-resolver.js';

const BACKEND_TYPE = 'milvus';

/**
 * Get the model value from settings based on provider
 */
function getModelFromSettings(settings) {
    const modelField = getModelField(settings.source);
    return modelField ? settings[modelField] || '' : '';
}

export class MilvusBackend extends VectorBackend {
    async _autoDetectDimensions(settings) {
        try {
            // Don't auto-detect for sources that are handled client-side in VectHare 
            // but missing in Similharity servers-side generation (e.g. KoboldCpp/WebLLM)
            // Although WebLLM is client-side, we can't easily run it here without importing providers.
            // This is a best-effort for server-side providers (OpenAI, etc.) supported by Similharity.
            
            vhLog(`VectHare: Attempting to auto-detect embedding dimensions for ${settings.source}...`);
            
            const response = await fetch('/api/plugins/similharity/get-embedding', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    text: 'test',
                    source: settings.source || 'transformers',
                    model: getModelFromSettings(settings)
                }),
            });

            if (response.ok) {
                const data = await response.json();
                if (data.success && data.embedding && Array.isArray(data.embedding)) {
                    vhLog(`VectHare: Auto-detected dimension: ${data.embedding.length}`);
                    return data.embedding.length;
                }
            }
        } catch (e) {
            console.warn('VectHare: Failed to auto-detect dimensions:', e);
        }
        return null;
    }

    async initialize(settings) {
        // Determine dimensions: Manual setting > Auto-detect > Default (null)
        let dimensions = settings.milvus_dimensions ? parseInt(settings.milvus_dimensions) : null;
        
        if (!dimensions || isNaN(dimensions)) {
            dimensions = await this._autoDetectDimensions(settings);
        }

        // Get Milvus config from settings
        const config = {
            host: settings.milvus_host || 'localhost',
            port: settings.milvus_port || 19530,
            address: settings.milvus_address || (settings.milvus_host ? `${settings.milvus_host}:${settings.milvus_port || 19530}` : 'localhost:19530'),
            username: settings.milvus_username || null,
            password: settings.milvus_password || null,
            token: settings.milvus_token || null,
            dimensions: dimensions,
        };

        const response = await fetch('/api/plugins/similharity/backend/init/milvus', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(config),
        });

        await readInitResponse(response, 'Milvus');

        vhLog('VectHare: Using Milvus backend (production-grade vector search)');
    }

    async healthCheck() {
        try {
            const response = await fetch('/api/plugins/similharity/backend/health/milvus', {
                headers: getRequestHeaders(),
            });

            if (!response.ok) return false;

            const data = await response.json();
            return data.healthy === true;
        } catch (error) {
            console.error('[Milvus] Health check failed:', error);
            return false;
        }
    }

    /**
     * Parse collection ID to extract type and sourceId for multitenancy
     * Handles registry key format: backend:source:collectionId
     * Extracts just the collectionId part and parses it
     * 
     * New format: vh:{type}:{uuid}
     * Examples:
     *   "vh:chat:a1b2c3d4-e5f6-7890-abcd-ef1234567890" → {type: "chat", sourceId: "a1b2..."}
     *   "vh:lorebook:world_info_123" → {type: "lorebook", sourceId: "world_info_123"}
     *   "vh:doc:char_456" → {type: "doc", sourceId: "char_456"}
     * 
     * Legacy format: vecthare_{type}_{sourceId}
     */
    _parseCollectionId(collectionId) {
        if (!collectionId || typeof collectionId !== 'string') {
            return { type: 'unknown', sourceId: 'unknown', logicalId: null };
        }

        // Strip registry key prefix if present (backend:source:collectionId)
        const knownBackends = ['standard', 'lancedb', 'vectra', 'milvus', 'qdrant'];
        // #13: a hand-written provider list omitted supported providers, so their
        // registry prefixes were never stripped and the collection was addressed by
        // the wrong name. The provider registry is the single source of truth.
        const knownSources = getValidProviderIds();
        
        const parts = collectionId.split(':');
        
        // Check if it starts with backend:source: prefix
        if (parts.length >= 3 && knownBackends.includes(parts[0]) && knownSources.includes(parts[1])) {
            // Strip the backend:source: prefix and work with just the collection ID
            collectionId = parts.slice(2).join(':');
        }
        // Check if it starts with source: prefix (old format)
        else if (parts.length >= 2 && knownSources.includes(parts[0])) {
            // Strip the source: prefix
            collectionId = parts.slice(1).join(':');
        }

        // Now parse the actual collection ID
        const idParts = collectionId.split(':');

        // New format: vh:{type}:{sourceId}
        if (idParts.length >= 3 && idParts[0] === 'vh') {
            return {
                type: idParts[1],
                sourceId: idParts.slice(2).join(':'), // Handle UUIDs that might have colons
                logicalId: collectionId,
            };
        }

        // Legacy format: vecthare_{type}_{sourceId}
        const legacyParts = collectionId.split('_');
        if (legacyParts.length >= 3 && legacyParts[0] === 'vecthare') {
            return {
                type: legacyParts[1],
                sourceId: legacyParts.slice(2).join('_'),
                logicalId: collectionId,
            };
        }

        // Fallback: assume it's a chat with raw ID
        console.warn('VectHare: Unknown collection ID format:', collectionId);
        return {
            type: 'chat',
            sourceId: collectionId,
            // Not a VectHare id shape: the plugin cannot derive a scope from it
            // and will refuse the call rather than guess.
            logicalId: null,
        };
    }

    /**
     * Step 9b: the collection's tenant scope plus its physical store, taken
     * from the storage resolver only (its locator, or today's rule: the shared
     * `vecthare_main`).
     */
    _target(collectionId, settings) {
        const parsed = this._parseCollectionId(collectionId);
        const storage = resolveStorage(parsed.logicalId || collectionId, settings, BACKEND_TYPE);
        // 9c: a v2 collection (vecthare_mt_<dim> or its own vh_ store) is named
        // by its logical id plus its storage; the plugin derives the scope, so
        // no client filters are sent. Legacy requests are unchanged.
        const v2 = v2StorageParam(storage);
        if (v2 && parsed.logicalId) {
            return { ...parsed, physical: parsed.logicalId, layout: storage.layout, storage,
                scopeFilters: undefined, tenantId: undefined, v2Extra: { storage: v2 } };
        }
        return { ...parsed, physical: storage.physical, layout: storage.layout, storage,
            scopeFilters: { type: parsed.type, sourceId: parsed.sourceId }, tenantId: parsed.logicalId, v2Extra: {} };
    }

    /** Writes into a v2 collection need a plugin that scopes it. */
    async _assertWritable(target) {
        if (target.storage?.v2 && !await scopedTenancySupported()) {
            throw new Error(`[Milvus] ${target.logicalId} uses a newer storage layout; update the Similharity plugin. Nothing was changed.`);
        }
    }

    async getSavedHashes(collectionId, settings) {
        const target = this._target(collectionId, settings);
        const { type, sourceId, logicalId, physical, scopeFilters, tenantId, v2Extra } = target;

        const response = await fetch('/api/plugins/similharity/chunks/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: physical,
                ...v2Extra,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                limit: VECTOR_LIST_LIMIT,
                allHashes: true, // VH-027: every hash, not the first VECTOR_LIST_LIMIT
                filters: scopeFilters, // Filter by tenant
                tenantCollectionId: tenantId, // plugin derives the scope from this (client filters are not trusted)
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Milvus] Failed to get saved hashes for ${collectionId} (type: ${type}, sourceId: ${sourceId}): ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();
        // VH-027: the plugin answers allHashes with every hash and complete:true.
        // An older plugin ignores it and returns a capped page: never treat that as everything.
        if (data.complete === true && Array.isArray(data.items)) return data.items.map(item => item.hash);
        if (Array.isArray(data.items) && data.hasMore === false && Number(data.total) === data.items.length) {
            return data.items.map(item => item.hash);
        }
        throw new Error(`[Milvus] The stored hash list of ${collectionId} could not be read completely (update the Similharity plugin). Nothing was changed.`);
    }

    async insertVectorItems(collectionId, items, settings) {
        if (items.length === 0) return;

        const target = this._target(collectionId, settings);
        await this._assertWritable(target);
        const { type, sourceId, logicalId, physical, scopeFilters, tenantId, v2Extra } = target;

        const response = await fetch('/api/plugins/similharity/chunks/insert', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: physical,
                ...v2Extra,
                items: items.map(item => ({
                    hash: item.hash,
                    text: item.text,
                    index: item.index,
                    vector: item.vector,
                    metadata: itemMetadata(item)
                })),
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                filters: scopeFilters, // Pass multitenancy info
                tenantCollectionId: tenantId, // plugin derives the scope from this (client filters are not trusted)
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Milvus] Failed to insert ${items.length} vectors into ${collectionId} (type: ${type}, sourceId: ${sourceId}): ${response.status} ${response.statusText} - ${errorBody}`);
        }

        // 9c: a v2 insert says where the vectors went; record it once.
        if (target.storage?.v2) {
            const result = await response.json().catch(() => null);
            const location = result?.storage;
            if (location && typeof location.physical === 'string') {
                const locator = locatorForPhysical(logicalId, BACKEND_TYPE, location.physical, location.dim ?? null);
                if (locator) {
                    const { recordStorageLocator } = await import('../core/collection-metadata.js');
                    recordStorageLocator(logicalId, locator);
                }
            }
        }
        vhLog(`VectHare Milvus: Inserted ${items.length} vectors (type: ${type}, sourceId: ${sourceId})`);
    }

    async deleteVectorItems(collectionId, hashes, settings) {
        const target = this._target(collectionId, settings);
        const { type, sourceId, logicalId, physical, scopeFilters, tenantId, v2Extra } = target;

        const response = await fetch('/api/plugins/similharity/chunks/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: physical,
                ...v2Extra,
                hashes: hashes,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                filters: scopeFilters,
                tenantCollectionId: tenantId, // plugin derives the scope from this (client filters are not trusted)
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Milvus] Failed to delete vectors from ${collectionId} (type: ${type}, sourceId: ${sourceId}): ${response.status} ${response.statusText} - ${errorBody}`);
        }
    }

    async queryCollection(collectionId, searchText, topK, settings, queryVector = null) {
        const target = this._target(collectionId, settings);
        const { type, sourceId, logicalId, physical, scopeFilters, tenantId, v2Extra } = target;

        const response = await fetch('/api/plugins/similharity/chunks/query', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: physical,
                ...v2Extra,
                searchText: searchText,
                // #52: reuse one query embedding across collections when given.
                ...(Array.isArray(queryVector) && queryVector.length ? { queryVector } : {}),
                topK: topK,
                threshold: 0.0,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                filters: scopeFilters,
                tenantCollectionId: tenantId, // plugin derives the scope from this (client filters are not trusted)
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Milvus] Failed to query collection ${collectionId} (type: ${type}, sourceId: ${sourceId}): ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();

        // Format results to match expected output
        const hashes = data.results.map(r => r.hash);
        const metadata = data.results.map(r => ({
            hash: r.hash,
            text: r.text,
            score: r.score,
            ...r.metadata,
        }));

        return { hashes, metadata };
    }

    async queryMultipleCollections(collectionIds, searchText, topK, threshold, settings, queryVector = null) {
        const results = {};

        for (const collectionId of collectionIds) {
            try {
                const target = this._target(collectionId, settings);
        const { type, sourceId, logicalId, physical, scopeFilters, tenantId, v2Extra } = target;

                const response = await fetch('/api/plugins/similharity/chunks/query', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        backend: BACKEND_TYPE,
                        collectionId: physical,
                ...v2Extra,
                        searchText: searchText,
                        // #52: reuse one query embedding across collections when given.
                        ...(Array.isArray(queryVector) && queryVector.length ? { queryVector } : {}),
                        topK: topK,
                        threshold: threshold,
                        source: settings.source || 'transformers',
                        model: getModelFromSettings(settings),
                        filters: scopeFilters,
                        tenantCollectionId: tenantId, // plugin derives the scope from this (client filters are not trusted)
                    }),
                });

                if (response.ok) {
                    const data = await response.json();
                    const resultArray = data.results || data.chunks || [];

                    results[collectionId] = {
                        hashes: resultArray.map(r => r.hash),
                        metadata: resultArray.map(r => ({
                            hash: r.hash,
                            text: r.text,
                            score: r.score,
                            ...r.metadata,
                        })),
                    };
                } else {
                    console.error(`VectHare: Query failed for ${collectionId}: ${response.status} ${response.statusText}`);
                    results[collectionId] = { hashes: [], metadata: [] };
                }
            } catch (error) {
                console.error(`Failed to query collection ${collectionId}:`, error);
                results[collectionId] = { hashes: [], metadata: [] };
            }
        }

        return results;
    }

    async purgeVectorIndex(collectionId, settings) {
        const target = this._target(collectionId, settings);
        const { type, sourceId, logicalId, physical, scopeFilters, tenantId, v2Extra } = target;

        const response = await fetch('/api/plugins/similharity/chunks/purge', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: physical,
                ...v2Extra,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                filters: scopeFilters, // Purge specific tenant
                tenantCollectionId: tenantId, // plugin derives the scope from this (client filters are not trusted)
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Milvus] Failed to purge collection ${collectionId} (type: ${type}, sourceId: ${sourceId}): ${response.status} ${response.statusText} - ${errorBody}`);
        }

        vhLog(`VectHare Milvus: Purged (type: ${type}, sourceId: ${sourceId})`);
    }

    async purgeFileVectorIndex(collectionId, settings) {
        return this.purgeVectorIndex(collectionId, settings);
    }

    async purgeAllVectorIndexes(_settings) {
        // Never call a backend-wide purge: Standard shares ST's vector directory,
        // and LanceDB/Milvus may share physical storage with other consumers.
        throw new Error('Unsafe global purge is forbidden; delete verified VectHare collections individually');
    }

    // ========================================================================
    // EXTENDED API METHODS (for UI components)
    // ========================================================================

    /**
     * Get a single chunk by hash
     */
    async getChunk(collectionId, hash, settings) {
        const target = this._target(collectionId, settings);
        const { type, sourceId, logicalId, physical, scopeFilters, tenantId, v2Extra } = target;

        const response = await fetch(`/api/plugins/similharity/chunks/${encodeURIComponent(hash)}?` + new URLSearchParams({
            backend: BACKEND_TYPE,
            collectionId: physical,
            ...(v2Extra.storage ? { storage: JSON.stringify(v2Extra.storage) } : {}),
            source: settings.source || 'transformers',
            model: getModelFromSettings(settings),
            // Without a scope the plugin refuses the lookup (it would otherwise
            // return another collection's chunk with the same hash). 9c: a v2
            // request is scoped by the plugin from its storage.
            ...(v2Extra.storage ? {} : { filters: JSON.stringify({ type, sourceId }) }),
            ...(logicalId && !v2Extra.storage ? { tenantCollectionId: logicalId } : {}),
        }), {
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            if (response.status === 404) return null;
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Milvus] Failed to get chunk ${hash} from ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();
        return data.chunk;
    }

    /**
     * P5: stored records of this collection for the given hashes only, read
     * with a scoped hash query (verification after writes). Returns null when
     * the plugin cannot answer, so the caller reads in full.
     */
    async getChunksByHashes(collectionId, hashes, settings) {
        const target = this._target(collectionId, settings);
        const { type, sourceId, logicalId, physical, scopeFilters, tenantId, v2Extra } = target;
        if (!logicalId) return null;
        const response = await fetch('/api/plugins/similharity/chunks/get-by-hashes', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: physical,
                ...v2Extra,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                hashes,
                filters: scopeFilters,
                tenantCollectionId: tenantId,
            }),
        });
        if (response.status === 404) return null; // older plugin without this route
        if (!response.ok) {
            const errorBody = await response.text().catch(() => '');
            throw new Error(`Reading chunks by hash failed: HTTP ${response.status} ${errorBody}`.trim());
        }
        const data = await response.json();
        return data?.success === true && data.complete === true && Array.isArray(data.items) ? data : null;
    }

    /**
     * List chunks with pagination
     */
    async listChunks(collectionId, settings, options = {}) {
        const target = this._target(collectionId, settings);
        const { type, sourceId, logicalId, physical, scopeFilters, tenantId, v2Extra } = target;

        const response = await fetch('/api/plugins/similharity/chunks/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: physical,
                ...v2Extra,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                offset: options.offset || 0,
                limit: options.limit || 100,
                includeVectors: options.includeVectors || false,
                strictRead: options.strictRead === true,
                filters: scopeFilters,
                tenantCollectionId: tenantId, // plugin derives the scope from this (client filters are not trusted)
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Milvus] Failed to list chunks in ${collectionId} (type: ${type}, sourceId: ${sourceId}): ${response.status} ${response.statusText} - ${errorBody}`);
        }

        return await response.json();
    }

    /**
     * Update chunk text (triggers re-embedding)
     */
    async updateChunkText(collectionId, hash, newText, settings) {
        const target = this._target(collectionId, settings);
        const { type, sourceId, logicalId, physical, scopeFilters, tenantId, v2Extra } = target;

        const response = await fetch(`/api/plugins/similharity/chunks/${encodeURIComponent(hash)}/text`, {
            method: 'PATCH',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: physical,
                ...v2Extra,
                text: newText,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                filters: scopeFilters,
                tenantCollectionId: tenantId, // plugin derives the scope from this (client filters are not trusted)
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Milvus] Failed to update chunk text in ${collectionId} (hash: ${hash}): ${response.status} ${response.statusText} - ${errorBody}`);
        }

        return await response.json();
    }

    /**
     * Update chunk metadata (no re-embedding)
     */
    async updateChunkMetadata(collectionId, hash, metadata, settings) {
        const target = this._target(collectionId, settings);
        const { type, sourceId, logicalId, physical, scopeFilters, tenantId, v2Extra } = target;

        const response = await fetch(`/api/plugins/similharity/chunks/${encodeURIComponent(hash)}/metadata`, {
            method: 'PATCH',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: physical,
                ...v2Extra,
                metadata: metadata,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                filters: scopeFilters,
                tenantCollectionId: tenantId, // plugin derives the scope from this (client filters are not trusted)
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Milvus] Failed to update chunk metadata in ${collectionId} (hash: ${hash}): ${response.status} ${response.statusText} - ${errorBody}`);
        }

        return await response.json();
    }

    /**
     * Get collection statistics
     */
    async getStats(collectionId, settings) {
        const target = this._target(collectionId, settings);
        const { type, sourceId, logicalId, physical, scopeFilters, tenantId, v2Extra } = target;

        const response = await fetch('/api/plugins/similharity/chunks/stats', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: physical,
                ...v2Extra,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                filters: scopeFilters,
                tenantCollectionId: tenantId, // plugin derives the scope from this (client filters are not trusted)
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Milvus] Failed to get stats for ${collectionId} (type: ${type}, sourceId: ${sourceId}): ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();
        return data.stats;
    }

    // ========================================================================
    // HYBRID SEARCH METHODS
    // ========================================================================

    /**
     * Check if this backend supports native hybrid search.
     * Milvus supports hybrid search via the Similharity plugin.
     * @returns {boolean}
     */
    supportsHybridSearch() {
        return true;
    }

    /**
     * Perform hybrid search using Milvus's hybrid capabilities.
     * Falls back to regular vector search if hybrid endpoint is unavailable.
     *
     * @param {string} collectionId - Collection to query
     * @param {string} searchText - Query text
     * @param {number} topK - Number of results to return
     * @param {object} settings - VectHare settings
     * @param {object} hybridOptions - Hybrid search options
     * @returns {Promise<{hashes: number[], metadata: object[]}>}
     */
    async hybridQuery(collectionId, searchText, topK, settings, hybridOptions = {}) {
        const {
            vectorWeight = 0.5,
            textWeight = 0.5,
            fusionMethod = 'rrf',
            rrfK = 60,
            queryVector = null
        } = hybridOptions;

        const target = this._target(collectionId, settings);
        const { type, sourceId, logicalId, physical, scopeFilters, tenantId, v2Extra } = target;

        const body = {
            backend: BACKEND_TYPE,
            collectionId: physical,
                ...v2Extra,
            searchText: searchText,
            // #11: the prepared query vector was accepted and then dropped, so
            // Milvus re-embedded the query (or failed when it could not).
            ...(Array.isArray(queryVector) && queryVector.length ? { queryVector } : {}),
            topK: topK,
            threshold: 0.0,
            source: settings.source || 'transformers',
            model: getModelFromSettings(settings),
            filters: scopeFilters,
            tenantCollectionId: tenantId, // plugin derives the scope from this (client filters are not trusted)
            // Hybrid-specific parameters
            hybrid: true,
            hybridOptions: {
                vectorWeight,
                textWeight,
                fusionMethod,
                rrfK
            }
        };

        try {
            // Try the hybrid endpoint first
            const response = await fetch('/api/plugins/similharity/chunks/hybrid-query', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(body),
            });

            if (response.ok) {
                const data = await response.json();
                vhLog(`[Milvus] Native hybrid search returned ${data.results?.length || 0} results`);

                return {
                    hashes: data.results.map(r => r.hash),
                    metadata: data.results.map(r => ({
                        hash: r.hash,
                        text: r.text,
                        score: r.score,
                        vectorScore: r.vectorScore,
                        textScore: r.textScore,
                        fusionMethod: fusionMethod,
                        hybridSearch: true,
                        ...r.metadata,
                    }))
                };
            }

            // If hybrid endpoint returns 404 or similar, fall back
            console.warn(`[Milvus] Hybrid endpoint not available (${response.status}), falling back to vector-only search`);
        } catch (error) {
            console.warn(`[Milvus] Hybrid search failed:`, error.message);
        }

        // Fallback to regular vector search (9b fix: with the prepared query
        // vector, which used to be dropped here, so the query was embedded again)
        return this.queryCollection(collectionId, searchText, topK, settings, queryVector);
    }
}
