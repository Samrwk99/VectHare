/**
 * ============================================================================
 * VECTHARE - ADVANCED RAG SYSTEM
 * ============================================================================
 * Entry point - lean and clean
 * All logic is in separate modules - see project guidelines
 *
 * @author Coneja Chibi
 * @version 2.2.0-alpha
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
import { synchronizeChat, rearrangeChat, vectorizeAll, repairChatVectors, checkUnfinishedVectorization, isVectorizationActive, isChatSynchronizationActive, consumeWasLastRunStoppedByUser, flagImmediateReverseSync, parseRegistryKey } from './core/chat-vectorization.js';
import {
    ensureChatBinding, chatFileExists, deletionCandidates, anotherChatClaimsCollection,
    removeChatBinding, releaseToQuarantine, onChatBindingRenamed, onCharacterBindingRenamed,
    isChatCollectionWriteActive, tryBeginChatCollectionDelete, endChatCollectionDelete, chatStoreDestination,
    getChatOwner, normChat,
} from './core/collection-ids.js';
import { purgeAllVectorIndexes, purgeVectorIndex } from './core/core-vector-api.js';
import { getChatCollectionId } from './core/chat-vectorization.js';
import { getDefaultDecaySettings } from './core/temporal-decay.js';
import { migrateOldEnabledKeys, deleteCollectionMeta } from './core/collection-metadata.js';
import { clearCollectionRegistry, discoverExistingCollections, getCollectionRegistry, unregisterCollection } from './core/collection-loader.js';
import AsyncUtils from './utils/async-utils.js';

// VectHare modules - UI
import { renderSettings, openDiagnosticsModal, loadWebLlmModels, updateWebLlmStatus, refreshAutoSyncCheckbox, updateContinueVectorizationButton, updateVectorizationStatus } from './ui/ui-manager.js';
import { progressTracker } from './ui/progress-tracker.js';
import { initializeVisualizer } from './ui/chunk-visualizer.js';
import { initializeDatabaseBrowser } from './ui/database-browser.js';
import { checkBackendHealth } from './ui/health-dashboard.js';
import { initializeSceneMarkers, updateAllMarkerStates, setSceneSettings } from './ui/scene-markers.js';
import { initializeWorldInfoIntegration } from './core/world-info-integration.js';

// VectHare modules - Cotton-Tales Integration
import './core/emotion-classifier.js'; // Exposes window.VectHareEmotionClassifier

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

    // Collection registry (list of known collection IDs)
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
const getBatchSize = () => ['transformers', 'ollama'].includes(settings.source) ? 1 : 5;

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
    } finally {
        invalidateSavedVectorizationStatus();
        void offerResumeOfUnfinishedVectorization(); // refresh status line + button
    }
}

/**
 * Action: Vectorize all messages in current chat (full sync: repair + backlog)
 */
async function onVectorizeAllClick() {
    invalidateSavedVectorizationStatus();
    try {
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
    // R7/R10: informational only - points at the (renamed) Repair Chunks button
    toastr.info(
        `${pending} of ${total} message groups not yet vectorized. Use the "Repair Chunks" button in VectHare's Actions panel to resume/repair from where it stopped.`,
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
    if (!isVectorizationActive() && !progressTracker.isPaused && progressTracker.isDatabaseSnapshot) {
        progressTracker.setDatabaseStatus(null, unavailableVectorizationStatus());
    }
    refreshVectorizationStatusDisplay();
}

function isValidSavedStatus(result) {
    return result != null &&
        Number.isSafeInteger(result.total) && Number.isSafeInteger(result.pending) &&
        result.total >= 0 && result.pending >= 0 && result.pending <= result.total;
}

function refreshVectorizationStatusDisplay() {
    if (isVectorizationActive() || progressTracker.isPaused) {
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
async function refreshSavedDatabaseStatus() {
    const chatKey = currentStatusChatKey();
    if (!chatKey) {
        lastDbStatus = null;
        if (!isVectorizationActive() && !progressTracker.isPaused && progressTracker.isDatabaseSnapshot) {
            progressTracker.setDatabaseStatus(null, unavailableVectorizationStatus());
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
        collectionId !== getChatCollectionId()) return;
    result = isValidSavedStatus(result) ? result : null;
    lastDbStatus = result ? { ...result, statusKey: chatKey } : null;

    // A periodic refresh may supersede a resume check. Keep its button usable.
    if (result && !isVectorizationActive() && !progressTracker.isPaused) {
        updateContinueVectorizationButton(
            result.pending > 0 ? 'backlog' : 'available', result.pending, result.total);
    }
    // Saved snapshots never mutate active or paused run counters.
    if (!isVectorizationActive() && !progressTracker.isPaused && progressTracker.isDatabaseSnapshot) {
        progressTracker.setDatabaseStatus(
            settings.chunking_strategy === 'per_scene' ? null : result,
            unavailableVectorizationStatus());
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
    if (isVectorizationActive()) {
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
                if (!isVectorizationActive() && !progressTracker.isPaused && progressTracker.isDatabaseSnapshot) {
                    progressTracker.setDatabaseStatus(
                        settings.chunking_strategy === 'per_scene' ? null : result,
                        unavailableVectorizationStatus());
                }
                // R9: if the user just pressed Stop, they KNOW it's unfinished - don't
                // immediately nag with the toast. Button still updates (persistent
                // affordance). Flag is consume-on-read so later natural checks toast.
                const justStoppedByUser = consumeWasLastRunStoppedByUser();
                if (result.pending > 0 && !isVectorizationActive() && !justStoppedByUser) {
                    console.log(`VectHare: Unfinished vectorization detected (${result.pending}/${result.total} pending)`);
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
        if (!isVectorizationActive() && !progressTracker.isPaused && progressTracker.isDatabaseSnapshot) {
            progressTracker.setDatabaseStatus(null, unavailableVectorizationStatus());
        }
        console.debug('VectHare: Resume check inconclusive after retries; saved status unavailable');
    } finally {
        if (activeResumeStatusReadId === statusReadId) activeResumeStatusReadId = 0;
    }
}

/**
 * Action: Full purge - wipes ALL vector data and settings
 */
async function onPurgeClick() {
    const confirmed = confirm(
        'WARNING: This will delete ALL vector data and reset VectHare settings.\n\n' +
        'This cannot be undone. Continue?'
    );

    if (!confirmed) {
        toastr.info('Purge cancelled');
        return;
    }

    try {
        const { getRequestHeaders } = await import('../../../../script.js');

        // 1. Delete entire vectors folder
        await fetch('/api/plugins/similharity/purge-all', {
            method: 'POST',
            headers: getRequestHeaders(),
        });

        // 2. Clear extension_settings.vecthare
        for (const key in extension_settings.vecthare) {
            if (key !== 'enabled') {
                delete extension_settings.vecthare[key];
            }
        }

        // 3. Save settings
        const { saveSettingsDebounced } = await import('../../../../script.js');
        saveSettingsDebounced();

        toastr.success('All vector data purged', 'Purge Complete');

    } catch (error) {
        console.error('VectHare: Purge failed:', error);
        toastr.error('Purge failed: ' + error.message);
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
jQuery(async () => {
    console.log('VectHare: Initializing...');

    // Load saved settings
    if (!extension_settings.vecthare) {
        extension_settings.vecthare = defaultSettings;
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
            ...extension_settings.vecthare.collections
        }
    };

    // Migrate old scattered enabled keys to new collections structure
    const migrationResult = migrateOldEnabledKeys();
    if (migrationResult.migrated > 0) {
        console.log(`VectHare: Migrated ${migrationResult.migrated} old collection enabled keys`);
    }

    // Render UI
    renderSettings('extensions_settings2', settings, {
        onVectorizeAll: onVectorizeAllClick,
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
        '#vecthare_qdrant_api_key', '#vecthare_qdrant_multitenancy'
    ].join(', ');
    jQuery(document).off('.vecthareSavedStatus').on(
        'input.vecthareSavedStatus change.vecthareSavedStatus',
        savedStatusSettingsSelector, invalidateSavedVectorizationStatus);

    // Fresh check on page load; no health cache is trusted for the indicator.
    void checkBackendHealth(settings);

    progressTracker.setStartCallback(onVectorizeAllClick);
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
                console.log(`VectHare: Discovered ${collections.length} existing collections`);
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
            console.log('VectHare: Legacy collection preserved unassigned', id);
            return;
        }
        // Inspect every character/group chat file, including unopened copies.
        if (await anotherChatClaimsCollection(rec, id) !== false) {
            console.warn('VectHare: Competing claim or incomplete scan; deletion skipped', id);
            return;
        }
        const keys = getCollectionRegistry().filter(key => parseRegistryKey(key).collectionId === id);
        if (!rec.stores?.length && keys.length) {
            console.warn('VectHare: Collection has unknown backend; deletion skipped', id);
            return;
        }
        for (const store of [...(rec.stores || [])]) {
            // Do not purge a different Qdrant endpoint or tenant after settings
            // changes. Multitenancy purge has its own unresolved safety issue.
            const destination = chatStoreDestination({ ...settings, vector_backend: store.backend });
            if (!store.destination || destination !== store.destination ||
                (store.backend === 'qdrant' && settings.qdrant_multitenancy)) {
                console.warn('VectHare: Backend destination unverified; deletion skipped', id);
                return;
            }
            const backendSettings = { ...settings, vector_backend: store.backend, source: store.source };
            if (!await purgeVectorIndex(id, backendSettings)) {
                console.warn('VectHare: Backend did not confirm purge; binding retained', id);
                return;
            }
            // Persist partial success, so a retry does not need to revisit a
            // store already deleted. Registry/metadata remain until all finish.
            rec.stores = rec.stores.filter(item => item !== store);
            saveSettingsDebounced();
        }
        for (const key of keys) unregisterCollection(key);
        deleteCollectionMeta(id);
        removeChatBinding(id);
        console.log('VectHare: Deleted verified exclusive chat collection', id);
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
    // Events are fast-path registry updates; the claim in the chat file is the
    // recovery mechanism when an event is missed while the plugin was offline.
    eventSource.on(event_types.CHAT_RENAMED, payload => {
        onChatBindingRenamed(payload);
        invalidateSavedVectorizationStatus();
        void ensureChatBinding(undefined, { create: false }).then(result => {
            if (result.state === 'active') {
                refreshAutoSyncCheckbox(settings);
                scheduleSavedDatabaseRefresh();
            }
        }).catch(error => console.warn('VectHare: Rename binding could not be reconciled', error));
    });
    eventSource.on(event_types.CHARACTER_RENAMED,
        (oldAvatar, newAvatar) => onCharacterBindingRenamed(oldAvatar, newAvatar));

    // When WebLLM extension is loaded, refresh the model list
    eventSource.on(event_types.EXTENSION_SETTINGS_LOADED, async (manifest) => {
        if (settings.source === 'webllm' && manifest?.display_name === 'WebLLM') {
            console.log('VectHare: WebLLM extension loaded, refreshing models...');
            updateWebLlmStatus();
            await loadWebLlmModels(settings);
        }
    });

    // When chat changes, refresh UI state to match settings
    eventSource.on(event_types.CHAT_CHANGED, () => {
        // Invalidate all cached status and outstanding reads for the prior chat.
        invalidateSavedVectorizationStatus();
        // Safe, idempotent, one-time identity discovery. Never enable writes
        // for ambiguous legacy collections.
        void ensureChatBinding(undefined, { create: false }).then(result => {
            if (result.state === 'active') { refreshAutoSyncCheckbox(settings); scheduleSavedDatabaseRefresh(); }
        }).catch(error => console.warn('VectHare: Chat binding not resolved', error));
        console.log('VectHare: Chat changed, refreshing UI state');
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

    console.log('VectHare: ✅ Initialized successfully');
});
