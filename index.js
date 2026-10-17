import { saveVectHareSettingsDebounced as saveSettingsDebounced } from './core/settings-durability.js';
import { getChatUUID } from './core/collection-ids.js';
import { initialiseSettingsDurability, flushVectHareSettings, getSettingsDurabilityStatus } from './core/settings-durability.js';
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
import {acquireSharedOperation,finishSharedOperation,SharedOperationStoppedError} from './ui/shared-operations.js';
import {createOperationControl, detachOperationControl, hasActiveVectorWrite, OperationStoppedError} from './ui/operation-controls.js';
import { clearAllRecovery } from './core/sync-checkpoints.js';
import { openPurgeDialog } from './ui/purge-dialog.js';
import { getCollectionProfile, verifyAndRestoreLegacyProfile } from './core/vectorization-profile.js';
import { openContentVectorizer } from './ui/content-vectorizer.js';
import { getChatBinding, reconcileActiveChatRename } from './core/collection-ownership.js';
import { recordCurrentChatIdentity, repairCurrentLegacyBranchIdentity, confirmReopenedLegacyBranchIdentity, observeChatIdentityTransition } from './core/chat-identity-ledger.js';
import {
    eventSource,
    getCurrentChatId,
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

    // P2 #57: 0 disables an additional limit; Top-K still applies.
    memory_max_injections: 0,
    memory_token_budget: 0,

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

// Capture the originating chat BEFORE scheduling the delayed Auto-Sync work.
// A branch/chat switch during debounce must never convert an event from A
// into an unrequested write to B, even when both chats use the same character.
const debouncedChatUpdate = debounce(async (sourceUUID, sourceChatFile) => {
    if (!sourceUUID || !sourceChatFile ||
        getChatUUID() !== sourceUUID || getCurrentChatId() !== sourceChatFile) {
        console.warn('VectHare: discarding a stale chat event after a chat/branch switch');
        return;
    }
    await moduleWorker.update();
}, debounce_timeout.relaxed);
const onChatEvent = () => debouncedChatUpdate(getChatUUID(), getCurrentChatId());

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
// Explicit opt-in legacy-branch identity repair. Never copies a parent's vectors.
window.vecthareRepairLegacyBranchIdentity = async () => {
    let shared=null, outcome='failed';
    try {
        // Same-server tabs must not simultaneously rewrite the same legacy
        // chat's identity metadata. Acquire the user's durable write slot.
        const originalFile=getCurrentChatId();
        shared=await acquireSharedOperation('Repair Legacy Chat Identity',
            {category:'identity-repair',resourceKey:`chat:${originalFile}`,queue:false});
        if(getCurrentChatId()!==originalFile)throw new Error('Chat switched while acquiring identity-repair lock');
        const result=await repairCurrentLegacyBranchIdentity({confirm:async()=>window.confirm(
            'VectHare detected an ambiguous legacy branch identity. Give THIS chat an independent VectHare identity?\n\nNo existing vectors will move or be deleted, and automatic vectorisation will remain off. You must switch away and reopen the chat before starting a new collection.')});
        if(result?.repaired){toastr.info(result.reason,'VectHare: Legacy Branch');refreshActiveChatProfile();}
        outcome='completed';
    }catch(error){toastr.error(error.message,'VectHare: Branch Repair');}
    finally{if(shared)await finishSharedOperation(shared,outcome).catch(e=>console.warn('VectHare identity repair requires lease reconciliation:',e));}
};

let lastChatScan = null;
function refreshActiveChatProfile() {
    const identity=recordCurrentChatIdentity();
    const statusEl=document.getElementById('vecthare_active_profile_status');
    if(!identity.verified){
        if(statusEl) {
            statusEl.replaceChildren();
            statusEl.appendChild(document.createTextNode(`VectHare write access blocked: ${identity.reason} `));
            if(/collision|are required/i.test(identity.reason)) {
                const button=document.createElement('button');
                button.type='button';button.textContent='Repair This Legacy Chat Identity';
                button.addEventListener('click',()=>void window.vecthareRepairLegacyBranchIdentity());
                statusEl.appendChild(button);
            }
        }
        return;
    }
    let binding;
    try { binding=getChatBinding(); }
    catch(error) {
        const el=document.getElementById('vecthare_active_profile_status');
        if (el) el.textContent=`VectHare write access blocked: ${error.message}`;
        console.warn('VectHare: unsafe chat/branch binding:',error);
        return;
    }
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
    let activityFinished=false, shared=null,sharedOutcome='failed';
    const originalChat=getChatUUID();
    const control=createOperationControl(activityId,{pausable:repairing,stoppable:true,writeOperation:repairing});
    registerActivityRetry(activityId,async()=>{
        if(originalChat!==getChatUUID())throw new Error('Return to the original chat before retrying');
        lastChatScan=null;await onScanRepairClick();
    });
    try {
        if(repairing){shared=await acquireSharedOperation('Repair Chat Embeddings',{activityId,category:'repair',resourceKey:originalChat||''});control.bindSharedOperation(shared);}
        if(lastChatScan?.issues?.length) {
            const problems=lastChatScan.issues;
            if(!confirm(`Repair ${problems.length} chat embedding issue(s)? Replacements are verified before outdated vectors are removed.`)) {
                sharedOutcome='completed';finishActivity(activityId,true,'Repair cancelled; no data changed'); activityFinished=true; return;
            }
            setScanButton('Repairing...',true);
            updateActivity(activityId,{total:problems.length+1,detail:'Repairing and checking stored embeddings'});
            const after=await repairCurrentChat(currentSettings,lastChatScan, {control,onProgress: ({detail,completed,total}) => updateActivity(activityId,{detail,completed,total})});
            lastChatScan=after.issues.length?after:null;
            setScanButton(after.issues.length?`Repair (${after.issues.length} Issues)`:'All Clear');
            sharedOutcome=after.issues.length?'failed':'completed';
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
        if(!activityFinished) {finishActivity(activityId,error instanceof OperationStoppedError || error instanceof SharedOperationStoppedError?'stopped':false,error.message || 'Scan/repair failed');activityFinished=true;}
        if(error instanceof OperationStoppedError || error instanceof SharedOperationStoppedError){lastChatScan=null;setScanButton('Scan Chat');return;}
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
    }finally{
        if(shared)try{await finishSharedOperation(shared,sharedOutcome);}catch(e){console.warn('VectHare: repair job needs recovery:',e);}
        detachOperationControl(activityId);
    }
}
/**
 * Action: Full purge - wipes ALL vector data and settings
 */
async function onPurgeClick() {
    const purgeActivity=startActivity('Purge VectHare Data',{category:'purge',total:1,unit:'operation',detail:'Preparing scoped deletion inventory'});
    try {
        const result=await openPurgeDialog(settings,{allowReset:true});
        if(!result){finishActivity(purgeActivity,true,'Cancelled without deleting data');return;}
        if(result.resetSettings){
            settings={...defaultSettings,enabled:extension_settings.vecthare.enabled};
            toastr.success(`Verified deletion of ${result.completed.length} collection(s). Settings were reset. Reload SillyTavern to refresh all controls.`,'VectHare');
        }else{
            toastr.success(`Verified deletion of ${result.completed.length} VectHare collection(s). Provider and other settings preserved.`,'VectHare');
        }
        finishActivity(purgeActivity,true,'Verified scoped deletion complete');
    }catch(error){
        finishActivity(purgeActivity,false,error.message);
        toastr.error(`Purge aborted or incomplete: ${error.message}`,'VectHare',{timeOut:15000});
        console.error('VectHare: Purge failed:',error);
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

    // One live settings object throughout the extension. The previous copy-on-
    // startup model split `settings.collections` from collection metadata in
    // extension_settings, permitting UI/runtime values to diverge after edits.
    if (!extension_settings.vecthare) extension_settings.vecthare = {};
    settings = extension_settings.vecthare;
    for (const [key,defaultValue] of Object.entries(defaultSettings)) {
        if(settings[key]===undefined)settings[key]=structuredClone(defaultValue);
    }
    if(!settings.temporal_decay || typeof settings.temporal_decay!=='object' || Array.isArray(settings.temporal_decay))
        settings.temporal_decay=structuredClone(defaultSettings.temporal_decay||{});
    for(const [key,defaultValue] of Object.entries(defaultSettings.temporal_decay||{})){
        if(settings.temporal_decay[key]===undefined)settings.temporal_decay[key]=structuredClone(defaultValue);
    }
    // Collection metadata MUST remain the actual shared registry object, never
    // a shallow clone that can become stale while a modal is open.

    // Check the authoritative recovery copy without silently replacing local
    // settings; any host/server mismatch must be resolved explicitly.
    initialiseSettingsDurability().catch(error=>console.warn('[VectHare] Settings recovery copy unavailable:',error.message));

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

    // Register identity independently of any database collection.
    // New chats/branches remain entirely unvectorised until user initiation.
    recordCurrentChatIdentity();
    // Register event handlers
    eventSource.on(event_types.MESSAGE_DELETED, (...args) => {
        lastChatScan=null;
        setScanButton('Scan Chat');
        onChatEvent(...args);
        // Capture BOTH immutable identity and source chat file at event time.
        // A delayed callback must never retarget a newly opened branch/chat.
        const sourceChatId = getCurrentChatId();
        const sourceChatUUID = getChatUUID();
        // Queue by both identities; a branch switch is not a licence to
        // repair a different chat. Only queue an already connected collection.
        let hasVerifiedBinding = false;
        try { hasVerifiedBinding = !!(sourceChatId && sourceChatUUID && getChatBinding(sourceChatUUID)); }
        catch(error) { console.warn('VectHare: deletion source identity ambiguous; no automatic repair:', error); }
        if (hasVerifiedBinding) {
            extension_settings.vecthare.pendingDeletionReconciliations ||= {};
            extension_settings.vecthare.pendingDeletionReconciliations[sourceChatUUID] =
                {sourceChatId,sourceChatUUID,requestedAt:Date.now()};
            saveSettingsDebounced();
        }
        setTimeout(async () => {
            if (getCurrentChatId() !== sourceChatId || getChatUUID() !== sourceChatUUID) {
                console.warn('VectHare: chat switched before delete reconciliation; source remains for explicit Scan/Repair');
                return;
            }
            const complete=await reconcileDeletedMessages(extension_settings.vecthare || settings,
                {sourceChatId,sourceChatUUID});
            if(complete===true) {
                delete extension_settings.vecthare.pendingDeletionReconciliations?.[sourceChatUUID];
                saveSettingsDebounced();
            }
        }, 350);
    });
    eventSource.on(event_types.MESSAGE_EDITED, (...args) => { lastChatScan=null;setScanButton('Scan Chat');onChatEvent(...args); });
    // Run vector sync tasks on message events
    // Note: Semantic WI injection happens in the generate_interceptor (rearrangeChat), not here
    eventSource.on(event_types.MESSAGE_SENT, onChatEvent);
    eventSource.on(event_types.MESSAGE_RECEIVED, onChatEvent);
    eventSource.on(event_types.MESSAGE_SWIPED, (...args) => { lastChatScan=null;setScanButton('Scan Chat');onChatEvent(...args); });
    // 1.19 emits the rename after a successful server-side move. Only the
    // active original UUID/file pair can update its binding; copied branches
    // and identically named chats may not adopt the collection.
    if (event_types.CHAT_RENAMED) eventSource.on(event_types.CHAT_RENAMED, event => {
        if (reconcileActiveChatRename(event)) {
            // A deletion pending when the SAME chat is renamed must follow
            // its verified new filename; otherwise it becomes stranded until
            // manually repaired. Never retarget a different UUID/branch.
            const uuid=getChatUUID();
            const oldFile=String(event?.oldFileName||'').replace(/\.jsonl$/i,'');
            const pending=extension_settings.vecthare?.pendingDeletionReconciliations?.[uuid];
            if(pending?.sourceChatUUID===uuid && pending.sourceChatId===oldFile){
                pending.sourceChatId=getCurrentChatId();
                saveSettingsDebounced();
            }
            console.info('VectHare: verified chat rename updated its identity and any existing collection binding');
            refreshActiveChatProfile();
        }
    });

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
        observeChatIdentityTransition();
        const identity=confirmReopenedLegacyBranchIdentity();
        if(!identity.verified)console.warn('[VectHare] Unsafe branch identity, writes blocked:',identity.reason);
        console.log('VectHare: Chat changed, refreshing UI state');
        refreshAutoSyncCheckbox(settings);
        lastChatScan=null;setScanButton('Scan Chat');refreshActiveChatProfile();
        const sourceChatUUID=getChatUUID(), sourceChatId=getCurrentChatId();
        const pending=extension_settings.vecthare?.pendingDeletionReconciliations?.[sourceChatUUID];
        if(pending && pending.sourceChatId===sourceChatId) {
            setTimeout(async()=>{
                if(getChatUUID()!==sourceChatUUID || getCurrentChatId()!==sourceChatId)return;
                const complete=await reconcileDeletedMessages(extension_settings.vecthare||settings,pending);
                if(complete===true){
                    delete extension_settings.vecthare.pendingDeletionReconciliations[sourceChatUUID];
                    saveSettingsDebounced();
                }
            },350);
        }
    });

    console.log('VectHare: ✅ Initialized successfully');
});
