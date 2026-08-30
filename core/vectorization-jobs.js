/**
 * VectHare Vectorization Job Store
 * Persistent job/checkpoint state per chat. Survives ST restarts.
 * Patterns follow eventbase-store.js style: in-memory Map over persisted object,
 * monotonic writes, saveSettingsDebounced.
 */

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { getStringHash } from '../../../../utils.js';
import { getModelField } from './providers.js';

function ensureStore() {
    if (!extension_settings.vecthare) extension_settings.vecthare = {};
    if (!extension_settings.vecthare.vectorization_jobs) {
        extension_settings.vecthare.vectorization_jobs = {};
    }
    return extension_settings.vecthare.vectorization_jobs;
}

export function getJob(chatUUID) {
    if (!chatUUID) return undefined;
    return ensureStore()[chatUUID];
}

export function getJobByChatId(chatId) {
    if (!chatId) return undefined;
    const store = ensureStore();
    for (const uuid of Object.keys(store)) {
        if (String(store[uuid].chatId) === String(chatId)) return store[uuid];
    }
    return undefined;
}

export function createJob({ chatUUID, chatId, collectionId, registryKey, configFingerprint }) {
    if (!chatUUID) return undefined;
    const store = ensureStore();
    store[chatUUID] = {
        chatUUID, chatId, collectionId, registryKey, configFingerprint,
        status: 'running',
        pauseReason: undefined,
        counts: { completed: 0, failed: 0 },
        startedAt: Date.now(),
        updatedAt: Date.now(),
        lastError: null,
    };
    saveSettingsDebounced();
    return store[chatUUID];
}

export function updateJob(chatUUID, patch) {
    if (!chatUUID) return;
    const store = ensureStore();
    const job = store[chatUUID];
    if (!job) return;
    Object.assign(job, patch);
    // Monotonic counts — never regress
    if (patch.counts) {
        job.counts = {
            completed: Math.max(job.counts.completed || 0, patch.counts.completed || 0),
            failed: Math.max(job.counts.failed || 0, patch.counts.failed || 0),
        };
    }
    job.updatedAt = Date.now();
    saveSettingsDebounced();
}

export function deleteJob(chatUUID) {
    if (!chatUUID) return;
    const store = ensureStore();
    if (store[chatUUID]) {
        delete store[chatUUID];
        saveSettingsDebounced();
    }
}

/**
 * On startup: jobs found in 'running'/'error' have no live process behind them
 * (browser closed / crash). Reinterpret as paused-interrupted; caller offers resume.
 */
export function markInterruptedOnStartup() {
    const store = ensureStore();
    let n = 0;
    for (const uuid of Object.keys(store)) {
        const job = store[uuid];
        if (job.status === 'running' || job.status === 'error') {
            job.status = 'paused';
            job.pauseReason = 'interrupted';
            job.updatedAt = Date.now();
            n++;
        }
    }
    if (n > 0) saveSettingsDebounced();
    return n;
}

/** Drop jobs whose chatUUID no longer has a live collection. Call after discovery. */
export function pruneOrphanedJobs(liveRegistryKeys) {
    const store = ensureStore();
    const liveSet = new Set(liveRegistryKeys);
    let n = 0;
    for (const uuid of Object.keys(store)) {
        const job = store[uuid];
        const key = job.registryKey || job.collectionId;
        const bare = String(key).split(':').pop() || key;
        const match = [...liveSet].some(k => k === key || k === bare || String(k).split(':').pop() === bare);
        if (!match) { delete store[uuid]; n++; }
    }
    if (n > 0) saveSettingsDebounced();
    return n;
}

/**
 * Hash of the vectorization-affecting settings. Cleaning preset intentionally
 * EXCLUDED (content changes → hash changes → hash-diff self-heals).
 */
export function computeConfigFingerprint(settings) {
    const mf = getModelField(settings.source);
    return getStringHash(JSON.stringify({
        source: settings.source,
        model: mf ? (settings[mf] || '') : '',
        backend: settings.vector_backend,
        chunking_strategy: settings.chunking_strategy,
        batch_size: settings.batch_size,
        keyword_extraction_level: settings.keyword_extraction_level,
    }));
}
