/**
 * ============================================================================
 * VECTHARE WORLD INFO INTEGRATION
 * ============================================================================
 * Enhanced integration between vectorized lorebooks and ST's world info system
 * Provides semantic activation of WI entries based on vector similarity
 *
 * @author VectHare Team
 * @version 1.0.0
 * ============================================================================
 */

import { extension_settings, getContext } from '../../../../extensions.js';
import { queryCollection } from './core-vector-api.js';
import {
    getCollectionMeta,
    isCollectionEnabled,
    shouldCollectionActivate,
    applyChatCollectionPolicy,
    isLorebookCollection,
} from './collection-metadata.js';
import { parseRegistryKey } from './collection-ids.js';
import { setExtensionPrompt, getCurrentChatId, eventSource, event_types } from '../../../../../script.js';
import { getChatUUID } from './collection-ids.js';
import { EXTENSION_PROMPT_TAG } from './constants.js';
import { buildSearchContext } from './conditional-activation.js';

// SillyTavern 1.19 WORLDINFO_SCAN_DONE includes the authoritative activated
// Map after each recursion pass. Only a finished scan for the *same chat* is
// usable; a stale snapshot could suppress or duplicate lorebook injections.
let finalHostActiveEntries = null;
let hostWorldInfoHooksInstalled = false;
export function captureHostWorldInfoScan(args) {
    if (args?.state?.next !== 0 || !(args?.activated?.entries instanceof Map)) return;
    finalHostActiveEntries = {
        chatFile: getCurrentChatId(), chatUUID: getChatUUID(), at: Date.now(),
        entries: Array.from(args.activated.entries.values()),
    };
}
function takeHostActiveWorldInfo() {
    const data = finalHostActiveEntries;
    finalHostActiveEntries = null; // A generation can consume the scan only once.
    if (!data || Date.now() - data.at > 15000 ||
        data.chatFile !== getCurrentChatId() || data.chatUUID !== getChatUUID()) return null;
    return data.entries;
}

// ============================================================================
// WORLD INFO ACTIVATION HOOKS
// ============================================================================

/**
 * Get vectorized lorebook entries that should be activated based on semantic similarity
 * This function is called by ST's world info system to get additional entries to activate
 *
 * @param {string[]} recentMessages - Recent chat messages to use as query
 * @param {object[]} activeEntries - Currently active WI entries (from keyword matching)
 * @param {object} settings - VectHare settings
 * @returns {Promise<object[]>} Array of WI entries to activate { uid, key, content, score }
 */
export async function getSemanticWorldInfoEntries(recentMessages, activeEntries, settings) {
    if (!settings.enabled_world_info) {
        return [];
    }

    // Duplicate-suppression is only sound when ST supplies the actual
    // keyword-activated entries. An empty placeholder array is NOT proof
    // that no keyword World Info is active.
    const contextForActive=getContext();
    const verifiedActive = Array.isArray(contextForActive?.worldInfoEntries)
        ? contextForActive.worldInfoEntries
        : Array.isArray(contextForActive?.worldInfo?.activeEntries)
            ? contextForActive.worldInfo.activeEntries
            : takeHostActiveWorldInfo();
    if (!settings.world_info_enabled_for_all && !verifiedActive) {
        console.warn('VectHare: semantic WI suppressed: ST keyword-active entries unavailable; enable "for all" to permit duplicates explicitly.');
        return [];
    }
    activeEntries = verifiedActive ?? activeEntries ?? [];
    // Build search query from recent messages
    const query = recentMessages.slice(-(settings.world_info_query_depth ?? 3)).join('\n');
    if (!query.trim()) {
        return [];
    }

    console.log(`VectHare: Querying vectorized lorebooks for semantic WI activation...`);

    const semanticEntries = [];
    // Lower threshold for hybrid search since RRF fusion produces lower absolute scores
    const baseThreshold = settings.world_info_threshold ?? 0.3;
    const threshold = settings.hybrid_search_enabled ? baseThreshold * 0.8 : baseThreshold;
    const topK = settings.world_info_top_k ?? 3;

    // Build search context for activation filter evaluation
    const context = getContext();
    const searchContext = buildSearchContext(
        context.chat || [],
        settings.query || 10,
        recentMessages,
        {
            generationType: 'normal',
            isGroupChat: context.groupId != null,
            currentCharacter: context.name2 || null,
            activeLorebookEntries: activeEntries.map(e => e.key || e.uid),
            currentChatId: getCurrentChatId(),
            currentCharacterId: context.characterId || null
        }
    );

    // Get all enabled lorebook collections that pass activation filters
    const lorebookCollections = await getEnabledLorebookCollections(settings, searchContext);

    for (const collection of lorebookCollections) {
        try {
            // collection.id may be a registry key like 'backend:source:collectionId'
            // Parse it to extract the actual collectionId used by backends
            const parsed = parseRegistryKey(collection.id || collection.registryKey || '');
            const rawCollectionId = parsed.collectionId || collection.id;

            // Pass the qualified registry key: its backend, provider and embedding
            // profile must not be discarded when the active backend differs.
            const results = await queryCollection(collection.id, query, topK, settings);

            if (results && results.metadata) {
                for (let i = 0; i < results.metadata.length; i++) {
                    const meta = results.metadata[i];
                    const score = meta.score || 0;

                    if (score >= threshold) {
                        // Extract WI entry data from metadata
                        const entry = {
                            uid: meta.uid || meta.hash,
                            key: meta.keywords || meta.entryName || [],
                            content: meta.text || '',
                            score: score,
                            lorebookName: collection.name,
                            collectionId: collection.id,
                            registryKey: collection.id, // preserve registry key for metadata lookups
                            vectorActivated: true,
                            metadata: meta
                        };

                        semanticEntries.push(entry);
                        // Format key for display - handle arrays of strings or objects
                        const keyDisplay = Array.isArray(entry.key)
                            ? entry.key.map(k => typeof k === 'object' ? (k.text || k.keyword || JSON.stringify(k)) : k).join(', ')
                            : (entry.key || 'unknown');
                        console.log(`VectHare: Semantic WI activation: "${keyDisplay}" (score: ${score.toFixed(3)})`);
                    }
                }
            }
        } catch (error) {
            console.warn(`VectHare: Failed to query lorebook collection ${collection.id}:`, error);
        }
    }

    // Sort by score descending
    semanticEntries.sort((a, b) => b.score - a.score);

    // Deduplicate with already active entries unless the user enables all semantic entries.
    const deduplicatedEntries = settings.world_info_enabled_for_all
        ? semanticEntries
        : deduplicateWithActiveEntries(semanticEntries, activeEntries);

    // Cap the number of entries actually returned for injection.
    const maxEntries = settings.world_info_max_entries ?? 10;
    const limitedEntries = deduplicatedEntries.slice(0, maxEntries);

    console.log(`VectHare: Found ${limitedEntries.length} semantic WI entries to activate` +
        (deduplicatedEntries.length > limitedEntries.length ? ` (capped from ${deduplicatedEntries.length} by Max Entries)` : ''));
    return limitedEntries;
}

/**
 * Get all enabled lorebook collections that pass activation filters
 * @param {object} settings - VectHare settings
 * @param {object} searchContext - Search context for activation filter evaluation
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
async function getEnabledLorebookCollections(settings, searchContext) {
    const collections = [];
    const collectionRegistry = applyChatCollectionPolicy(
        settings.vecthare_collection_registry || [],
        searchContext?.currentChatId || getCurrentChatId(),
        { lorebooksOnly: true }
    );

    for (const collectionId of collectionRegistry) {
        // Check if this is a lorebook collection
        if (!isLorebookCollection(collectionId)) {
            continue;
        }

        // Check if collection is enabled
        if (!isCollectionEnabled(collectionId, settings)) {
            continue;
        }

        // Check if collection passes activation filters
        const passesActivation = await shouldCollectionActivate(collectionId, searchContext);
        if (!passesActivation) {
            console.log(`VectHare WI: Lorebook collection ${collectionId} did not pass activation filters, skipping`);
            continue;
        }

        // Get collection metadata
        const meta = getCollectionMeta(collectionId);
        const name = meta?.sourceName || collectionId;

        collections.push({ id: collectionId, name });
    }

    const exclusiveCollections = collections.filter(collection => {
        const meta = getCollectionMeta(collection.id);
        return meta?.exclusiveWhenActive === true;
    });

    if (exclusiveCollections.length > 0) {
        const exclusiveIds = new Set(exclusiveCollections.map(collection => collection.id));
        const filteredCollections = collections.filter(collection => exclusiveIds.has(collection.id));
        console.log(`VectHare WI: Exclusive lorebook collection active, suppressing ${collections.length - filteredCollections.length} other lorebook collection(s)`);
        return filteredCollections;
    }

    console.log(`VectHare WI: ${collections.length} lorebook collection(s) passed activation filters`);
    return collections;
}

/**
 * Deduplicate semantic entries with already active entries
 * @param {object[]} semanticEntries - Entries from vector search
 * @param {object[]} activeEntries - Already active entries from keyword matching
 * @returns {object[]} Deduplicated entries
 */
export function deduplicateWithActiveEntries(semanticEntries, activeEntries) {
    // Host World Info identifiers can be numbers; vector metadata often uses
    // strings. Compare normalised, nonempty identities and canonical content.
    const uid = e => e?.uid ?? e?.id ?? e?.entryId ?? null;
    const text = e => typeof e?.content === 'string'
        ? e.content.replace(/\s+/g,' ').trim().toLowerCase() : '';
    const activeUids = new Set(activeEntries.map(uid).filter(x=>x!=null).map(String));
    const activeContents = new Set(activeEntries.map(text).filter(Boolean));
    return semanticEntries.filter(entry => {
        const id=uid(entry);
        if(id != null && activeUids.has(String(id)))return false;
        const content=text(entry);
        return !content || !activeContents.has(content);
    });
}

// ============================================================================
// LOREBOOK VECTORIZATION HELPERS
// ============================================================================

/**
 * Check if a lorebook is already vectorized
 * @param {string} lorebookName - Name of the lorebook
 * @param {object} settings - VectHare settings
 * @returns {boolean}
 */
function matchingLorebookKeys(lorebookName, settings) {
    const registry = settings?.vecthare_collection_registry || [];
    const name = String(lorebookName).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0,50);
    return registry.filter(key => {
        if(!isLorebookCollection(key))return false;
        const meta=getCollectionMeta(key);
        // The original source name is authoritative when available. A
        // generated name fragment alone can collide after punctuation or
        // truncation, or match a similarly prefixed lorebook.
        if(typeof meta?.sourceName === 'string' && meta.sourceName.trim())
            return meta.sourceName === String(lorebookName);
        const raw = parseRegistryKey(key).collectionId || key;
        return raw === `vecthare_lorebook_${name}` ||
            raw.startsWith(`vecthare_lorebook_${name}_`);
    });
}
export function isLorebookVectorized(lorebookName, settings) {
    return matchingLorebookKeys(lorebookName, settings).length > 0;
}

/**
 * Get vectorization status for all lorebooks
 * @param {string[]} lorebookNames - Array of lorebook names
 * @param {object} settings - VectHare settings
 * @returns {Map<string, boolean>} Map of lorebook name -> is vectorized
 */
export function getLorebooksVectorizationStatus(lorebookNames, settings) {
    const statusMap = new Map();

    for (const name of lorebookNames) {
        statusMap.set(name, isLorebookVectorized(name, settings));
    }

    return statusMap;
}

/**
 * Get statistics for vectorized lorebook
 * @param {string} lorebookName - Name of the lorebook
 * @param {object} settings - VectHare settings
 * @returns {Promise<object|null>} Stats object or null if not vectorized
 */
export async function getLorebookVectorStats(lorebookName, settings) {
    const matches=matchingLorebookKeys(lorebookName,settings);
    // Never invent a new timestamped ID to look up an existing collection.
    // If two registered collections claim this same lorebook, don't silently
    // return potentially unrelated stats; an explicit selection is required.
    if(matches.length!==1)return null;
    const collectionId=matches[0];
    const meta = getCollectionMeta(collectionId);
    if (!meta) return null;

    return {
        collectionId,
        sourceName: meta.sourceName,
        chunkCount: meta.chunkCount || 0,
        createdAt: meta.createdAt,
        enabled: isCollectionEnabled(collectionId, settings),
        strategy: meta.settings?.strategy || 'per_entry',
        scope: meta.scope || 'global',
    };
}

// ============================================================================
// WORLD INFO UI INTEGRATION
// ============================================================================

/**
 * Add vector status indicators to world info entries in the UI
 * This function can be called to enhance the WI editor UI
 *
 * @param {string} lorebookName - Name of the current lorebook
 * @param {object[]} entries - World info entries
 * @param {object} settings - VectHare settings
 * @returns {object[]} Enhanced entries with vector status
 */
export function enhanceWorldInfoEntriesUI(lorebookName, entries, settings) {
    const isVectorized = isLorebookVectorized(lorebookName, settings);

    if (!isVectorized) {
        return entries;
    }

    // Add vector status to each entry
    return entries.map(entry => ({
        ...entry,
        vectorized: true,
        vectorStatus: {
            isVectorized: true,
            canUseSemanticActivation: true,
            lorebookVectorized: isVectorized
        }
    }));
}

// ============================================================================
// EXPORT FOR ST INTEGRATION
// ============================================================================

/**
 * Initialize world info integration hooks
 * This should be called when VectHare loads
 */
export function initializeWorldInfoIntegration() {
    if (!hostWorldInfoHooksInstalled && event_types.WORLDINFO_SCAN_DONE) {
        eventSource.on(event_types.WORLDINFO_SCAN_DONE, captureHostWorldInfoScan);
        eventSource.on(event_types.CHAT_CHANGED, () => { finalHostActiveEntries = null; });
        hostWorldInfoHooksInstalled = true;
    }
    // Make functions available globally for ST to call
    window.VectHare_WorldInfo = {
        getSemanticEntries: getSemanticWorldInfoEntries,
        isLorebookVectorized: isLorebookVectorized,
        getVectorizationStatus: getLorebooksVectorizationStatus,
        getVectorStats: getLorebookVectorStats,
        enhanceEntriesUI: enhanceWorldInfoEntriesUI
    };

    console.log('VectHare: World Info integration hooks initialized');
}

/**
 * Query semantic WI entries and inject them into the prompt extension tag.
 * Intended to be called on MESSAGE_SENT to ensure lorebook semantic hits
 * are available for the subsequent generation.
 * @param {object[]} chat Current chat messages
 * @param {object} settings VectHare settings
 */
export async function applySemanticEntriesToPrompt(chat, settings) {
    try {
        if (!settings || !settings.enabled_world_info) return;
        // This legacy standalone WI prompt path is outside the unified
        // per-generation budget. When limits are configured, WI must flow
        // through rearrangeChat's eligible memory pipeline instead: never
        // create a second uncounted injection that bypasses #57.
        if (Number(settings.memory_max_injections) > 0 || Number(settings.memory_token_budget) > 0) {
            console.warn('VectHare: independent semantic WI injection disabled while the unified memory budget is active');
            return;
        }

        const recentMessages = chat
            .filter(m => !m.is_system)
            .reverse()
            .slice(0, settings.world_info_query_depth ?? settings.query ?? 3)
            .map(m => (m.mes || '').toString());

        const entries = await getSemanticWorldInfoEntries(recentMessages, [], settings);
        if (!entries || entries.length === 0) {
            return;
        }

        // Build simple injection text from entries (preserve order by score)
        const text = entries.map(e => e.content || (Array.isArray(e.key) ? e.key.join(' ') : e.key || '')).join('\n\n');

        // Respect global RAG wrappers if configured
        const fullText = (settings.rag_context ? settings.rag_context + '\n\n' : '') + text;

        // Inject into ST extension prompt tag so generation will include it
        setExtensionPrompt(EXTENSION_PROMPT_TAG, fullText, settings.position || 0, settings.depth ?? 2, false);
        console.log(`VectHare: Injected ${entries.length} semantic WI entries into prompt`);
    } catch (err) {
        console.warn('VectHare: Failed to apply semantic WI to prompt', err.message || err);
    }
}
