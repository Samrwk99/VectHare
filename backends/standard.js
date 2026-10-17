import { withSharedWriteHeaders,runExclusiveNativeMutation } from '../ui/shared-operations.js';
import { saveVectHareSettingsDebounced as saveSettingsDebounced } from '../core/settings-durability.js';
import { assertEmbeddingQueryFits } from '../core/embedding-overflow.js';
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
import { extension_settings } from '../../../../extensions.js';
import { VectorBackend } from './backend-interface.js';
import { getModelField } from '../core/providers.js';
import { getProviderSpecificParams } from './provider-params.js';
import { VECTOR_LIST_LIMIT } from '../core/constants.js';

/**
 * Get the model value from settings based on provider
 */
function getModelFromSettings(settings) {
    const modelField = getModelField(settings.source);
    return modelField ? settings[modelField] || '' : '';
}

/**
 * Native SillyTavern vector storage does not persist rich VectHare metadata.
 * Maintain a per-source/per-collection sidecar for metadata + text. It is
 * committed ONLY after a successful native write, and dropped ONLY after a
 * successful delete/purge. This is not a substitute for plugin-side metadata
 * when sharing databases between installations (export settings together).
 */
function nativeSidecars() {
    if (!extension_settings.vecthare) throw new Error('VectHare settings are unavailable');
    return extension_settings.vecthare.nativeStandardChunks ||= {};
}
function sidecarKey(collectionId, settings) {
    return JSON.stringify(['standard', settings?.source || 'transformers', getModelFromSettings(settings), collectionId]);
}
function nativeRecord(item) {
    const extras = ['keywords', 'importance', 'customWeights', 'disabledKeywords',
        'chunkGroup', 'conditions', 'summary', 'isSummaryChunk', 'parentHash'];
    const metadata = { ...(item.metadata || {}) };
    for (const key of extras) if (item[key] !== undefined) metadata[key] = item[key];
    return { hash: item.hash, text: item.text || '', index: item.index ?? 0, metadata };
}
function saveSidecar(collectionId, items, settings) {
    const key = sidecarKey(collectionId, settings);
    const records = nativeSidecars()[key] ||= {};
    for (const item of items) records[String(item.hash)] = nativeRecord(item);
    saveSettingsDebounced();
}
function deleteSidecarHashes(collectionId, hashes, settings) {
    const records = nativeSidecars()[sidecarKey(collectionId, settings)];
    if (!records) return;
    for (const hash of hashes) delete records[String(hash)];
    saveSettingsDebounced();
}
function purgeSidecars(collectionId) {
    let changed = false;
    for (const key of Object.keys(nativeSidecars())) {
        try {
            const [, , , storedCollection] = JSON.parse(key);
            if (storedCollection === collectionId) {
                delete nativeSidecars()[key];
                changed = true;
            }
        } catch { /* preserve unknown keys; never guess which collection */ }
    }
    if (changed) saveSettingsDebounced();
}

export class StandardBackend extends VectorBackend {
    constructor() {
        super();
        this.pluginAvailable = false;
    }

    async initialize(settings) {
        // Check if plugin is available
        console.log('VectHare DEBUG: Checking plugin availability...');
        try {
            const response = await fetch('/api/plugins/similharity/health');
            console.log('VectHare DEBUG: Plugin health check response:', response.status, response.ok);
            this.pluginAvailable = response.ok;

            if (this.pluginAvailable) {
                await fetch('/api/plugins/similharity/backend/init/vectra', {
                    method: 'POST',
                    headers: withSharedWriteHeaders(getRequestHeaders()),
                });
                console.log('VectHare: Standard backend initialized (plugin available)');
            } else {
                console.log('VectHare: Standard backend initialized (native ST API only - health check failed)');
            }
        } catch (e) {
            console.log('VectHare: Standard backend initialized (native ST API only - error:', e.message, ')');
            this.pluginAvailable = false;
        }
        
    }

    async healthCheck() {
        // Probe the native API. Even a missing collection should return HTTP 200
        // with an empty hash array; HTTP 500 is a server failure, not "not found".
        try {
            const response = await fetch('/api/vector/list', {
                method: 'POST',
                headers: withSharedWriteHeaders(getRequestHeaders()),
                body: JSON.stringify({
                    collectionId: '__vecthare_health_check__',
                    source: 'transformers'
                }),
            });
            if (!response.ok) {
                console.warn(`[Standard] Native vector health check returned HTTP ${response.status}`);
                return false;
            }
            const hashes = await response.json();
            return Array.isArray(hashes);
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
            headers: withSharedWriteHeaders(getRequestHeaders()),
            body: JSON.stringify({
                collectionId: collectionId,
                source: settings.source || 'transformers',
                model: model,
                ...providerParams,
            }),
        });

        if (!response.ok) {
            // SillyTavern's /api/vector/list returns 200 + [] for an empty (or
            // newly created) index. A 500 indicates a backend/index error.
            // Never disguise it as an empty collection: callers use the hash
            // list for incremental sync, repair, and deletion decisions.
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Standard] Failed to list hashes for ${collectionId}: HTTP ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();
        if (!Array.isArray(data)) {
            throw new Error(`[Standard] Invalid hash list for ${collectionId}: native API returned ${data === null ? 'null' : typeof data}, expected an array`);
        }
        return data;
    }

    /**
     * Insert vector items into a collection
     * Uses plugin API if available (for metadata support), falls back to native ST API
     */
    async insertVectorItems(collectionId, items, settings) {
        // Plugin routes are fenced by their own middleware. Native HTTP routes
        // are not, so a shared lease must encompass the entire native write.
        if(this.pluginAvailable)return this._insertVectorItems(collectionId, items, settings);
        return runExclusiveNativeMutation('Standard: insertVectorItems',collectionId,()=>this._insertVectorItems(collectionId, items, settings));
    }

    async _insertVectorItems(collectionId, items, settings) {
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
            // Try plugin API first (supports metadata) - fallback to native API if unavailable
            console.log('VectHare DEBUG: this.pluginAvailable =', this.pluginAvailable);
            let usePluginApi = this.pluginAvailable;
            if (['nanogpt','custom','ollama'].includes(settings.source) && !usePluginApi) {
                throw new Error(`${settings.source} requires the matching Similharity plugin for safe embedding requests (Ollama truncate:false and custom provider routing); refusing an unsafe native fallback`);
            }
            let endpoint = usePluginApi ? '/api/plugins/similharity/chunks/insert' : '/api/vector/insert';

            console.log(`VectHare DEBUG: Using ${usePluginApi ? 'PLUGIN' : 'NATIVE'} API for insertion (${endpoint})`);
            
            // Warn if keywords will be lost
            if (!usePluginApi && chunksWithKeywords > 0) {
                console.warn(`⚠️ VectHare: ${chunksWithKeywords} chunks have keywords, but native ST API doesn't support metadata!`);
                console.warn(`⚠️ VectHare: Install the Similharity plugin to save keywords: https://github.com/SillyTavern/SillyTavern-Extras-Similharity-plugin`);
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
                        metadata: {
                            ...item.metadata,
                            keywords: item.keywords || [],
                            importance: item.importance,
                            customWeights: item.customWeights,
                            disabledKeywords: item.disabledKeywords,
                            chunkGroup: item.chunkGroup,
                            conditions: item.conditions,
                            summary: item.summary,
                            isSummaryChunk: item.isSummaryChunk,
                            parentHash: item.parentHash,
                        },
                    };
                    // Debug: Log first item's metadata
                    if (item === items[0] && item.keywords?.length > 0) {
                        console.log(`VectHare DEBUG: First item metadata being sent:`, mappedItem.metadata);
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
                headers: withSharedWriteHeaders(getRequestHeaders()),
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const errorBody = await response.text().catch(() => 'No response body');
                throw new Error(`Failed to insert vectors: ${response.status} - ${errorBody}`);
            }

            if (!usePluginApi) saveSidecar(collectionId, items, settings);
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
        return runExclusiveNativeMutation('Standard: deleteVectorItems',collectionId,()=>this._deleteVectorItems(collectionId, hashes, settings));
    }

    async _deleteVectorItems(collectionId, hashes, settings) {
        const response = await fetch('/api/vector/delete', {
            method: 'POST',
            headers: withSharedWriteHeaders(getRequestHeaders()),
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
        deleteSidecarHashes(collectionId, hashes, settings);
    }

    /**
     * Query a collection for similar vectors
     * Uses native ST API
     */
    async queryCollection(collectionId, searchText, topK, settings, queryVector = null) {
        if (!queryVector) await assertEmbeddingQueryFits(searchText, settings);
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
            headers: withSharedWriteHeaders(getRequestHeaders()),
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`Failed to query collection: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        const data = await response.json();

        // Native API returns { hashes: [], metadata: [] }
        const hashes = data.hashes || [];
        const sidecar = nativeSidecars()[sidecarKey(collectionId, settings)] || {};
        return {
            hashes,
            metadata: hashes.map((hash, idx) => {
                const m = (data.metadata || [])[idx] || {};
                const stored = sidecar[String(hash)];
                return {
                    ...stored?.metadata,
                    hash,
                    text: m.text || stored?.text || '',
                    ...m,
                    score: m.score ?? 0,
                };
            }),
        };
    }

    /**
     * Query multiple collections
     * Uses native ST API
     */
    async queryMultipleCollections(collectionIds, searchText, topK, threshold, settings, queryVector = null) {
        if (!queryVector) await assertEmbeddingQueryFits(searchText, settings);
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
            headers: withSharedWriteHeaders(getRequestHeaders()),
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

        const results = await response.json();
        // Preserve locally recorded chunk attributes when native results omit
        // them; never merge metadata belonging to another collection.
        for (const [collectionId, result] of Object.entries(results || {})) {
            if (!result || !Array.isArray(result.hashes)) continue;
            const sidecar = nativeSidecars()[sidecarKey(collectionId, settings)] || {};
            result.metadata = result.hashes.map((hash, i) => {
                const server = result.metadata?.[i] || {};
                const stored = sidecar[String(hash)];
                return { ...stored?.metadata, hash, text: server.text || stored?.text || '', ...server };
            });
        }
        return results;
    }

    /**
     * Purge (delete) a collection
     * Uses native ST API
     */
    async purgeVectorIndex(collectionId, settings) {
        return runExclusiveNativeMutation('Standard: purgeVectorIndex',collectionId,()=>this._purgeVectorIndex(collectionId, settings));
    }

    async _purgeVectorIndex(collectionId, settings) {
        const response = await fetch('/api/vector/purge', {
            method: 'POST',
            headers: withSharedWriteHeaders(getRequestHeaders()),
            body: JSON.stringify({
                collectionId: collectionId,
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`Failed to purge collection: ${response.status} ${response.statusText} - ${errorBody}`);
        }
        purgeSidecars(collectionId);
    }

    async purgeFileVectorIndex(collectionId, settings) {
        return this.purgeVectorIndex(collectionId, settings);
    }

    /**
     * Purge all vector indexes
     * Uses native ST API
     */
    async purgeAllVectorIndexes() {
        // Whole-user native purge also deletes unrelated SillyTavern vectors.
        // Only the scoped, verified VectHare purge flow is permitted.
        throw new Error('Unsafe native Purge All is disabled. Use the VectHare scoped Purge dialog instead.');
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
                    headers: withSharedWriteHeaders(getRequestHeaders()),
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
                    const result=await response.json();
                    if(!result || result.success === false || !Array.isArray(result.items) ||
                       (result.total != null && (!Number.isSafeInteger(result.total) || result.total<0)))
                        throw new Error('Similharity chunk listing returned malformed or failed success data');
                    return result;
                }
                if (response.status !== 404 && response.status !== 501)
                    throw new Error(`Similharity chunk listing failed (HTTP ${response.status})`);
            } catch (e) {
                // Network errors and server failures must not become false-empty.
                throw new Error(`Similharity chunk listing unavailable: ${e.message}`, {cause:e});
            }
        }

        // Fallback: use native list (hashes only)
        const hashes = await this.getSavedHashes(collectionId, settings);
        const records = nativeSidecars()[sidecarKey(collectionId, settings)] || {};
        const offset = Math.max(0, options.offset || 0);
        const limit = Math.max(1, options.limit || 100);
        return {
            items: hashes.slice(offset, offset + limit).map(hash => records[String(hash)] ||
                { hash, text: '', metadata: { unverifiedNativeMetadata: true } }),
            total: hashes.length,
        };
    }

    /**
     * Get a single chunk by hash (plugin-only feature)
     * Returns null if plugin unavailable
     */
    async getChunk(collectionId, hash, settings) {
        if (!this.pluginAvailable) {
            const hashes = await this.getSavedHashes(collectionId, settings);
            if (!hashes.some(h => String(h) === String(hash))) return null;
            return nativeSidecars()[sidecarKey(collectionId, settings)]?.[String(hash)] || null;
        }

        try {
            const response = await fetch(`/api/plugins/similharity/chunks/${encodeURIComponent(hash)}?` + new URLSearchParams({
                backend: 'vectra',
                collectionId: collectionId,
                source: settings.source || 'transformers',
                model: getModelFromSettings(settings),
            }), {
                headers: withSharedWriteHeaders(getRequestHeaders()),
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
        await assertEmbeddingQueryFits(newText, settings); // Edit re-embeds one vector; do not silently truncate or split it.
        if (!this.pluginAvailable) {
            throw new Error('Chunk text editing requires the Similharity plugin');
        }

        const response = await fetch(`/api/plugins/similharity/chunks/${encodeURIComponent(hash)}/text`, {
            method: 'PATCH',
            headers: withSharedWriteHeaders(getRequestHeaders()),
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
            headers: withSharedWriteHeaders(getRequestHeaders()),
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
                    headers: withSharedWriteHeaders(getRequestHeaders()),
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
                    headers: withSharedWriteHeaders(getRequestHeaders()),
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
