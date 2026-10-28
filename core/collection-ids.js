/**
 * ============================================================================
 * VECTHARE COLLECTION ID UTILITIES
 * ============================================================================
 * Single source of truth for all collection ID operations:
 * - Building/generating collection IDs
 * - Parsing collection IDs (all formats)
 * - Pattern matching for discovery
 *
 * ALL other files should import from here instead of rolling their own.
 * ============================================================================
 */

import { getContext } from '../../../../extensions.js';
import { getCurrentChatId, chat_metadata } from '../../../../../script.js';
import {observeChatFork} from '../utils/s11-chat-fork-observer.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Prefix for new VectHare format (not currently used for chats, but available) */
export const VH_PREFIX = 'vh';

/** All known collection prefixes for backwards compatibility */
export const COLLECTION_PREFIXES = {
    // VectHare formats
    VECTHARE_CHAT: 'vecthare_chat_',
    VECTHARE_LOREBOOK: 'vecthare_lorebook_',
    VECTHARE_CHARACTER: 'vecthare_character_',
    VECTHARE_DOCUMENT: 'vecthare_document_',

    // Legacy/external formats
    FILE: 'file_',
    LOREBOOK: 'lorebook_',
    RAGBOOKS_LOREBOOK: 'ragbooks_lorebook_',
    CARROTKERNEL_CHAR: 'carrotkernel_char_',
};

/** Collection types */
export const COLLECTION_TYPES = {
    CHAT: 'chat',
    LOREBOOK: 'lorebook',
    CHARACTER: 'character',
    DOCUMENT: 'document',
    FILE: 'file',
    URL: 'url',
    WIKI: 'wiki',
    YOUTUBE: 'youtube',
    UNKNOWN: 'unknown',
};

/** Collection scopes */
export const COLLECTION_SCOPES = {
    GLOBAL: 'global',
    CHARACTER: 'character',
    CHAT: 'chat',
    UNKNOWN: 'unknown',
};

// ============================================================================
// CHAT UUID UTILITIES
// ============================================================================

/**
 * Gets the unique chat UUID from chat_metadata.integrity
 * This is the authoritative identifier for a chat.
 * @returns {string|null} Chat UUID or null if no chat
 */
/** Stable ownership may only use an ID persisted with chat metadata, not a
 * filename or UI chat index. A missing integrity ID requires user remapping.
 */
export function getChatIdentityObservation() {
    const value = chat_metadata?.integrity;
    let storage = null;
    try { storage = globalThis.localStorage || null; } catch { /* browser storage inaccessible */ }
    return observeChatFork({chatId:getCurrentChatId(),integrity:value,storage});
}
export function getVerifiedChatOriginId() {
    return getChatIdentityObservation().originId;
}

export function getChatUUID() {
    const integrity = chat_metadata?.integrity;
    if (integrity) {
        // A copied integrity value must never become a second chat's collection.
        // No local/host observation is proof of server authorization.
        return getVerifiedChatOriginId();
    }
    // Fallback: use chatId (less ideal but works for old chats)
    const chatId = getCurrentChatId();
    if (chatId) {
        console.warn('VectHare: chat_metadata.integrity not found, falling back to chatId');
        return chatId;
    }
    return null;
}

// ============================================================================
// COLLECTION ID BUILDERS
// ============================================================================

/**
 * Builds a chat collection ID using UUID for uniqueness
 * Format: vecthare_chat_{charName}_{uuid}
 * @param {string} [chatUUID] Optional UUID override
 * @returns {string|null} Collection ID or null if no chat
 */
export function buildChatCollectionId(chatUUID) {
    const uuid = chatUUID || getChatUUID();
    if (!uuid) {
        return null;
    }

    const context = getContext();
    const charName = context?.name2 || 'chat';

    // Sanitize character name (lowercase, alphanumeric only)
    const sanitizedChar = charName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 30);

    return `${COLLECTION_PREFIXES.VECTHARE_CHAT}${sanitizedChar}_${uuid}`;
}

/**
 * Builds a legacy chat collection ID (for backwards compatibility checks)
 * Format: vecthare_chat_{chatId}
 * @param {string} [chatId] Optional chatId override
 * @returns {string|null} Legacy collection ID or null
 */
export function buildLegacyChatCollectionId(chatId) {
    const id = chatId || getCurrentChatId();
    if (!id) {
        return null;
    }
    return `${COLLECTION_PREFIXES.VECTHARE_CHAT}${id}`;
}

/**
 * Builds a lorebook collection ID
 * @param {string} lorebookName Lorebook name
 * @param {number} [timestamp] Optional timestamp, defaults to Date.now()
 * @returns {string} Collection ID
 */
export function buildLorebookCollectionId(lorebookName, timestamp) {
    const sanitizedName = lorebookName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .substring(0, 50);
    return `${COLLECTION_PREFIXES.VECTHARE_LOREBOOK}${sanitizedName}_${timestamp || Date.now()}`;
}

/**
 * Builds a character collection ID
 * @param {string} characterName Character name
 * @param {number} [timestamp] Optional timestamp
 * @returns {string} Collection ID
 */
export function buildCharacterCollectionId(characterName, timestamp) {
    const sanitizedName = characterName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .substring(0, 50);
    return `${COLLECTION_PREFIXES.VECTHARE_CHARACTER}${sanitizedName}_${timestamp || Date.now()}`;
}

/**
 * Builds a document collection ID
 * @param {string} documentName Document name
 * @param {number} [timestamp] Optional timestamp
 * @returns {string} Collection ID
 */
export function buildDocumentCollectionId(documentName, timestamp) {
    const sanitizedName = documentName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .substring(0, 50);
    return `${COLLECTION_PREFIXES.VECTHARE_DOCUMENT}${sanitizedName}_${timestamp || Date.now()}`;
}

/**
 * Gets all possible collection IDs for the current chat (for discovery)
 * @param {string} [chatId] Optional chatId override
 * @param {string} [chatUUID] Optional UUID override
 * @returns {{current: string|null, legacy: string|null}} Both format IDs
 */
export function getAllChatCollectionIds(chatId, chatUUID) {
    return {
        current: buildChatCollectionId(chatUUID),
        legacy: buildLegacyChatCollectionId(chatId),
    };
}

// ============================================================================
// COLLECTION ID PARSER
// ============================================================================

/**
 * Parses any collection ID format and returns structured info
 * Handles all legacy and current formats.
 *
 * @param {string} collectionId Collection ID to parse
 * @returns {{type: string, rawId: string, scope: string, format: string}} Parsed info
 */
export function parseCollectionId(collectionId) {
    if (!collectionId || typeof collectionId !== 'string') {
        return {
            type: COLLECTION_TYPES.UNKNOWN,
            rawId: 'unknown',
            scope: COLLECTION_SCOPES.UNKNOWN,
            format: 'invalid',
        };
    }

    // New VH format: vh:type:sourceId
    if (collectionId.startsWith(`${VH_PREFIX}:`)) {
        const parts = collectionId.split(':');
        if (parts.length >= 3) {
            return {
                type: parts[1],
                rawId: parts.slice(2).join(':'),
                scope: parts[1] === 'chat' ? COLLECTION_SCOPES.CHAT : COLLECTION_SCOPES.GLOBAL,
                format: 'vh',
            };
        }
    }

    // VectHare chat format: vecthare_chat_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.VECTHARE_CHAT)) {
        return {
            type: COLLECTION_TYPES.CHAT,
            rawId: collectionId.replace(COLLECTION_PREFIXES.VECTHARE_CHAT, ''),
            scope: COLLECTION_SCOPES.CHAT,
            format: 'vecthare',
        };
    }

    // VectHare lorebook format: vecthare_lorebook_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.VECTHARE_LOREBOOK)) {
        return {
            type: COLLECTION_TYPES.LOREBOOK,
            rawId: collectionId.replace(COLLECTION_PREFIXES.VECTHARE_LOREBOOK, ''),
            scope: COLLECTION_SCOPES.GLOBAL,
            format: 'vecthare',
        };
    }

    // VectHare character format: vecthare_character_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.VECTHARE_CHARACTER)) {
        return {
            type: COLLECTION_TYPES.CHARACTER,
            rawId: collectionId.replace(COLLECTION_PREFIXES.VECTHARE_CHARACTER, ''),
            scope: COLLECTION_SCOPES.CHARACTER,
            format: 'vecthare',
        };
    }

    // VectHare document format: vecthare_document_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.VECTHARE_DOCUMENT)) {
        return {
            type: COLLECTION_TYPES.DOCUMENT,
            rawId: collectionId.replace(COLLECTION_PREFIXES.VECTHARE_DOCUMENT, ''),
            scope: COLLECTION_SCOPES.GLOBAL,
            format: 'vecthare',
        };
    }

    // Legacy file format: file_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.FILE)) {
        return {
            type: COLLECTION_TYPES.FILE,
            rawId: collectionId.replace(COLLECTION_PREFIXES.FILE, ''),
            scope: COLLECTION_SCOPES.GLOBAL,
            format: 'legacy',
        };
    }

    // Legacy lorebook format: lorebook_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.LOREBOOK)) {
        return {
            type: COLLECTION_TYPES.LOREBOOK,
            rawId: collectionId.replace(COLLECTION_PREFIXES.LOREBOOK, ''),
            scope: COLLECTION_SCOPES.GLOBAL,
            format: 'legacy',
        };
    }

    // Ragbooks lorebook format: ragbooks_lorebook_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.RAGBOOKS_LOREBOOK)) {
        return {
            type: COLLECTION_TYPES.LOREBOOK,
            rawId: collectionId.replace(COLLECTION_PREFIXES.RAGBOOKS_LOREBOOK, ''),
            scope: COLLECTION_SCOPES.GLOBAL,
            format: 'ragbooks',
        };
    }

    // CarrotKernel/Fullsheet character format: carrotkernel_char_*
    if (collectionId.startsWith(COLLECTION_PREFIXES.CARROTKERNEL_CHAR)) {
        return {
            type: COLLECTION_TYPES.CHARACTER,
            rawId: collectionId.replace(COLLECTION_PREFIXES.CARROTKERNEL_CHAR, ''),
            scope: COLLECTION_SCOPES.CHARACTER,
            format: 'fullsheet',
        };
    }

    // Heuristic: date/timestamp patterns suggest chat
    if (collectionId.includes('@') || /\d{4}-\d{2}-\d{2}/.test(collectionId)) {
        return {
            type: COLLECTION_TYPES.CHAT,
            rawId: collectionId,
            scope: COLLECTION_SCOPES.CHAT,
            format: 'legacy_chat',
        };
    }

    // Default: unknown
    return {
        type: COLLECTION_TYPES.UNKNOWN,
        rawId: collectionId,
        scope: COLLECTION_SCOPES.UNKNOWN,
        format: 'unknown',
    };
}

// ============================================================================
// PATTERN MATCHING FOR DISCOVERY
// ============================================================================

/**
 * Builds search patterns for finding a chat's collections
 * Used by doesChatHaveVectors and similar discovery functions
 *
 * @param {string} [chatId] Chat ID (filename)
 * @param {string} [chatUUID] Chat UUID
 * @returns {string[]} Array of patterns to search for (all lowercase)
 */
export function buildChatSearchPatterns(chatId, chatUUID) {
    const patterns = [];
    const uuid = chatUUID || getChatUUID();
    const id = chatId || getCurrentChatId();

    // Primary: UUID (the unique identifier)
    if (uuid) {
        patterns.push(uuid.toLowerCase());
    }

    // Legacy: full chatId
    if (id) {
        patterns.push(`${COLLECTION_PREFIXES.VECTHARE_CHAT}${id}`.toLowerCase());

        // Extract character name (before " - " in filename)
        const charNameMatch = id.match(/^([^-]+)/);
        if (charNameMatch) {
            const charName = charNameMatch[1].trim().toLowerCase();
            if (charName) {
                patterns.push(`${COLLECTION_PREFIXES.VECTHARE_CHAT}${charName}`.toLowerCase());
            }
        }
    }

    return patterns;
}

/**
 * Checks if a collection ID matches any of the given patterns
 * Case-insensitive, uses substring matching for flexibility
 *
 * @param {string} collectionId Collection ID to check
 * @param {string[]} patterns Patterns to match against
 * @returns {boolean} True if matches any pattern
 */
export function matchesPatterns(collectionId, patterns) {
    if (!collectionId || !patterns || patterns.length === 0) {
        return false;
    }

    const idLower = collectionId.toLowerCase();

    return patterns.some(pattern =>
        idLower === pattern ||
        idLower.includes(pattern)
    );
}

/**
 * Extracts backend and source from a registry key
 * Registry keys can be:
 * - "backend:source:collectionId" (new format)
 * - "source:collectionId" (migration format)
 * - "collectionId" (legacy format)
 *
 * @param {string} registryKey Registry key to parse
 * @returns {{backend: string|null, source: string|null, collectionId: string}} Parsed key
 */
export function parseRegistryKey(registryKey) {
    if (!registryKey || typeof registryKey !== 'string') {
        return { backend: null, source: null, collectionId: '' };
    }

    // Known backends and embedding sources
    const knownBackends = ['standard', 'lancedb', 'vectra', 'milvus', 'qdrant'];
    const knownSources = ['transformers', 'openai', 'cohere', 'ollama', 'llamacpp',
        'vllm', 'koboldcpp', 'webllm', 'bananabread', 'openrouter',
        'electronhub', 'mistral', 'nomicai', 'palm', 'vertexai', 'togetherai', 'extras'];

    const parts = registryKey.split(':');

    // New format: backend:source:collectionId (3+ parts)
    if (parts.length >= 3 && knownBackends.includes(parts[0]) && knownSources.includes(parts[1])) {
        return {
            backend: parts[0],
            source: parts[1],
            collectionId: parts.slice(2).join(':'),  // Rest is collection ID (may contain colons)
        };
    }

    // Migration format: source:collectionId (2+ parts, starts with source)
    if (parts.length >= 2 && knownSources.includes(parts[0])) {
        return {
            backend: null,  // Backend unknown in old format
            source: parts[0],
            collectionId: parts.slice(1).join(':'),
        };
    }

    // Legacy format: just collectionId (no colons, or unknown prefix)
    return { backend: null, source: null, collectionId: registryKey };
}



// Phase 0 canonical collection-key API (also exported from pure test helper).

export const COLLECTION_BACKENDS = Object.freeze(['standard', 'vectra', 'lancedb', 'milvus', 'qdrant']);
export const COLLECTION_SOURCES = Object.freeze(['transformers','openai','cohere','ollama','llamacpp','vllm','koboldcpp','webllm','bananabread','openrouter','electronhub','mistral','nomicai','palm','vertexai','togetherai','extras']);
const valid = (s, values) => typeof s === 'string' && values.includes(s);
export function formatCollectionKey({backend, source, collectionId} = {}) {
    if (!valid(backend, COLLECTION_BACKENDS) || !valid(source, COLLECTION_SOURCES) || typeof collectionId !== 'string' || !collectionId.length) {
        throw new Error('Invalid qualified collection identity');
    }
    return `${backend}:${source}:${collectionId}`;
}
export function parseCollectionKey(value) {
    if (typeof value !== 'string') return null;
    const first = value.indexOf(':');
    const second = first < 0 ? -1 : value.indexOf(':', first + 1);
    if (first < 0 || second < 0) return null;
    const parsed = {backend:value.slice(0,first),source:value.slice(first+1,second),collectionId:value.slice(second+1)};
    try { if (formatCollectionKey(parsed) === value) return parsed; } catch (_) { /* invalid */ }
    return null;
}
/** Registry entries retain their original spelling; never auto-migrate them. */
export function resolveCollectionKey(input, {registry = [], backend, source} = {}) {
    if (typeof input !== 'string' || !input || !Array.isArray(registry)) return {status:'none', candidates:[]};
    const matches = new Set();
    for (const entry of registry) {
        if (typeof entry !== 'string') continue;
        const parsed = parseCollectionKey(entry);
        if (parsed) {
            if ((entry === input || parsed.collectionId === input) && (!backend || parsed.backend === backend) && (!source || parsed.source === source)) matches.add(entry);
        } else if (entry === input) {
            // Legacy entries cannot prove their backend/source. Never silently qualify.
            matches.add(entry);
        }
    }
    const candidates = [...matches];
    // A legacy bare entry is independent from a qualified one, even if it has the same text.
    if (candidates.length > 1) return {status:'ambiguous', candidates};
    if (candidates.length === 1 && parseCollectionKey(candidates[0])) return {status:'unique',key:candidates[0],candidates};
    return {status:'none',candidates};
}
