import { backendWriteRefusal } from './plugin-health.js';
import { vhLog } from '../utils/log.js';
import AsyncUtils from '../utils/async-utils.js';
/**
 * ============================================================================
 * VECTHARE CHAT VECTORIZATION
 * ============================================================================
 * Core logic for vectorizing chat messages and retrieving relevant context
 *
 * @author Coneja Chibi
 * @version see manifest.json
 * ============================================================================
 */

import { getCurrentChatId, is_send_press, setExtensionPrompt, substituteParams, chat_metadata, extension_prompts } from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';
import { getStringHash as calculateHash, waitUntilCondition, onlyUnique, uuidv4 } from '../../../../utils.js';
import { isUnitStrategy, groupConversationTurns } from './chunking.js';
import { extractChatKeywords, extractBM25Keywords } from './keyword-boost.js';
import { cleanText } from './text-cleaning.js';
import {
    getSavedHashes,
    insertVectorItems,
    queryCollection,
    queryActiveCollections,
    deleteVectorItems,
    purgeVectorIndex,
    throwIfSourceInvalid,
    primeChunkHashClaims,
    resolveEmbeddingSettingsForEdit,
} from './core-vector-api.js';
import { isBackendAvailable, getBackend } from '../backends/backend-manager.js';
import { applyDecayToResults, applySceneAwareDecay } from './temporal-decay.js';
import { isChunkDisabledByScene } from './scenes.js';
import { registerCollection, getCollectionRegistry } from './collection-loader.js';
import {
    isCollectionEnabled,
    filterActiveCollections,
    getChatCollectionPolicy,
    applyChatCollectionPolicy,
    canRecordInitialVectorizationConfig,
    createInitialVectorizationConfig,
    saveInitialVectorizationConfig,
    readInitialVectorizationConfig,
    resolveCollectionOperationSettings,
    snapshotCollectionOperationSettings,
    assertCollectionOperationSettingsStable,
    compareInitialVectorizationConfig,
    carryOverCollectionPreferences,
    transferCollectionAnnotations,
    getAnnotatedChunkHashes,
} from './collection-metadata.js';
import { progressTracker, describeEffectiveSettings, phaseText } from '../ui/progress-tracker.js';
import { sha256Text } from './vector-provenance.js';
// VectHare+: run control (pause / resume / stop) for vectorization jobs
import {
    pauseVectorization,
    resumeVectorization,
    stopVectorization,
    resetControlState,
    isVectorizationPaused,
    isVectorizationStopped,
    getStopSignal,
} from './vectorization-control.js';
import { buildSearchContext, filterChunksByConditions, processChunkLinks } from './conditional-activation.js';
import { getChunkMetadata, getCollectionMeta, setCollectionMeta, deleteChunkMetadata } from './collection-metadata.js';
import { flushVectHareStore, persistVectHareStore, assertStoreAuthoritative, refreshStoreIfStale } from './vecthare-store.js';
import { acquireLease } from './leases.js';
import { resolveStorage, settingsForCollectionStorage, scopedTenancySupported } from './storage-resolver.js';
import { processChunkGroups, mergeVirtualLinks } from './chunk-groups.js';
import { createDebugData, setLastSearchDebug, addTrace, recordChunkFate } from '../ui/search-debug.js';
import { getSemanticWorldInfoEntries } from './world-info-integration.js';
import { Queue, LRUCache } from '../utils/data-structures.js';
import { getRequestHeaders } from '../../../../../script.js';
import { EXTENSION_PROMPT_TAG, HASH_CACHE_SIZE } from './constants.js';
// Import from collection-ids.js - single source of truth for collection ID operations
import {
    getChatUUID,
    buildChatCollectionId,
    buildLegacyChatCollectionId,
    getAllChatCollectionIds,
    parseCollectionId,
    parseRegistryKey,
    ensureChatBinding,
    recordChatStore,
    beginChatCollectionWrite,
    endChatCollectionWrite,
    withChatCollectionPurgeGuard,
    getChatOwner,
    normChat,
    peekChatCollectionId,
    mintChatCollectionId,
    beginChatCollectionRebuild,
    endChatCollectionRebuild,
    adoptChatCollection,
    reattachChatCollection,
    chatStoreDestination,
} from './collection-ids.js';
import { listDeletedChatCollections, clearDeletedChatInfo } from './deleted-chats.js';

// Hash cache for performance
const hashCache = new LRUCache(HASH_CACHE_SIZE);

// Synchronization state
let syncBlocked = false;

/**
 * Whether SillyTavern is generating right now. `is_send_press` is a live import
 * that SillyTavern changes itself; reading it through a call lets the
 * wait loops say so plainly (lint cannot see live-binding updates).
 */
function isGenerating() {
    return is_send_press;
}

export function isChatSynchronizationActive() { return syncBlocked; }

// #39: Identity is owner + filename + collection ID. ST may reuse or mutate
// ctx.chat across awaits, so only read target.messages immediately after a check.
// #7: identity checks compared the chat array by reference, which assumes a
// switch always allocates a new array. This counter makes any A -> B -> A
// sequence detectable on its own, whatever the host reuses.
let chatSwitchGeneration = 0;
export function noteChatSwitch() {
    chatSwitchGeneration++;
    seedSeenMessages();
}

// ---------------------------------------------------------------------------
// VH-081: a second tab or device with an older view of the chat must not sync.
// The identity ledger records every indexed message with a source key
// (send_date, role, name). A message the ledger holds that this tab has never
// had, sent after this tab opened the chat, was written elsewhere: this tab's
// view is out of date, and its Sync/Repair would delete it and store text the
// server never saved.
// ---------------------------------------------------------------------------
const seenMessages = new Map(); // chat key -> { keys: Set, openedAt: ms, newestAtOpen: ms }
const SEND_DATE_SLACK_MS = 60 * 1000; // send_date strings may have minute precision

function chatViewKey(ctx = getContext()) {
    const owner = getChatOwner(ctx);
    const chatId = normChat(ctx?.chatId);
    return owner && chatId ? JSON.stringify([owner.type, owner.id, chatId]) : null;
}
function messageSourceKey(message) {
    if (!message || message.is_system) return null;
    const stamp = message.send_date;
    if (!((typeof stamp === 'number' && Number.isFinite(stamp)) || (typeof stamp === 'string' && stamp.trim()))) return null;
    return JSON.stringify([String(stamp), message.is_user ? 'user' : 'character', String(message.name || '')]);
}
function sendDateMs(stamp) {
    const text = String(stamp ?? '').trim();
    if (/^\d{11,}$/.test(text)) return Number(text);
    const parsed = Date.parse(text.replace(/(\d)(am|pm)$/i, '$1 $2'));
    return Number.isFinite(parsed) ? parsed : null;
}
function newestSendDate(messages) {
    let newest = -Infinity;
    for (const message of messages || []) {
        const at = message && !message.is_system ? sendDateMs(message.send_date) : null;
        if (at !== null && at > newest) newest = at;
    }
    return newest;
}
function seedSeenMessages(ctx = getContext()) {
    try {
        const key = chatViewKey(ctx);
        if (!key || !Array.isArray(ctx?.chat)) return;
        const keys = new Set(ctx.chat.map(messageSourceKey).filter(Boolean));
        seenMessages.set(key, { keys, openedAt: Date.now(), newestAtOpen: newestSendDate(ctx.chat) });
    } catch { /* best effort */ }
}
function noteSeenMessages(messages, ctx = getContext()) {
    const key = chatViewKey(ctx);
    if (!key) return null;
    // Not seeded at chat open: judge from what the tab has now (fewer alarms).
    if (!seenMessages.has(key)) seenMessages.set(key, { keys: new Set(), openedAt: Date.now(), newestAtOpen: newestSendDate(messages) });
    const entry = seenMessages.get(key);
    for (const message of messages || []) {
        const sourceKey = messageSourceKey(message);
        if (sourceKey) entry.keys.add(sourceKey);
    }
    return entry;
}

export class StaleChatViewError extends Error {
    constructor(count) {
        super(`This tab's chat is out of date: ${count} newer message(s) were added on another tab or device. ` +
            'Reload this chat before syncing. Nothing was changed.');
        this.code = 'VH_STALE_CHAT_VIEW';
    }
}

/** Throws StaleChatViewError when the ledger holds messages sent elsewhere after this tab opened the chat. */
function assertChatViewCurrent(ledger, messages) {
    const entry = noteSeenMessages(messages);
    if (!entry || !Array.isArray(ledger?.messages)) return;
    const newer = ledger.messages.filter(msg => msg.active !== false && msg.sourceKey &&
        !entry.keys.has(msg.sourceKey) && (() => {
            let stamp; try { stamp = JSON.parse(msg.sourceKey)[0]; } catch { return false; }
            const at = sendDateMs(stamp);
            // Sent after this tab opened the chat, and newer than anything it had then.
            return at !== null && at >= entry.openedAt - SEND_DATE_SLACK_MS && at > entry.newestAtOpen;
        })());
    if (newer.length) throw new StaleChatViewError(newer.length);
}

let staleViewNoticeAt = 0;
function noteStaleChatView(error) {
    if (Date.now() - staleViewNoticeAt < 30000) return;
    staleViewNoticeAt = Date.now();
    toastr.warning(error.message, 'VectHare', { timeOut: 15000 });
}

function captureChatTarget(ctx = getContext()) {
    const owner = getChatOwner(ctx);
    const chatId = normChat(ctx?.chatId);
    if (!owner || !chatId || !Array.isArray(ctx?.chat)) return null;
    return { owner, chatId, messages: ctx.chat, generation: chatSwitchGeneration };
}

function isChatTargetCurrent(target, collectionId = null) {
    if (!target) return false;
    const ctx = getContext();
    const owner = getChatOwner(ctx);
    let reason = null;
    if (!owner || owner.type !== target.owner.type || owner.id !== target.owner.id) reason = 'owner';
    else if (normChat(ctx?.chatId) !== target.chatId) reason = 'chat file';
    else if (ctx.chat !== target.messages) reason = 'chat array';
    else if (target.generation !== chatSwitchGeneration) reason = 'chat switch';
    else if (collectionId !== null && peekChatCollectionId(ctx) !== collectionId) reason = 'collection ID';
    if (reason) console.debug(`VectHare: Chat target changed (${reason})`);
    return reason === null;
}

// K6/U8: an unresolved identity is never guessed at; the user's way to clear
// it is a full rebuild of this chat's vectors.
const UNRESOLVED_ACTION_HINT = n =>
    `Vectorize \u2192 Re-vectorize this chat clears ${n === 1 ? 'it' : `these ${n}`}`;

const syncDeferred = () => ({ remaining: -1, messagesProcessed: 0, chunksCreated: 0 });
const validatedManualSync = Symbol('validated-manual-sync');

/**
 * VH-110: a chat's chunking (strategy, batch size, turn order, keyword level)
 * is chosen when the chat is first vectorized and saved with its collection;
 * the settings panel has no control for it. Sync and the status line used the
 * hidden global value instead, so a chat vectorized with another strategy
 * showed "database check inconclusive" and Sync was refused. Returns a copy of
 * settings carrying the collection's own saved chunking (or settings itself).
 */
function withSavedChatChunking(settings, saved) {
    const c = saved?.status === 'valid' ? saved.config?.chunking : null;
    if (c?.pipeline !== 'sync-chat') return settings;
    return {
        ...settings,
        chunking_strategy: c.strategy ?? settings.chunking_strategy,
        batch_size: c.batchSize ?? settings.batch_size,
        conversation_turn_order: c.conversationTurnOrder ?? settings.conversation_turn_order,
        keyword_extraction_level: c.keywordLevel ?? settings.keyword_extraction_level,
    };
}

function chatConfigChunking(settings) {
    return {
        pipeline: 'sync-chat',
        strategy: settings.chunking_strategy || 'per_message',
        batchSize: settings.batch_size || 4,
        conversationTurnOrder: settings.conversation_turn_order || 'user_character',
        keywordLevel: settings.keyword_extraction_level || 'balanced',
    };
}


// A deliberate, non-error stop: completed writes remain in their original chat.
class ChatSwitchStop extends Error {
    constructor() {
        super('Chat changed during vectorization');
        this.name = 'ChatSwitchStop';
    }
}

// VectHare+ R9: one-time warning flag for auto-sync blocked by config mismatch
let autoSyncFingerprintWarned = false;

/**
 * VectHare+ R10: Forces the NEXT sync pass (auto-sync or Repair Chunks) to run
 * the reverse-sync (ghost cleanup + duplicate healing) pass immediately,
 * instead of waiting out the 5-minute throttle. Called on MESSAGE_EDITED and
 * MESSAGE_DELETED so edited/removed messages get repaired on the very next
 * sync rather than up to 5 minutes later.
 */
// P1: bumped on every message edit/delete/swipe; a Sync run's cached plan is
// only reused while this is unchanged.
let chatMutationCounter = 0;
export function flagImmediateReverseSync() {
    chatMutationCounter++;
    const id = getChatCollectionId();
    if (!id) return;
    lastReverseSyncByCollection.delete(id);
    lastAutoRepairByCollection.delete(id);
    failedSyncHashes.delete(id);
    reverseSyncGeneration.set(id, (reverseSyncGeneration.get(id) ?? 0) + 1);
}

/**
 * VectHare+ R9: Computes the vectorization configuration fingerprint for the
 * current settings. SINGLE SOURCE OF TRUTH - used by BOTH vectorizeAll (manual
 * runs) and synchronizeChat (auto-sync) so the two can never drift apart.
 * Changed settings => different fingerprint => mixing vectors is detectable.
 *
 * Async because the model-field lookup lives in providers.js (dynamic import;
 * static import would create a circular dependency - providers.js has no
 * dependency on this file, but keeping the pattern consistent with the other
 * lazy imports here is safer).
 * Fingerprinting must degrade, never throw: any failure returns null and
 * callers skip the check (fail-open, same as R7).
 *
 * @param {object} settings VectHare settings
 * @returns {Promise<string|null>} Fingerprint, or null if computation failed
 */
async function computeVectorizationConfigFingerprint(settings) {
    try {
        const { getModelField } = await import('./providers.js');
        const modelField = getModelField(settings.source);
        const currentModel = modelField ? (settings[modelField] || '') : '';
        return String(getStringHash(JSON.stringify({
            source: settings.source,
            model: currentModel,
            chunking_strategy: settings.chunking_strategy,
            batch_size: settings.batch_size,
            ...(settings.chunking_strategy === 'conversation_turns'
                ? { conversation_turn_order: settings.conversation_turn_order || 'user_character' } : {}),
            chunk_size: settings.chunk_size,
        })));
    } catch (error) {
        console.warn('VectHare: Could not compute config fingerprint:', error.message);
        return null;
    }
}

// VectHare+ R6: reverse-sync throttle timestamp (module-scope so it spans
// event-driven sync passes AND vectorizeAll loop iterations)
const lastReverseSyncByCollection = new Map();
const lastAutoRepairByCollection = new Map(); // #85: automatic Sync's Repair-first pass
// #48: groups whose write keeps failing. They are retried, but they no longer
// consume every pass's budget ahead of content that can still be vectorized.
const failedSyncHashes = new Map(); // collectionId -> Map(hash -> { attempts, until })
const SYNC_FAILURE_BACKOFF_MAX_MS = 10 * 60 * 1000;
/** VH-078: what of this collection is waiting for a retry after a failed write. */
function pendingSyncFailures(collectionId) {
    const byHash = failedSyncHashes.get(collectionId);
    if (!byHash || !byHash.size) return { count: 0, reason: null, retryAt: null };
    let reason = null, retryAt = null;
    for (const entry of byHash.values()) {
        reason = entry.reason || reason;
        retryAt = retryAt === null ? entry.until : Math.min(retryAt, entry.until);
    }
    return { count: byHash.size, reason, retryAt };
}

function noteSyncItemFailure(collectionId, hash, reason = null) {
    const byHash = failedSyncHashes.get(collectionId) || new Map();
    const key = String(hash);
    const attempts = (byHash.get(key)?.attempts || 0) + 1;
    byHash.set(key, { attempts, reason: reason ? String(reason).slice(0, 300) : byHash.get(key)?.reason || null,
        until: Date.now() + Math.min(2 ** (attempts - 1) * 60 * 1000, SYNC_FAILURE_BACKOFF_MAX_MS) });
    failedSyncHashes.set(collectionId, byHash);
}
// #24: a request already sent server-side can still land after Stop. Drop the
// reconciliation throttles so the next pass re-reads the backend instead of
// assuming the collection is still as this run left it.
function requireReconciliationAfterStop(collectionId) {
    if (!collectionId) return;
    lastReverseSyncByCollection.delete(collectionId);
    lastAutoRepairByCollection.delete(collectionId);
    // These maps live in memory only, so a page reload would forget that a run
    // was interrupted. Persist the fact, so the next session still reconciles
    // before trusting the inventory this run left behind.
    try {
        setCollectionMeta(collectionId, { needsReconciliation: true });
    } catch (error) {
        console.debug('VectHare: Could not record the reconciliation marker:', error.message);
    }
}

// #24: a stop (or an interrupted session) may be followed by a server-side
// write that landed after we stopped reading. Until a verified pass clears the
// marker, reconciliation is due regardless of the throttle.
function reconciliationDue(collectionId, lastRunAt, intervalMs) {
    if (getCollectionMeta(collectionId)?.needsReconciliation === true) return true;
    return Date.now() - (lastRunAt ?? 0) >= intervalMs;
}

function clearReconciliationMarker(collectionId) {
    if (!collectionId || getCollectionMeta(collectionId)?.needsReconciliation !== true) return;
    try {
        setCollectionMeta(collectionId, { needsReconciliation: false });
    } catch (error) {
        console.debug('VectHare: Could not clear the reconciliation marker:', error.message);
    }
}

function clearSyncItemFailure(collectionId, hash) {
    const byHash = failedSyncHashes.get(collectionId);
    if (!byHash) return;
    byHash.delete(String(hash));
    if (!byHash.size) failedSyncHashes.delete(collectionId);
}
const reverseSyncGeneration = new Map();

// VectHare+: guards against concurrent vectorizeAll runs (they share one
// singleton progress panel and would interleave Pause/Stop wiring)
let vectorizeRunActive = false;

// VectHare+ R9: true when the most recently ended run was ended by the user's
// Stop button. Consumed by the resume check (index.js) so a deliberate stop
// isn't followed by an immediate "unfinished vectorization!" toast nag.
let lastRunStoppedByUser = false;

/**
 * R9: Consume-on-read - returns whether the last ended run was user-stopped
 * and resets the flag, so a later natural check (chat change etc.) toasts again.
 * @returns {boolean}
 */
export function consumeWasLastRunStoppedByUser() {
    const value = lastRunStoppedByUser;
    lastRunStoppedByUser = false;
    return value;
}

/**
 * VectHare+: True while a vectorizeAll() run is in progress.
 * Used by index.js to suppress resume popups during an active run.
 * @returns {boolean}
 */
export function isVectorizationActive() {
    return vectorizeRunActive;
}
// (R7 note: lastReverseSyncAt already declared module-scope below, R6)

/**
 * VectHare+ R12: Shared run acquisition for vectorizeAll AND repairChatVectors.
 * Enforces single-run re-entrancy and recovers a paused run's panel instead of
 * dead-ending the user. Returns true when the caller owns the run.
 * @returns {boolean}
 */
function tryAcquireVectorizationRun() {
    if (vectorizeRunActive) {
        // VectHare+ (R5): a PAUSED run whose panel the user closed would
        // dead-end here ("use the panel" → but the panel with the Resume
        // button was closed and unreachable). Recover by bringing the paused
        // run's panel back instead of rejecting.
        if (isVectorizationPaused()) {
            progressTracker.reveal();
            progressTracker.updateDisplay('⏸ Paused — use Resume or Stop on the panel');
            toastr.info(
                'A vectorization run is paused. Its controls have been brought back - use Resume or Stop on the panel.',
                'VectHare'
            );
        } else {
            toastr.info(
                'A vectorization/repair run is already active. Use Pause / Stop on the progress panel to control it.',
                'VectHare'
            );
        }
        console.warn('VectHare: run start ignored - a run is already active');
        return false;
    }
    vectorizeRunActive = true;
    lastRunStoppedByUser = false; // R9: fresh run clears any prior user-stop
    return true;
}

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
 * R24: exported - scenes.js must use THIS exact formula for contained-chunk
 * hashes, or scene disable-linkage points at hashes that don't exist in the DB
 * @param {object} message Chat message object
 * @returns {string} Message text without attachment prefix
 */
export function getTextWithoutAttachments(message) {
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
// Chunk text names the speakers as the chat does ([Peter]: / [Alice]:). The
// HASH keeps the role labels ([User]: / [Character]:), so existing chunk
// identities, ledgers and Sync/Repair diffing are unchanged, and renaming a
// persona or character never makes a chunk look edited.
function chatSpeakerLabel(m) {
    const name = typeof m.name === 'string' ? m.name.trim() : '';
    return name || (m.is_user ? 'User' : 'Character');
}
const chatRoleLabel = m => (m.is_user ? 'User' : 'Character');

// Records written before speaker names were used carry role-labelled text.
// Verification that compares stored text accepts that earlier form as well.
const legacyLabelText = new WeakMap();
function textVariants(item) {
    const legacy = legacyLabelText.get(item);
    return legacy && legacy !== item.text ? [item, { ...item, text: legacy }] : [item];
}

function groupMessagesByStrategy(messages, strategy, batchSize = 4, keywordLevel = 'balanced', conversationTurnOrder = 'user_character') {
    if (!messages.length) return [];

    // R22: grouped strategies hash the combined RAW text (m.raw), not the
    // substituted display text - same volatile-identity fix as per_message.
    // Display/embedding text (m.text) stays substituted.
    const rawOf = (m) => m.raw ?? m.text;

    // Helper to extract keywords based on level
    const getKeywords = (text) => {
        if (keywordLevel === 'off') return [];
        return extractBM25Keywords(text, { level: keywordLevel });
    };

    switch (strategy) {
        case 'conversation_turns': {
            // Pair logical speaker turns, including consecutive messages.
            const grouped = [];
            for (const pair of groupConversationTurns(messages, conversationTurnOrder)) {
                // Combine texts with speaker labels
                const combinedText = pair.map(m => `[${chatSpeakerLabel(m)}]: ${m.text}`).join('\n\n');
                const legacyText = pair.map(m => `[${chatRoleLabel(m)}]: ${m.text}`).join('\n\n');
                // R22: hash from RAW combined text (stable identity)
                const combinedRaw = pair.map(m => {
                    const role = m.is_user ? 'User' : 'Character';
                    return `[${role}]: ${rawOf(m)}`;
                }).join('\n\n');

                grouped.push({
                    text: combinedText,
                    hash: getStringHash(combinedRaw),
                    index: pair[0].index,
                    keywords: getKeywords(combinedText),
                    metadata: {
                        strategy: 'conversation_turns',
                        messageIds: pair.map(m => m.index),
                        messageHashes: pair.map(m => m.hash), // Store individual hashes for injection lookup
                        startIndex: pair[0].index,
                        endIndex: pair[pair.length - 1].index
                    }
                });
                legacyLabelText.set(grouped[grouped.length - 1], legacyText);
            }
            return grouped;
        }

        case 'message_batch': {
            // Group N messages together
            const grouped = [];
            for (let i = 0; i < messages.length; i += batchSize) {
                const batch = messages.slice(i, i + batchSize);
                // Combine texts with speaker labels
                const combinedText = batch.map(m => `[${chatSpeakerLabel(m)}]: ${m.text}`).join('\n\n');
                const legacyText = batch.map(m => `[${chatRoleLabel(m)}]: ${m.text}`).join('\n\n');
                // R22: hash from RAW combined text (stable identity)
                const combinedRaw = batch.map(m => {
                    const role = m.is_user ? 'User' : 'Character';
                    return `[${role}]: ${rawOf(m)}`;
                }).join('\n\n');

                grouped.push({
                    text: combinedText,
                    hash: getStringHash(combinedRaw),
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
                legacyLabelText.set(grouped[grouped.length - 1], legacyText);
            }
            return grouped;
        }

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
 * VectHare+ R12: Gathers chat messages and groups them per the chunking
 * strategy. Extracted from synchronizeChat so repairChatVectors uses the
 * EXACT same grouping/hashing logic - repair and sync must agree on what
 * a "group" is, or their hash diffing diverges.
 * @param {object[]} chat Chat messages
 * @param {object} settings VectHare settings
 * @returns {object[]} Grouped items
 */
function collectGroupedItems(chat, settings, hashOnly = false, memberPositions = null) {
    const strategy = settings.chunking_strategy || 'per_message';
    const strategyBatchSize = settings.batch_size || 4;
    const keywordLevel = hashOnly ? 'off' : (settings.keyword_extraction_level || 'balanced');

    const allMessages = [];
    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        if (msg.is_system) continue;
        const text = hashOnly ? getTextWithoutAttachments(msg)
            : cleanText(String(substituteParams(msg.mes)), settings.__collectionCleaningPatterns);
        allMessages.push({
            text,
            raw: getTextWithoutAttachments(msg), // R22: unsubstituted, consumed by grouped strategies' stable hashing
            hash: getStringHash(getTextWithoutAttachments(msg)), // R22: raw text, not substituted - stable identity across reloads
            index: i,
            is_user: msg.is_user,
            name: msg.name,
        });
    }

    if (!memberPositions) {
        return groupMessagesByStrategy(allMessages, strategy, strategyBatchSize, keywordLevel, settings.conversation_turn_order);
    }
    // Existing ledger groups have stable membership, even after chat positions
    // change. Re-use the original text/hash rules for each selected membership.
    const byPosition = new Map(allMessages.map(message => [message.index, message]));
    return memberPositions.map(positions => {
        const messages = positions.map(position => byPosition.get(position));
        if (!messages.length || messages.some(message => !message) ||
            (strategy === 'per_message' && messages.length !== 1)) {
            throw new Error('Invalid persisted chat group membership');
        }
        const item = groupMessagesByStrategy(messages,
            strategy === 'per_message' ? 'per_message' : 'message_batch',
            messages.length, keywordLevel, settings.conversation_turn_order)[0];
        if (strategy === 'conversation_turns') {
            delete item.metadata.batchSize;
            item.metadata.strategy = 'conversation_turns';
        }
        return item;
    });
}

// The Content Vectorizer's current-chat preview must show the SAME groups
// that its Sync-backed live-chat write will use. Read-only; no ledger changes.
export async function previewSyncChatGroups(chat, settings) {
    const target = captureChatTarget();
    if (!target || target.messages !== chat) throw new Error('Selected chat changed during preview');
    const collectionId = getChatCollectionId();
    const items = await collectCurrentChatGroups(chat, settings, collectionId);
    if (!isChatTargetCurrent(target, collectionId)) throw new Error('Selected chat changed during preview');
    return items;
}

/**
 * VectHare+ R14: Unified message-ID extraction from chunk/group metadata.
 * per_message chunks store `messageId` (singular number); grouped strategies
 * store `messageIds` (array). Repair's replacement detection originally read
 * ONLY `messageIds`, so on per_message chats (the default) NO replacements
 * were ever detected - edited messages had their stale vectors deleted but
 * the new text was never re-vectorized. Handles both shapes, numeric strings,
 * and a defensively-nested metadata object.
 * @param {object} meta Chunk or group metadata
 * @returns {number[]} Message indices
 */
function extractMessageIds(meta) {
    if (!meta) return [];
    const nested = meta.metadata || {};
    const raw = Array.isArray(meta.messageIds) ? meta.messageIds
        : Array.isArray(nested.messageIds) ? nested.messageIds
        : (meta.messageId != null) ? [meta.messageId]
        : (nested.messageId != null) ? [nested.messageId]
        : [];
    return raw.map(v => Number(v)).filter(v => Number.isFinite(v));
}

/**
 * A stored vector may be treated as a stale Sync Chat vector only when its own
 * persisted provenance says so. Shared by Repair and reverse Sync (#63/#77):
 * uploaded transcripts, scenes, summaries and records without usable message
 * identity are never ghosts. Unknown metadata fails closed.
 */
function isProtectedChatRecordMeta(meta) {
    if (!meta || meta.source !== 'chat' || meta.contentType != null || meta.sourceName != null) return true;
    if (meta.isScene === true || meta.disabledByScene != null) return true;
    if (meta.isSummaryChunk === true || meta.isSummary === true || meta.isSummaryVector === true) return true;
    if (meta.parentHash != null) return true;
    // A record stamped by another writer (e.g. a manual Visualizer edit) is not
    // a Sync Chat vector, even if it carries copied chat message metadata.
    if (meta.vecthareProvenance && meta.vecthareProvenance.recordKind !== 'sync-chat') return true;
    // `source: chat` alone is not enough evidence that a vector can safely be
    // deleted: unknown/legacy message identity cannot support replacement
    // matching. All current Sync strategies store their member indices.
    const validId = id => (typeof id === 'number' ||
        (typeof id === 'string' && id.trim() !== '')) &&
        Number.isSafeInteger(Number(id)) && Number(id) >= 0;
    if (meta.strategy === 'per_message') return !validId(meta.messageId);
    if (meta.strategy === 'message_batch' || meta.strategy === 'conversation_turns') {
        return !Array.isArray(meta.messageIds) || meta.messageIds.length === 0 ||
            !meta.messageIds.every(validId);
    }
    return true;
}

/**
 * Collections without an identity ledger cannot prove how an old vector was
 * prepared. If every message recorded for a "stale" vector is still unchanged,
 * its hash differs because of incompatible historical preparation, not because
 * the chat was edited (#54/#55): that must not authorize deletion/replacement.
 */
function hasUnchangedMemberMessages(meta, chat) {
    const ids = extractMessageIds(meta);
    const hashes = Array.isArray(meta?.messageHashes) ? meta.messageHashes : null;
    if (!hashes || ids.length === 0 || hashes.length !== ids.length) return false;
    return ids.every((id, i) => {
        const msg = chat[id];
        return msg && !msg.is_system &&
            String(getStringHash(getTextWithoutAttachments(msg))) === String(hashes[i]);
    });
}

/**
 * Does a stored physical record carry the text, grouping and (when required)
 * ledger source identity that `item` would have written? Used to rebuild a
 * missing ledger and to verify Repair replacements beyond hash presence (#57).
 */
// The Qdrant adapter stores chunk text with its keywords appended
// (backends/qdrant.js: `text [KEYWORDS: a b]`). A stored record matches its
// intended text exactly, or exactly with that one adapter-generated suffix built
// from the item's own keywords - nothing looser.
function storedTextMatches(storedText, item) {
    if (typeof storedText !== 'string' || typeof item?.text !== 'string') return false;
    if (storedText === item.text) return true;
    const keywords = item.keywords;
    if (!Array.isArray(keywords) || !keywords.length) return false;
    return storedText === `${item.text} [KEYWORDS: ${keywords.map(kw => kw?.text || kw).join(' ')}]`;
}

function chatRecordMatchesItem(meta, item, collectionId, textFingerprint, requireLedger = true, verifyContent = false) {
    const p = meta?.vecthareProvenance;
    const ids = extractMessageIds(item.metadata);
    const originalIds = extractMessageIds(meta);
    const wanted = item.metadata?.messageHashes;
    const uids = p?.sourceIdentity?.messageUids;
    const provenanceOk = requireLedger
        ? p?.collectionId === collectionId && p.recordKind === 'sync-chat' &&
            p.sourceType === 'chat' && p.sourceIdentity?.status === 'ledger-linked' &&
            p.submittedTextFingerprint === textFingerprint &&
            Array.isArray(uids) && uids.length === ids.length &&
            uids.every(uid => /^m_[0-9a-f]{32}$/.test(uid))
        : !p || (p.collectionId === collectionId && p.recordKind === 'sync-chat' &&
            p.sourceType === 'chat' &&
            (p.submittedTextFingerprint == null || p.submittedTextFingerprint === textFingerprint));
    // #57 (Repair replacements): the stored record itself must carry the intended
    // text and source UID tuple and be an ordinary Sync Chat record - a matching
    // fingerprint or well-formed UIDs alone do not prove that.
    const contentOk = !verifyContent || (!isProtectedChatRecordMeta(meta) &&
        storedTextMatches(meta.text, item) &&
        (!requireLedger || (Array.isArray(item.metadata?.messageUids) &&
            item.metadata.messageUids.length === uids?.length &&
            item.metadata.messageUids.every((uid, j) => uid === uids[j]))));
    return Boolean(meta) && provenanceOk && contentOk && meta.strategy === item.metadata?.strategy &&
        originalIds.length === ids.length && ids.every((id, j) => id === originalIds[j]) &&
        Array.isArray(meta.messageHashes) && Array.isArray(wanted) &&
        meta.messageHashes.length === wanted.length &&
        meta.messageHashes.every((hash, j) => String(hash) === String(wanted[j]));
}

// A replacement inherits user annotations stored on the vector it supersedes
// (#66). Fields derived from the chat group or the writer are regenerated.
const REGENERATED_RECORD_KEYS = new Set(['hash', 'text', 'index', 'source', 'strategy', 'messageId',
    'messageIds', 'messageHashes', 'startIndex', 'endIndex', 'batchSize', 'vecthareProvenance',
    'vecthareImportedProvenance', 'timestamp', 'messageIndex', 'type', 'sourceId', 'embeddingSource',
    'embeddingModel', 'is_user']);
function carriedRecordMetadata(meta) {
    return Object.fromEntries(Object.entries(meta || {}).filter(([key]) => !REGENERATED_RECORD_KEYS.has(key)));
}

// Pair each replacement with the single stale vector it supersedes, only when
// the pairing is unambiguous in both directions.
function uniqueReplacementSources(links) {
    const unique = [...new Map(links.map(([next, old]) => [`${next}:${old}`, [String(next), String(old)]])).values()];
    const count = (index) => unique.reduce((m, pair) => m.set(pair[index], (m.get(pair[index]) || 0) + 1), new Map());
    const byNew = count(0), byOld = count(1);
    return new Map(unique.filter(([next, old]) => byNew.get(next) === 1 && byOld.get(old) === 1));
}

// ============================================================================
// PHASE 3: CONFIRMED STAGED REBUILD
// ============================================================================

/**
 * Phase 3 preflight for Vectorize. Decides, without changing anything, whether
 * the current settings can be used on this chat's existing collection or
 * whether a confirmed rebuild is needed.
 *
 * @param {object} settings VectHare settings as selected now
 * @returns {Promise<{action: string, reason?: string, collectionId?: string,
 *   differences?: object[], chunkCount?: number}>}
 *   action is 'vectorize' (proceed normally), 'rebuild' (ask the user) or
 *   'blocked' (do not touch anything).
 */
export async function planChatVectorizationRebuild(settings) {
    const target = captureChatTarget();
    if (!target) return { action: 'blocked', reason: 'No chat is open.' };

    // The proposed settings are validated before anything destructive is
    // considered, so an unusable provider cannot start a rebuild.
    try {
        throwIfSourceInvalid(settings);
    } catch (error) {
        return { action: 'blocked', reason: `The selected embedding settings are not usable: ${error.message}` };
    }
    const chunking = chatConfigChunking(settings);
    if (!createInitialVectorizationConfig(settings, chunking)) {
        return { action: 'blocked', reason: 'The selected vectorization settings could not be described.' };
    }

    const binding = await ensureChatBinding();
    if (!binding?.writable || !binding.collectionId) {
        return { action: 'blocked', reason: "This chat's collection identity could not be verified.",
            unverifiedClaim: binding?.unverifiedClaim === true }; // VH-083: index.js offers a new collection
    }
    const collectionId = binding.collectionId;

    // VH-052: this chat's vectors are on another backend/server. Sync cannot
    // reach them; re-vectorizing (the staged rebuild) makes a new collection
    // here and keeps the old one where it is.
    {
        const { collectionLivesElsewhere, describeStore, backendLabel } = await import('./backend-elsewhere.js');
        const elsewhere = collectionLivesElsewhere(collectionId, settings);
        if (elsewhere.length) {
            return {
                action: 'rebuild', collectionId, chunkCount: 0, differences: [],
                annotationCount: getAnnotatedChunkHashes(collectionId).length,
                reason: `This chat's memories are on ${[...new Set(elsewhere.map(describeStore))].join(' and ')}. ` +
                    `Switch back to use them, or re-vectorize this chat on ${backendLabel(settings.vector_backend)} ` +
                    '(a new collection is made here; the old one is kept).',
            };
        }
    }

    let chunkCount = 0;
    try {
        const hashes = await getSavedHashes(collectionId, settings, false, getStopSignal());
        chunkCount = Array.isArray(hashes) ? hashes.length : 0;
    } catch (error) {
        return { action: 'blocked', reason: `The existing collection could not be read: ${error.message}` };
    }

    let saved;
    try {
        saved = await readInitialVectorizationConfig(collectionId, settings);
    } catch (error) {
        return { action: 'blocked', reason: `The original configuration could not be read: ${error.message}` };
    }

    if (saved.status === 'valid' && saved.config?.chunking?.pipeline === 'scene-markers') {
        // A scene marked before the chat's first Sync recorded the collection's
        // write-once settings as a scene collection, so Sync can never use it.
        // The staged rebuild makes a proper chat collection; the old one (with
        // its scenes) is kept and can be deleted later.
        return {
            action: 'rebuild', collectionId, chunkCount, differences: [],
            annotationCount: getAnnotatedChunkHashes(collectionId).length,
            reason: 'This chat\'s collection was started by a scene marker before the chat was synced, so Sync cannot use it. ' +
                'Rebuilding creates a proper chat collection; the old one (with its scenes) is kept.',
        };
    }
    // 9c: legacy Qdrant multitenancy is read-only once the plugin offers the
    // new layouts; re-vectorizing (the staged rebuild) moves the chat.
    if (saved.status === 'valid' && resolveStorage(collectionId, settings).layout === 'legacy-mt' &&
        await scopedTenancySupported()) {
        return {
            action: 'rebuild', collectionId, chunkCount, differences: [],
            annotationCount: getAnnotatedChunkHashes(collectionId).length,
            reason: 'This chat is stored in the old shared Qdrant store (multitenancy), which is read-only now. ' +
                'Rebuilding re-vectorizes it into the new store; the old copy is kept until you delete it.',
        };
    }
    if (saved.status === 'valid') {
        // 9b/9c: compare against THIS collection's storage (its recorded
        // location), not today's switch, which only decides new collections.
        // VH-110: Sync keeps the chat's own saved chunking; only settings that
        // can be selected (provider, model, backend, storage) are compared.
        const syncSettings = withSavedChatChunking(settings, saved);
        const comparison = compareInitialVectorizationConfig(saved.config,
            createInitialVectorizationConfig(settingsForCollectionStorage(collectionId, syncSettings),
                chatConfigChunking(syncSettings)), 'sync-chat');
        if (comparison.status === 'incompatible') {
            return {
                action: 'rebuild', collectionId, chunkCount,
                differences: comparison.differences,
                annotationCount: getAnnotatedChunkHashes(collectionId).length,
                reason: 'The selected settings differ from the settings this chat was vectorized with.',
            };
        }
        // 'cannot_verify' is not a licence to rebuild on its own: the existing
        // collection keeps its own recorded settings. A rebuild the user asked
        // for explicitly is still available (rebuildable), with no difference
        // list because the selected settings reproduce the saved ones.
        return {
            action: 'vectorize', collectionId, chunkCount, rebuildable: chunkCount > 0,
            differences: [], annotationCount: getAnnotatedChunkHashes(collectionId).length,
        };
    }

    // No authoritative configuration. With no vectors there is nothing to
    // replace, so a normal first vectorization applies.
    if (chunkCount === 0) return { action: 'vectorize', collectionId, chunkCount };

    return {
        action: 'rebuild', collectionId, chunkCount, differences: [],
        annotationCount: getAnnotatedChunkHashes(collectionId).length,
        reason: saved.status === 'missing'
            ? 'This chat\'s memories were made by an older VectHare that did not record its settings, so Sync cannot add to them. Re-vectorize to rebuild them.'
            : `The original configuration could not be verified (${saved.status}).`,
    };
}

/**
 * Phase 3: rebuilds this chat's collection into a NEW collection and switches
 * the chat to it only after the replacement has been verified.
 *
 * The old collection is never purged first, and is never deleted here: after a
 * successful switch it is retained as an inspectable cleanup candidate (listed
 * in the Database Browser), because authorization to destroy vectors is not
 * implied by a settings change.
 *
 * @param {object} settings VectHare settings as selected now
 * @param {number} batchSize Items per vectorization pass
 * @returns {Promise<{success: boolean, collectionId?: string, previousCollectionId?: string,
 *   reason?: string, committed?: boolean}>}
 */
export async function rebuildChatCollection(settings, batchSize) {
    assertStoreAuthoritative('Rebuilding a chat collection');
    // 8C: the chat's current collection stays leased for the whole rebuild,
    // so another tab cannot sync into it or delete it meanwhile (the new
    // collection is leased by the Sync run that fills it).
    await refreshStoreIfStale({ minIntervalMs: 0 }).catch(() => false);
    const currentId = peekChatCollectionId();
    let lease = null;
    if (currentId) {
        try {
            lease = await acquireLease(currentId, { label: 'Rebuild', isPaused: isVectorizationPaused });
        } catch (error) {
            if (error?.code === 'VH_LEASE_HELD') return { success: false, reason: error.message };
            throw error;
        }
    }
    try {
        return await rebuildChatCollectionLeased(settings, batchSize);
    } finally {
        await lease?.release();
    }
}

async function rebuildChatCollectionLeased(settings, batchSize) {
    const target = captureChatTarget();
    if (!target) return { success: false, reason: 'No chat is open.' };

    const binding = await ensureChatBinding();
    if (!binding?.writable || !binding.collectionId) {
        return { success: false, reason: "This chat's collection identity could not be verified." };
    }
    const previousCollectionId = binding.collectionId;
    const stagedCollectionId = mintChatCollectionId();

    // A durable record of the staging attempt, so an interrupted rebuild is
    // identifiable afterwards instead of leaving an unexplained collection.
    setCollectionMeta(stagedCollectionId, {
        scope: 'chat',
        rebuildFrom: previousCollectionId,
        rebuildState: 'staging',
        rebuildStartedAt: Date.now(),
    });
    try {
        await flushVectHareStore();
    } catch (error) {
        return { success: false, reason: `The rebuild could not be recorded: ${error.message}` };
    }

    let result;
    if (!beginChatCollectionRebuild(stagedCollectionId)) {
        return { success: false, reason: 'The rebuild destination could not be bound to this chat.' };
    }
    // S5: the embedding part uses the first 85% of the bar; verifying, switching
    // and carrying over use the rest, so the bar does not reach 100% early.
    progressTracker.queueBarRange(0, 85);
    try {
        result = await vectorizeAll(settings, batchSize, true);
    } catch (error) {
        progressTracker.clearBarRange();
        endChatCollectionRebuild();
        setCollectionMeta(stagedCollectionId, { rebuildState: 'failed', rebuildError: error.message });
        persistVectHareStore();
        return { success: false, collectionId: stagedCollectionId, previousCollectionId,
            reason: `Embedding into the replacement collection failed: ${error.message}` };
    }

    progressTracker.clearBarRange();
    // Verify the replacement on its own terms before anything is switched.
    let verification = null;
    let carried = [];
    let annotations = { transferred: 0, skipped: 0 };
    let transferError = null;
    let followRun = null;
    const followPhase = (text, percent) => {
        if (followRun == null || !progressTracker.isCurrentRun(followRun)) return;
        progressTracker.setPhase(text);
        progressTracker.setWeightedPercent(percent);
    };
    const followEnd = (success, message) => {
        if (followRun != null && progressTracker.isCurrentRun(followRun)) {
            progressTracker.complete(success, message, followRun);
        }
    };
    try {
        if (!result?.success) throw new Error('vectorization did not complete');
        followRun = progressTracker.beginFollowUp(phaseText('Verifying new collection', 1, 3), 85);
        if (!isChatTargetCurrent(target, stagedCollectionId)) {
            throw new Error('the chat changed during the rebuild');
        }
        const hashes = await getSavedHashes(stagedCollectionId, settings, false, getStopSignal());
        const stored = Array.isArray(hashes) ? hashes.length : 0;
        if (stored === 0) throw new Error('the replacement collection is empty');
        const savedConfig = await readInitialVectorizationConfig(stagedCollectionId, settings);
        if (savedConfig.status !== 'valid') {
            throw new Error(`the replacement has no verifiable configuration (${savedConfig.status})`);
        }
        // 9c: compare with the replacement's own storage (a new collection may be
        // in the new layout, which today's switch alone does not describe).
        const comparison = compareInitialVectorizationConfig(savedConfig.config,
            createInitialVectorizationConfig(settingsForCollectionStorage(stagedCollectionId, settings),
                chatConfigChunking(settings)), 'sync-chat');
        if (comparison.status === 'incompatible') {
            throw new Error('the replacement was not stored with the selected settings');
        }
        verification = { stored, hashes: Array.isArray(hashes) ? hashes.map(String) : [],
            identityLedger: savedConfig.config.identityLedger === 1 };
        progressTracker.log(`Verified: ${stored} chunk(s) stored with the selected settings`);
    } catch (error) {
        followEnd(false, `Replacement not verified - your previous collection is still in use`);
        endChatCollectionRebuild();
        setCollectionMeta(stagedCollectionId, { rebuildState: 'unverified', rebuildError: error.message });
        persistVectHareStore();
        // The chat is still bound to its previous collection, untouched.
        return { success: false, collectionId: stagedCollectionId, previousCollectionId,
            reason: `The replacement could not be verified: ${error.message}. ` +
                'Your previous collection is still in use.' };
    }

    // Commit: the chat adopts the verified replacement and the old collection
    // is preserved, not deleted.
    try {
        followPhase(phaseText('Switching chat to new collection', 2, 3), 90);
        const adopted = await adoptChatCollection(stagedCollectionId, previousCollectionId);
        if (adopted.state !== 'active') {
            throw new Error(`binding state "${adopted.state}"`);
        }
        setCollectionMeta(stagedCollectionId, {
            rebuildState: 'committed', rebuildCommittedAt: Date.now(), rebuildError: null,
        });
        setCollectionMeta(previousCollectionId, { supersededBy: stagedCollectionId, supersededAt: Date.now() });
        // The replacement's own vectorization record is already authoritative;
        // what carries over is only what the USER configured, plus annotations
        // for chunks the rebuild actually reproduced. The replaced collection
        // keeps its own copy: it is retained, not deleted.
        // The rebuild is already committed at this point, so a transfer problem
        // is reported, never mistaken for a failed switch.
        try {
            followPhase(phaseText('Carrying annotations', 3, 3), 95);
            carried = carryOverCollectionPreferences(previousCollectionId, stagedCollectionId);
            annotations = transferCollectionAnnotations(previousCollectionId, stagedCollectionId,
                verification.hashes);
            progressTracker.log(`Carried ${annotations.transferred} annotation(s)` +
                `${annotations.skipped ? `, ${annotations.skipped} not carried` : ''}`);
        } catch (error) {
            transferError = error.message;
            console.warn(`VectHare: Rebuilt collection settings could not be carried over: ${error.message}`);
        }
        await flushVectHareStore();
    } catch (error) {
        followEnd(false, 'Could not switch the chat - your previous collection is still in use');
        setCollectionMeta(stagedCollectionId, { rebuildState: 'verified_uncommitted', rebuildError: error.message });
        persistVectHareStore();
        return { success: false, collectionId: stagedCollectionId, previousCollectionId,
            reason: `The replacement is complete but the chat could not be switched to it: ${error.message}. ` +
                'Your previous collection is still in use.' };
    } finally {
        endChatCollectionRebuild();
    }

    followEnd(true, `Rebuilt ${verification.stored} chunks \u2014 old collection kept: ${previousCollectionId}` +
        `${transferError ? ' (settings/annotations not fully carried over)' : ''}`);
    vhLog(`VectHare: Rebuilt ${previousCollectionId} as ${stagedCollectionId} ` +
        `(${verification.stored} chunks, ledger ${verification.identityLedger ? 'enabled' : 'not used'})`);
    return { success: true, committed: true, collectionId: stagedCollectionId,
        previousCollectionId, chunkCount: verification.stored,
        carriedFields: carried, annotationsTransferred: annotations.transferred,
        annotationsNotTransferred: annotations.skipped, transferError };
}

// ---------------------------------------------------------------------------
// N2: re-attach a deleted chat's kept collection
// ---------------------------------------------------------------------------
export const REATTACH_MIN_RATIO = 0.6;
const REATTACH_MIN_MATCHES = 2;

/** Share of a ledger's unique message keys that appear in the current chat. */
export async function scoreDeletedChatLedger(ledger, chat) {
    const previous = (ledger?.messages || []).filter(msg => msg && msg.active !== false);
    const current = await describeIdentityMessages(chat);
    const fp = msg => `${msg.role}:${msg.name}:${msg.fingerprint}`;
    const uniqueOf = (items, keyOf) => {
        const counts = new Map();
        for (const item of items) {
            const key = keyOf(item);
            if (key) counts.set(key, (counts.get(key) || 0) + 1);
        }
        return new Set([...counts].filter(([, n]) => n === 1).map(([key]) => key));
    };
    const score = (keyOf) => {
        const wanted = uniqueOf(previous, keyOf);
        const present = new Set(current.map(keyOf).filter(Boolean));
        const matched = [...wanted].filter(key => present.has(key)).length;
        return { matched, total: wanted.size, ratio: wanted.size ? matched / wanted.size : 0 };
    };
    const bySource = score(msg => msg.sourceKey || null);
    const byFingerprint = score(msg => (msg.fingerprint ? fp(msg) : null));
    const best = bySource.ratio >= byFingerprint.ratio ? bySource : byFingerprint;
    return { ...best, bySource, byFingerprint,
        qualifies: best.ratio >= REATTACH_MIN_RATIO && best.matched >= REATTACH_MIN_MATCHES };
}

/**
 * Before a chat without a binding gets a NEW collection, look for a kept
 * collection of a deleted chat of the same owner whose identity ledger matches
 * this chat (>= 60% of its unique send-date keys or fingerprints). Exactly one
 * candidate -> ask the user. Yes re-binds it to this chat, and the next Sync's
 * normal reconcile treats the differences as edits/inserts/deletes. No, an
 * ambiguous match, or any read failure -> nothing happens (a new collection is
 * created as before).
 * @param {object} settings VectHare settings
 * @returns {Promise<{reattached: boolean, collectionId?: string}>}
 */
export async function offerDeletedChatReattach(settings, { confirmReattach = null } = {}) {
    try {
        const target = captureChatTarget();
        if (!target) return { reattached: false };
        const existing = await ensureChatBinding(undefined, { create: false });
        if (existing?.state !== 'unbound') return { reattached: false };
        const owner = getChatOwner();
        const candidates = listDeletedChatCollections().filter(({ info }) =>
            info.rec?.owner && owner && info.rec.owner.type === owner.type &&
            String(info.rec.owner.id) === String(owner.id));
        if (!candidates.length) return { reattached: false };

        const qualified = [];
        for (const { id, info } of candidates) {
            const stores = (info.rec.stores || []).filter(store => store.destination &&
                chatStoreDestination({ ...settings, vector_backend: store.backend }, id) === store.destination);
            if (stores.length !== 1) continue;
            const storeSettings = { ...settings, vector_backend: stores[0].backend, source: stores[0].source };
            const saved = await readInitialVectorizationConfig(id, storeSettings);
            if (saved.status !== 'valid' || saved.config?.identityLedger !== 1) continue;
            let ledger;
            try {
                const read = await identityLedgerRequest('read', id, identityBinding(storeSettings, saved.config));
                if (read.status !== 'found') continue;
                ledger = read.ledger;
            } catch { continue; }
            if (!isChatTargetCurrent(target)) return { reattached: false };
            const score = await scoreDeletedChatLedger(ledger, target.messages);
            if (score.qualifies) qualified.push({ id, info, score });
        }
        // Ambiguous -> ask nothing, create new.
        if (qualified.length !== 1) return { reattached: false };
        const [{ id, info, score }] = qualified;

        const ask = confirmReattach || (async () => {
            const { callGenericPopup, POPUP_TYPE } = await import('../../../../popup.js');
            return callGenericPopup(
                `<div style="text-align:left;">
                    <h3>Re-use memories of a deleted chat?</h3>
                    <p>This looks like a chat you deleted (<strong>${score.matched} of ${score.total}</strong> messages match).</p>
                    <p style="margin-top:10px;">Re-use its memories? Only the differences are vectorized again.
                    Choosing No creates a new collection; the deleted chat's collection stays in Database Browser.</p>
                </div>`,
                POPUP_TYPE.CONFIRM, '', { okButton: 'Yes, re-use', cancelButton: 'No, start new' });
        });
        const accepted = await ask({ collectionId: id, matched: score.matched, total: score.total });
        if (!accepted || !isChatTargetCurrent(target)) return { reattached: false };
        const result = await reattachChatCollection(id, info.rec);
        if (result?.state !== 'active') {
            toastr.warning('The deleted chat\'s memories could not be re-attached; a new collection will be used.', 'VectHare');
            return { reattached: false };
        }
        clearDeletedChatInfo(id);
        try { await flushVectHareStore(); } catch { /* saved with the next write */ }
        toastr.success(`Re-attached the deleted chat's memories (${score.matched} of ${score.total} messages matched).`, 'VectHare');
        return { reattached: true, collectionId: id };
    } catch (error) {
        console.warn('VectHare: Deleted-chat re-attach check skipped:', error.message);
        return { reattached: false };
    }
}

/**
 * Phase 2: removes the identity ledger belonging to one collection, for the
 * exact destination recorded in its own saved configuration. Returns false
 * when no ledger destination can be established - an unknown destination is
 * never guessed at, so nothing else's ledger can be removed by mistake.
 * @param {string} collectionId Collection identifier
 * @param {object} settings VectHare settings
 * @returns {Promise<boolean>} Whether a ledger was deleted or already absent
 */
export async function discardIdentityLedgerForCollection(collectionId, settings) {
    const saved = await readInitialVectorizationConfig(collectionId, settings, {
        backend: settings.vector_backend || 'standard',
        source: settings.source,
    });
    if (saved.status !== 'valid' || !saved.config) return false;
    await identityLedgerRequest('save', collectionId, identityBinding(settings, saved.config), null);
    return true;
}

// Stage 13.0: message-occurrence identity is kept only in VectHare plugin data.
// SillyTavern chat objects/files are read, never annotated or saved.
function identityBinding(settings, config) {
    return {
        backend: settings.vector_backend || 'standard',
        source: config.embedding.provider,
        model: config.embedding.model || '',
        storage: config.storage,
        chunking: config.chunking,
    };
}

// Step 8B: a ledger object carries the file version it was read as, or last
// saved as, in `__token` (copied along by `{ ...ledger }`, never sent as part
// of the ledger). A save names that version; the plugin refuses it with 409 if
// another tab changed the file in between.
export class LedgerConflictError extends Error {
    constructor() {
        super('Another tab is updating this chat\'s vectors - this pass stopped before changing anything it had not confirmed');
        this.code = 'VH_LEDGER_CONFLICT';
    }
}
const ledgerTokensSeen = { value: false }; // true once the plugin returned a ledger token
const stripLedgerToken = ledger => {
    if (!ledger || typeof ledger !== 'object') return ledger;
    const { __token, ...rest } = ledger;
    return rest;
};

async function identityLedgerRequest(action, collectionId, binding, ledger = undefined, baseToken = undefined) {
    const response = await fetch(`/api/plugins/similharity/identity-ledger/${action}`, {
        method: 'POST', headers: getRequestHeaders(),
        // Reads honor Stop; a save is never abandoned half-way (outcome unknown).
        ...(action === 'read' ? { signal: getStopSignal() } : {}),
        body: JSON.stringify({ collectionId, binding,
            ...(ledger !== undefined ? { ledger: stripLedgerToken(ledger) } : {}),
            ...(baseToken !== undefined ? { baseToken } : {}) }),
    });
    if (response.status === 409 && action === 'save') {
        const body = await response.json().catch(() => null);
        if (body?.conflict === true) throw new LedgerConflictError();
    }
    if (!response.ok) {
        const error = new Error(`Identity ledger ${action}: HTTP ${response.status}`);
        error.status = response.status;
        throw error;
    }
    const result = await response.json();
    if (result.success !== true) throw new Error('Identity ledger operation was not confirmed');
    if (typeof result.token === 'string') ledgerTokensSeen.value = true;
    return result;
}

/** Saves `ledger` based on the version it carries, then records the new one on it. */
async function saveLedgerVersioned(ledger, baseToken = ledger?.__token) {
    if (ledgerTokensSeen.value && baseToken === undefined) {
        // Every save must say which version it replaces; a missing token is a
        // bug that would silently bypass the protection, so it fails closed.
        throw new Error('Identity ledger save without a version; blocked');
    }
    const result = await identityLedgerRequest('save', ledger.collectionId, ledger.binding, ledger, baseToken);
    if (typeof result.token === 'string') ledger.__token = result.token;
    return ledger;
}

const emptyIdentityLedger = (collectionId, binding) => ({
    version: 1, state: 'clean', pending: null, collectionId, binding, messages: [], groups: [],
});

async function readChatIdentityLedger(collectionId, settings, config, creating = false) {
    // Native Standard writes omit chunk provenance; never mark them as
    // ledger-verified even if the ledger HTTP routes happen to respond.
    if (['standard', 'vectra'].includes(settings.vector_backend || 'standard')) {
        const backend = await getBackend(settings);
        if (!backend.pluginAvailable) throw new Error('Identity tracking requires plugin-backed Standard inserts');
    }
    const binding = identityBinding(settings, config);
    const result = await identityLedgerRequest('read', collectionId, binding);
    if (result.status === 'found') {
        const ledger = result.ledger;
        if (typeof result.token === 'string') ledger.__token = result.token;
        return ledger;
    }
    if (creating && result.status === 'missing') {
        const ledger = emptyIdentityLedger(collectionId, binding);
        // Another tab creating the same ledger first makes this a conflict.
        await saveLedgerVersioned(ledger, typeof result.token === 'string' ? result.token : undefined);
        return ledger;
    }
    const error = new Error(`Identity ledger ${result.status || 'unavailable'}; destructive actions blocked`);
    error.ledgerStatus = result.status;
    error.ledgerToken = result.token;
    throw error;
}

async function saveChatIdentityLedger(ledger) {
    await saveLedgerVersioned(ledger);
}

// A match fingerprint includes speaker identity but no stored message text.
// #44: every Sync pass re-describes the whole chat. The digest is the expensive
// part, so an unchanged message reuses its previous fingerprint. Keyed by the
// message object AND its exact digest input, so an edit always recomputes.
const identityFingerprintCache = new WeakMap();
async function identityFingerprint(message, role, name) {
    const input = JSON.stringify([role, name, getTextWithoutAttachments(message)]);
    const cached = identityFingerprintCache.get(message);
    if (cached?.input === input) return cached.fingerprint;
    const fingerprint = await sha256Text(input);
    if (message && typeof message === 'object') {
        identityFingerprintCache.set(message, { input, fingerprint });
    }
    return fingerprint;
}

async function describeIdentityMessages(chat) {
    return Promise.all(chat.map(async (message, position) => {
        if (message.is_system) return null;
        const role = message.is_user ? 'user' : 'character';
        const name = String(message.name || '');
        const fingerprint = await identityFingerprint(message, role, name);
        // ST's read-only send timestamp is helpful for edits where text changes.
        // Only unique keys can be claimed; never write UIDs into chat objects.
        const stamp = message.send_date;
        const sourceKey = (typeof stamp === 'number' && Number.isFinite(stamp)) ||
            (typeof stamp === 'string' && stamp.trim())
            ? JSON.stringify([String(stamp), role, name]) : null;
        return { position, role, name, fingerprint, sourceKey };
    })).then(items => items.filter(Boolean));
}

// Match only unambiguous occurrences. Positional matching by itself is never
// evidence; a one-for-one edit requires confirmed anchors on BOTH sides.
async function reconcileIdentityMessages(chat, ledger) {
    const previous = ledger.messages.filter(msg => msg.active !== false);
    const current = await describeIdentityMessages(chat);
    const oldUsed = new Set(), newUsed = new Set(), uidByPosition = new Map();
    const claim = (oldIndex, newIndex) => {
        oldUsed.add(oldIndex); newUsed.add(newIndex);
        uidByPosition.set(current[newIndex].position, previous[oldIndex].uid);
    };
    const matches = (item) => `${item.role}:${item.name}:${item.fingerprint}`;
    // A unique stable read-only source key is stronger evidence for edits than
    // an index or equal sequence length. Timestamp collisions remain unclaimed.
    const keyedOld = new Map(), keyedNew = new Map();
    previous.forEach((msg, i) => {
        if (msg.sourceKey) keyedOld.set(msg.sourceKey, [...(keyedOld.get(msg.sourceKey) || []), i]);
    });
    current.forEach((msg, i) => {
        if (msg.sourceKey) keyedNew.set(msg.sourceKey, [...(keyedNew.get(msg.sourceKey) || []), i]);
    });
    for (const [key, indices] of keyedOld) {
        const fresh = keyedNew.get(key) || [];
        // Phase 4: a stable source key held by several messages (two messages
        // from the same author within one send_date granularity) used to go
        // unmatched entirely. An EDITED message among them was then given a new
        // UID, so Repair could not recognise its group as a replacement of a
        // formerly indexed one - while Sync embedded the new text as new
        // content. That is the reported Repair/Sync discrepancy.
        //
        // When both sides hold the same number of occurrences of that immutable
        // key, chat order is the only order-preserving correspondence between
        // them, so the occurrences are paired by ordinal. Differing counts stay
        // unmatched: an insert or delete within that key is not an edit, and
        // remains uncertain rather than guessed at.
        if (indices.length !== fresh.length) continue;
        indices.forEach((oldIndex, occurrence) => {
            const newIndex = fresh[occurrence];
            if (previous[oldIndex].role === current[newIndex].role &&
                previous[oldIndex].name === current[newIndex].name) claim(oldIndex, newIndex);
        });
    }
    // An unchanged complete sequence is unambiguous as a sequence, including
    // multiple identical occurrences. No UID churn on repeated Sync/Repair.
    if (previous.length === current.length &&
        previous.every((msg, i) => matches(msg) === matches(current[i]))) {
        // Exact unchanged sequence; ordinal duplicate identities are stable.
        previous.forEach((_msg, i) => {
            if (!oldUsed.has(i) && !newUsed.has(i)) claim(i, i);
        });
    }
    // Unique unchanged messages remain identifiable after any position shift.
    const byOld = new Map(), byNew = new Map();
    previous.forEach((item, i) => {
        const key = matches(item);
        byOld.set(key, [...(byOld.get(key) || []), i]);
    });
    current.forEach((item, i) => {
        const key = matches(item);
        byNew.set(key, [...(byNew.get(key) || []), i]);
    });
    for (const [key, oldIndices] of byOld) {
        const newIndices = byNew.get(key) || [];
        if (oldIndices.length === 1 && newIndices.length === 1 &&
            !oldUsed.has(oldIndices[0]) && !newUsed.has(newIndices[0])) claim(oldIndices[0], newIndices[0]);
    }
    // Within two matched neighbours, an unchanged repeated-text run can be
    // associated one-to-one only when both gaps contain the same occurrences.
    const oldIndexByUid = new Map(previous.map((msg, i) => [msg.uid, i]));
    const newIndexByPosition = new Map(current.map((msg, i) => [msg.position, i]));
    const ordered = [...uidByPosition.entries()].map(([position, uid]) => ({
        old: oldIndexByUid.get(uid) ?? -1,
        now: newIndexByPosition.get(position) ?? -1,
    })).filter(pair => pair.old >= 0 && pair.now >= 0)
        .sort((a, b) => a.old - b.old);
    for (let a = 0; a < ordered.length - 1; a++) {
        const left = ordered[a], right = ordered[a + 1];
        if (left.now >= right.now) continue; // moved anchors are not a gap boundary
        const oldGap = [], newGap = [];
        for (let i = left.old + 1; i < right.old; i++) if (!oldUsed.has(i)) oldGap.push(i);
        for (let i = left.now + 1; i < right.now; i++) if (!newUsed.has(i)) newGap.push(i);
        if (oldGap.length !== newGap.length || !oldGap.length) continue;
        const sameText = oldGap.every((i, j) => matches(previous[i]) === matches(current[newGap[j]]));
        if (sameText) oldGap.forEach((i, j) => claim(i, newGap[j]));
        // Different text between anchors may be edit OR remove+insert.
        // Without a persistent read-only source key we cannot prove which.

    }
    // Unmatched unique fingerprints can identify reordered messages.
    const oldRemaining = new Map(), newRemaining = new Map();
    previous.forEach((msg, i) => {
        if (oldUsed.has(i)) return;
        const key = matches(msg);
        oldRemaining.set(key, [...(oldRemaining.get(key) || []), i]);
    });
    current.forEach((msg, i) => {
        if (newUsed.has(i)) return;
        const key = matches(msg);
        newRemaining.set(key, [...(newRemaining.get(key) || []), i]);
    });
    for (const [key, oldIndices] of oldRemaining) {
        const newIndices = newRemaining.get(key) || [];
        if (oldIndices.length === 1 && newIndices.length === 1 &&
            !oldUsed.has(oldIndices[0]) && !newUsed.has(newIndices[0])) claim(oldIndices[0], newIndices[0]);
    }
    // VH-031: a character (or persona) renamed by SillyTavern on past messages
    // changes the name inside every identity key above, so each message looked
    // new and turn/batch chunks fell apart. For messages still unmatched, two
    // name-blind checks follow, each one-to-one and only across a name change:
    //  1. the same send time and role (unique on both sides);
    //  2. the same text and role: the old fingerprint is recomputed with the
    //     old name (the ledger stores no text, only that digest).
    const unclaimedOld = () => previous.map((_m, i) => i).filter(i => !oldUsed.has(i));
    const unclaimedNew = () => current.map((_m, i) => i).filter(i => !newUsed.has(i));
    const stampOf = sourceKey => {
        try { const parsed = JSON.parse(sourceKey); return Array.isArray(parsed) ? String(parsed[0]) : null; }
        catch { return null; }
    };
    if (unclaimedOld().length && unclaimedNew().length) {
        const byStampOld = new Map(), byStampNew = new Map();
        for (const i of unclaimedOld()) {
            const stamp = previous[i].sourceKey ? stampOf(previous[i].sourceKey) : null;
            if (stamp) { const key = JSON.stringify([stamp, previous[i].role]); byStampOld.set(key, [...(byStampOld.get(key) || []), i]); }
        }
        for (const i of unclaimedNew()) {
            const stamp = current[i].sourceKey ? stampOf(current[i].sourceKey) : null;
            if (stamp) { const key = JSON.stringify([stamp, current[i].role]); byStampNew.set(key, [...(byStampNew.get(key) || []), i]); }
        }
        for (const [key, oldIndices] of byStampOld) {
            const newIndices = byStampNew.get(key) || [];
            if (oldIndices.length === 1 && newIndices.length === 1 &&
                previous[oldIndices[0]].name !== current[newIndices[0]].name &&
                !oldUsed.has(oldIndices[0]) && !newUsed.has(newIndices[0])) claim(oldIndices[0], newIndices[0]);
        }
    }
    if (unclaimedOld().length && unclaimedNew().length) {
        const candidates = new Map(); // newIndex -> [oldIndex]
        const oldByFingerprint = new Map();
        for (const i of unclaimedOld()) {
            oldByFingerprint.set(previous[i].fingerprint, [...(oldByFingerprint.get(previous[i].fingerprint) || []), i]);
        }
        const oldNamesByRole = new Map();
        for (const i of unclaimedOld()) {
            const names = oldNamesByRole.get(previous[i].role) || new Set();
            names.add(previous[i].name);
            oldNamesByRole.set(previous[i].role, names);
        }
        for (const n of unclaimedNew()) {
            const item = current[n];
            const text = getTextWithoutAttachments(chat[item.position]);
            for (const oldName of oldNamesByRole.get(item.role) || []) {
                if (oldName === item.name) continue;
                const digest = await sha256Text(JSON.stringify([item.role, oldName, text]));
                for (const o of oldByFingerprint.get(digest) || []) {
                    if (previous[o].role === item.role && previous[o].name === oldName) {
                        candidates.set(n, [...(candidates.get(n) || []), o]);
                    }
                }
            }
        }
        const timesOldOffered = new Map();
        for (const list of candidates.values()) for (const o of list) timesOldOffered.set(o, (timesOldOffered.get(o) || 0) + 1);
        for (const [n, list] of candidates) {
            if (list.length === 1 && timesOldOffered.get(list[0]) === 1 &&
                !oldUsed.has(list[0]) && !newUsed.has(n)) claim(list[0], n);
        }
    }
    const activeMessages = current.map((msg, i) => ({
        ...msg, uid: uidByPosition.get(msg.position) || `m_${uuidv4().replace(/-/g, '').toLowerCase()}`, active: true,
    }));
    for (const msg of activeMessages) uidByPosition.set(msg.position, msg.uid);
    const activeUidSet = new Set(activeMessages.map(msg => msg.uid));
    const activeIndexByUid = new Map(activeMessages.map((msg, i) => [msg.uid, i]));
    const inactive = ledger.messages.filter(msg => msg.active === false ||
        !activeUidSet.has(msg.uid)).map(msg => ({ ...msg, active: false }));
    const previousKeyCounts = new Map(), previousSourceCounts = new Map();
    for (const msg of previous) {
        previousKeyCounts.set(matches(msg), (previousKeyCounts.get(matches(msg)) || 0) + 1);
        if (msg.sourceKey) previousSourceCounts.set(msg.sourceKey,
            (previousSourceCounts.get(msg.sourceKey) || 0) + 1);
    }
    const activeKeys = new Set(activeMessages.map(matches));
    const activeSourceKeys = new Set(activeMessages.map(msg => msg.sourceKey).filter(Boolean));
    // An unmatched new occurrence could be an edited/moved old message.
    // Text absence alone cannot prove deletion in that case. Unique, stable
    // source keys remain sufficient evidence even when other messages are new.
    const hasUnmatchedNew = current.some((_msg, i) => !newUsed.has(i));
    // A missing message is only a confidently deleted occurrence when both
    // neighbouring persisted messages are matched, adjacent in the new chat,
    // and that old fingerprint has no indistinguishable remaining occurrence.
    const confidentDeleted = new Set();
    for (let i = 0; i < previous.length; i++) {
        if (oldUsed.has(i)) continue;
        const before = i > 0 ? previous[i - 1] : null;
        const after = i + 1 < previous.length ? previous[i + 1] : null;
        const left = before ? (activeIndexByUid.get(before.uid) ?? -1) : -1;
        const right = after ? (activeIndexByUid.get(after.uid) ?? -1) : -1;
        const interior = before && after && left >= 0 && right === left + 1;
        const first = !before && after && right === 0;
        const last = before && !after && left === activeMessages.length - 1;
        const uniqueRetiredSource = previous[i].sourceKey &&
            previousSourceCounts.get(previous[i].sourceKey) === 1 &&
            !activeSourceKeys.has(previous[i].sourceKey);
        const uniqueRetiredText = !hasUnmatchedNew && !activeKeys.has(matches(previous[i])) &&
            previousKeyCounts.get(matches(previous[i])) === 1;
        // A unique read-only source key (ST's send_date + role + name) that no
        // longer exists anywhere in the chat, held by a message that was not
        // matched by text either, is gone: deleted, or replaced in place by a
        // swipe (which carries its own send_date). Requiring adjacent
        // neighbours as well left such vectors stored forever whenever a new
        // message sat next to the gap (every swipe did), so RAG kept returning
        // abandoned swipes. A hash still used by a current group is never
        // deleted (keep-set), so this only retires the stale occurrence.
        if (uniqueRetiredSource || ((interior || first || last) && uniqueRetiredText)) {
            confidentDeleted.add(previous[i].uid);
        }
    }
    // The former immediate-neighbour check misses multi-message deletions.
    // Two ordered, surviving anchors with no messages between them now can
    // certify an entire missing run, but NEVER an edit/replacement or an
    // indistinguishable duplicate. Include guarded start/end runs as well.
    const currentAnchors = [...uidByPosition.entries()].map(([position, uid]) => ({
        old: oldIndexByUid.get(uid) ?? -1,
        now: newIndexByPosition.get(position) ?? -1,
    })).filter(pair => pair.old >= 0 && pair.now >= 0)
        .sort((a, b) => a.old - b.old);
    const anchored = [{ old: -1, now: -1 }, ...currentAnchors, {
        old: previous.length, now: activeMessages.length,
    }];
    for (let a = 0; a < anchored.length - 1; a++) {
        const left = anchored[a], right = anchored[a + 1];
        if (right.now !== left.now + 1 || right.old <= left.old + 1) continue;
        const removed = previous.slice(left.old + 1, right.old);
        if (removed.some(msg => oldUsed.has(oldIndexByUid.get(msg.uid)))) continue;
        if (removed.every(msg => (
            msg.sourceKey && previousSourceCounts.get(msg.sourceKey) === 1 &&
                !activeSourceKeys.has(msg.sourceKey)
        ) || (!hasUnmatchedNew && !activeKeys.has(matches(msg)) &&
            previousKeyCounts.get(matches(msg)) === 1))) {
            removed.forEach(msg => confidentDeleted.add(msg.uid));
        }
    }
    // Persist the difference between a verified retirement and an ambiguous
    // disappearance. Otherwise a second Sync loses the only evidence that a
    // source was deleted and an old shared-hash group can never be cleaned up.
    const allConfidentDeleted = new Set([
        ...confidentDeleted,
        ...inactive.filter(msg => msg.retiredConfirmed === true).map(msg => msg.uid),
    ]);
    const storedInactive = inactive.map(msg => ({ ...msg,
        retiredConfirmed: allConfidentDeleted.has(msg.uid) }));
    return { messages: [...activeMessages, ...storedInactive], uidByPosition,
        activeUids: new Set(activeMessages.map(m => m.uid)),
        confidentDeleted: allConfidentDeleted,
        uncertainUids: new Set([
            ...previous.filter((msg, i) => !oldUsed.has(i) &&
                !allConfidentDeleted.has(msg.uid)).map(msg => msg.uid),
            ...storedInactive.filter(msg => !msg.retiredConfirmed).map(msg => msg.uid),
        ]) };
}

async function attachIdentityGroups(chat, groupedItems, reconciliation) {
    const result = [];
    for (const item of groupedItems) {
        const ids = extractMessageIds(item.metadata);
        const memberUids = ids.map(id => reconciliation.uidByPosition.get(id));
        if (!ids.length || memberUids.some(uid => !uid)) throw new Error('Unknown source message in grouped chunk');
        const raw = ids.map(id => {
            const message = chat[id];
            const text = getTextWithoutAttachments(message);
            if (item.metadata?.strategy === 'per_message') return text;
            return `[${message.is_user ? 'User' : 'Character'}]: ${text}`;
        }).join('\n\n');
        if (String(calculateHash(raw)) !== String(item.hash)) {
            throw new Error('Identity group reconstruction does not match its existing content hash');
        }
        const hashInputFingerprint = await sha256Text(raw);
        const group = { memberUids, hash: item.hash, hashInputFingerprint, indexed: false };
        item.metadata = { ...item.metadata, messageUids: memberUids };
        result.push(group);
    }
    // A 32-bit content hash must never silently represent two different inputs.
    const seen = new Map();
    for (const group of result) {
        const key = String(group.hash);
        if (seen.has(key) && seen.get(key) !== group.hashInputFingerprint) {
            throw new Error(`Different group texts share hash ${key}; indexing blocked`);
        }
        seen.set(key, group.hashInputFingerprint);
    }
    return result;
}

const memberKey = group => group.memberUids.join('|');

// Preserve indexed and previously staged (but unfinished) UID memberships.
// Only genuinely new insertions between old groups become singleton chunks.
async function collectStableIdentityGroups(chat, settings, ledger, reconciliation, hashOnly = false) {
    const active = reconciliation.messages.filter(msg => msg.active !== false)
        .sort((a, b) => a.position - b.position);
    const indexByUid = new Map(active.map((msg, i) => [msg.uid, i]));
    const positions = [];
    const claimed = new Set();
    const planned = ledger.groups;
    if (!planned.length) return collectGroupedItems(chat, settings, hashOnly);

    // Indexed membership has priority. Only reuse an unindexed group when its
    // original members are still consecutive and its raw text is unchanged.
    for (const group of [...planned.filter(g => g.indexed).reverse(),
        ...planned.filter(g => !g.indexed).reverse()]) {
        if (!group.indexed) {
            const indices = group.memberUids.map(uid => indexByUid.get(uid));
            if (indices.some(index => index === undefined) ||
                indices.some((index, i) => i > 0 && index !== indices[i - 1] + 1) ||
                group.memberUids.some(uid => claimed.has(uid))) continue;
            const ids = indices.map(index => active[index].position);
            const original = collectGroupedItems(chat, settings, true, [ids])[0];
            const raw = ids.map(id => {
                const message = chat[id];
                const text = getTextWithoutAttachments(message);
                return original.metadata.strategy === 'per_message' ? text :
                    `[${message.is_user ? 'User' : 'Character'}]: ${text}`;
            }).join('\n\n');
            if (String(original.hash) !== String(group.hash) ||
                await sha256Text(raw) !== group.hashInputFingerprint) continue;
        }
        let run = [], previousIndex = -1;
        const flush = () => {
            if (run.length) positions.push(run.map(i => active[i].position));
            run = []; previousIndex = -1;
        };
        for (const uid of group.memberUids) {
            const index = indexByUid.get(uid);
            if (index === undefined || claimed.has(uid)) { flush(); continue; }
            if (run.length && index !== previousIndex + 1) flush();
            run.push(index);
            previousIndex = index;
            claimed.add(uid);
        }
        flush();
    }
    if (!positions.length) {
        // No surviving verified boundaries: use the configured strategy for
        // entirely new content, without claiming any historical membership.
        return collectGroupedItems(chat, settings, hashOnly);
    }
    const covered = new Set(positions.flat());
    for (let i = 0; i < active.length;) {
        if (covered.has(active[i].position)) { i++; continue; }
        let end = i + 1;
        while (end < active.length && !covered.has(active[end].position)) end++;
        const newcomers = active.slice(i, end).map(msg => msg.position);
        if (end === active.length) {
            // Only a genuinely appended tail uses initial batch/turn grouping.
            const strategy = settings.chunking_strategy || 'per_message';
            // Re-open the group that touches the tail so a short last batch or an
            // unfinished turn can absorb appended messages, as before; a full group
            // regroups identically. Without this, auto-sync fragments chunks.
            const lastAt = positions.findIndex(p => p[p.length - 1] === active[i - 1].position);
            if (lastAt >= 0) newcomers.unshift(...positions.splice(lastAt, 1)[0]);
            if (strategy === 'message_batch') {
                const size = settings.batch_size || 4;
                for (let j = 0; j < newcomers.length; j += size) {
                    positions.push(newcomers.slice(j, j + size));
                }
            } else if (strategy === 'conversation_turns') {
                const tail = newcomers.map(position => ({ index: position, is_user: chat[position].is_user }));
                for (const group of groupConversationTurns(tail, settings.conversation_turn_order)) {
                    positions.push(group.map(msg => msg.index));
                }
            } else {
                newcomers.forEach(position => positions.push([position]));
            }
        } else {
            newcomers.forEach(position => positions.push([position]));
        }
        i = end;
    }
    positions.sort((a, b) => a[0] - b[0]);
    return collectGroupedItems(chat, settings, hashOnly, positions);
}

// Read-only view of the group plan used by Sync/Repair. A new chat or a
// deliberate change of preview strategy keeps normal initial grouping.
// Never create, reset or save a ledger from preview/resume reporting.
async function collectCurrentChatGroups(chat, settings, collectionId, hashOnly = false) {
    if (!collectionId || !getCollectionRegistry().some(key =>
        parseRegistryKey(key).collectionId === collectionId)) {
        return collectGroupedItems(chat, settings, hashOnly);
    }
    const saved = await readInitialVectorizationConfig(collectionId, settings);
    if (saved.status === 'invalid' || saved.status === 'unavailable') {
        throw new Error('Cannot verify existing collection grouping for preview/resume');
    }
    if (saved.status !== 'valid' || saved.config.identityLedger !== 1 ||
        saved.config.chunking?.pipeline !== 'sync-chat') {
        return collectGroupedItems(chat, settings, hashOnly);
    }
    const requested = chatConfigChunking(settings);
    const original = saved.config.chunking;
    if (original.strategy !== requested.strategy ||
        (original.batchSize || 4) !== requested.batchSize ||
        (original.conversationTurnOrder || 'user_character') !== requested.conversationTurnOrder) {
        // A differently configured preview shows the proposed new grouping;
        // resume must not report that plan as the collection's actual backlog.
        if (hashOnly) throw new Error('Saved grouping differs from current settings');
        return collectGroupedItems(chat, settings, hashOnly);
    }
    const ledger = await readChatIdentityLedger(collectionId, settings, saved.config);
    const reconciliation = await reconcileIdentityMessages(chat, ledger);
    return collectStableIdentityGroups(chat, settings, ledger, reconciliation, hashOnly);
}

// A content hash alone is not source identity. The backend must show the
// corresponding chat provenance for at least one ledger-tracked occurrence.
function indexedChatProvenance(meta, ledger, group) {
    const p = meta?.vecthareProvenance;
    return p?.collectionId === ledger.collectionId &&
        p.recordKind === 'sync-chat' && p.sourceType === 'chat' &&
        p.sourceIdentity?.status === 'ledger-linked' &&
        Array.isArray(p.sourceIdentity.messageUids) &&
        p.sourceIdentity.messageUids.length === (group.provenanceUids || group.memberUids).length &&
        p.sourceIdentity.messageUids.every((uid, i) =>
            uid === (group.provenanceUids || group.memberUids)[i]);
}

// A hash delete removes all physical copies, not just the one whose ledger
// provenance was checked first. Every copy must belong to an indexed group
// that the caller has already determined is safe to remove.
function allPhysicalCopiesMatchGroups(ledger, hash, records, eligibleGroups) {
    return Array.isArray(records) && records.length > 0 && records.every(meta =>
        eligibleGroups.some(group => group.indexed && String(group.hash) === String(hash) &&
            indexedChatProvenance(meta, ledger, group)));
}

async function readIdentityInventory(collectionId, settings) {
    const data = await getSavedHashes(collectionId, settings, true, getStopSignal(), true);
    if (!Array.isArray(data?.hashes) || !Array.isArray(data?.metadata) ||
        data.hashes.length !== data.metadata.length) {
        throw new Error('Identity ledger requires a complete aligned backend inventory');
    }
    const byHash = new Map();
    data.hashes.forEach((hash, i) => {
        const key = String(hash);
        const records = byHash.get(key) || [];
        records.push(data.metadata[i]);
        byHash.set(key, records);
    });
    return byHash;
}

/**
 * P5: the stored records for just these hashes (every physical copy), shaped
 * like readIdentityInventory(). Uses the plugin's get-by-hashes read; when it
 * is unavailable (older plugin, Qdrant multitenancy) or its answer is not
 * complete and well-formed, falls back to the full inventory read.
 * Only for lookups of these hashes - never for "everything stored".
 */
async function readInventoryForHashes(collectionId, settings, hashes, fallback = null) {
    const wanted = [...new Set((hashes || []).map(String))];
    if (!wanted.length) return new Map();
    let result = null;
    try {
        const backend = await getBackend(settings);
        if (typeof backend.getChunksByHashes === 'function') {
            result = await backend.getChunksByHashes(collectionId, wanted, settings);
        }
    } catch (error) {
        console.debug(`VectHare: hash read unavailable for ${collectionId}, reading in full: ${error.message}`);
        result = null;
    }
    if (result?.complete === true && Array.isArray(result.items)) {
        const want = new Set(wanted);
        const byHash = new Map();
        let wellFormed = true;
        for (const item of result.items) {
            const meta = item?.metadata;
            const hash = item?.hash ?? meta?.hash;
            const text = item?.text ?? meta?.text;
            if (!meta || typeof meta !== 'object' || Array.isArray(meta) ||
                !['number', 'string'].includes(typeof hash) || typeof text !== 'string' ||
                (item.hash != null && meta.hash != null && String(item.hash) !== String(meta.hash)) ||
                (item.text != null && meta.text != null && item.text !== meta.text) ||
                !want.has(String(hash))) {
                wellFormed = false;
                break;
            }
            const key = String(hash);
            const records = byHash.get(key) || [];
            records.push({ ...meta, hash, text });
            byHash.set(key, records);
        }
        if (wellFormed) return byHash;
    }
    return fallback ? fallback() : readIdentityInventory(collectionId, settings);
}

// A missing ledger can be reconstructed only for current groups whose exact
// source indices, message hashes, original submitted text, and source UIDs
// are still attested by the backend. Stale/ambiguous historical vectors stay
// unclaimed: Repair will not delete them or manufacture edited-message UIDs.
async function rebuildMissingIdentityLedger(collectionId, settings, config, chat) {
    const binding = identityBinding(settings, config);
    const inventory = await readIdentityInventory(collectionId, settings);
    const items = collectGroupedItems(chat, settings);
    const descriptions = await describeIdentityMessages(chat);
    const claimed = new Map();
    const groupClaims = new Map();
    const usedUids = new Set();
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const ids = extractMessageIds(item.metadata);
        const candidates = [];
        for (const variant of textVariants(item)) {
            const textFingerprint = `sha256:${await sha256Text(variant.text)}`;
            for (const meta of inventory.get(String(item.hash)) || []) {
                if (!candidates.includes(meta) &&
                    chatRecordMatchesItem(meta, variant, collectionId, textFingerprint)) candidates.push(meta);
            }
        }
        // Multiple physical records or a UID that maps to conflicting positions
        // cannot establish a unique historical occurrence.
        if (candidates.length !== 1) continue;
        const uids = candidates[0].vecthareProvenance.sourceIdentity.messageUids;
        if (new Set(uids).size !== uids.length || uids.some((uid, j) =>
            usedUids.has(uid) || (claimed.has(ids[j]) && claimed.get(ids[j]) !== uid))) continue;
        ids.forEach((id, j) => { claimed.set(id, uids[j]); usedUids.add(uids[j]); });
        groupClaims.set(i, uids);
    }
    const messages = descriptions.map(msg => ({
        ...msg, uid: claimed.get(msg.position) || `m_${uuidv4().replace(/-/g, '').toLowerCase()}`,
        active: true,
    }));
    const uidByPosition = new Map(messages.map(msg => [msg.position, msg.uid]));
    const groups = await attachIdentityGroups(chat, items, { uidByPosition });
    const trusted = groups.filter((group, i) => groupClaims.has(i) &&
        group.memberUids.every((uid, j) => uid === groupClaims.get(i)[j]))
        .map(group => ({ ...group, indexed: true }));
    // A nonempty collection with no verifiable group identity is not a
    // reconstructable ledger. Do not persist invented UIDs as a clean history.
    if (inventory.size > 0 && trusted.length === 0) {
        throw new Error('Existing vectors lack verifiable message identities; ledger rebuild blocked');
    }
    const ledger = { ...emptyIdentityLedger(collectionId, binding), messages, groups: trusted };
    // Existing unclaimed vectors are deliberately not considered repairable.
    // Confirm every reconstructed group before committing it as indexed.
    if (!trusted.every(group => verifiedGroupHash(ledger, group, inventory))) {
        throw new Error('Backend identity evidence changed; ledger rebuild blocked');
    }
    // Rebuilt only when the read found no ledger: it must still be missing.
    await saveLedgerVersioned(ledger, ledgerTokensSeen.value ? 'missing' : undefined);
    console.info(`VectHare: Rebuilt ${trusted.length} verified groups for the current chat; unverified vectors retained`);
    return ledger;
}

// An identical-text occurrence can share a physical vector whose provenance
// names a different (now retired) occurrence. Carry that attested UID tuple in
// the surviving group, rather than retaining phantom historical message rows.
function verifiedGroupProvenance(ledger, group, inventory) {
    const records = inventory.get(String(group.hash)) || [];
    for (const meta of records) {
        if (ledger.groups.some(known =>
            String(known.hash) === String(group.hash) &&
            known.hashInputFingerprint === group.hashInputFingerprint &&
            indexedChatProvenance(meta, ledger, known))) {
            return [...meta.vecthareProvenance.sourceIdentity.messageUids];
        }
    }
    return null;
}

function verifiedGroupHash(ledger, group, inventory) {
    return verifiedGroupProvenance(ledger, group, inventory) !== null;
}

async function stageIdentityLedger(ledger, insertHashes, deleteHashes, reconciliation, currentGroups) {
    if (ledger.state !== 'clean') throw new Error('Identity ledger is dirty; writes blocked until verification');
    if (!insertHashes.length && !deleteHashes.length) return;
    // Keep confirmed indexed memberships and stage source UIDs as *unindexed*
    // so a crash cannot erase the identity of just-attempted vector writes.
    const existing = new Set(ledger.groups.map(g => `${memberKey(g)}:${g.hash}`));
    const groups = [...ledger.groups];
    for (const group of currentGroups) {
        const key = `${memberKey(group)}:${group.hash}`;
        if (!existing.has(key)) {
            groups.push({ ...group, indexed: false });
            existing.add(key);
        }
    }
    const next = { ...ledger, messages: reconciliation.messages, groups,
        state: 'dirty', pending: {
            insertHashes: [...new Set(insertHashes.map(String))],
            deleteHashes: [...new Set(deleteHashes.map(String))],
        } };
    await saveChatIdentityLedger(next); // REQUIRED before first backend mutation
    Object.assign(ledger, next);
}

async function finishIdentityLedger(ledger, reconciliation, currentGroups, inventory) {
    const currentByKey = new Map(currentGroups.map(g => [`${memberKey(g)}:${g.hash}`, g]));
    const currentKeys = new Set(currentByKey.keys());
    const indexedCurrent = currentGroups.map(group => {
        const attested = verifiedGroupProvenance(ledger, group, inventory);
        if (!attested) return null;
        const sameSource = attested.length === group.memberUids.length &&
            attested.every((uid, i) => uid === group.memberUids[i]);
        return { ...group, indexed: true,
            ...(sameSource ? {} : { provenanceUids: attested }) };
    }).filter(Boolean);
    const currentIndexedHashes = new Set(indexedCurrent.map(g => String(g.hash)));
    // A shared hash can survive after one occurrence is removed. Do not leave
    // the retired occurrence as a phantom active reference once the surviving
    // group is confirmed in the backend.
    // A present hash with missing/mismatched provenance is NOT a deletion.
    // Keep the old group and its retired UIDs if even one physical copy cannot
    // be attested; hash-only duplicate cleanup is intentionally out of scope.
    const attestedOwners = [...ledger.groups.filter(group => group.indexed), ...indexedCurrent];
    const oldGroups = ledger.groups.filter(group => {
        const hash = String(group.hash);
        const records = inventory.get(hash);
        if (!records?.length) return false;
        // An unfinished group can have a physical vector if a write succeeded
        // before ledger finalization. Keep its evidence unless all copies are
        // attributable to an already-indexed group, or it is still current
        // (and will be retained in unfinishedCurrent below).
        if (!group.indexed &&
            currentByKey.get(`${memberKey(group)}:${group.hash}`)?.hashInputFingerprint ===
                group.hashInputFingerprint) return false;
        const verifiedCopies = records.every(meta =>
            attestedOwners.some(known => String(known.hash) === hash &&
                known.hashInputFingerprint === group.hashInputFingerprint &&
                indexedChatProvenance(meta, ledger, known)));
        if (!group.indexed) return !verifiedCopies;
        // An already-verified current group retains the same member evidence;
        // do not duplicate its ledger row merely because another copy is bad.
        if (!verifiedCopies) return !indexedCurrent.some(current =>
            memberKey(current) === memberKey(group) && String(current.hash) === hash &&
            current.hashInputFingerprint === group.hashInputFingerprint);
        return !currentKeys.has(`${memberKey(group)}:${group.hash}`) &&
            !currentIndexedHashes.has(hash);
    });
    const pending = ledger.pending;
    const pendingVerified = !pending || (
        pending.insertHashes.every(hash => indexedCurrent.some(group => String(group.hash) === hash)) &&
        pending.deleteHashes.every(hash => !inventory.has(hash))
    );
    // An uncertain operation must not turn an old hash or a foreign vector
    // into verified chat membership.
    if (!pendingVerified) return false;
    // Keep unfinished, still-current planned groups after another group is
    // successfully finalized. Otherwise the next pass splits their members.
    const indexedKeys = new Set(indexedCurrent.map(g => `${memberKey(g)}:${g.hash}`));
    const unfinishedCurrent = ledger.groups.filter(group => {
        const key = `${memberKey(group)}:${group.hash}`;
        return !group.indexed && !indexedKeys.has(key) && !oldGroups.includes(group) &&
            currentByKey.get(key)?.hashInputFingerprint === group.hashInputFingerprint;
    });
    const groups = [...oldGroups, ...indexedCurrent, ...unfinishedCurrent];
    const referenced = new Set(groups.flatMap(group => group.memberUids));
    // Prune confirmed retirements only after their vector is absent or fully
    // accounted for. Unverifiable existing vectors retain historical UIDs.
    const messages = reconciliation.messages.filter(msg => msg.active !== false ||
        !msg.retiredConfirmed || referenced.has(msg.uid));
    const next = { ...ledger, messages,
        groups, state: 'clean', pending: null };
    await saveChatIdentityLedger(next);
    Object.assign(ledger, next);
    return true;
}

/**
 * #79: a vector changed or removed through VectHare's own editor must not leave
 * the identity ledger asserting the original vector as indexed. Called BEFORE
 * the edit: affected groups become unindexed (UIDs kept), so Repair cannot trust
 * the obsolete association and the next Sync/Repair re-verifies from the backend.
 */
export async function noteManualVectorChange(collectionId, settings, hashes) {
    await refreshStoreIfStale({ minIntervalMs: 0 }).catch(() => false); // 8B
    const logicalId = parseRegistryKey(collectionId).collectionId || collectionId;
    const saved = await readInitialVectorizationConfig(logicalId, settings);
    if (saved.status !== 'valid' || saved.config.identityLedger !== 1) return;
    let ledger;
    try { ledger = await readChatIdentityLedger(logicalId, settings, saved.config); }
    catch (error) {
        if (error.ledgerStatus === 'missing') return; // Repair rebuilds only from backend evidence.
        throw error;
    }
    if (ledger.state !== 'clean') {
        throw new Error('Identity ledger has unfinished work; run Sync Chat or Repair before editing vectors');
    }
    const changed = new Set(hashes.map(String));
    if (!ledger.groups.some(group => group.indexed && changed.has(String(group.hash)))) return;
    await saveChatIdentityLedger({ ...ledger, groups: ledger.groups.map(group =>
        group.indexed && changed.has(String(group.hash)) ? { ...group, indexed: false } : group) });
}

// Crash recovery for the same collection, with no concurrent-writer protocol.
// Insert-only operations are safe to retry after inspecting the backend.
async function recoverIdentityLedger(ledger, collectionId, settings) {
    if (ledger.state !== 'dirty') return true;
    const inventory = await readIdentityInventory(collectionId, settings);
    // A remaining deletion target is not a reason to repeat a destructive
    // request. Keep it in the backend, re-evaluate only on the next normal run.
    const next = { ...ledger, state: 'clean', pending: null,
        groups: ledger.groups.map(group => ({ ...group,
            indexed: inventory.has(String(group.hash)) &&
                verifiedGroupHash(ledger, group, inventory) })) };
    await saveChatIdentityLedger(next);
    Object.assign(ledger, next);
    return true;
}

// Check first-write emptiness without accidentally creating a missing native
// Vectra index via the plugin's listing accessor. Never infer first use from
// an empty hash list alone; the saved provenance endpoint must agree.
async function assertEmptyFirstInsertCollection(collectionId, settings, saved, returnInventory = false) {
    if (saved.status !== 'missing') {
        throw new Error('Collection configuration is not confirmed missing; ledger reset blocked');
    }
    if (saved.physicalAbsent) return; // Plugin verified there is no local index.
    if (['standard', 'vectra'].includes(settings.vector_backend || 'standard')) {
        const { getModelField } = await import('./providers.js');
        const source = settings.source || 'transformers';
        const modelField = getModelField(source);
        const exact = await readInitialVectorizationConfig(collectionId, settings, {
            source, model: modelField ? settings[modelField] || '' : '',
        });
        if (exact.status !== 'missing' || exact.physicalAbsent) {
            throw new Error('Original Vectra model index cannot be verified; ledger reset blocked');
        }
    }
    const inventory = await readIdentityInventory(collectionId, settings);
    if (inventory.size !== 0 && !returnInventory) {
        throw new Error('Existing backend records prevent first-insert ledger recovery');
    }
    return inventory;
}

// A failed FIRST insert may have created an empty Vectra index before the
// initial-configuration marker could be saved. The normal Stage 2B preflight
// rightly rejects an unrecorded physical collection. Allow this one retry only
// with a matching VectHare ledger and a complete, empty backend inventory.
// This does not make other legacy/unverified collections writable.
async function recoverEmptyFirstSyncPreflight(collectionId, settings) {
    // 9c: an interrupted first insert into a new-layout collection staged its
    // ledger with that layout; describe the collection by its own storage.
    settings = settingsForCollectionStorage(collectionId, settings);
    if (!canRecordInitialVectorizationConfig(collectionId, settings)) return null;
    const saved = await readInitialVectorizationConfig(collectionId, settings);
    if (saved.status !== 'missing' || saved.physicalAbsent) return null;
    // VH-016: the ledger is found by the settings of the first insert. Those
    // kept locally at that insert are tried first; today's settings after.
    const today = createInitialVectorizationConfig(settings, chatConfigChunking(settings));
    const kept = getCollectionMeta(collectionId)?.firstInsertConfig;
    const candidates = [kept, today].filter((candidate, i, all) => candidate && typeof candidate === 'object' &&
        all.findIndex(other => JSON.stringify(other) === JSON.stringify(candidate)) === i);
    let config = null;
    let ledger;
    for (const candidate of candidates) {
        try {
            ledger = await readChatIdentityLedger(collectionId, settings, candidate);
            config = JSON.parse(JSON.stringify(candidate));
            break;
        } catch { /* No matching ledger is NOT proof of a failed first insert. */ }
    }
    if (!config || !ledger) return null;
    // Only an interrupted first INSERT qualifies. A clean historical ledger,
    // even with no vectors left, must not be silently reset.
    if (ledger.state !== 'dirty' || !ledger.pending?.insertHashes?.length ||
        ledger.pending.deleteHashes.length || ledger.groups.some(group => group.indexed)) {
        return null;
    }
    const inventory = await assertEmptyFirstInsertCollection(collectionId, settings, saved, true);
    if (inventory.size === 0) {
        return { status: 'new', settings: snapshotCollectionOperationSettings(settings), config };
    }
    // #78: the first insert succeeded but the initial configuration was never
    // saved. Recover only when EVERY backend record is one the interrupted
    // insert staged and carries matching ledger provenance; anything else is a
    // legacy/unrelated collection and must not receive today's settings.
    const pending = new Set(ledger.pending.insertHashes.map(String));
    const attested = [...inventory].every(([hash, records]) => pending.has(hash) &&
        records.every(meta => ledger.groups.some(group => String(group.hash) === hash &&
            indexedChatProvenance(meta, ledger, group))));
    if (!attested) return null;
    config.identityLedger = 1;
    if (!await saveInitialVectorizationConfig(collectionId, config, settings)) return null;
    setCollectionMeta(collectionId, { firstInsertConfig: null });
    return resolveCollectionOperationSettings(collectionId, settings, 'sync-chat', chatConfigChunking(settings));
}

/**
 * Filters out chunks that have been disabled by scene vectorization
 * @param {object[]} chunks Chunks to filter
 * @returns {object[]} Chunks not disabled by scenes
 */
function filterSceneDisabledChunks(chunks) {
    const filtered = chunks.filter(chunk => {
        const isDisabled = isChunkDisabledByScene(chunk.hash, chunk.collectionId);
        if (isDisabled) {
            console.debug(`VectHare: Chunk ${chunk.hash} is disabled by scene`);
        }
        return !isDisabled;
    });

    if (filtered.length !== chunks.length) {
        vhLog(`VectHare: Scene filtering: ${chunks.length} → ${filtered.length} chunks (${chunks.length - filtered.length} disabled by scenes)`);
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
        const chunkMeta = getChunkMetadata(chunk.hash, chunk.collectionId);
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

    vhLog(`VectHare: Chunk conditions filtered ${filtered.length} → ${conditionFilteredChunks.length}`);
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

        vhLog(`VectHare: Reranked ${rerankedChunks.length} chunks with BananaBread`);
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
export async function synchronizeChat(settings, batchSize = 5, bypassAutoSync = false, validationToken = null,
    verifiedConfig = null, runCache = null) {
    settings = snapshotCollectionOperationSettings(settings);
    const callerSettings = settings; // Repair resolves its own saved-settings snapshot
    let capturedConfig = validationToken === validatedManualSync ? verifiedConfig : null;
    // Background events must not create chat bindings when auto-sync is off.
    // Explicit Sync Chat / Continue calls bypass this read-only eligibility gate.
    const target = captureChatTarget();
    if (!target) return syncDeferred();
    if (backendWriteRefusal(settings.vector_backend)) return syncDeferred(); // VH-015: nothing can be stored
    if (!bypassAutoSync) {
        const existingId = peekChatCollectionId();
        if (!existingId) return syncDeferred();
        const { isCollectionAutoSyncEnabled } = await import('./collection-metadata.js');
        if (!isChatTargetCurrent(target, existingId) || !isCollectionAutoSyncEnabled(existingId)) {
            return syncDeferred();
        }
    }
    const binding = await ensureChatBinding();
    if (!isChatTargetCurrent(target)) return syncDeferred();
    const collectionId = binding.writable ? binding.collectionId : null;
    if (collectionId && !isChatTargetCurrent(target, collectionId)) return syncDeferred();
    vhLog(`🔍 VectHare DEBUG: getChatCollectionId() returned: "${collectionId}"`);
    vhLog(`🔍 VectHare DEBUG: settings.vector_backend = "${settings.vector_backend}"`);
    vhLog(`🔍 VectHare DEBUG: settings.source = "${settings.source}"`);
    if (!collectionId) {
        return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
    }
    // Acquire before the first await: a concurrent chat deletion must not
    // begin between the identity check and a later vector write.
    try { beginChatCollectionWrite(collectionId); }
    catch (error) {
        console.warn('VectHare: Sync skipped during collection deletion', error.message);
        return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
    }
    // 8C: another tab/device working on this chat makes this pass wait (an
    // auto-sync just skips; the next chat event tries again).
    let syncLease = null;
    try {
        syncLease = await acquireLease(collectionId, { label: 'Sync', isPaused: isVectorizationPaused });
    } catch (error) {
        endChatCollectionWrite(collectionId);
        if (error?.code === 'VH_LEASE_HELD') {
            console.info('VectHare: Sync pass skipped - another tab is working on this chat');
            return syncDeferred();
        }
        throw error;
    }
    try {

    // Check per-collection autoSync setting instead of global enabled_chats.
    // VectHare+: bypassAutoSync lets an explicitly user-started run (Sync Chat /
    // Continue Vectorization) proceed even when background auto-sync is off.
    const { isCollectionAutoSyncEnabled, getCollectionMeta, setCollectionMeta } = await import('./collection-metadata.js');
    if (!bypassAutoSync && !isCollectionAutoSyncEnabled(collectionId)) {
        return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
    }

    // Protect both manual and automatic sync before reverse-sync can delete
    // anything. Manual vectorizeAll validates once at operation start.
    let syncCompatibility;
    try {
        if (validationToken === validatedManualSync) {
            syncCompatibility = { status: 'compatible' };
        } else {
            let resolved;
            try {
                resolved = await resolveCollectionOperationSettings(collectionId, settings, 'sync-chat',
                    chatConfigChunking(settings), { allowNew: true });
            } catch (error) {
                resolved = await recoverEmptyFirstSyncPreflight(collectionId, settings);
                if (!resolved) throw error;
            }
            settings = resolved.settings;
            capturedConfig = resolved.config || createInitialVectorizationConfig(settings, chatConfigChunking(settings));
            syncCompatibility = { status: resolved.status };
        }
    } catch (error) {
        if (!bypassAutoSync) {
            // VH-052: this chat's memories are on another backend/server: say so (once).
            const { noteChatLivesElsewhere } = await import('./backend-elsewhere.js');
            if (noteChatLivesElsewhere(collectionId, settings)) {
                console.warn('VectHare: Auto-sync skipped: this chat\'s collection is on another backend or server');
                return syncDeferred();
            }
            // VH-017: the location check failed for a moment: try again next time, quietly.
            if (error?.code === 'VH_STORAGE_UNCHECKED') {
                console.warn('VectHare: Auto-sync deferred:', error.message);
                return syncDeferred();
            }
            // VH-061: a collection from before 13.31 (no saved settings): re-vectorize prompt.
            if (/original configuration missing/.test(error.message)) {
                const { noteLegacyNeedsRebuild } = await import('./legacy-collections.js');
                noteLegacyNeedsRebuild(collectionId);
                console.warn('VectHare: Auto-sync skipped: collection from an older VectHare needs re-vectorizing');
                return syncDeferred();
            }
            if (!autoSyncFingerprintWarned) {
                autoSyncFingerprintWarned = true;
                toastr.error(error.message, 'VectHare: Auto-sync blocked', { timeOut: 0, closeOnHover: false });
            }
            console.warn('VectHare: Auto-sync blocked by collection configuration:', error.message);
            return syncDeferred();
        }
        throw error;
    }
    if (!isChatTargetCurrent(target, collectionId)) return syncDeferred();
    assertCollectionOperationSettingsStable(capturedConfig, settings, chatConfigChunking(settings));

    // VectHare+ R9: config fingerprint gate for AUTO-SYNC. vectorizeAll enforces
    // this for manual runs; without this gate, changed embedding settings +
    // auto-sync enabled would silently embed new messages with vectors
    // incompatible with the existing collection (silent poisoning - exactly
    // what the user flagged as important). On mismatch: refuse to add vectors,
    // warn once, fail-closed. Manual runs bypass via bypassAutoSync because
    // their own (stricter, blocking) check already ran in vectorizeAll.
    if (!bypassAutoSync && syncCompatibility.status !== 'compatible') {
        try {
            const configFingerprint = await computeVectorizationConfigFingerprint(settings);
            if (configFingerprint) {
                const storedFingerprint = getCollectionMeta(collectionId).vectorizationConfigFingerprint;
                if (storedFingerprint && storedFingerprint !== configFingerprint) {
                    if (!autoSyncFingerprintWarned) {
                        autoSyncFingerprintWarned = true;
                        toastr.error(
                            'Auto-sync paused: vectorization settings changed since this collection was created. New messages are NOT being vectorized (mixing incompatible vectors is prevented). Restore the previous settings, or re-vectorize the collection via Content Vectorizer > Replace All.',
                            'VectHare: Auto-sync blocked',
                            { timeOut: 0, closeOnHover: false }
                        );
                    }
                    console.warn('VectHare: Auto-sync blocked - vectorization config fingerprint mismatch');
                    return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
                }
                // Record the fingerprint if absent so future manual runs validate
                // against what auto-sync actually used
                if (!storedFingerprint) {
                    setCollectionMeta(collectionId, { vectorizationConfigFingerprint: configFingerprint });
                }
            }
        } catch (fpError) {
            // Fingerprint failures must never block background sync (fail-open)
            console.warn('VectHare: Auto-sync fingerprint check failed (continuing):', fpError.message);
        }
    }

    // Per Scene strategy: don't auto-vectorize on message events
    // Scenes are vectorized when user marks scene end (via createSceneChunk)
    if (settings.chunking_strategy === 'per_scene') {
        return { remaining: 0, messagesProcessed: 0, chunksCreated: 0 };
    }

    // VectHare+: While paused, automatic sync stays idle (resume via panel button
    // or page reload; the pending queue is re-derived from the DB on next run)
    if (isVectorizationPaused()) {
        return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
    }

    // VectHare+ R16 FIX (mutual exclusion): background auto-sync previously had
    // NO exclusion against a manual run (repair or Sync Chat) - both could
    // write to the same collection CONCURRENTLY (syncBlocked only guards
    // sync-vs-sync). Two writers racing = reads interleaving with each other's
    // writes = the class of lost/duplicate insert the user hit on Qdrant.
    // Auto-sync now stands down whenever a manual run owns the collection.
    // Manual runs pass bypassAutoSync=true (they ARE the owner).
    if (!bypassAutoSync && vectorizeRunActive) {
        console.debug('VectHare: Auto-sync deferred - a manual vectorization/repair run is active');
        return { remaining: -1, messagesProcessed: 0, chunksCreated: 0 };
    }

    try {
        await waitUntilCondition(() => !syncBlocked && !is_send_press, 1000);
    } catch {
        // Another sync may own syncBlocked; never unlock it on our timeout.
        return syncDeferred();
    }

    if (!isChatTargetCurrent(target, collectionId)) return syncDeferred();
    try {
        syncBlocked = true;

        // #85: automatic Sync reconciles existing indexed vectors with the current
        // chat (the same Repair used by manual Sync Chat) before adding new content.
        // Ledger-enabled collections only; throttled like reverse Sync because it
        // reads the full inventory. Manual runs already did this in vectorizeAll.
        if (!bypassAutoSync && capturedConfig?.identityLedger === 1 &&
            reconciliationDue(collectionId, lastAutoRepairByCollection.get(collectionId), 5 * 60 * 1000)) {
            if (vectorizeRunActive) return syncDeferred();
            vectorizeRunActive = true; // shared run lock: manual runs and other syncs stand down
            let repaired;
            try { repaired = await repairChatVectors(callerSettings, batchSize, 'auto'); }
            finally { vectorizeRunActive = false; resetControlState(); }
            if (repaired !== 'ok') return syncDeferred();
            lastAutoRepairByCollection.set(collectionId, Date.now());
            clearReconciliationMarker(collectionId); // #24: verified pass completed
            if (!isChatTargetCurrent(target, collectionId)) return syncDeferred();
        }

        // Snapshot groups while the original chat is still active; never read a
        // different chat's messages after a backend await.
        assertCollectionOperationSettingsStable(capturedConfig, settings, chatConfigChunking(settings));
        const strategy = settings.chunking_strategy || 'per_message';
        const wasUnregistered = canRecordInitialVectorizationConfig(collectionId, settings);
        const initialConfig = wasUnregistered ? createInitialVectorizationConfig(settings,
            chatConfigChunking(settings)) : null;
        // Capture before preparing any groups, not only before the later
        // inventory read. A changed chat must not use a stale deletion keep-set.
        const groupedChatState = target.messages.map(msg => [msg, msg.is_system, msg.is_user,
            msg.name, msg.send_date, getTextWithoutAttachments(msg)]);
        const groupedChatUnchanged = () => target.messages.length === groupedChatState.length &&
            !target.messages.some((msg, i) =>
                msg !== groupedChatState[i][0] || msg.is_system !== groupedChatState[i][1] ||
                msg.is_user !== groupedChatState[i][2] || msg.name !== groupedChatState[i][3] ||
                msg.send_date !== groupedChatState[i][4] ||
                getTextWithoutAttachments(msg) !== groupedChatState[i][5]);
        // P1: a manual run (vectorizeAll) plans once and reuses the plan for
        // its later batches while nothing changed. Any doubt -> full re-plan.
        const planGeneration = chatSwitchGeneration;
        const planMutation = chatMutationCounter;
        const planConfigKey = JSON.stringify(capturedConfig ?? null);
        const previousPlan = runCache?.plan || null;
        const cachedPlan = previousPlan &&
            previousPlan.collectionId === collectionId &&
            previousPlan.generation === planGeneration &&
            previousPlan.mutation === planMutation &&
            previousPlan.messages === target.messages &&
            previousPlan.length === target.messages.length &&
            previousPlan.configKey === planConfigKey &&
            previousPlan.unchanged() &&
            !(previousPlan.existingHashes.size > 0 && reconciliationDue(collectionId,
                lastReverseSyncByCollection.get(collectionId) ?? 0, 5 * 60 * 1000)) &&
            (!previousPlan.identityLedger ||
                (previousPlan.identityLedger.state === 'clean' && previousPlan.inventory instanceof Map))
            ? previousPlan : null;
        // Consumed: only a pass that finishes cleanly stores a plan again.
        if (runCache) runCache.plan = null;

        // S1: only a manual run (Sync Chat) owns the Status panel; automatic
        // background sync stays silent.
        const manualPanel = bypassAutoSync && progressTracker.currentOperation === 'Vectorizing Chat'
            ? progressTracker : null;
        const manualPanelRunId = manualPanel ? manualPanel.runId : null;
        let groupedItems = cachedPlan ? cachedPlan.groupedItems : collectGroupedItems(target.messages, settings);
        // NOTE: Registration happens AFTER first successful insert to prevent ghosts.
        let isRegistered = false;
        let initialConfigRecorded = false;
        if (!cachedPlan) manualPanel?.setPhase('Checking collection…');
        const existingHashes = cachedPlan ? cachedPlan.existingHashes : new Set(
            (await getSavedHashes(collectionId, settings, false, getStopSignal())).map(hash => String(hash))
        );
        if (!isChatTargetCurrent(target, collectionId)) return syncDeferred();
        let identityLedger = null, identityReconciliation = null, identityGroups = [];
        if (cachedPlan) {
            ({ identityLedger, identityReconciliation, identityGroups } = cachedPlan);
        }
        const identityRequired = capturedConfig?.identityLedger === 1;
        const identityNew = wasUnregistered && existingHashes.size === 0 && !identityRequired;
        // Only genuinely empty collections initialize tracking. An existing
        // unrecorded collection is legacy even when registry state is missing.
        if (!cachedPlan && (identityNew || identityRequired)) {
            const config = identityNew ? initialConfig : capturedConfig;
            if (!config) throw new Error('Collection identity configuration unavailable');
            try {
                manualPanel?.setPhase('Comparing with chat…');
                identityLedger = await readChatIdentityLedger(collectionId, settings, config, identityNew);
                if (identityNew && (identityLedger.messages.length || identityLedger.groups.length ||
                    identityLedger.state !== 'clean')) {
                    // Only an interrupted first insert can be reset. An empty
                    // backend by itself is not proof that old UID history is safe
                    // to discard (for example after an external collection purge).
                    if (identityLedger.state !== 'dirty' ||
                        !identityLedger.pending?.insertHashes?.length ||
                        identityLedger.pending.deleteHashes.length ||
                        identityLedger.groups.some(group => group.indexed)) {
                        throw new Error('Unregistered collection has historical identity ledger; manual recovery required');
                    }
                    const saved = await readInitialVectorizationConfig(collectionId, settings);
                    await assertEmptyFirstInsertCollection(collectionId, settings, saved);
                    identityLedger = { ...emptyIdentityLedger(collectionId, identityLedger.binding),
                        __token: identityLedger.__token };
                    await saveChatIdentityLedger(identityLedger);
                }
                assertChatViewCurrent(identityLedger, target.messages); // VH-081
                identityReconciliation = await reconcileIdentityMessages(target.messages, identityLedger);
                groupedItems = await collectStableIdentityGroups(target.messages, settings,
                    identityLedger, identityReconciliation);
                identityGroups = await attachIdentityGroups(target.messages, groupedItems, identityReconciliation);
                for (const group of identityGroups) {
                    if (identityLedger.groups.some(old => String(old.hash) === String(group.hash) &&
                        old.hashInputFingerprint !== group.hashInputFingerprint)) {
                        throw new Error(`Content hash ${group.hash} maps to different inputs`);
                    }
                }
                if (identityNew) {
                    initialConfig.identityLedger = 1;
                    // VH-016: keep the settings of this first insert locally, so an
                    // interrupted first Vectorize can be recovered even after the
                    // user changes a setting before the next run.
                    setCollectionMeta(collectionId, { firstInsertConfig: initialConfig });
                    await Promise.race([flushVectHareStore().catch(() => {}), new Promise(r => setTimeout(r, 2000))]);
                }
            } catch (error) {
                // A new empty collection may work with older plugins, but a
                // tracked collection must NEVER fall back to positional Repair.
                if (identityRequired || identityLedger || error.status !== 404) throw error;
                // An older plugin may lack only these routes. Preserve the
                // untracked Sync path without trusting it for UID-based Repair.
                console.warn('VectHare: Ledger routes absent on older plugin; retaining original Sync:', error.message);
            }
        }
        if (identityLedger?.state === 'dirty' &&
            !await recoverIdentityLedger(identityLedger, collectionId, settings)) {
            throw new Error('Identity ledger has an unresolved deletion; Sync writes blocked');
        }

        // ========================================================================
        // VectHare+ Step 1.5: Reverse sync (ghost vector cleanup)
        //
        // Forward sync adds missing hashes, but hash-diffing alone never notices
        // history changing behind the DB's back:
        //   Edited message → text changes → hash changes → old hash obsolete
        //   Deleted message → old hash remains = retrievable "ghost vector"
        // This pass deletes stored hashes that no longer correspond to any
        // current chat content.
        //
        // IMPORTANT: the keep-set MUST be built from groupedItems (the same
        // grouped/combined hashes that forward sync compares against), NOT raw
        // per-message hashes - under conversation_turns/message_batch strategies
        // stored hashes are combined-text hashes and would otherwise all look
        // like ghosts.
        //
        // Protected from pruning (chunks that do not map 1:1 to chat messages):
        //   - Scene composite chunks (DB metadata.isScene === true)
        //   - Dual-vector summary chunks (isSummary* flags / parentHash)
        //   - Chunks marked disabled-by-scene in settings-layer chunk metadata
        //
        // Safety: this pass only runs when per-chunk metadata is resolvable from
        // the backend, so special chunks are always detectable. If metadata is
        // unavailable it is skipped entirely rather than guessed.
        //
        // PERFORMANCE (R6 FIX): this pass fetches FULL collection metadata
        // (chunk list up to VECTOR_LIST_LIMIT entries), which is expensive on
        // large chats. synchronizeChat runs on EVERY message event, and before
        // R6 it ran this pass every time - heavy payload per chat message.
        // Now throttled to at most once per 5 minutes across ALL sync passes
        // (event-driven and vectorizeAll iterations alike). Ghost cleanup still
        // happens promptly after edits/deletes; it just stops being a
        // per-message tax on large collections.
        // ========================================================================
        const REVERSE_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;
        const generation = reverseSyncGeneration.get(collectionId) ?? 0;
        const lastAt = lastReverseSyncByCollection.get(collectionId) ?? 0;
        assertCollectionOperationSettingsStable(capturedConfig, settings, chatConfigChunking(settings));
        if (existingHashes.size > 0 &&
            reconciliationDue(collectionId, lastAt, REVERSE_SYNC_MIN_INTERVAL_MS)) {
            try {
                const { getChunkMetadata } = await import('./collection-metadata.js');

                // Compare to the state used to plan groups, including changes
                // before this inventory read as well as while it was pending.
                manualPanel?.setPhase('Checking collection…');
                const collectionData = await getSavedHashes(collectionId, settings, true, getStopSignal(), Boolean(identityLedger) || settings.vector_backend === 'qdrant');
                if (!isChatTargetCurrent(target, collectionId)) return syncDeferred();
                if (!groupedChatUnchanged()) {
                    console.info('VectHare: Chat changed after Sync grouping; reverse cleanup deferred');
                    return syncDeferred();
                }
                manualPanel?.setPhase('Comparing with chat…');
                const keepHashes = new Set(groupedItems.map(item => String(item.hash)));
                const allStoredHashes = Array.isArray(collectionData) ? collectionData : (collectionData?.hashes || []);

                const metaByHash = (collectionData && !Array.isArray(collectionData) && Array.isArray(collectionData.metadata) && collectionData.metadata.length > 0)
                    ? new Map(collectionData.hashes.map((h, i) => [String(h), collectionData.metadata[i] || {}]))
                    : null;
                // An identical hash may be shared with an imported/scene record.
                // Do not let Map's last duplicate hide a protected earlier copy.
                const allRecordsByHash = new Map();
                if (metaByHash) {
                    collectionData.hashes.forEach((hash, i) => {
                        const records = allRecordsByHash.get(String(hash)) || [];
                        records.push(collectionData.metadata[i]);
                        allRecordsByHash.set(String(hash), records);
                    });
                }

                const isProtectedMeta = (meta) => {
                    if (!meta) return false;
                    if (meta.isScene === true) return true;
                    if (meta.isSummaryChunk === true || meta.isSummary === true || meta.isSummaryVector === true) return true;
                    if (meta.parentHash != null) return true;
                    return false;
                };

                if (metaByHash) {
                    // Check both DB-side metadata and settings-layer chunk metadata
                    const isProtected = (hash, meta) => {
                        if (isProtectedMeta(meta)) return true;
                        // Same source-ownership rule as Repair, for every physical
                        // copy that deleting this hash would remove (#63/#77).
                        if ((allRecordsByHash.get(String(hash)) || [meta]).some(isProtectedChatRecordMeta)) return true;
                        if (identityLedger && (allRecordsByHash.get(String(hash)) || []).some(record =>
                            isProtectedMeta(record) ||
                            record?.vecthareProvenance?.recordKind !== 'sync-chat' ||
                            record?.vecthareProvenance?.sourceIdentity?.status !== 'ledger-linked')) return true;
                        const chunkMeta = getChunkMetadata(hash, collectionId);
                        // VH-082: a chunk a scene covers (disabledByScene, a local
                        // note) is an ordinary chat chunk. While its message is
                        // current it is never a ghost; once the message is edited or
                        // deleted it must be removed like any other stale chunk.
                        if (chunkMeta && isProtectedMeta(chunkMeta)) return true;
                        return false;
                    };

                    // R12 FIX: duplicate healing moved here (after the protected-
                    // class check) and now SKIPS protected hashes. Previously a
                    // duplicated scene/summary chunk would have had ALL copies
                    // deleted and never re-added (forward sync cannot recreate
                    // scene/summary chunks) = silent data loss.
                    const dupCounts = new Map();
                    for (const h of allStoredHashes) {
                        const k = String(h);
                        dupCounts.set(k, (dupCounts.get(k) || 0) + 1);
                    }
                    const duplicateHashes = [...dupCounts.entries()]
                        // Stage 13.0: a hash required by any current group cannot
                        // be removed for duplicate cleanup (even temporarily).
                        .filter(([h, c]) => c > 1 && !keepHashes.has(h) &&
                            !isProtected(h, metaByHash.get(h) || null))
                        .map(([h]) => h);
                    const ghostHashes = [];
                    // #22: without a ledger, a stale hash must not be deleted
                    // before its replacement is actually written. Defer any ghost
                    // whose messages still have an unwritten current group; the
                    // next pass removes it once the replacement exists.
                    const groupHashesByMessageId = new Map();
                    if (!identityLedger) {
                        for (const group of groupedItems) {
                            for (const messageId of extractMessageIds(group.metadata)) {
                                const list = groupHashesByMessageId.get(messageId) || [];
                                list.push(String(group.hash));
                                groupHashesByMessageId.set(messageId, list);
                            }
                        }
                    }
                    const replacementPending = meta => extractMessageIds(meta).some(messageId =>
                        (groupHashesByMessageId.get(messageId) || [])
                            .some(hash => !existingHashes.has(hash)));
                    // VH-018: duplicate cleanup is a deletion like any other: the #22
                    // guards apply (a message still unchanged, or whose replacement is
                    // not written yet, keeps its chunk until a later pass).
                    const safeDuplicateHashes = identityLedger ? [] : duplicateHashes.filter(h => {
                        const meta = metaByHash.get(h) || null;
                        return !hasUnchangedMemberMessages(meta, target.messages) && !replacementPending(meta);
                    });
                    if (safeDuplicateHashes.length > 0 && !identityLedger) {
                        // Exact physical duplicate cleanup is not part of the
                        // ledger path (#61). Never delete a shared ledger hash.
                        if (!isChatTargetCurrent(target, collectionId)) return syncDeferred();
                        // #35: cleanup requests honour Stop like every other write.
                        await deleteVectorItems(collectionId, safeDuplicateHashes, settings, getStopSignal());
                        if (!isChatTargetCurrent(target, collectionId)) return syncDeferred();
                        console.warn(`VectHare: Removed ${safeDuplicateHashes.length} duplicated vector(s) of old message versions`);
                        for (const h of safeDuplicateHashes) {
                            existingHashes.delete(String(h));
                        }
                    }

                    const ledgerOwned = new Set(identityLedger?.groups.filter(g => g.indexed)
                        .map(g => String(g.hash)) || []);
                    const pendingReplacementUids = new Set(identityGroups
                        .filter(g => !existingHashes.has(String(g.hash)))
                        .flatMap(g => g.memberUids));
                    for (const [hash, meta] of metaByHash) {
                        if (isProtected(hash, meta) || keepHashes.has(hash)) continue;
                        if (!identityLedger && (hasUnchangedMemberMessages(meta, target.messages) ||
                            replacementPending(meta))) continue;
                        if (identityLedger) {
                            if (identityLedger.state === 'dirty' || !ledgerOwned.has(hash)) continue;
                            const prior = identityLedger.groups.filter(g => String(g.hash) === hash);
                            if (prior.some(g => g.memberUids.some(uid =>
                                pendingReplacementUids.has(uid) || identityReconciliation.uncertainUids.has(uid)))) continue;
                            if (prior.some(g => g.memberUids.some(uid =>
                                !identityReconciliation.activeUids.has(uid) &&
                                !identityReconciliation.confidentDeleted.has(uid)))) continue;
                            // Deletion by hash removes every physical copy.
                            // Any unrecognized UID provenance vetoes cleanup.
                            if (!allPhysicalCopiesMatchGroups(identityLedger, hash,
                                allRecordsByHash.get(hash), prior)) continue;
                        }
                        ghostHashes.push(hash);
                    }

                    if (ghostHashes.length && !groupedChatUnchanged()) return syncDeferred();
                    if (identityLedger && ghostHashes.length && identityLedger.state === 'clean') {
                        await stageIdentityLedger(identityLedger, [], ghostHashes, identityReconciliation, identityGroups);
                    }
                    if (ghostHashes.length > 0 && (!identityLedger || identityLedger.pending?.deleteHashes?.length)) {
                        if (!isChatTargetCurrent(target, collectionId) || !groupedChatUnchanged()) return syncDeferred();
                        await deleteVectorItems(collectionId, ghostHashes, settings, getStopSignal());
                        if (!isChatTargetCurrent(target, collectionId)) return syncDeferred();
                        if (identityLedger) {
                            // Finish the verified delete stage before beginning a
                            // second write-ahead stage for forward Sync.
                            const inventory = await readIdentityInventory(collectionId, settings);
                            if (!await finishIdentityLedger(identityLedger, identityReconciliation,
                                identityGroups, inventory)) {
                                throw new Error('Reverse-sync deletion not verified; forward writes blocked');
                            }
                            // VH-055 tidy-up: this collection's own notes for chunks
                            // verified gone (other collections' notes are kept).
                            for (const hash of ghostHashes) {
                                if (!inventory.has(String(hash))) deleteChunkMetadata(hash, collectionId);
                            }
                        }
                        vhLog(`VectHare: Reverse sync removed ${ghostHashes.length} obsolete vector(s) (changed/deleted sources)`);
                        // Notes shared by hash (older records) are never removed here:
                        // another collection may still hold that hash. Only this
                        // collection's own notes are removed above, and only after a
                        // verified deletion; Diagnostics tidies the rest.
                    }
                } else {
                    console.debug('VectHare: Reverse sync skipped - chunk metadata unavailable from backend');
                }
                if ((reverseSyncGeneration.get(collectionId) ?? 0) === generation) {
                    lastReverseSyncByCollection.set(collectionId, Date.now());
                    clearReconciliationMarker(collectionId); // #24: verified pass completed
                }
            } catch (reverseSyncError) {
                // Never block forward vectorization on reverse-sync failure.
                if ((reverseSyncGeneration.get(collectionId) ?? 0) === generation) {
                    lastReverseSyncByCollection.set(collectionId,
                        Date.now() - REVERSE_SYNC_MIN_INTERVAL_MS + 30000);
                }
                if (identityLedger) throw reverseSyncError;
                console.warn('VectHare: Reverse sync failed (forward vectorization continues):', reverseSyncError.message);
            }
        }

        // The forward plan was prepared from the same snapshot. A changed chat
        // must be regrouped on a later pass, not indexed from stale membership.
        if (!isChatTargetCurrent(target, collectionId) || !groupedChatUnchanged()) return syncDeferred();

        // Filter out already vectorized items (by their grouped hash)
        const queue = new Queue();
        const queuedHashKeys = new Set();
        const cooling = failedSyncHashes.get(collectionId);
        const coolingItems = [];
        let emptyAfterCleaning = 0;
        for (const item of groupedItems) {
            const key = String(item.hash);
            // #51: identical text produces one hash and needs one embedding,
            // with or without the ledger. Queueing it twice embeds it twice.
            if (existingHashes.has(key) || queuedHashKeys.has(key)) continue;
            // #49: text cleaning can empty a message completely. An empty input
            // cannot be embedded (providers error or return nothing), so it is
            // not queued at all rather than sent as a single space.
            if (!String(item.text ?? '').trim()) {
                emptyAfterCleaning++;
                continue;
            }
            queuedHashKeys.add(key);
            // #48: a repeatedly failing group waits behind content that can
            // still be written, instead of consuming the budget every pass.
            if (cooling?.get(key)?.until > Date.now()) coolingItems.push(item);
            else queue.enqueue(item);
        }
        // Nothing else to do: retry the cooling groups rather than idling.
        if (queue.isEmpty()) for (const item of coolingItems) queue.enqueue(item);
        if (emptyAfterCleaning) {
            console.info(`VectHare: ${emptyAfterCleaning} group(s) have no text after cleaning and were not vectorized`);
        }

        // Show existing saved groups before processing new ones.
        const groupsDoneAtStart = groupedItems.length - queue.size;
        if (manualPanel) {
            progressTracker.stats.totalItems = groupedItems.length;
            progressTracker.stats.embeddedChunks = groupsDoneAtStart;
            progressTracker.stats.totalChunksToEmbed = groupedItems.length;
            progressTracker.stats.partialUnits = 0;
            progressTracker.stats.processedItems = groupsDoneAtStart;
            // The end of each batch logs its own line; log this one only for the
            // first pass so consecutive passes do not repeat it.
            progressTracker.setPhase(
                queue.size > 0 ? phaseText('Embedding', groupsDoneAtStart, groupedItems.length) : 'Finalizing...',
                { log: (progressTracker.stats.embedBatches || 0) === 0 });
        }

        if (queue.isEmpty()) {
            if (identityLedger) {
                const inventory = await readIdentityInventory(collectionId, settings);
                await finishIdentityLedger(identityLedger, identityReconciliation, identityGroups, inventory);
            }
            return { remaining: 0, messagesProcessed: 0, chunksCreated: 0, groupsCompleted: 0, total: groupedItems.length };
        }
        if (identityLedger) {
            const queuedHashes = [...new Set(queue.items.slice(0, batchSize).map(g => String(g.hash)))];
            await stageIdentityLedger(identityLedger, queuedHashes, [], identityReconciliation, identityGroups);
        }

        // Step 3: Process batch
        let itemsProcessed = 0;
        let chunksCreated = 0;
        let groupsCompleted = 0;
        let itemsFailed = 0;
        const attemptedHashes = []; // P1: verified after the batch
        const label = strategy === 'per_message' ? 'Message' : 'Group';

        while (!queue.isEmpty() && itemsProcessed < batchSize) {
            if (!isChatTargetCurrent(target, collectionId)) return syncDeferred();
            // VectHare+: honor Pause/Stop inside the batch loop. The rest of the
            // queue is left untouched (nothing lost) and every already-successful
            // item is already persisted, so any later run continues seamlessly.
            if (isVectorizationStopped() || isVectorizationPaused()) {
                vhLog(`VectHare: Sync ${isVectorizationStopped() ? 'stopped' : 'paused'} by user with ${queue.size} item(s) still pending (completed work kept)`);
                if (isVectorizationStopped()) requireReconciliationAfterStop(collectionId);
                break;
            }
            // #41: submit several groups per embed/insert request instead of one
            // request per group, bounded by Insert Batch Size and this pass's
            // own item budget. A failed slot is retried as whole groups on a
            // later pass, never re-inserted item by item (which would duplicate
            // records on backends that append rather than replace).
            const slotSize = Math.max(1, Math.min(
                Number(settings.insert_batch_size) || 50, batchSize - itemsProcessed));
            const slot = [];
            while (slot.length < slotSize && !queue.isEmpty()) slot.push(queue.dequeue());
            for (const queued of slot) attemptedHashes.push(String(queued.hash));

            try {
                // Prepare items for insertion (add source metadata)
                const chunks = prepareItemsForInsertion(slot);
                chunks.forEach((chunk, index) => {
                    chunk.__vecthareProvenanceHint = {
                        writer: 'sync-chat', sourceType: 'chat',
                        groupingStrategy: slot[index].metadata?.strategy,
                        ...(identityLedger ? { messageUids: slot[index].metadata?.messageUids } : {}),
                    };
                });

                // Insert chunks (insertVectorItems handles duplicates at DB level)
                // R13: pass the Stop signal - Stop now cancels the in-flight
                // embedding/insert request instead of draining it
                if (chunks.length > 0) {
                    if (!isChatTargetCurrent(target, collectionId)) return syncDeferred();
                    assertCollectionOperationSettingsStable(capturedConfig, settings, chatConfigChunking(settings));
                    recordChatStore(collectionId, settings);
                    manualPanel?.beginEmbedTiming(); // S4
                    try {
                        await insertVectorItems(collectionId, chunks, settings, (embedded, total, phase) => {
                            // R7 FIX: vectorizeAll feeds the panel collection-wide
                            // totals; this callback only updates the current-item line.
                            vhLog(`[Chat Vectorization] Embedding progress callback: ${embedded}/${total}`);

                            // #34: the insert layer reports which phase it is in;
                            // inferring it from a percentage was a guess.
                            const span = slot.length > 1
                                ? `${itemsProcessed + 1}-${itemsProcessed + slot.length}` : `${itemsProcessed + 1}`;
                            progressTracker.updateCurrentItem(`${label} ${span}/${batchSize} - ${phase || 'Processing'}: ${embedded}/${total} chunks`);
                            if (manualPanel && manualPanel.isCurrentRun(manualPanelRunId)) {
                                // S2: the bar moves inside the batch, and the status
                                // line counts groups, not only whole batches.
                                const fraction = total > 0 ? Math.min(Math.max(embedded / total, 0), 1) : 0;
                                const partial = groupsCompleted + fraction * slot.length;
                                manualPanel.setPartialUnits(partial);
                                manualPanel.setPhase(phaseText('Embedding',
                                    Math.floor(groupsDoneAtStart + partial), groupedItems.length), { log: false });
                            }
                        }, getStopSignal());
                    } finally {
                        manualPanel?.endEmbedTiming();
                    }
                    chunksCreated += chunks.length;
                    // Only an empty collection can receive a first-vectorization record.
                    // Existing/legacy collections must not be assigned today's settings.
                    if (existingHashes.size === 0 && wasUnregistered && !initialConfigRecorded) {
                        initialConfigRecorded = await saveInitialVectorizationConfig(collectionId, initialConfig, settings);
                        if (initialConfigRecorded) {
                            setCollectionMeta(collectionId, { verifiedPurgeDestination: null, firstInsertConfig: null });
                        }
                        if (identityLedger && !initialConfigRecorded) {
                            throw new Error('Cannot confirm ledger capability in saved collection settings');
                        }
                    }

                    // Register on first successful insert (prevents ghost collections)
                    if (!isRegistered) {
                        // Construct proper registry key: backend:source:collectionId
                        const backend = settings.vector_backend || 'standard';
                        const source = settings.source || 'transformers';
                        const registryKey = `${backend}:${source}:${collectionId}`;
                        registerCollection(registryKey);
                        isRegistered = true;
                        vhLog(`VectHare: Registered collection ${registryKey} after first successful insert`);
                    }
                    // An in-flight insert can finish after switching chats. Keep
                    // its original collection registered, then stop this sync.
                    if (!isChatTargetCurrent(target, collectionId)) return syncDeferred();
                    groupsCompleted += slot.length;
                    for (const written of slot) clearSyncItemFailure(collectionId, written.hash);
                }
            } catch (itemError) {
                // R13: an aborted request (user pressed Stop) is a CLEAN stop,
                // not a failed item - exit the batch loop immediately. The loop
                // top then handles the normal stop bookkeeping.
                if (isVectorizationStopped()) {
                    for (const pending of slot) queue.enqueue(pending); // still pending
                    requireReconciliationAfterStop(collectionId);
                    break;
                }
                if (identityLedger && itemError.message?.includes('Cannot confirm ledger capability')) {
                    throw itemError; // never write further vectors without a saved identity marker
                }
                // Log error but continue processing other items
                console.warn(`VectHare: Failed to process ${slot.length} item(s) (hashes: ${slot.map(i => i.hash).join(', ')}):`, itemError.message);
                itemsFailed += slot.length;
                for (const failed of slot) noteSyncItemFailure(collectionId, failed.hash, itemError.message);
                // VH-077: the first slot of a new collection can fail after some of its
                // rows were written (one request per item). Those rows were written in
                // this run with today's settings, so record the saved settings now;
                // otherwise the collection would stay unrecorded for good.
                if (existingHashes.size === 0 && wasUnregistered && !initialConfigRecorded && initialConfig) {
                    try {
                        initialConfigRecorded = await saveInitialVectorizationConfig(collectionId, initialConfig, settings);
                        if (initialConfigRecorded) {
                            setCollectionMeta(collectionId, { verifiedPurgeDestination: null, firstInsertConfig: null });
                            if (!isRegistered) {
                                registerCollection(`${settings.vector_backend || 'standard'}:${settings.source || 'transformers'}:${collectionId}`);
                                isRegistered = true;
                            }
                            vhLog(`VectHare: Saved settings recorded for ${collectionId} after a partly written first batch`);
                        }
                    } catch (configError) {
                        console.debug('VectHare: No saved settings after the failed first batch (nothing was written?):', configError.message);
                    }
                }
                // Don't rethrow - continue with the next slot
            }

            itemsProcessed += slot.length;
            progressTracker.updateCurrentItem(`${label} ${itemsProcessed}/${batchSize}${itemsFailed > 0 ? ` (${itemsFailed} failed)` : ''}`);
        }

        progressTracker.updateCurrentItem(null);
        let batchInventory = null;
        let ledgerFinished = true;
        if (identityLedger) {
            if (manualPanel && manualPanel.isCurrentRun(manualPanelRunId)) manualPanel.setPhase('Saving…');
            // A partial batch remains dirty unless all planned writes can be
            // confirmed. Never save optimistic `indexed:true` records.
            // P1: with a cached plan, the inventory is the previous one plus a
            // read-back of this batch's hashes (nothing else writes during a
            // manual run); without one, or when that read is unavailable, the
            // full inventory is read as before.
            if (cachedPlan?.inventory instanceof Map) {
                let full = null;
                const delta = await readInventoryForHashes(collectionId, settings, attemptedHashes,
                    async () => (full = await readIdentityInventory(collectionId, settings)));
                if (full) {
                    batchInventory = full;
                } else {
                    batchInventory = new Map(cachedPlan.inventory);
                    for (const hash of attemptedHashes) {
                        if (delta.has(hash)) batchInventory.set(hash, delta.get(hash));
                        else batchInventory.delete(hash);
                    }
                }
            } else {
                batchInventory = await readIdentityInventory(collectionId, settings);
            }
            ledgerFinished = await finishIdentityLedger(identityLedger, identityReconciliation, identityGroups, batchInventory);
            if (!ledgerFinished) {
                console.warn('VectHare: Identity ledger remains dirty; incomplete indexed evidence');
            } else if (chunksCreated > 0) {
                // A group written this pass can supersede an indexed one (appended
                // messages re-open the last batch/turn). Its old vector is removed by
                // the reverse cleanup, which is otherwise throttled to every 5 min;
                // mark the collection so the next pass cleans it straight away
                // instead of leaving those messages stored twice meanwhile.
                const currentHashes = new Set(identityGroups.map(group => String(group.hash)));
                if (identityLedger.groups.some(group => group.indexed && !currentHashes.has(String(group.hash)))) {
                    try {
                        setCollectionMeta(collectionId, { needsReconciliation: true });
                    } catch (error) {
                        console.debug('VectHare: Could not mark collection for cleanup:', error.message);
                    }
                }
            }
        }

        // P1: keep the plan for the run's next batch only after a clean batch
        // whose every written hash is confirmed stored.
        if (runCache && itemsFailed === 0 && ledgerFinished && !isVectorizationStopped() &&
            isChatTargetCurrent(target, collectionId) && groupedChatUnchanged()) {
            try {
                const present = identityLedger ? batchInventory
                    : await readInventoryForHashes(collectionId, settings, attemptedHashes, async () => {
                        const saved = await getSavedHashes(collectionId, settings, false, getStopSignal());
                        return new Map(saved.map(hash => [String(hash), []]));
                    });
                if (attemptedHashes.every(hash => present.has(hash))) {
                    for (const hash of attemptedHashes) existingHashes.add(hash);
                    runCache.plan = {
                        collectionId, generation: planGeneration, mutation: planMutation,
                        messages: target.messages, length: target.messages.length,
                        configKey: planConfigKey, unchanged: groupedChatUnchanged,
                        existingHashes, groupedItems, identityLedger, identityReconciliation, identityGroups,
                        inventory: identityLedger ? batchInventory : null,
                    };
                }
            } catch (error) {
                console.debug('VectHare: Sync plan not kept for the next batch:', error.message);
            }
        }

        if (itemsFailed > 0) {
            console.warn(`VectHare: Sync completed with ${itemsFailed} failed items out of ${itemsProcessed}`);
        }

        return {
            remaining: queue.size + itemsFailed,
            messagesProcessed: itemsProcessed,
            chunksCreated,
            groupsCompleted,
            itemsFailed,
            total: groupedItems.length // R7: whole-collection group count for progress display
        };
    } catch (error) {
        if (error?.code === 'VH_LEDGER_CONFLICT') {
            // 8B: another tab staged this chat's ledger first. Nothing this pass
            // had not confirmed was changed; the next pass re-reads and goes on.
            console.info('VectHare: Another tab is updating this chat; this Sync pass was deferred');
            return syncDeferred();
        }
        if (error?.code === 'VH_STALE_CHAT_VIEW') {
            // VH-081: nothing was changed; the user reloads this chat.
            noteStaleChatView(error);
            console.warn('VectHare: Sync skipped:', error.message);
            if (bypassAutoSync) throw error;
            return syncDeferred();
        }
        console.error('VectHare: Sync failed', error);
        throw error;
    } finally {
        syncBlocked = false;
    }
    } finally {
        endChatCollectionWrite(collectionId);
        await syncLease?.release();
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
    const chatCollectionId = getChatCollectionId();
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
        if (collectionId === chatCollectionId) {
            continue;
        }

        // Check if collection is enabled. getCollectionMeta/isCollectionEnabled resolve
        // metadata across bare-id/registry-key/legacy forms internally, so the bare
        // collectionId works for both the enabled check and the actual query.
        if (isCollectionEnabled(collectionId)) {
            collectionsToQuery.push(collectionId);
        }
    }

    // Add explicitly selected/forced collections for this chat. These bypass
    // trigger/condition activation later, but still respect disabled state here.
    for (const selectedId of chatPolicy.selectedCollections || []) {
        const alreadyIncluded = collectionsToQuery.some(id => {
            const parsedExisting = parseRegistryKey(id);
            const parsedSelected = parseRegistryKey(selectedId);
            return id === selectedId || parsedExisting.collectionId === parsedSelected.collectionId;
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

// Shared by early candidate filtering and the final Stage 9 deduplication.
// VectHare's existing setting defines 0 as checking the ENTIRE chat.
function getRecentMessagesForDedup(chat, settings) {
    const depth = settings.deduplication_depth ?? 50;
    return depth > 0 && depth < chat.length ? chat.slice(-depth) : chat;
}

const RAG_QUERY_CONCURRENCY = 4;

/**
 * P2: the one source of truth for how many items a Sync/Repair pass takes,
 * used by Sync Chat, Repair, auto-sync and Content Vectorizer alike.
 * `embedding_batch_size` when set; otherwise 8 for local transformers, 5 else.
 * (Transformers still embeds one item per request inside insertVectorItems.)
 * @param {object} settings VectHare settings
 * @returns {number}
 */
export function getSyncBatchSize(settings) {
    const configured = Number(settings?.embedding_batch_size);
    if (Number.isSafeInteger(configured) && configured > 0) return Math.min(configured, 100);
    // The "Insert Batch Size" slider is the only batch control in the UI. It
    // already sized each request inside insertVectorItems, but a Sync pass only
    // ever handed over 5 (or 8) items, so setting it had no visible effect on
    // chat Sync. Once the user has changed it (flag, or any value other than the
    // factory 50), the pass uses it too; untouched installs keep 5 / 8.
    const insert = Number(settings?.insert_batch_size);
    if (Number.isSafeInteger(insert) && insert > 0 &&
        (settings?.insert_batch_size_set === true || insert !== 50)) {
        return Math.min(insert, 100);
    }
    return (settings?.source || 'transformers') === 'transformers' ? 8 : 5;
}

let legacyModule = null;
void import('./legacy-collections.js').then(m => { legacyModule = m; }).catch(() => {});

// C10: tell the user once per chat per reason when memories are skipped.
// The console keeps the details; the toast is the visible hint.
const toastedRagIssues = new Set();
function reportRagIssues(issues, debugData) {
    if (!Array.isArray(issues) || issues.length === 0) return;
    // VH-061: an older collection whose vector size differs from today's model
    // is not used from now on, with one re-vectorize notice instead of a raw
    // dimension error.
    if (legacyModule) {
        issues = issues.filter(issue => {
            if (!legacyModule.isLegacyCollection(issue.collectionId) ||
                !/dimension|vector size|expected dim|wrong vector/i.test(String(issue.reason))) return true;
            legacyModule.markLegacyMismatch(issue.collectionId, null, 'its vector size differs from the current model');
            legacyModule.noteLegacyNotUsed(issue.collectionId, getCollectionMeta(issue.collectionId)?.displayName,
                'its vector size differs from the current model');
            return false;
        });
        if (!issues.length) return;
    }
    debugData.ragIssues = issues.map(issue => ({
        collectionId: issue.collectionId,
        label: getCollectionMeta(issue.collectionId)?.displayName || issue.collectionId,
        // The message usually starts with "Collection <id>: "; the label already says which.
        reason: String(issue.reason || 'unknown reason').replace(/^Collection \S+: /, ''),
    }));
    let chatKey = '';
    try { chatKey = String(getCurrentChatId() ?? ''); } catch { chatKey = ''; }
    const byReason = new Map();
    for (const issue of debugData.ragIssues) {
        if (!byReason.has(issue.reason)) byReason.set(issue.reason, []);
        const labels = byReason.get(issue.reason);
        if (!labels.includes(issue.label)) labels.push(issue.label);
    }
    for (const [reason, labels] of byReason) {
        const key = JSON.stringify([chatKey, reason]);
        if (toastedRagIssues.has(key)) continue;
        if (toastedRagIssues.size >= 200) toastedRagIssues.clear();
        toastedRagIssues.add(key);
        try {
            toastr.warning(`Memories skipped: ${labels.join(', ')} \u2014 ${reason}. Open VectHare \u2192 Database Browser`,
                'VectHare', { timeOut: 10000 });
        } catch { /* toast is a hint only */ }
    }
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
async function queryAndMergeCollections(activeCollections, queryText, settings, chat, debugData) {
    let chunksForVisualizer = [];
    const effectiveTopK = settings.top_k ?? settings.insert;
    // Retrieve replacement candidates before Stage 9 dedup, without reducing configured top-K.
    const candidateTopK = Math.max(effectiveTopK, Math.min(100, effectiveTopK * 3));

    // PERF: Build hash-to-message Map once for O(1) lookups instead of O(n) find() per chunk
    const chatHashMap = new Map();
    for (const msg of chat) {
        if (msg.mes) {
            // R22: raw-text hash - must match the storage-side formula, or the
            // text-fallback lookup silently misses macro-containing messages
            const hash = getStringHash(getTextWithoutAttachments(msg));
            if (!chatHashMap.has(hash)) {
                chatHashMap.set(hash, msg);
            }
        }
    }

    // #52: one embedding per embedding configuration for the whole retrieval,
    // instead of one per collection.
    const queryVectorCache = new Map();

    // C10: collections that return nothing because they were skipped or failed.
    const ragIssues = [];
    // C9: message hashes that exist in the current chat, and which collection
    // is this chat's own (only that one is checked for stale chunks).
    const chatHashKeys = new Set([...chatHashMap.keys()].map(String));
    let ownChatCollectionId = null;
    try { ownChatCollectionId = peekChatCollectionId(); } catch { ownChatCollectionId = null; }
    const isOwnChatCollection = id => !!ownChatCollectionId &&
        (parseRegistryKey(id).collectionId || id) === ownChatCollectionId;
    let staleChunksDropped = 0;

    const queryOne = async (collectionId) => {
        try {
            const queryResults = await queryCollection(collectionId, queryText, candidateTopK,
                settings, queryVectorCache, ragIssues);

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

            vhLog(`VectHare: Retrieved ${queryResults.hashes.length} chunks from ${collectionId}`);

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
                    finalScore: meta.score ?? 1.0,
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
                    score: meta.score ?? 1.0,
                    originalScore: meta.originalScore,
                    keywordBoost: meta.keywordBoost,
                    matchedKeywords: meta.matchedKeywords,
                    matchedKeywordsWithWeights: meta.matchedKeywordsWithWeights,
                    keywordBoosted: meta.keywordBoosted,
                    similarity: meta.score ?? 1.0,
                    text: text,
                    index: meta.messageId || meta.index || 0,
                    collectionId: collectionId,
                    decayApplied: false,
                    // Hybrid search scores
                    vectorScore: meta.vectorScore,
                    textScore: meta.textScore,
                    hybridSearch: meta.hybridSearch
                };
            });

            // C9: a chunk of this chat's own collection whose messages are all gone
            // from the chat (deleted/edited since it was stored) must not be injected.
            // Other collections (lorebooks, documents, other chats) are untouched.
            const liveChunks = !isOwnChatCollection(collectionId) ? collectionChunks : collectionChunks.filter(chunk => {
                const members = chunk.metadata?.messageHashes;
                if (!Array.isArray(members) || members.length === 0) return true;
                if (members.some(hash => chatHashKeys.has(String(hash)))) return true;
                staleChunksDropped++;
                recordChunkFate(debugData, chunk.hash, 'stale_chunk', 'dropped',
                    'None of the messages this chunk was made from exist in the chat any more',
                    { collectionId });
                return false;
            });

            return liveChunks;
        } catch (error) {
            console.warn(`VectHare: Failed to query collection ${collectionId}:`, error.message);
            addTrace(debugData, 'vector_search', `Query failed for ${collectionId}`, {
                error: error.message
            });
            ragIssues.push({ collectionId, reason: String(error?.message || error) });
            return [];
        }
    };

    // P3: collections are queried 4 at a time. The first runs alone so the
    // shared query-vector cache is filled once before the others reuse it.
    // Results keep the collection order.
    const perCollection = [];
    if (activeCollections.length) {
        perCollection.push(await queryOne(activeCollections[0]));
        perCollection.push(...await AsyncUtils.parallel(
            activeCollections.slice(1).map(collectionId => () => queryOne(collectionId)),
            RAG_QUERY_CONCURRENCY));
    }
    for (const list of perCollection) chunksForVisualizer.push(...list);

    debugData.staleChunksDropped = staleChunksDropped;
    if (staleChunksDropped > 0) {
        addTrace(debugData, 'stale_chunk', 'Dropped chunks whose source messages are gone', { dropped: staleChunksDropped });
    }
    reportRagIssues(ragIssues, debugData);

    // Filter exact recent-message duplicates before the global top-K.
    // Stage 9 remains authoritative after summary/group/link processing.
    const recentHashes = new Set(getRecentMessagesForDedup(chat, settings)
        .filter(message => message.mes)
        .map(message => getStringHash(getTextWithoutAttachments(message))));
    // #12: grouped chunks hash their combined text, so the early filter needs
    // the same member-level check Stage 9 uses.
    const recentHashKeys = new Set([...recentHashes].map(String));
    const fullyInRecentContext = chunk => {
        const members = chunk.metadata?.messageHashes ?? chunk.messageHashes;
        // Any size: a one-message group of a grouped strategy hashes its
        // speaker-labelled text, so only its member hash shows it is in context.
        return Array.isArray(members) && members.length > 0 &&
            members.every(hash => recentHashKeys.has(String(hash)));
    };
    chunksForVisualizer = chunksForVisualizer.filter(chunk =>
        !recentHashes.has(chunk.hash) && !fullyInRecentContext(chunk));

    chunksForVisualizer.sort((a, b) => b.score - a.score);
    // The overfetched candidates are deliberately kept here: the threshold,
    // decay, condition and deduplication stages all remove chunks, and trimming
    // to top-K this early left fewer memories than configured with no
    // replacements for deduplicated ones. The top-K cap is applied once the
    // final injection set is known (Stage 9).
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
    const parentHashesNeeded = new Map(); // [collectionId, parentHash] -> { parentHash, summaryChunk, collectionId }

    // First pass: identify which chunks are summaries and need parent expansion
    for (const chunk of chunks) {
        const meta = chunk.metadata || {};
        const isSummary = meta.isSummaryChunk || meta.isSummary || meta.isSummaryVector;
        const parentHash = meta.parentHash;

        if (isSummary && parentHash) {
            // Track this summary for parent lookup
            const parentKey = JSON.stringify([chunk.collectionId, String(parentHash)]);
            const previous = parentHashesNeeded.get(parentKey);
            if (!previous || (chunk.score ?? -Infinity) > (previous.summaryChunk.score ?? -Infinity)) {
                parentHashesNeeded.set(parentKey, {
                    parentHash: String(parentHash),
                    summaryChunk: chunk,
                    collectionId: chunk.collectionId
                });
            }

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
    for (const { parentHash, summaryChunk, collectionId } of parentHashesNeeded.values()) {
        if (!parentsByCollection.has(collectionId)) {
            parentsByCollection.set(collectionId, []);
        }
        parentsByCollection.get(collectionId).push({ parentHash, summaryChunk });
    }

    // Fetch parents from each collection
    for (const [collectionId, parentInfos] of parentsByCollection) {
        try {
            // VH-042: read just the parents, with the collection's own settings
            // (not today's global ones, which may name another backend or model).
            const collectionSettings = await resolveEmbeddingSettingsForEdit(collectionId, settings);
            const records = collectionSettings
                ? await readInventoryForHashes(collectionId, collectionSettings, parentInfos.map(info => info.parentHash))
                : null;

            if (records) {
                const chunkLookup = new Map();
                for (const [hash, copies] of records) {
                    if (copies?.length) chunkLookup.set(String(hash), copies[0]);
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
    if (!settings.temporal_decay || !settings.temporal_decay.enabled) {
        addTrace(debugData, 'decay', 'Temporal decay skipped (disabled)', { enabled: false });
        chunks.forEach(chunk => {
            recordChunkFate(debugData, chunk.hash, 'decay', 'passed', 'Decay disabled', {
                score: chunk.score
            });
        });
        return chunks;
    }

    const beforeCount = chunks.length;
    addTrace(debugData, 'decay', 'Starting temporal decay', {
        enabled: true,
        sceneAware: settings.temporal_decay.sceneAware,
        halfLife: settings.temporal_decay.halfLife || settings.temporal_decay.half_life,
        strength: settings.temporal_decay.strength || settings.temporal_decay.rate
    });

    const currentMessageId = chat.length - 1;
    const chunksWithScores = chunks.map(chunk => ({
        hash: chunk.hash,
        metadata: chunk.metadata,
        score: chunk.score
    }));

    let decayedChunks;
    let decayType = 'standard';

    // Use scene-aware decay if enabled and scenes exist
    if (settings.temporal_decay.sceneAware) {
        const sceneChunks = chunks.filter(c => c.metadata?.isScene === true);
        const scenes = sceneChunks.map(c => ({
            start: c.metadata.sceneStart,
            end: c.metadata.sceneEnd,
            hash: c.hash,
        }));

        if (scenes.length > 0) {
            decayedChunks = applySceneAwareDecay(chunksWithScores, currentMessageId, scenes, settings.temporal_decay);
            decayType = 'scene_aware';
            vhLog('VectHare: Applied scene-aware temporal decay to search results');
        } else {
            decayedChunks = applyDecayToResults(chunksWithScores, currentMessageId, settings.temporal_decay);
            decayType = 'standard_no_scenes';
            vhLog('VectHare: Applied temporal decay to search results (no scenes marked)');
        }
    } else {
        decayedChunks = applyDecayToResults(chunksWithScores, currentMessageId, settings.temporal_decay);
        vhLog('VectHare: Applied temporal decay to search results');
    }

    decayedChunks.sort((a, b) => b.score - a.score);

    // PERF: Build Map for O(1) lookups instead of O(n) find() per chunk
    const decayedChunksMap = new Map(decayedChunks.map(dc => [dc.hash, dc]));

    // Map decay results back to chunks and record fate
    let result = chunks.map(chunk => {
        const decayedChunk = decayedChunksMap.get(chunk.hash);
        if (decayedChunk && (decayedChunk.decayApplied || decayedChunk.sceneAwareDecay)) {
            const decayMultiplier = decayedChunk.score / (decayedChunk.originalScore || 1);
            const newScore = decayedChunk.score;
            const stillAboveThreshold = newScore >= threshold;

            if (stillAboveThreshold) {
                recordChunkFate(debugData, chunk.hash, 'decay', 'passed', null, {
                    originalScore: decayedChunk.originalScore,
                    decayedScore: newScore,
                    decayMultiplier,
                    messageAge: decayedChunk.messageAge || decayedChunk.effectiveAge,
                    decayType
                });
            } else {
                recordChunkFate(debugData, chunk.hash, 'decay', 'dropped',
                    `Decayed score ${newScore.toFixed(3)} < threshold ${threshold}`,
                    {
                        originalScore: decayedChunk.originalScore,
                        decayedScore: newScore,
                        decayMultiplier,
                        messageAge: decayedChunk.messageAge || decayedChunk.effectiveAge,
                        decayType
                    }
                );
            }

            return {
                ...chunk,
                score: newScore,
                originalScore: decayedChunk.originalScore,
                messageAge: decayedChunk.messageAge || decayedChunk.effectiveAge,
                decayApplied: true,
                sceneAwareDecay: decayedChunk.sceneAwareDecay || false,
                decayMultiplier
            };
        }

        recordChunkFate(debugData, chunk.hash, 'decay', 'passed', 'No decay applied', {
            score: chunk.score
        });
        return chunk;
    });

    // Re-filter by threshold after decay
    result = result.filter(c => c.score >= threshold);

    addTrace(debugData, 'decay', 'Temporal decay completed', {
        decayType,
        before: beforeCount,
        after: result.length,
        dropped: beforeCount - result.length
    });

    return result;
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
    const beforeCount = chunks.length;
    let processedChunks = [...chunks];

    addTrace(debugData, 'groups', 'Starting groups and links processing', {
        chunksCount: beforeCount,
        collectionsToCheck: activeCollections.length
    });

    // Collect groups from all active collections
    // PERF: Count modes during collection instead of separate filter passes
    const allGroups = [];
    let inclusiveCount = 0;
    let exclusiveCount = 0;
    for (const collectionId of activeCollections) {
        const meta = getCollectionMeta(collectionId);
        if (meta.groups && meta.groups.length > 0) {
            for (const group of meta.groups) {
                allGroups.push(group);
                if (group.mode === 'inclusive') inclusiveCount++;
                else if (group.mode === 'exclusive') exclusiveCount++;
            }
        }
    }

    if (allGroups.length === 0) {
        addTrace(debugData, 'groups', 'No groups defined in active collections', {});
        // Still process explicit chunk links even without groups
    } else {
        addTrace(debugData, 'groups', `Found ${allGroups.length} groups across collections`, {
            inclusive: inclusiveCount,
            exclusive: exclusiveCount
        });

        // Build a map of all chunks for mandatory group lookup
        const allChunksMap = new Map(chunks.map(c => [String(c.hash), c]));

        // Process groups
        const groupResult = processChunkGroups(chunks, allGroups, allChunksMap, {
            softBoost: settings.group_soft_boost || 0.15
        });

        processedChunks = groupResult.chunks;

        // Log group processing results
        if (groupResult.debug.excluded.length > 0) {
            addTrace(debugData, 'groups', `Exclusive groups filtered ${groupResult.debug.excluded.length} chunks`, {
                excluded: groupResult.debug.excluded.map(e => ({
                    hash: String(e.hash).substring(0, 8),
                    group: e.groupName,
                    beatBy: String(e.beatBy).substring(0, 8)
                }))
            });

            // Record fates for excluded chunks
            for (const ex of groupResult.debug.excluded) {
                recordChunkFate(debugData, ex.hash, 'groups', 'dropped',
                    `Excluded by group "${ex.groupName}" - beaten by chunk #${String(ex.beatBy).substring(0, 8)}`,
                    { score: ex.score, winnerScore: ex.winnerScore }
                );
            }
        }

        if (groupResult.debug.forced.length > 0) {
            addTrace(debugData, 'groups', `Mandatory groups force-included ${groupResult.debug.forced.length} chunks`, {
                forced: groupResult.debug.forced.map(f => ({
                    hash: String(f.hash).substring(0, 8),
                    group: f.groupName
                }))
            });

            // Record fates for forced chunks
            for (const f of groupResult.debug.forced) {
                recordChunkFate(debugData, f.hash, 'groups', 'passed',
                    `Force-included by mandatory group "${f.groupName}"`,
                    { reason: f.reason }
                );
            }
        }

        // PERF: Build chunk metadata map ONCE and reuse for both virtual and explicit links
        const chunkMetadataMap = new Map();
        for (const chunk of processedChunks) {
            const meta = getChunkMetadata(chunk.hash, chunk.collectionId) || {};
            chunkMetadataMap.set(String(chunk.hash), meta);
        }

        // If there are virtual links from inclusive groups, merge them with chunk metadata
        if (groupResult.virtualLinks && groupResult.virtualLinks.size > 0) {
            addTrace(debugData, 'groups', `Inclusive groups generated ${groupResult.debug.virtualLinksCreated} virtual links`, {});

            // Merge virtual links into metadata
            const mergedMetadata = mergeVirtualLinks(chunkMetadataMap, groupResult.virtualLinks);

            // Process links (both explicit and group-generated)
            const linkResult = processChunkLinks(processedChunks, mergedMetadata, settings.group_soft_boost || 0.15);
            processedChunks = linkResult.chunks;

            // Handle hard-linked chunks that need to be fetched
            // Note: Fetching missing hard-linked chunks would require additional backend calls
            // and complex deduplication logic. Currently, hard links only boost already-matched chunks.
            if (linkResult.missingHardLinks && linkResult.missingHardLinks.length > 0) {
                addTrace(debugData, 'groups', `Hard links require ${linkResult.missingHardLinks.length} additional chunks (not fetched)`, {
                    hashes: linkResult.missingHardLinks.map(h => String(h).substring(0, 8))
                });
            }

            // Log soft link boosts
            const boostedChunks = processedChunks.filter(c => c.softLinked);
            if (boostedChunks.length > 0) {
                addTrace(debugData, 'groups', `Soft links boosted ${boostedChunks.length} chunks`, {
                    boosted: boostedChunks.map(c => ({
                        hash: String(c.hash).substring(0, 8),
                        boost: c.linkBoost
                    }))
                });
            }
        } else {
            // No virtual links - process explicit chunk links only
            // Filter to only chunks with explicit links
            const chunksWithLinks = new Map();
            for (const [hash, meta] of chunkMetadataMap) {
                if (meta.links && meta.links.length > 0) {
                    chunksWithLinks.set(hash, meta);
                }
            }

            if (chunksWithLinks.size > 0) {
                const linkResult = processChunkLinks(processedChunks, chunksWithLinks, settings.group_soft_boost || 0.15);
                processedChunks = linkResult.chunks;

                const boostedByExplicitLinks = processedChunks.filter(c => c.softLinked && !c.groupBoosted);
                if (boostedByExplicitLinks.length > 0) {
                    addTrace(debugData, 'links', `Explicit links boosted ${boostedByExplicitLinks.length} chunks`, {});
                }
            }
        }
    }

    // Also process explicit chunk links when there are no groups at all
    // (This handles the case where allGroups.length === 0)
    if (allGroups.length === 0) {
        // PERF: Build metadata map once for chunks with links only
        const chunkMetadataMap = new Map();
        for (const chunk of processedChunks) {
            const meta = getChunkMetadata(chunk.hash, chunk.collectionId) || {};
            if (meta.links && meta.links.length > 0) {
                chunkMetadataMap.set(String(chunk.hash), meta);
            }
        }

        if (chunkMetadataMap.size > 0) {
            const linkResult = processChunkLinks(processedChunks, chunkMetadataMap, settings.group_soft_boost || 0.15);
            processedChunks = linkResult.chunks;

            const boostedByExplicitLinks = processedChunks.filter(c => c.softLinked && !c.groupBoosted);
            if (boostedByExplicitLinks.length > 0) {
                addTrace(debugData, 'links', `Explicit links boosted ${boostedByExplicitLinks.length} chunks`, {});
            }
        }
    }

    addTrace(debugData, 'groups', 'Groups and links processing complete', {
        before: beforeCount,
        after: processedChunks.length,
        groupsProcessed: allGroups.length
    });

    return processedChunks;
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

    // Use the exact same depth semantics as the early top-K candidate filter.
    const recentMessages = getRecentMessagesForDedup(chat, settings);

    vhLog(`[VectHare Dedup] Building hash set from ${recentMessages.length} recent messages (depth: ${deduplicationDepth})`);
    vhLog(`[VectHare Dedup] Total chat length: ${chat.length}, checking duplicates in last ${recentMessages.length} messages`);

    // Build set of hashes currently in chat context
    const currentChatHashes = new Set();
    const chatHashMap = new Map(); // For debugging: hash -> message preview

    recentMessages.forEach((msg, idx) => {
        if (msg.mes) {
            const cleanedText = substituteParams(getTextWithoutAttachments(msg));
            // R22: raw-text hash - must match the storage-side formula
            const hash = getStringHash(getTextWithoutAttachments(msg));
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

    vhLog(`[VectHare Dedup] Built hash set with ${currentChatHashes.size} unique message hashes from recent context`);

    // #12: a grouped chunk is hashed over its combined text, so its hash never
    // equals a single message's hash. It is still redundant when every message
    // it was built from is already in the recent context. A partially-present
    // group still carries information and is kept.
    const currentChatHashKeys = new Set([...currentChatHashes].map(String));
    const groupMemberHashes = chunk => {
        const stored = chunk.metadata?.messageHashes ?? chunk.messageHashes;
        return Array.isArray(stored) && stored.length > 0 ? stored.map(String) : null;
    };

    const toInject = [];
    const skipped = [];

    for (const chunk of chunks) {
        const members = groupMemberHashes(chunk);
        const isInChat = currentChatHashes.has(chunk.hash) ||
            (members !== null && members.every(hash => currentChatHashKeys.has(hash)));

        if (isInChat) {
            const matchedMsg = chatHashMap.get(chunk.hash);
            console.debug(`[VectHare Dedup] ❌ SKIPPING chunk (hash: ${chunk.hash})`);
            console.debug(`  Chunk text: "${chunk.text?.substring(0, 80)}..."`);
            console.debug(matchedMsg
                ? `  Matches chat message #${matchedMsg.index} from ${matchedMsg.name}: "${matchedMsg.preview}..."`
                : `  Every message in this group (${members?.length ?? 0}) is already in recent context`);
            console.debug(`  Score: ${chunk.score?.toFixed(4)}, Collection: ${chunk.collectionId}`);

            skipped.push(chunk);
            recordChunkFate(debugData, chunk.hash, 'injection', 'skipped',
                matchedMsg ? 'Already in current chat context - no injection needed'
                    : 'Every message of this group is already in current chat context',
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

    vhLog(`[VectHare Dedup] FINAL: ${toInject.length} will inject, ${skipped.length} skipped as duplicates`);

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
function getRagInjectionChunkText(chunk, settings) {
    const text = typeof chunk?.text === 'string' && chunk.text
        ? chunk.text
        : '(text not available)';

    // Only alter the text sent to regular Qdrant RAG prompts.
    if (settings?.include_keywords_in_rag_context === true || settings?.vector_backend !== 'qdrant') {
        return text;
    }

    const keywords = chunk?.metadata?.keywords;
    if (!Array.isArray(keywords) || keywords.length === 0) {
        return text;
    }

    // Matches Qdrant's generated suffix, without stripping arbitrary user-authored tags.
    const keywordTexts = keywords.map(kw => kw?.text || kw).join(' ');
    const suffix = ` [KEYWORDS: ${keywordTexts}]`;
    const trimmedText = text.trimEnd();

    if (!trimmedText.endsWith(suffix)) {
        return text;
    }

    // Handle repeated identical suffixes; preserve trailing whitespace exactly.
    let originalText = trimmedText;
    while (originalText.endsWith(suffix)) {
        originalText = originalText.slice(0, -suffix.length);
    }

    // Do not turn a suffix-only chunk into empty injected memory text.
    if (!originalText.trim()) {
        return text;
    }

    return originalText + text.slice(trimmedText.length);
}

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
            const chunkMeta = getChunkMetadata(chunk.hash, collectionId) || {};
            const chunkContext = chunkMeta.context ? substituteParams(chunkMeta.context) : '';
            const chunkXmlTag = chunkMeta.xmlTag || '';
            const text = getRagInjectionChunkText(chunk, settings);

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
    const chunkMeta = getChunkMetadata(chunk.hash, chunk.collectionId) || {};
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
    vhLog(`[VectHare Injection Control] Preparing to inject ${chunksToInject.length} chunks`);
    vhLog('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    let emptyTextCount = 0;
    chunksToInject.forEach((chunk, idx) => {
        const textLength = chunk.text?.length || 0;
        const hasValidText = textLength > 0 && chunk.text !== '(text not found)' && chunk.text !== '(text not available)';
        if (!hasValidText) emptyTextCount++;

        vhLog(`  [${idx + 1}/${chunksToInject.length}] CHUNK QUEUED FOR INJECTION ${!hasValidText ? '⚠️ EMPTY/INVALID TEXT' : ''}`);
        vhLog(`      Hash: ${chunk.hash}`);
        vhLog(`      Score: ${chunk.score?.toFixed(4)}`);
        vhLog(`      Collection: ${chunk.collectionId}`);
        vhLog(`      Text length: ${textLength} chars ${!hasValidText ? '⚠️' : '✓'}`);
        vhLog(`      Text preview: "${chunk.text?.substring(0, 120)}${textLength > 120 ? '...' : ''}"`);
        vhLog('      ─────────────────────────────────────────────────────────────────');
    });
    if (emptyTextCount > 0) {
        console.warn(`[VectHare Injection Control] ⚠️ WARNING: ${emptyTextCount}/${chunksToInject.length} chunks have empty or placeholder text!`);
    }
    vhLog('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

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

        vhLog(`[VectHare Injection Control] Single position injection: position="${group.position}", depth=${group.depth}, chunks=${group.chunks.length}, textLength=${insertedText.length}`);
        vhLog(`[VectHare Injection Control] Injection text preview: "${insertedText.substring(0, 200)}${insertedText.length > 200 ? '...' : ''}"`);

        setExtensionPrompt(EXTENSION_PROMPT_TAG, insertedText, group.position, group.depth, false);

        // Verify injection
        const verifiedPrompt = extension_prompts[EXTENSION_PROMPT_TAG];
        const injectionVerified = verifiedPrompt && verifiedPrompt.value === insertedText;

        vhLog(`[VectHare Injection Control] Injection verification: ${injectionVerified ? '✓ PASSED' : '✗ FAILED'}`);
        vhLog(`[VectHare Injection Control] extension_prompts[${EXTENSION_PROMPT_TAG}]:`, {
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
    vhLog(`[VectHare Injection Control] Multiple position injection: ${positionGroups.size} different positions`);

    // Clear the main tag first (will be unused when multi-position)
    setExtensionPrompt(EXTENSION_PROMPT_TAG, '', settings.position, settings.depth, false);

    let allVerified = true;
    const allTexts = [];
    let groupIndex = 0;

    for (const [key, group] of positionGroups) {
        // Build text for this position group (no global wrapper - that goes on outermost only)
        const groupSettings = { ...settings, rag_context: '', rag_xml_tag: '' };
        const groupText = buildNestedInjectionText(group.chunks, groupSettings);

        vhLog(`[VectHare Injection Control] Position group ${groupIndex + 1}/${positionGroups.size}: key="${key}", chunks=${group.chunks.length}, textLength=${groupText.length}`);
        group.chunks.forEach((chunk, idx) => {
            vhLog(`    [${idx + 1}/${group.chunks.length}] Hash: ${chunk.hash}, Score: ${chunk.score?.toFixed(4)}`);
        });

        // Use unique tag per position group
        const tag = `${EXTENSION_PROMPT_TAG}_pos${groupIndex}`;

        setExtensionPrompt(tag, groupText, group.position, group.depth, false);

        // Verify
        const verifiedPrompt = extension_prompts[tag];
        const verified = verifiedPrompt && verifiedPrompt.value === groupText;

        vhLog(`[VectHare Injection Control] Position group ${groupIndex + 1} verification: ${verified ? '✓ PASSED' : '✗ FAILED'}`);

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

    vhLog(`[VectHare Injection Control] Injection complete: ${allVerified ? '✓ All verified' : '✗ Some failed'}, ${allTexts.length} groups`);

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
// VH-019: retrieval at generation has a deadline (settings.rag_timeout_seconds,
// default 15; 0 = no limit). On timeout nothing is injected, the generation goes
// on, and a late result from that retrieval is discarded.
let ragRunCounter = 0;
const ragRunsTimedOut = new Set();
const RAG_TIMED_OUT = Symbol('rag-timed-out');
let ragTimeoutNoticeAt = 0;

export async function rearrangeChat(chat, settings, type) {
    const seconds = Number(settings?.rag_timeout_seconds ?? 15);
    const run = ++ragRunCounter;
    const isCurrentRun = () => run === ragRunCounter && !ragRunsTimedOut.has(run);
    const inner = rearrangeChatWithinDeadline(chat, settings, type, isCurrentRun);
    if (!(seconds > 0) || type === 'quiet') return inner;
    let timer;
    const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(RAG_TIMED_OUT), seconds * 1000); });
    const result = await Promise.race([inner, deadline]);
    clearTimeout(timer);
    if (result !== RAG_TIMED_OUT) return result;
    ragRunsTimedOut.add(run);
    inner.catch(() => {}).finally(() => ragRunsTimedOut.delete(run));
    // nothing from this retrieval goes into the prompt
    setExtensionPrompt(EXTENSION_PROMPT_TAG, '', settings.position, settings.depth, false);
    for (let i = 0; i < 10; i++) {
        const posTag = `${EXTENSION_PROMPT_TAG}_pos${i}`;
        if (extension_prompts[posTag]) setExtensionPrompt(posTag, '', 0, 0, false);
    }
    console.warn(`VectHare: retrieval did not finish within ${seconds} s; no memories were added to this message`);
    if (Date.now() - ragTimeoutNoticeAt > 60_000) {
        ragTimeoutNoticeAt = Date.now();
        toastr.warning(`Memories were skipped for this message: the embedding or vector backend did not answer within ${seconds} s. ` +
            'Check that it is running (the limit is "Retrieval time limit" in VectHare settings).', 'VectHare', { timeOut: 10000 });
    }
    return undefined;
}

async function rearrangeChatWithinDeadline(chat, settings, type, isCurrentRun) {
    vhLog(`🐰 VectHare: rearrangeChat called (type: ${type}, chat length: ${chat?.length || 0})`);
    // VH-109: pick up other tabs' changes first (one small request). A tab
    // whose copy of the store is out of date looked for a collection another
    // tab or device had just written where today's rule puts NEW collections;
    // on multitenant Qdrant that is a different place, so nothing was recalled.
    await refreshStoreIfStale({ minIntervalMs: 0 }).catch(() => false);

    try {
        // === EARLY EXITS ===
        if (type === 'quiet') {
            console.debug('VectHare: Skipping quiet prompt');
            return;
        }

        // C11: remember which chat this retrieval is for. Retrieval awaits the
        // network several times; if the user switched chats meanwhile, the result
        // belongs to the old chat and must not be injected into the new one.
        const chatTarget = captureChatTarget();
        const startChatId = getCurrentChatId();
        const startGeneration = chatSwitchGeneration;
        const retrievalStillForThisChat = () => isCurrentRun() && (chatTarget
            ? isChatTargetCurrent(chatTarget)
            : (getCurrentChatId() === startChatId && chatSwitchGeneration === startGeneration));

        // Clear extension prompts (main + any position-specific tags from previous run)
        setExtensionPrompt(EXTENSION_PROMPT_TAG, '', settings.position, settings.depth, false);
        // Clear position-specific tags (max 10 should be more than enough)
        for (let i = 0; i < 10; i++) {
            const posTag = `${EXTENSION_PROMPT_TAG}_pos${i}`;
            if (extension_prompts[posTag]) {
                setExtensionPrompt(posTag, '', 0, 0, false);
            }
        }

        if (!getCurrentChatId() || !Array.isArray(chat)) {
            console.debug('VectHare: No chat selected');
            return;
        }
        // Resolving an older chat must finish before gathering collections for
        // retrieval; a provisional/unbound chat contributes no chat vectors.
        await ensureChatBinding(undefined, { create: false });

        const minChatLength = settings.min_chat_length ?? 0;
        if (minChatLength > 0 && chat.length < minChatLength) {
            console.warn(`⚠️ VectHare: Not enough messages to inject chunks (${chat.length} < ${minChatLength})`);
            vhLog(`   💡 You need at least ${minChatLength} messages before chunk injection starts`);
            return;
        }

        // === STAGE 1: Gather collections to query ===
        const collectionsToQuery = gatherCollectionsToQuery(settings);
        // Allow continuing with WI-only mode if enabled_world_info is set
        const hasCollections = collectionsToQuery.length > 0;
        const canQueryWI = settings.enabled_world_info;

        if (!hasCollections && !canQueryWI) {
            console.warn('⚠️ VectHare: No enabled collections to query and World Info disabled - chunks cannot be injected!');
            vhLog('   💡 Make sure you have enabled at least one collection in VectHare settings, or enable World Info');
            return;
        }
        if (hasCollections) {
            vhLog(`VectHare: Will query ${collectionsToQuery.length} collections:`, collectionsToQuery);
        } else {
            vhLog('VectHare: No regular collections enabled, but World Info is enabled - will query lorebooks only');
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
        vhLog(`VectHare: Extracted ${queryKeywords.length} keywords from query:`, queryKeywordTexts);

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
            vhLog('⚠️ VectHare: No collections passed activation conditions and World Info disabled - chunks cannot be injected!');
            vhLog('   💡 Check your collection activation conditions in VectHare settings');
            return;
        }
        if (activeCollections.length > 0) {
            vhLog(`✅ VectHare: ${activeCollections.length} collections passed activation filters:`, activeCollections);
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

        // C12: let per-chunk annotations (disabled, etc.) of older shared records
        // be matched to the one collection that holds them before they are used.
        try { await primeChunkHashClaims(settings); } catch (error) {
            console.debug(`VectHare: annotation ownership check skipped: ${error.message}`);
        }

        // === STAGE 4: Query all collections and merge results ===
        let chunks = await queryAndMergeCollections(activeCollections, queryText, settings, chat, debugData);

        // === STAGE 4.1: Filter disabled chunks ===
        const beforeDisabledFilter = chunks.length;
        chunks = chunks.filter(chunk => {
            const meta = getChunkMetadata(chunk.hash, chunk.collectionId);
            if (meta?.disabled === true || meta?.enabled === false) {
                recordChunkFate(debugData, chunk.hash, 'disabled_filter', 'dropped',
                                'Chunk is disabled', { hash: chunk.hash });
                return false;
            }
            // F8: a scene whose messages changed since it was made is not injected.
            if (meta?.sceneOutdated === true && chunk.metadata?.isScene === true) {
                recordChunkFate(debugData, chunk.hash, 'disabled_filter', 'dropped',
                                'Scene is outdated (its messages changed) - re-create it in the chunk browser', { hash: chunk.hash });
                return false;
            }
            return true;
        });
        if (chunks.length !== beforeDisabledFilter) {
            vhLog(`VectHare: Disabled filter: ${beforeDisabledFilter} → ${chunks.length} chunks (${beforeDisabledFilter - chunks.length} disabled chunks removed)`);
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
                vhLog(`VectHare: Boosted ${keywordMatchCount}/${chunks.length} chunks with matching keywords to 100% score`);
                debugData.stages.afterKeywordBoost = [...chunks];
                debugData.stats.keywordBoosted = keywordMatchCount;
                addTrace(debugData, 'keyword_boost', `Boosted ${keywordMatchCount} chunks with keyword matches`, {
                    totalChunks: chunks.length,
                    boostedCount: keywordMatchCount
                });
            } else {
                vhLog(`VectHare: No chunks matched query keywords, all ${chunks.length} chunks keep original scores`);
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
                            score: e.score || 1.0,
                            originalScore: e.score || 1.0,
                            similarity: e.score || 1.0,
                            text: e.content || (Array.isArray(e.key) ? e.key.join(' ') : e.key || ''),
                            index: 0,
                            collectionId: e.collectionId || `vecthare_wi:${e.lorebookName || 'lorebook'}`,
                            decayApplied: false
                        };
                    });

                    // VH-038: a lorebook collection that is also queried as an active
                    // collection already returned this text; keep one copy.
                    const bareId = id => String(id || '').split(':').pop();
                    const textKey = text => String(text || '').replace(/\s+/g, ' ').trim();
                    const seen = new Set();
                    for (const chunk of chunks) {
                        seen.add(`${bareId(chunk.collectionId)}|${chunk.hash}`);
                        seen.add(`${bareId(chunk.collectionId)}|text:${textKey(chunk.text)}`);
                    }
                    const freshWi = wiChunks.filter((chunk, i) => {
                        const entry = wiEntries[i];
                        const id = bareId(chunk.collectionId);
                        const stored = entry?.metadata?.hash ?? entry?.hash;
                        return !(stored !== undefined && seen.has(`${id}|${stored}`)) && !seen.has(`${id}|text:${textKey(chunk.text)}`);
                    });
                    if (freshWi.length < wiChunks.length) {
                        addTrace(debugData, 'world_info', `Skipped ${wiChunks.length - freshWi.length} WI entries already retrieved from their collection`);
                    }

                    // Prepend WI chunks so they get considered equally in downstream stages
                    chunks = freshWi.concat(chunks);
                    debugData.stages.worldInfo = freshWi;
                }
            }
        } catch (wiError) {
            console.warn('VectHare: WorldInfo semantic integration failed', wiError.message);
            addTrace(debugData, 'world_info', 'WorldInfo query failed', { error: wiError.message });
        }
        vhLog(`VectHare: Retrieved ${chunks.length} total chunks from ${activeCollections.length} collections`);

        debugData.stages.initial = [...chunks];
        debugData.stats.retrievedFromVector = chunks.length;

        // === STAGE 4.5: Expand summary chunks to parent chunks (dual-vector) ===
        const chunksBeforeExpansion = chunks.length;
        chunks = await expandSummaryChunks(chunks, activeCollections, settings, debugData);
        if (chunks.length !== chunksBeforeExpansion || chunks.some(c => c.expandedFromSummary)) {
            const expandedCount = chunks.filter(c => c.expandedFromSummary).length;
            vhLog(`VectHare: Expanded ${expandedCount} summary chunks to parent text`);
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
        vhLog(`VectHare: Stored ${chunks.length} chunks for visualizer`);

        // === STAGE 9: Deduplicate ===
        vhLog(`[VectHare Deduplication] Starting with ${chunks.length} chunks before deduplication`);
        vhLog(`[VectHare Deduplication] Current chat has ${chat.length} messages`);

        const dedupResult = deduplicateChunks(chunks, chat, settings, debugData);
        const skippedDuplicates = dedupResult.skipped;
        // Apply the configured top-K to the final injection set. Chunks pulled
        // in by a mandatory group are kept regardless, as before.
        const injectionLimit = settings.top_k ?? settings.insert;
        let chunksToInject = dedupResult.toInject;
        if (Number.isFinite(injectionLimit) && injectionLimit > 0 &&
            chunksToInject.length > injectionLimit) {
            const forced = chunksToInject.filter(chunk => chunk.forcedByGroup != null);
            const ranked = chunksToInject.filter(chunk => chunk.forcedByGroup == null)
                .slice(0, Math.max(0, injectionLimit - forced.length));
            const keep = new Set([...forced, ...ranked]);
            vhLog(`[VectHare Deduplication] Trimming ${chunksToInject.length} candidates to top-${injectionLimit} (+${forced.length} group-forced)`);
            chunksToInject = chunksToInject.filter(chunk => keep.has(chunk));
        }

        vhLog(`[VectHare Deduplication] After deduplication: ${chunksToInject.length} to inject, ${skippedDuplicates.length} skipped`);
        if (skippedDuplicates.length > 0) {
            vhLog(`[VectHare Deduplication] Skipped chunks (already in chat):`);
            skippedDuplicates.forEach((chunk, idx) => {
                vhLog(`  [${idx + 1}] Hash: ${chunk.hash}, Score: ${chunk.score?.toFixed(4)}, Text: "${chunk.text?.substring(0, 80)}..."`);
            });
        }

        if (chunksToInject.length === 0) {
            vhLog('ℹ️ VectHare: All retrieved chunks already in context, nothing to inject');
            vhLog(`   ${skippedDuplicates.length} chunks were skipped (already in current chat)`);
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

        vhLog(`[VectHare Deduplication] ✅ ${chunksToInject.length} chunks will proceed to injection`);

        // === STAGE 10: Inject into prompt ===
        if (!retrievalStillForThisChat()) {
            console.warn('VectHare: Chat changed while memories were being retrieved - discarding this result');
            return;
        }
        const injection = injectChunksIntoPrompt(chunksToInject, settings, debugData);

        vhLog(`\n✅ VectHare: Successfully injected ${chunksToInject.length} chunk(s) into prompt`);
        vhLog(`   Verification: ${injection.verified ? '✓ PASSED' : '✗ FAILED'}`);
        vhLog(`   Total characters injected: ${injection.text.length}\n`);

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
        vhLog(`VectHare: ✅ Injected ${chunksToInject.length} chunks (${skippedDuplicates.length} skipped - already in context)`);

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
export async function vectorizeAll(settings, batchSize, includeIndexedCount = false) {
    settings = snapshotCollectionOperationSettings(settings);
    let capturedConfig = null;
    let progressShown = false;
    let runId = null;
    let runLease = null; // 8C: held for the whole run, renewed every batch
    try {
        // VectHare+: Manual Sync Chat / Continue always runs, regardless of the
        // per-collection auto-sync toggle - auto-sync gating applies ONLY to
        // event-driven background sync inside synchronizeChat (see the
        // bypassAutoSync flag). Round 2 wrongly warned users here, which made
        // the manual "Continue Vectorization" button demand auto-sync.

        // VectHare+ re-entrancy guard: a second run while one is active would
        // interleave batches, fight over the (singleton) progress panel, and
        // re-wire Pause/Stop callbacks under the first run. Exactly the kind
        // of weird behavior seen in testing.
        // R12: shared acquisition guard (identical behavior for sync and repair)
        if (!tryAcquireVectorizationRun()) {
            return;
        }

        const target = captureChatTarget();
        if (!target) {
            toastr.info('No chat selected', 'Vectorization aborted');
            vectorizeRunActive = false;
            return;
        }
        // VH-015: a backend that cannot store collections (e.g. Qdrant < 1.15) is
        // refused before anything is embedded.
        const writeRefusal = backendWriteRefusal(settings.vector_backend);
        if (writeRefusal) {
            toastr.error(writeRefusal, 'VectHare', { timeOut: 15000 });
            vectorizeRunActive = false;
            return { success: false, reason: writeRefusal };
        }

        // N2: a re-imported/restored chat can get its deleted copy's memories back.
        await offerDeletedChatReattach(settings);
        if (!isChatTargetCurrent(target)) throw new ChatSwitchStop();
        // The current chat must have a verified, independent collection.
        const binding = await ensureChatBinding();
        if (!isChatTargetCurrent(target)) throw new ChatSwitchStop();
        if (!binding.writable || !binding.collectionId) {
            toastr.warning(binding.unverifiedClaim
                ? 'This chat names a character or chat file that no longer exists, so its collection cannot be verified. ' +
                  'Press Sync Chat to start a new collection for it (the old one is kept). No vectors were written.'
                : 'Chat collection identity is not yet verified. No vectors were written.', 'VectHare', { timeOut: 15000 });
            vectorizeRunActive = false;
            return;
        }
        try {
            runLease = await acquireLease(binding.collectionId, { label: 'Sync Chat', isPaused: isVectorizationPaused });
        } catch (error) {
            if (error?.code !== 'VH_LEASE_HELD') throw error;
            toastr.info(error.message, 'VectHare');
            vectorizeRunActive = false;
            return;
        }

        // Resolve the original model/grouping for this collection before any
        // health check or embedding. No global settings are changed.
        let resolvedSync;
        try {
            resolvedSync = await resolveCollectionOperationSettings(binding.collectionId, settings,
                'sync-chat', chatConfigChunking(settings), { allowNew: true });
        } catch (error) {
            resolvedSync = await recoverEmptyFirstSyncPreflight(binding.collectionId, settings);
            if (!resolvedSync) throw error;
        }
        settings = resolvedSync.settings;
        capturedConfig = resolvedSync.config || createInitialVectorizationConfig(settings, chatConfigChunking(settings));

        // Pre-flight check: verify backend is available before starting
        const backendName = settings.vector_backend || 'standard';
        const backendAvailable = await isBackendAvailable(backendName, settings);
        if (!backendAvailable) {
            toastr.error(
                `Backend "${backendName}" is not available. Check your settings or start the backend service.`,
                'Vectorization aborted'
            );
            console.error(`VectHare: Backend ${backendName} failed health check before vectorization`);
            vectorizeRunActive = false;
            return;
        }

        // A backend health check may have completed after a chat switch.
        if (!isChatTargetCurrent(target, binding.collectionId)) throw new ChatSwitchStop();
        const totalMessages = target.messages.filter(x => !x.is_system).length;

        // VectHare+ FIX: empty chat previously ran a full "cycle" and produced a
        // nonsense success ("Vectorized 0 messages") plus a progress panel with
        // 0/0 - now short-circuits with an honest info toast.
        if (totalMessages === 0) {
            progressTracker.hide();
            toastr.info('This chat has no messages to vectorize.', 'VectHare');
            vhLog('VectHare: Vectorization skipped - chat has no vectorizable messages');
            vectorizeRunActive = false;
            resetControlState();
            return;
        }

        // VectHare+ FIX: per_scene messages are vectorized via scene markers
        // (createSceneChunk), not by chat sync. Previously this path ran a
        // pointless cycle and toasted fake success ("Vectorized 0 messages").
        if (settings.chunking_strategy === 'per_scene') {
            progressTracker.hide();
            toastr.info(
                'Per-scene strategy is active: scenes are vectorized from scene markers on messages, not via Sync Chat.',
                'VectHare',
                { timeOut: 10000 }
            );
            vhLog('VectHare: Vectorization skipped - per_scene strategy uses scene markers');
            vectorizeRunActive = false;
            resetControlState();
            return;
        }

        // Database provenance takes priority over the older settings fingerprint.
        // A new collection is allowed only when it is unregistered and empty.
        assertCollectionOperationSettingsStable(capturedConfig, settings, chatConfigChunking(settings));
        const syncCompatibility = { status: resolvedSync.status };
        if (!isChatTargetCurrent(target, binding.collectionId)) throw new ChatSwitchStop();

        // ====================================================================
        // VectHare+ R7: Vectorization configuration fingerprint
        // Continuing a run MUST use the same settings that produced the
        // existing vectors (embedding provider/model determines dimensions;
        // chunking strategy/batch size determine content). A mismatch would
        // mix incompatible vectors in one collection and poison retrieval.
        // The fingerprint is persisted on the collection's metadata and
        // compared at the start of every run.
        // ====================================================================
        if (syncCompatibility.status !== 'compatible') {
            const fpCollectionId = binding.collectionId;
            if (fpCollectionId) {
                try {
                    const { getCollectionMeta, setCollectionMeta } = await import('./collection-metadata.js');

                    // R9: shared computation (same function the auto-sync gate uses)
                    const configFingerprint = await computeVectorizationConfigFingerprint(settings);

                    const storedFingerprint = getCollectionMeta(fpCollectionId).vectorizationConfigFingerprint;

                    // R9: null fingerprint = computation failed -> fail-open (never block)
                    if (configFingerprint && storedFingerprint && storedFingerprint !== configFingerprint) {
                        // Only a problem if the collection actually has vectors
                        let existingVectorCount = 0;
                        try {
                            // #35: this gate runs inside a stoppable manual run.
                            existingVectorCount = (await getSavedHashes(fpCollectionId, settings,
                                false, getStopSignal())).length || 0;
                        } catch { /* backend read failed - treat as unknown, allow with persist */ }

                        if (existingVectorCount > 0) {
                            toastr.error(
                                'Vectorization settings changed since this collection was created (embedding model, provider, or chunking strategy). Continuing would mix incompatible vectors. Either restore the previous settings, or re-vectorize the collection from the Content Vectorizer (purges and rebuilds it with the new settings).',
                                'VectHare: Settings mismatch',
                                { timeOut: 0, closeOnHover: false }
                            );
                            console.error('VectHare: Run blocked - vectorization config fingerprint mismatch', { storedFingerprint, configFingerprint });
                            vectorizeRunActive = false;
                            resetControlState();
                            return;
                        }
                    }

                    // Persist the fingerprint so future runs can verify continuity
                    if (configFingerprint) {
                        setCollectionMeta(fpCollectionId, { vectorizationConfigFingerprint: configFingerprint });
                    }
                } catch (fpError) {
                    // Fingerprint failures must never block vectorization
                    console.warn('VectHare: Config fingerprint check failed (continuing without it):', fpError.message);
                }
            }
        }

        if (!isChatTargetCurrent(target, binding.collectionId)) throw new ChatSwitchStop();

        // #85: reconcile and repair existing indexed vectors BEFORE adding new
        // content, using the same Repair logic (no second implementation). Only
        // collections whose saved configuration records the identity ledger
        // qualify; anything unverified stops here instead of syncing beside it.
        if (resolvedSync.config?.identityLedger === 1) {
            const repaired = await repairChatVectors(settings, batchSize, true);
            if (repaired !== 'ok') {
                if (isVectorizationStopped()) lastRunStoppedByUser = true;
                vectorizeRunActive = false;
                resetControlState();
                return;
            }
            if (!isChatTargetCurrent(target, binding.collectionId)) throw new ChatSwitchStop();
        }

        // Count the grouped units actually used by synchronization.
        // Progress total only: a failed ledger read must not abort Sync here.
        const totalGroups = await collectCurrentChatGroups(target.messages, settings,
            binding.collectionId).then(items => items.length,
            () => collectGroupedItems(target.messages, settings).length);
        const progressUnit = !settings.chunking_strategy || settings.chunking_strategy === 'per_message'
            ? 'Messages' : 'Message groups';
        // #33: this run's id; a later operation taking over the panel makes our
        // own completion a no-op instead of overwriting what the user now sees.
        runId = progressTracker.show('Vectorizing Chat', totalGroups, progressUnit);
        // These are the settings the run resolved, which for an existing
        // collection are its own saved vectorization settings - not today's
        // global selection.
        progressTracker.setRunSettings(describeEffectiveSettings(settings),
            settings.__collectionCleaningPatterns
                ? 'from this collection\'s saved configuration'
                : 'as resolved for this run');
        progressTracker.stats.groupsCompletedThisRun = 0;
        progressTracker.stats.monotonic = true; // S2: the bar never moves backwards in a run
        progressShown = true;

        let finished = false;
        let iteration = 0;
        let processedCount = 0;
        let totalChunks = 0;
        let transientBlockCount = 0; // VectHare+: consecutive transient-block counter
        let consecutiveFailingIterations = 0; // VectHare+ R6: all-fail loop guard
        let writesNotReadBack = 0; // VH-094
        let previousRemaining = null;

        // VectHare+: wire Pause/Resume/Stop controls into the progress panel
        resetControlState();
        progressTracker.setControls({
            onPause: () => {
                pauseVectorization();
                progressTracker.markPaused(`Paused after ${processedCount} processed — all completed vectors are saved`);
                // R9: remember when we paused so ETA/elapsed stay honest on resume
                progressTracker._pausedAt = Date.now();
                vhLog('VectHare: Vectorization paused');
            },
            onResume: () => {
                // A stale Resume click must never restart a run for another chat.
                if (!isChatTargetCurrent(target, binding.collectionId)) {
                    stopVectorization();
                    return;
                }
                resumeVectorization();
                // R9 FIX (ETA inflation): shift the run clock forward by the pause
                // duration - otherwise paused minutes counted against the average
                // and the ETA showed garbage after every long break.
                if (progressTracker._pausedAt && progressTracker.stats?.startTime) {
                    const pausedMs = Date.now() - progressTracker._pausedAt;
                    progressTracker.stats.startTime += pausedMs;
                    if (progressTracker.stats.lastBatchStartTime) {
                        progressTracker.stats.lastBatchStartTime += pausedMs;
                    }
                    progressTracker._pausedAt = null;
                }
                progressTracker.isComplete = false;
                progressTracker.isPaused = false;
                progressTracker.terminalStatus = '';
                progressTracker.startTimeUpdater();
                if (progressTracker.elements?.pauseBtn) progressTracker.elements.pauseBtn.style.display = 'inline-block';
                if (progressTracker.elements?.resumeBtn) progressTracker.elements.resumeBtn.style.display = 'none';
                if (progressTracker.elements?.stopBtn) progressTracker.elements.stopBtn.style.display = 'inline-block';
                progressTracker.updateDisplay();
                vhLog('VectHare: Vectorization resumed — continuing from last completed item');
            },
            onStop: () => {
                stopVectorization();
                // R7 (user feedback): stopping must DRAIN the in-flight embedding
                // request before the run ends, so there is an unavoidable short
                // delay - but it was previously silent, looking like a dead button.
                // Immediate feedback: panel status + toast, then the normal
                // completion message arrives once the drain finishes.
                // R10: swap the ETA for "stopping…" and hold it there (tracker
                // computes ETA each tick; isStopping overrides it).
                progressTracker.isStopping = true;
                // R13: the in-flight request is now CANCELLED (AbortSignal), not
                // drained - stop is effectively instant.
                progressTracker.updateDisplay('⏹ Stopping - cancelling the in-flight request...');
                // R13 wording: request is aborted; for server-side sources the
                // server MAY still finish that single request in the background,
                // which is harmless - it writes a valid chunk the next sync's
                // hash diff reconciles. Nothing partial can ever be written.
                toastr.info('Stopping - the in-flight request is being cancelled. Everything completed is saved. The run ends immediately.', 'VectHare');
                vhLog('VectHare: Vectorization stop requested (in-flight request aborted)');
            },
        });

        // P1: the plan is made once and reused by later batches while nothing changes.
        const runCache = {};
        while (!finished) {
            if (!isChatTargetCurrent(target, binding.collectionId)) throw new ChatSwitchStop();
            if (isGenerating()) {
                // VectHare+: wait out the generation instead of aborting the run.
                // R6 FIX: honor Stop while waiting - previously a hung generation
                // made the Stop button unresponsive for exactly the window the
                // user would most want it.
                while (isGenerating() && !isVectorizationStopped() && !isVectorizationPaused()) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    if (!isChatTargetCurrent(target, binding.collectionId)) throw new ChatSwitchStop();
                }
                if (!isVectorizationStopped() && !isVectorizationPaused()) {
                    progressTracker.updateProgress(progressTracker.stats.processedItems, 'Resumed after message generation');
                }
            }

            // VectHare+: honor Pause — wait (without burning CPU) until resumed;
            // nothing is lost meanwhile, every completed item is already persisted
            while (isVectorizationPaused() && !isVectorizationStopped()) {
                await new Promise(resolve => setTimeout(resolve, 300));
                if (!isChatTargetCurrent(target, binding.collectionId)) throw new ChatSwitchStop();
            }

            // VectHare+: honor Stop — end cleanly, keep everything completed so far.
            // The next sync (manual, auto-sync, or resume-on-load) continues from here.
            if (isVectorizationStopped()) {
                lastRunStoppedByUser = true; // R9: suppress the follow-up resume nag
                progressTracker.complete('stopped', `Stopped after ${processedCount} processed — work kept, continue anytime via Vectorize Chat`, runId);
                toastr.info('Vectorization stopped. Every completed vector is saved and syncing will continue from this point.', 'VectHare');
                vectorizeRunActive = false;
                resetControlState();
                return;
            }

            if (!isChatTargetCurrent(target, binding.collectionId)) throw new ChatSwitchStop();
            if (runLease && !await runLease.touch()) {
                const lost = new Error('Another tab or device took over this chat; Sync stopped between batches. Completed vectors are saved.');
                lost.code = 'VH_LEASE_LOST';
                throw lost;
            }
            // VectHare+: bypassAutoSync=true - the run was explicitly started by
            // the user (Sync Chat / Continue button); synchronizeChat's autoSync
            // gate must not block a manual run.
            // VectHare+ (restored + improved): bypassAutoSync=true - the run was
            // explicitly started by the user (Sync Chat / Continue button), so
            // synchronizeChat's autoSync gate must not block a manual run.
            const result = await synchronizeChat(settings, batchSize, true, validatedManualSync, capturedConfig, runCache);
            if (!isChatTargetCurrent(target, binding.collectionId)) throw new ChatSwitchStop();
            // A brand-new collection gets its identity ledger in the first pass,
            // and its saved configuration records that (identityLedger: 1). The
            // configuration captured before that first write does not, so later
            // passes of this same run skipped the ledger and only the first
            // batch was tracked. Adopt the saved record once it exists.
            if (capturedConfig && capturedConfig.identityLedger !== 1 && (result?.chunksCreated || 0) > 0) {
                try {
                    const saved = await readInitialVectorizationConfig(binding.collectionId, settings);
                    if (saved.status === 'valid' && saved.config?.identityLedger === 1) {
                        assertCollectionOperationSettingsStable(saved.config, settings, chatConfigChunking(settings));
                        capturedConfig = saved.config;
                    }
                } catch (error) {
                    console.debug('VectHare: saved configuration not re-read:', error.message);
                }
                if (!isChatTargetCurrent(target, binding.collectionId)) throw new ChatSwitchStop();
            }

            // VectHare+ BUG FIX (infinite failure loop): items that permanently
            // fail to embed are never written to the DB, so they re-enter the
            // queue on EVERY iteration and are retried forever - "remaining"
            // never reaches 0 and the run never ends. Detect consecutive
            // iterations that produced attempts but ZERO successful chunks and
            // bail out after 10 of them (work completed elsewhere is kept).
            const iterationAttempts = result.messagesProcessed || 0;
            const iterationSuccesses = result.chunksCreated || 0;
            if (iterationAttempts > 0 && iterationSuccesses === 0) {
                consecutiveFailingIterations++;
                if (consecutiveFailingIterations >= 10) {
                    progressTracker.complete(false,
                        `Giving up after 10 consecutive failed batches (~${iterationAttempts} failures in the last one). Completed vectors are saved; failed items will attempt again on the next sync.`,
                        runId);
                    toastr.error(
                        'Vectorization stopped: embedding requests kept failing for the remaining items. Everything completed so far is saved and resumable.',
                        'VectHare', { timeOut: 15000 }
                    );
                    console.warn(`VectHare: Aborting run - 10 consecutive iterations with zero successful chunk inserts`);
                    vectorizeRunActive = false;
                    resetControlState();
                    return;
                }
            } else {
                consecutiveFailingIterations = 0;
            }

            // VH-094: writes that are never read back. If batches keep reporting
            // stored chunks but the number left does not go down, the backend
            // saves to one place and reads from another (or drops the writes):
            // stop with a clear error instead of writing the same chunks forever.
            if (result.remaining > 0 && iterationSuccesses > 0 &&
                previousRemaining !== null && result.remaining >= previousRemaining) {
                writesNotReadBack++;
                if (writesNotReadBack >= 3) {
                    progressTracker.complete(false,
                        'Stopped: chunks were written but could not be read back from the vector store.',
                        runId);
                    toastr.error(
                        `Vectorization stopped: VectHare stored chunks, but reading the collection back still shows ${result.remaining} of ${result.total} missing. ` +
                        'The vector store saves and reads in different places. Check that the Similharity plugin is the version that comes with this VectHare, then try again.',
                        'VectHare', { timeOut: 20000 }
                    );
                    console.warn(`VectHare: Aborting run - ${writesNotReadBack} batches wrote chunks without reducing what is left (${result.remaining})`);
                    vectorizeRunActive = false;
                    resetControlState();
                    return;
                }
            } else if (result.remaining >= 0) {
                writesNotReadBack = 0;
            }
            if (result.remaining >= 0) previousRemaining = result.remaining;

            // Handle disabled/blocked state.
            // VectHare+ FIX: -1 is usually TRANSIENT (send in progress, sync
            // mutex busy, momentary state). The old code aborted the entire run
            // with a scary "Blocked or disabled" failure if ANY message event
            // landed mid-run. Now: wait a beat and retry, with a consecutive-
            // failure bail-out (30 attempts ≈ 30s) for genuinely permanent
            // blocks (e.g. chat switched away and back, collection vanished).
            if (result.remaining === -1) {
                transientBlockCount++;
                if (transientBlockCount >= 30) {
                    progressTracker.complete(false, 'Blocked for 30s - giving up (collection/chat state unchanged?). Work completed so far is saved.', runId);
                    toastr.warning('Vectorization was blocked for 30 seconds and has been stopped. Everything completed so far is saved and resumable.', 'VectHare');
                    vectorizeRunActive = false;
                    resetControlState();
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }
            transientBlockCount = 0;

            // The denominator follows the current grouping snapshot.
            progressTracker.stats.totalItems = result.total;
            progressTracker.updateEmbeddingProgress(result.total - result.remaining, result.total);

            finished = result.remaining <= 0;
            iteration++;

            processedCount += result.messagesProcessed;
            totalChunks += result.chunksCreated;
            progressTracker.stats.groupsCompletedThisRun += result.groupsCompleted;

            progressTracker.updateProgress(
                result.total - result.remaining,
                result.remaining > 0
                    ? phaseText('Embedding', result.total - result.remaining, result.total)
                    : 'Finalizing...'
            );
            progressTracker.updateChunks(totalChunks);

            vhLog(`VectHare: Vectorization iteration ${iteration}, ${result.remaining > 0 ? result.remaining + ' remaining' : 'complete'} (${result.chunksCreated} chunks this batch)`);

        }

        // A manual Sync finishes in one press: if this run's writes superseded
        // indexed chunks (see needsReconciliation in synchronizeChat), run one
        // more pass so their old vectors are removed now, not at a later Sync.
        if (totalChunks > 0 && !isVectorizationStopped() &&
            getCollectionMeta(binding.collectionId)?.needsReconciliation === true &&
            isChatTargetCurrent(target, binding.collectionId)) {
            try {
                progressTracker.updateProgress(progressTracker.stats.processedItems, 'Removing superseded chunks…');
                await synchronizeChat(settings, batchSize, true, validatedManualSync, capturedConfig, {});
            } catch (error) {
                if (error instanceof ChatSwitchStop) throw error;
                console.warn('VectHare: Cleanup pass deferred to the next Sync:', error.message);
            }
        }

        vectorizeRunActive = false;
        resetControlState();
        progressTracker.complete(true, `Completed ${progressTracker.stats.groupsCompletedThisRun} ${progressUnit.toLowerCase()} this run (${totalChunks} chunks written)`, runId);
        // Phase 1: make this run's registry/binding/annotation changes durable.
        await flushVectHareStore().catch(error =>
            console.error('VectHare: Collection metadata could not be saved:', error));
        // VH-078: say so when some messages could not be stored (they are on retry back-off).
        const waiting = pendingSyncFailures(binding.collectionId);
        if (waiting.count > 0) {
            const minutes = Math.max(1, Math.ceil(((waiting.retryAt || Date.now()) - Date.now()) / 60000));
            toastr.warning(`Chat vectorized, but ${waiting.count} chunk(s) could not be stored. ` +
                `They are retried automatically in about ${minutes} min, or press Sync Chat again.` +
                (waiting.reason ? ` Last error: ${waiting.reason}` : ''), 'VectHare', { timeOut: 15000 });
        } else {
            toastr.success('Chat vectorized successfully', 'VectHare');
        }
        vhLog(`VectHare: ✅ Vectorization complete after ${iteration} iterations`);
        // F8: scenes are never retired by Sync; mark the ones whose messages changed.
        try {
            const { refreshSceneStaleness } = await import('./scenes.js');
            if (isChatTargetCurrent(target, binding.collectionId)) {
                const scenes = await refreshSceneStaleness(settings, binding.collectionId, target.messages);
                if (scenes.outdated) {
                    toastr.warning(`${scenes.outdated} scene(s) are outdated because their messages changed. ` +
                        'They are not used until re-created (chunk browser \u2192 Scenes).', 'VectHare', { timeOut: 10000 });
                }
            }
        } catch (error) {
            console.debug('VectHare: Scene staleness check skipped:', error.message);
        }
        // Content Vectorizer needs the TOTAL stored count, not just the number
        // newly written during this Sync. A read failure must not make a
        // successful vectorization look like a failed one.
        let indexedChunkCount = null;
        if (includeIndexedCount) {
            try {
                const hashes = await getSavedHashes(binding.collectionId, settings,
                    false, getStopSignal()); // #35: cancellable like the rest of the run
                if (Array.isArray(hashes)) indexedChunkCount = hashes.length;
            } catch (error) {
                console.warn('VectHare: Could not confirm the indexed collection count:', error);
            }
        }
        return { success: true, chunkCount: totalChunks, indexedChunkCount };
    } catch (error) {
        const wasStopped = isVectorizationStopped(); // a Stop cancels reads too
        vectorizeRunActive = false;
        resetControlState(); // Never let pause/stop flags leak into the next run.
        if (wasStopped && !(error instanceof ChatSwitchStop)) {
            lastRunStoppedByUser = true;
            if (progressShown) progressTracker.complete('stopped', 'Stopped - completed work is saved', runId);
            toastr.info('Vectorization stopped. Everything completed is saved.', 'VectHare');
            return;
        }
        if (error?.code === 'VH_LEASE_LOST') {
            if (progressShown) progressTracker.complete('stopped', 'Stopped - another tab took over this chat', runId);
            toastr.info(error.message, 'VectHare');
            return;
        }
        if (error instanceof ChatSwitchStop) {
            if (progressShown) progressTracker.complete('stopped', 'Stopped because you switched chats — completed vectors saved', runId);
            toastr.info('Vectorization stopped because you switched chats. Completed vectors are saved; return to the original chat to continue.', 'VectHare');
            console.info('VectHare: Vectorization stopped after chat switch; completed vectors preserved');
            return;
        }
        console.error('VectHare: Failed to vectorize all', error);
        progressTracker.addError(error.message);
        progressTracker.complete(false, 'Vectorization failed', runId);
        if (error?.code === 'VH_STALE_CHAT_VIEW') {
            toastr.warning(error.message, 'VectHare', { timeOut: 15000 }); // VH-081
        } else if (/original configuration missing/.test(error.message)) {
            // VH-061: older collection: the way on is the rebuild, not an error.
            const { LEGACY_PROMPT } = await import('./legacy-collections.js');
            toastr.warning(`This chat's memories need to be re-vectorized. ${LEGACY_PROMPT} (Vectorize asks before rebuilding.)`, 'VectHare', { timeOut: 15000 });
        } else {
            toastr.error(`Vectorization failed: ${error.message}`, 'VectHare');
        }
    } finally {
        await runLease?.release();
    }
}

/**
 * VectHare+ R12: REPAIR - fixes the already-vectorized part of the collection
 * WITHOUT continuing the backlog:
 *   1. Deletes stale vectors (source message edited or deleted).
 *   2. Heals duplicate vectors (same hash stored twice).
 *   3. Re-vectorizes ONLY "replacements": current groups whose content was
 *      previously vectorized under a now-stale hash (detected by overlapping
 *      message IDs with a ghost vector). An edited message's new text thus
 *      REPLACES its old vector.
 *   4. NEVER touches groups that were never vectorized (the backlog) - that
 *      is Sync Chat's job. Repair = make what EXISTS correct.
 *
 * Safety: aborts before touching anything if chunk metadata is unavailable
 * (protected scene/summary chunks could not be identified) or the collection
 * doesn't exist. Deletion happens AFTER successful re-insertion of each
 * replacement, so a failed embed leaves the stale vector in place rather
 * than leaving a hole. No partial state is ever created.
 *
 * @param {object} settings VectHare settings
 * @param {number} batchSize Embed batch size (unused for deletes)
 */
export async function repairChatVectors(settings, batchSize = 5, embeddedMode = false) {
    const ctx = { runId: null };
    const result = await repairChatVectorsImpl(settings, batchSize, embeddedMode, ctx);
    // S3: the panel now opens when Repair starts, so every way out of Repair
    // (including the early "blocked" returns) must leave it finished, never
    // running. Embedded runs hand the panel to Sync Chat right after this.
    if (embeddedMode !== 'auto' && ctx.runId != null && progressTracker.isCurrentRun(ctx.runId) &&
        !progressTracker.isComplete) {
        progressTracker.complete(result === 'ok',
            result === 'ok' ? 'Repair check finished' : 'Repair ended before making any change - see the message shown',
            ctx.runId);
    }
    return result;
}

async function repairChatVectorsImpl(settings, batchSize, embeddedMode, ctx) {
    // `embeddedMode`: Sync Chat runs this as its first step and already owns the
    // run (lock, panel controls). Returns 'ok' only when Sync may add new content.
    // 'auto' additionally means background auto-sync: no progress panel, no
    // toasts and no control rebinding for a run the user did not start (#86).
    const embedded = Boolean(embeddedMode);
    const silent = embeddedMode === 'auto';
    const panel = () => silent ? null : progressTracker;
    const notify = (kind, ...args) => { if (!silent) toastr[kind](...args); };
    const releaseRun = () => { if (!embedded) { vectorizeRunActive = false; resetControlState(); } };
    settings = snapshotCollectionOperationSettings(settings);
    let capturedConfig = null;
    let writeLockedCollection = null;
    let repairLease = null;
    // Called at batch boundaries: stop cleanly if another tab took the chat.
    const leaseStillHeld = async () => {
        if (repairLease && !await repairLease.touch()) {
            const error = new Error('Another tab or device took over this chat; Repair stopped between steps.');
            error.code = 'VH_LEASE_LOST';
            throw error;
        }
    };
    let progressShown = false;
    let runId = null;
    try {
        if (!embedded && !tryAcquireVectorizationRun()) return;

        const target = captureChatTarget();
        if (!target) {
            notify('info', 'No chat selected', 'Repair aborted');
            releaseRun();
            return;
        }

        const binding = await ensureChatBinding();
        if (!isChatTargetCurrent(target)) throw new ChatSwitchStop();
        const collectionId = binding.writable ? binding.collectionId : null;
        if (!collectionId) {
            notify('error', 'Could not determine this chat\'s collection', 'Repair aborted');
            releaseRun();
            return;
        }
        if (!isChatTargetCurrent(target, collectionId)) throw new ChatSwitchStop();
        beginChatCollectionWrite(collectionId);
        writeLockedCollection = collectionId;
        // 8C: one tab at a time per chat (re-entrant when Sync runs Repair).
        repairLease = await acquireLease(collectionId, { label: 'Repair', isPaused: isVectorizationPaused });

        // S3: open the panel now, so reading and comparing are visible too.
        // Weights: read 10%, compare 5%, embed 60%, delete 15%, verify 10%
        // (phases with no work give their share to the others, see below).
        if (!silent) {
            runId = panel().show('Repairing Chunks', 0, 'Items');
            ctx.runId = runId;
            progressShown = true;
            panel().setWeightedPercent(0);
            panel().setPhase('Verifying collection settings…');
        }

        // Repair only makes sense for an existing, registered collection.
        // Stage 2B checks the saved physical destination before any DB action.
        // Require a qualified registry entry for destructive Repair; a bare
        // legacy ID does not prove which backend/provider owns the collection.
        const registryEntries = getCollectionRegistry()
            .map(key => parseRegistryKey(key))
            .filter(entry => entry.collectionId === collectionId);
        // Registry tracking can be absent even though the backend still has
        // verified Sync Chat vectors (e.g. after a UI reload). Check saved
        // provenance before deciding that the collection is missing.

        // Repair must never act on unknown or incompatible provenance.
        try {
            const resolved = await resolveCollectionOperationSettings(collectionId, settings,
                'repair', chatConfigChunking(settings), { signal: getStopSignal() });
            settings = resolved.settings;
            capturedConfig = resolved.config;
            const backendName = name => name === 'vectra' ? 'standard' : name;
            if (!registryEntries.some(entry =>
                entry.backend && backendName(entry.backend) === backendName(settings.vector_backend || 'standard') &&
                entry.source === settings.source)) {
                // A bare registry key from an earlier Sync Chat build is not
                // proof of destination; backend configuration + inventory are.
                if (capturedConfig?.chunking?.pipeline !== 'sync-chat') {
                    throw new Error('No qualified registry entry matches the saved collection backend/source');
                }
                const verifiedInventory = await getSavedHashes(collectionId, settings, true, getStopSignal(), true);
                if (!Array.isArray(verifiedInventory?.hashes) ||
                    !Array.isArray(verifiedInventory?.metadata) ||
                    verifiedInventory.hashes.length !== verifiedInventory.metadata.length ||
                    !verifiedInventory.metadata.some(meta =>
                        meta?.vecthareProvenance?.collectionId === collectionId &&
                        meta.vecthareProvenance.recordKind === 'sync-chat' &&
                        meta.vecthareProvenance.sourceType === 'chat')) {
                    throw new Error('Cannot verify old registry destination; Repair blocked');
                }
                registerCollection(`${settings.vector_backend || 'standard'}:${settings.source}:${collectionId}`);
            }
            assertCollectionOperationSettingsStable(capturedConfig, settings, chatConfigChunking(settings));
        } catch (error) {
            if (isVectorizationStopped()) {
                notify('info', 'Repair stopped. Nothing was changed.', 'VectHare');
                releaseRun();
                return;
            }
            // VH-052: on another backend/server, say where instead of the raw error.
            const { collectionLivesElsewhere, describeStore, backendLabel } = await import('./backend-elsewhere.js');
            const elsewhere = collectionLivesElsewhere(collectionId, settings);
            if (elsewhere.length) {
                notify('warning', `This chat's memories are on ${[...new Set(elsewhere.map(describeStore))].join(' and ')}. ` +
                    `Switch back to repair them, or re-vectorize this chat on ${backendLabel(settings.vector_backend)}. Nothing was changed.`,
                'Repair', { timeOut: 15000 });
                releaseRun();
                return;
            }
            notify('error', error.message, 'Repair blocked: settings mismatch', { timeOut: 0, closeOnHover: false });
            releaseRun();
            return;
        }
        // These shared-store delete APIs currently delete by hash without a
        // logical collection filter. Do not risk touching another chat's
        // matching hash (issues #30/#70); this is not a settings mismatch.
        // 9b: the collection's own layout (its locator, or today's setting).
        // 9c (P7): lifted for the new layouts (Qdrant/Milvus v2, Milvus per-
        // collection) when the plugin scopes them; legacy layouts stay gated.
        const repairStorage = resolveStorage(collectionId, settings);
        if ((settings.vector_backend === 'milvus' && !(repairStorage.v2 && await scopedTenancySupported())) ||
            (settings.vector_backend === 'qdrant' && repairStorage.layout === 'legacy-mt')) {
            // Sync Chat keeps its previous behaviour on these backends; the
            // pre-Sync repair step is simply unavailable there.
            if (embedded) return 'ok';
            notify('error', 'Repair is disabled for shared storage (Milvus, or Qdrant multitenancy) until deletion is scoped to the logical collection. ' +
                'Your vectors are untouched and Sync Chat still works. For repairable chats use per-collection storage (Standard, LanceDB, or Qdrant with multitenancy off); shared-storage repair comes with the multitenancy update.',
                'Repair blocked: unsafe shared storage', { timeOut: 0, closeOnHover: false });
            releaseRun();
            return;
        }
        if (!isChatTargetCurrent(target, collectionId)) throw new ChatSwitchStop();

        // Stage 13.0: existing collections opt in only if their original
        // backend-resident configuration recorded the identity ledger capability.
        let identityLedger = null, identityReconciliation = null, identityGroups = [];
        panel()?.setPhase('Reading collection…');
        if (capturedConfig?.identityLedger === 1) {
            try {
                try {
                    identityLedger = await readChatIdentityLedger(collectionId, settings, capturedConfig);
                } catch (readError) {
                    if (readError.ledgerStatus !== 'missing') throw readError;
                    identityLedger = await rebuildMissingIdentityLedger(collectionId, settings,
                        capturedConfig, target.messages);
                }
                if (identityLedger.state !== 'clean') {
                    if (identityLedger.state !== 'dirty' ||
                        !await recoverIdentityLedger(identityLedger, collectionId, settings)) {
                        throw new Error('Identity ledger state is not verified; Repair blocked');
                    }
                }
                assertChatViewCurrent(identityLedger, target.messages); // VH-081
            } catch (error) {
                if (error instanceof StaleChatViewError) {
                    noteStaleChatView(error); // shown also for the automatic pass before a Sync
                    releaseRun();
                    return;
                }
                notify('error', error.message, 'Repair blocked: identity ledger', { timeOut: 0, closeOnHover: false });
                releaseRun();
                return;
            }
        }

        // Full metadata read - REQUIRED. Without per-chunk metadata we cannot
        // identify protected scene/summary chunks, so repair must not run.
        let collectionData;
        try {
            // R17: abortable+timed read (was an unbounded await - a hung backend
            // read previously stalled repair before it even started, with Stop
            // unable to free it)
            collectionData = await getSavedHashes(collectionId, settings, true, getStopSignal(), true);
        } catch (readError) {
            notify('error', 'Could not read collection metadata - repair aborted, nothing was changed.', 'Repair');
            console.warn('VectHare: Repair aborted - metadata read failed:', readError.message);
            releaseRun();
            return;
        }

        if (!isChatTargetCurrent(target, collectionId)) throw new ChatSwitchStop();
        panel()?.setWeightedPercent(10);
        const storedHashes = collectionData?.hashes;
        const metadataArr = collectionData?.metadata;
        if (!Array.isArray(storedHashes) || !Array.isArray(metadataArr) ||
            storedHashes.length !== metadataArr.length) {
            notify('error', 'Collection inventory was incomplete - repair aborted without changes.', 'Repair');
            releaseRun();
            return;
        }

        if (storedHashes.length === 0) {
            if (identityLedger) {
                // Confirm empty with the ledger's strict inventory reader
                // before invalidating any formerly indexed group claims.
                const inventory = await readIdentityInventory(collectionId, settings);
                if (inventory.size !== 0) throw new Error('Collection changed during empty Repair inventory');
                if (!isChatTargetCurrent(target, collectionId)) throw new ChatSwitchStop();
                identityReconciliation = await reconcileIdentityMessages(target.messages, identityLedger);
                const items = await collectStableIdentityGroups(target.messages, settings,
                    identityLedger, identityReconciliation);
                identityGroups = await attachIdentityGroups(target.messages, items, identityReconciliation);
                // Preserve valid group boundaries as unfinished work for Sync;
                // no absent vector can remain marked as indexed.
                // Collection verified empty: a pending insert/delete is moot. Clear it,
                // or a stale pending record would make this reconciliation throw.
                const emptyLedger = { ...identityLedger, pending: null,
                    groups: identityGroups.map(group => ({ ...group, indexed: false })) };
                if (!await finishIdentityLedger(emptyLedger, identityReconciliation,
                    identityGroups, inventory)) {
                    throw new Error('Empty-collection ledger reconciliation could not be verified');
                }
            }
            if (!embedded) notify('info', 'The collection is empty - nothing to repair. Use "Sync Chat" to vectorize this chat.', 'Repair');
            releaseRun();
            return 'ok';
        }
        if (metadataArr.length === 0) {
            notify('error', 'Chunk metadata unavailable from the backend - repair cannot safely identify protected chunks. Nothing was changed.', 'Repair');
            console.warn('VectHare: Repair aborted - backend returned no chunk metadata');
            releaseRun();
            return;
        }

        const metaByHash = new Map();
        const copiesByHash = new Map();
        const storedHashSet = new Set(storedHashes.map(h => String(h)));

        const { getChunkMetadata, saveChunkMetadata } = await import('./collection-metadata.js');
        // A record can only be classified as a stale Sync Chat vector when its
        // persisted writer provenance says so. Content Vectorizer can store
        // uploaded transcripts in the same logical chat collection; its chunks
        // are NOT ghosts just because they differ from the current chat.
        const isProtectedMeta = isProtectedChatRecordMeta;
        const protectedHashes = new Set();
        for (let i = 0; i < storedHashes.length; i++) {
            const hash = String(storedHashes[i]);
            const meta = metadataArr[i];
            if (!metaByHash.has(hash)) metaByHash.set(hash, meta);
            if (identityLedger) {
                const copies = copiesByHash.get(hash) || [];
                copies.push(meta);
                copiesByHash.set(hash, copies);
            }
            // If any copy with this hash is protected, deleting by hash could
            // delete that copy too. Do not classify such a hash as deletable.
            if (isProtectedMeta(meta) || (identityLedger && (
                meta?.vecthareProvenance?.recordKind !== 'sync-chat' ||
                meta?.vecthareProvenance?.sourceIdentity?.status !== 'ledger-linked'))) {
                protectedHashes.add(hash);
            }
        }
        const isProtected = (hash, meta) => {
            if (protectedHashes.has(String(hash)) || isProtectedMeta(meta)) return true;
            if (identityLedger && (meta?.vecthareProvenance?.recordKind !== 'sync-chat' ||
                meta?.vecthareProvenance?.sourceIdentity?.status !== 'ledger-linked')) return true;
            const chunkMeta = getChunkMetadata(hash, collectionId);
            // VH-082: disabledByScene (a local note on a chunk a scene covers) no
            // longer protects a chunk whose message was edited or deleted.
            if (chunkMeta && (
                chunkMeta.isScene === true || chunkMeta.isSummaryChunk === true ||
                chunkMeta.isSummary === true || chunkMeta.isSummaryVector === true ||
                chunkMeta.parentHash != null)) return true;
            return false;
        };

        // Current chat, grouped EXACTLY like sync (shared helper)
        if (!isChatTargetCurrent(target, collectionId)) throw new ChatSwitchStop();
        panel()?.setPhase('Comparing with chat…');
        let groupedItems = collectGroupedItems(target.messages, settings);
        if (identityLedger) {
            identityReconciliation = await reconcileIdentityMessages(target.messages, identityLedger);
            groupedItems = await collectStableIdentityGroups(target.messages, settings,
                identityLedger, identityReconciliation);
            identityGroups = await attachIdentityGroups(target.messages, groupedItems, identityReconciliation);
            // A numeric content hash collision must not be silently treated as
            // an unchanged vector merely because its key is still present.
            for (const group of identityGroups) {
                if (identityLedger.groups.some(old => String(old.hash) === String(group.hash) &&
                    old.hashInputFingerprint !== group.hashInputFingerprint)) {
                    throw new Error(`Content hash ${group.hash} maps to different inputs; Repair blocked`);
                }
            }
        }
        const groupByHash = new Map(groupedItems.map(it => [String(it.hash), it]));
        const currentHashSet = new Set(groupByHash.keys());

        // ---- Analyze: duplicates, ghosts, replacements ----
        const hashesToDelete = [];   // stale/duplicate vectors to remove
        const replacements = [];     // current groups to (re-)insert

        const ghosts = [];
        let replacementSources = new Map(); // #66: replacement hash -> superseded stale hash
        // VH-032: a group that is empty after cleaning cannot be embedded (as in
        // Sync, #49). It is never a replacement; the old vector it supersedes is
        // an ordinary stale vector, so the edit is not blocked forever.
        const emptyAfterCleaning = item => !String(item?.text ?? '').trim();
        const emptyCurrentHashes = new Set(groupedItems.filter(emptyAfterCleaning).map(item => String(item.hash)));
        if (identityLedger) {
            const repairInventory = await readIdentityInventory(collectionId, settings);
            const indexed = identityLedger.groups.filter(group => group.indexed &&
                verifiedGroupHash(identityLedger, group, repairInventory));
            const formerlyIndexedUids = new Set(indexed.flatMap(group => group.memberUids));
            // Only groups consisting entirely of formerly indexed messages
            // can be replacements. New backlog is still Sync Chat's job.
            const seenReplacementHashes = new Set();
            identityGroups.forEach((group, i) => {
                const hash = String(group.hash);
                if (storedHashSet.has(hash) || seenReplacementHashes.has(hash) ||
                    !group.memberUids.every(uid => formerlyIndexedUids.has(uid)) ||
                    group.memberUids.some(uid => identityReconciliation.uncertainUids.has(uid))) return;
                if (emptyAfterCleaning(groupedItems[i])) return;
                replacements.push(groupedItems[i]);
                seenReplacementHashes.add(hash); // preserve hash-based dedup
            });
            const replacementHashSet = new Set(replacements.map(item => String(item.hash)));
            const processedHashes = new Set();
            for (const old of indexed) {
                const hash = String(old.hash);
                if (processedHashes.has(hash) || currentHashSet.has(hash) ||
                    !storedHashSet.has(hash) || isProtected(hash, metaByHash.get(hash)) ||
                    !indexedChatProvenance(metaByHash.get(hash), identityLedger, old)) continue;
                // Deletion by hash affects EVERY source occurrence using that
                // hash. One unresolved occurrence or pending replacement vetoes
                // deletion of the entire key (not just the first ledger group).
                const everyOccurrence = indexed.filter(group => String(group.hash) === hash);
                if (!allPhysicalCopiesMatchGroups(identityLedger, hash,
                    copiesByHash.get(hash), everyOccurrence) ||
                    !allPhysicalCopiesMatchGroups(identityLedger, hash,
                        repairInventory.get(hash), everyOccurrence)) continue;
                if (everyOccurrence.some(group => group.memberUids.some(uid =>
                    !identityReconciliation.activeUids.has(uid) &&
                    !identityReconciliation.confidentDeleted.has(uid)))) continue;
                // A regrouped batch with new backlog must retain its old recall
                // until Sync writes the new group. Check every occurrence.
                if (everyOccurrence.some(prior => identityGroups.some(group =>
                    group.memberUids.some(uid => prior.memberUids.includes(uid)) &&
                    !storedHashSet.has(String(group.hash)) &&
                    !replacementHashSet.has(String(group.hash)) &&
                    !emptyCurrentHashes.has(String(group.hash))))) continue;
                ghosts.push({ hash, meta: metaByHash.get(hash) });
                hashesToDelete.push(hash);
                processedHashes.add(hash);
            }
            replacementSources = uniqueReplacementSources(replacements.flatMap(item =>
                ghosts.filter(ghost => indexed.some(old => String(old.hash) === ghost.hash &&
                    old.memberUids.some(uid => item.metadata?.messageUids?.includes(uid))))
                    .map(ghost => [item.hash, ghost.hash])));
            // Physical duplicate cleanup (#61) is deliberately outside scope.
        } else {
        // 1) Duplicate healing (non-protected only - a duplicated scene chunk
        //    must NOT be deleted: forward sync could never recreate it)
        const dupCounts = new Map();
        for (const h of storedHashes) {
            const k = String(h);
            dupCounts.set(k, (dupCounts.get(k) || 0) + 1);
        }
        // R14 FIX: extractMessageIds handles per_message's singular `messageId`
        // AND grouped strategies' `messageIds` - previously per_message groups
        // contributed nothing here, so replacements could never match.
        const groupsByMessageId = new Map(); // messageId -> [group]
        for (const it of groupedItems) {
            for (const mid of extractMessageIds(it.metadata)) {
                if (!groupsByMessageId.has(mid)) groupsByMessageId.set(mid, []);
                groupsByMessageId.get(mid).push(it);
            }
        }

        for (const [hash, count] of dupCounts) {
            if (count <= 1) continue;
            if (isProtected(hash, metaByHash.get(hash) || null)) continue;
            hashesToDelete.push(hash);
            // Re-insert ONE clean copy if this hash is still current content
            // (dedup artifact, not a ghost). If not current, the ghost loop
            // below already covers it.
            const group = groupByHash.get(hash);
            if (group && !emptyCurrentHashes.has(hash)) {
                replacements.push(group);
            }
        }

        // 2) Ghosts: stored hashes that no longer match any current content
        for (const [hash, meta] of metaByHash) {
            if (currentHashSet.has(hash)) continue;          // still current
            if (isProtected(hash, meta)) continue;           // never delete protected
            if (hasUnchangedMemberMessages(meta, target.messages)) continue; // incompatible history, not an edit
            ghosts.push({ hash, meta });
            if (!hashesToDelete.includes(hash)) hashesToDelete.push(hash);
        }

        // 3) Replacements: missing current groups whose message IDs overlap a
        //    ghost's message IDs => that content WAS vectorized before; its
        //    new text must replace the stale vector. Groups never vectorized
        //    (no overlapping ghost) stay untouched = the backlog.
        const replacementSeen = new Set();
        const replacementLinks = [];
        for (const ghost of ghosts) {
            // R14 FIX: per_message ghosts store `messageId` (singular), not
            // `messageIds` - the old check skipped EVERY per_message ghost,
            // which is why edited messages were deleted but never re-vectorized.
            const ghostMessageIds = extractMessageIds(ghost.meta);
            if (ghostMessageIds.length === 0) continue;
            for (const mid of ghostMessageIds) {
                for (const group of (groupsByMessageId.get(mid) || [])) {
                    const gHash = String(group.hash);
                    if (storedHashSet.has(gHash)) continue;         // already vectorized
                    if (emptyCurrentHashes.has(gHash)) continue;    // VH-032: nothing to embed
                    replacementLinks.push([gHash, ghost.hash]);
                    if (replacementSeen.has(gHash)) continue;       // already queued
                    replacements.push(group);
                    replacementSeen.add(gHash);
                }
            }
        }
        replacementSources = uniqueReplacementSources(replacementLinks);

        }

        panel()?.setWeightedPercent(15);
        // R14/R18: diagnostic logging. R18 expands this to hash-level detail so
        // the "repair looks clean in-session but dirty again after reload"
        // oscillation (user report) can be attributed in ONE test: compare the
        // collectionId line and the per-hash lines across a page reload.
        // - Same collectionId, same msgIds, DIFFERENT hashes after reload =>
        //   session-dependent hash drift (macros/regex/fileLength in the text)
        // - DIFFERENT collectionId after reload => collection-ID split (watch
        //   for the "falling back to chatId" warning)
        vhLog(`VectHare: Repair target - collection "${collectionId}" (backend: ${settings.vector_backend || 'standard'}, storage: ${resolveStorage(collectionId, settings).physical})`);
        vhLog(`VectHare: Repair analysis - stale/duplicate vectors to delete: ${hashesToDelete.length}, replacements to re-vectorize: ${replacements.length}`);
        for (const { hash, meta } of ghosts) {
            vhLog(`  [stale] hash ${hash} (msgIds: ${extractMessageIds(meta).join(',') || '?'})`);
        }
        for (const item of replacements) {
            vhLog(`  [replace] hash ${item.hash} (msgIds: ${extractMessageIds(item.metadata).join(',') || '?'}) text: "${String(item.text).substring(0, 60)}..."`);
        }

        if (hashesToDelete.length === 0 && replacements.length === 0) {
            if (!isChatTargetCurrent(target, collectionId)) throw new ChatSwitchStop();
            if (identityLedger) {
                panel()?.setPhase('Verifying…');
                panel()?.setWeightedPercent(90);
                if (!await finishIdentityLedger(identityLedger, identityReconciliation, identityGroups,
                    await readIdentityInventory(collectionId, settings))) {
                    throw new Error('Identity ledger could not verify the current indexed groups');
                }
            }
            // R16 FIX: complete() (not bare hide()) - the old bare hide left
            // the panel's Pause/Stop controls bound to a dead run; a later
            // panel reveal resurrected clickable controls for a run that no
            // longer existed. complete() hides controls and shows an honest
            // green-tick line.
            const uncertainCount = identityReconciliation?.uncertainUids?.size || 0;
            const noWorkMessage = uncertainCount
                ? `No verified repair actions; ${uncertainCount} source identity association(s) unresolved and preserved. ${UNRESOLVED_ACTION_HINT(uncertainCount)}`
                : 'Nothing to repair — no repair work detected for the current chat';
            if (!embedded) panel()?.complete(!uncertainCount, noWorkMessage, runId);
            if (uncertainCount) notify('warning', noWorkMessage, 'Repair');
            else if (!embedded) notify('success', noWorkMessage, 'Repair');
            releaseRun();
            return 'ok';
        }

        // Phase 4: current groups Repair deliberately does not touch because
        // they contain messages that were never indexed - Sync Chat's work.
        const replacementHashes = new Set(replacements.map(item => String(item.hash)));
        const groupsLeftToSync = identityLedger
            ? identityGroups.filter(group => !storedHashSet.has(String(group.hash)) &&
                !replacementHashes.has(String(group.hash))).length
            : 0;

        // Persist intent before the first embedding or deletion. A crash must
        // not leave a clean ledger falsely asserting the prior indexed state.
        if (identityLedger) {
            panel()?.setPhase('Saving…');
            await stageIdentityLedger(identityLedger,
                replacements.map(item => String(item.hash)), hashesToDelete,
                identityReconciliation, identityGroups);
        }
        // ---- Execute with progress panel + Pause/Stop ----
        const totalUnits = hashesToDelete.length + replacements.length;
        panel()?.retarget(totalUnits, 'Items');
        // S3: the 85% after reading/comparing is shared by the phases that have
        // work, in the weights 60 (embed) : 15 (delete) : 10 (verify).
        const execWeight = (replacements.length ? 60 : 0) + (hashesToDelete.length ? 15 : 0) + 10;
        const execScale = 85 / execWeight;
        const embedStart = 15;
        const embedSpan = replacements.length ? 60 * execScale : 0;
        const deleteStart = embedStart + embedSpan;
        const deleteSpan = hashesToDelete.length ? 15 * execScale : 0;
        const verifyStart = deleteStart + deleteSpan;
        resetControlState();
        panel()?.setControls({
            onPause: () => { pauseVectorization(); progressTracker.markPaused('Repair paused - completed fixes are saved'); },
            onResume: () => {
                if (!isChatTargetCurrent(target, collectionId)) {
                    stopVectorization();
                    return;
                }
                resumeVectorization();
                progressTracker.isComplete = false;
                progressTracker.isPaused = false;
                progressTracker.terminalStatus = '';
                progressTracker.startTimeUpdater();
                if (progressTracker.elements?.pauseBtn) progressTracker.elements.pauseBtn.style.display = 'inline-block';
                if (progressTracker.elements?.resumeBtn) progressTracker.elements.resumeBtn.style.display = 'none';
                if (progressTracker.elements?.stopBtn) progressTracker.elements.stopBtn.style.display = 'inline-block';
                progressTracker.updateDisplay();
            },
            onStop: () => {
                stopVectorization();
                progressTracker.isStopping = true;
                // R13: in-flight request is cancelled, not drained
                progressTracker.updateDisplay('⏹ Stopping - cancelling the in-flight request...');
                notify('info', 'Stopping repair - the in-flight request is cancelled. Completed fixes are saved; nothing is ever partially saved.', 'VectHare');
            },
        });

        let done = 0;
        let inserted = 0;
        let deleted = 0;
        let replacementFailures = 0;
        let deletionFailures = 0;
        const writtenReplacements = [];
        // R20: hashes of FAILED replacements - their ghosts must NOT be deleted
        // in Phase 2 (insert-before-delete guarantee: the stale vector stays as
        // the recall fallback until the replacement exists)
        const failedHashes = new Set();
        const label = 'Item';

        // Phase 1: re-insert replacements FIRST (insert-before-delete: a failed
        // embed leaves the stale vector in place rather than a hole; the ghost
        // cleanup on the next pass will retry)
        let attemptedReplacements = 0;
        if (replacements.length) panel()?.setPhase(phaseText('Re-embedding', 0, replacements.length));
        for (const item of replacements) {
            while (isVectorizationPaused() && !isVectorizationStopped() &&
                isChatTargetCurrent(target, collectionId)) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            if (!isChatTargetCurrent(target, collectionId)) throw new ChatSwitchStop();
            if (isVectorizationStopped()) break;
            await leaseStillHeld();
            try {
                const chunks = prepareItemsForInsertion([item]);
                const supersedes = replacementSources.get(String(item.hash));
                if (chunks[0] && supersedes != null) {
                    // Keep user annotations of the single vector this replaces (#66).
                    chunks[0].metadata = { ...carriedRecordMetadata(metaByHash.get(supersedes)),
                        ...chunks[0].metadata };
                }
                if (chunks[0]) chunks[0].__vecthareProvenanceHint = {
                    writer: 'repair', sourceType: 'chat',
                    groupingStrategy: item.metadata?.strategy,
                    ...(identityLedger ? { messageUids: item.metadata?.messageUids } : {}),
                };
                // R13: abortable - Stop cancels the in-flight repair embed
                recordChatStore(collectionId, settings);
                assertCollectionOperationSettingsStable(capturedConfig, settings, chatConfigChunking(settings));
                await insertVectorItems(collectionId, chunks, settings, (embedded, total) => {
                    panel()?.updateCurrentItem(`${label} ${done + 1}/${totalUnits} - embedding ${embedded}/${total}`);
                }, getStopSignal());
                inserted++;
                writtenReplacements.push(item);
                done++;
            } catch (err) {
                // An aborted or failed request may have an uncertain write outcome.
                failedHashes.add(String(item.hash));
                if (isVectorizationStopped()) break;
                console.warn(`VectHare: Repair - replacement write not acknowledged (hash ${item.hash}):`, err.message);
                replacementFailures++;
            }
            attemptedReplacements++;
            panel()?.updateProgress(done);
            panel()?.setWeightedPercent(embedStart + embedSpan * attemptedReplacements / replacements.length);
            panel()?.setPhase(phaseText('Re-embedding', attemptedReplacements, replacements.length) +
                `${replacementFailures ? ` (${replacementFailures} write errors)` : ''}`, { log: false });
        }

        // Check acknowledged replacement hashes BEFORE deleting any stale records.
        if (writtenReplacements.length > 0 && !isVectorizationStopped()) {
            panel()?.setPhase('Verifying replacements…');
            panel()?.setWeightedPercent(deleteStart);
        }
        let hashesFound = 0;
        let verificationUnavailable = false;
        const hashesNotFound = [];
        if (writtenReplacements.length > 0 && !isVectorizationStopped()) {
            while (isVectorizationPaused() && !isVectorizationStopped() &&
                isChatTargetCurrent(target, collectionId)) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            if (!isChatTargetCurrent(target, collectionId)) throw new ChatSwitchStop();
            if (!isVectorizationStopped()) {
                try {
                    // P5: read back only the hashes just written.
                    const written = await readInventoryForHashes(collectionId, settings,
                        writtenReplacements.map(item => item.hash), async () => {
                            // Fallback as before: the plain hash list (works without metadata).
                            const savedHashes = await getSavedHashes(collectionId, settings, false, getStopSignal());
                            return new Map(savedHashes.map(hash => [String(hash), []]));
                        });
                    if (!isChatTargetCurrent(target, collectionId)) throw new ChatSwitchStop();
                    if (!isVectorizationStopped()) {
                        const verifyHashes = new Set([...written.keys()]);
                        for (const item of writtenReplacements) {
                            if (verifyHashes.has(String(item.hash))) hashesFound++;
                            else hashesNotFound.push(item);
                        }
                        vhLog(`VectHare: Repair hash check - ${hashesFound}/${writtenReplacements.length} acknowledged replacement hashes found`);
                        for (const item of hashesNotFound) {
                            console.warn(`VectHare: Repair replacement hash not found: ${item.hash}`);
                        }
                    }
                } catch (verifyError) {
                    if (verifyError instanceof ChatSwitchStop) throw verifyError;
                    verificationUnavailable = true;
                    if (!isVectorizationStopped()) {
                        console.warn('VectHare: Repair hash check unavailable:', verifyError.message);
                    }
                }
            }
        }

        let replacementChecksPassed =
            inserted === replacements.length && replacementFailures === 0 &&
            !verificationUnavailable && hashesFound === writtenReplacements.length;
        if (identityLedger && replacementChecksPassed && replacements.length) {
            // Hash presence alone could belong to an unrelated source. For
            // identity-ledger deletes require the new chat provenance too.
            try {
                const inventory = await readInventoryForHashes(collectionId, settings,
                    replacements.map(item => item.hash));
                replacementChecksPassed = replacements.every(item =>
                    identityGroups.some(group => String(group.hash) === String(item.hash) &&
                        verifiedGroupHash(identityLedger, group, inventory)));
            } catch (error) {
                replacementChecksPassed = false;
                console.warn('VectHare: Replacement source verification failed; deletion deferred:', error.message);
            }
        }

        if (replacementChecksPassed && writtenReplacements.length) {
            // #57: the hash alone does not prove the stored record has the text,
            // grouping and provenance that this replacement was meant to carry.
            try {
                const inventory = await readInventoryForHashes(collectionId, settings,
                    writtenReplacements.map(item => item.hash));
                for (const item of writtenReplacements) {
                    let recordMatches = false;
                    for (const variant of textVariants(item)) {
                        const fingerprint = `sha256:${await sha256Text(variant.text)}`;
                        if ((inventory.get(String(item.hash)) || []).some(meta => chatRecordMatchesItem(meta, variant,
                            collectionId, fingerprint, Boolean(identityLedger), true))) { recordMatches = true; break; }
                    }
                    if (!recordMatches) {
                        replacementChecksPassed = false;
                        console.warn(`VectHare: Replacement record does not match its intended text/metadata (hash ${item.hash}); deletion deferred`);
                        break;
                    }
                }
            } catch (error) {
                replacementChecksPassed = false;
                console.warn('VectHare: Replacement content verification failed; deletion deferred:', error.message);
            }
        }
        if (replacementChecksPassed) {
            // Settings-layer annotations are keyed by hash: copy (never move; the
            // hash may still be used elsewhere) to the verified replacement.
            for (const item of writtenReplacements) {
                const supersedes = replacementSources.get(String(item.hash));
                const previous = supersedes != null ? getChunkMetadata(supersedes, collectionId) : null;
                if (previous && !getChunkMetadata(String(item.hash), collectionId)) {
                    saveChunkMetadata(String(item.hash), { ...previous }, collectionId);
                }
            }
        }

        // Hash-only deletion could also remove valid copies of current content.
        const deferredDuplicateKeys = [
            ...new Set(
                hashesToDelete
                    .map(hash => String(hash))
                    .filter(hash => currentHashSet.has(hash))
            ),
        ];

        // Defer all cleanup if any replacement is unresolved.
        const safeDeletes = replacementChecksPassed
            ? hashesToDelete.filter(hash =>
                !failedHashes.has(String(hash)) && !currentHashSet.has(String(hash)))
            : [];

        while (isVectorizationPaused() && !isVectorizationStopped() &&
                isChatTargetCurrent(target, collectionId)) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!isChatTargetCurrent(target, collectionId)) throw new ChatSwitchStop();
        if (safeDeletes.length > 0 && !isVectorizationStopped()) {
            // S3: removed in batches of 50, each read back before the next, so
            // the panel moves and a failure leaves only the unconfirmed keys.
            const DELETE_BATCH = 50;
            let confirmedBatches = 0; // keys in batches that were read back
            let stillStoredTotal = 0;
            try {
                assertCollectionOperationSettingsStable(capturedConfig, settings, chatConfigChunking(settings));
                for (let from = 0; from < safeDeletes.length; from += DELETE_BATCH) {
                    while (isVectorizationPaused() && !isVectorizationStopped() &&
                            isChatTargetCurrent(target, collectionId)) {
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                    if (!isChatTargetCurrent(target, collectionId)) throw new ChatSwitchStop();
                    if (isVectorizationStopped()) break;
                    await leaseStillHeld();
                    const part = safeDeletes.slice(from, from + DELETE_BATCH);
                    panel()?.setPhase(phaseText('Removing stale', confirmedBatches, safeDeletes.length),
                        { log: from === 0 });
                    await deleteVectorItems(collectionId, part, settings, getStopSignal());
                    if (!isChatTargetCurrent(target, collectionId)) throw new ChatSwitchStop();
                    // An acknowledged request is not proof: read the inventory back and
                    // count only keys whose every physical copy is actually gone (#67).
                    const remaining = await readInventoryForHashes(collectionId, settings, part);
                    if (!isChatTargetCurrent(target, collectionId)) throw new ChatSwitchStop();
                    const stillStored = part.filter(hash => remaining.has(String(hash)));
                    deleted += part.length - stillStored.length;
                    done += part.length - stillStored.length;
                    deletionFailures += stillStored.length;
                    stillStoredTotal += stillStored.length;
                    confirmedBatches += part.length;
                    panel()?.updateProgress(done);
                    panel()?.setWeightedPercent(deleteStart + deleteSpan * confirmedBatches / safeDeletes.length);
                    panel()?.setPhase(phaseText('Removing stale', confirmedBatches, safeDeletes.length), { log: false });
                }
                if (stillStoredTotal) {
                    console.warn(`VectHare: Repair deletion acknowledged but ${stillStoredTotal} key(s) remain stored`);
                } else if (confirmedBatches === safeDeletes.length) {
                    vhLog(`VectHare: Repair deletion verified for ${safeDeletes.length} stale deletion key(s)`);
                }
            } catch (delError) {
                if (delError instanceof ChatSwitchStop || delError?.code === 'VH_LEASE_LOST') throw delError;
                if (!isVectorizationStopped()) {
                    // Keys in earlier batches were read back; the rest are unconfirmed.
                    deletionFailures += safeDeletes.length - confirmedBatches;
                    console.warn('VectHare: Repair - deletion not acknowledged; database outcome may be uncertain:', delError.message);
                }
            }
            panel()?.updateProgress(done);
        }

        // Do not finish a merely paused repair; Resume or Stop remains available.
        while (isVectorizationPaused() && !isVectorizationStopped() &&
                isChatTargetCurrent(target, collectionId)) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!isChatTargetCurrent(target, collectionId)) throw new ChatSwitchStop();

        const stopped = isVectorizationStopped();
        const passSucceeded =
            !stopped && replacementFailures === 0 && deletionFailures === 0 &&
            !verificationUnavailable && inserted === replacements.length &&
            hashesFound === replacements.length && deleted === hashesToDelete.length;
        const unresolved = Math.max(0, totalUnits - (hashesFound + deleted));
        let identityLedgerConfirmed = !identityLedger;
        if (!stopped) {
            panel()?.setPhase('Verifying…');
            panel()?.setWeightedPercent(verifyStart);
        }
        if (identityLedger && !stopped) {
            try {
                const inventory = await readIdentityInventory(collectionId, settings);
                identityLedgerConfirmed = await finishIdentityLedger(identityLedger,
                    identityReconciliation, identityGroups, inventory);
            } catch (error) {
                console.warn('VectHare: Repair ledger remains dirty until verification succeeds:', error.message);
            }
        }
        const summary =
            `Repair pass ${stopped ? 'stopped' : passSucceeded && identityLedgerConfirmed ? 'complete' : 'incomplete'}: ` +
            `${inserted}/${replacements.length} replacement writes acknowledged, ` +
            `${hashesFound}/${inserted} replacement hashes found, ` +
            `${deleted}/${hashesToDelete.length} deletion keys acknowledged` +
            `${deferredDuplicateKeys.length
                ? `, ${deferredDuplicateKeys.length} current-content hash key(s) deferred (hash-only deletion could remove valid copies)`
                : ''}` +
            `${verificationUnavailable ? ', hash check unavailable' : ''}` +
            `${replacementFailures ? `, ${replacementFailures} replacement write errors` : ''}` +
            `${deletionFailures ? `, ${deletionFailures} deletion keys without acknowledgement` : ''}` +
            `${unresolved ? `, ${unresolved} work units unresolved` : ''}` +
            // Phase 4: say what was NOT acted on, so a pass that leaves groups
            // behind is never read as "everything is repaired".
            `${identityReconciliation?.uncertainUids?.size
                ? `, ${identityReconciliation.uncertainUids.size} source identity association(s) unresolved and preserved (${UNRESOLVED_ACTION_HINT(identityReconciliation.uncertainUids.size)})`
                : ''}` +
            `${groupsLeftToSync ? `, ${groupsLeftToSync} group(s) left to Sync Chat (contain never-indexed messages)` : ''}` +
            `${!identityLedgerConfirmed ? ', identity ledger verification incomplete' : ''}`;

        releaseRun();
        panel()?.updateProgress(hashesFound + deleted);
        panel()?.complete(passSucceeded && identityLedgerConfirmed, summary, runId);
        if (passSucceeded && identityLedgerConfirmed) {
            if (!embedded) notify('success', summary, 'Repair');
            return 'ok';
        } else {
            notify('warning', summary + '. Unresolved work can be checked on a later repair pass.',
                'Repair', { timeOut: 15000 });
        }
    } catch (error) {
        const wasStopped = isVectorizationStopped(); // a Stop cancels reads too
        releaseRun();
        if (wasStopped) requireReconciliationAfterStop(writeLockedCollection);
        if (wasStopped && !(error instanceof ChatSwitchStop)) {
            if (progressShown) panel()?.complete('stopped', 'Repair stopped - completed fixes are saved', runId);
            notify('info', 'Repair stopped. Completed changes are saved.', 'VectHare');
            return;
        }
        if (error?.code === 'VH_LEASE_HELD' || error?.code === 'VH_LEASE_LOST') {
            if (progressShown) panel()?.complete('stopped', 'Repair stopped - another tab is working on this chat', runId);
            notify('info', error.message, 'Repair');
            return;
        }
        if (error?.code === 'VH_LEDGER_CONFLICT') {
            if (progressShown) panel()?.complete('stopped', 'Repair stopped - another tab is updating this chat', runId);
            notify('info', 'Another tab or device is updating this chat right now, so Repair stopped before changing anything unconfirmed. Run it again in a moment.', 'Repair');
            return;
        }
        if (error instanceof ChatSwitchStop) {
            if (progressShown) panel()?.complete('stopped', 'Repair stopped because you switched chats — completed changes saved', runId);
            notify('info', 'Repair stopped because you switched chats. Completed changes are saved.', 'VectHare');
            console.info('VectHare: Repair stopped after chat switch; completed changes preserved');
            return;
        }
        console.error('VectHare: Repair failed', error);
        panel()?.addError(error.message);
        panel()?.complete(false, 'Repair failed', runId);
        notify('error', `Repair failed: ${error.message}`, 'VectHare');
    } finally {
        if (writeLockedCollection) endChatCollectionWrite(writeLockedCollection);
        await repairLease?.release();
    }
}

/**
 * VectHare+: Detects unfinished vectorization work for the current chat.
 * Compares grouped chat items against the collection's stored hashes without
 * vectorizing anything. Used on startup/chat-load to surface a "continue"
 * affordance for an interrupted run — the core of resume-on-load.
 *
 * @param {object} settings VectHare settings
 * @returns {Promise<{hasBacklog: boolean, pending: number, total: number}|null>} null if undeterminable
 */
export async function checkUnfinishedVectorization(settings, collectionIdOverride = null) {
    try {
        // VH-109: another tab may have just created or moved this collection.
        await refreshStoreIfStale({ minIntervalMs: 1000 }).catch(() => false);
        const target = captureChatTarget();
        if (!target) return null;
        const collectionId = collectionIdOverride || getChatCollectionId();
        if (!collectionId || !isChatTargetCurrent(target, collectionId)) return null;
        if (settings.chunking_strategy === 'per_scene') return null;

        // VectHare+ FIX (ghost collections): only inspect collections already
        // known to the registry. Registry entries are only created after a
        // successful insert, so this both avoids wasted work AND prevents the
        // resume check from reading a vector DB that doesn't exist yet — some
        // backends create an empty collection on read, which previously
        // surfaced as 0-chunk "ghost" chats in discovery.
        const registry = getCollectionRegistry();
        const knownInRegistry = registry.some(
            key => parseRegistryKey(key).collectionId === collectionId
        );
        // Returns null in this case so callers can distinguish "collection not
        // discovered yet (retry)" from an actual definitive "no backlog".
        if (!knownInRegistry) {
            console.debug('VectHare: Resume check inconclusive - collection not in registry yet');
            return null;
        }

        // VH-050: read the collection with ITS OWN saved settings (provider,
        // model, backend), not today's global ones. After a provider switch the
        // global settings point at a different (empty) storage key, which made
        // this status line say "0 stored, N pending" for a full collection.
        let readSettings = settings;
        try {
            readSettings = await resolveEmbeddingSettingsForEdit(collectionId, settings) || settings;
        } catch (error) {
            console.debug('VectHare: Resume check using current settings:', error?.message || error);
        }
        const existingHashes = new Set(
            (await getSavedHashes(collectionId, readSettings)).map(hash => String(hash))
        );
        // A completed read for Chat A must never be paired with Chat B's messages.
        if (!isChatTargetCurrent(target, collectionId)) return null;

        // Match Sync Chat's message preparation, grouping and raw-text hashes -
        // with the chat's own saved chunking, as Sync uses it (VH-110).
        let statusSettings = settings;
        try {
            statusSettings = withSavedChatChunking(settings, await readInitialVectorizationConfig(collectionId, readSettings));
        } catch { /* no saved settings readable: today's settings, as before */ }
        const groupedItems = await collectCurrentChatGroups(target.messages, statusSettings,
            collectionId, true);
        if (!isChatTargetCurrent(target, collectionId)) return null;
        const pending = groupedItems.filter(
            item => !existingHashes.has(String(item.hash))
        ).length;

        // VH-061: a collection from before 13.31 (no saved settings) is marked.
        let needsRevectorizing = false;
        if (existingHashes.size) {
            try {
                needsRevectorizing = (await readInitialVectorizationConfig(collectionId, settings)).status === 'missing';
            } catch { /* unknown: no mark */ }
        }
        return {
            hasBacklog: pending > 0 && !needsRevectorizing,
            pending,
            total: groupedItems.length,
            storedChunks: existingHashes.size,
            needsRevectorizing,
        };
    } catch (error) {
        console.warn('VectHare: Could not check for unfinished vectorization:', error.message);
        return null;
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

    const collectionId = getChatCollectionId();
    if (!collectionId) {
        toastr.error('Could not get collection ID', 'Purge aborted');
        return;
    }

    try {
        if (await withChatCollectionPurgeGuard(collectionId, () => purgeVectorIndex(collectionId, settings))) {
            toastr.success('Vector index purged', 'VectHare');
            vhLog('VectHare: Index purged successfully');
        } else {
            toastr.error('Failed to purge vector index', 'VectHare');
        }
    } catch (error) {
        toastr.warning(error.message, 'Purge aborted');
    }
}
