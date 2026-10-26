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
} from '../../../../script.js';
import {
    ModuleWorkerWrapper,
    extension_settings,
} from '../../../extensions.js';
import { debounce } from '../../../utils.js';
import { debounce_timeout } from '../../../constants.js';

// VectHare modules - Core
import { synchronizeChat, rearrangeChat, vectorizeAll, repairChatVectors, checkUnfinishedVectorization, isVectorizationActive, consumeWasLastRunStoppedByUser, flagImmediateReverseSync, parseRegistryKey } from './core/chat-vectorization.js';
import { purgeAllVectorIndexes, purgeVectorIndex } from './core/core-vector-api.js';
import { getChatCollectionId } from './core/chat-vectorization.js';
import { getDefaultDecaySettings } from './core/temporal-decay.js';
import { migrateOldEnabledKeys } from './core/collection-metadata.js';
import { clearCollectionRegistry, discoverExistingCollections, getCollectionRegistry } from './core/collection-loader.js';
import AsyncUtils from './utils/async-utils.js';
import { purgeAllAndResetSettings } from './core/destructive-safety.js';

// VectHare modules - UI
import { renderSettings, openDiagnosticsModal, loadWebLlmModels, updateWebLlmStatus, refreshAutoSyncCheckbox, updateContinueVectorizationButton, updateVectorizationStatus } from './ui/ui-manager.js';
import { progressTracker } from './ui/progress-tracker.js';
import { initializeVisualizer } from './ui/chunk-visualizer.js';
import { initializeDatabaseBrowser } from './ui/database-browser.js';
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
    await repairChatVectors(settings, getBatchSize());
    offerResumeOfUnfinishedVectorization(); // refresh status line + button
}

/**
 * Action: Vectorize all messages in current chat (full sync: repair + backlog)
 */
async function onVectorizeAllClick() {
    await vectorizeAll(settings, getBatchSize());
    // VectHare+ FIX: after a run ends (especially Stop / partial / failure),
    // re-run the backlog check so the Continue button + toast reflect the
    // CURRENT chat's state. Previously the check only fired on CHAT_CHANGED,
    // so stopping mid-run and staying in the same chat left no resume
    // affordance at all until the user switched chats or reloaded.
    offerResumeOfUnfinishedVectorization();
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
let dbRefreshTimer = null;

function refreshVectorizationStatusDisplay(result = null) {
    if (result) lastDbStatus = { ...result, collectionId: getChatCollectionId() };
    if (isVectorizationActive()) {
        // Live progress from the tracker while a run is in flight
        const s = progressTracker.stats;
        const db = lastDbStatus?.collectionId === getChatCollectionId() ? lastDbStatus : null;
        const done = db ? (db.total - db.pending) : (s.totalChunksToEmbed > 0 ? s.embeddedChunks : s.processedItems);
        const total = db ? db.total : (s.totalChunksToEmbed > 0 ? s.totalChunksToEmbed : s.totalItems);
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        updateVectorizationStatus(`Running — ${pct}% (${done}/${total}) — click to view`);
        return;
    }
    if (!result && lastDbStatus?.collectionId === getChatCollectionId()) result = lastDbStatus;
    if (result && typeof result.total === 'number' && result.total > 0) {
        if (result.hasBacklog) {
            const doneCount = result.total - result.pending;
            const pct = Math.round((doneCount / result.total) * 100);
            updateVectorizationStatus(`Vectorized: ${pct}% (${doneCount}/${result.total}) — click for details`);
        } else {
            updateVectorizationStatus(`Fully vectorized (${result.total}/${result.total}) ✓`);
        }
        return;
    }
    updateVectorizationStatus('Status: no saved vector data for this chat');
}

// Read the actual saved hashes, coalescing rapid writes into one DB query.
// Runs after each committed insert/delete/purge and whenever Status opens.
async function refreshSavedDatabaseStatus() {
    const requestId = ++dbStatusRequestId;
    const collectionId = getChatCollectionId();
    let result = null;
    try {
        result = await checkUnfinishedVectorization(settings);
    } catch (error) {
        console.warn('VectHare: Status refresh failed:', error);
    }
    // Ignore replies from a previous chat or a superseded DB read.
    if (requestId !== dbStatusRequestId || collectionId !== getChatCollectionId()) return;
    lastDbStatus = result ? { ...result, collectionId } : null;

    if (isVectorizationActive() && result && progressTracker.currentOperation === 'Vectorizing Chat') {
        // This is collection-wide *persisted* progress, not just the last
        // in-memory batch. Shows each saved chunk even mid-batch.
        const done = result.total - result.pending;
        progressTracker.stats.totalItems = result.total;
        progressTracker.updateEmbeddingProgress(done, result.total);
        progressTracker.updateProgress(done, progressTracker.isPaused ? '' : `${result.pending} message groups remaining`);
    } else if (!isVectorizationActive() && progressTracker.isDatabaseSnapshot) {
        progressTracker.setDatabaseStatus(result);
    }
    refreshVectorizationStatusDisplay(result);
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
            waitedMs += 2000;
        }
        if (isVectorizationActive()) {
            console.debug('VectHare: Resume check gave up waiting (run exceeded 10 min wait window)');
            return;
        }
    }

    for (let attempt = 1; attempt <= RESUME_CHECK_MAX_ATTEMPTS; attempt++) {
        let result = null;
        try {
            result = await checkUnfinishedVectorization(settings);
        } catch (error) {
            console.warn('VectHare: Resume-on-load check failed:', error.message);
        }

        if (result) {
            // Definitive answer — reflect it in the UI (Repair Chunks button +
            // R10 status line) and stop polling.
            // R23: 'available' instead of hiding on no-backlog - the button is a
            // working tool (repair is a safe no-op when clean), and the old
            // hide-on-clean made it flicker away based on racy async timing.
            updateContinueVectorizationButton(
                result.hasBacklog ? 'backlog' : 'available',
                result.pending,
                result.total
            );
            refreshVectorizationStatusDisplay(result);
            if (!isVectorizationActive() && progressTracker.isDatabaseSnapshot) progressTracker.setDatabaseStatus(result);
            // R9: if the user just pressed Stop, they KNOW it's unfinished - don't
            // immediately nag with the toast. Button still updates (persistent
            // affordance). Flag is consume-on-read so later natural checks toast.
            const justStoppedByUser = consumeWasLastRunStoppedByUser();
            if (result.hasBacklog && !isVectorizationActive() && !justStoppedByUser) {
                console.log(`VectHare: Unfinished vectorization detected (${result.pending}/${result.total} pending)`);
                showResumeToast(result.pending, result.total);
            }
            return;
        }

        // Collection not discovered yet — wait for discovery and retry
        if (attempt < RESUME_CHECK_MAX_ATTEMPTS) {
            await new Promise(resolve => setTimeout(resolve, RESUME_CHECK_RETRY_MS));
        }
    }

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
    refreshVectorizationStatusDisplay();
    console.debug('VectHare: Resume check inconclusive after retries (no vector collection discovered yet)');
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
        const { saveSettingsDebounced } = await import('../../../../script.js');
        await purgeAllAndResetSettings({
            requestPurge: () => fetch('/api/plugins/similharity/purge-all', {
                method: 'POST',
                headers: getRequestHeaders(),
            }),
            settings: extension_settings.vecthare,
            persistSettings: saveSettingsDebounced,
        });

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
    eventSource.on(event_types.MESSAGE_DELETED, onChatEvent);
    eventSource.on(event_types.MESSAGE_EDITED, onChatEvent);
    // VectHare+ R10: edits/deletes flag the reverse-sync (repair) pass to run
    // on the very next sync instead of waiting out the 5-minute throttle -
    // the DB is corrected as soon as anything observes the change.
    eventSource.on(event_types.MESSAGE_EDITED, () => flagImmediateReverseSync());
    eventSource.on(event_types.MESSAGE_DELETED, () => flagImmediateReverseSync());
    // Run vector sync tasks on message events
    // Note: Semantic WI injection happens in the generate_interceptor (rearrangeChat), not here
    eventSource.on(event_types.MESSAGE_SENT, onChatEvent);
    eventSource.on(event_types.MESSAGE_RECEIVED, onChatEvent);
    eventSource.on(event_types.MESSAGE_SWIPED, onChatEvent);
    // When a chat is deleted, purge its vectors (not full purge, just that chat)
    eventSource.on(event_types.CHAT_DELETED, async (chatId) => {
        if (chatId) {
            const collectionId = getChatCollectionId(chatId);
            if (collectionId) {
                await purgeVectorIndex(collectionId, settings);
                console.log(`VectHare: Purged vectors for deleted chat: ${chatId}`);
            }
        }
    });
    eventSource.on(event_types.GROUP_CHAT_DELETED, async (chatId) => {
        if (chatId) {
            const collectionId = getChatCollectionId(chatId);
            if (collectionId) {
                await purgeVectorIndex(collectionId, settings);
                console.log(`VectHare: Purged vectors for deleted group chat: ${chatId}`);
            }
        }
    });

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
        console.log('VectHare: Chat changed, refreshing UI state');
        refreshAutoSyncCheckbox(settings);
        lastDbStatus = null;
        ++dbStatusRequestId;
        scheduleSavedDatabaseRefresh();
        // VectHare+: check for interrupted vectorization on the loaded chat
        offerResumeOfUnfinishedVectorization();
    });

    // VectHare+: one-time resume check at startup (page reload / ST reopen)
    setTimeout(offerResumeOfUnfinishedVectorization, 5000);
    setTimeout(scheduleSavedDatabaseRefresh, 5000);

    console.log('VectHare: ✅ Initialized successfully');
});
