import { guardedVectorFetch as fetch } from '../utils/e02-vector-request-gateway.js';
import {adapterCollectionId,requireTenantScope,rejectUnscopedPointOperation} from '../utils/tenant-route.js';
import {hasVerifiedCapability} from '../utils/backend-contracts.js';
import {assertNoCredentialsInUrl} from '../utils/c05-protected-credentials.js';
import { mergeDefinedChunkMetadata, trustedQueryMetadata } from '../utils/chunk-record-metadata.js';
import {sharedTenantFromCollection,markSharedDisplayPage,denyUnverifiedSharedInventory,labelSharedQuery} from '../utils/e06-shared-read-contract.js';
/**
 * ============================================================================
 * QDRANT BACKEND (via Unified Plugin API)
 * ============================================================================
 * Uses the Similharity plugin's unified /chunks/* endpoints.
 * Backend: Qdrant (external vector database server)
 *
 * COLLECTION ROUTING WARNING (E06):
 * - Similharity, not this adapter, decides the physical Qdrant collection.
 * - The plugin's _parseCollectionName strips colon-qualified names and may
 *   collapse different logical collection IDs onto the same physical name.
 * - The old “separate collections” setting is NOT proof of physical isolation.
 * - Qdrant writes, purge, metadata edits and deletes remain denied by E02.
 * - Scoped reads need type/sourceId and per-record owner checks; a successful
 *   plugin list/query does not prove authoritative completeness or health.
 *
 * Requires either a local Qdrant instance or Qdrant Cloud account.
 *
 * @author VectHare
 * @version 3.2.0
 * ============================================================================
 */

import { getRequestHeaders } from '../../../../../script.js';
import { VectorBackend } from './backend-interface.js';
import { getModelField } from '../core/providers.js';
import { getProviderSpecificParams } from './provider-params.js';
import { VECTOR_LIST_LIMIT } from '../core/constants.js';
import { requireListedItems, requireQueryItems, hybridEndpointUnsupported } from '../utils/backend-response-validation.js';

const BACKEND_TYPE = 'qdrant';
const MULTITENANCY_COLLECTION = 'vecthare_multitenancy';

/**
 * Get the model value from settings based on provider
 */
function getModelFromSettings(settings) {
    const modelField = getModelField(settings.source);
    return modelField ? settings[modelField] || '' : '';
}

/**
 * Determines the actual collection name to use based on multitenancy setting
 * @param {string} collectionId - Original collection ID
 * @param {object} settings - VectHare settings
 * @returns {string} - Actual collection name to use
 */
function getActualCollectionId(collectionId, settings) {
    if (settings.qdrant_multitenancy) {
        return MULTITENANCY_COLLECTION;
    }
    return collectionId;
}

/** E02: Similharity only understands `filters.type` + `filters.sourceId`.
 * The old Qdrant `filter.must[].content_type` was ignored by the server.
 * Unrecognized collection IDs are refused rather than guessed as a chat.
 */
function tenantFiltersFor(collectionId) {
    return sharedTenantFromCollection(collectionId, BACKEND_TYPE);
}

function verifyTenantResults(items, filters) {
    for (const item of items) {
        const owner = item?.metadata && typeof item.metadata === 'object' ? item.metadata : item;
        if (owner?.type !== filters.type || owner?.sourceId !== filters.sourceId)
            throw new Error('[Qdrant] Returned record has missing or mismatched tenant ownership');
    }
    return items;
}

export class QdrantBackend extends VectorBackend {
    async initialize(settings) {
        // S11.1 / S10: the plugin reads connection URL and credentials from its
        // private server-side per-user configuration. Never send browser settings.
        // Preserve the client's URL sanity check without using it for the connection.
        if (settings?.qdrant_use_cloud && settings?.qdrant_url) {
            assertNoCredentialsInUrl(settings.qdrant_url);
        }
        const response = await fetch('/api/plugins/similharity/backend/init/qdrant', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ configId: 'default' }),
        });

        if (!response.ok) {
            // S10 exposes machine-readable error codes; avoid echoing response
            // messages or configuration details into browser logs.
            const body = await response.json().catch(() => null);
            const code = typeof body?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(body.code)
                ? `; ${body.code}` : '';
            throw new Error(`[Qdrant] Failed to initialize Qdrant (HTTP ${response.status}${code})`);
        }
        console.log('VectHare: Qdrant server-managed connection initialized (read-only checkpoint)');
    }

    async healthCheck() {
        try {
            const response = await fetch('/api/plugins/similharity/backend/health/qdrant', {
                headers: getRequestHeaders(),
            });

            if (!response.ok) return false;

            const data = await response.json();
            return data.healthy === true;
        } catch (error) {
            console.error('[Qdrant] Health check failed:', error);
            return false;
        }
    }

    /**
     * Strip registry key prefix (backend:source:collectionId) to get just the collection ID
     * @param {string} collectionId - May be plain ID or prefixed registry key
     * @returns {string} - Just the collection ID part
     */
    _stripRegistryPrefix(collectionId, settings) {
        return adapterCollectionId(collectionId, BACKEND_TYPE, settings?.source || 'transformers');
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
    _parseCollectionId(collectionId, settings) {
        // First strip any registry prefix
        collectionId = this._stripRegistryPrefix(collectionId, settings);
        if (!collectionId || typeof collectionId !== 'string') {
            return { type: 'unknown', sourceId: 'unknown' };
        }

        // Now parse the actual collection ID
        const idParts = collectionId.split(':');

        // New format: vh:{type}:{sourceId}
        if (idParts.length >= 3 && idParts[0] === 'vh') {
            return {
                type: idParts[1],
                sourceId: idParts.slice(2).join(':') // Handle UUIDs that might have colons
            };
        }

        // Legacy format: vecthare_{type}_{sourceId}
        const legacyParts = collectionId.split('_');
        if (legacyParts.length >= 3 && legacyParts[0] === 'vecthare') {
            return {
                type: legacyParts[1],
                sourceId: legacyParts.slice(2).join('_')
            };
        }

        // Fallback: assume it's a chat with raw ID
        console.warn('VectHare: Unknown collection ID format:', collectionId);
        return {
            type: 'chat',
            sourceId: collectionId
        };
    }

    async getSavedHashes(collectionId, settings) {
        // Do not present Similharity's swallowed Qdrant list errors as a
        // complete saved-hash set. The mutation policy is already DENIED.
        const stripped = this._stripRegistryPrefix(collectionId, settings);
        tenantFiltersFor(stripped);
        denyUnverifiedSharedInventory(BACKEND_TYPE);
    }

    async insertVectorItems(collectionId, items, settings) {
        if (settings?.qdrant_multitenancy) requireTenantScope(BACKEND_TYPE, 'insertVectorItems');
        if (items.length === 0) return;

        // Strip registry key prefix to get the actual collection ID for Qdrant
        const strippedCollectionId = this._stripRegistryPrefix(collectionId, settings);
        const actualCollectionId = getActualCollectionId(strippedCollectionId, settings);

        // Batch items to avoid exceeding Qdrant's 32MB payload limit
        // Qdrant's default limit is 33554432 bytes (32MB)
        const BATCH_SIZE = 100; // Conservative batch size to stay well under limit
        const batches = [];
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
            batches.push(items.slice(i, i + BATCH_SIZE));
        }

        console.log(`VectHare Qdrant: Inserting ${items.length} vectors in ${batches.length} batch(es) of up to ${BATCH_SIZE} items`);

        // Process each batch
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex];
            const batchNum = batchIndex + 1;

            const response = await fetch('/api/plugins/similharity/chunks/insert', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    backend: BACKEND_TYPE,
                    collectionId: actualCollectionId,
                    items: batch.map(item => {
                        // Include keywords in the text for embedding/indexing
                        let textWithKeywords = item.text || '';
                        if (item.keywords && item.keywords.length > 0) {
                            const keywordTexts = item.keywords.map(kw => kw.text || kw).join(' ');
                            textWithKeywords += ` [KEYWORDS: ${keywordTexts}]`;
                        }

                        const metadata = mergeDefinedChunkMetadata(item);

                        // Add content_type for multitenancy mode
                        if (settings.qdrant_multitenancy) {
                            metadata.content_type = strippedCollectionId;
                        }

                        return {
                            hash: item.hash,
                            text: textWithKeywords,
                            index: item.index,
                            vector: item.vector,
                            metadata,
                        };
                    }),
                    source: settings.source || 'transformers',
                    model: getModelFromSettings(settings),
                    ...getProviderSpecificParams(settings),
                }),
            });

            if (!response.ok) {
                const errorBody = await response.text().catch(() => 'No response body');

                // Check for dimension mismatch error
                if (errorBody.includes('Vector dimension error') || errorBody.includes('dimension')) {
                    const dimensionMatch = errorBody.match(/expected dim: (\d+), got (\d+)/);
                    if (dimensionMatch) {
                        const expectedDim = dimensionMatch[1];
                        const gotDim = dimensionMatch[2];
                        throw new Error(
                            `[Qdrant] Vector dimension mismatch: Collection "${actualCollectionId}" expects ${expectedDim}-dimensional vectors, but received ${gotDim}-dimensional vectors. ` +
                            `This happens when switching embedding models. Solution: Delete the collection in Database Browser or use Qdrant API to drop it, then re-vectorize.`
                        );
                    }
                    throw new Error(
                        `[Qdrant] Vector dimension mismatch in collection "${actualCollectionId}". ` +
                        `This typically means you switched embedding models. Solution: Delete the collection and re-vectorize. Error: ${errorBody}`
                    );
                }

                throw new Error(`[Qdrant] Failed to insert ${items.length} vectors into ${actualCollectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
            }

            console.log(`VectHare Qdrant: Batch ${batchNum}/${batches.length} completed (${batch.length} vectors)`);
        }
        try {
            // Dynamic import to avoid circular dependency
            const { registerCollection } = await import('../core/collection-loader.js');
            registerCollection(collectionId);
        } catch (e) {
            console.warn('VectHare: Failed to register collection after Qdrant insert:', e);
        }

        const mode = settings.qdrant_multitenancy ? 'multitenancy' : 'separate';
        console.log(`VectHare Qdrant: Inserted ${items.length} vectors into ${actualCollectionId} (${mode} mode, content_type: ${strippedCollectionId})`);
    }

    async deleteVectorItems(collectionId, hashes, settings) {
        if (!hasVerifiedCapability('qdrant','deleteAcknowledgement')) throw new Error('qdrant: targeted deletion blocked; server acknowledgement unverified');
        if (settings?.qdrant_multitenancy) requireTenantScope(BACKEND_TYPE, 'deleteVectorItems');
        const strippedCollectionId = this._stripRegistryPrefix(collectionId, settings);
        const actualCollectionId = getActualCollectionId(strippedCollectionId, settings);

        const body = {
            backend: BACKEND_TYPE,
            collectionId: actualCollectionId,
            hashes: hashes,
            source: settings.source || 'transformers',
            model: getModelFromSettings(settings),
        };
        body.filters = tenantFiltersFor(strippedCollectionId);

        const response = await fetch('/api/plugins/similharity/chunks/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to delete vectors from ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }
    }

    async queryCollection(collectionId, searchText, topK, settings, queryVector = null) {
        if (settings?.qdrant_multitenancy) requireTenantScope(BACKEND_TYPE, 'queryCollection');
        const strippedCollectionId = this._stripRegistryPrefix(collectionId, settings);
        const actualCollectionId = getActualCollectionId(strippedCollectionId, settings);

        const body = {
            backend: BACKEND_TYPE,
            collectionId: actualCollectionId,
            searchText: searchText,
            topK: topK,
            threshold: 0.0,
            source: settings.source || 'transformers',
            model: getModelFromSettings(settings),
            ...getProviderSpecificParams(settings, true),
        };

    //Use queryVector if provided, otherwise searchText
        if (queryVector) {
            body.queryVector = queryVector;
        } else if (searchText?.trim()) {
            body.searchText = searchText;
        } else {
            console.warn('[Qdrant] No queryVector or searchText provided');
            return { hashes: [], metadata: [] };
        }
        body.filters = tenantFiltersFor(strippedCollectionId);

        const response = await fetch('/api/plugins/similharity/chunks/query', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to query collection ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();

        // Reject application-level failures even when HTTP returned 200.
        const items = verifyTenantResults(requireQueryItems(data, 'qdrant'), body.filters);
        const hashes = items.map(r => r.hash);
        const metadata = items.map(r => trustedQueryMetadata(r));

        return { hashes, metadata, ...labelSharedQuery(items, BACKEND_TYPE) };
    }

    async queryMultipleCollections(collectionIds, searchText, topK, threshold, settings, queryVector = null) {
        if (settings?.qdrant_multitenancy) requireTenantScope(BACKEND_TYPE, 'queryMultipleCollections');
        const results = {};

        for (const collectionId of collectionIds) {
            try {
                const strippedCollectionId = this._stripRegistryPrefix(collectionId, settings);
                const actualCollectionId = getActualCollectionId(strippedCollectionId, settings);

                const body = {
                    backend: BACKEND_TYPE,
                    collectionId: actualCollectionId,
                    searchText: searchText,
                    topK: topK,
                    threshold: threshold,
                    source: settings.source || 'transformers',
                    model: getModelFromSettings(settings),
                    ...getProviderSpecificParams(settings, true),
                };


                // Use queryVector if provided, otherwise searchText
                if (queryVector) {
                    body.queryVector = queryVector;
                } else if (searchText?.trim()) {
                    body.searchText = searchText;
                } else {
                    console.warn(`[Qdrant] No queryVector or searchText for ${collectionId}`);
                    results[collectionId] = { hashes: [], metadata: [] };
                    continue;
                }
        body.filters = tenantFiltersFor(strippedCollectionId);

                const response = await fetch('/api/plugins/similharity/chunks/query', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify(body),
                });

                if (response.ok) {
                    const data = await response.json();
                    const resultArray = verifyTenantResults(requireQueryItems(data, 'Qdrant'), body.filters);

                    results[collectionId] = {
                        hashes: resultArray.map(r => r.hash),
                        metadata: resultArray.map(r => trustedQueryMetadata(r)),
                    };
                } else {
                    const errorBody = await response.text().catch(() => 'No response body');
                    const errorMsg = `${response.status} ${response.statusText} - ${errorBody}`;
                    console.error(`VectHare: Query failed for ${collectionId}: ${errorMsg}`);
                    results[collectionId] = { hashes: [], metadata: [], error: errorMsg };
                }
            } catch (error) {
                console.error(`Failed to query collection ${collectionId}:`, error);
                results[collectionId] = { hashes: [], metadata: [], error: error.message };
            }
        }

        return results;
    }

    async purgeVectorIndex(collectionId, settings) {
        if (settings?.qdrant_multitenancy) throw new Error('Qdrant shared physical collection purge disabled: verified tenant-only delete required');
        if (!hasVerifiedCapability(BACKEND_TYPE,'purgeAcknowledgement')) throw new Error('Qdrant purge blocked: server acknowledgement unverified');
        const actualCollectionId = this._stripRegistryPrefix(collectionId, settings);
        const response = await fetch('/api/plugins/similharity/chunks/purge', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: actualCollectionId, // Use separate collection per content type
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to purge collection ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

         console.log(`VectHare Qdrant: purge request acknowledged for ${actualCollectionId}`);
    }

    async purgeFileVectorIndex(collectionId, settings) {
        return this.purgeVectorIndex(collectionId, settings);
    }

    async purgeAllVectorIndexes(settings) {
        // Note: With separate collections per content type, we need to purge each collection individually
        console.warn('VectHare: purgeAllVectorIndexes now requires calling purgeVectorIndex for each collection');
        throw new Error('purgeAllVectorIndexes requires collection IDs - call purgeVectorIndex for each collection instead');
    }

    // ========================================================================
    // EXTENDED API METHODS (for UI components)
    // ========================================================================

    /**
     * Get a single chunk by hash
     */
    async getChunk(collectionId, hash, settings) {
        if (settings?.qdrant_multitenancy) rejectUnscopedPointOperation(BACKEND_TYPE, 'getChunk');
        const actualCollectionId = this._stripRegistryPrefix(collectionId, settings);
        const response = await fetch(`/api/plugins/similharity/chunks/${encodeURIComponent(hash)}?` + new URLSearchParams({
            backend: BACKEND_TYPE,
            collectionId: actualCollectionId, // Use separate collection per content type
            source: settings.source || 'transformers',
            model: getModelFromSettings(settings),
            filters: JSON.stringify(tenantFiltersFor(actualCollectionId)),
        }), {
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            if (response.status === 404) return null;
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to get chunk ${hash} from ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();
        return verifyTenantResults([data.chunk], tenantFiltersFor(actualCollectionId))[0];
    }

    /**
     * List chunks with pagination
     */
    async listChunks(collectionId, settings, options = {}) {
        if (settings?.qdrant_multitenancy) requireTenantScope(BACKEND_TYPE, 'listChunks');
        // R19 FIX: listChunks previously ignored multitenancy mode entirely -
        // it read the per-chat collection name even when all data lives in the
        // shared multitenancy collection, and never applied the content_type
        // filter (so even in separate mode it could return other sources'
        // chunks if IDs ever overlapped). Now mirrors getSavedHashes exactly.
        const strippedCollectionId = this._stripRegistryPrefix(collectionId, settings);
        const actualCollectionId = getActualCollectionId(strippedCollectionId, settings);

        const body = {
            backend: BACKEND_TYPE,
            collectionId: actualCollectionId,
            source: settings.source || 'transformers',
            model: getModelFromSettings(settings),
            offset: options.offset || 0,
            limit: options.limit || 100,
            includeVectors: options.includeVectors || false,
        };
        body.filters = tenantFiltersFor(strippedCollectionId);

        const response = await fetch('/api/plugins/similharity/chunks/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to list chunks in ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();
        return markSharedDisplayPage(data, body.filters, BACKEND_TYPE);
    }

    /**
     * Update chunk text (triggers re-embedding)
     */
    async updateChunkText(collectionId, hash, newText, settings) {
        if (settings?.qdrant_multitenancy) rejectUnscopedPointOperation(BACKEND_TYPE, 'updateChunkText');
        const actualCollectionId = this._stripRegistryPrefix(collectionId, settings);
        const response = await fetch(`/api/plugins/similharity/chunks/${encodeURIComponent(hash)}/text`, {
            method: 'PATCH',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: actualCollectionId, // Use separate collection per content type
                text: newText,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                ...getProviderSpecificParams(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to update chunk text in ${collectionId} (hash: ${hash}): ${response.status} ${response.statusText} - ${errorBody}`);
        }

        return await response.json();
    }

    /**
     * Update chunk metadata (no re-embedding)
     */
    async updateChunkMetadata(collectionId, hash, metadata, settings) {
        if (settings?.qdrant_multitenancy) rejectUnscopedPointOperation(BACKEND_TYPE, 'updateChunkMetadata');
        const actualCollectionId = this._stripRegistryPrefix(collectionId, settings);
        const response = await fetch(`/api/plugins/similharity/chunks/${encodeURIComponent(hash)}/metadata`, {
            method: 'PATCH',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: BACKEND_TYPE,
                collectionId: actualCollectionId, // Use separate collection per content type
                metadata: metadata,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to update chunk metadata in ${collectionId} (hash: ${hash}): ${response.status} ${response.statusText} - ${errorBody}`);
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
                collectionId: actualCollectionId, // Use separate collection per content type
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to get stats for ${collectionId}: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();
        return data.stats;
    }

    // ========================================================================
    // HYBRID SEARCH METHODS
    // ========================================================================

    /**
     * Check if this backend supports native hybrid search.
     * Qdrant supports sparse vectors for hybrid search via the Similharity plugin.
     * @returns {boolean}
     */
    supportsHybridSearch() {
        return true;
    }

    /**
     * Perform hybrid search using Qdrant's sparse + dense vector capabilities.
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
        if (settings?.qdrant_multitenancy) requireTenantScope(BACKEND_TYPE, 'hybridQuery');
        const {
            vectorWeight = 0.5,
            textWeight = 0.5,
            fusionMethod = 'rrf',
            rrfK = 60
        } = hybridOptions;

        const strippedCollectionId = this._stripRegistryPrefix(collectionId, settings);
        const actualCollectionId = getActualCollectionId(strippedCollectionId, settings);

        const body = {
            backend: BACKEND_TYPE,
            collectionId: actualCollectionId,
            searchText: searchText,
            topK: topK,
            threshold: 0.0,
            source: settings.source || 'transformers',
            model: getModelFromSettings(settings),
            ...getProviderSpecificParams(settings, true),
            // Hybrid-specific parameters
            hybrid: true,
            hybridOptions: {
                vectorWeight,
                textWeight,
                fusionMethod,
                rrfK
            }
        };
        body.filters = tenantFiltersFor(strippedCollectionId);

        try {
            // Try the hybrid endpoint first
            const response = await fetch('/api/plugins/similharity/chunks/hybrid-query', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(body),
            });

            if (response.ok) {
                const data = await response.json();
                const hybridItems = verifyTenantResults(requireQueryItems(data, 'Qdrant hybrid'), body.filters);
                console.log(`[Qdrant] Native hybrid search returned ${data.results?.length || 0} results`);

                return {
                    hashes: hybridItems.map(r => r.hash),
                    metadata: hybridItems.map(r => ({
                        hash: r.hash,
                        text: r.text,
                        score: r.score,
                        vectorScore: r.vectorScore || r.debug?.vectorScore,
                        textScore: r.textScore || r.debug?.keywordScore,
                        fusionMethod: r.debug?.fusionMethod || fusionMethod,
                        hybridSearch: true,
                        vectorRank: r.debug?.vectorRank,
                        keywordRank: r.debug?.keywordRank,
                        matchedKeywords: r.debug?.matchedKeywords,
                        ...r.metadata,
                    }))
                };
            }

            if (!hybridEndpointUnsupported(response.status)) {
                throw new Error(`Hybrid query failed (HTTP ${response.status})`);
            }
            // An absent/unsupported endpoint can fall back to vector search.
            console.warn(`[Qdrant] Hybrid endpoint not available (${response.status}), falling back to vector-only search`);
        } catch (error) {
            throw error;
        }

        // Fallback to regular vector search
        return this.queryCollection(collectionId, searchText, topK, settings);
    }
}
