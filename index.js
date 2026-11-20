import { vhLog } from './utils/log.js';
/**
 * ============================================================================
 * VECTHARE - ADVANCED RAG SYSTEM
 * ============================================================================
 * Entry point - lean and clean
 * All logic is in separate modules - see project guidelines
 *
 * @author Coneja Chibi
 * @version see manifest.json
 * ============================================================================
 */

import {
    eventSource,
    event_types,
    extension_prompt_types,
    saveSettingsDebounced,
} from '../../../../script.js';
import {
    ModuleWorkerWrapper,
    extension_settings,
    getContext,
} from '../../../extensions.js';
import { debounce } from '../../../utils.js';
import { debounce_timeout } from '../../../constants.js';

// VectHare modules - Core
import { synchronizeChat, rearrangeChat, vectorizeAll, repairChatVectors, checkUnfinishedVectorization, isVectorizationActive, isChatSynchronizationActive, consumeWasLastRunStoppedByUser, flagImmediateReverseSync, parseRegistryKey, noteChatSwitch, planChatVectorizationRebuild, getSyncBatchSize } from './core/chat-vectorization.js';
import {
    ensureChatBinding, chatFileExists, deletionCandidates, anotherChatClaimsCollection,
    removeChatBinding, releaseToQuarantine, onChatBindingRenamed, onCharacterBindingRenamed,
    isChatCollectionWriteActive, tryBeginChatCollectionDelete, endChatCollectionDelete, chatStoreDestination,
    getChatOwner, normChat, requestFreshChatCollection,
} from './core/collection-ids.js';
import { purgeAllVectorIndexes, purgeVectorIndex } from './core/core-vector-api.js';
import { getChatCollectionId } from './core/chat-vectorization.js';
import { getDefaultDecaySettings } from './core/temporal-decay.js';
import { migrateOldEnabledKeys, deleteCollectionMeta, forgetAllLegacyCollectionKeys, renameChatPolicy, renameCharacterPolicies, renameChatLocks, renameCharacterLocks, fillStorageLocators } from './core/collection-metadata.js';
import { getBackend as getBackendForLocators } from './backends/backend-manager.js';
import { loadVectHareStore, vecthareState, storeStatus, flushVectHareStore, resetVectHareStore, refreshStoreIfStale } from './core/vecthare-store.js';
import { escapeHtml } from './utils/html.js';
import { migrateSecretsFromSettings } from './core/secret-store.js';
import { clearCollectionRegistry, discoverExistingCollections, getCollectionRegistry, unregisterCollection, doesChatHaveVectors } from './core/collection-loader.js';
import { softDeleteChatCollection, purgeDeletedChats, DELETED_CHAT_KEEP_DAYS } from './core/deleted-chats.js';
import AsyncUtils from './utils/async-utils.js';

// VectHare modules - UI
import { renderSettings, openDiagnosticsModal, loadWebLlmModels, updateWebLlmStatus, refreshAutoSyncCheckbox, updateContinueVectorizationButton, updateVectorizationStatus, openPurgeOptionsDialog } from './ui/ui-manager.js';
import { progressTracker } from './ui/progress-tracker.js';
import { initializeVisualizer } from './ui/chunk-visualizer.js';
import { initializeDatabaseBrowser } from './ui/database-browser.js';
import { checkBackendHealth } from './ui/health-dashboard.js';
import { checkPluginCompatibility } from './core/plugin-health.js';
import { initializeSceneMarkers, updateAllMarkerStates, setSceneSettings } from './ui/scene-markers.js';
import { initializeWorldInfoIntegration } from './core/world-info-integration.js';

// VectHare modules - Cotton-Tales Integration
import { registerClassifierSettingsMirror } from './core/emotion-classifier.js'; // Exposes window.VectHareEmotionClassifier

// Constants
const MODULE_NAME = 'VectHare';

// Default settings
const defaultSettings = {
    // Core vector settings
    source: 'transformers',
    vector_backend: 'standard', // Backend: 'standard' (ST Vectra), 'lancedb', 'qdrant'
    qdrant_host: 'localhost',
    qdrant_port: 6333,
    qdrant_url: '',
    qdrant_api_key: '',
    qdrant_use_cloud: false,
    qdrant_multitenancy: false, // Use single collection with content_type field instead of separate collections
    milvus_multitenancy: true, // 9c: new Milvus collections share one store per vector size (off: one store each)
    milvus_host: 'localhost',
    milvus_port: 19530,
    milvus_username: '',
    milvus_password: '',
    milvus_token: '',
    milvus_address: '',
    alt_endpoint_url: '',
    use_alt_endpoint: false,
    rate_limit_calls: 5,
    rate_limit_interval: 60, // seconds

    // VEC-6: Batch insert optimization
    insert_batch_size: 50, // Chunks per insert batch (50-100 recommended)
    debug_logging: false, // U3: VectHare's informational console output (warnings/errors always shown)
    togetherai_model: 'togethercomputer/m2-bert-80M-32k-retrieval',
    openai_model: 'text-embedding-ada-002',
    electronhub_model: 'text-embedding-3-small',
    openrouter_model: 'openai/text-embedding-3-large',
    cohere_model: 'embed-english-v3.0',
    ollama_model: 'mxbai-embed-large',
    ollama_keep: false,
    vllm_model: '',
    webllm_model: '',
    google_model: 'text-embedding-005',
    bananabread_rerank: false,
    bananabread_api_key: '', // Stored here since custom keys aren't returned by ST's readSecretState()

    // Chat vectorization
    enabled_chats: false,
    chunking_strategy: 'per_message', // per_message, conversation_turns, message_batch, adaptive
    batch_size: 4, // Messages per batch for message_batch strategy
    conversation_turn_order: 'user_character', // Pairing order for conversation_turns
    depth: 2,
    position: extension_prompt_types.IN_PROMPT,
    protect: 5,
    insert: 3,
    min_chat_length: 0, // Minimum number of messages in chat before injection starts (0 = no minimum)
    rag_timeout_seconds: 15, // VH-019: retrieval at generation gives up after this many seconds (0 = no limit)
    // Number of top results to retrieve from vector DB (top-K)
    top_k: 3,
    query: 2,
    chunk_size: 500, // For adaptive strategy only
    score_threshold: 0.25,

    // Deduplication settings
    deduplication_depth: 50, // Number of recent messages to check for duplicates (0 = check all)

    // Keyword scoring method
    keyword_scoring_method: 'keyword', // 'keyword', 'bm25', or 'hybrid'

    // BM25 parameters
    bm25_k1: 1.5,  // Term frequency saturation (1.2-2.0 typical)
    bm25_b: 0.75,  // Length normalization (0-1, 0.75 typical)

    // Keyword extraction level for chat messages
    keyword_extraction_level: 'balanced', // 'off', 'minimal', 'balanced', 'aggressive'

    // Hybrid Search settings (combines vector + full-text search)
    hybrid_search_enabled: false,       // Enable hybrid search mode
    hybrid_fusion_method: 'rrf',        // 'rrf' (Reciprocal Rank Fusion) or 'weighted'
    hybrid_vector_weight: 0.5,          // Weight for vector scores (0-1) - used in weighted mode
    hybrid_text_weight: 0.5,            // Weight for text/BM25 scores (0-1) - used in weighted mode
    hybrid_rrf_k: 60,                   // RRF constant (higher = more weight to top results)
    hybrid_native_prefer: true,         // Prefer native backend hybrid if available (Qdrant/Milvus)

    // Advanced features
    temporal_decay: getDefaultDecaySettings(),

    // Global defaults for new collections
    default_decay_enabled: false,    // Whether new collections have temporal weighting enabled
    default_decay_type: 'decay',     // 'decay' or 'nostalgia' for new collections

    // RAG Prompt Context (Global level)
    // Wraps ALL injected content with context prompts and/or XML tags
    rag_context: '',      // Natural language context shown before all RAG content
    rag_xml_tag: '',      // XML tag to wrap all RAG content (e.g., "retrieved_context")
    include_keywords_in_rag_context: false,

    // Collection-level metadata (managed by collection-metadata.js)
    collections: {},

    // Collection registry and collection metadata are stored in VectHare's own
    // collections.json (see core/vecthare-store.js); these defaults remain only
    // so a fresh install has the expected shape before the store loads.
    vecthare_collection_registry: [],

    // World Info Integration
    enabled_world_info: false,          // Enable semantic WI activation
    world_info_threshold: 0.3,          // Score threshold for WI activation
    world_info_top_k: 3,                // Max entries to activate per lorebook
    world_info_query_depth: 3,          // Recent messages to use for query
    world_info_enabled_for_all: false,  // Bypass dedup so semantic WI can also include keyword-active entries
    world_info_max_entries: 10,         // Cap on total semantic WI entries returned for injection

    // Keyword Extraction
    custom_stopwords: '',               // Custom stopwords (comma-separated)

    // Diagnostics
    include_production_tests: false,    // Default for production diagnostics checkbox
};

// Runtime settings (merged with saved settings)
let settings = { ...defaultSettings };

// Module worker for automatic syncing
const moduleWorker = new ModuleWorkerWrapper(() => synchronizeChat(settings, getBatchSize()));

// Batch size based on provider
// P2: one source of truth for the per-pass batch (see getSyncBatchSize).
const getBatchSize = () => getSyncBatchSize(settings);

// Chat event handler (debounced)
const onChatEvent = debounce(async () => await moduleWorker.update(), debounce_timeout.relaxed);

/**
 * Generation interceptor - searches and injects relevant messages
 */
async function vecthare_rearrangeChat(chat, _contextSize, _abort, type) {
    await rearrangeChat(chat, settings, type);
}

// Export to window for ST to call
window['vecthare_rearrangeChat'] = vecthare_rearrangeChat;

/**
 * VectHare+ R12: Repair-only entry point (Repair Chunks button).
 * Fixes already-vectorized content (stale/duplicate vectors + replacements
 * of edited messages) WITHOUT continuing the backlog.
 */
async function onRepairClick() {
    invalidateSavedVectorizationStatus();
    try {
        await repairChatVectors(settings, getBatchSize());
        // F8: Repair never retires scenes either; mark the ones whose messages changed.
        try {
            const { refreshSceneStaleness } = await import('./core/scenes.js');
            const scenes = await refreshSceneStaleness(settings);
            if (scenes.outdated) {
                toastr.warning(`${scenes.outdated} scene(s) are outdated because their messages changed. ` +
                    'They are not used until re-created (chunk browser \u2192 Scenes).', 'VectHare', { timeOut: 10000 });
            }
        } catch (error) {
            console.debug('VectHare: Scene staleness check skipped:', error.message);
        }
    } finally {
        invalidateSavedVectorizationStatus();
        void offerResumeOfUnfinishedVectorization(); // refresh status line + button
    }
}

/**
 * VH-062 (user decision: start fresh, no backup copy): collections.json is
 * damaged or missing. Asks once per page load; vectors are never touched.
 */
async function offerFreshVectHareStore(detail) {
    const { callGenericPopup, POPUP_TYPE } = await import('../../../popup.js');
    const confirmed = await callGenericPopup(
        `<div style="text-align:left;">
            <h3>VectHare's collection list is damaged</h3>
            <p>${escapeHtml(detail)}.</p>
            <p style="margin-top:10px;"><strong>Start fresh</strong> replaces it with an empty list. Your vectors are not touched:
            collections are found again from your vector backends, and you can delete old ones in the Database Browser.
            Collections in the shared stores of the current layout are found again too. Collections in the older shared
            stores (Qdrant <code>vecthare_multitenancy</code>, Milvus <code>vecthare_main</code>) are not found again one by one;
            their vectors stay in that store.</p>
            <p style="margin-top:10px;">What is lost: which chat uses which collection (each chat is vectorized again into a new
            collection the next time you use it), and per-chunk notes (keywords, conditions, disabled chunks).</p>
        </div>`, POPUP_TYPE.CONFIRM, '', { okButton: 'Start fresh', cancelButton: 'Not now' });
    if (!confirmed) return;
    const { startFreshVectHareStore } = await import('./core/vecthare-store.js');
    const result = await startFreshVectHareStore();
    if (!result.success) {
        toastr.error(`Could not start fresh: ${result.reason}`, 'VectHare', { timeOut: 15000 });
        return;
    }
    toastr.clear?.();
    toastr.success(result.reason || 'Started a fresh collection list. Finding your collections again…', 'VectHare');
    try {
        await discoverExistingCollections(settings);
    } catch (error) {
        console.warn('VectHare: rediscovery after a fresh start failed:', error);
    }
}

/**
 * VH-083: a chat whose saved claim names a character or chat file that no
 * longer exists cannot be matched to its collection. Offer to start a new one
 * (the old collection is kept untouched).
 * @returns {Promise<boolean|null>} true: a new collection was chosen; false: declined; null: not such a chat
 */
async function offerFreshCollectionForUnverifiedChat(binding = null) {
    binding ??= await ensureChatBinding(undefined, { create: false }).catch(() => null);
    if (!binding?.unverifiedClaim) return null;
    const { callGenericPopup, POPUP_TYPE } = await import('../../../popup.js');
    const confirmed = await callGenericPopup(
        `<div style="text-align:left;">
            <h3>Start a new collection for this chat?</h3>
            <p>This chat file names a character or chat file that no longer exists (for example after a rename
            or an import), so VectHare cannot tell which vector collection belongs to it.</p>
            <p style="margin-top:10px;">Starting a new collection vectorizes this chat from its messages.
            Any old collection is kept untouched and can be deleted later in the Database Browser.</p>
        </div>`, POPUP_TYPE.CONFIRM, '', { okButton: 'Start a new collection', cancelButton: 'Cancel' });
    if (!confirmed) return false;
    requestFreshChatCollection();
    return true;
}

/**
 * Action: Vectorize. For a chat that already has a vector collection this is a
 * REBUILD, so it asks first and only then opens the normal vectorization setup;
 * pressing Vectorize there runs the staged, verify-before-switch replacement.
 * A genuinely unvectorized chat keeps the normal first-vectorization flow.
 */
async function onVectorizeContentClick() {
    const { openContentVectorizer } = await import('./ui/content-vectorizer.js');
    if (await offerFreshCollectionForUnverifiedChat() === false) return; // VH-083

    let existing = null;
    try {
        existing = await doesChatHaveVectors(settings);
    } catch (error) {
        // An unreadable collection is not evidence that there is none: ask
        // rather than silently starting a first vectorization over the top.
        console.warn('VectHare: Could not check this chat for existing vectors:', error);
        existing = { hasVectors: true, chunkCount: 0, collectionId: null };
    }

    if (!existing?.hasVectors) {
        openContentVectorizer();
        return;
    }

    let annotationCount = 0;
    try {
        if (existing.collectionId) {
            const { getAnnotatedChunkHashes } = await import('./core/collection-metadata.js');
            annotationCount = getAnnotatedChunkHashes(existing.collectionId).length;
        }
    } catch (error) {
        console.warn('VectHare: Could not count this collection\'s annotations:', error);
    }

    const { callGenericPopup, POPUP_TYPE } = await import('../../../popup.js');
    const chunks = existing.elsewhere
        // VH-052
        ? '<p>This chat\'s vector collection is on another vector backend or server. Rebuilding makes a new collection on the one selected now; the old one is kept where it is.</p>'
        : existing.chunkCount
        ? `<p>This chat already has an existing vector collection (<strong>${existing.chunkCount}</strong> chunks).</p>`
        : '<p>This chat already has an existing vector collection.</p>';
    const disclosure = annotationCount
        ? `<p style="margin-top:10px;"><small>Your collection settings carry over. ` +
          `${annotationCount} per-chunk annotation(s) carry over only for chunks the rebuild ` +
          `reproduces; any that cannot be matched stay with the old collection.</small></p>`
        : '<p style="margin-top:10px;"><small>Your collection settings carry over.</small></p>';
    const confirmed = await callGenericPopup(
        `<div style="text-align:left;">
            <h3>Re-vectorize This Chat?</h3>
            ${chunks}
            <p style="margin-top:10px;">Would you like to rebuild its vectors using newly selected
            vectorization settings?</p>
            <p style="margin-top:10px;">Rebuilding will replace the existing embeddings and update
            the collection's saved configuration and metadata after the replacement succeeds.</p>
            <p style="margin-top:10px;"><strong>Your original chat messages will not be modified.</strong></p>
            ${disclosure}
        </div>`,
        POPUP_TYPE.CONFIRM, '',
        { okButton: 'Yes, Configure Rebuild', cancelButton: 'No, Cancel' });

    if (!confirmed) return;
    openContentVectorizer('chat', { rebuild: true });
}

/**
 * Action: Vectorize all messages in current chat (full sync: repair + backlog)
 */
async function onVectorizeAllClick() {
    invalidateSavedVectorizationStatus();
    try {
        // Phase 3: if the selected settings cannot be used on this chat's
        // existing collection, offer a confirmed rebuild instead of silently
        // reusing the old settings or writing into an incompatible collection.
        let plan;
        try {
            plan = await planChatVectorizationRebuild(settings);
        } catch (error) {
            console.error('VectHare: Rebuild preflight failed:', error);
            plan = { action: 'vectorize' }; // never block the normal path on a preflight bug
        }

        if (plan.action === 'blocked' && plan.unverifiedClaim) {
            // VH-083: offer a new collection, then vectorize into it.
            if (await offerFreshCollectionForUnverifiedChat({ unverifiedClaim: true })) {
                await vectorizeAll(settings, getBatchSize());
            }
            return;
        }
        if (plan.action === 'blocked') {
            toastr.error(plan.reason, 'VectHare');
            return;
        }

        // Sync is incremental only. Settings that cannot be used on this
        // chat's existing collection are a rebuild decision, which belongs to
        // Vectorize and its confirmation - never to a Sync press.
        if (plan.action === 'rebuild') {
            const differences = (plan.differences || [])
                .map(difference => `${difference.field}: was "${difference.saved}", now "${difference.intended}"`)
                .join('; ');
            toastr.error(
                `${plan.reason}${differences ? ` (${differences})` : ''} ` +
                'Sync only adds missing messages with the collection\'s own saved settings. ' +
                'To use the newly selected settings, press Vectorize and confirm the rebuild.',
                'VectHare: Sync not possible', { timeOut: 0, extendedTimeOut: 0 });
            return;
        }

        await vectorizeAll(settings, getBatchSize());
    } finally {
        // Re-read after the run, including Stop, failure and partial completion.
        invalidateSavedVectorizationStatus();
        void offerResumeOfUnfinishedVectorization();
    }
}

/**
 * VectHare+ Resume-on-load: detects unfinished vectorization work for the
 * current chat and offers continuation. Cursor-free by design — the vector
 * DB itself is the checkpoint, so any interruption (crash, page reload,
 * Stop button, closed browser) resumes exactly from what is missing.
 *
 * Robust against startup ordering: the collection registry is populated
 * asynchronously (discoverExistingCollections runs with its own retries), so
 * this polls until the check yields a definitive answer or attempts run out.
 */
const RESUME_CHECK_MAX_ATTEMPTS = 5;   // covers slow collection discovery
const RESUME_CHECK_RETRY_MS = 3000;

function showResumeToast(pending, total) {
    // Unfinished groups are Sync Chat backlog, not Repair Chunks work.
    toastr.info(
        `${pending} of ${total} message groups not yet vectorized. Use "Sync Chat" in VectHare's Actions panel to continue vectorization. Repair Chunks only fixes previously indexed chunks.`,
        'VectHare: Unfinished vectorization',
        {
            timeOut: 20000,
            closeOnHover: false,
            preventDuplicates: true, // CHAT_CHANGED fires at startup too - don't double-toast
        }
    );
}

/**
 * VectHare+ R10: Updates the Actions-card status line.
 * States: running (live % from the tracker) / backlog % / fully vectorized /
 * no collection. Called from the resume check's definitive branch and by a
 * light 3s interval while a run is active.
 * @param {{hasBacklog?: boolean, pending?: number, total?: number}} [result]
 */
let lastDbStatus = null;
let dbStatusRequestId = 0;
let resumeCheckId = 0;
let activeResumeStatusReadId = 0;
let dbRefreshTimer = null;

function currentStatusChatKey() {
    const ctx = getContext();
    const owner = getChatOwner(ctx);
    const filename = normChat(ctx?.chatId);
    return owner && filename ? JSON.stringify([
        owner.type, owner.id, filename, getChatCollectionId(),
        settings.chunking_strategy, settings.batch_size,
        settings.conversation_turn_order, settings.keyword_extraction_level,
        settings.chunk_size, settings.vector_backend, settings.source,
        settings.qdrant_url, settings.qdrant_host, settings.qdrant_port,
        settings.qdrant_use_cloud, settings.qdrant_multitenancy
    ]) : null;
}

// #36: a saved-progress snapshot must say which chat it describes.
function currentStatusTargetLabel() {
    const ctx = getContext();
    const name = ctx?.characterId != null && ctx?.characters?.[ctx.characterId]?.name
        ? ctx.characters[ctx.characterId].name
        : (ctx?.groupId && ctx?.groups?.find(group => group.id === ctx.groupId)?.name) || '';
    const file = normChat(ctx?.chatId) || '';
    if (name && file) return `${name} · ${file}`;
    return name || file || '';
}

// #37: the status line and button only knew about Sync/Repair runs. Any
// operation that owns the progress panel (Content Vectorizer, import, export)
// counts as in flight, so saved snapshots cannot overwrite its reporting.
function isAnyOperationActive() {
    return isVectorizationActive() || isChatSynchronizationActive() ||
        Boolean(progressTracker.isVisible && !progressTracker.isComplete &&
            progressTracker.currentOperation && !progressTracker.isDatabaseSnapshot);
}

function unavailableVectorizationStatus() {
    if (settings.chunking_strategy === 'per_scene') {
        return 'Per-scene: chat progress is managed through scene markers';
    }
    const collectionId = getChatCollectionId();
    if (!collectionId) return 'Saved vector status unavailable — no current chat collection';
    const known = getCollectionRegistry().some(key => {
        const entry = parseRegistryKey(key);
        return entry.collectionId === collectionId &&
            (!entry.backend || entry.backend === settings.vector_backend) &&
            (!entry.source || entry.source === settings.source);
    });
    return known ? 'Saved vector status unavailable — database check inconclusive'
        : 'No registry entry found for this chat — saved status unverified';
}

function invalidateSavedVectorizationStatus() {
    lastDbStatus = null;
    ++dbStatusRequestId;
    ++resumeCheckId;
    if (!isAnyOperationActive() && !progressTracker.isPaused && progressTracker.isDatabaseSnapshot) {
        progressTracker.setDatabaseStatus(null, unavailableVectorizationStatus(), currentStatusTargetLabel());
    }
    refreshVectorizationStatusDisplay();
}

function isValidSavedStatus(result) {
    return result != null &&
        Number.isSafeInteger(result.total) && Number.isSafeInteger(result.pending) &&
        result.total >= 0 && result.pending >= 0 && result.pending <= result.total;
}

function refreshVectorizationStatusDisplay() {
    if (isAnyOperationActive() || progressTracker.isPaused) {
        const state = progressTracker.isPaused ? 'Paused' : 'Running';
        if (settings.chunking_strategy === 'per_scene') {
            updateVectorizationStatus(`${state} — click to view`);
            return;
        }
        const s = progressTracker.stats;
        const useEmbedding = progressTracker.currentOperation !== 'Vectorizing Chat' &&
            s.totalChunksToEmbed > 0;
        const done = useEmbedding ? s.embeddedChunks : s.processedItems;
        const total = useEmbedding ? s.totalChunksToEmbed : s.totalItems;
        if (!Number.isFinite(done) || !Number.isFinite(total) ||
            done < 0 || total <= 0 || done > total) {
            updateVectorizationStatus(`${state} — progress unavailable — click to view`);
            return;
        }
        const pct = Math.round(done / total * 100);
        updateVectorizationStatus(`${state} — ${pct}% (${done}/${total}) — click to view`);
        return;
    }
    if (settings.chunking_strategy === 'per_scene') {
        updateVectorizationStatus(unavailableVectorizationStatus());
        return;
    }
    const statusKey = currentStatusChatKey();
    const result = statusKey && lastDbStatus?.statusKey === statusKey &&
        isValidSavedStatus(lastDbStatus) ? lastDbStatus : null;
    if (!result) {
        updateVectorizationStatus(unavailableVectorizationStatus());
        return;
    }
    if (result.total === 0) {
        updateVectorizationStatus('No eligible message groups in this chat');
        return;
    }
    const done = result.total - result.pending;
    const storedHashesKnown = Number.isSafeInteger(result.storedChunks) &&
        result.storedChunks >= 0;
    if (done === 0 && storedHashesKnown && result.storedChunks > 0) {
        updateVectorizationStatus(
            `${result.storedChunks} stored hash(es) reported; ` +
            'no matching current group hashes found — click for details'
        );
        return;
    }
    const pct = Math.round(done / result.total * 100);
    updateVectorizationStatus(result.pending > 0
        ? `Vectorized: ${pct}% (${done}/${result.total}) — click for details`
        : `Fully vectorized (${result.total}/${result.total}) ✓`);
}

// Read the actual saved hashes, coalescing rapid writes into one DB query.
// Runs after each committed insert/delete/purge and whenever Status opens.
let savedStatusRead = null;
let savedStatusRefreshQueued = false;

function refreshSavedDatabaseStatus() {
    savedStatusRefreshQueued = true;
    if (savedStatusRead) return savedStatusRead;
    savedStatusRead = (async () => {
        while (savedStatusRefreshQueued) {
            if (isAnyOperationActive() ||
                isChatCollectionWriteActive(getChatCollectionId())) {
                clearTimeout(dbRefreshTimer);
                dbRefreshTimer = setTimeout(() => {
                    void refreshSavedDatabaseStatus();
                }, 1000);
                return;
            }
            savedStatusRefreshQueued = false;
            await readSavedDatabaseStatus();
        }
    })().finally(() => {
        savedStatusRead = null;
        if (savedStatusRefreshQueued && !isAnyOperationActive() &&
            !isChatCollectionWriteActive(getChatCollectionId())) {
            scheduleSavedDatabaseRefresh();
        }
    });
    return savedStatusRead;
}

async function readSavedDatabaseStatus() {
    const chatKey = currentStatusChatKey();
    if (!chatKey) {
        lastDbStatus = null;
        if (!isAnyOperationActive() && !progressTracker.isPaused && progressTracker.isDatabaseSnapshot) {
            progressTracker.setDatabaseStatus(null, unavailableVectorizationStatus(), currentStatusTargetLabel());
        }
        refreshVectorizationStatusDisplay();
        return;
    }
    // Let startup/operation resume checks finish their retries and button update.
    if (activeResumeStatusReadId && activeResumeStatusReadId === dbStatusRequestId) return;
    const requestId = ++dbStatusRequestId;
    const collectionId = getChatCollectionId();
    let result = null;
    try {
        result = await checkUnfinishedVectorization(settings);
    } catch (error) {
        console.warn('VectHare: Status refresh failed:', error);
    }
    // A status read only publishes while its chat and request still match.
    if (requestId !== dbStatusRequestId || chatKey !== currentStatusChatKey() ||
        collectionId !== getChatCollectionId() ||
        isAnyOperationActive() || isChatCollectionWriteActive(collectionId)) return;
    result = isValidSavedStatus(result) ? result : null;
    lastDbStatus = result ? { ...result, statusKey: chatKey } : null;

    // A periodic refresh may supersede a resume check. Keep its button usable.
    if (result && !isAnyOperationActive() && !progressTracker.isPaused) {
        updateContinueVectorizationButton(
            result.pending > 0 ? 'backlog' : 'available', result.pending, result.total);
    }
    // Saved snapshots never mutate active or paused run counters.
    if (!isAnyOperationActive() && !progressTracker.isPaused && progressTracker.isDatabaseSnapshot) {
        progressTracker.setDatabaseStatus(
            settings.chunking_strategy === 'per_scene' ? null : result,
            unavailableVectorizationStatus(), currentStatusTargetLabel());
    }
    refreshVectorizationStatusDisplay();
}

function scheduleSavedDatabaseRefresh() {
    clearTimeout(dbRefreshTimer);
    dbRefreshTimer = setTimeout(() => { void refreshSavedDatabaseStatus(); }, 350);
}

// R10: light interval keeps the status line live during runs without the core
// needing UI hooks. Only active while a run is in flight (cheap no-op otherwise).
setInterval(() => {
    if (isAnyOperationActive()) {
        refreshVectorizationStatusDisplay();
    }
}, 3000);

async function offerResumeOfUnfinishedVectorization() {
    const requestId = ++resumeCheckId;
    const chatKey = currentStatusChatKey();
    if (!chatKey) return;
    const statusReadId = ++dbStatusRequestId;
    activeResumeStatusReadId = statusReadId;
    const isCurrent = () => requestId === resumeCheckId &&
        statusReadId === dbStatusRequestId && chatKey === currentStatusChatKey();
    try {
        // VectHare+ FIX (notification behavior): a run already in flight IS the
        // resume — don't nag while it works. BUT we must not bail permanently:
        // this can fire while a run is aborting (e.g. user switched chats mid-run,
        // CHAT_CHANGED beats the "chat changed" cleanup), and a bare return would
        // strand the NEW chat's backlog unchecked. So wait (bounded, up to 10 min)
        // for the active run to finish, then proceed with the normal check.
        if (isVectorizationActive()) {
            console.debug('VectHare: Resume check waiting for active vectorization run to finish...');
            let waitedMs = 0;
            while (isVectorizationActive() && waitedMs < 600000) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                if (!isCurrent()) return;
                waitedMs += 2000;
            }
            if (isVectorizationActive()) {
                console.debug('VectHare: Resume check gave up waiting (run exceeded 10 min wait window)');
                return;
            }
        }

        for (let attempt = 1; attempt <= RESUME_CHECK_MAX_ATTEMPTS; attempt++) {
            if (!isCurrent()) return;
            let result = null;
            try {
                result = await checkUnfinishedVectorization(settings);
            } catch (error) {
                console.warn('VectHare: Resume-on-load check failed:', error.message);
            }
            if (!isCurrent()) return;

            if (isValidSavedStatus(result)) {
                // Definitive answer — reflect it in the UI (Repair Chunks button +
                // R10 status line) and stop polling.
                // R23: 'available' instead of hiding on no-backlog - the button is a
                // working tool (repair is a safe no-op when clean), and the old
                // hide-on-clean made it flicker away based on racy async timing.
                updateContinueVectorizationButton(
                    result.pending > 0 ? 'backlog' : 'available',
                    result.pending,
                    result.total
                );
                lastDbStatus = { ...result, statusKey: chatKey };
                refreshVectorizationStatusDisplay();
                if (!isAnyOperationActive() && !progressTracker.isPaused && progressTracker.isDatabaseSnapshot) {
                    progressTracker.setDatabaseStatus(
                        settings.chunking_strategy === 'per_scene' ? null : result,
                        unavailableVectorizationStatus(), currentStatusTargetLabel());
                }
                // R9: if the user just pressed Stop, they KNOW it's unfinished - don't
                // immediately nag with the toast. Button still updates (persistent
                // affordance). Flag is consume-on-read so later natural checks toast.
                const justStoppedByUser = consumeWasLastRunStoppedByUser();
                if (result.pending > 0 && !isAnyOperationActive() && !justStoppedByUser) {
                    vhLog(`VectHare: Unfinished vectorization detected (${result.pending}/${result.total} pending)`);
                    showResumeToast(result.pending, result.total);
                }
                return;
            }

            // Collection not discovered yet — wait for discovery and retry
            if (attempt < RESUME_CHECK_MAX_ATTEMPTS) {
                await new Promise(resolve => setTimeout(resolve, RESUME_CHECK_RETRY_MS));
                if (!isCurrent()) return;
            }
        }
        if (!isCurrent()) return;

        // Inconclusive: the check couldn't determine state (discovery/init still
        // warming up, or chat truly has no collection).
        // R23 FIX: previously "leave the button in whatever state it was" - which,
        // combined with hide-on-clean calls elsewhere, is exactly how the user saw
        // the Repair Chunks button vanish after actions and reappear after reload.
        // Now: inconclusive state is resolved by REGISTRY TRUTH instead of timing.
        // - Collection known to the registry -> button shows as 'available'
        //   (repair is a safe no-op when clean; better a present harmless button
        //   than a racy vanishing one)
        // - Collection unknown -> genuinely no collection -> hidden (correct)
        // R11 status-line refresh retained.
        try {
            const collectionId = getChatCollectionId();
            const known = collectionId && getCollectionRegistry().some(
                key => parseRegistryKey(key).collectionId === collectionId
            );
            updateContinueVectorizationButton(known ? 'available' : 'hide');
        } catch (e) {
            console.warn('VectHare: R23 inconclusive-state button resolution failed:', e.message);
        }
        lastDbStatus = null;
        refreshVectorizationStatusDisplay();
        if (!isAnyOperationActive() && !progressTracker.isPaused && progressTracker.isDatabaseSnapshot) {
            progressTracker.setDatabaseStatus(null, unavailableVectorizationStatus(), currentStatusTargetLabel());
        }
        console.debug('VectHare: Resume check inconclusive after retries; saved status unavailable');
    } finally {
        if (activeResumeStatusReadId === statusReadId) activeResumeStatusReadId = 0;
    }
}

/**
 * Action: Full purge - removes VectHare-owned collections and resets VectHare settings.
 */
async function onPurgeClick() {
    // Two choices, both of which delete VectHare's own vectors and metadata;
    // only one of them also resets VectHare's settings.
    const choice = await openPurgeOptionsDialog();
    if (!choice) {
        toastr.info('Purge cancelled');
        return;
    }

    // S6: progress in the Status panel when no other run owns it.
    const purgeRun = progressTracker.beginCounted('Purging VectHare', 0, 'Collections');
    try {
        // Delete only VectHare-owned collections, never ST's shared folder.
        const result = await purgeAllVectorIndexes(settings, {
            onProgress: ({ done, total, id }) =>
                progressTracker.countedStep(purgeRun, 'Purging collections', done, total, id != null),
            onIssue: text => { if (purgeRun != null) progressTracker.addError(`Kept: ${text}`); },
        });
        if (!result.success) {
            throw new Error(`Some collections could not be safely purged (${result.skipped.length} unverified/failed). ` +
                'Nothing was removed from VectHare\'s metadata or settings, so this can be retried.');
        }

        // Only now, with the purge confirmed complete, clear VectHare's own
        // metadata document: registry, collection records, chunk annotations,
        // chat bindings and policies. Without this a purge left ghost rows.
        if (purgeRun != null && progressTracker.isCurrentRun(purgeRun)) {
            progressTracker.setPhase('Clearing VectHare metadata…');
        }
        const reset = await resetVectHareStore();
        if (!reset.success) {
            throw new Error(`Vectors were purged, but VectHare's metadata could not be cleared: ${reset.reason}`);
        }

        // Obsolete pre-migration keys must go too, or the startup migration
        // rebuilds collection records from them.
        const legacy = forgetAllLegacyCollectionKeys();

        if (choice === 'all') {
            // Reset VectHare's own settings namespace, keeping only whether the
            // extension is enabled. Nothing outside extension_settings.vecthare
            // is touched.
            for (const key in extension_settings.vecthare) {
                if (key !== 'enabled') delete extension_settings.vecthare[key];
            }
        }

        const { saveSettingsDebounced } = await import('../../../../script.js');
        saveSettingsDebounced();

        const detail = [
            `${result.removed} collection(s) purged`,
            reset.verified ? 'metadata cleared and verified empty' : `metadata cleared (${reset.reason})`,
            legacy.length ? `${legacy.length} obsolete key(s) removed` : '',
            choice === 'all' ? 'settings reset to defaults' : 'settings kept',
        ].filter(Boolean).join(' · ');
        if (purgeRun != null) progressTracker.complete(true, detail, purgeRun);
        toastr.success(detail, 'Purge Complete', { timeOut: 12000 });

    } catch (error) {
        if (purgeRun != null) {
            progressTracker.addError(error.message);
            progressTracker.complete(false, 'Purge did not finish - nothing was reset', purgeRun);
        }
        console.error('VectHare: Purge failed:', error);
        toastr.error('Purge failed: ' + error.message, 'VectHare',
            { timeOut: 0, extendedTimeOut: 0 });
    }
}

/**
 * Action: Run diagnostics - opens the diagnostics modal
 */
function onRunDiagnosticsClick() {
    openDiagnosticsModal();
}

/**
 * Initialize VectHare extension
 */
// Phase 1: a debounced metadata write must not be lost when the tab closes.
// Best effort only - the store is also flushed after runs and before commits.
window.addEventListener('beforeunload', () => { void flushVectHareStore(); });
// A request started while the page is merely hidden (tab switch, app switch,
// closing on mobile) is far more likely to complete than one at unload.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushVectHareStore().catch(() => {});
    // 8B: back in a tab that sat in the background - pick up other tabs' changes.
    else void refreshStoreIfStale({ minIntervalMs: 0 }).catch(() => {});
});

jQuery(async () => {
    vhLog('VectHare: Initializing...');

    // Load saved settings
    if (!extension_settings.vecthare) {
        extension_settings.vecthare = defaultSettings;
    }

    // Phase 1: VectHare's own collection state (registry, collection metadata,
    // chat bindings, chunk annotations) lives in its own per-user file. Load or
    // migrate it BEFORE anything reads collection metadata, and report rather
    // than silently continuing on an empty store.
    const storeState = await loadVectHareStore();
    if (storeState.status !== 'ready') {
        console.error(`VectHare: Collection metadata storage is unavailable - ${storeState.detail}`);
        toastr.error(`VectHare could not load its collection metadata: ${storeState.detail}. ` +
            'Operations that change collections are blocked until this is resolved.',
            'VectHare', { timeOut: 0, extendedTimeOut: 0 });
        // VH-062: a damaged or missing file can be started fresh (confirmed).
        if (storeState.canStartFresh) void offerFreshVectHareStore(storeState.detail);
    }

    // N2: collections of chats deleted more than DELETED_CHAT_KEEP_DAYS ago are
    // purged through the verified path. Delayed so the plugin and backends are
    // reachable; anything uncertain is kept and retried at the next startup.
    if (storeState.status === 'ready') {
        setTimeout(() => {
            void purgeDeletedChats(settings, {
                onlyExpired: true,
                isBusy: () => isChatSynchronizationActive() || isVectorizationActive(),
            }).then(results => {
                const purged = results.filter(r => r.success).length;
                const keptCount = results.length - purged;
                if (results.length) vhLog(`VectHare: Deleted-chat cleanup: ${purged} purged, ${keptCount} kept`, results);
            }).catch(error => console.warn('VectHare: Deleted-chat cleanup skipped:', error.message));
        }, 30000);
    }

    // Merge saved settings with defaults
    settings = {
        ...defaultSettings,
        ...extension_settings.vecthare,
        temporal_decay: {
            ...defaultSettings.temporal_decay,
            ...extension_settings.vecthare.temporal_decay
        },
        collections: {
            ...defaultSettings.collections,
            ...vecthareState().collections
        }
    };

    // VH-074: changes Cotton-Tales makes through the classifier API reach this object.
    registerClassifierSettingsMirror(settings);

    // Migrate old scattered enabled keys to new collections structure
    const migrationResult = migrateOldEnabledKeys();
    if (migrationResult.migrated > 0) {
        vhLog(`VectHare: Migrated ${migrationResult.migrated} old collection enabled keys`);
    }

    // U1: move Qdrant/Milvus credentials out of settings.json into the plugin's
    // key store. Per key: store -> confirm -> blank; on any failure the key stays
    // where it was. Done before the UI renders so the fields show the right state.
    try {
        await migrateSecretsFromSettings(settings);
    } catch (error) {
        console.warn('VectHare: Credential migration skipped:', error.message);
    }

    // Render UI
    renderSettings('extensions_settings2', settings, {
        onVectorizeAll: onVectorizeAllClick,
        onVectorizeContent: () => { void onVectorizeContentClick(); },
        // Called after a committed rebuild: the cached status refers to a
        // collection the chat is no longer bound to.
        onCollectionsChanged: () => {
            invalidateSavedVectorizationStatus();
            void offerResumeOfUnfinishedVectorization();
        },
        // R12: Repair Chunks is now a DISTINCT operation - repairs existing
        // vectors only, never continues the backlog (use Sync Chat for that)
        onContinueVectorization: onRepairClick,
        onVectorizationStatusClick: () => {
            progressTracker.openStatus();
            // Always re-read the actual DB on click (also works before first run).
            if (!isVectorizationActive()) void refreshSavedDatabaseStatus();
        },
        onPurge: onPurgeClick,
        onRunDiagnostics: onRunDiagnosticsClick
    });

    // Delegation runs after the controls' own settings update handlers.
    const savedStatusSettingsSelector = [
        '#vecthare_chunking_strategy', '#vecthare_turn_order',
        '#vecthare_batch_size', '#vecthare_chunk_size',
        '#vecthare_vector_backend', '#vecthare_source',
        '#vecthare_qdrant_use_cloud', '#vecthare_qdrant_host',
        '#vecthare_qdrant_port', '#vecthare_qdrant_url',
        '#vecthare_qdrant_api_key', '#vecthare_qdrant_multitenancy', '#vecthare_milvus_multitenancy'
    ].join(', ');
    jQuery(document).off('.vecthareSavedStatus').on(
        'input.vecthareSavedStatus change.vecthareSavedStatus',
        savedStatusSettingsSelector, invalidateSavedVectorizationStatus);

    // Fresh check on page load; no health cache is trusted for the indicator.
    void checkBackendHealth(settings);
    // Plugin / extension compatibility: one warning on load if they do not match
    // (shown in full in the health panel). A missing plugin is not warned here:
    // Standard works without it and the other backends already say so.
    void checkPluginCompatibility().then(result => {
        if (result.state === 'plugin-older' || result.state === 'extension-older') {
            toastr.warning(result.message, 'VectHare: plugin and extension do not match', { timeOut: 15000 });
        }
    }).catch(() => {});

    // 9b: record where this backend's existing collections are (read-only
    // probes, a pointer per collection), so later toggles of the multitenancy
    // switch keep them where they are. Delayed and in the background; nothing
    // is recorded for a collection found in no place or in more than one.
    if (storeState.status === 'ready' && ['qdrant', 'milvus'].includes(settings.vector_backend)) {
        setTimeout(async () => {
            try {
                await getBackendForLocators(settings);
                const result = await fillStorageLocators(settings);
                if (result.checked) vhLog(`VectHare: Storage locations: ${result.recorded} recorded, ${result.checked} checked`, result);
                if (result.conflicts.length) {
                    console.warn(`VectHare: ${result.conflicts.length} collection(s) have saved settings in more than one place; writes to them are blocked`, result.conflicts);
                }
            } catch (error) {
                console.warn('VectHare: Recording storage locations skipped:', error.message);
            }
        }, 20000);
    }

    progressTracker.setStartCallback(onVectorizeAllClick);
    // 8B: another tab changed VectHare's metadata; cached status may be stale.
    window.addEventListener('vecthare:store-reloaded', () => invalidateSavedVectorizationStatus());
    window.addEventListener('vecthare:database-changed', event => {
        const collectionId = event.detail?.collectionId;
        if (!collectionId || collectionId === getChatCollectionId()) scheduleSavedDatabaseRefresh();
    });
    // Catch changes made outside VectHare while the Status window is open.
    setInterval(() => {
        if (progressTracker.isVisible && !isVectorizationActive()) void refreshSavedDatabaseStatus();
    }, 10000);

    // Initialize auto-sync checkbox state for current chat (if any)
    refreshAutoSyncCheckbox(settings);

    // Initialize visualizer
    initializeVisualizer();

    // Initialize database browser
    initializeDatabaseBrowser(settings);

    // Initialize scene markers on chat messages (settings needed for DB operations)
    setSceneSettings(settings);
    initializeSceneMarkers();

    // Initialize world info integration hooks
    initializeWorldInfoIntegration();

    // VEC-34: Discover existing collections with retry mechanism
    // Uses exponential backoff to handle temporary backend unavailability
    (async () => {
        try {
            const collections = await AsyncUtils.retry(
                () => discoverExistingCollections(settings),
                {
                    maxAttempts: 3,
                    delay: 2000,
                    maxDelay: 10000,
                    backoffFactor: 2,
                    onRetry: (attempt, error) => {
                        console.warn(`VectHare: Collection discovery attempt ${attempt} failed: ${error.message}. Retrying...`);
                    }
                }
            );
            if (collections.length > 0) {
                vhLog(`VectHare: Discovered ${collections.length} existing collections`);
            }
        } catch (err) {
            console.error('VectHare: Collection discovery failed after retries:', err.message);
            toastr.warning(
                'Could not discover existing collections. Open Database Browser to refresh manually.',
                'VectHare: Collection Discovery Failed',
                { timeOut: 10000 }
            );
        }
    })();

    // Register event handlers
    // VectHare+ R10: edits, deletes, and swipes flag cleanup before the next sync.
    const onChatMutationEvent = (...args) => {
        flagImmediateReverseSync();
        return onChatEvent(...args);
    };
    eventSource.on(event_types.MESSAGE_DELETED, onChatMutationEvent);
    eventSource.on(event_types.MESSAGE_EDITED, onChatMutationEvent);
    eventSource.on(event_types.MESSAGE_SWIPED, onChatMutationEvent);
    // Run vector sync tasks on message events
    // Note: Semantic WI injection happens in the generate_interceptor (rearrangeChat), not here
    eventSource.on(event_types.MESSAGE_SENT, onChatEvent);
    eventSource.on(event_types.MESSAGE_RECEIVED, onChatEvent);
    // SillyTavern supplies a filename, not an owner. Inspect all candidates:
    // same-named chats belonging to other owners must never be purged.
    const onChatDeleted = async (filename, type) => {
        const candidates = deletionCandidates(filename, type);
        const absent = [];
        for (const candidate of candidates) {
            const exists = await chatFileExists(candidate[1].owner, candidate[1].chat);
            if (exists === null) {
                console.warn('VectHare: Cannot verify deleted chat owner; preserving vectors', filename);
                return;
            }
            if (exists === false) absent.push(candidate);
        }
        if (absent.length !== 1) {
            console.warn('VectHare: Deleted chat ownership ambiguous; preserving vectors', filename);
            return;
        }
        const [id, rec] = absent[0];
        if (isChatSynchronizationActive() || isVectorizationActive() || !tryBeginChatCollectionDelete(id)) {
            console.warn('VectHare: Collection busy; deletion skipped', id);
            return;
        }
        try {
        // Legacy collections may contain memories from other historical chats.
        if (rec.origin !== 'created') {
            releaseToQuarantine(id);
            vhLog('VectHare: Legacy collection preserved unassigned', id);
            return;
        }
        // Inspect every character/group chat file, including unopened copies.
        if (await anotherChatClaimsCollection(rec, id) !== false) {
            console.warn('VectHare: Competing claim or incomplete scan; deletion skipped', id);
            return;
        }
        // N2: no immediate purge. The binding is released (the collection is no
        // longer used by RAG) and kept for DELETED_CHAT_KEEP_DAYS, so a chat
        // deleted by mistake or re-imported can get its memories back. The
        // verified purge runs from "Empty deleted" or after the keep period.
        await softDeleteChatCollection(id, rec, filename);
        vhLog(`VectHare: Chat deleted; its collection is kept for ${DELETED_CHAT_KEEP_DAYS} days`, id);
        } finally {
            endChatCollectionDelete(id);
        }
    };
    eventSource.on(event_types.CHAT_DELETED, filename => {
        void onChatDeleted(filename, 'character').catch(error =>
            console.error('VectHare: Chat deletion cleanup failed; preserved remaining records', error));
    });
    eventSource.on(event_types.GROUP_CHAT_DELETED, filename => {
        void onChatDeleted(filename, 'group').catch(error =>
            console.error('VectHare: Group chat deletion cleanup failed; preserved remaining records', error));
    });
    // Events update the VectHare-owned registry. Historical chat-file claims
    // remain read-only; no new claims are written to SillyTavern chats.
    eventSource.on(event_types.CHAT_RENAMED, payload => {
        onChatBindingRenamed(payload);
        try { renameChatPolicy(payload); } catch (error) { console.warn('VectHare: chat policy rename failed', error); }
        try { renameChatLocks(payload); } catch (error) { console.warn('VectHare: chat lock rename failed', error); }
        invalidateSavedVectorizationStatus();
        void ensureChatBinding(undefined, { create: false }).then(result => {
            if (result.state === 'active') {
                refreshAutoSyncCheckbox(settings);
                scheduleSavedDatabaseRefresh();
            }
        }).catch(error => console.warn('VectHare: Rename binding could not be reconciled', error));
    });
    eventSource.on(event_types.CHARACTER_RENAMED, (oldAvatar, newAvatar) => {
        onCharacterBindingRenamed(oldAvatar, newAvatar);
        try { renameCharacterPolicies(oldAvatar, newAvatar); } catch (error) { console.warn('VectHare: chat policy rename failed', error); }
        try { renameCharacterLocks(oldAvatar, newAvatar); } catch (error) { console.warn('VectHare: character lock rename failed', error); }
    });

    // When WebLLM extension is loaded, refresh the model list
    eventSource.on(event_types.EXTENSION_SETTINGS_LOADED, async (manifest) => {
        if (settings.source === 'webllm' && manifest?.display_name === 'WebLLM') {
            vhLog('VectHare: WebLLM extension loaded, refreshing models...');
            updateWebLlmStatus();
            await loadWebLlmModels(settings);
        }
    });

    // When chat changes, refresh UI state to match settings
    eventSource.on(event_types.CHAT_CHANGED, () => {
        // #7: make any chat switch detectable to in-flight operations, even
        // when the host reuses the same chat array (A -> B -> A).
        noteChatSwitch();
        // Invalidate all cached status and outstanding reads for the prior chat.
        invalidateSavedVectorizationStatus();
        // Safe, idempotent, one-time identity discovery. Never enable writes
        // for ambiguous legacy collections.
        void ensureChatBinding(undefined, { create: false }).then(result => {
            if (result.state === 'active') { refreshAutoSyncCheckbox(settings); scheduleSavedDatabaseRefresh(); }
        }).catch(error => console.warn('VectHare: Chat binding not resolved', error));
        vhLog('VectHare: Chat changed, refreshing UI state');
        refreshAutoSyncCheckbox(settings);
        scheduleSavedDatabaseRefresh();
        // VectHare+: check for interrupted vectorization on the loaded chat
        offerResumeOfUnfinishedVectorization();
    });

    // Also resolve the currently open chat if CHAT_CHANGED fired before load.
    void ensureChatBinding(undefined, { create: false }).then(result => {
        if (result.state === 'active') { refreshAutoSyncCheckbox(settings); scheduleSavedDatabaseRefresh(); }
    }).catch(error => console.warn('VectHare: Initial chat binding not resolved', error));

    // VectHare+: one-time resume check at startup (page reload / ST reopen)
    setTimeout(offerResumeOfUnfinishedVectorization, 5000);
    setTimeout(scheduleSavedDatabaseRefresh, 5000);

    vhLog('VectHare: ✅ Initialized successfully');
});
