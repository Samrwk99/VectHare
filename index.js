/**
 * Similharity Server Plugin
 *
 * Unified vector database backend for VectHare extension.
 * Supports multiple backends: Vectra (file-based), LanceDB, Qdrant
 *
 * All chunk operations go through unified /chunks/* endpoints.
 * Backend is specified via `backend` parameter in request body.
 *
 * @version 3.2.11-m4d
 */

import path from 'node:path';
import fs from 'node:fs/promises';

import sanitize from 'sanitize-filename';
import vectra from 'vectra';
import { s01MutationGuard } from './lib/s01-safety.js';
import { authenticatedContext, forbidOwnerSpoof, validateClientConfig,
    lookupAuthorizedReservation, legacyReadBoundary, s03SensitiveRouteBoundary,
    AccessError, exposedSafeSource } from './lib/s03-security.js';
import { BackendPool } from './lib/s03-backends.js';
import { registerGuiConnectionRoutes } from './lib/s10-gui-connections.js';
import { safeLegacyPhysicalName } from './lib/s02-identity.js';
import { registerS04Routes } from './lib/s04-routes.js';
import {registerM0GatewayRoutes} from './lib/m0-gateway.js';
import {registerM1Routes,readM1HostEvidence} from './lib/m1-saved-records.js';
import {m0WriteBoundary} from './lib/m0-write-boundary.js';
import { registerS05Routes } from './lib/s05-routes.js';
import {registerF02Routes} from './lib/f02-public-reads.js';
import {registerF09WorkflowRoutes} from './lib/f09-workflows.js';
import {registerF09bSyncRoutes} from './lib/f09b-chat-sync.js';
import {registerF09b3SyncRoutes} from './lib/f09b3-chat-sync-execute.js';
import {registerF09b4LifecycleRoutes} from './lib/f09b4-chat-lifecycle.js';
import {registerF09b5EmbeddingRoutes,generateManagedEmbedding} from './lib/f09b5-embedding-profiles.js';
import {registerF09b6Routes} from './lib/f09b6-content-workflows.js';
import {registerF09b7Routes} from './lib/f09b7-link-conditions.js';
import {registerF10Routes} from './lib/f10-recovery-capture.js';
import {registerF11ReadinessRoutes} from './lib/f11-readiness.js';
import {registerF12ReleaseRoutes} from './lib/f12-release-assessment.js';
import {registerF03ProvisionRoutes} from './lib/f03-provision.js';
import {registerF04PilotRoutes} from './lib/f04-pilot-mutations.js';
import {registerF05AcceptanceRoutes} from './lib/f05-qdrant-acceptance.js';
import {registerF06AcceptanceRoutes} from './lib/f06-lancedb.js';
import {registerF06PilotRoutes} from './lib/f06-lancedb-pilot.js';
import {f07SealedVectra,f07VectraLocation} from './lib/f07-vectra.js';
import {registerF07PilotRoutes} from './lib/f07-vectra-pilot.js';
import {registerF07AcceptanceRoutes} from './lib/f07-vectra-acceptance.js';
import {registerF08MilvusPilotRoutes} from './lib/f08-milvus.js';
import {registerF08AcceptanceRoutes} from './lib/f08-milvus-acceptance.js';
import { loadS10Build } from './lib/s10-build.js';
import { registerS10Routes } from './lib/s10-contracts.js';
import {registerH01AcceptanceRoutes} from './lib/h01-qdrant-acceptance.js';
import {registerM2Routes} from './lib/m2-jobs.js';
import {registerM3Routes} from './lib/m3-collections.js';
import {registerM4aLanceRoutes} from './lib/m4a-lancedb-lifecycle.js';
import {registerM4bVectraRoutes} from './lib/m4b-vectra-lifecycle.js';
import {registerM4cMilvusRoutes} from './lib/m4c-milvus-lifecycle.js';
import {registerF01HostRoutes} from './lib/f01-host-sources.js';
import { validateVector as validateS05Vector } from './lib/s05-contract.js';

const pluginName = 'similharity';
const pluginVersion = '3.2.11-m4d';

/**
 * Initialize the plugin
 * @param {import('express').Router} router - Express router for plugin endpoints
 */
export async function init(router) {
    // Refuse to register any routes if the installed executable source does not match
    // its generated S10 build manifest. This is local integrity, not remote attestation.
    const s10Build = await loadS10Build(undefined, pluginVersion);
    console.log(`[${pluginName}] Initializing v${pluginVersion}...`);
    // S01: must run before ALL legacy routes, including /chunks/:hash/* and /purge-all.
    router.use(s01MutationGuard);
    // M0 fail-closed boundary before ANY existing pilot, diagnostic or legacy writer.
    router.use(m0WriteBoundary);
    const backendPool = new BackendPool();
    // Authentication is inherited from the SillyTavern host router. Do not
    // accept a user identity from request body, query or headers.
    router.use(async (req, res, next) => {
        if (req.path === '/health' && req.method === 'GET') return next();
        try {
            req.s03 = await authenticatedContext(req);
            forbidOwnerSpoof(req.body, req.s03);
            forbidOwnerSpoof(req.query, req.s03);
            next();
        } catch (error) {
            res.status(error.status || 403).json({success:false, code:error.code || 'S03_AUTH_UNVERIFIED',
                error:'Authenticated user scope could not be verified.'});
        }
    });
    router.use(s03SensitiveRouteBoundary);
    router.use((req,res,next)=>{
        if (req.path.startsWith('/chunks/') && req.method === 'POST') {
            const forbidden=['apiKey','apiUrl','extrasKey','extrasUrl','token','baseUrl','address'];
            if (forbidden.some(k => Object.hasOwn(req.body || {},k))) {
                return res.status(403).json({success:false,code:'S03_CLIENT_CONNECTION_FORBIDDEN'});
            }
        }
        next();
    });
    router.use(legacyReadBoundary);
    // S04 endpoints are preflight/status-only. No public mutation dispatch.
    registerS04Routes(router);
    // M0: authenticated source-attested plan and read-only capabilities; execution blocked.
    // M1 takes precedence for its narrow source-attested plan/execute routes.
    // M0 generic denials, S01 and S04 legacy denials stay in force.
    registerM1Routes(router,{backendPool,
      createVectra:(req,binding)=>f07SealedVectra(req,binding,{createIndex:folder=>new vectra.LocalIndex(folder),
        requireReceipt:!(binding.collection.generation>0)}),
      makeVectraIndex:folder=>new vectra.LocalIndex(folder),
      hostEmbed:(req,source,text,model)=>getEmbeddingForSource(source,text,model,req.user.directories,req)});
    registerM2Routes(router,{backendPool});
    registerM3Routes(router,{backendPool});
    registerM4aLanceRoutes(router,{backendPool});
    registerM4cMilvusRoutes(router,{backendPool});
    registerM4bVectraRoutes(router,{
      createVectra:(req,binding)=>f07SealedVectra(req,binding,{createIndex:folder=>new vectra.LocalIndex(folder),
        requireReceipt:!(binding.collection.generation>0)}),
      makeVectraIndex:folder=>new vectra.LocalIndex(folder)});
    registerM0GatewayRoutes(router,{liveCapabilityEvidence:async()=>{
      const evidenceByOperation={};
      for(const operation of ['insert','update','revectorize','delete']){
        const evidence=await readM1HostEvidence(operation);
        if(evidence)evidenceByOperation[`qdrant:${operation}`]=evidence;
      }
      return {hostVersion:process.env.SIMILHARITY_STABLE_ST_VERSION??null,evidenceByOperation};
    }});
    const f02ReadHandler=registerF02Routes(router,{backendPool,createVectra:async(req,binding)=>{
        // No fabricated index seal or auto-creation: S08 refuses unprovisioned Vectra.
        return f07SealedVectra(req,binding,{createIndex:folder=>new vectra.LocalIndex(folder)});
    }});
    registerS05Routes(router,{readHandler:f02ReadHandler});
    registerF09WorkflowRoutes(router,{backendPool,createVectra:async(req,binding)=>
      f07SealedVectra(req,binding,{createIndex:folder=>new vectra.LocalIndex(folder)})});
    registerF09bSyncRoutes(router,{backendPool,createVectra:async(req,binding)=>
      f07SealedVectra(req,binding,{createIndex:folder=>new vectra.LocalIndex(folder)})});
    const managedEmbed=(source,text,model,directories,req)=>generateManagedEmbedding(req.s03,
      {...req.body.embedding},text,{hostEmbed:(s,t,m)=>getEmbeddingForSource(s,t,m,directories,req)});
    registerF09b5EmbeddingRoutes(router,{hostEmbed:(req,s,t,m)=>getEmbeddingForSource(s,t,m,req.user.directories,req)});
    registerF09b3SyncRoutes(router,{backendPool,embed:managedEmbed,
      createVectra:async(req,binding)=>f07SealedVectra(req,binding,{createIndex:folder=>new vectra.LocalIndex(folder)})});
    registerF09b7Routes(router,{backendPool,createVectra:async(req,binding)=>
      f07SealedVectra(req,binding,{createIndex:folder=>new vectra.LocalIndex(folder)})});
    registerF09b6Routes(router,{backendPool,embed:managedEmbed,
      createVectra:async(req,binding)=>f07SealedVectra(req,binding,{createIndex:folder=>new vectra.LocalIndex(folder)})});
    registerF09b4LifecycleRoutes(router,{backendPool,embed:managedEmbed,
      createVectra:async(req,binding)=>f07SealedVectra(req,binding,{createIndex:folder=>new vectra.LocalIndex(folder)})});
    registerF10Routes(router,{backendPool,createVectra:async(req,binding)=>
      f07SealedVectra(req,binding,{createIndex:folder=>new vectra.LocalIndex(folder)})});
    registerF03ProvisionRoutes(router,{backendPool,createVectra:async(req,binding)=>{
      const folder=await f07VectraLocation(req.s03,binding,{createRoot:true});
      return {folder,index:new vectra.LocalIndex(folder)};
    }});
    registerF04PilotRoutes(router,{backendPool});
    registerF05AcceptanceRoutes(router,{backendPool});
    registerF06AcceptanceRoutes(router,{backendPool});
    registerF06PilotRoutes(router,{backendPool});
    registerF07PilotRoutes(router,{createVectra:(req,binding)=>f07SealedVectra(req,binding,{createIndex:folder=>new vectra.LocalIndex(folder)})});
    registerF07AcceptanceRoutes(router,{makeIndex:folder=>new vectra.LocalIndex(folder)});
    registerF08MilvusPilotRoutes(router,{backendPool});
    registerF08AcceptanceRoutes(router,{backendPool});
    registerS10Routes(router, s10Build);
    registerH01AcceptanceRoutes(router,{backendPool});
    registerF01HostRoutes(router);
    registerGuiConnectionRoutes(router,{backendPool});
    registerF11ReadinessRoutes(router);
    registerF12ReleaseRoutes(router);
    // NOTE: S02 registry mappings are reservations only; this route exposes
    // no mutation or claim that the physical collection belongs to the user.
    router.post('/v2/identity/resolve', async (req,res) => {
        try {
            const info = await lookupAuthorizedReservation(req.s03,req.body);
            res.json({success:true, schemaVersion:2, identity:info.identity,
                reservation:info.entry ? {key:info.entry.key,status:info.entry.status} : null,
                operational:false, writesEnabled:false});
        } catch (error) {
            res.status(error.status || 400).json({success:false,code:error.code || 'S03_IDENTITY_FAILED',error:error.message});
        }
    });

    async function requestBackend(req, backend, configId = 'default') {
        if (!req.s03) throw new AccessError('S03_AUTH_UNVERIFIED', 'Trusted user context required');
        if (backend === 'standard' || backend === 'vectra') return null;
        return await backendPool.get(req.s03,backend,configId);
    }


    // ========================================================================
    // BACKEND HANDLER - Routes requests to appropriate backend
    // ========================================================================

    /**
     * Ensures LanceDB is initialized before use
     * @param {object} directories - User directories containing vectors path
     */
    async function ensureLanceDBInitialized(req) {
        return await requestBackend(req, 'lancedb');
    }

    function getBackendHandler(backend, req, scopedBackend = null) {
        if (!req?.s03) throw new AccessError('S03_AUTH_UNVERIFIED', 'Trusted user context required');
        const lancedbBackend = scopedBackend;
        const qdrantBackend = scopedBackend;
        const milvusBackend = scopedBackend;
        switch (backend) {
            case 'vectra':
            case 'standard':
                return {
                    type: 'vectra',

                    list: async (collectionId, source, model, directories, options = {}) => {
                        const store = await getIndex(directories, collectionId, source, model);
                        const items = await store.listItems();

                        // Apply pagination
                        const offset = options.offset || 0;
                        const limit = options.limit || items.length;
                        const paginatedItems = items.slice(offset, offset + limit);

                        return {
                            items: paginatedItems.map(item => ({
                                hash: item.metadata.hash,
                                text: item.metadata.text,
                                index: item.metadata.index,
                                vector: options.includeVectors ? item.vector : undefined,
                                metadata: item.metadata
                            })),
                            total: items.length,
                            offset,
                            limit,
                            hasMore: offset + limit < items.length
                        };
                    },

                    get: async (collectionId, hash, source, model, directories) => {
                        const store = await getIndex(directories, collectionId, source, model);
                        const items = await store.listItems();
                        const item = items.find(i => i.metadata.hash == hash);
                        if (!item) return null;
                        return {
                            hash: item.metadata.hash,
                            text: item.metadata.text,
                            index: item.metadata.index,
                            vector: item.vector,
                            metadata: item.metadata
                        };
                    },

                    insert: async (collectionId, items, source, model, directories, req) => {
                        const store = await getIndex(directories, collectionId, source, model);

                        // Generate embeddings if not provided
                        let itemsWithVectors = [...items];
                        const itemsNeedingVectors = itemsWithVectors.filter(i => !i.vector);

                        if (itemsNeedingVectors.length > 0) {
                            const texts = itemsNeedingVectors.map(i => i.text);
                            const vectors = await getVectorsForSource(source, texts, model, directories, req);

                            let vIndex = 0;
                            itemsWithVectors = itemsWithVectors.map(item => {
                                if (!item.vector) {
                                    return { ...item, vector: vectors[vIndex++] };
                                }
                                return item;
                            });
                        }

                        await store.beginUpdate();
                        for (const item of itemsWithVectors) {
                            await store.upsertItem({
                                vector: item.vector,
                                metadata: {
                                    hash: item.hash,
                                    text: item.text,
                                    index: item.index,
                                    ...item.metadata
                                }
                            });
                        }
                        await store.endUpdate();
                    },

                    updateText: async (collectionId, hash, newText, source, model, directories, req) => {
                        const store = await getIndex(directories, collectionId, source, model);
                        const items = await store.listItems();
                        const item = items.find(i => i.metadata.hash == hash);
                        if (!item) throw new Error('Chunk not found');

                        // Generate new embedding for the new text
                        const newVector = await getEmbeddingForSource(source, newText, model, directories, req);
                        const newHash = getStringHash(newText);

                        // Delete old item
                        await store.deleteItem(item.id);

                        // Insert updated item
                        await store.beginUpdate();
                        await store.upsertItem({
                            vector: newVector,
                            metadata: {
                                ...item.metadata,
                                hash: newHash,
                                text: newText
                            }
                        });
                        await store.endUpdate();

                        return { oldHash: hash, newHash, text: newText };
                    },

                    updateMetadata: async (collectionId, hash, metadata, source, model, directories) => {
                        const store = await getIndex(directories, collectionId, source, model);
                        const items = await store.listItems();
                        const item = items.find(i => i.metadata.hash == hash);
                        if (!item) throw new Error('Chunk not found');

                        // Delete and re-insert with same vector but updated metadata
                        await store.deleteItem(item.id);

                        await store.beginUpdate();
                        await store.upsertItem({
                            vector: item.vector,
                            metadata: {
                                ...item.metadata,
                                ...metadata,
                                hash: item.metadata.hash, // Preserve hash
                                text: item.metadata.text   // Preserve text
                            }
                        });
                        await store.endUpdate();

                        return { hash, metadata };
                    },

                    delete: async (collectionId, hashes, source, model, directories) => {
                        const store = await getIndex(directories, collectionId, source, model);
                        const items = await store.listItems();

                        let deleted = 0;
                        for (const hash of hashes) {
                            const item = items.find(i => i.metadata.hash == hash);
                            if (item) {
                                await store.deleteItem(item.id);
                                deleted++;
                            }
                        }
                        return deleted;
                    },

                    query: async (collectionId, queryVector, topK, threshold, source, model, directories, options = {}) => {
                        const store = await getIndex(directories, collectionId, source, model);
                        const results = await store.queryItems(queryVector, topK);
                        return results
                            .filter(r => r.score >= threshold)
                            .map(r => ({
                                hash: r.item.metadata.hash,
                                score: r.score,
                                text: r.item.metadata.text,
                                vector: options.includeVectors ? r.item.vector : undefined,
                                metadata: r.item.metadata
                            }));
                    },

                    purge: async (collectionId, source, model, directories) => {
                        const store = await getIndex(directories, collectionId, source, model);
                        if (await store.isIndexCreated()) {
                            await store.deleteIndex();
                        }
                    },

                    stats: async (collectionId, source, model, directories) => {
                        const store = await getIndex(directories, collectionId, source, model);
                        const items = await store.listItems();

                        let totalCharacters = 0;
                        let totalTokens = 0;
                        const sources = {};
                        const messageHashes = new Set();
                        let embeddingDimensions = 0;

                        for (const item of items) {
                            const text = item.metadata.text || '';
                            totalCharacters += text.length;
                            totalTokens += Math.ceil(text.length / 4); // Rough estimate

                            const src = item.metadata.source || 'unknown';
                            sources[src] = (sources[src] || 0) + 1;

                            if (item.metadata.originalMessageHash) {
                                messageHashes.add(item.metadata.originalMessageHash);
                            }

                            if (item.vector && item.vector.length > 0) {
                                embeddingDimensions = item.vector.length;
                            }
                        }

                        // Get file size
                        const indexPath = model
                            ? path.join(directories.vectors, sanitize(source), sanitize(collectionId), sanitize(model), 'index.json')
                            : path.join(directories.vectors, sanitize(source), sanitize(collectionId), 'index.json');

                        let storageSize = 0;
                        try {
                            const stat = await fs.stat(indexPath);
                            storageSize = stat.size;
                        } catch (e) {
                            // File may not exist yet, which is fine
                            console.debug(`[${pluginName}] Could not stat index file (may not exist): ${indexPath}`);
                        }

                        return {
                            chunkCount: items.length,
                            totalCharacters,
                            totalTokens,
                            storageSize,
                            embeddingDimensions,
                            avgChunkSize: items.length > 0 ? Math.round(totalCharacters / items.length) : 0,
                            messageCount: messageHashes.size,
                            sources,
                            backend: 'vectra',
                            model: model || '(default)'
                        };
                    }
                };

            case 'lancedb':
                return {
                    type: 'lancedb',

                    list: async (collectionId, source, model, directories, options = {}) => {
                        const items = await lancedbBackend.listItems(collectionId, source, options);
                        // Return same format as Vectra handler for consistency
                        const offset = options.offset || 0;
                        const limit = options.limit || items.length;
                        const paginatedItems = items.slice(offset, offset + limit);
                        return {
                            items: paginatedItems,
                            total: items.length,
                            offset,
                            limit,
                            hasMore: offset + limit < items.length
                        };
                    },

                    get: async (collectionId, hash, source) => {
                        return await lancedbBackend.getItem(collectionId, hash, source);
                    },

                    insert: async (collectionId, items, source, model, directories, req) => {
                        // Generate embeddings if not provided
                        let itemsWithVectors = [...items];
                        const itemsNeedingVectors = itemsWithVectors.filter(i => !i.vector);

                        if (itemsNeedingVectors.length > 0) {
                            console.log(`[LanceDB] Generating embeddings for ${itemsNeedingVectors.length} items`);
                            const texts = itemsNeedingVectors.map(i => i.text);
                            const vectors = await getVectorsForSource(source, texts, model, directories, req);

                            let vIndex = 0;
                            itemsWithVectors = itemsWithVectors.map(item => {
                                if (!item.vector) {
                                    const vector = vectors[vIndex++];
                                    if (!vector || !Array.isArray(vector) || vector.length === 0) {
                                        console.error(`[LanceDB] Failed to generate valid vector for item hash=${item.hash}, source=${source}, model=${model}`);
                                        throw new Error(`Failed to generate embedding for item. Source: ${source}, Model: ${model}`);
                                    }
                                    return { ...item, vector };
                                }
                                return item;
                            });
                        }

                        await lancedbBackend.insertVectors(collectionId, itemsWithVectors, source);
                    },

                    updateText: async (collectionId, hash, newText, source, model, directories, req) => {
                        // Get new embedding
                        const newVector = await getEmbeddingForSource(source, newText, model, directories, req);
                        const newHash = getStringHash(newText);
                        await lancedbBackend.updateItem(collectionId, hash, { text: newText, hash: newHash, vector: newVector }, source);
                        return { oldHash: hash, newHash, text: newText };
                    },

                    updateMetadata: async (collectionId, hash, metadata, source) => {
                        await lancedbBackend.updateItemMetadata(collectionId, hash, metadata, source);
                        return { hash, metadata };
                    },

                    delete: async (collectionId, hashes, source) => {
                        await lancedbBackend.deleteVectors(collectionId, hashes, source);
                        return hashes.length;
                    },

                    query: async (collectionId, queryVector, topK, threshold, source, model, directories, options = {}) => {
                        const results = await lancedbBackend.queryVectors(collectionId, queryVector, topK, threshold, source);
                        return results;
                    },

                    purge: async (collectionId, source) => {
                        await lancedbBackend.purgeCollection(collectionId, source);
                    },

                    stats: async (collectionId, source) => {
                        return await lancedbBackend.getCollectionStats(collectionId, source);
                    }
                };

            case 'qdrant':
                return {
                    type: 'qdrant',

                    list: async (collectionId, source, model, directories, options = {}) => {
                        const items = await qdrantBackend.listItems(collectionId, options.filters || {}, options);
                        // Return same format as Vectra handler for consistency
                        const offset = options.offset || 0;
                        const limit = options.limit || items.length;
                        const paginatedItems = items.slice(offset, offset + limit);
                        return {
                            items: paginatedItems,
                            total: items.length,
                            offset,
                            limit,
                            hasMore: offset + limit < items.length
                        };
                    },

                    get: async (collectionId, hash, source, model, directories, filters = {}) => {
                        return await qdrantBackend.getItem(collectionId, hash, filters);
                    },

                    insert: async (collectionId, items, source, model, directories, req, filters = {}) => {
                        // Generate embeddings if not provided
                        let itemsWithVectors = [...items];
                        const itemsNeedingVectors = itemsWithVectors.filter(i => !i.vector);

                        if (itemsNeedingVectors.length > 0) {
                            console.log(`[Qdrant] Generating embeddings for ${itemsNeedingVectors.length} items`);
                            const texts = itemsNeedingVectors.map(i => i.text);
                            const vectors = await getVectorsForSource(source, texts, model, directories, req);

                            let vIndex = 0;
                            itemsWithVectors = itemsWithVectors.map(item => {
                                if (!item.vector) {
                                    const vector = vectors[vIndex++];
                                    if (!vector || !Array.isArray(vector) || vector.length === 0) {
                                        console.error(`[Qdrant] Failed to generate valid vector for item hash=${item.hash}, source=${source}, model=${model}`);
                                        throw new Error(`Failed to generate embedding for item. Source: ${source}, Model: ${model}`);
                                    }
                                    return { ...item, vector };
                                }
                                return item;
                            });
                        }

                        // Pass source and model for embedding tracking
                        await qdrantBackend.insertVectors(collectionId, itemsWithVectors, {
                            ...filters,
                            embeddingSource: source,
                            embeddingModel: model,
                        });
                    },

                    updateText: async (collectionId, hash, newText, source, model, directories, req, filters = {}) => {
                        const newVector = await getEmbeddingForSource(source, newText, model, directories, req);
                        const newHash = getStringHash(newText);
                        await qdrantBackend.updateItem(collectionId, hash, { text: newText, hash: newHash, vector: newVector }, filters);
                        return { oldHash: hash, newHash, text: newText };
                    },

                    updateMetadata: async (collectionId, hash, metadata, source, model, directories, filters = {}) => {
                        await qdrantBackend.updateItemMetadata(collectionId, hash, metadata, filters);
                        return { hash, metadata };
                    },

                    delete: async (collectionId, hashes, source, model, directories, filters = {}) => {
                        await qdrantBackend.deleteVectors(collectionId, hashes);
                        return hashes.length;
                    },

                    query: async (collectionId, queryVector, topK, threshold, source, model, directories, options = {}) => {
                        const results = await qdrantBackend.queryVectors(collectionId, queryVector, topK, threshold, options.filters || {});
                        return results;
                    },

                    purge: async (collectionId, source, model, directories, filters = {}) => {
                        throw new Error('S01: Qdrant purge is disabled pending server-authorized scoping');
                    },

                    stats: async (collectionId, source, model, directories, filters = {}) => {
                        return await qdrantBackend.getCollectionStats(collectionId, filters);
                    }
                };

            case 'milvus':
                return {
                    type: 'milvus',

                    list: async (collectionId, source, model, directories, options = {}) => {
                        const items = await milvusBackend.listItems(collectionId, options.filters || {}, options);
                        const offset = options.offset || 0;
                        const limit = options.limit || items.length;
                        return {
                            items: items,
                            total: items.length,
                            offset,
                            limit,
                            hasMore: items.length >= limit
                        };
                    },

                    get: async (collectionId, hash, source, model, directories, filters = {}) => {
                        return await milvusBackend.getItem(collectionId, hash, filters);
                    },

                    insert: async (collectionId, items, source, model, directories, req, filters = {}) => {
                        // Generate embeddings if not provided
                        let itemsWithVectors = [...items];
                        const itemsNeedingVectors = itemsWithVectors.filter(i => !i.vector);

                        if (itemsNeedingVectors.length > 0) {
                            console.log(`[Milvus] Generating embeddings for ${itemsNeedingVectors.length} items`);
                            const texts = itemsNeedingVectors.map(i => i.text);
                            const vectors = await getVectorsForSource(source, texts, model, directories, req);

                            let vIndex = 0;
                            itemsWithVectors = itemsWithVectors.map(item => {
                                if (!item.vector) {
                                    return { ...item, vector: vectors[vIndex++] };
                                }
                                return item;
                            });
                        }

                        await milvusBackend.insertVectors(collectionId, itemsWithVectors, {
                            ...filters,
                            embeddingSource: source,
                            embeddingModel: model,
                        });
                    },

                    updateText: async (collectionId, hash, newText, source, model, directories, req, filters = {}) => {
                        const newVector = await getEmbeddingForSource(source, newText, model, directories, req);
                        const newHash = getStringHash(newText);
                        await milvusBackend.updateItem(collectionId, hash, { text: newText, hash: newHash, vector: newVector }, filters);
                        return { oldHash: hash, newHash, text: newText };
                    },

                    updateMetadata: async (collectionId, hash, metadata, source, model, directories, filters = {}) => {
                        await milvusBackend.updateItem(collectionId, hash, metadata, filters);
                        return { hash, metadata };
                    },

                    delete: async (collectionId, hashes, source, model, directories, filters = {}) => {
                        await milvusBackend.deleteVectors(collectionId, hashes);
                        return hashes.length;
                    },

                    query: async (collectionId, queryVector, topK, threshold, source, model, directories, options = {}) => {
                        const results = await milvusBackend.queryCollection(collectionId, queryVector, topK, options.filters || {});
                        return results.filter(r => r.score >= threshold);
                    },

                    purge: async (collectionId, source, model, directories, filters = {}) => {
                        await milvusBackend.purgeCollection(collectionId, filters);
                    },

                    stats: async (collectionId, source, model, directories, filters = {}) => {
                        return await milvusBackend.getCollectionStats(collectionId, filters);
                    }
                };

            default:
                throw new Error(`Unknown backend: ${backend}`);
        }
    }

    // ========================================================================
    // UTILITY ENDPOINTS
    // ========================================================================

    /**
     * GET /api/plugins/similharity/health
     * Overall plugin health check
     */
    router.get('/health', (req, res) => {
        res.json({
            status: 'ok',
            plugin: pluginName,
            version: pluginVersion,
            backends: ['vectra', 'lancedb', 'qdrant', 'milvus'],
            checkpoint: 'S10',
            contractVersion: s10Build.contractVersion,
            sourceFingerprint: s10Build.fingerprint,
            buildVerification: s10Build.verification,
            deployedSourceAttested: false,
            legacyMutations: 'BLOCKED',
            clientBackendCredentials: 'DENIED',
            sharedLegacyReads: 'BLOCKED_UNVERIFIABLE',
            authenticatedContext: 'REQUIRED_FOR_NON_HEALTH',
            productionCertified: false
        });
    });

    /**
     * POST /api/plugins/similharity/open-folder
     * Opens collection folder in file explorer
     */
    router.post('/open-folder', (req, res) => res.status(409).json({success:false,
        code:'S03_SENSITIVE_ROUTE_BLOCKED', error:'Legacy shell-based folder launching is disabled.'}));

    /**
     * GET /api/plugins/similharity/collections
     * Lists ALL collections across ALL backends
     */
    router.get('/collections', async (req, res) => {
        try {
            const vectorsPath = req.user.directories.vectors;
            const allCollections = await scanAllSourcesForCollections(vectorsPath, req.s03, backendPool);

            res.json({
                success: true,
                count: allCollections.length,
                collections: allCollections
            });
        } catch (error) {
            console.error(`[${pluginName}] collections error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * GET /api/plugins/similharity/sources
     * Lists available embedding sources
     */
    router.get('/sources', async (req, res) => {
        try {
            const vectorsPath = req.user.directories.vectors;
            const entries = await fs.readdir(vectorsPath, { withFileTypes: true });
            const sources = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);

            res.json({ success: true, sources });
        } catch (error) {
            console.error(`[${pluginName}] sources error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * POST /api/plugins/similharity/get-embedding
     * Get embedding for single text
     */
    router.post('/get-embedding', async (req, res) => {
        try {
            const { text, source, model = '' } = req.body;

            if (!text || !source) {
                return res.status(400).json({ error: 'text and source are required' });
            }

            const embedding = await getEmbeddingForSource(source, text, model, req.user.directories, req);
            validateS05Vector(embedding, embedding?.length);
            res.json({ success: true, embedding });

        } catch (error) {
            console.error(`[${pluginName}] get-embedding error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * POST /api/plugins/similharity/batch-embeddings
     * Get embeddings for multiple texts
     */
    router.post('/batch-embeddings', async (req, res) => {
        try {
            const { texts, source, model = '' } = req.body;

            if (!texts || !Array.isArray(texts) || !source) {
                return res.status(400).json({ error: 'texts array and source are required' });
            }

            const embeddings = await getVectorsForSource(source, texts, model, req.user.directories, req);
            if (!Array.isArray(embeddings) || embeddings.length !== texts.length ||
                !embeddings.every(v => Array.isArray(v) && v.length === embeddings[0]?.length)) {
                throw new Error('S05_BATCH_EMBEDDING_INVALID');
            }
            for (const vector of embeddings) validateS05Vector(vector, embeddings[0].length);
            res.json({ success: true, embeddings });

        } catch (error) {
            console.error(`[${pluginName}] batch-embeddings error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    // ========================================================================
    // BACKEND MANAGEMENT ENDPOINTS
    // ========================================================================

    /**
     * GET /api/plugins/similharity/backend/health/:backend
     * Health check for specific backend
     */
    router.get('/backend/health/:backend', async (req, res) => {
        const backend = req.params.backend;
        try {
            if (!['vectra','standard','lancedb','qdrant','milvus'].includes(backend)) {
                return res.status(400).json({success:false,code:'S03_BACKEND_UNKNOWN'});
            }
            const configId = validateClientConfig(req.query ?? {});
            const instance = await requestBackend(req,backend,configId);
            const healthy = instance ? (backend === 'lancedb'
                ? !!instance.basePath : await instance.healthCheck()) : true;
            res.json({backend,healthy,configuration: configId === 'local' ? 'local-loopback' : 'server-only',userIsolated:true,
                productionCertified:false});
        } catch (error) {
            res.status(error.status||503).json({backend,healthy:false,code:error.code||'S03_BACKEND_UNAVAILABLE',
                error:'Backend is not available for the selected server configuration.'});
        }
    });

    /**
     * POST /api/plugins/similharity/backend/init/:backend
     * Initialize specific backend
     */
    router.post('/backend/init/:backend', async (req, res) => {
        const backend = req.params.backend;
        try {
            const configId = validateClientConfig(req.body ?? {});
            const instance = await requestBackend(req,backend,configId);
            if (backend !== 'standard' && backend !== 'vectra' && !instance) {
                throw new AccessError('S03_BACKEND_UNKNOWN','Unknown backend',400);
            }
            res.json({success:true,backend,configuration:configId === 'local' ? 'local-loopback' : 'server-only',initialized:true,
                mutationsEnabled:false});
        } catch (error) {
            res.status(error.status||503).json({success:false,code:error.code||'S03_BACKEND_UNAVAILABLE',
                error:'Backend initialization rejected or unavailable.'});
        }
    });

    /**
     * POST /api/plugins/similharity/chunks/list
     * List all chunks in a collection with pagination
     * Body: { backend, collectionId, source?, model?, offset?, limit?, includeVectors?, filters? }
     */
    router.post('/chunks/list', async (req, res) => {
        try {
            const {
                backend = 'vectra',
                collectionId,
                source = 'transformers',
                model = '',
                offset = 0,
                limit = 100,
                includeVectors = false,
                filters = {}
            } = req.body;

            if (!collectionId) {
                return res.status(400).json({ error: 'collectionId is required' });
            }

            // Auto-init LanceDB if needed
            if (backend === 'lancedb') {
                await ensureLanceDBInitialized(req);
            }

            const scopedBackend = await requestBackend(req, backend);
            const handler = getBackendHandler(backend, req, scopedBackend);
            const result = await handler.list(collectionId, source, model, req.user.directories, {
                offset,
                limit,
                includeVectors,
                filters
            });

            res.json({
                success: true,
                backend: handler.type,
                collectionId,
                ...result
            });

        } catch (error) {
            console.error(`[${pluginName}] chunks/list error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * GET /api/plugins/similharity/chunks/:hash
     * Get single chunk by hash
     * Query: backend, collectionId, source?, model?
     */
    router.get('/chunks/:hash', async (req, res) => {
        try {
            const { hash } = req.params;
            const { backend = 'vectra', collectionId, source = 'transformers', model = '' } = req.query;
            // Parse filters from query string (JSON encoded)
            let filters = {};
            if (req.query.filters) {
                try {
                    filters = JSON.parse(req.query.filters);
                } catch (e) {
                    console.warn(`[${pluginName}] Invalid filters JSON:`, req.query.filters);
                }
            }

            if (!collectionId) {
                return res.status(400).json({ error: 'collectionId is required' });
            }

            if (backend === 'lancedb') {
                await ensureLanceDBInitialized(req);
            }

            const scopedBackend = await requestBackend(req, backend);
            const handler = getBackendHandler(backend, req, scopedBackend);
            const chunk = await handler.get(collectionId, hash, source, model, req.user.directories, filters);

            if (!chunk) {
                return res.status(404).json({ error: 'Chunk not found' });
            }

            res.json({ success: true, chunk });

        } catch (error) {
            console.error(`[${pluginName}] chunks/:hash error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * S01: intentionally refused by the early s01MutationGuard middleware.
     * POST /api/plugins/similharity/chunks/insert
     * Insert new chunks
     * Body: { backend, collectionId, items: [{hash, text, index, metadata?, vector?}], source?, model? }
     */
    router.post('/chunks/insert', (req, res) => {
        // Defense in depth if the upstream S01 middleware is modified.
        return res.status(409).json({
            success: false,
            code: 'S01_MUTATION_BLOCKED',
            error: 'Legacy mutation disabled until scoped, verified S02-S04 contract is available.',
            retryable: false,
            checkpoint: 'S01'
        });
    });

    /**
     * PATCH /api/plugins/similharity/chunks/:hash/text
     * Update chunk text (triggers re-embedding)
     * Body: { backend, collectionId, text, source?, model? }
     */
    router.patch('/chunks/:hash/text', (req, res) => {
        // Defense in depth if the upstream S01 middleware is modified.
        return res.status(409).json({
            success: false,
            code: 'S01_MUTATION_BLOCKED',
            error: 'Legacy mutation disabled until scoped, verified S02-S04 contract is available.',
            retryable: false,
            checkpoint: 'S01'
        });
    });

    /**
     * PATCH /api/plugins/similharity/chunks/:hash/metadata
     * Update chunk metadata (no re-embedding)
     * Body: { backend, collectionId, metadata, source?, model? }
     */
    router.patch('/chunks/:hash/metadata', (req, res) => {
        // Defense in depth if the upstream S01 middleware is modified.
        return res.status(409).json({
            success: false,
            code: 'S01_MUTATION_BLOCKED',
            error: 'Legacy mutation disabled until scoped, verified S02-S04 contract is available.',
            retryable: false,
            checkpoint: 'S01'
        });
    });

    /**
     * POST /api/plugins/similharity/chunks/delete
     * Delete chunks by hash
     * Body: { backend, collectionId, hashes, source?, model? }
     */
    router.post('/chunks/delete', (req, res) => {
        // Defense in depth if the upstream S01 middleware is modified.
        return res.status(409).json({
            success: false,
            code: 'S01_MUTATION_BLOCKED',
            error: 'Legacy mutation disabled until scoped, verified S02-S04 contract is available.',
            retryable: false,
            checkpoint: 'S01'
        });
    });

    /**
     * POST /api/plugins/similharity/chunks/query
     * Query chunks by semantic similarity
     * Body: { backend, collectionId, queryVector OR searchText, topK?, threshold?, source?, model?, includeVectors? }
     */
    router.post('/chunks/query', async (req, res) => {
        try {
            const {
                backend = 'vectra',
                collectionId,
                queryVector,
                searchText,
                topK = 10,
                threshold = 0.0,
                source = 'transformers',
                model = '',
                includeVectors = false,
                filters = {}
            } = req.body;

            if (!collectionId) {
                return res.status(400).json({ error: 'collectionId is required' });
            }
            if (!queryVector && !searchText) {
                return res.status(400).json({ error: 'queryVector or searchText is required' });
            }

            if (backend === 'lancedb') {
                await ensureLanceDBInitialized(req);
            }

            // Get query vector if not provided
            let vector = queryVector;
            if (!vector && searchText) {
                vector = await getEmbeddingForSource(source, searchText, model, req.user.directories, req);
            }

            // S05 rejects malformed/oversized search vectors before dispatch.
            validateS05Vector(vector, vector?.length);
            if (!Number.isSafeInteger(topK) || topK < 1 || topK > 100 ||
                typeof threshold !== 'number' || !Number.isFinite(threshold)) {
                return res.status(400).json({success:false,code:'S05_QUERY_LIMIT_INVALID'});
            }
            const scopedBackend = await requestBackend(req, backend);
            const handler = getBackendHandler(backend, req, scopedBackend);
            const results = await handler.query(collectionId, vector, topK, threshold, source, model, req.user.directories, {
                includeVectors,
                filters
            });

            res.json({
                success: true,
                backend: handler.type,
                collectionId,
                count: results.length,
                results
            });

        } catch (error) {
            console.error(`[${pluginName}] chunks/query error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * POST /api/plugins/similharity/chunks/hybrid-query
     * Hybrid search combining vector similarity and keyword matching
     * Body: { backend, collectionId, searchText OR queryVector, keywords?, topK?, options?, filters?, source?, model? }
     */
    router.post('/chunks/hybrid-query', async (req, res) => {
        try {
            const {
                backend = 'qdrant',
                collectionId,
                queryVector,
                searchText,
                keywords,
                topK = 10,
                options = {},
                filters = {},
                source = 'transformers',
                model = '',
                hybridOptions = {}
            } = req.body;

            if (!collectionId) {
                return res.status(400).json({ error: 'collectionId is required' });
            }
            if (!queryVector && !searchText) {
                return res.status(400).json({ error: 'queryVector or searchText is required' });
            }

            // Only Qdrant, Milvus support native hybrid query
            if (backend !== 'qdrant' && backend !== 'milvus') {
                return res.status(400).json({ error: `Backend ${backend} does not support native hybrid query` });
            }

            // Generate embedding if searchText provided
            let vector = queryVector;
            if (!vector && searchText) {
                vector = await getEmbeddingForSource(source, searchText, model, req.user.directories, req);
            }

            // Extract keywords if not provided
            let extractedKeywords = keywords;
            if (!extractedKeywords && searchText) {
                // Simple keyword extraction: split by spaces, remove short words
                extractedKeywords = searchText
                    .toLowerCase()
                    .split(/\s+/)
                    .filter(word => word.length > 2)
                    .slice(0, 10); // Limit to 10 keywords
            }

            // Merge hybridOptions with options
            const mergedOptions = {
                ...hybridOptions,
                ...options
            };

            if (backend === 'qdrant') {
                const qdrantBackend = await requestBackend(req,'qdrant');
                const results = await qdrantBackend.hybridQuery(
                    collectionId,
                    vector,
                    extractedKeywords || [],
                    topK,
                    mergedOptions,
                    filters
                );

                res.json({
                    success: true,
                    backend: 'qdrant',
                    collectionId,
                    count: results.length,
                    results: results.map(r => ({
                        hash: r.hash,
                        text: r.text,
                        score: r.score,
                        metadata: r.metadata,
                        vectorScore: r.debug?.vectorScore,
                        textScore: r.debug?.keywordScore,
                        debug: r.debug
                    }))
                });
            } else if (backend === 'milvus') {
                // Milvus hybrid query implementation (if available)
                const milvusBackend = await requestBackend(req,'milvus');
                const results = await milvusBackend.hybridQuery(
                    collectionId,
                    vector,
                    extractedKeywords || [],
                    topK,
                    mergedOptions,
                    filters
                );

                res.json({
                    success: true,
                    backend: 'milvus',
                    collectionId,
                    count: results.length,
                    results: results.map(r => ({
                        hash: r.hash,
                        text: r.text,
                        score: r.score,
                        metadata: r.metadata,
                        vectorScore: r.debug?.vectorScore,
                        textScore: r.debug?.keywordScore,
                        debug: r.debug
                    }))
                });
            }

        } catch (error) {
            console.error(`[${pluginName}] chunks/hybrid-query error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * POST /api/plugins/similharity/chunks/purge
     * Purge all chunks in a collection
     * Body: { backend, collectionId, source?, model? }
     */
    router.post('/chunks/purge', (req, res) => {
        // Defense in depth if the upstream S01 middleware is modified.
        return res.status(409).json({
            success: false,
            code: 'S01_MUTATION_BLOCKED',
            error: 'Legacy mutation disabled until scoped, verified S02-S04 contract is available.',
            retryable: false,
            checkpoint: 'S01'
        });
    });

    /**
     * S01: intentionally refused by the early s01MutationGuard middleware.
     * POST /api/plugins/similharity/purge-all
     * Deletes the entire vectors folder
     */
    router.post('/purge-all', (req, res) => {
        // Defense in depth if the upstream S01 middleware is modified.
        return res.status(409).json({
            success: false,
            code: 'S01_MUTATION_BLOCKED',
            error: 'Legacy mutation disabled until scoped, verified S02-S04 contract is available.',
            retryable: false,
            checkpoint: 'S01'
        });
    });

    /**
     * POST /api/plugins/similharity/rerank
     * Rerank documents using BananaBread's reranking endpoint
     * Body: { apiUrl, query, documents, top_k? }
     */
    router.post('/rerank', (req, res) => res.status(409).json({success:false,
        code:'S03_SENSITIVE_ROUTE_BLOCKED', error:'Legacy caller-supplied rerank endpoint is disabled.'}));

    /**
     * POST /api/plugins/similharity/chunks/stats
     * Get collection statistics
     * Body: { backend, collectionId, source?, model? }
     */
    router.post('/chunks/stats', async (req, res) => {
        try {
            const {
                backend = 'vectra',
                collectionId,
                source = 'transformers',
                model = '',
                filters = {}
            } = req.body;

            if (!collectionId) {
                return res.status(400).json({ error: 'collectionId is required' });
            }

            if (backend === 'lancedb') {
                await ensureLanceDBInitialized(req);
            }

            const scopedBackend = await requestBackend(req, backend);
            const handler = getBackendHandler(backend, req, scopedBackend);
            const stats = await handler.stats(collectionId, source, model, req.user.directories, filters);

            res.json({
                success: true,
                backend: handler.type,
                collectionId,
                stats
            });

        } catch (error) {
            console.error(`[${pluginName}] chunks/stats error:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    console.log(`[${pluginName}] Plugin initialized successfully`);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get vectra index for a collection
 */
async function getIndex(directories, collectionId, source, model) {
    exposedSafeSource(source);
    safeLegacyPhysicalName('vectra', collectionId);
    if (model && (typeof model !== 'string' || sanitize(model) !== model)) {
        throw new AccessError('S03_INVALID_MODEL_PATH', 'Unverified model path must not alias an existing index', 409);
    }
    const pathToFile = model
        ? path.join(directories.vectors, sanitize(source), sanitize(collectionId), sanitize(model))
        : path.join(directories.vectors, sanitize(source), sanitize(collectionId));

    const store = new vectra.LocalIndex(pathToFile);

    if (!await store.isIndexCreated()) {
        throw new AccessError('S03_INDEX_NOT_FOUND', 'Index does not exist; read must not create it', 404);
    }

    return store;
}

/**
 * Get embedding for text from specified source
 */
async function getEmbeddingForSource(source, text, model, directories, req) {
    switch (source) {
        case 'transformers': {
            const { getTransformersVector } = await import('../../src/vectors/embedding.js');
            return await getTransformersVector(text);
        }
        case 'openai':
        case 'togetherai':
        case 'mistral':
        case 'electronhub':
        case 'openrouter': {
            const { getOpenAIVector } = await import('../../src/vectors/openai-vectors.js');
            // ElectronHub requires a model name, provide default if empty
            const effectiveModel = (source === 'electronhub' && !model) ? 'text-embedding-ada-002' : model;
            return await getOpenAIVector(text, source, directories, effectiveModel);
        }
        case 'koboldcpp': {
            return await _getKoboldCppEmbedding(text, model, req);
        }
        case 'nomicai': {
            const { getNomicAIVector } = await import('../../src/vectors/nomicai-vectors.js');
            return await getNomicAIVector(text, source, directories);
        }
        case 'cohere': {
            const { getCohereVector } = await import('../../src/vectors/cohere-vectors.js');
            return await getCohereVector(text, true, directories, model);
        }
        case 'ollama': {
            const { getOllamaVector } = await import('../../src/vectors/ollama-vectors.js');
            const apiUrl = req.body?.apiUrl || 'http://localhost:11434';
            const keep = req.body?.keep || false;
            return await getOllamaVector(text, apiUrl, model, keep, directories);
        }
        case 'llamacpp': {
            const { getLlamaCppVector } = await import('../../src/vectors/llamacpp-vectors.js');
            const apiUrl = req.body?.apiUrl || 'http://localhost:8080';
            return await getLlamaCppVector(text, apiUrl, directories);
        }
        case 'bananabread': {
            // BananaBread llama.cpp-compatible endpoint (no model param needed - uses server config)
            let apiUrl = req.body.apiUrl || 'http://localhost:8008';
            let apiKey = req.body.apiKey || '';

            // Validate URL before attempting to use it
            if (!apiUrl || typeof apiUrl !== 'string' || apiUrl.trim() === '') {
                throw new Error('BananaBread: apiUrl is missing or invalid. Configure the embedding URL in VectHare settings.');
            }
            apiUrl = apiUrl.trim();

            let url;
            try {
                url = new URL(apiUrl);
                url.pathname = '/embedding';
            } catch (e) {
                throw new Error(`BananaBread: Invalid URL format "${apiUrl}" - ${e.message}`);
            }

            const headers = { 'Content-Type': 'application/json' };
            if (apiKey) {
                headers['Authorization'] = `Bearer ${apiKey}`;
            }

            const response = await fetch(url.toString(), {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ content: text }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`BananaBread: ${response.statusText} ${errorText}`);
            }

            const data = await response.json();
            if (!Array.isArray(data?.embedding)) {
                throw new Error('BananaBread: Invalid response format');
            }
            return data.embedding;
        }
        case 'vllm': {
            const { getVllmVector } = await import('../../src/vectors/vllm-vectors.js');
            const apiUrl = req.body?.apiUrl || 'http://localhost:8000';
            return await getVllmVector(text, apiUrl, model, directories);
        }
        case 'palm':
        case 'vertexai': {
            const googleVectors = await import('../../src/vectors/google-vectors.js');
            if (source === 'palm') {
                return await googleVectors.getMakerSuiteVector(text, model, req);
            } else {
                return await googleVectors.getVertexVector(text, model, req);
            }
        }
        case 'extras': {
            const { getExtrasVector } = await import('../../src/vectors/extras-vectors.js');
            const extrasUrl = req.body?.extrasUrl || 'http://localhost:5100';
            const extrasKey = req.body?.extrasKey || '';
            return await getExtrasVector(text, extrasUrl, extrasKey);
        }
        default:
            throw new Error(`Unknown vector source: ${source}`);
    }
}

/**
 * Simple string hash function
 */
function getStringHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash);
}

/**
 * Scan all sources for collections
 */
async function scanAllSourcesForCollections(vectorsPath, userContext, backendPool) {
    const allCollections = [];

    try {
        // Scan vectra indexes
        const vectraIndexes = await findAllIndexes(vectorsPath);

        const vectraCollectionMap = new Map();
        for (const index of vectraIndexes) {
            const key = `${index.source}:${index.collectionId}`;

            if (!vectraCollectionMap.has(key)) {
                vectraCollectionMap.set(key, {
                    id: index.collectionId,
                    source: index.source,
                    backend: 'vectra',
                    indexes: [],
                    totalChunks: 0
                });
            }

            const chunkCount = await getChunkCountFromIndex(index.indexPath);
            vectraCollectionMap.get(key).indexes.push({
                modelPath: index.modelPath,
                chunkCount: chunkCount
            });
            vectraCollectionMap.get(key).totalChunks += chunkCount;
        }

        for (const [key, collection] of vectraCollectionMap) {
            if (!collection.id) continue;

            const primaryIndex = collection.indexes.reduce((best, curr) =>
                curr.chunkCount > best.chunkCount ? curr : best
            , collection.indexes[0]);

            const models = collection.indexes.map(idx => ({
                name: idx.modelPath || '(default)',
                path: idx.modelPath,
                chunkCount: idx.chunkCount
            }));

            allCollections.push({
                id: collection.id,
                source: collection.source,
                backend: 'vectra',
                chunkCount: collection.totalChunks,
                modelCount: collection.indexes.length,
                model: primaryIndex?.modelPath || '',
                models: models
            });
        }

        // Scan LanceDB
        const lancedbPath = path.join(vectorsPath, 'lancedb');
        try {
            await fs.access(lancedbPath);
            const lancedbBackend = await backendPool.get(userContext, 'lancedb');

            const sourceDirs = await fs.readdir(lancedbPath, { withFileTypes: true });
            const sources = sourceDirs.filter(d => d.isDirectory() && !d.name.endsWith('.lance')).map(d => d.name);

            for (const source of sources) {
                try {
                    const db = await lancedbBackend.getDatabase(source);
                    const tableNames = await db.tableNames();

                    for (const tableName of tableNames) {
                        if (!tableName) continue;
                        try {
                            const table = await db.openTable(tableName);
                            const count = await table.countRows();

                            allCollections.push({
                                id: tableName,
                                source: source,
                                backend: 'lancedb',
                                chunkCount: count,
                                modelCount: 1
                            });
                        } catch (e) {
                            console.warn(`[${pluginName}] LanceDB: Failed to open table '${tableName}' in source '${source}':`, e.message);
                        }
                    }
                } catch (e) {
                    console.warn(`[${pluginName}] LanceDB: Failed to scan source '${source}':`, e.message);
                }
            }
        } catch (e) {
            // LanceDB folder doesn't exist - this is normal if LanceDB hasn't been used
            console.debug(`[${pluginName}] LanceDB folder not found or not accessible:`, e.message);
        }

        // S03: no cross-tenant remote collection enumeration. Remote inventory
        // requires S05 verified server-owned collection mapping and pagination.

    } catch (error) {
        console.error(`[${pluginName}] Error scanning collections:`, error);
    }

    return allCollections;
}

/**
 * Find all vectra index.json files
 */
async function findAllIndexes(dir, relativePath = '') {
    const results = [];

    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const newRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;

            if (entry.isDirectory()) {
                const subResults = await findAllIndexes(fullPath, newRelativePath);
                results.push(...subResults);
            } else if (entry.name === 'index.json') {
                const pathParts = newRelativePath.split(path.sep);
                if (pathParts.length >= 3) {
                    results.push({
                        indexPath: fullPath,
                        collectionId: pathParts[1],
                        source: pathParts[0],
                        modelPath: pathParts.slice(2, -1).join(path.sep),
                        relativePath: newRelativePath
                    });
                }
            }
        }
    } catch (e) {
        // Directory may not exist or not be readable - log at debug level since this is recursive
        if (relativePath === '') {
            console.warn(`[${pluginName}] Vectra: Failed to scan vectors directory:`, e.message);
        }
    }

    return results;
}

/**
 * Get chunk count from vectra index
 */
async function getChunkCountFromIndex(indexPath) {
    try {
        const modelDir = path.dirname(indexPath);
        const store = new vectra.LocalIndex(modelDir);

        if (!await store.isIndexCreated()) {
            return 0;
        }

        const items = await store.listItems();
        return items.length;
    } catch (e) {
        console.warn(`[${pluginName}] Vectra: Failed to get chunk count from ${indexPath}:`, e.message);
        return 0;
    }
}

export async function exit() {
    console.log(`[${pluginName}] Plugin shutting down...`);
}

export const info = {
    id: pluginName,
    name: 'Similharity',
    description: 'Unified vector database backend for VectHare - supports Vectra, LanceDB, and Qdrant',
    version: pluginVersion
};
