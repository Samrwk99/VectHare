import {buildRecoveryReport} from './utils/e03-recovery.js';
import { guardedVectorFetch as fetch } from './utils/e02-vector-request-gateway.js';
import {renderF02ReadPanel} from './utils/f02-public-read-client.js';
import {renderF09MemoryPreview} from './utils/f09-memory-workflow.js';
import {renderF10RecoveryPanel} from './utils/f10-recovery-client.js';
import {renderF11SetupCenter,groupF11DeveloperPanels} from './utils/f11-setup-center.js';
import {renderF03ProvisionPanel} from './utils/f03-provision-client.js';
import {renderF04PilotPanel} from './utils/f04-pilot-client.js';
import {renderF05QdrantAcceptance} from './utils/f05-acceptance-client.js';
import {renderF06LanceAcceptance} from './utils/f06-lancedb-acceptance.js';
import {renderF06PilotPanel} from './utils/f06-lancedb-pilot-client.js';
import {renderF07VectraAcceptance} from './utils/f07-vectra-acceptance.js';
import {renderF07PilotPanel} from './utils/f07-vectra-pilot-client.js';
import {renderF08MilvusAcceptance} from './utils/f08-milvus-acceptance.js';
import {renderF08PilotPanel} from './utils/f08-milvus-pilot-client.js';
import {discoverS11Plugin, renderS11CompatibilityStatus, renderH01QdrantButton, renderF01SourceAttestation} from './utils/s11-plugin-compatibility.js';
import {recoverPendingC02Operations} from './core/core-vector-api.js';
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
    getRequestHeaders,
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
import { clearCollectionRegistry, discoverExistingCollections, getCollectionRegistry, getPendingCollectionDeletions } from './core/collection-loader.js';
import AsyncUtils from './utils/async-utils.js';
import {chatJobs,currentChatIdentity} from './core/chat-job-runtime.js';
import {getChatIdentityObservation} from './core/collection-ids.js';
import {promptReceipts} from './core/prompt-receipt-runtime.js';
import {worldInfoSnapshots} from './utils/world-info-identity.js';
import {stopVectorization,resetControlState} from './core/vectorization-control.js';
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
    qdrant_use_cloud: false,
    qdrant_multitenancy: false, // Use single collection with content_type field instead of separate collections
    milvus_host: 'localhost',
    milvus_port: 19530,
    milvus_username: '',
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

    // Chat vectorization
    enabled_chats: false,
    chunking_strategy: 'per_message', // per_message, conversation_turns, message_batch, adaptive
    batch_size: 4, // Messages per batch for message_batch strategy
    conversation_turn_order: 'user_character', // Pairing order for conversation_turns
    depth: 2,
    position: extension_prompt_types.IN_PROMPT,
    // I12: Legacy protect setting was never applied; removed rather than exposing a false safeguard.
    insert: 3,
    min_chat_length: 0, // Minimum number of messages in chat before injection starts (0 = no minimum)
    // Number of top results to retrieve from vector DB (top-K)
    top_k: 3,
    // C10: upper bound on VectHare injection, with host-context headroom.
    injection_token_cap: 1024,
    injection_safety_margin: 128,
    injection_context_reserve: 512,
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
const debouncedChatEvent = debounce(async (identityAtEvent) => {
    if (JSON.stringify(identityAtEvent) !== JSON.stringify(currentChatIdentity())) return;
    await moduleWorker.update();
}, debounce_timeout.relaxed);
const onChatEvent = () => debouncedChatEvent(currentChatIdentity());

/**
 * Generation interceptor - searches and injects relevant messages
 */
async function vecthare_rearrangeChat(chat, _contextSize, _abort, type) {
    chatJobs.bumpGeneration('new-generation');
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
    await offerResumeOfUnfinishedVectorization(); // refresh status line + button
}

/**
 * Action: Vectorize all messages in current chat (full sync: repair + backlog)
 */
async function onVectorizeAllClick() {
    const result = await vectorizeAll(settings, getBatchSize());
    // VectHare+ FIX: after a run ends (especially Stop / partial / failure),
    // re-run the backlog check so the Continue button + toast reflect the
    // CURRENT chat's state. Previously the check only fired on CHAT_CHANGED,
    // so stopping mid-run and staying in the same chat left no resume
    // affordance at all until the user switched chats or reloaded.
    await offerResumeOfUnfinishedVectorization();
    return result;
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
let resumeCheckRequestId = 0;

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
    const identityAtStart = JSON.stringify(currentChatIdentity());
    let result = null;
    try {
        result = await checkUnfinishedVectorization(settings);
    } catch (error) {
        console.warn('VectHare: Status refresh failed:', error);
    }
    // Ignore replies from a previous chat or a superseded DB read.
    if (requestId !== dbStatusRequestId || collectionId !== getChatCollectionId() ||
        identityAtStart !== JSON.stringify(currentChatIdentity())) return;
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
function ensureVectHareStatusInterval() {
    if (globalThis.__vecthareStatusInterval) return;
    globalThis.__vecthareStatusInterval = setInterval(() => {
        if (isVectorizationActive()) refreshVectorizationStatusDisplay();
    }, 3000);
}

async function offerResumeOfUnfinishedVectorization() {
    // A newer refresh or a chat switch invalidates any prior asynchronous work.
    const requestId = ++resumeCheckRequestId;
    const collectionIdAtStart = getChatCollectionId();
    const chatIdentityAtStart = JSON.stringify(currentChatIdentity());
    const isCurrent = () => requestId === resumeCheckRequestId &&
        collectionIdAtStart === getChatCollectionId() &&
        chatIdentityAtStart === JSON.stringify(currentChatIdentity());
    if (!isCurrent()) return;
    // VectHare+ FIX (notification behavior): a run already in flight IS the
    // resume — don't nag while it works. BUT we must not bail permanently:
    // this can fire while a run is aborting (e.g. user switched chats mid-run,
    // CHAT_CHANGED beats the "chat changed" cleanup), and a bare return would
    // strand the NEW chat's backlog unchecked. So wait (bounded, up to 10 min)
    // for the active run to finish, then proceed with the normal check.
    if (isVectorizationActive()) {
        console.debug('VectHare: Resume check waiting for active vectorization run to finish...');
        let waitedMs = 0;
        while (isCurrent() && isVectorizationActive() && waitedMs < 600000) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            waitedMs += 2000;
        }
        if (!isCurrent()) return;
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
            cancelJobs: reason => chatJobs.cancelAll(reason),
            awaitTrackedWrites: () => chatJobs.awaitInFlightWrites(),
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
    // C03: SillyTavern has no extension unload API. A second init must never
    // register duplicate listeners, workers or delayed tasks.
    if (globalThis.__vecthareRuntimeInitialized) return;
    globalThis.__vecthareRuntimeInitialized = true;
    try {
    console.log('VectHare: Initializing...');
    ensureVectHareStatusInterval();

    // Load saved settings
    if (!extension_settings.vecthare) {
        extension_settings.vecthare = structuredClone(defaultSettings);
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

    // All runtime modules and the UI must refer to the same current settings.
    // Keep the saved object identity; copying it into a detached snapshot causes
    // background jobs to use stale values after UI changes.
    Object.assign(extension_settings.vecthare, settings);
    settings = extension_settings.vecthare;

    // Retire the inert legacy recent-message protection setting. Deduplication uses
    // the separately configured deduplication_depth; this had no effect.
    if (Object.hasOwn(settings, 'protect') || Object.hasOwn(extension_settings.vecthare, 'protect')) {
        delete settings.protect;
        delete extension_settings.vecthare.protect;
        saveSettingsDebounced();
    }

    // Migrate old scattered enabled keys to new collections structure
    const migrationResult = migrateOldEnabledKeys();
    if (migrationResult.migrated > 0) {
        console.log(`VectHare: Migrated ${migrationResult.migrated} old collection enabled keys`);
    }

    // C01: inspect durable deletion markers after settings load. Never silently
    // retry a destructive operation until backend contracts can verify scope.
    const pendingDeletions = getPendingCollectionDeletions();
    if (pendingDeletions.length) {
        console.warn('VectHare: Collection deletions require reconciliation', pendingDeletions.map(({key,stage})=>({key,stage})));
        toastr.warning(`${pendingDeletions.length} collection deletion(s) require reconciliation; no automatic purge was attempted`, 'VectHare', {timeOut:12000});
    }

    let e03JournalEntries=[];
    let e03JournalError=false;
    // C02: durable write journal is inspected after settings load. No
    // pending replacement is retried or cleaned up automatically.
    try {
        const pendingC02=await recoverPendingC02Operations();
        e03JournalEntries=pendingC02;
        if(pendingC02.length){
            console.warn('VectHare: Journalled operations require reconciliation',pendingC02.map(op=>({operationId:op.operationId,kind:op.kind,phase:op.phase})));
            toastr.warning(`${pendingC02.length} import/replacement operation(s) require reconciliation; existing vectors were not automatically deleted`, 'VectHare', {timeOut:15000});
        }
    } catch (_) {
        e03JournalError=true;
        console.warn('VectHare: C02 durable journal unavailable; imports and replacements must remain blocked');
        toastr.warning('Durable vector-operation journal unavailable; unsafe replacements remain blocked', 'VectHare', {timeOut:15000});
    }

    // C03: pending in-flight requests from a crashed/unloaded tab are not proof
    // that a backend operation failed. Never auto-clear the reconciliation marker.
    const pendingWrites = chatJobs.pendingOperations();
    if (pendingWrites.length) {
        const pendingWriteCount = pendingWrites.reduce((sum,op)=>sum+(op.count||1),0);
        console.warn('VectHare: Pending write operations require reconciliation', pendingWrites.map(({id,status})=>({id,status})));
        toastr.warning(`${pendingWriteCount} interrupted or uncertain write(s) require reconciliation; destructive operations remain blocked`, 'VectHare', {timeOut:12000});
    }

    // E03: a consolidated, strictly read-only startup incident report. This
    // object can be inspected in diagnostics; it never auto-replays mutations.
    const recoveryReport=buildRecoveryReport({journal:e03JournalEntries,
        journalError:e03JournalError,writeMarkers:pendingWrites,deletionMarkers:pendingDeletions});
    globalThis.__vecthareRecoveryReport=recoveryReport;

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

    // S11: read-only S10 build/contract discovery. This is NOT authorization
    // to reactivate any backend operation. Failure remains visibly blocked.
    void discoverS11Plugin().then(status=>{
        renderS11CompatibilityStatus(document.querySelector('.vecthare_settings'),status);
        renderH01QdrantButton(document.querySelector('.vecthare_settings'));
        renderF01SourceAttestation(document.querySelector('.vecthare_settings'));
        renderF02ReadPanel(document.querySelector('.vecthare_settings'),()=>settings);
        renderF09MemoryPreview(document.querySelector('.vecthare_settings'),()=>settings);
        renderF10RecoveryPanel(document.querySelector('.vecthare_settings'),()=>settings);
        renderF03ProvisionPanel(document.querySelector('.vecthare_settings'),()=>settings);
        renderF04PilotPanel(document.querySelector('.vecthare_settings'),()=>settings);
        renderF05QdrantAcceptance(document.querySelector('.vecthare_settings'));
        renderF06LanceAcceptance(document.querySelector('.vecthare_settings'));
        renderF06PilotPanel(document.querySelector('.vecthare_settings'),()=>settings);
        renderF07VectraAcceptance(document.querySelector('.vecthare_settings'));
        renderF07PilotPanel(document.querySelector('.vecthare_settings'),()=>settings);
        renderF08MilvusAcceptance(document.querySelector('.vecthare_settings'));
        renderF08PilotPanel(document.querySelector('.vecthare_settings'),()=>settings);
        renderF11SetupCenter(document.querySelector('.vecthare_settings'),{getHeaders:getRequestHeaders});
        groupF11DeveloperPanels(document.querySelector('.vecthare_settings'));
        if (!status.compatible) console.warn('VectHare: Similharity S10 compatibility unavailable:',status.reason);
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

    // Register host listeners exactly once. Keep a registry to support a future
    // explicit teardown without changing the host's extension lifecycle.
    const vhListeners = [];
    const onVhEvent = (type, handler) => {
        if (!type) return;
        eventSource.on(type, handler);
        vhListeners.push({type,handler});
    };
    globalThis.__vecthareEventListeners = vhListeners;
    // A chat switch invalidates every job, not merely its eventual toast.
    const invalidateChat = () => {
        promptReceipts.invalidate();
        chatJobs.cancelAll('chat-changed');
        worldInfoSnapshots.clear(); // Do not reuse stale WI observations across chat switches.
        chatJobs.bumpGeneration('chat-changed');
        if (isVectorizationActive()) stopVectorization();
        else resetControlState();
    };
    const invalidateMessage = () => {
        promptReceipts.invalidate();
        chatJobs.cancelKinds(['retrieval','sync','repair','vectorize'],'message-changed');
        chatJobs.bumpGeneration('message-changed');
    };
    onVhEvent(event_types.CHAT_CHANGED, invalidateChat);
    let s11BranchQuarantineNoticeShown=false;
    onVhEvent(event_types.CHAT_CHANGED, () => {
        const observation=getChatIdentityObservation();
        if(observation.status==='QUARANTINED' && !s11BranchQuarantineNoticeShown){
            s11BranchQuarantineNoticeShown=true;
            toastr.warning('Two chat handles appear to share one integrity ID. Chat vector collections are quarantined pending identity review.', 'VectHare branch identity', {timeOut:15000});
        }
    });
    // The event payload is the assembled host prompt, not the extension registry.
    onVhEvent(event_types.CHAT_COMPLETION_PROMPT_READY, event=>promptReceipts.observe('chat',event));
    onVhEvent(event_types.GENERATE_AFTER_COMBINE_PROMPTS, event=>promptReceipts.observe('text',event));
    // C08: capture host WI activations for the *next* retrieval. Event ordering
    // versus generate_interceptor is version-dependent and not assumed.
    onVhEvent(event_types.WORLD_INFO_ACTIVATED, payload => {
        const current = currentChatIdentity();
        worldInfoSnapshots.capture(current.originId || current.chatId, payload);
    });

    for (const name of ['GENERATION_STOPPED','GENERATION_ENDED','GENERATION_ABORTED']) {
        onVhEvent(event_types[name], () => chatJobs.bumpGeneration(name.toLowerCase()));
    }
    for (const name of ['MESSAGE_EDITED','MESSAGE_DELETED','MESSAGE_SWIPED']) {
        onVhEvent(event_types[name], invalidateMessage);
    }
    const onPageHide = () => {promptReceipts.invalidate();chatJobs.teardown();};
    window.addEventListener('pagehide', onPageHide);
    // Register event handlers
    onVhEvent(event_types.MESSAGE_DELETED, onChatEvent);
    onVhEvent(event_types.MESSAGE_EDITED, onChatEvent);
    // VectHare+ R10: edits/deletes flag the reverse-sync (repair) pass to run
    // on the very next sync instead of waiting out the 5-minute throttle -
    // the DB is corrected as soon as anything observes the change.
    onVhEvent(event_types.MESSAGE_EDITED, () => flagImmediateReverseSync(getChatCollectionId(), settings));
    onVhEvent(event_types.MESSAGE_DELETED, () => flagImmediateReverseSync(getChatCollectionId(), settings));
    // Run vector sync tasks on message events
    // Note: Semantic WI injection happens in the generate_interceptor (rearrangeChat), not here
    onVhEvent(event_types.MESSAGE_SENT, onChatEvent);
    onVhEvent(event_types.MESSAGE_RECEIVED, onChatEvent);
    onVhEvent(event_types.MESSAGE_SWIPED, onChatEvent);
    onVhEvent(event_types.MESSAGE_SWIPED, () => flagImmediateReverseSync(getChatCollectionId(), settings));
    // When a chat is deleted, purge its vectors (not full purge, just that chat)
    onVhEvent(event_types.CHAT_DELETED, async (chatId) => {
        if (chatId) {
            const collectionId = getChatCollectionId(chatId);
            if (collectionId) {
                const confirmed = await purgeVectorIndex(collectionId, settings);
                if (confirmed !== true) return;
                console.log(`VectHare: Purged vectors for deleted chat: ${chatId}`);
            }
        }
    });
    onVhEvent(event_types.GROUP_CHAT_DELETED, async (chatId) => {
        if (chatId) {
            const collectionId = getChatCollectionId(chatId);
            if (collectionId) {
                const confirmed = await purgeVectorIndex(collectionId, settings);
                if (confirmed !== true) return;
                console.log(`VectHare: Purged vectors for deleted group chat: ${chatId}`);
            }
        }
    });

    // When WebLLM extension is loaded, refresh the model list
    onVhEvent(event_types.EXTENSION_SETTINGS_LOADED, async (manifest) => {
        if (settings.source === 'webllm' && manifest?.display_name === 'WebLLM') {
            console.log('VectHare: WebLLM extension loaded, refreshing models...');
            updateWebLlmStatus();
            await loadWebLlmModels(settings);
        }
    });

    // When chat changes, refresh UI state to match settings
    onVhEvent(event_types.CHAT_CHANGED, () => {
        ++resumeCheckRequestId; // Invalidate any pending resume check immediately.
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
    } catch (error) { globalThis.__vecthareRuntimeInitialized = false; throw error; }
});
