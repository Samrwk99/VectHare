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

import {scanCurrentChat, repairCurrentChat, reconcileDeletedMessages} from './core/chat-repair.js';
import {startActivity, updateActivity, finishActivity, registerActivityRetry} from './ui/activity-status.js';
import {createOperationControl, detachOperationControl, hasActiveVectorWrite, OperationStoppedError} from './ui/operation-controls.js';
import { clearAllRecovery } from './core/sync-checkpoints.js';
import { getCollectionProfile, verifyAndRestoreLegacyProfile } from './core/vectorization-profile.js';
import { openContentVectorizer } from './ui/content-vectorizer.js';
import { getChatBinding } from './core/collection-ownership.js';
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
import { synchronizeChat, rearrangeChat, vectorizeAll } from './core/chat-vectorization.js';
import { purgeAllVectorIndexes, purgeVectorIndex } from './core/core-vector-api.js';
import { getChatCollectionId } from './core/chat-vectorization.js';
import { getDefaultDecaySettings } from './core/temporal-decay.js';
import { migrateOldEnabledKeys } from './core/collection-metadata.js';
import { clearCollectionRegistry, discoverExistingCollections } from './core/collection-loader.js';
import AsyncUtils from './utils/async-utils.js';

// VectHare modules - UI
import { renderSettings, openDiagnosticsModal, loadWebLlmModels, updateWebLlmStatus, refreshAutoSyncCheckbox } from './ui/ui-manager.js';
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
    nanogpt_model: '',
    nanogpt_api_key: '',
    custom_model: '',
    custom_api_key: '',
    custom_endpoint_mode: 'base', // 'base' appends /v1/embeddings; 'exact' uses the URL verbatim.
    vllm_api_key: '',
    openrouter_api_key_override: '',
    electronhub_api_key_override: '',
    bananabread_model: '',
    koboldcpp_model: '',
    embedding_max_tokens: 0,
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
    conversation_turn_order: 'user_character', // Preferred logical pairing order for Conversation Turns
    batch_size: 4, // Messages per batch for message_batch strategy
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
 * Action: Vectorize all messages in current chat
 */
async function onVectorizeAllClick() {
    await vectorizeAll(settings, getBatchSize());
    refreshActiveChatProfile();
}
// Only a user interaction in Live Status can resume an interrupted chat.
window.vecthareResumeFromStatus = onVectorizeAllClick;
window.vecthareOpenStagedRecovery = (oldKey) => openContentVectorizer('chat',oldKey);

let lastChatScan = null;
function refreshActiveChatProfile() {
    const binding=getChatBinding();
    const profile=binding?.registryKey ? getCollectionProfile(binding.registryKey) : null;
    const state=profile ? `Connected: ${binding.registryKey} | Embedding: ${profile.embedding?.modelId || 'Unverified'} (${profile.embedding?.verified?'verified':'unverified'}) | Strategy: ${profile.chunking?.chunking_strategy || 'unknown'}; global settings only apply to new collections.` : binding ? 'This connected legacy collection has no saved vectorization profile; writing remains blocked until verified or re-vectorized.' : 'No writable collection is connected. Global settings apply to newly created collections.';
    $('#vecthare_collection_profile_status').text(state);
}
function setScanButton(label, disabled=false) {
    const button = $('#vecthare_scan_chat');
    button.find('span').text(label);
    button.prop('disabled',disabled);
}
async function onScanRepairClick() {
    if(hasActiveVectorWrite()){toastr.info('Wait for the active vector operation to finish or pause/stop it before scanning.','VectHare');return;}
    const currentSettings=extension_settings.vecthare || settings;
    const repairing=Boolean(lastChatScan?.issues?.length);
    const activityId=startActivity(repairing?'Repair Chat Embeddings':'Scan Chat Embeddings',
        {category:repairing?'repair':'scan',detail:repairing?'Preparing verified replacements':'Comparing chat and stored vectors'});
    let activityFinished=false;
    const originalChat=getChatUUID();
    const control=createOperationControl(activityId,{pausable:repairing,stoppable:true,writeOperation:repairing});
    registerActivityRetry(activityId,async()=>{
        if(originalChat!==getChatUUID())throw new Error('Return to the original chat before retrying');
        lastChatScan=null;await onScanRepairClick();
    });
    try {
        if(lastChatScan?.issues?.length) {
            const problems=lastChatScan.issues;
            if(!confirm(`Repair ${problems.length} chat embedding issue(s)? Replacements are verified before outdated vectors are removed.`)) {
                finishActivity(activityId,true,'Repair cancelled; no data changed'); activityFinished=true; return;
            }
            setScanButton('Repairing...',true);
            updateActivity(activityId,{total:problems.length+1,detail:'Repairing and checking stored embeddings'});
            const after=await repairCurrentChat(currentSettings,lastChatScan, {control,onProgress: ({detail,completed,total}) => updateActivity(activityId,{detail,completed,total})});
            lastChatScan=after.issues.length?after:null;
            setScanButton(after.issues.length?`Repair (${after.issues.length} Issues)`:'All Clear');
            finishActivity(activityId,after.issues.length===0,after.issues.length?`${after.issues.length} issues still need attention`:'All repairs verified');activityFinished=true;
            if(after.issues.length)toastr.warning(`${after.issues.length} issues remain after repair`, 'VectHare');
            else toastr.success('Chat embeddings verified after repair','VectHare');
            return;
        }
        setScanButton('Scanning...',true);
        const scan=await scanCurrentChat(currentSettings,{control,onProgress:({detail,completed,total})=>updateActivity(activityId,{detail,completed,total})});
        lastChatScan=scan.issues.length?scan:null;
        setScanButton(scan.issues.length?`Repair (${scan.issues.length} Issues)`:'All Clear');
        finishActivity(activityId,true,scan.issues.length?`${scan.issues.length} issue(s) found; repair available`:'All scanned vectors match the chat');activityFinished=true;
        if(scan.issues.length) {
            const counts=Object.groupBy ? Object.groupBy(scan.issues,issue=>issue.type) : null;
            const summary=counts?Object.entries(counts).map(([kind,items])=>`${kind}: ${items.length}`).join(', '):`${scan.issues.length} issues`;
            toastr.warning(`Scan found ${summary}. Click Repair to reconcile.`, 'VectHare', {timeOut:9000});
        } else toastr.success('All scanned vectors match the current chat', 'VectHare');
    } catch(error) {
        if(!activityFinished) {finishActivity(activityId,error instanceof OperationStoppedError?'stopped':false,error.message || 'Scan/repair failed');activityFinished=true;}
        if(error instanceof OperationStoppedError){lastChatScan=null;setScanButton('Scan Chat');return;}
        lastChatScan=null;
        setScanButton('Retry Scan');
        if(/(no verified vectorization profile|embedding identity is unverified|lacks a verifiable chunk manifest)/i.test(error.message)) {
            const binding=getChatBinding();
            if(binding) {
                const choice=prompt(`This older collection cannot be safely scanned or resumed: ${error.message}\n\n` +
                    'Options:\nRESTORE — First set the original embedding provider, model and chunking strategy in Settings, then verify against stored vector samples.\n' +
                    'RE-VECTORIZE — Build a new collection and keep this one as a disabled backup.\n' +
                    'CANCEL — Keep the collection read-only.\n\nType RESTORE or RE-VECTORIZE:','CANCEL');
                if(choice?.trim().toUpperCase()==='RE-VECTORIZE') {
                    openContentVectorizer('chat',binding.registryKey);return;
                }
                if(choice?.trim().toUpperCase()==='RESTORE') {
                    try {
                        await verifyAndRestoreLegacyProfile(binding.registryKey,currentSettings);
                        toastr.success('Stored vectors match the selected embedding model. Profile restored; scan again to inspect chat chunks.','VectHare');
                        setScanButton('Scan Chat');refreshActiveChatProfile();return;
                    } catch(verificationError) {toastr.error(`Original settings could not be verified: ${verificationError.message}`,'VectHare',{timeOut:12000});return;}
                }
                return;
            }
        }
        toastr.error(`Scan/repair could not finish: ${error.message}`,'VectHare',{timeOut:12000});
        console.error('VectHare: Chat repair error',error);
    }finally{detachOperationControl(activityId);}
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

    const purgeActivity=startActivity('Purge All Vectors',{category:'purge',total:3,unit:'steps',detail:'Requesting server deletion'});
    try {
        const { getRequestHeaders } = await import('../../../../script.js');

        // 1. Delete entire vectors folder
        const response = await fetch('/api/plugins/similharity/purge-all', {
            method: 'POST',
            headers: getRequestHeaders(),
        });
        if (!response.ok) {
            throw new Error(`Server did not purge vectors (${response.status}): ${await response.text()}`);
        }
        const result = await response.clone().json().catch(() => null);
        if (result?.success === false || result?.error) {
            throw new Error(`Server reported purge failure: ${JSON.stringify(result)}`);
        }

        // Only after confirmed backend purge: erase obsolete resume pointers.
        clearAllRecovery();
        updateActivity(purgeActivity,{completed:1,detail:'Backend confirmed deletion'});

        // 2. Clear extension_settings.vecthare
        for (const key in extension_settings.vecthare) {
            if (key !== 'enabled') {
                delete extension_settings.vecthare[key];
            }
        }

        updateActivity(purgeActivity,{completed:2,detail:'Extension settings cleared'});

        // 3. Save settings
        const { saveSettingsDebounced } = await import('../../../../script.js');
        saveSettingsDebounced();

        updateActivity(purgeActivity,{completed:3,detail:'Settings saved'});
        finishActivity(purgeActivity,true,'All vector data purged');
        toastr.success('All vector data purged', 'Purge Complete');

    } catch (error) {
        finishActivity(purgeActivity,false,error.message);
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
        onScanRepair: onScanRepairClick,
        onPurge: onPurgeClick,
        onRunDiagnostics: onRunDiagnosticsClick
    });

    // Initialize auto-sync checkbox state for current chat (if any)
    refreshAutoSyncCheckbox(settings);
    refreshActiveChatProfile();

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
    eventSource.on(event_types.MESSAGE_DELETED, (...args) => {
        lastChatScan=null;
        setScanButton('Scan Chat');
        onChatEvent(...args);
        // Let SillyTavern finish updating the chat array before reconciliation.
        setTimeout(() => reconcileDeletedMessages(extension_settings.vecthare || settings), 350);
    });
    eventSource.on(event_types.MESSAGE_EDITED, (...args) => { lastChatScan=null;setScanButton('Scan Chat');onChatEvent(...args); });
    // Run vector sync tasks on message events
    // Note: Semantic WI injection happens in the generate_interceptor (rearrangeChat), not here
    eventSource.on(event_types.MESSAGE_SENT, onChatEvent);
    eventSource.on(event_types.MESSAGE_RECEIVED, onChatEvent);
    eventSource.on(event_types.MESSAGE_SWIPED, (...args) => { lastChatScan=null;setScanButton('Scan Chat');onChatEvent(...args); });
    // Chat deletion must not automatically erase stored memories. Collections
    // and their ownership record remain available for explicit recovery/deletion.
    eventSource.on(event_types.CHAT_DELETED, chatId => {
        console.info(`VectHare: Chat ${chatId} deleted; preserving vectors and metadata`);
    });
    eventSource.on(event_types.GROUP_CHAT_DELETED, chatId => {
        console.info(`VectHare: Group chat ${chatId} deleted; preserving vectors and metadata`);
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
        lastChatScan=null;setScanButton('Scan Chat');refreshActiveChatProfile();
    });

    console.log('VectHare: ✅ Initialized successfully');
});
