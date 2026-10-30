/**
 * ============================================================================
 * VECTHARE SCENE MARKERS
 * ============================================================================
 * Adds scene start/end marker buttons to chat messages. Scenes are stored as
 * chunks in the vector database with isScene:true metadata.
 *
 * Local state:
 * - cachedSceneChunks: scene chunks from vector DB (refreshed on chat load)
 * - pendingSceneStart: message index where user clicked START (not yet in DB)
 *
 * @author Coneja Chibi
 * @version 2.2.0-alpha
 * ============================================================================
 */

import {
    createSceneChunk,
    deleteSceneChunk,
    getCurrentCollectionId,
    filterSceneChunks,
} from '../core/scenes.js';
import { getSavedHashes } from '../core/core-vector-api.js';
import { eventSource, event_types, chat_metadata, getRequestHeaders, getCurrentChatId } from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';
import {currentChatIdentity} from '../core/chat-job-runtime.js';
import {getVerifiedChatOriginId} from '../core/collection-ids.js';
import {formatCollectionKey} from '../utils/collection-keys.js';
import {acceptSceneTimelineSnapshot} from '../core/scene-timeline.js';
import {requiresManagedSceneContract} from '../utils/pb3-managed-scene-guard.js';
import {f02CurrentChatSelector} from '../utils/f02-public-read-client.js';
import {readManagedScenes,sceneLocator,validateHostSceneDraft,commitManagedSceneEdit} from '../utils/pb6-managed-scenes.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const START_MARKER_CLASS = 'vecthare-scene-marker-start';
const END_MARKER_CLASS = 'vecthare-scene-marker-end';

const BOOKMARK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M9.808 13.692h.884v-3h4.193L13.615 9l1.27-1.692H9.808zM6 19.5V4h12v15.5l-6-2.583z"/></svg>';

// ============================================================================
// LOCAL STATE
// ============================================================================

let cachedSceneChunks = [];
let pendingSceneStart = null;
let currentSettings = null;
let sceneCacheRefreshVersion = 0;
// P-B.2: legacy scene hash listings do not prove a managed-v2 record,
// owned generation, revision, or physically complete inventory.
let sceneCacheEvidence = 'UNVERIFIED';
let managedSceneReadback = null;
let managedSceneEditBusy = false;
const selectedSavedSource = () => f02CurrentChatSelector({getChatId:getCurrentChatId,getContext});
const managedLocatorKey = v => JSON.stringify([String(v.sendDate),v.name,v.isUser]);
function resolveManagedSceneRows(scenes,chat) {
    validateHostSceneDraft(scenes,chat);
    const index=new Map(chat.map((m,i)=>{try{return [managedLocatorKey(sceneLocator(m)),i];}catch{return [String(i),i];}}));
    return scenes.map(s=>({sceneId:s.id,sceneStart:index.get(managedLocatorKey(s.start)),
        sceneEnd:index.get(managedLocatorKey(s.end)),title:s.title,source:'SAVED_CHAT_METADATA'}));
}
async function saveManagedSceneChanges(scenes,label) {
    if(managedSceneEditBusy)throw Error('PB6_SCENE_EDIT_IN_PROGRESS');
    if(sceneCacheEvidence!=='MANAGED_SAVED_SCENES_VERIFIED'||!managedSceneReadback)throw Error('PB6_SCENE_REFRESH_REQUIRED');
    const ctx=getContext();
    if(!ctx||!Array.isArray(ctx.chat))throw Error('PB6_CHAT_UNAVAILABLE');
    validateHostSceneDraft(scenes,ctx.chat);
    managedSceneEditBusy=true;
    try {
        const source=selectedSavedSource();
        const read=async actual=>readManagedScenes({source:actual,headers:getRequestHeaders()});
        const result=await commitManagedSceneEdit({context:ctx,chatMetadata:chat_metadata,source,
            getCurrentSource:async()=>selectedSavedSource(),read,expected:managedSceneReadback,scenes,
            confirm:async()=>globalThis.confirm?.(`${label}\n\nSave these scene annotations in the actual SillyTavern chat? These are saved-source markers, NOT newly vectorized scene chunks.`)===true});
        if(result.status==='VERIFIED_SAVED_METADATA') {
            await refreshSceneCache();updateAllMarkerStates();
            eventSource.emit('vecthare_scenes_changed');
        }
        return result;
    } finally { managedSceneEditBusy=false; }
}


// ============================================================================
// CACHE MANAGEMENT
// ============================================================================

/**
 * Refreshes the local cache of scene chunks from the vector DB
 */
export async function refreshSceneCache(settings) {
    if (settings) currentSettings = settings;
    const version = ++sceneCacheRefreshVersion;
    const identity = JSON.stringify(currentChatIdentity());
    const collectionId = getCurrentCollectionId();
    const isCurrent = () => version === sceneCacheRefreshVersion &&
        identity === JSON.stringify(currentChatIdentity()) &&
        collectionId === getCurrentCollectionId();
    if (!currentSettings) {
        sceneCacheEvidence = 'UNVERIFIED';cachedSceneChunks = [];managedSceneReadback=null;return;
    }
    if (requiresManagedSceneContract(currentSettings)) {
        try {
            const source=selectedSavedSource();
            const read=await readManagedScenes({source,headers:getRequestHeaders()});
            if(!isCurrent())return;
            const chat=getContext()?.chat;
            if(!Array.isArray(chat)||JSON.stringify(chat_metadata?.vecthareManagedScenes??[])!==JSON.stringify(read.scenes))
                throw Error('PB6_HOST_SCENE_METADATA_STALE');
            const rows=resolveManagedSceneRows(read.scenes,chat);
            if(!isCurrent())return;
            cachedSceneChunks=rows;managedSceneReadback=read;
            sceneCacheEvidence='MANAGED_SAVED_SCENES_VERIFIED';
        }catch(error){
            if(!isCurrent())return;
            cachedSceneChunks=[];managedSceneReadback=null;
            sceneCacheEvidence='MANAGED_SCENE_UNVERIFIED';
            console.warn('VectHare: managed scene readback is unverified',error);
        }
        return;
    }
    if (!collectionId) {
        sceneCacheEvidence='UNVERIFIED';cachedSceneChunks=[];managedSceneReadback=null;return;
    }

    try {
        const result = await getSavedHashes(collectionId, currentSettings, true);
        if (!isCurrent()) return; // never paint chat B with results from chat A
        // The old getSavedHashes() response is advisory legacy metadata only.
        // In particular an empty array must not be presented as proof that
        // an owned managed-v2 collection contains no scenes.
        sceneCacheEvidence = 'LEGACY_UNVERIFIED';
        if (result.metadata) {
            cachedSceneChunks = result.metadata
                .filter(m => m.isScene === true)
                .map(m => ({
                    hash: m.hash,
                    sceneStart: m.sceneStart,
                    sceneEnd: m.sceneEnd,
                    containedHashes: m.containedHashes || [],
                    title: m.title || '',
                    sceneId: m.sceneId,
                    sceneStartRef:m.sceneStartRef,
                    sceneEndRef:m.sceneEndRef,
                }));
        } else {
            cachedSceneChunks = [];
        }
        const stableChatId = getVerifiedChatOriginId();
        if (stableChatId && result?.metadataStatus !== 'unavailable') {
            const key=formatCollectionKey({backend:currentSettings.vector_backend || 'standard',
                source:currentSettings.source || 'transformers',collectionId});
            // Read-only advisory scene timeline; does not certify pagination,
            // ownership, or successful backend writes.
            acceptSceneTimelineSnapshot(stableChatId,key,cachedSceneChunks);
        }
        console.log(`VectHare Scenes: Cached ${cachedSceneChunks.length} scenes`);
    } catch (error) {
        if (!isCurrent()) return;
        console.error('VectHare Scenes: Failed to refresh cache', error);
        cachedSceneChunks = [];
        sceneCacheEvidence = 'UNVERIFIED';
    }
}

/**
 * Gets cached scenes (for external use)
 */
export function getCachedScenes() {
    return cachedSceneChunks;
}

/** Read-only status for scene UI and diagnostics; never a mutation receipt. */
export function getSceneCacheEvidence() {
    return { status: sceneCacheEvidence,
        source: sceneCacheEvidence==='MANAGED_SAVED_SCENES_VERIFIED'?'SAVED_CHAT_METADATA':'LEGACY_HASH_ADVISORY',
        managedV2Verified: false, savedMetadataVerified: sceneCacheEvidence==='MANAGED_SAVED_SCENES_VERIFIED',
        vectorSceneRecordsVerified: false, physicalInventoryComplete: false };
}

/**
 * Gets pending scene start (for external use)
 */
export function getPendingSceneStart() {
    return pendingSceneStart;
}

/**
 * Sets the VectHare settings for scene operations
 */
export function setSceneSettings(settings) {
    currentSettings = settings;
}

// ============================================================================
// SCENE QUERY HELPERS
// ============================================================================

/**
 * Gets the scene chunk that contains a message
 * @param {number} msgId - Message index
 * @returns {object|null}
 */
function getSceneAtMessage(msgId) {
    return cachedSceneChunks.find(s =>
        msgId >= s.sceneStart && msgId <= s.sceneEnd
    ) || null;
}

/**
 * Checks if a message is a scene start
 * @param {number} msgId - Message index
 * @returns {object|null} The scene chunk or null
 */
function getSceneStartingAt(msgId) {
    return cachedSceneChunks.find(s => s.sceneStart === msgId) || null;
}

/**
 * Checks if a message is a scene end
 * @param {number} msgId - Message index
 * @returns {object|null} The scene chunk or null
 */
function getSceneEndingAt(msgId) {
    return cachedSceneChunks.find(s => s.sceneEnd === msgId) || null;
}

// ============================================================================
// MARKER BUTTON CREATION
// ============================================================================

function createStartMarker() {
    const btn = document.createElement('div');
    btn.className = `mes_button ${START_MARKER_CLASS}`;
    btn.title = 'Mark scene START';
    btn.innerHTML = BOOKMARK_SVG;
    return btn;
}

function createEndMarker() {
    const btn = document.createElement('div');
    btn.className = `mes_button ${END_MARKER_CLASS}`;
    btn.title = 'Mark scene END';
    btn.innerHTML = BOOKMARK_SVG;
    return btn;
}

// ============================================================================
// MESSAGE PARSING
// ============================================================================

function getMessageId(messageElement) {
    const mesId = messageElement.getAttribute('mesid');
    if (mesId === null || mesId === undefined) return null;
    return parseInt(mesId, 10);
}

// ============================================================================
// MARKER ATTACHMENT
// ============================================================================

function attachMarkersToMessage(messageElement) {
    if (messageElement.querySelector(`.${START_MARKER_CLASS}`)) return;
    if (messageElement.classList.contains('system')) return;

    const messageId = getMessageId(messageElement);
    if (messageId === null) return;

    const mesButtons = messageElement.querySelector('.mes_buttons');
    if (!mesButtons) return;

    const startButton = createStartMarker();
    const endButton = createEndMarker();

    startButton.addEventListener('click', function(e) {
        e.stopPropagation();
        handleStartClick(messageId);
    });

    endButton.addEventListener('click', function(e) {
        e.stopPropagation();
        handleEndClick(messageId);
    });

    const firstButton = mesButtons.querySelector('.mes_button');
    if (firstButton) {
        mesButtons.insertBefore(endButton, firstButton);
        mesButtons.insertBefore(startButton, firstButton);
    } else {
        mesButtons.appendChild(startButton);
        mesButtons.appendChild(endButton);
    }

    updateMessageMarkerState(messageElement, messageId);
}

export function attachAllMarkers() {
    const messages = document.querySelectorAll('#chat .mes[mesid]');
    messages.forEach(msg => attachMarkersToMessage(msg));
}

export function removeAllMarkers() {
    document.querySelectorAll(`.${START_MARKER_CLASS}`).forEach(m => m.remove());
    document.querySelectorAll(`.${END_MARKER_CLASS}`).forEach(m => m.remove());
}

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

/**
 * Updates marker visibility and state for a message
 */
function updateMessageMarkerState(messageElement, messageId) {
    const startButton = messageElement.querySelector(`.${START_MARKER_CLASS}`);
    const endButton = messageElement.querySelector(`.${END_MARKER_CLASS}`);

    const existingScene = getSceneAtMessage(messageId);
    const isExistingStart = getSceneStartingAt(messageId) !== null;
    const isExistingEnd = getSceneEndingAt(messageId) !== null;
    const isInPendingRange = pendingSceneStart !== null && messageId > pendingSceneStart;

    // START button visibility
    if (startButton) {
        // Always visible, but styled differently based on state
        startButton.style.display = '';
        startButton.classList.toggle('vecthare-active', isExistingStart);
        startButton.classList.toggle('vecthare-pending', pendingSceneStart === messageId);

        if (isExistingStart) {
            startButton.title = sceneCacheEvidence==='MANAGED_SAVED_SCENES_VERIFIED'
                ? 'Saved scene annotation: click to rename or delete (not a vector chunk)'
                : 'Legacy cached scene (UNVERIFIED managed-v2 provenance). Delete requires a separate authorized path.';
        } else if (pendingSceneStart === messageId) {
            startButton.title = 'Cancel pending scene';
        } else {
            startButton.title = 'Mark scene START';
        }
    }

    // END button visibility
    if (endButton) {
        // Only show if: pending exists AND this msg > pending start AND not inside existing scene
        const showEnd = pendingSceneStart !== null &&
                        messageId > pendingSceneStart &&
                        !existingScene;

        endButton.style.display = showEnd ? '' : 'none';
        endButton.title = 'Mark scene END';
    }

    // Visual indicators on message element
    messageElement.classList.remove('vecthare-in-scene', 'vecthare-scene-start', 'vecthare-scene-end', 'vecthare-pending-scene');

    if (existingScene) {
        messageElement.classList.add('vecthare-in-scene');
        if (existingScene.sceneStart === messageId) {
            messageElement.classList.add('vecthare-scene-start');
        }
        if (existingScene.sceneEnd === messageId) {
            messageElement.classList.add('vecthare-scene-end');
        }
    }

    if (pendingSceneStart !== null && messageId >= pendingSceneStart) {
        messageElement.classList.add('vecthare-pending-scene');
    }
}

export function updateAllMarkerStates() {
    const messages = document.querySelectorAll('#chat .mes[mesid]');
    messages.forEach(msg => {
        const messageId = getMessageId(msg);
        if (messageId !== null) {
            updateMessageMarkerState(msg, messageId);
        }
    });
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

/**
 * Handles START button click
 */
async function handleStartClick(messageId) {
    if (requiresManagedSceneContract(currentSettings)) {
        if(sceneCacheEvidence!=='MANAGED_SAVED_SCENES_VERIFIED') {
            toastr.warning('Scene metadata unverified. Refresh scene markers before editing.');return;
        }
        const existing=getSceneStartingAt(messageId);
        if(existing){
            const rename=globalThis.confirm?.(`Rename scene "${existing.title}"?\nOK: rename; Cancel: offer deletion.`)===true;
            let scenes,label;
            if(rename){
                const title=globalThis.prompt?.('New scene title',existing.title);
                if(title===null||title===undefined)return;
                scenes=managedSceneReadback.scenes.map(s=>s.id===existing.sceneId?{...s,title:title.trim()}:s);
                label=`Rename scene "${existing.title}"?`;
            }else{
                if(globalThis.confirm?.(`Delete saved scene annotation "${existing.title}"?`)!==true)return;
                scenes=managedSceneReadback.scenes.filter(s=>s.id!==existing.sceneId);
                label=`Delete scene "${existing.title}"?`;
            }
            try{const result=await saveManagedSceneChanges(scenes,label);
                if(result?.status==='VERIFIED_SAVED_METADATA')toastr.success('Saved scene metadata verified');
            }catch(err){toastr.error(err.message);}return;
        }
        if(getSceneAtMessage(messageId)){
            toastr.warning('Scene overlaps an existing range; edit the existing scene first.');return;
        }
        if(pendingSceneStart===messageId){pendingSceneStart=null;updateAllMarkerStates();return;}
        pendingSceneStart=messageId;
        toastr.info('Scene START selected. Click END to save a scene annotation.');
        updateAllMarkerStates();return;
    }
    if (!currentSettings) {
        toastr.error('VectHare settings not loaded');
        return;
    }

    const existingSceneStart = getSceneStartingAt(messageId);
    const existingSceneAt = getSceneAtMessage(messageId);

    // Case 1: Clicking on existing scene start - offer to delete
    if (existingSceneStart) {
        const confirmDelete = confirm(
            `Delete scene "${existingSceneStart.title || 'Untitled'}" (messages ${existingSceneStart.sceneStart}-${existingSceneStart.sceneEnd})?\n\nThis will re-enable the individual message chunks.`
        );
        if (confirmDelete) {
            const result = await deleteSceneChunk(
                existingSceneStart.hash,
                existingSceneStart.containedHashes,
                currentSettings
            );
            if (result.success) {
                toastr.success('Scene deleted');
                await refreshSceneCache();
                updateAllMarkerStates();
                eventSource.emit('vecthare_scenes_changed');
            } else {
                toastr.error(result.error || 'Failed to delete scene');
            }
        }
        return;
    }

    // Case 2: Clicking on pending start - cancel it
    if (pendingSceneStart === messageId) {
        pendingSceneStart = null;
        toastr.info('Pending scene cancelled');
        updateAllMarkerStates();
        return;
    }

    // Case 3: Inside existing scene - offer to split
    if (existingSceneAt && !existingSceneStart) {
        const confirmSplit = confirm(
            `This message is inside an existing scene (${existingSceneAt.sceneStart}-${existingSceneAt.sceneEnd}).\n\nSplit it? The existing scene will end at message ${messageId - 1}, and a new scene will start here.`
        );
        if (confirmSplit) {
            // C02: original scene cannot be deleted before its shortened
            // replacement has been durably verified. The deployed plugin has
            // no accepted replacement/delete contract, so fail closed.
            toastr.warning('Scene split requires verified replacement; original scene preserved', 'VectHare');
            return;

        }
        return;
    }

    // Case 4: Pending scene exists - offer to close it and start new
    if (pendingSceneStart !== null) {
        const confirmCloseAndStart = confirm(
            `You have a pending scene starting at message ${pendingSceneStart}.\n\nClose it at message ${messageId - 1} and start a new scene here?`
        );
        if (confirmCloseAndStart) {
            // Create the pending scene
            const result = await createSceneChunk(
                pendingSceneStart,
                messageId - 1,
                {},
                currentSettings
            );
            if (result.success) {
                toastr.success(`Scene created (${pendingSceneStart}-${messageId - 1})`);
                pendingSceneStart = messageId;
                toastr.info('New scene started. Mark the end.');
                await refreshSceneCache();
                updateAllMarkerStates();
                eventSource.emit('vecthare_scenes_changed');
            } else {
                toastr.error(result.error || 'Failed to create scene');
            }
        }
        return;
    }

    // Case 5: Normal start - just set pending
    pendingSceneStart = messageId;
    toastr.info('Scene started. Click END on another message to complete it.');
    updateAllMarkerStates();
}

/**
 * Handles END button click
 */
async function handleEndClick(messageId) {
    if (requiresManagedSceneContract(currentSettings)) {
        if(sceneCacheEvidence!=='MANAGED_SAVED_SCENES_VERIFIED'||pendingSceneStart===null){
            toastr.warning('Select a START marker after refreshing verified scene metadata.');return;
        }
        if(messageId<=pendingSceneStart||getSceneAtMessage(messageId)){
            toastr.warning('Scene END must follow START and must not overlap another scene.');return;
        }
        const ctx=getContext(),start=ctx?.chat?.[pendingSceneStart],end=ctx?.chat?.[messageId];
        if(!start||!end){toastr.error('Saved chat message boundaries unavailable');return;}
        const title=globalThis.prompt?.(`Scene title (messages ${pendingSceneStart}–${messageId})`,
            `Scene ${pendingSceneStart}–${messageId}`);
        if(title===null||title===undefined)return;
        try{
            const newScene={id:globalThis.crypto.randomUUID(),start:sceneLocator(start),end:sceneLocator(end),title:title.trim()};
            const result=await saveManagedSceneChanges([...managedSceneReadback.scenes,newScene],`Create scene "${newScene.title}"?`);
            if(result?.status==='VERIFIED_SAVED_METADATA'){
                pendingSceneStart=null;toastr.success('Scene annotation saved and verified in chat metadata');
                updateAllMarkerStates();
            }
        }catch(err){toastr.error(err.message);}
        return;
    }
    if (!currentSettings) {
        toastr.error('VectHare settings not loaded');
        return;
    }

    // No pending scene - shouldn't happen (button should be hidden)
    if (pendingSceneStart === null) {
        toastr.warning('No scene to close');
        return;
    }

    // End before start - shouldn't happen
    if (messageId <= pendingSceneStart) {
        toastr.warning('Scene end must be after start');
        return;
    }

    // Check if end point is inside an existing scene
    const existingSceneAt = getSceneAtMessage(messageId);
    if (existingSceneAt) {
        toastr.error(`Cannot end scene inside existing scene (${existingSceneAt.sceneStart}-${existingSceneAt.sceneEnd})`);
        return;
    }

    // Create the scene
    const result = await createSceneChunk(
        pendingSceneStart,
        messageId,
        {},
        currentSettings
    );

    if (result.success) {
        toastr.success(`Scene created (messages ${pendingSceneStart}-${messageId})`);
        pendingSceneStart = null;
        await refreshSceneCache();
        updateAllMarkerStates();
        eventSource.emit('vecthare_scenes_changed');
    } else {
        toastr.error(result.error || 'Failed to create scene');
    }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

let sceneMarkersInitialized = false;
let observedChatElement = null;
let sceneChatObserver = null;

export function initializeSceneMarkers() {
    if (sceneMarkersInitialized) return;
    sceneMarkersInitialized = true;
    // Watch for new messages via MutationObserver
    sceneChatObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.classList?.contains('mes')) {
                        attachMarkersToMessage(node);
                    }
                    const messages = node.querySelectorAll?.('.mes');
                    messages?.forEach(msg => attachMarkersToMessage(msg));
                }
            }
        }
    });

    // Start observing chat element (may not exist yet at startup)
    const startObserving = () => {
        const chat = document.getElementById('chat');
        if (chat !== observedChatElement) {
            // Disconnect first: an old #chat node may still exist after navigation.
            if (observedChatElement) sceneChatObserver.disconnect();
            observedChatElement = chat;
            if (chat) {
                sceneChatObserver.observe(chat, { childList: true, subtree: true });
                console.log('VectHare Scenes: Chat observer started');
            }
        }
        if (chat) attachAllMarkers();
    };

    // Try immediately
    startObserving();

    // Update states on chat change
    eventSource.on(event_types.CHAT_CHANGED, async () => {
        ++sceneCacheRefreshVersion;
        cachedSceneChunks = [];
        managedSceneReadback=null;
        pendingSceneStart = null; // Clear pending on chat change
        // Ensure observer is running (in case chat element was recreated)
        startObserving();
        const identityAtSchedule = JSON.stringify(currentChatIdentity());
        setTimeout(async () => {
            if (identityAtSchedule !== JSON.stringify(currentChatIdentity())) return;
            await refreshSceneCache();
            if (identityAtSchedule !== JSON.stringify(currentChatIdentity())) return;
            attachAllMarkers();
            updateAllMarkerStates();
        }, 100);
    });

    // Also attach markers when app is ready (covers initial load)
    eventSource.on(event_types.APP_READY, () => {
        startObserving();
        setTimeout(() => {
            attachAllMarkers();
            updateAllMarkerStates();
        }, 200);
    });

    console.log('VectHare Scenes: Markers initialized');
}
