/** C12 scene timelines are chat-owned metadata, never inferred from retrieval hits.
 * Browser settings persistence is debounced and therefore NOT a durable receipt;
 * this store is advisory for temporal scoring, not deletion or migration proof.
 */
import {extension_settings} from '../../../../extensions.js';
import {saveSettingsDebounced} from '../../../../../script.js';
import {parseCollectionKey} from '../utils/collection-keys.js';
import {normalizeSceneTimeline} from '../utils/c12-scene-temporal.js';
import {reconcileSceneBoundaries} from '../utils/record-identity.js';

// In-memory cache of scene listings independently loaded by the marker UI.
// This is advisory scoring context only; it is never used for deletion proof.
const observedTimelines = new Map();
export function acceptSceneTimelineSnapshot(chatOriginId, collectionKey, scenes) {
    if (!chatOriginId || !parseCollectionKey(collectionKey) || !Array.isArray(scenes) || scenes.length > 2000) return false;
    observedTimelines.set(JSON.stringify([chatOriginId,collectionKey]), scenes.map(scene=>({
        chatOriginId,collectionKey,sceneId:String(scene.sceneId ?? scene.hash),
        sceneStart:scene.sceneStart,sceneEnd:scene.sceneEnd,
        sceneStartRef:scene.sceneStartRef,sceneEndRef:scene.sceneEndRef,
    })));
    return true;
}

export function getSceneTimeline(chatOriginId, collectionKey, chat = []) {
    if (!chatOriginId || !parseCollectionKey(collectionKey) || !Array.isArray(chat)) return [];
    const saved = extension_settings?.vecthare?.sceneTimelines?.[chatOriginId]?.[collectionKey];
    // A confirmed local scene creation is stronger than an unverified partial
    // browser listing. Merge by logical scene ID without trusting either as
    // backend ownership or deletion evidence.
    const observed = observedTimelines.get(JSON.stringify([chatOriginId,collectionKey]));
    const map = new Map();
    for (const row of Array.isArray(observed) ? observed : []) map.set(row.sceneId,row);
    for (const row of Array.isArray(saved) ? saved : []) map.set(row.sceneId,row);
    const bucket=[...map.values()];
    const reconciled = bucket.map(row => {
        if (!row.sceneStartRef && !row.sceneEndRef) return row;
        if (!row.sceneStartRef || !row.sceneEndRef) return null;
        const resolved = reconcileSceneBoundaries([{metadata:{...row,isScene:true}}], chatOriginId, chat)[0];
        return resolved?.status === 'ready' ? {...row,...resolved.metadata} : null;
    }).filter(Boolean);
    return normalizeSceneTimeline(chatOriginId,collectionKey,reconciled,chat.length);
}

export function rememberCommittedScene(chatOriginId, collectionKey, scene) {
    if (!chatOriginId || !parseCollectionKey(collectionKey) || !scene?.isScene || scene.sceneStart == null || scene.sceneEnd == null)
        return false;
    const root = extension_settings.vecthare ||= {};
    const chatStore = (root.sceneTimelines ||= {})[chatOriginId] ||= {};
    const entries = chatStore[collectionKey] ||= [];
    const sceneId = String(scene.sceneId ?? scene.hash);
    if (!sceneId || sceneId === 'undefined') return false;
    const entry = {chatOriginId,collectionKey,sceneId,
        sceneStart:scene.sceneStart,sceneEnd:scene.sceneEnd,
        ...(scene.sceneStartRef && scene.sceneEndRef ? {sceneStartRef:scene.sceneStartRef,sceneEndRef:scene.sceneEndRef} : {})};
    const index = entries.findIndex(value => value.sceneId === sceneId);
    if (index >= 0) entries[index] = entry;
    else if (entries.length >= 2000) return false;
    else entries.push(entry);
    // Update the advisory cache immediately after a confirmed scene creation.
    const snapshotKey=JSON.stringify([chatOriginId,collectionKey]);
    const observed=observedTimelines.get(snapshotKey) || [];
    observedTimelines.set(snapshotKey,[...observed.filter(x=>x.sceneId!==sceneId),entry]);
    saveSettingsDebounced();
    return true;
}

export function forgetCommittedScene(chatOriginId, collectionKey, sceneId) {
    if (!chatOriginId || !parseCollectionKey(collectionKey)) return false;
    const entries = extension_settings?.vecthare?.sceneTimelines?.[chatOriginId]?.[collectionKey];
    const index = Array.isArray(entries) ? entries.findIndex(entry=>entry.sceneId===String(sceneId)) : -1;
    const snapshotKey=JSON.stringify([chatOriginId,collectionKey]);
    const observed=observedTimelines.get(snapshotKey);
    const hadObserved=Array.isArray(observed) && observed.some(x=>x.sceneId===String(sceneId));
    if (index < 0 && !hadObserved) return false;
    if (index >= 0) {entries.splice(index,1);saveSettingsDebounced();}
    if (hadObserved) observedTimelines.set(snapshotKey,observed.filter(x=>x.sceneId!==String(sceneId)));
    return true;
}
