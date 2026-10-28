import {requireSupportedClassifierMode} from '../utils/feature-support.js';
import {createEmotionSimilarityClassifier, EMOTION_TEST_FIXTURES} from './emotion-similarity.js';
import {createPluginEmotionEmbedder, emotionEmbeddingCapabilities} from './emotion-embedding-provider.js';
/**
 * ============================================================================
 * VECTHARE EMOTION CLASSIFIER
 * ============================================================================
 * Provides emotion classification for Cotton-Tales integration.
 * Supports:
 * - SillyTavern server-managed emotion classifier endpoint
 * - Read-only, server-managed local Transformers embedding similarity
 *
 * @author VectHare
 * @version 1.0.0
 * ============================================================================
 */

import { getRequestHeaders } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const MODULE_NAME = 'VectHare-EmotionClassifier';

/**
 * Historical examples of classifier labels; the live endpoint is server-controlled.
 * Client-side model selection is intentionally not offered.
 */
export const RECOMMENDED_CLASSIFIER_MODELS = [
    {
        id: 'SamLowe/roberta-base-go_emotions',
        name: 'RoBERTa GoEmotions (28 emotions)',
        description: 'Best general-purpose emotion classifier. 28 emotion labels.',
        labels: ['admiration', 'amusement', 'anger', 'annoyance', 'approval', 'caring',
            'confusion', 'curiosity', 'desire', 'disappointment', 'disapproval', 'disgust',
            'embarrassment', 'excitement', 'fear', 'gratitude', 'grief', 'joy', 'love',
            'nervousness', 'optimism', 'pride', 'realization', 'relief', 'remorse',
            'sadness', 'surprise', 'neutral'],
    },
    {
        id: 'j-hartmann/emotion-english-distilroberta-base',
        name: 'DistilRoBERTa Emotion (7 emotions)',
        description: 'Faster, simpler model. 7 basic emotions.',
        labels: ['anger', 'disgust', 'fear', 'joy', 'neutral', 'sadness', 'surprise'],
    },
    {
        id: 'bhadresh-savani/distilbert-base-uncased-emotion',
        name: 'DistilBERT Emotion (6 emotions)',
        description: 'Lightweight model. 6 basic emotions.',
        labels: ['sadness', 'joy', 'love', 'anger', 'fear', 'surprise'],
    },
];

/**
 * Default settings for emotion classifier
 */
export const DEFAULT_CLASSIFIER_SETTINGS = {
    enabled: false,
    model: 'SamLowe/roberta-base-go_emotions',
    useEmbeddingSimilarity: false, // If true, use embedding similarity instead of classifier
    customLabels: [], // Custom emotion labels (empty = use model's default)
};

// =============================================================================
// COTTON-TALES DETECTION
// =============================================================================

/**
 * Check if Cotton-Tales extension is installed
 * @returns {boolean}
 */
export function isCottonTalesInstalled() {
    try {
        // Check for Cotton-Tales settings in extension_settings
        return !!extension_settings?.cotton_tales;
    } catch {
        return false;
    }
}

/**
 * Check if Cotton-Tales is using VectHare for classification
 * @returns {boolean}
 */
export function isCottonTalesUsingVectHare() {
    try {
        const ctSettings = extension_settings?.cotton_tales;
        // EXPRESSION_API.vecthare = 4
        return ctSettings?.expressionApi === 4;
    } catch {
        return false;
    }
}

// =============================================================================
// CLASSIFIER API
// =============================================================================

/** Cache for classifier results */
let classifierCache = new Map();
const CACHE_MAX_SIZE = 100;
// Also protects against requests completing after a settings change/cache clear.
let cacheGeneration = 0;
let similarityRuntime = null;

function activeSimilarity(settings) {
    const source = extension_settings?.vecthare?.source || 'transformers';
    requireSupportedClassifierMode({useEmbeddingSimilarity:true,source});
    const provider = createPluginEmotionEmbedder({settings:{source},request:(url,options)=>fetch(url,{...options,headers:getRequestHeaders()})});
    const signature = provider.profileKey;
    if (similarityRuntime?.signature !== signature) {
        similarityRuntime = {signature, classifier:createEmotionSimilarityClassifier(provider)};
    }
    return similarityRuntime.classifier;
}


/**
 * Use an unambiguous representation of the entire text and the configured
 * classifier behavior. A prefix or short content hash can alias different
 * messages; JSON encoding also avoids delimiter collisions and works on
 * non-secure (plain HTTP) SillyTavern installations without Web Crypto.
 *
 * The current classify endpoint selects its model server-side. We still
 * partition by requested model/mode/labels so changes never reuse results
 * across configurations; honoring those settings is separate C14 work.
 */
function classifierCacheKey(text, settings, options = {}) {
    return JSON.stringify([
        text,
        options.model ?? settings.model,
        options.useEmbeddingSimilarity ?? settings.useEmbeddingSimilarity,
        options.customLabels ?? settings.customLabels,
        extension_settings?.vecthare?.source ?? 'transformers',
        'ct-basic-en-v1',
    ]);
}

/**
 * Clear the classifier cache
 */
export function clearClassifierCache() {
    cacheGeneration++;
    classifierCache.clear();
    similarityRuntime?.classifier.clear();
    similarityRuntime = null;
    console.log(`[${MODULE_NAME}] Classifier cache cleared`);
}

/**
 * Classify emotion using local transformers.js classifier
 * This uses ST's built-in /api/extra/classify endpoint
 *
 * @param {string} text - Text to classify
 * @param {Object} options - Options
 * @param {string} [options.model] - Model to use (default from settings)
 * @returns {Promise<{label: string, score: number}|null>} Classification result
 */
export async function classifyEmotion(text, options = {}) {
    if (!text || typeof text !== 'string') {
        return null;
    }

    const settings = getClassifierSettings();
    if (!settings.enabled) {
        console.debug(`[${MODULE_NAME}] Classifier not enabled`);
        return null;
    }

    // Check cache
    const similarityMode = options.useEmbeddingSimilarity ?? settings.useEmbeddingSimilarity;
    requireSupportedClassifierMode({useEmbeddingSimilarity: similarityMode,source:extension_settings?.vecthare?.source || 'transformers'});
    const cacheKey = classifierCacheKey(text, settings, options);
    const requestGeneration = cacheGeneration;
    if (classifierCache.has(cacheKey)) {
        return classifierCache.get(cacheKey);
    }

    try {
        if (similarityMode) {
            const result = await activeSimilarity(settings).classify(text, {customLabels:options.customLabels ?? settings.customLabels});
            if (requestGeneration === cacheGeneration && result) {
                if (classifierCache.size >= CACHE_MAX_SIZE) classifierCache.delete(classifierCache.keys().next().value);
                classifierCache.set(cacheKey, result);
            }
            return result;
        }
        // Use ST's local classify endpoint
        const response = await fetch('/api/extra/classify', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                text: text,
            }),
        });

        if (!response.ok) {
            console.error(`[${MODULE_NAME}] Classification request failed: ${response.status}`);
            return null;
        }

        const data = await response.json();

        if (!data?.classification?.length) {
            console.debug(`[${MODULE_NAME}] No classification result`);
            return null;
        }

        const result = {
            label: data.classification[0].label,
            score: data.classification[0].score,
            allLabels: data.classification,
        };

        // An older request may finish after a settings change or explicit
        // cache clear. Do not reintroduce a now-invalid result into the cache.
        if (requestGeneration === cacheGeneration) {
            if (classifierCache.size >= CACHE_MAX_SIZE) {
                // Remove oldest entry
                const firstKey = classifierCache.keys().next().value;
                classifierCache.delete(firstKey);
            }
            classifierCache.set(cacheKey, result);
        }

        console.log(`[${MODULE_NAME}] Classified as "${result.label}" (${(result.score * 100).toFixed(1)}%)`);
        return result;
    } catch (error) {
        console.error(`[${MODULE_NAME}] Classification error:`, error);
        return null;
    }
}

/**
 * Test if a model produces emotion-like labels
 * @param {string} model - Model ID to test
 * @returns {Promise<{isEmotionClassifier: boolean, sampleLabels: string[], confidence: string}>}
 */
export async function testClassifierModel() {
    const testTexts = [
        { text: 'I am so happy and excited!', expected: ['joy', 'excitement', 'happiness', 'love'] },
        { text: 'This makes me really angry and frustrated.', expected: ['anger', 'annoyance', 'frustration', 'disgust'] },
        { text: 'I feel sad and disappointed.', expected: ['sadness', 'disappointment', 'grief'] },
    ];

    const results = [];
    const allLabels = new Set();

    for (const test of testTexts) {
        try {
            const response = await fetch('/api/extra/classify', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    text: test.text,
                }),
            });

            if (!response.ok) {
                return {
                    isEmotionClassifier: false,
                    sampleLabels: [],
                    confidence: 'error',
                    error: `HTTP ${response.status}`,
                };
            }

            const data = await response.json();
            // VEC-27: Validate array bounds before access
            if (data?.classification?.length > 0 && data.classification[0]?.label) {
                const topLabel = data.classification[0].label.toLowerCase();
                allLabels.add(topLabel);

                // Check if result matches expected emotions
                const matchesExpected = test.expected.some(exp =>
                    topLabel.includes(exp) || exp.includes(topLabel)
                );
                results.push(matchesExpected);
            }
        } catch (error) {
            return {
                isEmotionClassifier: false,
                sampleLabels: [],
                confidence: 'error',
                error: error.message,
            };
        }
    }

    const matchRate = results.filter(Boolean).length / results.length;
    const labelsArray = Array.from(allLabels);

    // Check if labels look like emotions
    const emotionKeywords = ['joy', 'sad', 'anger', 'fear', 'love', 'surprise', 'disgust',
        'happy', 'neutral', 'excit', 'annoy', 'disappoint', 'grat', 'curious'];
    const looksLikeEmotions = labelsArray.some(label =>
        emotionKeywords.some(kw => label.includes(kw))
    );

    let confidence;
    if (matchRate >= 0.66 && looksLikeEmotions) {
        confidence = 'high';
    } else if (matchRate >= 0.33 || looksLikeEmotions) {
        confidence = 'medium';
    } else {
        confidence = 'low';
    }

    return {
        isEmotionClassifier: confidence !== 'low',
        sampleLabels: labelsArray,
        confidence: confidence,
        matchRate: matchRate,
        modelHonored: false,
    };
}

/** C14: measured test set, not a fabricated accuracy estimate. */
export async function testSimilarityClassifier(fixtures=EMOTION_TEST_FIXTURES) {
    const settings=getClassifierSettings();
    const classifier=activeSimilarity(settings);
    return classifier.evaluate(fixtures,{customLabels:settings.customLabels});
}

/** Server controls the classifier model. The plugin embedding source is verified only for Transformers. */
export function getClassifierCapabilities() {
    const source=extension_settings?.vecthare?.source||'transformers';
    return {classifier:{supported:true,modelHonored:false,model:'server-controlled'},
        similarity:emotionEmbeddingCapabilities({source})};
}

// =============================================================================
// SETTINGS MANAGEMENT
// =============================================================================

/**
 * Get classifier settings from VectHare extension settings
 * @returns {Object} Classifier settings
 */
export function getClassifierSettings() {
    const vhSettings = extension_settings?.vecthare || {};
    return {
        enabled: vhSettings.emotion_classifier_enabled ?? DEFAULT_CLASSIFIER_SETTINGS.enabled,
        model: vhSettings.emotion_classifier_model ?? DEFAULT_CLASSIFIER_SETTINGS.model,
        useEmbeddingSimilarity: vhSettings.emotion_use_similarity ?? DEFAULT_CLASSIFIER_SETTINGS.useEmbeddingSimilarity,
        customLabels: vhSettings.emotion_custom_labels ?? DEFAULT_CLASSIFIER_SETTINGS.customLabels,
    };
}

/**
 * Update classifier setting
 * @param {string} key - Setting key
 * @param {any} value - Setting value
 */
export function updateClassifierSetting(key, value) {
    if (!extension_settings.vecthare) {
        extension_settings.vecthare = {};
    }

    const keyMap = {
        enabled: 'emotion_classifier_enabled',
        model: 'emotion_classifier_model',
        useEmbeddingSimilarity: 'emotion_use_similarity',
        customLabels: 'emotion_custom_labels',
    };

    const settingKey = keyMap[key] || key;
    extension_settings.vecthare[settingKey] = value;

    // Enabled state, classifier mode, selected model, and label set all
    // change classification semantics. Keep existing cached responses isolated
    // even when the settings UI is changed while a request is in flight.
    if (['enabled', 'model', 'useEmbeddingSimilarity', 'customLabels'].includes(key) ||
        ['emotion_classifier_enabled', 'emotion_classifier_model',
            'emotion_use_similarity', 'emotion_custom_labels'].includes(settingKey)) {
        clearClassifierCache();
    }

    console.log(`[${MODULE_NAME}] Setting ${settingKey} = ${value}`);
}

// =============================================================================
// EXPORTS FOR COTTON-TALES
// =============================================================================

/**
 * Public API for Cotton-Tales to call
 * Exposed on window for cross-extension access
 */
export const CottonTalesAPI = {
    classifyEmotion,
    testClassifierModel,
    testSimilarityClassifier,
    getClassifierCapabilities,
    getClassifierSettings,
    clearClassifierCache,
    isCottonTalesInstalled,
    RECOMMENDED_CLASSIFIER_MODELS,
};

// Expose to window for Cotton-Tales access
if (typeof window !== 'undefined') {
    window.VectHareEmotionClassifier = CottonTalesAPI;
}
