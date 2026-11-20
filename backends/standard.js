import { itemMetadata } from './item-metadata.js';
import { vhLog } from '../utils/log.js';
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
import AsyncUtils from '../utils/async-utils.js';

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
    }

    async initialize(settings) {
        // Check if plugin is available
        vhLog('VectHare DEBUG: Checking plugin availability...');
        try {
            const response = await fetch('/api/plugins/similharity/health');
            vhLog('VectHare DEBUG: Plugin health check response:', response.status, response.ok);
            this.pluginAvailable = response.ok;

            if (this.pluginAvailable) {
                await fetch('/api/plugins/similharity/backend/init/vectra', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                });
                vhLog('VectHare: Standard backend initialized (plugin available)');
            } else {
                vhLog('VectHare: Standard backend initialized (native ST API only - health check failed)');
            }
        } catch (e) {
            vhLog('VectHare: Standard backend initialized (native ST API only - error:', e.message, ')');
            this.pluginAvailable = false;
        }
        
    }

    async healthCheck() {
        // Native ST API is always available if ST is running.
        //
        // This used to probe a collection named '__vecthare_health_check__'.
        // Listing a Vectra collection that does not exist CREATES it, so every
        // health check left an empty index folder behind under the active
        // source, which then showed up as a collection. The endpoint is asked
        // for nothing instead: a reachable route rejects the empty request
        // (400), an absent one answers 404, and nothing is created either way.
        try {
            const response = await fetch('/api/vector/list', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({}),
            });
            return response.status !== 404;
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
            // VH-098: SillyTavern answers a missing collection with an empty list
            // (status 200) and rebuilds a corrupted index itself; a 500 is a real
            // failure. Reading it as "nothing stored" made Sync re-insert every
            // chunk after one server error.
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`Failed to get saved hashes: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();
        // Native API returns array of hashes directly
        return Array.isArray(data) ? data : [];
    }

    /**
     * Insert vector items into a collection
     * Uses plugin API if available (for metadata support), falls back to native ST API
     */
    async insertVectorItems(collectionId, items, settings) {
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

        vhLog(`VectHare: Embedding ${items.length} chunks (avg: ${avgLen} chars, max: ${maxLen} chars at index ${longestChunkIndex}) - ${chunksWithKeywords} chunks have keywords`);

        // Debug: Log first chunk's keywords if any
        if (chunksWithKeywords > 0) {
            const firstChunkWithKeywords = items.find(item => item.keywords && item.keywords.length > 0);
            vhLog(`VectHare DEBUG: First chunk keywords:`, firstChunkWithKeywords.keywords);
        }

        // Warn if chunks are unusually large (potential OOM risk)
        if (maxLen > 2000) {
            console.warn(`VectHare: Large chunk detected (${maxLen} chars). If you see OOM errors, try reducing chunk size.`);
            console.warn(`VectHare: Problematic chunk preview: "${(items[longestChunkIndex]?.text || '').substring(0, 100)}..."`);
        }

        try {
            // Try plugin API first (supports metadata) - fallback to native API if unavailable
            vhLog('VectHare DEBUG: this.pluginAvailable =', this.pluginAvailable);
            let usePluginApi = this.pluginAvailable;
            let endpoint = usePluginApi ? '/api/plugins/similharity/chunks/insert' : '/api/vector/insert';

            vhLog(`VectHare DEBUG: Using ${usePluginApi ? 'PLUGIN' : 'NATIVE'} API for insertion (${endpoint})`);
            
            // Warn if keywords will be lost
            if (!usePluginApi && chunksWithKeywords > 0) {
                console.warn(`⚠️ VectHare: ${chunksWithKeywords} chunks have keywords, but native ST API doesn't support metadata!`);
                console.warn(`⚠️ VectHare: Install the Similharity plugin to save keywords: https://github.com/SillyTavern/SillyTavern-Extras-Similharity-plugin`);
            }

            if (!usePluginApi && !this._provenanceNativeWarned) {
                console.warn('VectHare: Native Standard insert cannot persist vecthareProvenance; records written there remain unverified.');
                this._provenanceNativeWarned = true;
            }

            const payload = usePluginApi ? {
                backend: 'vectra',
                collectionId: collectionId,
                items: items.map(item => {
                    const mappedItem = {
                        hash: item.hash,
                        text: item.text || '',
                        index: item.index ?? 0,
                        vector: item.vector,
                        metadata: { ...itemMetadata(item), keywords: itemMetadata(item).keywords || [] },
                    };
                    // Debug: Log first item's metadata
                    if (item === items[0] && item.keywords?.length > 0) {
                        vhLog(`VectHare DEBUG: First item metadata being sent:`, mappedItem.metadata);
                    }
                    return mappedItem;
                }),
                source: settings.source || 'transformers',
                model: model,
                ...providerParams,
            } : {
                collectionId: collectionId,
                items: items.map(item => ({
                    hash: item.hash,
                    text: item.text || '',
                    index: item.index ?? 0,
                })),
                source: settings.source || 'transformers',
                model: model,
                // Pass embeddings if pre-computed (for webllm, koboldcpp, bananabread)
                embeddings: items[0]?.vector ? Object.fromEntries(items.map(i => [
                    i.text || '',
                    i.vector
                ])) : undefined,
                ...providerParams,
            };

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const errorBody = await response.text().catch(() => 'No response body');
                // #47: keep a forwarded Retry-After so the retry policy obeys it.
                throw AsyncUtils.httpError(response,
                    `Failed to insert vectors: ${response.status} - ${errorBody}`);
            }

            vhLog(`VectHare Standard: Inserted ${items.length} vectors into ${collectionId}`);
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
        // VH-096: SillyTavern picks the collection's model folder from the
        // request's model for openai, ollama, cohere, vllm and others; without
        // it the delete went to a folder named "undefined" and removed nothing.
        const response = await fetch('/api/vector/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                collectionId: collectionId,
                hashes: hashes,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                ...getProviderSpecificParams(settings, false),
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
    /**
     * VH-097: search through the plugin's Vectra search, which returns real
     * similarity scores. SillyTavern's /api/vector/query returns only the stored
     * metadata (no score), so every Standard result scored 0: only chunks that
     * shared keywords with the question got past the relevance threshold.
     * Returns null when the plugin cannot answer (the native API is used then).
     */
    async _pluginQuery(collectionId, searchText, topK, settings, queryVector) {
        if (!this.pluginAvailable) return null;
        try {
            const response = await fetch('/api/plugins/similharity/chunks/query', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    backend: 'vectra',
                    collectionId,
                    searchText,
                    ...(Array.isArray(queryVector) && queryVector.length ? { queryVector } : {}),
                    topK,
                    threshold: 0.0,
                    source: settings.source || 'transformers',
                    model: getModelFromSettings(settings),
                    ...getProviderSpecificParams(settings, true),
                }),
            });
            if (!response.ok) {
                console.warn(`VectHare: Plugin search failed for ${collectionId} (HTTP ${response.status}); using SillyTavern's search (no scores)`);
                return null;
            }
            const data = await response.json();
            const results = Array.isArray(data?.results) ? data.results : null;
            if (!results) return null;
            return {
                hashes: results.map(r => r.hash),
                metadata: results.map(r => ({ ...(r.metadata || {}), hash: r.hash, text: r.text ?? r.metadata?.text, score: r.score })),
            };
        } catch (error) {
            console.warn(`VectHare: Plugin search failed for ${collectionId}: ${error?.message || error}; using SillyTavern's search (no scores)`);
            return null;
        }
    }

    async queryCollection(collectionId, searchText, topK, settings, queryVector = null) {
        const viaPlugin = await this._pluginQuery(collectionId, searchText, topK, settings, queryVector);
        if (viaPlugin) return viaPlugin;
        const providerParams = getProviderSpecificParams(settings, true);
        const model = getModelFromSettings(settings);

        const requestBody = {
            collectionId: collectionId,
            searchText: searchText,
            topK: topK,
            // #10: the relevance threshold is applied by the RAG pipeline AFTER
            // keyword boosting and BM25 fusion (Stage 6). Pre-filtering here
            // dropped keyword-strong candidates before they could be promoted,
            // and the other backends already send no threshold.
            threshold: 0.0,
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

        // Native API returns { hashes: [], metadata: [] }
        return {
            hashes: data.hashes || [],
            metadata: (data.metadata || []).map((m, idx) => ({
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
        // VH-097: with the plugin, search each collection with scores (as LanceDB does).
        if (this.pluginAvailable) {
            const results = {};
            let answered = true;
            for (const collectionId of collectionIds) {
                const one = await this._pluginQuery(collectionId, searchText, topK, settings, queryVector);
                if (!one) { answered = false; break; }
                const keep = one.metadata.map((m, i) => i).filter(i => (one.metadata[i].score ?? 0) >= (threshold || 0));
                results[collectionId] = { hashes: keep.map(i => one.hashes[i]), metadata: keep.map(i => one.metadata[i]) };
            }
            if (answered) return results;
        }
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

    /** Purge only this VectHare collection's source/model index.
     * ST's native purge removes every embedding source for a collection ID.
     */
    async purgeVectorIndex(collectionId, settings) {
        const response = await fetch('/api/plugins/similharity/chunks/purge', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: 'vectra',
                collectionId,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                // Set only by a deletion the user explicitly confirmed for a
                // collection VectHare cannot prove is its own.
                ...(settings.__vecthareConfirmUnowned === true ? { confirmUnowned: true } : {}),
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`Failed to purge scoped Vectra index: ${response.status} ${response.statusText} - ${errorBody}`);
        }
        if ((await response.json()).success !== true) {
            throw new Error('Scoped Vectra purge was not confirmed');
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
        // Never call a backend-wide purge: Standard shares ST's vector directory,
        // and LanceDB/Milvus may share physical storage with other consumers.
        throw new Error('Unsafe global purge is forbidden; delete verified VectHare collections individually');
    }

    // ========================================================================
    // EXTENDED API METHODS (plugin-only, graceful fallback)
    // ========================================================================

    /**
     * List chunks with pagination (plugin-only feature)
     * Falls back to basic hash list if plugin unavailable
     */
    async listChunks(collectionId, settings, options = {}) {
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
                        strictRead: options.strictRead === true,
                    }),
                });

                if (response.ok) {
                    return await response.json();
                }
                if (options.strictRead) throw new Error(`Metadata listing failed (HTTP ${response.status})`);
            } catch (e) {
                if (options.strictRead) throw e;
                console.warn('VectHare: Plugin listChunks failed, using native fallback');
            }
        }
        if (options.strictRead) throw new Error('Plugin metadata listing is unavailable');

        // Fallback: use native list (hashes only)
        const hashes = await this.getSavedHashes(collectionId, settings);
        return {
            items: hashes.map(hash => ({ hash, text: '', metadata: {} })),
            total: hashes.length,
        };
    }

    /**
     * P5: stored records for the given hashes only (verification after writes).
     * Returns null when the plugin cannot answer, so the caller reads in full.
     */
    async getChunksByHashes(collectionId, hashes, settings) {
        if (!this.pluginAvailable) return null;
        const response = await fetch('/api/plugins/similharity/chunks/get-by-hashes', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: 'vectra',
                collectionId: collectionId,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
                hashes,
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
     * Get a single chunk by hash (plugin-only feature)
     * Returns null if plugin unavailable
     */
    async getChunk(collectionId, hash, settings) {
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
