/**
 * Defaults for new collections (settings panel: "New Collection Defaults").
 * The Vectorize dialog starts from these and can change them for one
 * vectorization; Sync Chat uses them for a chat vectorized for the first time.
 * Existing collections always keep their own saved settings.
 */
import { extension_settings } from '../../../../extensions.js';
import { getDefaultDecayForType } from './collection-metadata.js';
import { getCleaningSettings, getPatternsForPreset } from './text-cleaning.js';
import { LIVE_CHAT_STRATEGIES } from './content-types.js';

export const KEYWORD_LEVELS = ['off', 'minimal', 'balanced', 'aggressive'];

export function clampBatchSize(value) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? Math.min(20, Math.max(2, n)) : 4;
}

export function clampKeywordWeight(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.min(3, Math.max(0.01, n)) : 1.5;
}

/** The default text cleaning preset (the Text Cleaning manager's selection). */
export function getDefaultCleaningPreset() {
    return getCleaningSettings().selectedPreset || 'custom';
}

/**
 * Cleaning patterns for one vectorization. The default preset gives exactly
 * what the Text Cleaning manager applies.
 */
export function getCleaningPatternsFor(presetId) {
    return getPatternsForPreset(presetId || getDefaultCleaningPreset());
}

/**
 * @param {string} contentType 'chat', 'lorebook', 'document', ...
 * @returns {{keywordLevel: string, keywordBaseWeight: number, cleaningPreset: string, temporalDecay: object,
 *   strategy?: string, conversation_turn_order?: string, batchSize?: number}}
 */
export function getNewCollectionDefaults(contentType) {
    const settings = extension_settings.vecthare || {};
    const defaults = {
        keywordLevel: KEYWORD_LEVELS.includes(settings.keyword_extraction_level) ? settings.keyword_extraction_level : 'balanced',
        keywordBaseWeight: clampKeywordWeight(settings.keyword_base_weight),
        cleaningPreset: getDefaultCleaningPreset(),
        temporalDecay: getDefaultDecayForType(contentType),
    };
    if (contentType === 'chat') {
        defaults.strategy = LIVE_CHAT_STRATEGIES.includes(settings.chunking_strategy) ? settings.chunking_strategy : 'per_message';
        defaults.conversation_turn_order = settings.conversation_turn_order === 'character_user' ? 'character_user' : 'user_character';
        defaults.batchSize = clampBatchSize(settings.batch_size);
    }
    return defaults;
}
