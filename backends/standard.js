import {adapterCollectionId} from '../utils/tenant-route.js';
import {hasVerifiedCapability} from '../utils/backend-contracts.js';
import { mergeDefinedChunkMetadata } from '../utils/chunk-record-metadata.js';
/**
 * ============================================================================
 * STANDARD BACKEND (Vectra - ST Native + Plugin)
 * ============================================================================
 * Uses ST's native /api/vector/* endpoints as the primary method.
 * Falls back to Similharity plugin endpoints if available for extended features.
 *
 * This is the default backend - no setup required.
 *
 * @author VectHare
 * @version 3.1.0
 * ============================================================================
 */

import { getRequestHeaders } from '../../../../../script.js';
import { VectorBackend } from './backend-interface.js';
import { getModelField } from '../core/providers.js';
import { getProviderSpecificParams } from './provider-params.js';
import { VECTOR_LIST_LIMIT } from '../core/constants.js';
import { hybridEndpointUnsupported } from '../utils/backend-response-validation.js';

/**
 * Get the model value from settings based on provider
 */
function getModelFromSettings(settings) {
    const modelField = getModelField(settings.source);
    return modelField ? settings[modelField] || '' : '';
}

export class StandardBackend extends VectorBackend {
    constructor() {
        super();
        this.pluginAvailable = false;
        this.pluginInsertUnavailable = false;
    }

    async initialize(settings) {
        // Re-probe the insert route after an explicit backend re-initialization.
        this.pluginInsertUnavailable = false;
        // Check if plugin is available
        console.log('VectHare DEBUG: Checking plugin availability...');
        try {
            const response = await fetch('/api/plugins/similharity/health');
            console.log('VectHare DEBUG: Plugin health check response:', response.status, response.ok);
            this.pluginAvailable = response.ok;

            if (this.pluginAvailable) {
                const initResponse = await fetch('/api/plugins/similharity/backend/init/vectra', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                });
                if (!initResponse.ok) {
                    this.pluginAvailable = false;
                    console.warn(`VectHare: Standard plugin initialization rejected (HTTP ${initResponse.status}); using native ST API`);
                } else {
                    console.log('VectHare: Standard backend initialized (plugin available)');
                }
            } else {
                console.log('VectHare: Standard backend initialized (native ST API only - health check failed)');
            }
        } catch (e) {
            console.log('VectHare: Standard backend initialized (native ST API only - error:', e.message, ')');
            this.pluginAvailable = false;
        }
        
    }

    async healthCheck() {
        // Native ST API is always available if ST is running
        try {
            // Quick test: try to list a non-existent collection (should return empty array or error)
            const response = await fetch('/api/vector/list', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    collectionId: '__vecthare_health_check__',
                    source: 'transformers'
                }),
            });
            // HTTP 500 can be a genuine server failure; never treat it as healthy.
            return response.ok;
        } catch (error) {
            console.error('[Standard] Health check failed:', error);
            return false;
        }
    }

    /**
     * Get saved hashes for a collection
     * Uses native ST API
     */
    async getSavedHashes(collectionId, settings) {
        collectionId = adapterCollectionId(collectionId, 'standard', settings?.source || 'transformers');
        const providerParams = getProviderSpecificParams(settings, false);
        const model = getModelFromSettings(settings);

        const response = await fetch('/api/vector/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                collectionId: collectionId,
                source: settings.source || 'transformers',
                model: model,
                ...providerParams,
            }),
        });

        if (!response.ok) {
            // A server failure is not proof that a collection is empty.
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`Failed to get saved hashes: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();
        // Native API returns array of hashes directly
        if (!Array.isArray(data)) throw new Error('Standard: invalid saved-hashes response (expected an array)');
        return data;
    }

    /**
     * Insert vector items into a collection
     * Uses plugin API if available (for metadata support), falls back to native ST API
     */
    async insertVectorItems(collectionId, items, settings) {
        collectionId = adapterCollectionId(collectionId, 'standard', settings?.source || 'transformers');
        if (items.length === 0) return;

        const providerParams = getProviderSpecificParams(settings, false);
        const model = getModelFromSettings(settings);

        // Log chunk statistics for debugging OOM issues
        const textLengths = items.map(item => (item.text || '').length);
        const maxLen = Math.max(...textLengths);
        const avgLen = Math.round(textLengths.reduce((a, b) => a + b, 0) / textLengths.length);
        const longestChunkIndex = textLengths.indexOf(maxLen);

        // Count how many chunks have keywords
        const chunksWithKeywords = items.filter(item => item.keywords && item.keywords.length > 0).length;

        console.log(`VectHare: Embedding ${items.length} chunks (avg: ${avgLen} chars, max: ${maxLen} chars at index ${longestChunkIndex}) - ${chunksWithKeywords} chunks have keywords`);

        // Debug: Log first chunk's keywords if any
        if (chunksWithKeywords > 0) {
            const firstChunkWithKeywords = items.find(item => item.keywords && item.keywords.length > 0);
            console.log(`VectHare DEBUG: First chunk keywords:`, firstChunkWithKeywords.keywords);
        }

        // Warn if chunks are unusually large (potential OOM risk)
        if (maxLen > 2000) {
            console.warn(`VectHare: Large chunk detected (${maxLen} chars). If you see OOM errors, try reducing chunk size.`);
            console.warn(`VectHare: Problematic chunk preview: "${(items[longestChunkIndex]?.text || '').substring(0, 100)}..."`);
        }

        try {
            // An available plugin may not implement the insert route. Remember only
            // endpoint *unavailability*, not ordinary failed insert attempts.
            const pluginPreferred = this.pluginAvailable && !this.pluginInsertUnavailable;
            const makePayload = (usePluginApi) => usePluginApi ? {
                backend: 'vectra',
                collectionId,
                items: items.map(item => ({
                    hash: item.hash,
                    text: item.text || '',
                    index: item.index ?? 0,
                    vector: item.vector,
                    metadata: mergeDefinedChunkMetadata(item),
                })),
                source: settings.source || 'transformers',
                model,
                ...providerParams,
            } : {
                collectionId,
                items: items.map(item => ({
                    hash: item.hash,
                    text: item.text || '',
                    index: item.index ?? 0,
                })),
                source: settings.source || 'transformers',
                model,
                embeddings: items[0]?.vector ? Object.fromEntries(items.map(i => [
                    i.text || '',
                    i.vector,
                ])) : undefined,
                ...providerParams,
            };

            const insertVia = async (usePluginApi) => {
                const endpoint = usePluginApi
                    ? '/api/plugins/similharity/chunks/insert'
                    : '/api/vector/insert';
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify(makePayload(usePluginApi)),
                });
                if (!response.ok) return { response, endpoint };
                // Some native API versions return an empty body. When the server
                // supplies a status/count, reject explicit application failures.
                const result = await response.json().catch(() => null);
                if (result && (result.success === false || result.error ||
                    (typeof result.inserted === 'number' && result.inserted < items.length))) {
                    throw new Error(`Failed to insert vectors: ${result.error || 'server rejected or partially accepted the batch'}`);
                }
                return { response, endpoint };
            };

            let usedPlugin = pluginPreferred;
            let { response, endpoint } = await insertVia(usedPlugin);
            if (!response.ok && usedPlugin && hybridEndpointUnsupported(response.status)) {
                // No plugin insert route: native insertion still works but loses
                // plugin-only metadata. Do NOT retry for 401/403/500/transport errors.
                this.pluginInsertUnavailable = true;
                usedPlugin = false;
                console.warn(`VectHare: Plugin insert endpoint unavailable (HTTP ${response.status}); retrying with native ST insert`);
                ({ response, endpoint } = await insertVia(false));
            }
            if (!usedPlugin && chunksWithKeywords > 0) {
                console.warn('VectHare: Native ST insertion does not store custom chunk metadata/keywords');
            }
            if (!response.ok) {
                const errorBody = await response.text().catch(() => 'No response body');
                throw new Error(`Failed to insert vectors (${endpoint}): ${response.status} - ${errorBody}`);
            }
            console.log(`VectHare Standard: Inserted ${items.length} vectors into ${collectionId}`);
        } catch (error) {
            // Enhanced error logging for OOM debugging
            const isOOM = error.message?.includes('OrtRun') || error.message?.includes('error code = 6');
            if (isOOM) {
                console.error(`VectHare: ONNX OOM Error while embedding. Diagnostics:`);
                console.error(`  - Provider: ${settings.source}`);
                console.error(`  - Model: ${model || '(default)'}`);
                console.error(`  - Batch size: ${items.length} chunks`);
                console.error(`  - Largest chunk: ${maxLen} chars (index ${longestChunkIndex})`);
                console.error(`  - Average chunk: ${avgLen} chars`);
                console.error(`  - Tip: Try reducing chunk size in settings, or use a smaller embedding model`);
            }
            throw error;
        }
    }

    /**
     * Delete vector items from a collection
     * Uses native ST API
     */
    async deleteVectorItems(collectionId, hashes, settings) {
        if (!hasVerifiedCapability('standard','deleteAcknowledgement')) throw new Error('standard: targeted deletion blocked; server acknowledgement unverified');
        collectionId = adapterCollectionId(collectionId, 'standard', settings?.source || 'transformers');
        const response = await fetch('/api/vector/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                collectionId: collectionId,
                hashes: hashes,
                source: settings.source || 'transformers',
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`Failed to delete vectors: ${response.status} ${response.statusText} - ${errorBody}`);
        }
    }

    /**
     * Query a collection for similar vectors
     * Uses native ST API
     */
    async queryCollection(collectionId, searchText, topK, settings, queryVector = null) {
        collectionId = adapterCollectionId(collectionId, 'standard', settings?.source || 'transformers');
        const providerParams = getProviderSpecificParams(settings, true);
        const model = getModelFromSettings(settings);

        const requestBody = {
            collectionId: collectionId,
            searchText: searchText,
            topK: topK,
            threshold: settings.score_threshold || 0.0,
            source: settings.source || 'transformers',
            model: model,
            ...providerParams,
        };

        // If we have a pre-computed query vector (for webllm, koboldcpp, bananabread)
        if (queryVector) {
            requestBody.embeddings = { [searchText]: queryVector };
        }

        const response = await fetch('/api/vector/query', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`Failed to query collection: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();

        // Distinguish a legitimate empty native result from an application error.
        if (!data || data.success === false || data.error ||
            !Array.isArray(data.hashes) || !Array.isArray(data.metadata)) {
            throw new Error('Standard: invalid or unsuccessful query response');
        }
        return {
            hashes: data.hashes,
            metadata: data.metadata.map((m, idx) => ({
                hash: data.hashes?.[idx],
                text: m.text,
                score: m.score || 0,
                ...m,
            })),
        };
    }

    /**
     * Query multiple collections
     * Uses native ST API
     */
    async queryMultipleCollections(collectionIds, searchText, topK, threshold, settings, queryVector = null) {
        const providerParams = getProviderSpecificParams(settings, true);
        const model = getModelFromSettings(settings);

        const requestBody = {
            collectionIds: collectionIds,
            searchText: searchText,
            topK: topK,
            threshold: threshold,
            source: settings.source || 'transformers',
            model: model,
            ...providerParams,
        };

        if (queryVector) {
            requestBody.embeddings = { [searchText]: queryVector };
        }

        const response = await fetch('/api/vector/query-multi', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            // Fallback: query each collection individually
            console.warn('VectHare: query-multi failed, falling back to individual queries');
            const results = {};
            const errors = [];
            for (const collectionId of collectionIds) {
                try {
                    results[collectionId] = await this.queryCollection(collectionId, searchText, topK, settings, queryVector);
                } catch (e) {
                    console.error(`VectHare: Query failed for collection ${collectionId}:`, e.message);
                    errors.push(`${collectionId}: ${e.message}`);
                    results[collectionId] = { hashes: [], metadata: [], error: e.message };
                }
            }
            if (errors.length > 0) {
                console.error(`VectHare: ${errors.length} collection(s) failed to query:`, errors);
            }
            return results;
        }

        return await response.json();
    }

    /**
     * Purge (delete) a collection
     * Uses native ST API
     */
    async purgeVectorIndex(collectionId, settings) {
        if (!hasVerifiedCapability('standard','purgeAcknowledgement')) throw new Error('Standard purge blocked: native acknowledgement contract unverified');
        collectionId = adapterCollectionId(collectionId, 'standard', settings?.source || 'transformers');
        const response = await fetch('/api/vector/purge', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                collectionId: collectionId,
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`Failed to purge collection: ${response.status} ${response.statusText} - ${errorBody}`);
        }
    }

    async purgeFileVectorIndex(collectionId, settings) {
        return this.purgeVectorIndex(collectionId, settings);
    }

    /**
     * Purge all vector indexes
     * Uses native ST API
     */
    async purgeAllVectorIndexes(_settings) {
        throw new Error('Global Standard purge disabled: unverified ownership and durable safety checkpoint');
    }


    // ========================================================================
    // EXTENDED API METHODS (plugin-only, graceful fallback)
    // ========================================================================

    /**
     * List chunks with pagination (plugin-only feature)
     * Falls back to basic hash list if plugin unavailable
     */
    async listChunks(collectionId, settings, options = {}) {
        collectionId = adapterCollectionId(collectionId, 'standard', settings?.source || 'transformers');
        if (this.pluginAvailable) {
            try {
                const response = await fetch('/api/plugins/similharity/chunks/list', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        backend: 'vectra',
                        collectionId: collectionId,
                        source: settings.source || 'transformers',
                        model: getModelFromSettings(settings),
                        offset: options.offset || 0,
                        limit: options.limit || 100,
                        includeVectors: options.includeVectors || false,
                    }),
                });

                if (response.ok) {
                    return await response.json();
                }
            } catch (e) {
                console.warn('VectHare: Plugin listChunks failed, using native fallback');
            }
        }

        // Fallback: use native list (hashes only)
        const hashes = await this.getSavedHashes(collectionId, settings);
        return {
            items: hashes.map(hash => ({ hash })),
            metadataStatus: 'unavailable',
            complete: false,
            total: hashes.length,
        };
    }

    /**
     * Get a single chunk by hash (plugin-only feature)
     * Returns null if plugin unavailable
     */
    async getChunk(collectionId, hash, settings) {
        collectionId = adapterCollectionId(collectionId, 'standard', settings?.source || 'transformers');
        if (!this.pluginAvailable) return null;

        try {
            const response = await fetch(`/api/plugins/similharity/chunks/${encodeURIComponent(hash)}?` + new URLSearchParams({
                backend: 'vectra',
                collectionId: collectionId,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
            }), {
                headers: getRequestHeaders(),
            });

            if (response.ok) {
                const data = await response.json();
                return data.chunk;
            }
        } catch (e) {
            console.warn('VectHare: Plugin getChunk failed');
        }

        return null;
    }

    /**
     * Update chunk text (plugin-only feature)
     */
    async updateChunkText(collectionId, hash, newText, settings) {
        collectionId = adapterCollectionId(collectionId, 'standard', settings?.source || 'transformers');
        if (!this.pluginAvailable) {
            throw new Error('Chunk text editing requires the Similharity plugin');
        }

        const response = await fetch(`/api/plugins/similharity/chunks/${encodeURIComponent(hash)}/text`, {
            method: 'PATCH',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: 'vectra',
                collectionId: collectionId,
                text: newText,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`Failed to update chunk text: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        return await response.json();
    }

    /**
     * Update chunk metadata (plugin-only feature)
     */
    async updateChunkMetadata(collectionId, hash, metadata, settings) {
        collectionId = adapterCollectionId(collectionId, 'standard', settings?.source || 'transformers');
        if (!this.pluginAvailable) {
            throw new Error('Chunk metadata editing requires the Similharity plugin');
        }

        const response = await fetch(`/api/plugins/similharity/chunks/${encodeURIComponent(hash)}/metadata`, {
            method: 'PATCH',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: 'vectra',
                collectionId: collectionId,
                metadata: metadata,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`Failed to update chunk metadata: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        return await response.json();
    }

    /**
     * Get collection statistics (plugin-only feature)
     * Falls back to basic count if plugin unavailable
     */
    async getStats(collectionId, settings) {
        collectionId = adapterCollectionId(collectionId, 'standard', settings?.source || 'transformers');
        if (this.pluginAvailable) {
            try {
                const response = await fetch('/api/plugins/similharity/chunks/stats', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        backend: 'vectra',
                        collectionId: collectionId,
                        source: settings.source || 'transformers',
                        model: getModelFromSettings(settings),
                    }),
                });

                if (response.ok) {
                    const data = await response.json();
                    return data.stats;
                }
            } catch (e) {
                console.warn('VectHare: Plugin getStats failed, using native fallback');
            }
        }

        // Fallback: just return count from hash list
        const hashes = await this.getSavedHashes(collectionId, settings);
        return {
            count: hashes.length,
            source: 'native',
        };
    }

    /**
     * Discover all collections on disk
     * Plugin provides this; native API requires probing
     */
    async discoverCollections(settings) {
        if (this.pluginAvailable) {
            try {
                const response = await fetch('/api/plugins/similharity/collections', {
                    headers: getRequestHeaders(),
                });

                if (response.ok) {
                    const data = await response.json();
                    return (data.collections || []).map(c => ({
                        id: c.id,
                        source: c.source,
                        chunkCount: c.chunkCount || 0,
                        backend: c.backend || 'vectra',
                    }));
                }
            } catch (e) {
                console.warn('VectHare: Plugin discoverCollections failed');
            }
        }

        // No native way to list collections - return empty
        // Discovery will be handled by collection-loader probing known patterns
        return null;
    }
}
