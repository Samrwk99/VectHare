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
} from './collection-metadata.js';
import { parseRegistryKey } from './collection-ids.js';
import { buildLorebookCollectionId } from './collection-ids.js';
import { setExtensionPrompt, getCurrentChatId } from '../../../../../script.js';
import { LEGACY_WORLD_INFO_PROMPT_TAG } from './constants.js';
import { buildSearchContext } from './conditional-activation.js';
import {normalizeWorldInfoEntries, normalizeWorldInfoEntry} from '../utils/world-info-identity.js';
import {resolveExclusiveCollections} from './retrieval-planner.js';

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

    // Build search query from recent messages
    const query = recentMessages.slice(-Math.max(1, Number(settings.world_info_query_depth) || 3)).join('\n');
    if (!query.trim()) {
        return [];
    }

    console.log(`VectHare: Querying vectorized lorebooks for semantic WI activation...`);

    const semanticEntries = [];
    // Lower threshold for hybrid search since RRF fusion produces lower absolute scores
    const baseThreshold = settings.world_info_threshold ?? 0.3;
    const threshold = settings.hybrid_search_enabled ? baseThreshold * 0.8 : baseThreshold;
    const topK = Math.max(1,Math.min(100,Number.isFinite(Number(settings.world_info_top_k))
        ? Math.trunc(Number(settings.world_info_top_k)) || 3 : 3));

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
            activeLorebookEntries: normalizeWorldInfoEntries(activeEntries),
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

            // Query this lorebook collection (use raw collection ID)
            const results = await queryCollection(rawCollectionId, query, topK, settings);

            if (results && results.metadata) {
                for (let i = 0; i < results.metadata.length; i++) {
                    const meta = results.metadata[i];
                    const score = meta.score || 0;

                    if (score >= threshold) {
                        // Extract WI entry data from metadata
                        const entry = {
                            uid: meta.entryUid ?? meta.uid ?? meta.hash,
                            key: meta.keywords || meta.entryName || [],
                            content: meta.text || '',
                            score: score,
                            lorebookName: collection.name,
                            collectionId: rawCollectionId,
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
    const limitedEntries = deduplicateSemanticWorldInfo(deduplicatedEntries)
        .slice(0, Number.isFinite(Number(maxEntries)) ? Math.max(0,Math.min(1000,Math.trunc(Number(maxEntries)))) : 10);

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
        if (!collectionId.includes('lorebook')) {
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

    // C09's deterministic exclusive-collection resolver must apply here too:
    // allowing *all* exclusive lorebooks would violate the one-winner rule.
    const exclusive = resolveExclusiveCollections(collections.map(c=>c.id),getCollectionMeta);
    if (exclusive.reasons.length) {
        const accepted = new Set(exclusive.ids);
        console.log(`VectHare WI: Exclusive lorebook policy suppressed ${collections.length-accepted.size} collection(s)`);
        return collections.filter(c=>accepted.has(c.id));
    }

    console.log(`VectHare WI: ${collections.length} lorebook collection(s) passed activation filters`);
    return collections;
}

/** Read-only canonical WI dedup across distinct vector collections.
 * Keep the highest ranked semantic result for each qualified entry identity.
 * Missing identity cannot be used for cross-collection deduplication.
 */
export function deduplicateSemanticWorldInfo(entries=[]) {
    const seen=new Set();
    return entries.filter(entry=>{
        const id=normalizeWorldInfoEntry(entry,entry.lorebookName)?.id;
        if(!id)return true;
        if(seen.has(id))return false;
        seen.add(id);return true;
    });
}

/**
 * Deduplicate semantic entries with already active entries
 * @param {object[]} semanticEntries - Entries from vector search
 * @param {object[]} activeEntries - Already active entries from keyword matching
 * @returns {object[]} Deduplicated entries
 */
function deduplicateWithActiveEntries(semanticEntries, activeEntries) {
    // UIDs alone are not unique across lorebooks.
    const activeIds = new Set(normalizeWorldInfoEntries(activeEntries).map(e => e.id));
    const activeContents = new Set((Array.isArray(activeEntries)?activeEntries:[]).map(e => typeof e?.content==='string' ? e.content.trim().toLowerCase() : null).filter(Boolean));

    return semanticEntries.filter(entry => {
        // Skip if UID already active
        const identity = normalizeWorldInfoEntry(entry, entry.lorebookName);
        if (identity && activeIds.has(identity.id)) {
            return false;
        }

        // Skip if content already active (fuzzy match)
        const content = entry.content?.trim().toLowerCase();
        if (content && activeContents.has(content)) {
            return false;
        }

        return true;
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
export function isLorebookVectorized(lorebookName, settings) {
    const collectionId = buildLorebookCollectionId(lorebookName, 'global');
    const collectionRegistry = settings.vecthare_collection_registry || [];
    return collectionRegistry.includes(collectionId);
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
    const collectionId = buildLorebookCollectionId(lorebookName, 'global');
    const meta = getCollectionMeta(collectionId);

    if (!meta) {
        return null;
    }

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

        const recentMessages = chat
            .filter(m => !m.is_system)
            .slice(-Math.max(1, Number(settings.world_info_query_depth || settings.query) || 3))
            .map(m => (m.mes || '').toString());

        const entries = await getSemanticWorldInfoEntries(recentMessages, [], settings);
        if (!entries || entries.length === 0) {
            return;
        }

        // Build simple injection text from entries (preserve order by score)
        const text = entries.map(e => e.content || (Array.isArray(e.key) ? e.key.join(' ') : e.key || '')).join('\n\n');

        // Respect global RAG wrappers if configured
        const fullText = (settings.rag_context ? settings.rag_context + '\n\n' : '') + text;

        // Dormant compatibility helper: never overwrite the active RAG prompt tag.
        setExtensionPrompt(LEGACY_WORLD_INFO_PROMPT_TAG, fullText, settings.position ?? 0, settings.depth ?? 2, false);
        console.log(`VectHare: Injected ${entries.length} semantic WI entries into prompt`);
    } catch (err) {
        console.warn('VectHare: Failed to apply semantic WI to prompt', err.message || err);
    }
}
