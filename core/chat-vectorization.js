import { claimQdrantIdentity } from './physical-identity.js';
/**
 * ============================================================================
 * VECTHARE CHAT VECTORIZATION
 * ============================================================================
 * Core logic for vectorizing chat messages and retrieving relevant context
 *
 * @author Coneja Chibi
 * @version 2.2.0-alpha
 * ============================================================================
 */

import { getCurrentChatId, is_send_press, setExtensionPrompt, substituteParams, chat_metadata, extension_prompts } from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';
import { getStringHash as calculateHash, waitUntilCondition, onlyUnique } from '../../../../utils.js';
import { isUnitStrategy, chunkText } from './chunking.js';
import { groupConversationTurns, normalizeTurnOrder } from './conversation-turns.js';
import { applyAndVerifyProfile, settingsForSavedCollection, saveChatChunkManifest, saveCollectionProfile, patchChatChunkManifest, getChatChunkManifest } from './vectorization-profile.js';
import { prepareEmbeddingItems } from './embedding-overflow.js';
import { bindChatCollection } from './collection-ownership.js';
import { extractChatKeywords, extractBM25Keywords } from './keyword-boost.js';
import { cleanText } from './text-cleaning.js';
import { assignOccurrenceIds } from './chunk-identity.js';
import {
    getSavedHashes,
    insertVectorItems,
    queryCollection,
    queryActiveCollections,
    deleteVectorItems,
    purgeVectorIndex,
} from './core-vector-api.js';
import { isBackendAvailable, getBackend } from '../backends/backend-manager.js';
import { applyDecayToResults, applySceneAwareDecay, applyNostalgiaToResults } from './temporal-decay.js';
import { isChunkDisabledByScene } from './scenes.js';
import { registerCollection, getCollectionRegistry } from './collection-loader.js';
import { getChatBinding, resolveChatWriteTarget } from './collection-ownership.js';
import {
    isCollectionEnabled,
    filterActiveCollections,
    getChatCollectionPolicy,
    applyChatCollectionPolicy,
    getCollectionDecaySettings,
    hasCustomDecaySettings,
} from './collection-metadata.js';
import { progressTracker } from '../ui/progress-tracker.js';
import {startActivity, updateActivity, finishActivity} from '../ui/activity-status.js';
import {acquireSharedOperation, finishSharedOperation, SharedOperationStoppedError} from '../ui/shared-operations.js';
import { inspectCollectionChunks, chunkMatchesExpected } from './chunk-integrity.js';
import { beginSyncCheckpoint, updateSyncCheckpoint, acknowledgeSyncChunk, finalizeSyncCheckpoint } from './sync-checkpoints.js';
import { createOperationControl, detachOperationControl, hasActiveVectorWrite, OperationStoppedError } from '../ui/operation-controls.js';
import { buildSearchContext, filterChunksByConditions, processChunkLinks } from './conditional-activation.js';
import { getChunkMetadata, getCollectionMeta, setCollectionMeta } from './collection-metadata.js';
import { processChunkGroups, mergeVirtualLinks } from './chunk-groups.js';
import { createDebugData, setLastSearchDebug, addTrace, recordChunkFate } from '../ui/search-debug.js';
import { getSemanticWorldInfoEntries } from './world-info-integration.js';
import { chooseMemoryInjections, countConservativeGenerationTokens } from './injection-budget.js';
import { Queue, LRUCache } from '../utils/data-structures.js';
import { getRequestHeaders } from '../../../../../script.js';
import { EXTENSION_PROMPT_TAG, HASH_CACHE_SIZE } from './constants.js';
import { rankEligibleChunks, isChatChunkInRecentContext, nextCandidateLimit, getCandidateBudget, loadCachedCandidatePage } from './retrieval-policy.js';
// Import from collection-ids.js - single source of truth for collection ID operations
import {
    getChatUUID,
    buildChatCollectionId,
    buildLegacyChatCollectionId,
    getAllChatCollectionIds,
    parseCollectionId,
    parseRegistryKey,
} from './collection-ids.js';

function scopedChunkKey(chunk, settings) {
    if(!chunk?.collectionId)return null;
    const parsed=parseRegistryKey(chunk.collectionId);
    return parsed.backend ? chunk.collectionId : `${settings?.vector_backend||'standard'}:${settings?.source||'transformers'}:${chunk.collectionId}`;
}

// Hash cache for performance
const hashCache = new LRUCache(HASH_CACHE_SIZE);

// Synchronization state
let syncBlocked = false;
let manualSyncActive = false;

// ============================================================================
// RE-EXPORTS from collection-ids.js for backwards compatibility
// Other files importing from chat-vectorization.js will still work.
// ============================================================================

// Re-export getChatUUID (already imported above)
export { getChatUUID };

/**
 * Builds chat collection ID using the chat's unique UUID
 * Format: vecthare_chat_{charName}_{uuid}
 * @param {string} [chatUUID] Optional UUID override, otherwise uses current chat
 * @returns {string|null} Collection ID or null if no chat
 */
export function getChatCollectionId(chatUUID) {
    return buildChatCollectionId(chatUUID);
}

/**
 * Gets the legacy format collection ID for backwards compatibility
 * @param {string} [chatId] Optional chatId override, otherwise uses current chat
 * @returns {string|null} Legacy collection ID or null if no chat
 */
export function getLegacyChatCollectionId(chatId) {
    return buildLegacyChatCollectionId(chatId);
}

// Re-export getAllChatCollectionIds with adapted return format for backwards compat
export { getAllChatCollectionIds, parseCollectionId, parseRegistryKey };

/**
 * Gets the hash value for a string (with LRU caching)
 * @param {string} str Input string
 * @returns {number} Hash value
 */
function getStringHash(str) {
    const cached = hashCache.get(str);
    if (cached !== undefined) {
        return cached;
    }
    const hash = calculateHash(str);
    hashCache.set(str, hash);
    return hash;
}

/**
 * Gets message text without file attachments
 * Matches behavior of ST vectors extension for hash compatibility
 * @param {object} message Chat message object
 * @returns {string} Message text without attachment prefix
 */
function getTextWithoutAttachments(message) {
    const fileLength = message?.extra?.fileLength || 0;
    return String(message?.mes || '').substring(fileLength).trim();
}

/**
 * Prepares items for insertion by adding source metadata
 * @param {object[]} items Array of vector items
 * @returns {object[]} Items with source metadata added
 */
function prepareItemsForInsertion(items) {
    return items.map(item => ({
        ...item,
        metadata: {
            ...item.metadata,
            source: 'chat',
        }
    }));
}

/**
 * Groups messages according to chunking strategy
 *
 * HASH DESIGN NOTE: Hashes are calculated from combined text ONLY (not message indices).
 * This is INTENTIONAL semantic deduplication - identical text produces identical embeddings,
 * so storing duplicates would waste storage and query budget. Individual message IDs are
 * preserved in metadata.messageIds and metadata.messageHashes for injection lookup.
 * DO NOT add message indices to hash calculation - it would break incremental sync and
 * disable deduplication with no functional benefit.
 *
 * @param {object[]} messages Messages to group
 * @param {string} strategy Chunking strategy: 'per_message', 'conversation_turns', 'message_batch'
 * @param {number} batchSize Number of messages per batch (for message_batch strategy)
 * @param {string} keywordLevel Keyword extraction level: 'off', 'minimal', 'balanced', 'aggressive'
 * @returns {object[]} Grouped message items ready for chunking
 */
export function groupMessagesByStrategy(messages, strategy, batchSize = 4, keywordLevel = 'balanced', conversationTurnOrder = 'user_character') {
    if (!messages.length) return [];

    // Helper to extract keywords based on level
    const getKeywords = (text) => {
        if (keywordLevel === 'off') return [];
        return extractBM25Keywords(text, { level: keywordLevel });
    };

    switch (strategy) {
        case 'conversation_turns': {
            const order = normalizeTurnOrder(conversationTurnOrder);
            return groupConversationTurns(messages, order).map(pair => {
                const combinedText = pair.map(m => `[${m.is_user ? 'User' : 'Character'}]: ${m.text}`).join('\n\n');
                return {
                    text: combinedText,
                    hash: getStringHash(combinedText),
                    index: pair[0].index,
                    keywords: getKeywords(combinedText),
                    metadata: {
                        strategy: 'conversation_turns',
                        turnOrder: order,
                        messageIds: pair.map(m => m.index),
                        messageHashes: pair.map(m => m.hash),
                        startIndex: pair[0].index,
                        endIndex: pair[pair.length - 1].index,
                    },
                };
            });
        }

        case 'message_batch': {
            // Group N messages together
            const grouped = [];
            for (let i = 0; i < messages.length; i += batchSize) {
                const batch = messages.slice(i, i + batchSize);
                // Combine texts with speaker labels
                const combinedText = batch.map(m => {
                    const role = m.is_user ? 'User' : 'Character';
                    return `[${role}]: ${m.text}`;
                }).join('\n\n');

                grouped.push({
                    text: combinedText,
                    hash: getStringHash(combinedText),
                    index: batch[0].index,
                    keywords: getKeywords(combinedText),
                    metadata: {
                        strategy: 'message_batch',
                        batchSize: batch.length,
                        messageIds: batch.map(m => m.index),
                        messageHashes: batch.map(m => m.hash), // Store individual hashes for injection lookup
                        startIndex: batch[0].index,
                        endIndex: batch[batch.length - 1].index
                    }
                });
            }
            return grouped;
        }

        case 'adaptive': {
            // Adaptive is a character-budget strategy, never silently per-message.
            // Used with a deterministic metadata mapping to all source messages.
            throw new Error('Adaptive chat syncing requires a complete re-vectorization using the Content Vectorizer; refusing to silently fall back to Per Message.');
        }
        case 'per_scene': return [];
        case 'per_message':
        default:
            // Current behavior - each message is its own item
            return messages.map(m => ({
                text: m.text,
                hash: m.hash,
                index: m.index,
                is_user: m.is_user,
                keywords: getKeywords(m.text),
                metadata: {
                    strategy: 'per_message',
                    messageId: m.index,
                    messageHashes: [m.hash] // Consistent with grouped strategies
                }
            }));
    }
}

/**
 * Filters out chunks that have been disabled by scene vectorization
 * @param {object[]} chunks Chunks to filter
 * @returns {object[]} Chunks not disabled by scenes
 */
function filterSceneDisabledChunks(chunks) {
    const filtered = chunks.filter(chunk => {
        const isDisabled = isChunkDisabledByScene(chunk.hash);
        if (isDisabled) {
            console.debug(`VectHare: Chunk ${chunk.hash} is disabled by scene`);
        }
        return !isDisabled;
    });

    if (filtered.length !== chunks.length) {
        console.log(`VectHare: Scene filtering: ${chunks.length} → ${filtered.length} chunks (${chunks.length - filtered.length} disabled by scenes)`);
    }

    return filtered;
}

/**
 * Applies chunk-level conditions to filter results
 * @param {object[]} chunks Chunks with metadata
 * @param {object[]} chat Chat messages for context
 * @param {object} settings VectHare settings
 * @returns {Promise<object[]>} Filtered chunks
 */
async function applyChunkConditions(chunks, chat, settings) {
    // First filter out chunks disabled by scenes
    let filtered = filterSceneDisabledChunks(chunks);

    // Check if any chunks have conditions (from chunk metadata)
    const chunksWithConditions = filtered.map(chunk => {
        const chunkMeta = getChunkMetadata(chunk.hash, scopedChunkKey(chunk, typeof settings !== 'undefined' ? settings : null));
        if (chunkMeta?.conditions?.enabled) {
            return { ...chunk, conditions: chunkMeta.conditions };
        }
        return chunk;
    });

    // If no chunks have conditions, return filtered
    const hasAnyConditions = chunksWithConditions.some(c => c.conditions?.enabled);
    if (!hasAnyConditions) {
        return filtered;
    }

    // Build search context for condition evaluation
    const context = buildSearchContext(chat, settings.query || 10, chunksWithConditions, {
        generationType: settings.generationType || 'normal',
        isGroupChat: settings.isGroupChat || false,
        currentCharacter: settings.currentCharacter || null,
        activeLorebookEntries: settings.activeLorebookEntries || [],
        activationHistory: window.VectHare_ActivationHistory || {}
    });

    // Filter chunks by their conditions
    const conditionFilteredChunks = filterChunksByConditions(chunksWithConditions, context);

    // Track activation for frequency conditions
    conditionFilteredChunks.forEach(chunk => {
        if (chunk.conditions?.enabled) {
            trackChunkActivation(chunk.hash, chat.length);
        }
    });

    console.log(`VectHare: Chunk conditions filtered ${filtered.length} → ${conditionFilteredChunks.length}`);
    return conditionFilteredChunks;
}

/**
 * Tracks chunk activation for frequency/cooldown conditions
 * @param {number} hash Chunk hash
 * @param {number} messageCount Current message count
 */
function trackChunkActivation(hash, messageCount) {
    if (!window.VectHare_ActivationHistory) {
        window.VectHare_ActivationHistory = {};
    }

    const history = window.VectHare_ActivationHistory[hash] || { count: 0, lastActivation: null };
    window.VectHare_ActivationHistory[hash] = {
        count: history.count + 1,
        lastActivation: messageCount
    };
}

/**
 * Rerank chunks using BananaBread's reranking endpoint
 * @param {string} query The search query
 * @param {Array} chunks Array of chunks with text
 * @param {object} settings VectHare settings
 * @returns {Promise<Array>} Chunks with updated scores from reranker
 */
async function rerankWithBananaBread(query, chunks, settings) {
    if (!chunks.length) return chunks;

    const apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : 'http://localhost:8008';
    const documents = chunks.map(c => c.text);

    try {
        const response = await fetch('/api/plugins/similharity/rerank', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                apiUrl,
                apiKey: settings.bananabread_api_key || '', // Include API key for authentication
                query,
                documents,
                top_k: chunks.length
            }),
        });

        if (!response.ok) {
            console.warn('VectHare: Reranking failed, using original scores');
            return chunks;
        }

        const data = await response.json();
        if (!data.results || !Array.isArray(data.results)) {
            return chunks;
        }

        // Apply rerank scores - results are sorted by score desc
        // Each result has { index, score } where index refers to original position
        const rerankedChunks = data.results.map(r => {
            const chunk = { ...chunks[r.index] };
            chunk.rerankScore = r.score;
            chunk.originalScore = chunk.score;
            chunk.score = r.score; // Replace score with rerank score
            return chunk;
        });

        console.log(`VectHare: Reranked ${rerankedChunks.length} chunks with BananaBread`);
        return rerankedChunks;
    } catch (error) {
        console.warn('VectHare: Reranking error:', error.message);
        return chunks;
    }
}

/**
 * Synchronizes chat with vector index using simple FIFO queue
 *
 * How it works:
 * 1. Get all messages, get all vectorized hashes from DB
 * 2. Queue = messages not yet in DB (by hash)
 * 3. Process batch: take message, chunk it, insert chunks, remove from queue
 * 4. Repeat until queue empty
 *
 * @param {object} settings VectHare settings
 * @param {number} batchSize Number of messages to process per call
 * @returns {Promise<object>} Progress info
 */
/** Deterministic representation shared by incremental sync and the repair scanner. */
export async function buildExpectedChatItems(chat, settings) {
    if (!Array.isArray(chat)) throw new Error('Chat contents unavailable');
    const messages=[];
    for(let i=0;i<chat.length;i++) {
        const msg=chat[i];
        if(msg.is_system)continue;
        const text=cleanText(String(substituteParams(getTextWithoutAttachments(msg))),settings.cleaning_snapshot);
        messages.push({text,hash:getStringHash(text),index:i,is_user:!!msg.is_user});
    }
    const keywordLevel=settings.keyword_extraction_level || 'balanced';
    let grouped;
    if(settings.chunking_strategy==='adaptive') {
        const segments=messages.map(m=>({index:m.index,start:0,end:0,label:`[${m.is_user?'User':'Character'}]: ${m.text}`}));
        let cursor=0;
        for(const part of segments){part.start=cursor;cursor+=part.label.length;part.end=cursor;cursor+=2;}
        const combined=segments.map(x=>x.label).join('\n\n');
        const chunks=await chunkText(combined,{strategy:'adaptive',chunkSize:settings.chunk_size||500,chunkOverlap:settings.chunk_overlap||0});
        let scanFrom=0;
        grouped=chunks.map(c=>{
            const location=combined.indexOf(c.text,scanFrom);
            const start=location>=0?location:scanFrom;
            const end=start+c.text.length;
            scanFrom=start+Math.max(1,c.text.length-Number(settings.chunk_overlap||0));
            const ids=segments.filter(m=>m.start<end && m.end>start).map(m=>m.index);
            return {text:c.text,hash:getStringHash(c.text),index:ids[0]||0,keywords:keywordLevel==='off'?[]:extractBM25Keywords(c.text,{level:keywordLevel}),metadata:{...c.metadata,strategy:'adaptive',messageIds:ids,startIndex:ids[0],endIndex:ids.at(-1)}};
        });
    } else grouped=groupMessagesByStrategy(messages,settings.chunking_strategy||'per_message',settings.batch_size||4,keywordLevel,settings.conversation_turn_order||'user_character');
    return assignOccurrenceIds(await prepareEmbeddingItems(prepareItemsForInsertion(grouped),settings,getStringHash),getStringHash);
}

export async function synchronizeChat(settings, batchSize = 5, {manual=false, control=null, onProgress=null} = {}) {
    const chatUUID=getChatUUID();
    const originatingChatFile=getCurrentChatId();
    if(!chatUUID || !getCurrentChatId())return {remaining:-1,messagesProcessed:0,chunksCreated:0};
    if(!manual && hasActiveVectorWrite())return {remaining:-1,messagesProcessed:0,chunksCreated:0};
    const binding=getChatBinding(chatUUID);
    // A persisted collection profile wins over global defaults for this chat.
    const requested=binding ? settingsForSavedCollection(binding.registryKey,settings) : settings;
    const target=resolveChatWriteTarget(requested,chatUUID,getChatCollectionId(chatUUID));
    if(!manual){
        const {isCollectionAutoSyncEnabled}=await import('./collection-metadata.js');
        if(!isCollectionAutoSyncEnabled(target.registryKey))return {remaining:-1,messagesProcessed:0,chunksCreated:0};
    }
    if(requested.chunking_strategy==='per_scene')return {remaining:0,messagesProcessed:0,chunksCreated:0};
    const verified=await applyAndVerifyProfile(target.registryKey,requested,{allowNew:target.newCollection});
    const effective=verified.settings;
    if(!verified.profile.embedding.verified)throw new Error('Embedding model identity unverified; refusing to sync');
    try {await waitUntilCondition(()=>!syncBlocked && !is_send_press,1000);}
    catch {return {remaining:-1,messagesProcessed:0,chunksCreated:0};}
    const startChatId=getCurrentChatId();
    let autoActivityId=null, autoControl=null, autoShared=null, autoOutcome='failed';
    let checkpointStarted=false;
    try {
        syncBlocked=true;
        const context=getContext();
        if(!Array.isArray(context.chat))throw new Error('Current chat is unavailable');
        const chatSignature=()=>JSON.stringify(context.chat.map(m=>[m.mes,m.swipe_id,m.is_user,m.is_system,m.extra?.fileLength]));
        const signatureAtStart=chatSignature();
        const chatSnapshot=structuredClone(context.chat);
        const expected=await buildExpectedChatItems(chatSnapshot,effective);
        // Identity registration must not create a physical or registered empty
        // collection. Initial vectorization of an empty/all-filtered chat is
        // deliberately a no-op, retaining Auto-Sync disabled.
        if(target.newCollection && expected.length===0)
            return {remaining:0,messagesProcessed:0,chunksCreated:0};
        if(!manual){autoShared=await acquireSharedOperation('Auto-Sync Chat',{category:'autosync',resourceKey:target.registryKey,queue:false});}
        if(getCurrentChatId()!==originatingChatFile || getChatUUID()!==chatUUID)
            throw new Error('Originating chat changed while waiting for the shared backend slot; no vectors written');
        const assertUnchanged=()=>{
            if(startChatId!==getCurrentChatId()||getChatUUID()!==chatUUID||chatSignature()!==signatureAtStart)
                throw new Error('Chat edited or switched during synchronization; completed chunks retained');
        };
        assertUnchanged();
        if(target.newCollection && getCollectionRegistry().includes(target.registryKey))
            throw new Error('Unbound existing collection cannot be adopted automatically');
        // Before the first write, persist the verified profile and ownership.
        // An interruption after the first DB commit can then recover safely.
        if(target.newCollection){
            if((effective.vector_backend || 'standard') === 'qdrant') {
                const candidateBackend = await getBackend(effective);
                const before = await candidateBackend.listChunks(target.collectionId,effective,{offset:0,limit:1});
                if(!Array.isArray(before?.items) || before.items.length) throw new Error('New Qdrant collection already exists; refusing to reuse or overwrite it');
                claimQdrantIdentity(target.registryKey,effective);
            }
            await saveCollectionProfile(target.registryKey,verified.profile);
            await saveChatChunkManifest(target.registryKey,[],chatUUID);
            bindChatCollection(chatUUID,target.registryKey,{writeVerified:true});
            registerCollection(target.registryKey);
        } else {
            const manifest=getChatChunkManifest(target.registryKey);
            if(!manifest || manifest.chatUUID!==chatUUID)throw new Error('Collection has no reliable chat manifest; cannot perform interruption-safe Sync Chat');
        }
        const backend=await getBackend(effective);
        let actual;
        try {actual=await inspectCollectionChunks(backend,target.collectionId,effective);}
        catch(error){
            if(target.newCollection && /\b404\b/.test(error.message))actual=[];
            else throw error;
        }
        const stored=new Map();
        for(const row of actual){
            const hash=String(row.hash);
            if(stored.has(hash))throw new Error(`Duplicate stored hash ${hash}; run Scan Chat before syncing`);
            stored.set(hash,row);
        }
        const expectedByHash=new Map(expected.map(item=>[String(item.hash),item]));
        if(expectedByHash.size!==expected.length)throw new Error('Expected chunk hash collision; refusing ambiguous writes');
        if(target.newCollection && actual.length)throw new Error('Generated collection already contains vectors; refusing to adopt existing content');
        const confirmed=expected.filter(item=>chunkMatchesExpected(stored.get(String(item.hash)),item));
        const needed=expected.filter(item=>!chunkMatchesExpected(stored.get(String(item.hash)),item));
        const stale=actual.filter(row=>!expectedByHash.has(String(row.hash)));
        beginSyncCheckpoint(target.registryKey,chatUUID,expected.length,confirmed.length);
        checkpointStarted=true;
        // Recover a commit that succeeded before the previous process was able
        // to persist its manifest. The database, not the journal, is truth.
        const oldManifest=getChatChunkManifest(target.registryKey);
        const oldKnown=new Set((oldManifest?.entries||[]).map(entry=>String(entry.hash)));
        const recovered=confirmed.filter(item=>!oldKnown.has(String(item.hash)));
        if(recovered.length)await patchChatChunkManifest(target.registryKey,recovered,chatUUID);
        const items=needed.slice(0,Math.max(1,batchSize));
        if(!manual && items.length){
            autoActivityId=startActivity('Auto-Sync Chat',{category:'autosync',resourceKey:target.registryKey,total:expected.length,unit:'chunks',detail:`${confirmed.length} already verified`});
            autoControl=createOperationControl(autoActivityId,{pausable:false,stoppable:true,writeOperation:true});
            if(autoShared){autoShared.activityId=autoActivityId;autoControl.bindSharedOperation(autoShared);}
        }
        const gate=control||autoControl;
        let processed=0;
        for(const chunk of items){
            await gate?.checkpoint();
            assertUnchanged();
            updateSyncCheckpoint(target.registryKey,chatUUID,{phase:'running',activeHash:String(chunk.hash),message:'Embedding next missing or mismatched chunk'});
            await insertVectorItems(target.collectionId,[chunk],effective);
            // Verify the acknowledged write before counting it as completed.
            // getChunk is O(1) when supported; fallback is full inventory.
            let row=typeof backend.getChunk==='function'?await backend.getChunk(target.collectionId,chunk.hash,effective):null;
            if(!row){
                const updated=await inspectCollectionChunks(backend,target.collectionId,effective);
                row=updated.find(x=>String(x.hash)===String(chunk.hash));
            }
            if(!chunkMatchesExpected(row,chunk))throw new Error(`Chunk ${chunk.hash} was not verified after backend insertion; preserving it for retry`);
            await patchChatChunkManifest(target.registryKey,[chunk],chatUUID);
            processed++;
            const verifiedCount=confirmed.length+processed;
            acknowledgeSyncChunk(target.registryKey,chatUUID,chunk.hash,verifiedCount);
            onProgress?.({completed:verifiedCount,total:expected.length,detail:`Verified ${verifiedCount}/${expected.length} chunks`});
            if(autoActivityId)updateActivity(autoActivityId,{completed:verifiedCount,total:expected.length,detail:`Verified ${verifiedCount}/${expected.length} chunks`});
        }
        await gate?.checkpoint();
        assertUnchanged();
        const remaining=needed.length-processed;
        if(!remaining && stale.length){
            await gate?.checkpoint();
            // Only remove stale records after all expected vectors are present.
            const hashes=[...new Set(stale.map(row=>row.hash))];
            await deleteVectorItems(target.collectionId,hashes,effective);
            const after=await inspectCollectionChunks(backend,target.collectionId,effective);
            if(after.some(row=>hashes.map(String).includes(String(row.hash))))throw new Error('Stale vectors were not fully deleted; run Repair');
            await patchChatChunkManifest(target.registryKey,[],chatUUID,hashes);
        }
        if(!remaining){
            finalizeSyncCheckpoint(target.registryKey,chatUUID,'completed','All current chunks verified');
            setCollectionMeta(target.registryKey,{lastSuccessfulSyncAt:new Date().toISOString()});
        }else updateSyncCheckpoint(target.registryKey,chatUUID,{phase:'running',activeHash:null,message:`${remaining} chunks still pending`});
        autoOutcome='completed';
        if(autoActivityId)finishActivity(autoActivityId,true,`Verified ${processed} new chunks; ${remaining} pending`);
        return {remaining,messagesProcessed:processed,chunksCreated:processed,itemsFailed:0,total:expected.length,verified:confirmed.length+processed};
    }catch(error){
        autoOutcome=error instanceof OperationStoppedError || error instanceof SharedOperationStoppedError?'stopped':'failed';
        if(checkpointStarted)finalizeSyncCheckpoint(target.registryKey,chatUUID,error instanceof OperationStoppedError?'stopped':'interrupted',error.message);
        if(autoActivityId)finishActivity(autoActivityId,error instanceof OperationStoppedError || error instanceof SharedOperationStoppedError?'stopped':false,error.message);
        throw error;
    }finally{
        if(autoShared)try{await finishSharedOperation(autoShared,autoOutcome);}catch(e){console.warn('VectHare: auto-sync lease recovery required:',e);}
        if(autoActivityId)detachOperationControl(autoActivityId);
        syncBlocked=false;
    }
}

// ============================================================================
// REARRANGE CHAT PIPELINE - Helper Functions
// ============================================================================
// These functions break down the rearrangeChat logic into discrete stages
// for better maintainability and testability.
// ============================================================================

/**
 * Stage 1: Gather all collections that should be queried
 * @param {object} settings VectHare settings
 * @returns {string[]} Array of collection IDs to query
 */
function gatherCollectionsToQuery(settings) {
    const chatCollectionId = getChatBinding()?.registryKey || getChatCollectionId();
    const currentChatId = getCurrentChatId();
    const chatPolicy = getChatCollectionPolicy(currentChatId);
    const collectionsToQuery = [];

    // Include chat collection if it's enabled AND we have a valid collection ID
    // Uses per-collection enabled state, not global enabled_chats
    if (chatCollectionId && isCollectionEnabled(chatCollectionId)) {
        collectionsToQuery.push(chatCollectionId);
    }

    // Get all other registered collections that are enabled
    const registry = getCollectionRegistry();
    for (const registryKey of registry) {
        // Use proper registry key parser to extract collection ID
        const parsedKey = parseRegistryKey(registryKey);
        const collectionId = parsedKey.collectionId;

        // Skip if this is the current chat collection (already handled above)
        if (registryKey === chatCollectionId) continue;
        if (isCollectionEnabled(registryKey)) {
            collectionsToQuery.push(registryKey);
        }
    }

    // Add explicitly selected/forced collections for this chat. These bypass
    // trigger/condition activation later, but still respect disabled state here.
    for (const selectedId of chatPolicy.selectedCollections || []) {
        const alreadyIncluded = collectionsToQuery.some(id => {
            const parsedExisting = parseRegistryKey(id);
            const parsedSelected = parseRegistryKey(selectedId);
            return id === selectedId || (!parsedExisting.backend || !parsedSelected.backend)
                && parsedExisting.collectionId === parsedSelected.collectionId;
        });

        if (!alreadyIncluded && isCollectionEnabled(selectedId)) {
            collectionsToQuery.push(selectedId);
        }
    }

    return applyChatCollectionPolicy(collectionsToQuery, currentChatId);
}

/**
 * Stage 2: Build the search query from recent messages
 * @param {object[]} chat Current chat messages
 * @param {object} settings VectHare settings
 * @returns {string} Query text
 */
function buildSearchQuery(chat, settings) {
    const recentMessages = chat
        .filter(x => !x.is_system)
        .reverse()
        .slice(0, settings.query)
        .map(x => substituteParams(x.mes));

    return recentMessages.join('\n').trim();
}

/**
 * Stage 3: Query all active collections and merge results
 * @param {string[]} activeCollections Collections that passed activation filters
 * @param {string} queryText Search query
 * @param {object} settings VectHare settings
 * @param {object[]} chat Current chat messages
 * @param {object} debugData Debug tracking object
 * @returns {Promise<object[]>} Array of chunk objects with scores
 */
async function queryAndMergeCollections(activeCollections, queryText, settings, chat, debugData, requestedLimit=null, pageCache=null) {
    let chunksForVisualizer = [];
    const effectiveTopK = settings.top_k ?? settings.insert;
    // Query more than Top-K because threshold, activation, conditions, decay,
    // grouping and recent-context dedup happen after the backend query.
    const candidateLimit = requestedLimit ?? Math.min(250, Math.max(effectiveTopK * 4, 32));
    let canRefill = false;
    const failedCollections = [];

    // PERF: Build hash-to-message Map once for O(1) lookups instead of O(n) find() per chunk
    const chatHashMap = new Map();
    for (const msg of chat) {
        if (msg.mes) {
            const hash = getStringHash(substituteParams(getTextWithoutAttachments(msg)));
            if (!chatHashMap.has(hash)) {
                chatHashMap.set(hash, msg);
            }
        }
    }

    for (const collectionId of activeCollections) {
        try {
            // Reuse exhausted collections and already-fetched prefixes. Only
            // collections with a full prior candidate page are queried again.
            const snapshot=await loadCachedCandidatePage(pageCache||new Map(),collectionId,candidateLimit,
                (_id,limit)=>queryCollection(collectionId,queryText,limit,settings));
            const queryResults=snapshot.result;
            if(snapshot.full)canRefill=true;

            // TRACE: Vector query results for this collection
            addTrace(debugData, 'vector_search', `Query completed for ${collectionId}`, {
                hashesReturned: queryResults.hashes.length,
                hashes: queryResults.hashes.slice(0, 5),
                scoreBreakdown: queryResults.metadata.slice(0, 5).map(m => ({
                    finalScore: m.score?.toFixed(3),
                    originalScore: m.originalScore?.toFixed(3),
                    keywordBoost: m.keywordBoost?.toFixed(2) || '1.00',
                    matchedKeywords: m.matchedKeywords || [],
                    keywordBoosted: m.keywordBoosted || false
                }))
            });

            console.log(`VectHare: Retrieved ${queryResults.hashes.length} chunks from ${collectionId}`);

            // Build chunks with text for visualizer
            const collectionChunks = queryResults.metadata.map((meta, idx) => {
                const hash = queryResults.hashes[idx];

                // Prefer text from metadata (stored in vector DB)
                let text = meta.text;
                let textSource = 'metadata';

                // Fallback: try to find in chat messages if not in metadata
                // PERF: Use pre-built Map for O(1) lookup instead of O(n) find()
                if (!text) {
                    const chatMessage = chatHashMap.get(hash);
                    text = chatMessage ? substituteParams(chatMessage.mes) : '(text not found)';
                    textSource = chatMessage ? 'chat_lookup' : 'not_found';

                    // Debug: Log when text is not found
                    if (textSource === 'not_found') {
                        console.warn(`[VectHare] ⚠️ Chunk text not found! hash=${hash}, meta.text=${meta.text ? 'exists' : 'missing'}, chatMessage=${chatMessage ? 'found' : 'not found'}`);
                    }
                }

                // TRACE: Record initial chunk state
                recordChunkFate(debugData, hash, 'vector_search', 'passed', null, {
                    finalScore: meta.score ?? 0,
                    originalScore: meta.originalScore,
                    keywordBoost: meta.keywordBoost,
                    matchedKeywords: meta.matchedKeywords,
                    textSource,
                    textLength: text?.length || 0,
                    collectionId
                });

                return {
                    hash: hash,
                    metadata: meta,
                    score: meta.score ?? 0,
                    originalScore: meta.originalScore,
                    keywordBoost: meta.keywordBoost,
                    matchedKeywords: meta.matchedKeywords,
                    matchedKeywordsWithWeights: meta.matchedKeywordsWithWeights,
                    keywordBoosted: meta.keywordBoosted,
                    similarity: meta.score ?? 0,
                    text: text,
                    index: meta.messageId ?? meta.index ?? 0,
                    collectionId: collectionId,
                    decayApplied: false,
                    // Hybrid search scores
                    vectorScore: meta.vectorScore,
                    textScore: meta.textScore,
                    hybridSearch: meta.hybridSearch
                };
            });

            chunksForVisualizer.push(...collectionChunks);
        } catch (error) {
            failedCollections.push({collectionId, error: error.message});
            console.error(`VectHare: Failed to query collection ${collectionId}:`, error.message);
            addTrace(debugData, 'vector_search', `Query failed for ${collectionId}`, {
                error: error.message
            });
        }
    }

    // A partial result is not an all-clear. Surface every failed collection;
    // if none succeeded, propagate the error to the caller.
    if (failedCollections.length) {
        debugData.retrievalFailures = failedCollections;
        const message = `Retrieval degraded: ${failedCollections.length}/${activeCollections.length} collection(s) failed: ` +
            failedCollections.map(f => f.collectionId).join(', ');
        console.error('[VectHare]', message);
        if (typeof toastr !== 'undefined') toastr.warning(message, 'VectHare', {timeOut:8000});
        if (failedCollections.length === activeCollections.length)
            throw new Error(message);
    }
    // DO NOT trim here: later eligibility filters need alternative candidates.
    chunksForVisualizer.sort((a, b) => b.score - a.score);
    // Backend returned a full page: more eligible candidates may exist.
    chunksForVisualizer.mayHaveMore = canRefill;
    return chunksForVisualizer;
}

/**
 * Stage 3.5: Expand summary chunks to their parent chunks (dual-vector system)
 * When a summary chunk matches a query, we want to inject the full parent text instead.
 * The summary's score is preserved since that's what semantically matched.
 *
 * @param {object[]} chunks Chunks from query results
 * @param {string[]} activeCollections Collections that were queried
 * @param {object} settings VectHare settings
 * @param {object} debugData Debug tracking object
 * @returns {Promise<object[]>} Chunks with summaries expanded to parents
 */
async function expandSummaryChunks(chunks, activeCollections, settings, debugData) {
    const expandedChunks = [];
    const parentHashesNeeded = new Map(); // parentHash -> { summaryChunk, collectionId }

    // First pass: identify which chunks are summaries and need parent expansion
    for (const chunk of chunks) {
        const meta = chunk.metadata || {};
        const isSummary = meta.isSummaryChunk || meta.isSummary || meta.isSummaryVector;
        const parentHash = meta.parentHash;

        if (isSummary && parentHash) {
            // Track this summary for parent lookup
            parentHashesNeeded.set(String(parentHash), {
                summaryChunk: chunk,
                collectionId: chunk.collectionId
            });

            addTrace(debugData, 'summary_expansion', `Summary chunk found, will expand to parent`, {
                summaryHash: chunk.hash,
                parentHash: parentHash,
                summaryScore: chunk.score?.toFixed(3),
                collectionId: chunk.collectionId
            });
        } else {
            // Not a summary, keep as-is
            expandedChunks.push(chunk);
        }
    }

    // If no summaries found, return original chunks
    if (parentHashesNeeded.size === 0) {
        return chunks;
    }

    // Second pass: fetch parent chunks from the vector DB
    // Group by collection for efficiency
    const parentsByCollection = new Map();
    for (const [parentHash, info] of parentHashesNeeded) {
        const collectionId = info.collectionId;
        if (!parentsByCollection.has(collectionId)) {
            parentsByCollection.set(collectionId, []);
        }
        parentsByCollection.get(collectionId).push({ parentHash, summaryChunk: info.summaryChunk });
    }

    // Fetch parents from each collection
    for (const [collectionId, parentInfos] of parentsByCollection) {
        try {
            // Get all chunks from this collection with metadata
            const collectionData = await getSavedHashes(collectionId, settings, true);

            if (collectionData && collectionData.metadata) {
                // Build a lookup map of hash -> chunk data
                const chunkLookup = new Map();
                for (let i = 0; i < collectionData.hashes.length; i++) {
                    const hash = String(collectionData.hashes[i]);
                    chunkLookup.set(hash, collectionData.metadata[i]);
                }

                // Find each parent and create expanded chunk
                for (const { parentHash, summaryChunk } of parentInfos) {
                    const parentData = chunkLookup.get(String(parentHash));

                    if (parentData) {
                        // Found parent - create expanded chunk with parent's text but summary's score
                        const expandedChunk = {
                            ...summaryChunk,
                            hash: parentHash, // Use parent's hash for deduplication
                            text: parentData.text || parentData.mes || '(parent text not found)',
                            metadata: {
                                ...parentData,
                                expandedFromSummary: true,
                                originalSummaryHash: summaryChunk.hash,
                                originalSummaryScore: summaryChunk.score
                            },
                            // Keep summary's score since that's what matched the query
                            score: summaryChunk.score,
                            originalScore: summaryChunk.originalScore,
                            expandedFromSummary: true
                        };

                        expandedChunks.push(expandedChunk);

                        recordChunkFate(debugData, parentHash, 'summary_expansion', 'passed',
                            `Expanded from summary #${summaryChunk.hash}`, {
                                summaryHash: summaryChunk.hash,
                                parentTextLength: expandedChunk.text?.length || 0,
                                inheritedScore: summaryChunk.score?.toFixed(3)
                            });

                        addTrace(debugData, 'summary_expansion', `Parent chunk retrieved`, {
                            parentHash: parentHash,
                            summaryHash: summaryChunk.hash,
                            parentTextLength: expandedChunk.text?.length || 0
                        });
                    } else {
                        // Parent not found - keep the summary chunk as fallback
                        console.warn(`VectHare: Parent chunk ${parentHash} not found for summary ${summaryChunk.hash}, using summary text`);
                        expandedChunks.push(summaryChunk);

                        recordChunkFate(debugData, summaryChunk.hash, 'summary_expansion', 'passed',
                            `Parent not found, using summary text`, {
                                parentHash: parentHash,
                                fallback: true
                            });
                    }
                }
            } else {
                // Couldn't get collection data - keep summaries as-is
                for (const { summaryChunk } of parentInfos) {
                    expandedChunks.push(summaryChunk);
                }
            }
        } catch (error) {
            console.warn(`VectHare: Failed to expand summaries from ${collectionId}:`, error.message);
            // Keep summaries as-is on error
            for (const { summaryChunk } of parentInfos) {
                expandedChunks.push(summaryChunk);
            }
        }
    }

    addTrace(debugData, 'summary_expansion', 'Summary expansion complete', {
        originalCount: chunks.length,
        summariesExpanded: parentHashesNeeded.size,
        finalCount: expandedChunks.length
    });

    return expandedChunks;
}

/**
 * Stage 4: Apply threshold filter to chunks
 * @param {object[]} chunks Chunks to filter
 * @param {number} threshold Score threshold
 * @param {object} debugData Debug tracking object
 * @returns {object[]} Filtered chunks
 */
function applyThresholdFilter(chunks, threshold, debugData) {
    const beforeCount = chunks.length;
    const filtered = chunks.filter(chunk => {
        const passes = chunk.score >= threshold;
        if (!passes) {
            recordChunkFate(debugData, chunk.hash, 'threshold', 'dropped',
                `Score ${chunk.score.toFixed(3)} < threshold ${threshold}`,
                { score: chunk.score, threshold }
            );
        } else {
            recordChunkFate(debugData, chunk.hash, 'threshold', 'passed', null,
                { score: chunk.score, threshold }
            );
        }
        return passes;
    });

    addTrace(debugData, 'threshold', 'Threshold filter applied', {
        threshold,
        before: beforeCount,
        after: filtered.length,
        dropped: beforeCount - filtered.length
    });

    return filtered;
}

/**
 * Stage 5: Apply temporal decay to chunks
 * @param {object[]} chunks Chunks to process
 * @param {object[]} chat Current chat messages
 * @param {object} settings VectHare settings
 * @param {number} threshold Score threshold for re-filtering
 * @param {object} debugData Debug tracking object
 * @returns {object[]} Chunks with decay applied
 */
function applyTemporalDecayStage(chunks, chat, settings, threshold, debugData) {
    const currentMessageId = chat.length - 1;
    // Hashes are not globally unique: apply decay separately to each collection,
    // preserving input order and per-collection preferences. No hash-keyed map.
    const byCollection = new Map();
    for (const chunk of chunks) {
        const key = chunk.collectionId || '';
        if (!byCollection.has(key)) byCollection.set(key, []);
        byCollection.get(key).push(chunk);
    }
    const output = [];
    for (const [collectionId, group] of byCollection) {
        const custom = collectionId && hasCustomDecaySettings(collectionId);
        const stored = collectionId ? getCollectionDecaySettings(collectionId) : null;
        // An explicit per-collection "off" must override global "on".
        const selected = custom ? stored : (settings.temporal_decay || {enabled:false});
        if (!selected.enabled) { output.push(...group); continue; }
        const sceneChunks = group.filter(c => c.metadata?.isScene === true);
        const scenes = sceneChunks.map(c => ({start:c.metadata.sceneStart,end:c.metadata.sceneEnd,hash:c.hash}));
        const input = group.map(c => ({...c,score:c.score}));
        const result = custom && stored?.enabled
            ? awaitDecayForCollection(input,currentMessageId,collectionId,scenes)
            : (selected.sceneAware && scenes.length ? applySceneAwareDecay(input,currentMessageId,scenes,selected) : applyDecayToResults(input,currentMessageId,selected));
        output.push(...result);
    }
    const kept = output.filter(c => c.score >= threshold);
    addTrace(debugData, 'decay', 'Collection-scoped temporal weighting completed', {
        before:chunks.length,after:kept.length,dropped:chunks.length-kept.length
    });
    return kept.sort((a,b) => b.score-a.score);
}

// The exported per-collection decay adapter is async because it dynamically
// loads settings. This pipeline already has the settings: use its pure engines
// to avoid producing promises during synchronous retrieval filtering.
function awaitDecayForCollection(chunks, currentMessageId, collectionId, scenes) {
    const settings = getCollectionDecaySettings(collectionId);
    if (!settings?.enabled) return chunks;
    if (settings.type === 'nostalgia') return applyNostalgiaToResults(chunks,currentMessageId,settings);
    return settings.sceneAware && scenes?.length
        ? applySceneAwareDecay(chunks,currentMessageId,scenes,settings)
        : applyDecayToResults(chunks,currentMessageId,settings);
}

/**
 * Stage 6: Apply chunk-level conditions
 * @param {object[]} chunks Chunks to filter
 * @param {object[]} chat Current chat messages
 * @param {object} settings VectHare settings
 * @param {object} debugData Debug tracking object
 * @returns {Promise<object[]>} Chunks that passed conditions
 */
async function applyConditionsStage(chunks, chat, settings, debugData) {
    const beforeCount = chunks.length;
    // PERF: Build a Map of hash -> chunk data for tracking instead of copying entire array
    const chunkDataByHash = new Map(chunks.map(c => [c.hash, { score: c.score, conditions: c.metadata?.conditions }]));

    addTrace(debugData, 'conditions', 'Starting condition filtering', {
        chunksToFilter: beforeCount,
        hasConditions: chunks.some(c => c.metadata?.conditions)
    });

    const filtered = await applyChunkConditions(chunks, chat, settings);

    // Record which chunks were dropped by conditions
    const afterConditionsHashes = new Set(filtered.map(c => c.hash));
    for (const [hash, data] of chunkDataByHash) {
        if (afterConditionsHashes.has(hash)) {
            recordChunkFate(debugData, hash, 'conditions', 'passed', null, {
                score: data.score,
                hadConditions: !!data.conditions
            });
        } else {
            recordChunkFate(debugData, hash, 'conditions', 'dropped',
                data.conditions
                    ? `Failed condition: ${JSON.stringify(data.conditions)}`
                    : 'Filtered by condition system',
                {
                    score: data.score,
                    conditions: data.conditions
                }
            );
        }
    }

    addTrace(debugData, 'conditions', 'Condition filtering completed', {
        before: beforeCount,
        after: filtered.length,
        dropped: beforeCount - filtered.length
    });

    return filtered;
}

/**
 * Stage 6.5: Process chunk groups and links
 * - Applies exclusive group filtering (only highest-scoring member passes)
 * - Expands inclusive groups into virtual links
 * - Processes chunk links (both explicit and group-generated)
 * @param {object[]} chunks Chunks to process
 * @param {string[]} activeCollections Active collection IDs
 * @param {object} settings VectHare settings
 * @param {object} debugData Debug tracking object
 * @returns {Promise<object[]>} Processed chunks with links applied
 */
async function applyGroupsAndLinksStage(chunks, activeCollections, settings, debugData) {
    // Group identities and explicit chunk links are local to one collection.
    // Previously a map keyed only by hash would let two different collections
    // influence one another when their chunk IDs happened to match.
    const grouped = new Map();
    for (const chunk of chunks) {
        const key = chunk.collectionId || '';
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(chunk);
    }
    const output = [];
    let groupsProcessed = 0;
    for (const [collectionId, ownChunks] of grouped) {
        const groups = getCollectionMeta(collectionId)?.groups || [];
        const allChunksMap = new Map(ownChunks.map(c => [String(c.hash), c]));
        const result = groups.length ? processChunkGroups(ownChunks, groups, allChunksMap,
            {softBoost: settings.group_soft_boost ?? 0.15}) : {chunks:ownChunks,virtualLinks:new Map()};
        groupsProcessed += groups.length;
        const metadata = new Map();
        for (const chunk of result.chunks) {
            const chunkMeta = getChunkMetadata(chunk.hash, scopedChunkKey(chunk, settings)) || {};
            if ((chunkMeta.links?.length || 0) > 0 || result.virtualLinks?.has(String(chunk.hash))) {
                metadata.set(String(chunk.hash), chunkMeta);
            }
        }
        const merged = result.virtualLinks?.size ? mergeVirtualLinks(metadata,result.virtualLinks) : metadata;
        if (merged.size) {
            const linked = processChunkLinks(result.chunks,merged,settings.group_soft_boost ?? 0.15);
            output.push(...linked.chunks);
        } else output.push(...result.chunks);
    }
    addTrace(debugData,'groups','Collection-scoped chunk groups processed',{
        before:chunks.length,after:output.length,groupsProcessed
    });
    return output;
}

/**
 * Stage 7: Deduplicate chunks already in chat context
 * Only checks against recent messages within the context window, not entire chat history.
 * @param {object[]} chunks Chunks to deduplicate
 * @param {object[]} chat Current chat messages
 * @param {object} settings VectHare settings (uses deduplication_depth)
 * @param {object} debugData Debug tracking object
 * @returns {{toInject: object[], skipped: object[]}} Chunks to inject and skipped duplicates
 */
function deduplicateChunks(chunks, chat, settings, debugData) {
    // Determine how far back to check for duplicates
    // Default to 50 messages if not specified (reasonable context window)
    const deduplicationDepth = settings.deduplication_depth ?? 50;

    addTrace(debugData, 'injection', 'Starting deduplication and injection', {
        chunksToInject: chunks.length,
        chatLength: chat.length,
        deduplicationDepth: deduplicationDepth
    });

    // Only check the most recent N messages (within context window)
    const recentMessages = deduplicationDepth <= 0 ? []
        : deduplicationDepth < chat.length ? chat.slice(-deduplicationDepth) : chat;

    console.log(`[VectHare Dedup] Building hash set from ${recentMessages.length} recent messages (depth: ${deduplicationDepth})`);
    console.log(`[VectHare Dedup] Total chat length: ${chat.length}, checking duplicates in last ${recentMessages.length} messages`);

    // Build set of hashes currently in chat context
    const currentChatHashes = new Set();
    const chatHashMap = new Map(); // For debugging: hash -> message preview

    recentMessages.forEach((msg, idx) => {
        if (msg.mes) {
            const cleanedText = substituteParams(getTextWithoutAttachments(msg));
            const hash = getStringHash(cleanedText);
            currentChatHashes.add(hash);

            // Store sample for debugging (first occurrence only)
            // Calculate absolute index in full chat
            const absoluteIndex = chat.length - recentMessages.length + idx;
            if (!chatHashMap.has(hash)) {
                chatHashMap.set(hash, {
                    index: absoluteIndex,
                    preview: cleanedText.substring(0, 80),
                    isUser: msg.is_user,
                    name: msg.name
                });
            }
        }
    });

    console.log(`[VectHare Dedup] Built hash set with ${currentChatHashes.size} unique message hashes from recent context`);

    const toInject = [];
    const skipped = [];

    for (const chunk of chunks) {
        const sourceChatMatches = chunk.metadata?.chatUUID === getChatUUID() ||
            (getChatBinding()?.registryKey && getChatBinding().registryKey === chunk.collectionId);
        const isInChat = (sourceChatMatches && isChatChunkInRecentContext(chunk, chat.length, deduplicationDepth)) ||
            currentChatHashes.has(chunk.hash) ||
            // An occurrence-specific hash differs from the original message hash.
            // Compare complete chunk text only when its actual source dialogue is
            // already present in the recent context; never rely on its index alone.
            (sourceChatMatches && recentMessages.some(msg =>
                String(chunk.text || '').trim() === substituteParams(getTextWithoutAttachments(msg))));

        if (isInChat) {
            const matchedMsg = chatHashMap.get(chunk.hash);
            console.debug(`[VectHare Dedup] ❌ SKIPPING chunk (hash: ${chunk.hash})`);
            console.debug(`  Chunk text: "${chunk.text?.substring(0, 80)}..."`);
            console.debug(`  Matches chat message #${matchedMsg.index} from ${matchedMsg.name}: "${matchedMsg.preview}..."`);
            console.debug(`  Score: ${chunk.score?.toFixed(4)}, Collection: ${chunk.collectionId}`);

            skipped.push(chunk);
            recordChunkFate(debugData, chunk.hash, 'injection', 'skipped',
                'Already in current chat context - no injection needed',
                { score: chunk.score }
            );
        } else {
            console.debug(`[VectHare Dedup] ✅ KEEPING chunk (hash: ${chunk.hash}, score: ${chunk.score?.toFixed(4)})`);
            console.debug(`  Text: "${chunk.text?.substring(0, 80)}..."`);

            toInject.push(chunk);
            recordChunkFate(debugData, chunk.hash, 'injection', 'passed',
                'Not in current context - will inject',
                { score: chunk.score, collectionId: chunk.collectionId }
            );
        }
    }

    addTrace(debugData, 'injection', 'Deduplication complete', {
        totalChunks: chunks.length,
        toInject: toInject.length,
        skippedDuplicates: skipped.length
    });

    console.log(`[VectHare Dedup] FINAL: ${toInject.length} will inject, ${skipped.length} skipped as duplicates`);

    return { toInject, skipped };
}

/**
 * Builds the nested prompt structure with context and XML tags at each level.
 * Groups chunks by collection and applies wrapping in this order:
 * 1. Global wrapper (outermost)
 * 2. Collection wrapper (groups chunks from same collection)
 * 3. Chunk wrapper (innermost, per-chunk)
 *
 * @param {object[]} chunks Chunks to inject
 * @param {object} settings VectHare settings
 * @returns {string} Formatted injection text
 */
function buildNestedInjectionText(chunks, settings) {
    // Group chunks by collection
    const byCollection = new Map();
    for (const chunk of chunks) {
        const collId = chunk.collectionId || 'unknown';
        if (!byCollection.has(collId)) {
            byCollection.set(collId, []);
        }
        byCollection.get(collId).push(chunk);
    }

    // Build collection blocks
    const collectionBlocks = [];

    for (const [collectionId, collChunks] of byCollection) {
        // Get collection metadata for context/xmlTag
        const collMeta = getCollectionMeta(collectionId) || {};
        const collContext = collMeta.context ? substituteParams(collMeta.context) : '';
        const collXmlTag = collMeta.xmlTag || '';

        // Build chunk texts with per-chunk wrapping
        const chunkTexts = collChunks.map(chunk => {
            const chunkMeta = getChunkMetadata(chunk.hash, scopedChunkKey(chunk, typeof settings !== 'undefined' ? settings : null)) || {};
            const chunkContext = chunkMeta.context ? substituteParams(chunkMeta.context) : '';
            const chunkXmlTag = chunkMeta.xmlTag || '';
            const text = chunk.text || '(text not available)';

            // Build chunk with optional wrapping
            let chunkBlock = '';

            if (chunkContext) {
                chunkBlock += chunkContext + '\n';
            }

            if (chunkXmlTag) {
                chunkBlock += `<${chunkXmlTag}>\n${text}\n</${chunkXmlTag}>`;
            } else {
                chunkBlock += text;
            }

            return chunkBlock;
        });

        // Join chunks within this collection
        let collectionBlock = chunkTexts.join('\n\n');

        // Apply collection-level wrapping
        if (collContext) {
            collectionBlock = collContext + '\n\n' + collectionBlock;
        }

        if (collXmlTag) {
            collectionBlock = `<${collXmlTag}>\n${collectionBlock}\n</${collXmlTag}>`;
        }

        collectionBlocks.push(collectionBlock);
    }

    // Join all collection blocks
    let fullText = collectionBlocks.join('\n\n');

    // Apply global-level wrapping
    const globalContext = settings.rag_context ? substituteParams(settings.rag_context) : '';
    const globalXmlTag = settings.rag_xml_tag || '';

    if (globalContext) {
        fullText = globalContext + '\n\n' + fullText;
    }

    if (globalXmlTag) {
        fullText = `<${globalXmlTag}>\n${fullText}\n</${globalXmlTag}>`;
    }

    return fullText;
}

/**
 * Resolves the effective injection position for a chunk using cascade:
 * chunk → collection → global
 * @param {object} chunk Chunk with collectionId
 * @param {object} settings VectHare settings
 * @returns {{position: number, depth: number}} Resolved position and depth
 */
function resolveChunkInjectionPosition(chunk, settings) {
    const chunkMeta = getChunkMetadata(chunk.hash, scopedChunkKey(chunk, typeof settings !== 'undefined' ? settings : null)) || {};
    const collMeta = getCollectionMeta(chunk.collectionId) || {};

    // Cascade: chunk → collection → global
    const position = chunkMeta.position ?? collMeta.position ?? settings.position ?? 0;
    const depth = chunkMeta.depth ?? collMeta.depth ?? settings.depth ?? 2;

    return { position, depth };
}

/**
 * Stage 8: Format and inject chunks into prompt
 * Supports per-chunk/per-collection injection positions via cascade resolution.
 * Groups chunks by their resolved position+depth and creates separate injections.
 *
 * @param {object[]} chunksToInject Chunks to inject
 * @param {object} settings VectHare settings
 * @param {object} debugData Debug tracking object
 * @returns {{verified: boolean, text: string}} Injection result
 */
function injectChunksIntoPrompt(chunksToInject, settings, debugData) {
    // Control print: Log chunks QUEUED for injection (not yet injected)
    console.log(`[VectHare Injection Control] Preparing to inject ${chunksToInject.length} chunks`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    let emptyTextCount = 0;
    chunksToInject.forEach((chunk, idx) => {
        const textLength = chunk.text?.length || 0;
        const hasValidText = textLength > 0 && chunk.text !== '(text not found)' && chunk.text !== '(text not available)';
        if (!hasValidText) emptyTextCount++;

        console.log(`  [${idx + 1}/${chunksToInject.length}] CHUNK QUEUED FOR INJECTION ${!hasValidText ? '⚠️ EMPTY/INVALID TEXT' : ''}`);
        console.log(`      Hash: ${chunk.hash}`);
        console.log(`      Score: ${chunk.score?.toFixed(4)}`);
        console.log(`      Collection: ${chunk.collectionId}`);
        console.log(`      Text length: ${textLength} chars ${!hasValidText ? '⚠️' : '✓'}`);
        console.log(`      Text preview: "${chunk.text?.substring(0, 120)}${textLength > 120 ? '...' : ''}"`);
        console.log('      ─────────────────────────────────────────────────────────────────');
    });
    if (emptyTextCount > 0) {
        console.warn(`[VectHare Injection Control] ⚠️ WARNING: ${emptyTextCount}/${chunksToInject.length} chunks have empty or placeholder text!`);
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // Group chunks by resolved injection position+depth
    const positionGroups = new Map(); // "position:depth" → chunks[]

    for (const chunk of chunksToInject) {
        const { position, depth } = resolveChunkInjectionPosition(chunk, settings);
        const key = `${position}:${depth}`;

        if (!positionGroups.has(key)) {
            positionGroups.set(key, { position, depth, chunks: [] });
        }
        positionGroups.get(key).chunks.push(chunk);
    }

    // If all chunks go to the same position, use the simple single-injection path
    if (positionGroups.size === 1) {
        const [_, group] = [...positionGroups.entries()][0];
        const insertedText = buildNestedInjectionText(group.chunks, settings);

        console.log(`[VectHare Injection Control] Single position injection: position="${group.position}", depth=${group.depth}, chunks=${group.chunks.length}, textLength=${insertedText.length}`);
        console.log(`[VectHare Injection Control] Injection text preview: "${insertedText.substring(0, 200)}${insertedText.length > 200 ? '...' : ''}"`);

        setExtensionPrompt(EXTENSION_PROMPT_TAG, insertedText, group.position, group.depth, false);

        // Verify injection
        const verifiedPrompt = extension_prompts[EXTENSION_PROMPT_TAG];
        const injectionVerified = verifiedPrompt && verifiedPrompt.value === insertedText;

        console.log(`[VectHare Injection Control] Injection verification: ${injectionVerified ? '✓ PASSED' : '✗ FAILED'}`);
        console.log(`[VectHare Injection Control] extension_prompts[${EXTENSION_PROMPT_TAG}]:`, {
            exists: !!verifiedPrompt,
            valueLength: verifiedPrompt?.value?.length,
            position: verifiedPrompt?.position,
            depth: verifiedPrompt?.depth,
            valuePreview: verifiedPrompt?.value?.substring(0, 100)
        });

        if (!injectionVerified) {
            console.warn('VectHare: ⚠️ Injection verification failed!', {
                expected: insertedText.substring(0, 100) + '...',
                actual: verifiedPrompt?.value?.substring(0, 100) + '...',
                promptExists: !!verifiedPrompt
            });
        }

        // Record final fate for injected chunks
        group.chunks.forEach(chunk => {
            recordChunkFate(debugData, chunk.hash, 'final', 'injected', null, {
                score: chunk.score,
                collectionId: chunk.collectionId
            });
        });

        return { verified: injectionVerified, text: insertedText };
    }

    // Multiple injection positions - create separate extension prompts for each
    console.log(`[VectHare Injection Control] Multiple position injection: ${positionGroups.size} different positions`);

    // Clear the main tag first (will be unused when multi-position)
    setExtensionPrompt(EXTENSION_PROMPT_TAG, '', settings.position, settings.depth, false);

    let allVerified = true;
    const allTexts = [];
    let groupIndex = 0;

    for (const [key, group] of positionGroups) {
        // Build text for this position group (no global wrapper - that goes on outermost only)
        const groupSettings = { ...settings, rag_context: '', rag_xml_tag: '' };
        const groupText = buildNestedInjectionText(group.chunks, groupSettings);

        console.log(`[VectHare Injection Control] Position group ${groupIndex + 1}/${positionGroups.size}: key="${key}", chunks=${group.chunks.length}, textLength=${groupText.length}`);
        group.chunks.forEach((chunk, idx) => {
            console.log(`    [${idx + 1}/${group.chunks.length}] Hash: ${chunk.hash}, Score: ${chunk.score?.toFixed(4)}`);
        });

        // Use unique tag per position group
        const tag = `${EXTENSION_PROMPT_TAG}_pos${groupIndex}`;

        setExtensionPrompt(tag, groupText, group.position, group.depth, false);

        // Verify
        const verifiedPrompt = extension_prompts[tag];
        const verified = verifiedPrompt && verifiedPrompt.value === groupText;

        console.log(`[VectHare Injection Control] Position group ${groupIndex + 1} verification: ${verified ? '✓ PASSED' : '✗ FAILED'}`);

        if (!verified) {
            console.warn(`VectHare: ⚠️ Injection verification failed for position ${key}`, {
                tag,
                expected: groupText.substring(0, 100) + '...',
                actual: verifiedPrompt?.value?.substring(0, 100) + '...'
            });
            allVerified = false;
        }

        // Record fates
        group.chunks.forEach(chunk => {
            recordChunkFate(debugData, chunk.hash, 'final', 'injected', null, {
                score: chunk.score,
                collectionId: chunk.collectionId,
                position: group.position,
                depth: group.depth
            });
        });

        allTexts.push(groupText);
        groupIndex++;
    }

    console.log(`[VectHare Injection Control] Injection complete: ${allVerified ? '✓ All verified' : '✗ Some failed'}, ${allTexts.length} groups`);

    return {
        verified: allVerified,
        text: allTexts.join('\n\n---\n\n') // Combine for debug output
    };
}

// ============================================================================
// MAIN ORCHESTRATOR
// ============================================================================

/**
 * Searches for and injects relevant past messages from ALL enabled collections
 * This includes chat collections (if enabled_chats is true) AND any other
 * enabled collections like lorebooks, documents, character files, etc.
 *
 * @param {object[]} chat Current chat messages
 * @param {object} settings VectHare settings
 * @param {string} type Generation type
 */
export async function rearrangeChat(chat, settings, type) {
    console.log(`🐰 VectHare: rearrangeChat called (type: ${type}, chat length: ${chat?.length || 0})`);

    try {
        // Clear ALL prompts produced by an earlier generation, including quiet
        // generations; fixed bounds of 10 leave stale tags behind.
        const oldTags = Object.keys(extension_prompts || {}).filter(tag =>
            tag === EXTENSION_PROMPT_TAG || tag.startsWith(`${EXTENSION_PROMPT_TAG}_pos`));
        for (const tag of oldTags) setExtensionPrompt(tag, '', 0, 0, false);
        // === EARLY EXITS ===
        if (type === 'quiet') {
            console.debug('VectHare: Skipping quiet prompt');
            return;
        }

        // Clear extension prompts (main + any position-specific tags from previous run)
        setExtensionPrompt(EXTENSION_PROMPT_TAG, '', settings.position, settings.depth, false);
        // All known position tags were cleared above; keep no arbitrary cap.

        if (!getCurrentChatId() || !Array.isArray(chat)) {
            console.debug('VectHare: No chat selected');
            return;
        }

        const minChatLength = settings.min_chat_length ?? 0;
        if (minChatLength > 0 && chat.length < minChatLength) {
            console.warn(`⚠️ VectHare: Not enough messages to inject chunks (${chat.length} < ${minChatLength})`);
            console.log(`   💡 You need at least ${minChatLength} messages before chunk injection starts`);
            return;
        }

        // === STAGE 1: Gather collections to query ===
        const collectionsToQuery = gatherCollectionsToQuery(settings);
        // Allow continuing with WI-only mode if enabled_world_info is set
        const hasCollections = collectionsToQuery.length > 0;
        const canQueryWI = settings.enabled_world_info;

        if (!hasCollections && !canQueryWI) {
            console.warn('⚠️ VectHare: No enabled collections to query and World Info disabled - chunks cannot be injected!');
            console.log('   💡 Make sure you have enabled at least one collection in VectHare settings, or enable World Info');
            return;
        }
        if (hasCollections) {
            console.log(`VectHare: Will query ${collectionsToQuery.length} collections:`, collectionsToQuery);
        } else {
            console.log('VectHare: No regular collections enabled, but World Info is enabled - will query lorebooks only');
        }

        // === STAGE 2: Build search query ===
        const queryText = buildSearchQuery(chat, settings);
        if (queryText.length === 0) {
            console.debug('VectHare: No text to query');
            return;
        }

        // === STAGE 2.5: Extract keywords from query message ===
        const extractionLevel = settings.keyword_extraction_level || 'balanced';
        const queryKeywords = extractChatKeywords(queryText, {
            level: extractionLevel,
            baseWeight: settings.keyword_boost_base_weight || 1.5
        });
        const queryKeywordTexts = queryKeywords.map(kw => kw.text.toLowerCase());
        console.log(`VectHare: Extracted ${queryKeywords.length} keywords from query:`, queryKeywordTexts);

        // === STAGE 3: Filter by activation conditions ===
        let activeCollections = [];
        const collectionDecisions = [];
        if (hasCollections) {
            const searchContext = buildSearchContext(chat, settings.query || 10, [], {
                generationType: type || 'normal',
                isGroupChat: getContext().groupId != null,
                currentCharacter: getContext().name2 || null,
                activeLorebookEntries: [],
                currentChatId: getCurrentChatId(),
                currentCharacterId: getContext().characterId || null,
                collectionDecisions
            });
            searchContext.collectionDecisions = collectionDecisions;
            activeCollections = await filterActiveCollections(collectionsToQuery, searchContext);
        }

        // Allow WI-only mode even if no regular collections pass filters
        if (activeCollections.length === 0 && !canQueryWI) {
            console.log('⚠️ VectHare: No collections passed activation conditions and World Info disabled - chunks cannot be injected!');
            console.log('   💡 Check your collection activation conditions in VectHare settings');
            return;
        }
        if (activeCollections.length > 0) {
            console.log(`✅ VectHare: ${activeCollections.length} collections passed activation filters:`, activeCollections);
        }

        // === INITIALIZE DEBUG DATA ===
        const debugData = createDebugData();
        debugData.query = queryText;
        debugData.queryKeywords = queryKeywordTexts;
        debugData.collectionId = activeCollections.length > 0 ? activeCollections.join(', ') : 'world_info_only';
        debugData.collectionsQueried = activeCollections;
        debugData.collectionDecisions = collectionDecisions;
        const effectiveTopK = settings.top_k ?? settings.insert;
        debugData.settings = {
            threshold: settings.score_threshold,
            topK: effectiveTopK,
            temporal_decay: settings.temporal_decay,
            protect: settings.protect,
            chatLength: chat.length
        };

        addTrace(debugData, 'init', 'Pipeline started', {
            collectionsQueried: activeCollections,
            queryLength: queryText.length,
            threshold: settings.score_threshold,
            topK: effectiveTopK,
            protect: settings.protect
        });

        // Refill only when at least one collection produced a full page. Apply
        // ALL eligibility stages afresh at the larger limit, never allow a
        // failed backend request to masquerade as an exhausted collection.
        const finalTopK=Math.max(0, Number(settings.top_k ?? settings.insert ?? 5));
        // This is a retrieval-work safety budget, NOT the embedding model's
        // context window. Search until K eligible memories survive or all
        // backend candidates are exhausted. We expose budget exhaustion.
        const maxCandidateLimit=getCandidateBudget(finalTopK);
        let candidateLimit=Math.min(maxCandidateLimit,Math.max(32,finalTopK*4));
        const pageCache=new Map();
        let chunksToInject=[];
        let skippedDuplicates=[];
        for (let refillRound=0;refillRound<24;refillRound++) {
        // === STAGE 4: Query all collections and merge results ===
        let chunks = await queryAndMergeCollections(activeCollections, queryText, settings, chat, debugData, candidateLimit, pageCache);

        const canRefill = chunks.mayHaveMore;
        // === STAGE 4.1: Filter disabled chunks ===
        const beforeDisabledFilter = chunks.length;
        chunks = chunks.filter(chunk => {
            const meta = getChunkMetadata(chunk.hash, scopedChunkKey(chunk, typeof settings !== 'undefined' ? settings : null));
            if (meta?.disabled === true || meta?.enabled === false) {
                recordChunkFate(debugData, chunk.hash, 'disabled_filter', 'dropped',
                                'Chunk is disabled', { hash: chunk.hash });
                return false;
            }
            return true;
        });
        if (chunks.length !== beforeDisabledFilter) {
            console.log(`VectHare: Disabled filter: ${beforeDisabledFilter} → ${chunks.length} chunks (${beforeDisabledFilter - chunks.length} disabled chunks removed)`);
            addTrace(debugData, 'disabled_filter', 'Disabled chunks removed', {
                before: beforeDisabledFilter,
                after: chunks.length,
                removed: beforeDisabledFilter - chunks.length
            });
        }

        // === STAGE 4.3: Boost chunks with matching query keywords ===
        if (chunks.length > 0) {
            let keywordMatchCount = 0;
            // FIX: Match chunk keywords against BOTH auto-extracted query keywords AND
            // the full raw query text. The extraction cap (e.g. balanced = max 8 keywords)
            // previously silently dropped names beyond the cap, preventing their boost.
            const queryLower = queryText.toLowerCase();

            for (const chunk of chunks) {
                // Get chunk keywords from metadata
                const chunkKeywords = (chunk.metadata?.keywords || [])
                .map(kw => (typeof kw === 'object' ? kw.text : kw)?.toLowerCase())
                .filter(Boolean);

                // Check chunk keywords against extracted list OR raw query text
                // Word-boundary match to avoid partial hits (e.g. "mel" inside "melody")
                const matchedKeywords = chunkKeywords.filter(ck => {
                    if (queryKeywordTexts.includes(ck)) return true;
                    const escaped = ck.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    return new RegExp(`(?<![\\w])${escaped}(?![\\w])`, 'i').test(queryLower);
                });

                if (matchedKeywords.length > 0) {
                    // Chunk matches query keywords - boost to perfect hit
                    const oldScore = chunk.score;
                    chunk.keywordMatched = true;
                    chunk.matchedQueryKeywords = matchedKeywords;
                    chunk.score = 1.0; // 100% perfect match
                    chunk.originalScore = oldScore;
                    keywordMatchCount++;

                    addTrace(debugData, 'keyword_boost', `Chunk boosted by ${matchedKeywords.length} keyword(s)`, {
                        hash: chunk.hash,
                        matchedKeywords,
                        newScore: 1.0,
                        oldScore
                    });
                }
            }

            if (keywordMatchCount > 0) {
                console.log(`VectHare: Boosted ${keywordMatchCount}/${chunks.length} chunks with matching keywords to 100% score`);
                debugData.stages.afterKeywordBoost = [...chunks];
                debugData.stats.keywordBoosted = keywordMatchCount;
                addTrace(debugData, 'keyword_boost', `Boosted ${keywordMatchCount} chunks with keyword matches`, {
                    totalChunks: chunks.length,
                    boostedCount: keywordMatchCount
                });
            } else {
                console.log(`VectHare: No chunks matched query keywords, all ${chunks.length} chunks keep original scores`);
            }
        }

        // === WORLD INFO: Semantic WI entries ===
        try {
            if (settings.enabled_world_info) {
                // Build recentMessages array for WI query
                const recentMessages = chat
                    .filter(x => !x.is_system)
                    .reverse()
                    .slice(0, settings.world_info_query_depth || settings.query)
                    .map(x => substituteParams(x.mes));

                const wiEntries = await getSemanticWorldInfoEntries(recentMessages, [], settings);
                if (Array.isArray(wiEntries) && wiEntries.length > 0) {
                    addTrace(debugData, 'world_info', `Found ${wiEntries.length} semantic WI entries`, { entries: wiEntries.map(e => ({ uid: e.uid, score: e.score })) });

                    // Convert WI entries into chunk-like objects and merge
                    const wiChunks = wiEntries.map(e => {
                        const hash = String(e.uid || getStringHash(e.content || e.key || ''));
                        return {
                            hash,
                            metadata: e.metadata || {},
                            score: e.score ?? 0,
                            originalScore: e.score ?? 0,
                            similarity: e.score ?? 0,
                            text: e.content || (Array.isArray(e.key) ? e.key.join(' ') : e.key || ''),
                            index: 0,
                            collectionId: e.collectionId || `vecthare_wi:${e.lorebookName || 'lorebook'}`,
                            decayApplied: false
                        };
                    });

                    // Prepend WI chunks so they get considered equally in downstream stages
                    chunks = wiChunks.concat(chunks);
                    debugData.stages.worldInfo = wiChunks;
                }
            }
        } catch (wiError) {
            console.warn('VectHare: WorldInfo semantic integration failed', wiError.message);
            addTrace(debugData, 'world_info', 'WorldInfo query failed', { error: wiError.message });
        }
        console.log(`VectHare: Retrieved ${chunks.length} total chunks from ${activeCollections.length} collections`);

        debugData.stages.initial = [...chunks];
        debugData.stats.retrievedFromVector = chunks.length;

        // === STAGE 4.5: Expand summary chunks to parent chunks (dual-vector) ===
        const chunksBeforeExpansion = chunks.length;
        chunks = await expandSummaryChunks(chunks, activeCollections, settings, debugData);
        if (chunks.length !== chunksBeforeExpansion || chunks.some(c => c.expandedFromSummary)) {
            const expandedCount = chunks.filter(c => c.expandedFromSummary).length;
            console.log(`VectHare: Expanded ${expandedCount} summary chunks to parent text`);
            debugData.stages.afterSummaryExpansion = [...chunks];
            debugData.stats.summariesExpanded = expandedCount;
        }

        // === STAGE 5: BananaBread reranking (optional) ===
        if (settings.source === 'bananabread' && settings.bananabread_rerank && chunks.length > 0) {
            addTrace(debugData, 'rerank', 'Starting BananaBread reranking', {
                chunks: chunks.length,
                query: queryText.substring(0, 100)
            });
            chunks = await rerankWithBananaBread(queryText, chunks, settings);
            debugData.stages.afterRerank = [...chunks];
            addTrace(debugData, 'rerank', 'Reranking complete', { rerankedCount: chunks.length });
        }

        // === STAGE 6: Threshold filter ===
        const threshold = settings.score_threshold || 0;
        chunks = applyThresholdFilter(chunks, threshold, debugData);
        debugData.stages.afterThreshold = [...chunks];

        // === STAGE 7: Temporal decay ===
        chunks = applyTemporalDecayStage(chunks, chat, settings, threshold, debugData);
        debugData.stages.afterDecay = [...chunks];
        debugData.stats.afterDecay = chunks.length;

        // === STAGE 8: Chunk conditions ===
        chunks = await applyConditionsStage(chunks, chat, settings, debugData);
        debugData.stages.afterConditions = [...chunks];
        debugData.stats.afterConditions = chunks.length;

        // === STAGE 8.5: Chunk Groups and Links ===
        chunks = await applyGroupsAndLinksStage(chunks, activeCollections, settings, debugData);
        debugData.stages.afterGroups = [...chunks];
        debugData.stats.afterGroups = chunks.length;

        // Store for legacy visualizer
        window.VectHare_LastSearch = {
            chunks: chunks,
            query: queryText,
            timestamp: Date.now(),
            settings: { threshold: settings.score_threshold, topK: (settings.top_k ?? settings.insert), temporal_decay: settings.temporal_decay }
        };
        console.log(`VectHare: Stored ${chunks.length} chunks for visualizer`);

        // Never reinject chunks overlapping the newest protected chat messages.
        const protectedCount = Math.max(0, Number(settings.protect) || 0);
        if (protectedCount) {
            const bindingKey = getChatBinding()?.registryKey;
            chunks = chunks.filter(chunk => {
                if (chunk.collectionId !== bindingKey && chunk.metadata?.chatUUID !== getChatUUID()) return true;
                return !isChatChunkInRecentContext(chunk, chat.length, protectedCount);
            });
        }

        // === STAGE 9: Deduplicate ===
        console.log(`[VectHare Deduplication] Starting with ${chunks.length} chunks before deduplication`);
        console.log(`[VectHare Deduplication] Current chat has ${chat.length} messages`);

        const { toInject: eligibleChunks, skipped: skipped } = deduplicateChunks(chunks, chat, settings, debugData);
        skippedDuplicates = skipped;
        chunksToInject = rankEligibleChunks(eligibleChunks, getChatCollectionPolicy(getCurrentChatId()),
            Math.max(0, Number(settings.top_k ?? settings.insert ?? 5)));

        const nextLimit=nextCandidateLimit({eligible:chunksToInject.length,target:finalTopK,
            requested:candidateLimit,mayHaveMore:canRefill,maxLimit:maxCandidateLimit});
        if (nextLimit !== null) {
            const previousLimit=candidateLimit;
            candidateLimit=nextLimit;
            addTrace(debugData,'vector_search',`Refilling candidates after eligibility filtering`,{
                eligible:chunksToInject.length,target:finalTopK,previousLimit,nextLimit:candidateLimit
            });
            continue;
        }
        debugData.candidateRefill={rounds:refillRound+1,finalLimit:candidateLimit,
            exhausted:!canRefill,capReached:canRefill&&candidateLimit>=maxCandidateLimit,
            requested:finalTopK,eligible:chunksToInject.length,
            incomplete:canRefill&&candidateLimit>=maxCandidateLimit&&chunksToInject.length<finalTopK};
        if (debugData.candidateRefill.incomplete) {
            const warning=`Only ${chunksToInject.length}/${finalTopK} eligible memories found before the ${candidateLimit}-candidate safety budget. Retrieval is incomplete, not empty.`;
            console.warn('[VectHare]',warning);
            if(typeof toastr !== 'undefined')toastr.warning(warning,'VectHare',{timeOut:10000});
        }
        break;
        }
        console.log(`[VectHare Deduplication] After deduplication: ${chunksToInject.length} to inject, ${skippedDuplicates.length} skipped`);
        if (skippedDuplicates.length > 0) {
            console.log(`[VectHare Deduplication] Skipped chunks (already in chat):`);
            skippedDuplicates.forEach((chunk, idx) => {
                console.log(`  [${idx + 1}] Hash: ${chunk.hash}, Score: ${chunk.score?.toFixed(4)}, Text: "${chunk.text?.substring(0, 80)}..."`);
            });
        }

        if (chunksToInject.length === 0) {
            console.log('ℹ️ VectHare: All retrieved chunks already in context, nothing to inject');
            console.log(`   ${skippedDuplicates.length} chunks were skipped (already in current chat)`);
            console.info('[VectHare] Injection blocked: All retrieved chunks are already present in the current chat context. Adjust temporal decay or query depth if you want older messages.');
            debugData.stages.injected = [];
            debugData.stats.actuallyInjected = 0;
            debugData.stats.skippedDuplicates = skippedDuplicates.length;
            addTrace(debugData, 'injection', 'PIPELINE COMPLETE - NO INJECTION NEEDED', {
                reason: 'All chunks already in current context',
                skippedCount: skippedDuplicates.length
            });
            setLastSearchDebug(debugData);
            return;
        }

        console.log(`[VectHare Deduplication] ✅ ${chunksToInject.length} chunks will proceed to injection`);

        // === P2 #57: one memory-count and generation-token budget shared by
        // all collections, positions and Semantic World Info results.
        const countSetting = Number(settings.memory_max_injections ?? 0);
        const tokenSetting = Number(settings.memory_token_budget ?? 0);
        if (countSetting > 0 || tokenSetting > 0) {
            try {
                let countFn;
                if (tokenSetting > 0) {
                    // SillyTavern's generation tokenizer (NOT embedding tokenizer).
                    // An absent/unusable exact counter fails closed: no false
                    // hard-budget guarantee based on characters or heuristics.
                    const tokenizerModule = await import('../../../../tokenizers.js');
                    if(typeof tokenizerModule.getTokenCountAsync !== 'function')
                        throw new Error('SillyTavern generation tokenizer API is unavailable');
                    countFn = async str => countConservativeGenerationTokens(str,
                        value=>tokenizerModule.getTokenCountAsync(value));
                }
                const result = await chooseMemoryInjections(chunksToInject, {
                    maxMemories:countSetting, maxTokens:tokenSetting,
                    renderGroups: items => {
                        const groups=new Map();
                        for (const item of items) {
                            const {position,depth}=resolveChunkInjectionPosition(item,settings);
                            const key=`${position}:${depth}`;
                            if(!groups.has(key))groups.set(key,[]);
                            groups.get(key).push(item);
                        }
                        const multi=groups.size>1;
                        return [...groups.values()].map(group => buildNestedInjectionText(group,
                            multi ? {...settings,rag_context:'',rag_xml_tag:''} : settings));
                    },
                    countTokens:countFn
                });
                chunksToInject=result.selected;
                debugData.injectionBudget={maxMemories:countSetting,maxTokens:tokenSetting,
                    usedTokens:result.usedTokens,skipped:result.skipped,
                    tokenCountSource:tokenSetting>0?'max(SillyTavern generation count, UTF-8 byte safeguard)':'disabled',
                    exactModelTokenCountUnverified:tokenSetting>0,
                    conservativeByteSafeguard:tokenSetting>0};
            } catch (error) {
                chunksToInject=[];
                debugData.injectionBudget={error:String(error.message),blocked:true};
                console.error('VectHare: memory token budget could not be guaranteed; no memories injected:',error);
                toastr.warning('Memory injection blocked: the generation tokenizer could not verify your token budget.',
                    'VectHare Token Budget');
            }
            if (!chunksToInject.length) {
                setLastSearchDebug(debugData);
                return;
            }
        }
        // === STAGE 10: Inject into prompt ===
        const injection = injectChunksIntoPrompt(chunksToInject, settings, debugData);
        if (!injection.verified) {
            // Do not leave partial multi-position prompts when ST refused to
            // acknowledge even one tag. Count/position budgets are only valid
            // for the exact prompt text actually committed.
            const tags=Object.keys(extension_prompts || {}).filter(tag =>
                tag===EXTENSION_PROMPT_TAG || tag.startsWith(`${EXTENSION_PROMPT_TAG}_pos`));
            for(const tag of tags)setExtensionPrompt(tag,'',0,0,false);
            throw new Error('Memory prompt injection could not be verified; cleared all VectHare tags');
        }

        console.log(`\n✅ VectHare: Successfully injected ${chunksToInject.length} chunk(s) into prompt`);
        console.log(`   Verification: ${injection.verified ? '✓ PASSED' : '✗ FAILED'}`);
        console.log(`   Total characters injected: ${injection.text.length}\n`);

        // Finalize debug data
        debugData.stages.injected = chunksToInject;
        debugData.stats.actuallyInjected = chunksToInject.length;
        debugData.stats.skippedDuplicates = skippedDuplicates.length;
        debugData.injection = {
            verified: injection.verified,
            text: injection.text,
            position: settings.position,
            depth: settings.depth,
            promptTag: EXTENSION_PROMPT_TAG,
            charCount: injection.text.length
        };

        addTrace(debugData, 'final', 'PIPELINE COMPLETE - SUCCESS', {
            injectedCount: chunksToInject.length,
            skippedDuplicates: skippedDuplicates.length,
            injectedHashes: chunksToInject.map(c => c.hash),
            totalTokens: injection.text.length,
            position: settings.position,
            depth: settings.depth,
            verified: injection.verified
        });

        setLastSearchDebug(debugData);
        console.log(`VectHare: ✅ Injected ${chunksToInject.length} chunks (${skippedDuplicates.length} skipped - already in context)`);

    } catch (error) {
        toastr.error(`Generation interceptor aborted: ${error.message}`, 'VectHare');
        console.error('VectHare: Failed to rearrange chat', error);
    }
}

/**
 * Vectorizes entire chat
 * @param {object} settings VectHare settings
 * @param {number} batchSize Batch size
 */
export async function vectorizeAll(settings, batchSize) {
    if(manualSyncActive || hasActiveVectorWrite()){toastr.info('Sync Chat is already running. Use Live Status to control it.','VectHare');return;}
    manualSyncActive=true;
    let control=null, shared=null, sharedOutcome='failed';
    try {
        // Manual Sync is intentionally independent of Auto-Sync.

        const chatId = getCurrentChatId();
        const originalChatUUID=getChatUUID();
        if (!chatId) {
            toastr.info('No chat selected', 'Vectorization aborted');
            return;
        }

        // Pre-flight check: verify backend is available before starting
        const binding=getChatBinding();
        const resumeSettings=binding ? settingsForSavedCollection(binding.registryKey,settings) : settings;
        const backendName = resumeSettings.vector_backend || 'standard';
        const backendAvailable = await isBackendAvailable(backendName, resumeSettings);
        if (!backendAvailable) {
            toastr.error(
                `Backend "${backendName}" is not available. Check your settings or start the backend service.`,
                'Vectorization aborted'
            );
            console.error(`VectHare: Backend ${backendName} failed health check before vectorization`);
            return;
        }

        // Calculate total messages to vectorize
        const context = getContext();
        const totalMessages = context.chat ? context.chat.filter(x => !x.is_system).length : 0;

        // Show progress panel
        progressTracker.show('Vectorizing Chat', totalMessages, 'Messages');
        control=createOperationControl(progressTracker.activityId,{pausable:true,stoppable:true,writeOperation:true});
        shared=await acquireSharedOperation('Vectorizing Chat',{activityId:progressTracker.activityId,category:'chat-write',resourceKey:getChatUUID()||''});
        control.bindSharedOperation(shared);
        if(getCurrentChatId()!==chatId || getChatUUID()!==originalChatUUID)
            throw new Error('Chat or branch changed while waiting in the backend queue; vectorisation cancelled safely');
        progressTracker.registerRetry(async()=>{
            if(originalChatUUID!==getChatUUID())throw new Error('Open the original chat before retrying its vectorisation');
            await vectorizeAll(settings,batchSize);
        });

        let finished = false;
        let iteration = 0;
        let processedCount = 0;
        let totalChunks = 0;

        while (!finished) {
            if (is_send_press) {
                toastr.info('Message generation is in progress.', 'Vectorization aborted');
                progressTracker.complete(false, 'Aborted - message generation in progress');
                throw new Error('Message generation in progress');
            }

            await control.checkpoint();
            if(getCurrentChatId()!==chatId || getChatUUID()!==originalChatUUID)
                throw new Error('Chat or branch changed before synchronization; no further writes allowed');
            const result = await synchronizeChat(settings, batchSize, {manual:true,control,
                onProgress:({completed,total,detail})=>progressTracker.updateVerifiedChunks(completed,total,detail)});

            // Handle disabled/blocked state
            if (result.remaining === -1) {
                console.log('VectHare: Vectorization blocked or disabled');
                progressTracker.complete(false, 'Blocked or disabled');
                return;
            }

            if(result.itemsFailed)throw new Error(`${result.itemsFailed} chunks failed`);
            if(result.remaining > 0 && result.chunksCreated === 0)throw new Error('No progress during vectorization');
            finished = result.remaining <= 0;
            iteration++;

            // Update progress with actual counts
            processedCount += result.messagesProcessed;
            totalChunks += result.chunksCreated;

            progressTracker.updateVerifiedChunks(result.verified??processedCount,result.total??totalMessages,
                result.remaining>0?`Checking ${result.remaining} remaining chunks`:'All current chunks verified');
            progressTracker.updateChunks(result.total??totalChunks);

            console.log(`VectHare: Vectorization iteration ${iteration}, ${result.remaining > 0 ? result.remaining + ' remaining' : 'complete'} (${result.chunksCreated} chunks this batch)`);

            if (chatId !== getCurrentChatId()) {
                progressTracker.complete(false, 'Chat changed during vectorization');
                throw new Error('Chat changed');
            }
        }

        sharedOutcome='completed';
        progressTracker.complete(true, `Verified and synchronized ${processedCount} missing chunks`);
        toastr.success('Chat vectorized successfully', 'VectHare');
        console.log(`VectHare: ✅ Vectorization complete after ${iteration} iterations`);
    } catch (error) {
        console.error('VectHare: Failed to vectorize all', error);
        progressTracker.addError(error.message);
        sharedOutcome=error instanceof OperationStoppedError || error instanceof SharedOperationStoppedError?'stopped':'failed';
        progressTracker.complete((error instanceof OperationStoppedError || error instanceof SharedOperationStoppedError)?'stopped':false, (error instanceof OperationStoppedError || error instanceof SharedOperationStoppedError)?'Stopped safely; completed chunks retained':'Vectorization failed');
        if(!(error instanceof OperationStoppedError || error instanceof SharedOperationStoppedError))toastr.error(`Vectorization failed: ${error.message}`, 'VectHare');
    }finally{
        if(shared)try{await finishSharedOperation(shared,sharedOutcome);}catch(e){console.error('VectHare: shared job finalization failed; recovery required',e);}
        if(control)detachOperationControl(control.activityId);
        manualSyncActive=false;
    }
}

/**
 * Purges vector index for current chat
 * @param {object} settings VectHare settings
 */
export async function purgeChatIndex(settings) {
    if (!getCurrentChatId()) {
        toastr.info('No chat selected', 'Purge aborted');
        return;
    }

    const binding = getChatBinding();
    if (!binding) {
        toastr.error('No connected writable collection', 'Purge aborted');
        return;
    }

    let collectionId;
    try { collectionId = resolveChatWriteTarget(settings).collectionId; }
    catch (error) { toastr.error(error.message, 'Purge aborted'); return; }
    if (await purgeVectorIndex(collectionId, settings)) {
        toastr.success('Vector index purged', 'VectHare');
        console.log('VectHare: Index purged successfully');
    } else {
        toastr.error('Failed to purge vector index', 'VectHare');
    }
}
