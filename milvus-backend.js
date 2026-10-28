/**
 * ============================================================================
 * MILVUS BACKEND
 * ============================================================================
 * Server-side Milvus vector database operations.
 * Uses the official nodejs sdk.
 *
 * Multitenancy Strategy:
 * - ONE collection: "vecthare_main"
 * - Scalar fields for filtering: type, sourceId, etc.
 *
 * @author VectHare
 * @version 1.0.0
 * ============================================================================
 */

import { MilvusClient } from '@zilliz/milvus2-sdk-node';
import { denyUnsafeBackendMutation, SafetyError } from './lib/s01-safety.js';

/**
 * Milvus Backend Manager
 * Manages Milvus connection and operations
 */
class MilvusBackend {
    constructor() {
        this.client = null;
        // params must be stringified for some SDK versions
        this.baseParams = { 
            metric_type: 'COSINE', 
            index_type: 'IVF_FLAT', 
            params: JSON.stringify({ nlist: 1024 }) 
        };
        this.isConnected = false;
        this.config = {
            address: '127.0.0.1:19530',
            token: '', // API token or user:password
            ssl: false,
            dimensions: null,
        };
    }

    /**
     * Initialize Milvus connection
     * @param {object} config - Configuration { address, token, ssl, dimensions }
     */
    async initialize(config = {}) {
        this.config = { ...this.config, ...config };
        
        console.log(`[Milvus] Initializing connection to ${this.config.address}...`);
        
        try {
            this.client = new MilvusClient({
                address: this.config.address,
                token: this.config.token,
                ssl: this.config.ssl
            });

            // Test connection by listing collections
            await this.client.listCollections();
            this.isConnected = true;
            console.log('[Milvus] Connection successful');
            
            // S01: Initialization is connection-only. Never auto-create or
            // recreate shared collections before identity/schema migration.
            
        } catch (error) {
            this.isConnected = false;
            console.error('[Milvus] Connection failed:', error.message);
            throw error;
        }
    }

    /**
     * Health check
     * @returns {Promise<boolean>}
     */
    async healthCheck() {
        try {
            if (!this.client) return false;
            await this.client.listCollections();
            return true;
        } catch (error) {
            console.error('[Milvus] Health check failed:', error.message);
            return false;
        }
    }

    /**
     * Ensure collection exists with proper schema
     * @param {string} collectionName - Collection name
     * @param {number} vectorSize - Vector dimension
     */
    async ensureCollection(collectionName, vectorSize = 768) {
        if (!this.isConnected) throw new Error('Milvus not initialized');
        // S01: explicit, read-only verification. Never drop, recreate,
        // create indexes, or create a shared legacy schema on this path.
        const listing = await this.client.listCollections();
        const collections = listing?.data;
        if (!Array.isArray(collections)) {
            throw new SafetyError('SCHEMA_UNVERIFIABLE', 'Milvus collection inventory is unavailable.');
        }
        if (!collections.some(c => c.name === collectionName)) {
            throw new SafetyError('S01_COLLECTION_CREATION_BLOCKED',
                `Milvus collection ${collectionName} does not exist; creation is disabled in S01.`);
        }
        const desc = await this.client.describeCollection({ collection_name: collectionName });
        const vectorField = desc?.schema?.fields?.find(f => f.name === 'vector');
        if (!vectorField) {
            throw new SafetyError('SCHEMA_MISMATCH',
                `Milvus collection ${collectionName} has no vector field.`);
        }
        const dimParam = vectorField.dim ?? vectorField.params?.find(p => p.key === 'dim')?.value;
        const existingDim = Number(dimParam);
        if (!Number.isSafeInteger(existingDim) || existingDim <= 0) {
            throw new SafetyError('SCHEMA_UNVERIFIABLE',
                `Milvus collection ${collectionName} dimension cannot be verified.`);
        }
        if (existingDim !== vectorSize) {
            throw new SafetyError('DIMENSION_MISMATCH',
                `Milvus collection uses ${existingDim} dimensions; requested ${vectorSize}.`);
        }
        return { dimension: existingDim, verified: true };
    }

    /**
     * Insert vectors into collection
     * @param {string} collectionName - Collection name
     * @param {Array} items - Items to insert
     * @param {object} tenantMetadata - Metadata for tenancy
     */
    async insertVectors(collectionName, items, tenantMetadata = {}) {
        denyUnsafeBackendMutation('milvus', 'insertVectors');
    }


    /**
     * Delete vectors by hash
     * @param {string} collectionName 
     * @param {number[]} hashes 
     */
    async deleteVectors(collectionName, hashes) {
        denyUnsafeBackendMutation('milvus', 'deleteVectors');
    }


    /**
     * Build boolean expression for filtering
     */
    _buildFilterExpr(filters) {
        const conditions = [];
        
        if (filters.type) conditions.push(`type == "${filters.type}"`);
        if (filters.sourceId) conditions.push(`sourceId == "${filters.sourceId}"`);
        if (filters.embeddingSource) conditions.push(`embeddingSource == "${filters.embeddingSource}"`);
        if (filters.timestampAfter) conditions.push(`timestamp >= ${filters.timestampAfter}`);
        
        return conditions.length > 0 ? conditions.join(' && ') : '';
    }

    /**
     * Query/Search for similar vectors
     */
    async queryCollection(collectionName, queryVector, topK = 10, filters = {}) {
        if (!this.isConnected) throw new Error('Milvus not initialized');

        const mainCollection = 'vecthare_main';
        const filterExpr = this._buildFilterExpr(filters);

        try {
            // Need to verify collection is loaded
            await this.client.loadCollection({ collection_name: mainCollection });

            const results = await this.client.search({
                collection_name: mainCollection,
                vector: queryVector,
                filter: filterExpr || undefined,
                limit: topK,
                output_fields: ['hash', 'text', 'metadata']
            });

            return results.results.map(r => ({
                hash: Number(r.hash),
                text: r.text,
                score: r.score,
                metadata: r.metadata
            }));

        } catch (error) {
            console.error('[Milvus] Search failed:', error.message);
            throw error;
        }
    }

    /**
     * List items (Query by scalar)
     */
    async listItems(collectionName, filters = {}, options = {}) {
        if (!this.isConnected) throw new Error('Milvus not initialized');

        const mainCollection = 'vecthare_main';
        const filterExpr = this._buildFilterExpr(filters) || 'hash > 0'; // Always need an expression for query

        try {
            await this.client.loadCollection({ collection_name: mainCollection });

            const output_fields = ['hash', 'text', 'metadata'];
            if (options.includeVectors) output_fields.push('vector');

            // Milvus query doesn't support easy pagination like "scroll" in Qdrant
            // But we can use limit/offset
            const limit = options.limit || 100;
            const offset = options.offset || 0;

            const results = await this.client.query({
                collection_name: mainCollection,
                filter: filterExpr,
                output_fields: output_fields,
                limit: limit,
                offset: offset
            });

            return results.data.map(r => ({
                hash: Number(r.hash),
                text: r.text,
                metadata: r.metadata,
                vector: options.includeVectors ? r.vector : undefined
            }));

        } catch (error) {
            console.error('[Milvus] List items failed:', error.message);
            throw error;
        }
    }

    /**
     * Get single item
     */
    async getItem(collectionName, hash, filters = {}) {
        if (!this.isConnected) throw new Error('Milvus not initialized');
        const mainCollection = 'vecthare_main';

        try {
            const results = await this.client.query({
                collection_name: mainCollection,
                filter: `hash == ${hash}`,
                output_fields: ['hash', 'text', 'vector', 'metadata'],
                limit: 1
            });

            if (results.data.length === 0) return null;
            const r = results.data[0];
            
            return {
                hash: Number(r.hash),
                text: r.text,
                vector: r.vector,
                metadata: r.metadata
            };

        } catch (error) {
            console.error('[Milvus] Get item failed:', error.message);
            throw error;
        }
    }

    /**
     * Update item (delete & insert)
     */
    async updateItem(collectionName, hash, updates, filters = {}) {
        denyUnsafeBackendMutation('milvus', 'updateItem');
    }


    /**
     * Purge collection (drop & recreate or delete by filter)
     * If filters present, delete by filter. If no filters, drop collection.
     */
    async purgeCollection(collectionName, filters = {}) {
        denyUnsafeBackendMutation('milvus', 'purgeCollection');
    }


    /**
     * Get stats
     */
    async getCollectionStats(collectionName, filters = {}) {
        if (!this.isConnected) throw new Error('Milvus not initialized');
        const mainCollection = 'vecthare_main';

        try {
            const stats = await this.client.getCollectionStatistics({
                collection_name: mainCollection
            });

            const rowCount = stats.data.row_count;

            // Approximate token count if we can't query all efficiently
            // For now return basic stats
            return {
                chunkCount: Number(rowCount),
                backend: 'milvus'
            };

        } catch (error) {
            throw error;
        }
    }
}

const milvusBackend = new MilvusBackend();
export default milvusBackend;
