import { guardedVectorFetch as fetch } from '../utils/e02-vector-request-gateway.js';
import {adapterCollectionId} from '../utils/tenant-route.js';
import {hasVerifiedCapability} from '../utils/backend-contracts.js';
import { mergeDefinedChunkMetadata, trustedQueryMetadata } from '../utils/chunk-record-metadata.js';
import { verifyWriteIdentity, validateWriteBatch, collectVerifiedInventory } from '../utils/e05-verified-write-contract.js';
/**
 * ============================================================================
 * LANCEDB BACKEND (via Unified Plugin API)
 * ============================================================================
 * Uses the Similharity plugin's unified /chunks/* endpoints.
 * Backend: LanceDB (disk-based columnar storage)
 *
 * Provides disk-based, scalable vector storage for large collections.
 * Requires the VectHare plugin to be installed.
 *
 * @author VectHare
 * @version 3.0.0
 * ============================================================================
 */

import { getRequestHeaders } from '../../../../../script.js';
import { VectorBackend } from './backend-interface.js';
import { getModelField } from '../core/providers.js';
import { VECTOR_LIST_LIMIT } from '../core/constants.js';
import { requireListedItems, requireQueryItems, hybridEndpointUnsupported } from '../utils/backend-response-validation.js';

const BACKEND_TYPE = 'lancedb';

/**
 * Get the model value from settings based on provider
 */
function getModelFromSettings(settings) {
    const modelField = getModelField(settings.source);
    return modelField ? settings[modelField] || '' : '';
}

export class LanceDBBackend extends VectorBackend {
    /**
     * Strip registry key prefix (backend:source:collectionId) to get just the collection ID
     * @param {string} collectionId - May be plain ID or prefixed registry key
     * @returns {string} - Just the collection ID part
     */
    _stripRegistryPrefix(collectionId, settings) {
        return adapterCollectionId(collectionId, BACKEND_TYPE, settings?.source || 'transformers');
    }

    async initialize(settings) {
        // Initialize LanceDB backend via plugin
        const response = await fetch('/api/plugins/similharity/backend/init/lancedb', {
            method: 'POST',
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`Failed to initialize LanceDB: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        console.log('VectHare: Using LanceDB backend (disk-based, scalable)');
    }

    async healthCheck() {
        try {
            const response = await fetch('/api/plugins/similharity/backend/health/lancedb', {
                headers: getRequestHeaders(),
            });

            if (!response.ok) return false;

            const data = await response.json();
            return data.healthy === true;
        } catch (error) {
            console.error('[LanceDB] Health check failed:', error);
            return false;
        }
    }

    async getSavedHashes(collectionId, settings) {
        // E05: a single first page is NOT an inventory. The plugin's LanceDB
        // list wrapper has total/offset/hasMore, but each page is a full table
        // scan. Bound work and refuse truncation, duplicates or drift.
        const actualCollectionId = this._stripRegistryPrefix(collectionId, settings);
        const base = {
            backend: BACKEND_TYPE,
            collectionId: actualCollectionId,
            source: settings.source || 'transformers',
            model: getModelFromSettings(settings),
        };
        const inventory = await collectVerifiedInventory(async ({offset,limit,includeVectors}) => {
            const response = await fetch('/api/plugins/similharity/chunks/list', {
                method: 'POST', headers: getRequestHeaders(),
                body: JSON.stringify({...base,offset,limit,includeVectors}),
            });
            if (!response.ok) throw new Error(`[LanceDB] Collection inventory refused: HTTP ${response.status}`);
            return response.json();
        });
        return [...inventory.rows.values()].map(item => {
            const hash = Number(item.hash);
            if (!Number.isSafeInteger(hash)) throw new Error('LanceDB inventory returned an invalid numeric hash');
            return hash;
        });
    }

    async insertVectorItems(collectionId, items, settings) {
        if (items.length === 0) return;

        const actualCollectionId = this._stripRegistryPrefix(collectionId, settings);
        verifyWriteIdentity({backend:BACKEND_TYPE,collectionId:actualCollectionId,
            source:settings.source || 'transformers',model:getModelFromSettings(settings)});
        validateWriteBatch(items,{backend:BACKEND_TYPE});
        const response = await fetch('/api/plugins/similharity/chunks/insert', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: actualCollectionId,
                items: items.map(item => ({
                    hash: item.hash,
                    text: item.text,
                    index: item.index,
                    vector: item.vector,
                    metadata: mergeDefinedChunkMetadata(item),
                })),
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[LanceDB] Failed to insert ${items.length} vectors into ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        console.log(`VectHare LanceDB: Inserted ${items.length} vectors into ${collectionId}`);
    }

    async deleteVectorItems(collectionId, hashes, settings) {
        if (!hasVerifiedCapability('lancedb','deleteAcknowledgement')) throw new Error('lancedb: targeted deletion blocked; server acknowledgement unverified');
        const actualCollectionId = this._stripRegistryPrefix(collectionId, settings);
        const response = await fetch('/api/plugins/similharity/chunks/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: actualCollectionId,
                hashes: hashes,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[LanceDB] Failed to delete vectors from ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }
    }

    async queryCollection(collectionId, searchText, topK, settings) {
        const actualCollectionId = this._stripRegistryPrefix(collectionId, settings);
        console.log(`[LanceDB] queryCollection: original=${collectionId}, stripped=${actualCollectionId}`);
        const response = await fetch('/api/plugins/similharity/chunks/query', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: actualCollectionId,
                searchText: searchText,
                topK: topK,
                threshold: 0.0,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[LanceDB] Failed to query collection ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();

        // Reject application-level failures even when HTTP returned 200.
        const items = requireQueryItems(data, 'lancedb');
        const hashes = items.map(r => r.hash);
        const metadata = items.map(r => trustedQueryMetadata(r));

        return { hashes, metadata };
    }

    async queryMultipleCollections(collectionIds, searchText, topK, threshold, settings) {
        // Query each collection separately
        const results = {};

        for (const collectionId of collectionIds) {
            const actualCollectionId = this._stripRegistryPrefix(collectionId, settings);
            try {
                const response = await fetch('/api/plugins/similharity/chunks/query', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        backend: BACKEND_TYPE,
                        collectionId: actualCollectionId,
                        searchText: searchText,
                        topK: topK,
                        threshold: threshold,
                        source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                    }),
                });

                if (response.ok) {
                    const data = await response.json();
                    const resultArray = requireQueryItems(data, 'LanceDB');

                    results[collectionId] = {
                        hashes: resultArray.map(r => r.hash),
                        metadata: resultArray.map(r => trustedQueryMetadata(r)),
                    };
                } else {
                    console.error(`VectHare: Query failed for ${collectionId}: ${response.status} ${response.statusText}`);
                    results[collectionId] = { hashes: [], metadata: [], error: `HTTP ${response.status} ${response.statusText}` };
                }
            } catch (error) {
                console.error(`Failed to query collection ${collectionId}:`, error);
                results[collectionId] = { hashes: [], metadata: [], error: error.message };
            }
        }

        return results;
    }

    async purgeVectorIndex(collectionId, settings) {
        if (!hasVerifiedCapability(BACKEND_TYPE,'purgeAcknowledgement')) throw new Error('LanceDB purge blocked: server acknowledgement unverified');
        const actualCollectionId = this._stripRegistryPrefix(collectionId, settings);
        const response = await fetch('/api/plugins/similharity/chunks/purge', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: actualCollectionId,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[LanceDB] Failed to purge collection ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }
    }

    async purgeFileVectorIndex(collectionId, settings) {
        return this.purgeVectorIndex(collectionId, settings);
    }

    async purgeAllVectorIndexes(_settings) {
        throw new Error('Global LanceDB purge disabled: enumeration does not prove backend ownership');
    }


    // ========================================================================
    // EXTENDED API METHODS (for UI components)
    // ========================================================================

    /**
     * Get a single chunk by hash
     */
    async getChunk(collectionId, hash, settings) {
        const actualCollectionId = this._stripRegistryPrefix(collectionId, settings);
        const response = await fetch(`/api/plugins/similharity/chunks/${encodeURIComponent(hash)}?` + new URLSearchParams({
            backend: BACKEND_TYPE,
            collectionId: actualCollectionId,
            source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
        }), {
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            if (response.status === 404) return null;
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[LanceDB] Failed to get chunk ${hash} from ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();
        return data.chunk;
    }

    /**
     * List chunks with pagination
     */
    async listChunks(collectionId, settings, options = {}) {
        const actualCollectionId = this._stripRegistryPrefix(collectionId, settings);
        const response = await fetch('/api/plugins/similharity/chunks/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: actualCollectionId,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                offset: options.offset || 0,
                limit: options.limit || 100,
                includeVectors: options.includeVectors || false,
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[LanceDB] Failed to list chunks in ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        return await response.json();
    }

    /**
     * Update chunk text (triggers re-embedding)
     */
    async updateChunkText(collectionId, hash, newText, settings) {
        const actualCollectionId = this._stripRegistryPrefix(collectionId, settings);
        const response = await fetch(`/api/plugins/similharity/chunks/${encodeURIComponent(hash)}/text`, {
            method: 'PATCH',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: actualCollectionId,
                text: newText,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[LanceDB] Failed to update chunk text in ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        return await response.json();
    }

    /**
     * Update chunk metadata (no re-embedding)
     */
    async updateChunkMetadata(collectionId, hash, metadata, settings) {
        const actualCollectionId = this._stripRegistryPrefix(collectionId, settings);
        const response = await fetch(`/api/plugins/similharity/chunks/${encodeURIComponent(hash)}/metadata`, {
            method: 'PATCH',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: actualCollectionId,
                metadata: metadata,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[LanceDB] Failed to update chunk metadata in ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        return await response.json();
    }

    /**
     * Get collection statistics
     */
    async getStats(collectionId, settings) {
        if (!hasVerifiedCapability(BACKEND_TYPE,'tenantFilter')) throw new Error('Tenant statistics unavailable: server tenant filter unverified');
        const actualCollectionId = this._stripRegistryPrefix(collectionId, settings);
        const response = await fetch('/api/plugins/similharity/chunks/stats', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: actualCollectionId,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[LanceDB] Failed to get stats for ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();
        return data.stats;
    }
}
