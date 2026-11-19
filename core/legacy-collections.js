/**
 * VH-061: collections from before 13.31 have no saved settings. Upgrade rule
 * (user, 2026-11-12): Sync is not allowed and the user is asked to
 * re-vectorize. Until then such a collection is
 *  - not used, with one notice, when its model/provider is known and differs
 *    from today's, or when its vector size differs;
 *  - used, marked "needs re-vectorizing", when its model cannot be known and
 *    the size matches.
 */
import { parseRegistryKey } from './collection-ids.js';
import { getCollectionRegistry } from './collection-loader.js';
import { getBackend } from '../backends/backend-manager.js';
import { getModelField } from './providers.js';

const getModelFromSettings = settings => {
    const field = getModelField(settings?.source);
    return field ? settings[field] || '' : '';
};

const verdicts = new Map();   // key -> { usable, reason, stored }
const noticed = new Set();
const needsRebuild = new Set(); // bare ids used with the badge

const bare = id => parseRegistryKey(id).collectionId || id;
const normModel = model => String(model || '').trim().replace(/:latest$/i, '').toLowerCase();
const keyOf = (id, settings) => JSON.stringify([bare(id), settings?.vector_backend || 'standard',
    settings?.source || 'transformers', normModel(getModelFromSettings(settings))]);

export const LEGACY_PROMPT = 'It was made by an older VectHare that did not record its settings. Press Vectorize to rebuild it.';

/** Whether a legacy collection may be searched with today's settings (cached per page). */
export async function legacyVerdict(collectionId, settings) {
    const key = keyOf(collectionId, settings);
    if (verdicts.has(key)) return verdicts.get(key);
    const id = bare(collectionId);
    const backend = String(settings?.vector_backend || 'standard').toLowerCase();
    const todaySource = settings?.source || 'transformers';
    const todayModel = normModel(getModelFromSettings(settings));
    let verdict = { usable: true, reason: null, stored: {} };
    try {
        // Folder-per-provider backends: the registry records the provider it was made with.
        if (['standard', 'vectra', 'lancedb'].includes(backend)) {
            const sources = getCollectionRegistry().map(parseRegistryKey)
                .filter(p => p.collectionId === id && p.backend && p.source).map(p => p.source);
            if (sources.length && !sources.includes(todaySource)) {
                verdict = { usable: false, reason: `it was made with ${[...new Set(sources)].join('/')}, not ${todaySource}`, stored: { source: sources[0] } };
            }
        }
        if (verdict.usable) {
            const adapter = await getBackend(settings);
            const page = await adapter.listChunks(id, settings, { offset: 0, limit: 1, includeVectors: false });
            const meta = page?.items?.[0]?.metadata || {};
            const storedSource = meta.embeddingSource || page?.items?.[0]?.embeddingSource;
            const storedModel = normModel(meta.embeddingModel || page?.items?.[0]?.embeddingModel);
            verdict.stored = { source: storedSource, model: storedModel };
            if (storedSource && storedSource !== todaySource) {
                verdict = { usable: false, reason: `it was made with ${storedSource}, not ${todaySource}`, stored: verdict.stored };
            } else if (storedModel && todayModel && storedModel !== todayModel) {
                verdict = { usable: false, reason: `it was made with the model ${storedModel}, not ${todayModel}`, stored: verdict.stored };
            }
        }
    } catch (error) {
        // Unknown: searched as before (a size mismatch is caught at query time).
        console.debug(`VectHare: could not classify older collection ${id}: ${error.message}`);
    }
    if (verdict.usable) needsRebuild.add(id);
    else needsRebuild.delete(id);
    verdicts.set(key, verdict);
    return verdict;
}

/** A query failed because the vector size differs: not used from now on. */
export function markLegacyMismatch(collectionId, settings, reason) {
    verdicts.set(keyOf(collectionId, settings), { usable: false, reason, stored: {} });
    needsRebuild.delete(bare(collectionId));
}

export const isLegacyCollection = collectionId => needsRebuild.has(bare(collectionId)) ||
    [...verdicts.keys()].some(key => JSON.parse(key)[0] === bare(collectionId));

/** "needs re-vectorizing" badge: a legacy collection that is being used. */
export const legacyNeedsRebuild = collectionId => needsRebuild.has(bare(collectionId));

/** One notice per collection per session. */
export function noteLegacyNotUsed(collectionId, label, reason) {
    const id = bare(collectionId);
    if (noticed.has(id)) return;
    noticed.add(id);
    const what = String(id).startsWith('vecthare_chat_') ? "This chat's memories are" : `"${label || id}" is`;
    globalThis.toastr?.warning?.(`${what} not used: ${reason}. ${LEGACY_PROMPT}`, 'VectHare', { timeOut: 15000 });
}

/** The Sync/Vectorize prompt for a legacy collection (shown once per collection per session). */
export function noteLegacyNeedsRebuild(collectionId, label) {
    const id = bare(collectionId);
    if (noticed.has(`sync:${id}`)) return;
    noticed.add(`sync:${id}`);
    const what = String(id).startsWith('vecthare_chat_') ? "This chat's memories need" : `"${label || id}" needs`;
    globalThis.toastr?.warning?.(`${what} to be re-vectorized before Sync can add to them. ${LEGACY_PROMPT}`, 'VectHare', { timeOut: 15000 });
}
