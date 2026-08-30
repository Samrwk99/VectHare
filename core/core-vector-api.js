/**
 * ============================================================================
 * CORE VECTOR API CLIENT
 * ============================================================================
 * Abstraction layer for vector operations.
 * Routes to different backends: ST's Vectra API, LanceDB, or Qdrant.
 *
 * Functions:
 * - getVectorsRequestBody() - Builds request body for embedding providers
 * - getAdditionalArgs() - Special handling for WebLLM/KoboldCpp
 * - throwIfSourceInvalid() - Validates provider configuration
 * - getSavedHashes() - GET existing hashes from a collection
 * - insertVectorItems() - POST embeddings to backend
 * - queryCollection() - POST query to find similar vectors
 * - queryMultipleCollections() - POST query across multiple collections
 * - deleteVectorItems() - DELETE specific hashes
 * - purgeVectorIndex() - DELETE entire collection
 * - purgeAllVectorIndexes() - DELETE all collections
 * - purgeFileVectorIndex() - DELETE file-specific collection
 *
 * @author Base: Cohee#1207 | VectHare: Backend abstraction
 * ============================================================================
 */

import { getRequestHeaders } from '../../../../../script.js';
import { extension_settings, modules } from '../../../../extensions.js';
import { secret_state } from '../../../../secrets.js';
import { textgen_types, textgenerationwebui_settings } from '../../../../textgen-settings.js';
import { oai_settings } from '../../../../openai.js';
import { isWebLlmSupported } from '../../../shared.js';
import { getWebLlmProvider } from '../providers/webllm.js';
import { getBackend, invalidateBackendHealth, recordQuery, recordInsert, recordDelete, recordError } from '../backends/backend-manager.js';
import {
    getProviderConfig,
    getModelField,
    getSecretKey,
    requiresApiKey,
    requiresUrl,
    getUrlProviders
} from './providers.js';
import { applyKeywordBoosts, getOverfetchAmount } from './keyword-boost.js';
import { applyBM25Scoring } from './bm25-scorer.js';
import { hybridSearch } from './hybrid-search.js';
import AsyncUtils from '../utils/async-utils.js';
import StringUtils from '../utils/string-utils.js';
import {
    RATE_LIMIT_CALLS,
    RATE_LIMIT_WINDOW_MS,
    API_TIMEOUT_MS,
    RETRY_MAX_ATTEMPTS,
    RETRY_INITIAL_DELAY_MS,
    RETRY_MAX_DELAY_MS,
    RETRY_BACKOFF_MULTIPLIER
} from './constants.js';

// Get shared WebLLM provider singleton (lazy-initialized)
const webllmProvider = getWebLlmProvider();

/**
 * VEC-33: Wrapper for backend operations that invalidates health cache on error
 * @param {Function} operation - Async function that performs the backend operation
 * @param {object} settings - Settings object (used to determine backend name)
 * @returns {Promise<any>} Result of the operation
 * @throws {Error} Re-throws the original error after invalidating cache
 */
async function withHealthInvalidation(operation, settings) {
    try {
        return await operation();
    } catch (error) {
        // Invalidate health cache for the backend that failed
        const backendName = settings?.vector_backend || 'standard';
        invalidateBackendHealth(backendName, error);
        throw error;
    }
}

/**
 * Rate limiter that respects user settings dynamically.
 */
class DynamicRateLimiter {
    constructor() {
        this.timestamps = [];
    }

    /**
     * Executes a function if rate limits allow, or waits until they do.
     * @param {Function} fn Function to execute
     * @param {object} settings Settings containing rate_limit_calls and rate_limit_interval
     * @returns {Promise<any>} Result of the function
     */
    async execute(fn, settings) {
        const maxCalls = settings.rate_limit_calls || 0; // 0 = disabled
        const intervalMs = (settings.rate_limit_interval || 60) * 1000;

        if (maxCalls <= 0) {
            return await fn();
        }

        // Clean up old timestamps
        const now = Date.now();
        this.timestamps = this.timestamps.filter(t => now - t < intervalMs);

        if (this.timestamps.length >= maxCalls) {
            // Calculate wait time
            const oldest = this.timestamps[0];
            const waitTime = (oldest + intervalMs) - now;

            if (waitTime > 0) {
                console.log(`VectHare: Rate limit reached. Waiting ${Math.round(waitTime / 1000)}s...`);
                await AsyncUtils.sleep(waitTime + 100); // Add small buffer
            }

            // Recursive call to re-check
            return this.execute(fn, settings);
        }

        // Add timestamp and execute
        this.timestamps.push(Date.now());
        return await fn();
    }
}

// Global rate limiter instance
const dynamicRateLimiter = new DynamicRateLimiter();

/**
 * Helper to batch array into chunks
 * @template T
 * @param {T[]} array
 * @param {number} size
 * @returns {T[][]}
 */
function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

/**
 * Throw an AbortError when the caller's signal has already been cancelled.
 * Central helper so every abort check site throws an identical error.
 * @param {AbortSignal|null} abortSignal
 */
function throwIfAborted(abortSignal) {
    if (abortSignal?.aborted) {
        throw Object.assign(new Error('Vectorization stopped by user'), { name: 'AbortError' });
    }
}

/**
 * callWithHedge — fire a duplicate request after a threshold to dodge connection-level
 * routing stalls on multi-upstream embedding providers. Race-first-wins via Promise.
 *
 * Two triggers, one ordered sequence of hedges:
 *   - the fixed schedule (t = i * thresholdMs) covers attempts that HANG;
 *   - an attempt that FAILS brings the next hedge forward immediately.
 * Attempts cap at maxHedges + 1 either way.
 *
 * Hedge-fatal: if all attempts fail, throws Error with
 *   name === 'HedgeFatalError' and isHedgeFatal === true.
 *
 * @param {Function} fn - Async function (each invocation must be safe to repeat;
 *   deterministic text -> deterministic embedding -> idempotent upsert by hash)
 * @param {number} thresholdMs - Time between attempts (e.g., 15000)
 * @param {number} maxHedges - Number of hedges after primary (e.g., 3)
 * @param {object} ctx - { debugOn, batchIdx, totalBatches, provider } for logging
 * @returns {Promise<*>} Result of the first attempt to succeed
 */
export function callWithHedge(fn, thresholdMs, maxHedges, ctx) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timers = [];
        const errors = [];
        const { debugOn, batchIdx, totalBatches, provider } = ctx || {};

        const settle = (kind, val) => {
            if (settled) return;
            settled = true;
            for (const t of timers) clearTimeout(t);
            if (kind === 'ok') resolve(val); else reject(val);
        };

        const label = (i) => (i === 0 ? 'primary' : `hedge ${i}/${maxHedges}`);

        let hedgesFired = 0;
        let attemptsInFlight = 0;
        const hedgeTimers = new Map();

        const buildHedgeFatal = () => {
            const lastError = errors.length ? errors[errors.length - 1].error : null;
            const tail = lastError
                ? `last error: ${lastError?.name || 'Error'}: ${lastError?.message || lastError}`
                : `${maxHedges + 1} attempts still in-flight at cutoff, none returned`;
            const fatalErr = new Error(
                `Hedge fatal: ${maxHedges + 1} attempts to ${provider} over ${((maxHedges + 1) * thresholdMs) / 1000}s — ${tail}`,
            );
            fatalErr.name = 'HedgeFatalError';
            fatalErr.isHedgeFatal = true;
            return fatalErr;
        };

        const startHedge = (i, isEarly) => {
            if (settled || i > maxHedges) return;
            hedgesFired = i;
            const scheduled = hedgeTimers.get(i);
            if (scheduled) {
                clearTimeout(scheduled);
                hedgeTimers.delete(i);
            }
            if (debugOn) {
                console.warn(isEarly
                    ? `VectHare: hedge ${i}/${maxHedges} firing early — batch ${batchIdx}/${totalBatches} via ${provider} (previous attempt FAILED)`
                    : `VectHare: hedge ${i}/${maxHedges} firing at t=${(i * thresholdMs) / 1000}s — batch ${batchIdx}/${totalBatches} via ${provider} (previous attempt still running)`);
            }
            fire(i);
        };

        const fire = (attemptIdx) => {
            const start = performance.now();
            attemptsInFlight++;
            fn().then(
                (r) => {
                    attemptsInFlight--;
                    if (settled) return;
                    if (attemptIdx > 0) {
                        console.warn(`VectHare: hedge — ${label(attemptIdx)} WON for batch ${batchIdx}/${totalBatches} via ${provider} after ${((performance.now() - start) / 1000).toFixed(1)}s`);
                    } else {
                        console.log(`VectHare: hedge — primary WON for batch ${batchIdx}/${totalBatches} via ${provider} after ${((performance.now() - start) / 1000).toFixed(1)}s`);
                    }
                    settle('ok', r);
                },
                (e) => {
                    attemptsInFlight--;
                    errors.push({ attemptIdx, error: e });
                    if (debugOn && !settled) {
                        console.warn(`VectHare: hedge — ${label(attemptIdx)} FAILED after ${((performance.now() - start) / 1000).toFixed(1)}s for batch ${batchIdx}/${totalBatches} — ${e?.name || 'Error'}: ${e?.message || e}`);
                    }
                    // Abort short-circuit: user pressed Stop; stop firing hedges.
                    if (e?.name === 'AbortError') {
                        settle('err', e);
                        return;
                    }
                    if (settled) return;
                    if (hedgesFired < maxHedges) {
                        startHedge(hedgesFired + 1, true);
                        return;
                    }
                    // Last attempt, nothing left in flight: every attempt has failed.
                    if (attemptsInFlight === 0) settle('err', buildHedgeFatal());
                },
            );
        };

        // Primary at t=0
        fire(0);

        // Schedule hedges on the fixed clock
        for (let i = 1; i <= maxHedges; i++) {
            const scheduled = setTimeout(() => {
                if (settled || hedgesFired >= i) return;
                startHedge(i, false);
            }, i * thresholdMs);
            hedgeTimers.set(i, scheduled);
            timers.push(scheduled);
        }

        // Hard fatal cutoff
        timers.push(setTimeout(() => {
            if (settled) return;
            settle('err', buildHedgeFatal());
        }, (maxHedges + 1) * thresholdMs));
    });
}

// Retry configuration for transient failures (matches AsyncUtils.retry signature)
const RETRY_CONFIG = {
    maxAttempts: RETRY_MAX_ATTEMPTS,
    delay: RETRY_INITIAL_DELAY_MS,
    maxDelay: RETRY_MAX_DELAY_MS,
    backoffFactor: RETRY_BACKOFF_MULTIPLIER,
    shouldRetry: (error) => {
        // Hedge-fatal: the hedge already burned maxHedges+1 fresh-connection attempts.
        // An immediate outer retry would just re-trigger another hedge cycle — throw up.
        if (error?.isHedgeFatal === true) return false;
        // AbortSignal.timeout()'s DOMException ("TimeoutError" / "signal timed out")
        // — the word form "timed out" was missed by the keyword list, so embedding
        // stalls tripped the HTTP timeout and silently killed the run mid-way.
        if (error?.name === 'TimeoutError') return true;
        const message = error?.message?.toLowerCase() || '';
        const isRetryable =
            message.includes('network') ||
            message.includes('timeout') ||
            message.includes('timed out') ||
            message.includes('failed to fetch') ||
            message.includes('fetch') ||
            message.includes('suspended') ||
            message.includes('429') ||
            message.includes('rate limit') ||
            message.includes('too many requests') ||
            message.includes('502') ||
            message.includes('503') ||
            message.includes('504');
        return isRetryable;
    }
};

/**
 * Strips HTML and Markdown formatting from text before embedding.
 * Uses StringUtils from ST-Helpers for consistent text cleaning.
 * @param {string} text - Text to clean
 * @returns {string} Cleaned text
 */
function stripFormatting(text) {
    if (!text || typeof text !== 'string') {
        return text;
    }
    // Strip HTML first, then Markdown
    let cleaned = StringUtils.stripHtml(text, true);
    cleaned = StringUtils.stripMarkdown(cleaned);
    return cleaned.trim();
}

/**
 * Gets common body parameters for vector requests.
 * @param {object} args Additional arguments
 * @param {object} settings VectHare settings object
 * @returns {object} Request body
 */
export function getVectorsRequestBody(args = {}, settings) {
    const body = Object.assign({}, args);
    switch (settings.source) {
        case 'extras':
            body.extrasUrl = extension_settings.apiUrl;
            body.extrasKey = extension_settings.apiKey;
            break;
        case 'electronhub':
            body.model = settings.electronhub_model;
            break;
        case 'openrouter':
            body.model = settings.openrouter_model;
            break;
        case 'togetherai':
            body.model = settings.togetherai_model;
            break;
        case 'openai':
            body.model = settings.openai_model;
            break;
        case 'cohere':
            body.model = settings.cohere_model;
            break;
        case 'ollama':
            body.model = settings.ollama_model;
            body.apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.OLLAMA];
            body.keep = !!settings.ollama_keep;
            break;
        case 'llamacpp':
            body.apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.LLAMACPP];
            console.log(`VectHare DEBUG llamacpp (core-vector-api): use_alt_endpoint=${settings.use_alt_endpoint}, alt_endpoint_url="${settings.alt_endpoint_url}", ST_url="${textgenerationwebui_settings.server_urls[textgen_types.LLAMACPP]}", final apiUrl="${body.apiUrl}"`);
            break;
        case 'vllm':
            body.apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.VLLM];
            body.model = settings.vllm_model;
            break;
        case 'bananabread':
            body.apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : 'http://localhost:8008';
            // Use extension settings for API key (custom keys aren't returned by ST's readSecretState)
            if (settings.bananabread_api_key) {
                body.apiKey = settings.bananabread_api_key;
            }
            break;
        case 'webllm':
            body.model = settings.webllm_model;
            break;
        case 'palm':
            body.model = settings.google_model;
            body.api = 'makersuite';
            break;
        case 'vertexai':
            body.model = settings.google_model;
            body.api = 'vertexai';
            body.vertexai_auth_mode = oai_settings.vertexai_auth_mode;
            body.vertexai_region = oai_settings.vertexai_region;
            body.vertexai_express_project_id = oai_settings.vertexai_express_project_id;
            break;
        default:
            break;
    }
    return body;
}

/**
 * Gets additional arguments for embeddings.
 * For client-side providers (webllm, koboldcpp, bananabread), this generates embeddings.
 * @param {string[]} items Items to embed
 * @param {object} settings VectHare settings object
 * @param {Function} onProgress - Optional callback (embedded, total) => void for progress updates
 * @returns {Promise<object>} Additional arguments
 */
export async function getAdditionalArgs(items, settings, onProgress = null) {
    const args = {};
    switch (settings.source) {
        case 'webllm':
            args.embeddings = await createWebLlmEmbeddings(items, settings);
            break;
        case 'koboldcpp': {
            const { embeddings, model } = await createKoboldCppEmbeddings(items, settings, onProgress);
            args.embeddings = embeddings;
            args.model = model;
            break;
        }
        case 'bananabread': {
            const { embeddings, model } = await createBananaBreadEmbeddings(items, settings);
            args.embeddings = embeddings;
            args.model = model;
            break;
        }
    }
    return args;
}

/**
 * Creates WebLLM embeddings for a list of items.
 * Wrapped with retry and timeout for robustness.
 * @param {string[]} items Items to embed
 * @param {object} settings VectHare settings object
 * @returns {Promise<Record<string, number[]>>} Calculated embeddings
 */
async function createWebLlmEmbeddings(items, settings) {
    if (items.length === 0) {
        return /** @type {Record<string, number[]>} */ ({});
    }

    if (!isWebLlmSupported()) {
        throw new Error('VectHare: WebLLM is not supported', { cause: 'webllm_not_supported' });
    }

    // Clean text before embedding
    const cleanedItems = items.map(item => stripFormatting(item) || item);

    return await AsyncUtils.retry(async () => {
        const embedPromise = webllmProvider.embedTexts(cleanedItems, settings.webllm_model);
        const embeddings = await AsyncUtils.timeout(embedPromise, API_TIMEOUT_MS * 2, 'WebLLM embedding request timed out');

        const result = /** @type {Record<string, number[]>} */ ({});
        for (let i = 0; i < items.length; i++) {
            // Map back to original items for hash consistency
            result[items[i]] = embeddings[i];
        }
        return result;
    }, {
        ...RETRY_CONFIG,
        onRetry: (attempt, error) => {
            console.warn(`VectHare: WebLLM embedding retry ${attempt} - ${error.message}`);
        }
    });
}

/**
 * Creates KoboldCpp embeddings for a list of items.
 * Wrapped with retry and rate limiting for robustness.
 * @param {string[]} items Items to embed
 * @param {object} settings VectHare settings object
 * @param {Function} onProgress - Optional callback (embedded, total) => void for progress updates
 * @returns {Promise<{embeddings: Record<string, number[]>, model: string}>} Calculated embeddings
 */
async function createKoboldCppEmbeddings(items, settings, onProgress = null) {
    // Clean text before embedding (strip HTML/Markdown)
    const cleanedItems = items.map(item => stripFormatting(item) || item);

    // Batch size for progress tracking
    const BATCH_SIZE = 10;
    const allEmbeddings = /** @type {Record<string, number[]>} */ ({});
    let modelName = 'koboldcpp';

    // Process in batches to show progress
    for (let i = 0; i < cleanedItems.length; i += BATCH_SIZE) {
        const batchItems = cleanedItems.slice(i, Math.min(i + BATCH_SIZE, cleanedItems.length));
        const originalBatchItems = items.slice(i, Math.min(i + BATCH_SIZE, items.length));

        const result = await dynamicRateLimiter.execute(async () => {
            return await AsyncUtils.retry(async () => {
                const serverUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.KOBOLDCPP];
                if (!serverUrl) {
                    throw new Error('KoboldCpp URL not found');
                }

                const cleanUrl = serverUrl.replace(/\/$/, '');
                const response = await fetch(`${cleanUrl}/v1/embeddings`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        input: batchItems,
                        model: settings.koboldcpp_model || 'koboldcpp',
                    }),
                });

                if (!response.ok) {
                    // Try legacy endpoint if v1 fails (fallback)
                    if (response.status === 404) {
                        console.warn('VectHare: KoboldCpp /v1/embeddings not found, trying legacy endpoint...');
                        // Fallthrough to retry or handle legacy?
                        // Better to throw specific error so we can potentially retry with legacy logic if we wanted,
                        // but for now let's stick to the directive of using OpenAI compatible endpoint.
                    }
                    throw new Error(`Failed to get KoboldCpp embeddings: ${response.status} ${response.statusText}`);
                }

                const data = await response.json();

                // OpenAI format: { data: [{ embedding: [], index: 0, ... }, ...], model: "..." }
                if (!data.data || !Array.isArray(data.data) || data.data.length !== batchItems.length) {
                     throw new Error('Invalid response from KoboldCpp embeddings (OpenAI format)');
                }

                // Sort by index to ensure order matches items
                data.data.sort((a, b) => a.index - b.index);

                const batchEmbeddings = {};
                for (let j = 0; j < data.data.length; j++) {
                    const embedding = data.data[j].embedding;
                    if (!Array.isArray(embedding) || embedding.length === 0) {
                        throw new Error('KoboldCpp returned an empty embedding.');
                    }
                    // Map back to original items (not cleaned) for hash consistency
                    batchEmbeddings[originalBatchItems[j]] = embedding;
                }

                return {
                    embeddings: batchEmbeddings,
                    model: data.model || 'koboldcpp',
                };
            }, {
                ...RETRY_CONFIG,
                onRetry: (attempt, error) => {
                    console.warn(`VectHare: KoboldCpp embedding retry ${attempt} - ${error.message}`);
                }
            });
        }, settings);

        // Merge batch embeddings into all embeddings
        Object.assign(allEmbeddings, result.embeddings);
        modelName = result.model;

        // Call progress callback after each batch
        const embeddedSoFar = Math.min(i + BATCH_SIZE, items.length);
        if (onProgress) {
            console.log(`[KoboldCpp] Calling progress callback: ${embeddedSoFar}/${items.length}`);
            onProgress(embeddedSoFar, items.length);
        }
    }

    return {
        embeddings: allEmbeddings,
        model: modelName,
    };
}

/**
 * Creates BananaBread embeddings for a list of items.
 * Wrapped with retry, timeout, and rate limiting for robustness.
 * @param {string[]} items Items to embed
 * @param {object} settings VectHare settings object
 * @returns {Promise<{embeddings: number[][], model: string}>} Calculated embeddings as array (index-aligned with input items)
 */
async function createBananaBreadEmbeddings(items, settings) {
    // Clean text before embedding (strip HTML/Markdown & Handle mixed types: strings vs objects)
    // Note: Must preserve 1:1 mapping with input items, so we replace empty strings with space instead of filtering
    const cleanedItems = items.map(item => {
        let text = '';
        // 1. Handle primitive strings
        if (typeof item === 'string') {
            text = stripFormatting(item) || item;
        }
        // 2. Handle objects: Extract known text fields (e.g., item.text, item.content)
        else if (item && typeof item === 'object') {
            const textValue = item.text || item.content || '';
            text = stripFormatting(textValue) || textValue;
        }

        // 3. Fallback for unexpected types or empty result
        return text.length > 0 ? text : ' ';
    });

    return await dynamicRateLimiter.execute(async () => {
        return await AsyncUtils.retry(async () => {
            const serverUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : 'http://localhost:8008';
            const cleanUrl = serverUrl.replace(/\/$/, '');

            const headers = {
                'Content-Type': 'application/json',
            };

            // Use extension settings for API key (custom keys aren't returned by ST's readSecretState)
            if (settings.bananabread_api_key) {
                headers['Authorization'] = `Bearer ${settings.bananabread_api_key}`;
            }

            const fetchPromise = fetch(`${cleanUrl}/v1/embeddings`, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({
                    input: cleanedItems,
                    model: settings.bananabread_model || 'bananabread',
                }),
            });

            const response = await AsyncUtils.timeout(fetchPromise, API_TIMEOUT_MS * 20, 'BananaBread embedding request timed out');

            if (!response.ok) {
                throw new Error(`Failed to get BananaBread embeddings: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();

            // OpenAI format: { data: [{ embedding: [], index: 0, ... }, ...], model: "..." }
            if (!data.data || !Array.isArray(data.data) || data.data.length !== cleanedItems.length) {
                throw new Error(`Invalid response from BananaBread embeddings (OpenAI format): expected ${cleanedItems.length} embeddings, got ${data.data?.length || 0}`);
            }

            // Sort by index to ensure order matches input items
            data.data.sort((a, b) => a.index - b.index);

            // Build map of embeddings keyed by original item text
            const embeddings = /** @type {Record<string, number[]>} */ ({});
            for (let i = 0; i < data.data.length; i++) {
                const embedding = data.data[i].embedding;
                if (!Array.isArray(embedding) || embedding.length === 0) {
                    throw new Error(`BananaBread returned an empty or invalid embedding at index ${i}.`);
                }
                // Map back to original items for hash consistency/lookup
                embeddings[items[i]] = embedding;
            }

            return {
                embeddings: embeddings,
                model: data.model || 'bananabread',
            };
        }, {
            ...RETRY_CONFIG,
            onRetry: (attempt, error) => {
                console.warn(`VectHare: BananaBread embedding retry ${attempt} - ${error.message}`);
            }
        });
    }, settings);
}

/**
 * Throws an error if the source is invalid (missing API key or URL, or missing module)
 * @param {object} settings VectHare settings object
 */
export function throwIfSourceInvalid(settings) {
    const source = settings.source;
    const config = getProviderConfig(source);

    if (!config) {
        throw new Error(`VectHare: Unknown provider ${source}`, { cause: 'unknown_provider' });
    }

    // Check API key requirement
    if (requiresApiKey(source)) {
        const secretKey = getSecretKey(source);
        if (secretKey && !secret_state[secretKey]) {
            // Special case: VertexAI can use service account as fallback
            if (source === 'vertexai' && secret_state['VERTEXAI_SERVICE_ACCOUNT']) {
                // Service account auth is available, continue
            } else {
                throw new Error('VectHare: API key missing', { cause: 'api_key_missing' });
            }
        }
    }

    // Check URL requirement
    if (requiresUrl(source)) {
        if (settings.use_alt_endpoint) {
            if (!settings.alt_endpoint_url) {
                throw new Error('VectHare: API URL missing', { cause: 'api_url_missing' });
            }
        } else {
            // Check textgen settings for local providers
            const textgenMapping = {
                'ollama': textgen_types.OLLAMA,
                'vllm': textgen_types.VLLM,
                'koboldcpp': textgen_types.KOBOLDCPP,
                'llamacpp': textgen_types.LLAMACPP
            };

            if (textgenMapping[source] && !textgenerationwebui_settings.server_urls[textgenMapping[source]]) {
                throw new Error('VectHare: API URL missing', { cause: 'api_url_missing' });
            }
        }
    }

    // Check model requirement
    if (config.requiresModel) {
        const modelField = getModelField(source);
        if (modelField && !settings[modelField]) {
            throw new Error('VectHare: API model missing', { cause: 'api_model_missing' });
        }
    }

    // Special case: extras requires embeddings module
    if (source === 'extras' && !modules.includes('embeddings')) {
        throw new Error('VectHare: Embeddings module missing', { cause: 'extras_module_missing' });
    }

    // Special case: WebLLM requires browser support
    if (source === 'webllm' && !isWebLlmSupported()) {
        throw new Error('VectHare: WebLLM is not supported', { cause: 'webllm_not_supported' });
    }
}

/**
 * Gets the saved hashes for a collection
 * @param {string} collectionId Collection ID
 * @param {object} settings VectHare settings object
 * @param {boolean} includeMetadata If true, returns {hashes: [], metadata: []} instead of just hashes
 * @returns {Promise<number[]|{hashes: number[], metadata: object[]}>} Saved hashes or full data
 */
export async function getSavedHashes(collectionId, settings, includeMetadata = false) {
    const backend = await getBackend(settings);
    const hashes = await backend.getSavedHashes(collectionId, settings);

    if (!includeMetadata) {
        return hashes;
    }

    // Use unified chunks API to get full metadata (works with all backends)
    try {
        const backendName = settings.vector_backend || 'standard';
        // Resolve the model from the provider's actual settings field — settings.model
        // does not exist; the old lookup silently sent an empty model, mispairing
        // metadata reads whenever the plugin needed it to route the correct index.
        const modelField = getModelField(settings.source);
        const model = modelField ? (settings[modelField] || '') : '';
        const response = await fetch('/api/plugins/similharity/chunks/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                backend: backendName === 'standard' ? 'vectra' : backendName,
                collectionId: collectionId,
                source: settings.source || 'transformers',
                model: model,
                limit: 10000
            })
        });

        if (response.ok) {
            const data = await response.json();
            if (data.success && data.items) {
                return {
                    hashes: hashes,
                    metadata: data.items.map(item => item.metadata || item)
                };
            }
        }
    } catch (error) {
        console.warn('VectHare: Failed to get full metadata from chunks API, returning hashes only', error);
    }

    // Fallback: return hashes as array (old format)
    return hashes;
}

/**
 * Inserts vector items into a collection
 * Handles batching, rate limiting, hedging, and parallel-split.
 * For client-side embedding sources (webllm, koboldcpp, bananabread), generates embeddings first.
 * @param {string} collectionId - The collection to insert into
 * @param {{ hash: number, text: string }[]} items - The items to insert
 * @param {object} settings VectHare settings object
 * @param {Function} onProgress - Optional callback (embedded, total) => void for progress updates
 * @param {AbortSignal|null} [abortSignal] - Optional abort signal for Pause/Stop
 * @returns {Promise<void>}
 */
export async function insertVectorItems(collectionId, items, settings, onProgress = null, abortSignal = null) {
    throwIfAborted(abortSignal);
    const backend = await getBackend(settings);

    // Sources that require client-side embedding generation
    const clientSideEmbeddingSources = ['webllm', 'koboldcpp', 'bananabread'];

    try {
        // If source requires client-side embeddings, use streaming approach
        if (clientSideEmbeddingSources.includes(settings.source)) {
            console.log(`VectHare: Streaming embeddings and writing for ${settings.source}...`);

            // Extract text strings - getAdditionalArgs expects string[], not objects
            const textStrings = items.map(item => {
                const text = item.text || item;
                // Ensure we have valid text (not empty after cleaning)
                return typeof text === 'string' && text.trim().length > 0 ? text : ' ';
            });

            // Use streaming embedding generation with immediate writes
            await streamEmbeddingsAndWrite(backend, collectionId, items, textStrings, settings, onProgress, abortSignal);
        } else {
            // Server-side embeddings - backend handles everything
            // Local-GPU sources work best with batch size 1 (and skip hedge/parallel-split,
            // which are pointless against a single fixed endpoint).
            const localGpuSources = ['transformers', 'ollama', 'llamacpp', 'koboldcpp', 'bananabread'];
            const configuredBatchSize = settings.insert_batch_size || 50;
            const hasExplicitBatchSize = !!settings.insert_batch_size;
            const hasRateLimit = settings.rate_limit_calls > 0;

            // Parallel-split (VectFox port): each item becomes its own insert POST, fired
            // in parallel waves. Contains the blast radius when ONE upstream worker is
            // stuck — the stuck item retries in isolation while the rest finish.
            // Opt-in via settings.vector_group_embedding_call (true = legacy batched POST).
            const groupEmbeddingCall = settings?.vector_group_embedding_call === true;
            const shouldParallelSplit = (
                !groupEmbeddingCall
                && !localGpuSources.includes(settings.source)
                && !hasRateLimit
                && items.length > 1
            );

            const BATCH_SIZE = shouldParallelSplit
                ? 1
                : ((!hasExplicitBatchSize && localGpuSources.includes(settings.source)) ? 1 : configuredBatchSize);
            const batches = chunkArray(items, BATCH_SIZE);

            const hasHedgeSetting = (Number(settings.vector_hedge_after_ms) || 0) > 0;
            const hedgeEnabled = hasHedgeSetting && !localGpuSources.includes(settings.source);
            const hedgeAfterMs = hedgeEnabled ? Number(settings.vector_hedge_after_ms) : 0;
            const HEDGE_MAX_COUNT = 3;
            const debugOn = true; // hedge/failure logs always visible during a run

            console.log(`VectHare: Processing ${items.length} items in ${batches.length} batch(es) of up to ${BATCH_SIZE}${hasRateLimit ? ` with rate limit` : ''}${shouldParallelSplit ? ` [parallel-split: waves of up to 16 concurrent POSTs]` : ''}${hedgeEnabled ? ` [hedge armed: ${hedgeAfterMs}ms × ${HEDGE_MAX_COUNT}]` : ''}`);

            // Factored-out per-batch retry+log closure shared by serial and parallel paths.
            const makeProcessBatch = (batch, batchIdx, batchItemCount) => async () => {
                let attemptCount = 0;
                await AsyncUtils.retry(async () => {
                    attemptCount++;
                    const attemptStart = performance.now();
                    console.log(
                        `VectHare: insert batch ${batchIdx}/${batches.length} attempt ${attemptCount}/${RETRY_CONFIG.maxAttempts} — POST ${batchItemCount} item(s) via ${settings.source}${hedgeEnabled ? ' [hedge armed]' : ''}`,
                    );
                    try {
                        throwIfAborted(abortSignal);
                        const insertCall = () => backend.insertVectorItems(collectionId, batch, settings, abortSignal);
                        if (hedgeEnabled) {
                            await callWithHedge(insertCall, hedgeAfterMs, HEDGE_MAX_COUNT, {
                                debugOn,
                                batchIdx,
                                totalBatches: batches.length,
                                provider: settings.source,
                            });
                        } else {
                            await insertCall();
                        }
                        if (attemptCount > 1) {
                            const elapsed = ((performance.now() - attemptStart) / 1000).toFixed(1);
                            console.log(`VectHare: insert batch ${batchIdx}/${batches.length} attempt ${attemptCount} succeeded after ${elapsed}s`);
                        }
                    } catch (err) {
                        if (debugOn) {
                            const elapsed = ((performance.now() - attemptStart) / 1000).toFixed(1);
                            console.warn(
                                `VectHare: insert batch ${batchIdx}/${batches.length} attempt ${attemptCount}/${RETRY_CONFIG.maxAttempts} FAILED after ${elapsed}s — ${err?.name || 'Error'}: ${err?.message || err} (provider=${settings.source}, items=${batchItemCount})`,
                            );
                        }
                        throw err;
                    }
                }, RETRY_CONFIG);
            };

            if (shouldParallelSplit) {
                // Parallel waves of up to MAX_PARALLEL concurrent inserts (VectFox port).
                // Promise.allSettled lets all in-flight finish even if one fails — successful
                // ones are durable (hash upsert = idempotent). If any failed after retries,
                // throw composite so the caller sees the batch failed; hash-dedup makes the
                // eventual retry safe.
                const MAX_PARALLEL = 16;
                for (let wave = 0; wave < batches.length; wave += MAX_PARALLEL) {
                    const slice = batches.slice(wave, wave + MAX_PARALLEL);
                    const results = await Promise.allSettled(
                        slice.map((batch, idx) => {
                            const processBatch = makeProcessBatch(batch, wave + idx + 1, batch.length);
                            return processBatch();
                        }),
                    );
                    const failed = results.filter(r => r.status === 'rejected');
                    if (failed.length > 0) {
                        const sample = failed[0].reason;
                        const anyHedgeFatal = failed.some(f => f.reason?.isHedgeFatal === true);
                        const composite = new Error(
                            `VectHare: ${failed.length}/${slice.length} parallel inserts in wave failed — first failure: ${sample?.name || 'Error'}: ${sample?.message || sample}`,
                        );
                        if (anyHedgeFatal) {
                            composite.name = 'HedgeFatalError';
                            composite.isHedgeFatal = true;
                        }
                        throw composite;
                    }
                    if (onProgress) {
                        onProgress(Math.min(wave + slice.length, items.length), items.length);
                    }
                }
            } else {
                // Serial path — preserves rate-limited and local-GPU semantics.
                for (let i = 0; i < batches.length; i++) {
                    throwIfAborted(abortSignal);
                    const processBatch = makeProcessBatch(batches[i], i + 1, batches[i].length);
                    if (hasRateLimit) {
                        await dynamicRateLimiter.execute(processBatch, settings);
                    } else {
                        await processBatch();
                    }
                    if (onProgress) {
                        const embeddedCount = (i + 1) * BATCH_SIZE;
                        const actualEmbedded = Math.min(embeddedCount, items.length);
                        onProgress(actualEmbedded, items.length);
                    }
                }
            }
        }

        // VEC-18: Record successful insert operation
        recordInsert(settings?.vector_backend || 'standard', items.length);
    } catch (error) {
        // VEC-18: Record error
        recordError(settings?.vector_backend || 'standard', error);
        throw error;
    }
}

/**
 * Stream embeddings and write to database as batches complete
 * @param {object} backend - The backend instance
 * @param {string} collectionId - Collection ID
 * @param {Array} items - Original items
 * @param {string[]} textStrings - Text strings extracted from items
 * @param {object} settings - Settings object
 * @param {Function} onProgress - Progress callback
 */
async function streamEmbeddingsAndWrite(backend, collectionId, items, textStrings, settings, onProgress, abortSignal = null) {
    // VEC-6: Use configurable batch size for optimized bulk inserts
    const EMBEDDING_BATCH_SIZE = settings.insert_batch_size || 50;
    let totalProcessed = 0;
    const totalBatches = Math.ceil(textStrings.length / EMBEDDING_BATCH_SIZE);

    console.log(`VectHare: Streaming ${items.length} items in ${totalBatches} batch(es) of up to ${EMBEDDING_BATCH_SIZE}`);

    // Process embeddings in batches
    for (let i = 0; i < textStrings.length; i += EMBEDDING_BATCH_SIZE) {
        throwIfAborted(abortSignal);
        const batchEnd = Math.min(i + EMBEDDING_BATCH_SIZE, textStrings.length);
        const batchTextStrings = textStrings.slice(i, batchEnd);
        const batchItems = items.slice(i, batchEnd);
        const batchNum = Math.floor(i / EMBEDDING_BATCH_SIZE) + 1;

        console.log(`VectHare: Embedding batch ${batchNum}/${totalBatches} (items ${i + 1}-${batchEnd})`);

        // VEC-6: Retry logic per batch instead of per chunk
        let additionalArgs;
        try {
            additionalArgs = await AsyncUtils.retry(async () => {
                return await getAdditionalArgs(batchTextStrings, settings);
            }, RETRY_CONFIG);
        } catch (error) {
            // AbortError must not be swallowed by the "after retries" wrapper.
            if (error?.name === 'AbortError') throw error;
            throw new Error(`VectHare: Failed to generate embeddings for batch ${batchNum} after retries: ${error.message}`);
        }

        if (!additionalArgs.embeddings) {
            throw new Error(`VectHare: No embeddings returned from ${settings.source} for batch ${batchNum}`);
        }

        // Attach embeddings to items and validate
        let missingEmbeddings = 0;
        const itemsToWrite = [];

        for (let j = 0; j < batchItems.length; j++) {
            const text = batchTextStrings[j];
            const embedding = additionalArgs.embeddings[text];

            if (embedding && Array.isArray(embedding) && embedding.length > 0) {
                // Validate embedding values
                const isValidEmbedding = embedding.every(val => typeof val === 'number' && !isNaN(val));
                if (!isValidEmbedding) {
                    console.error(`VectHare: Invalid embedding values for item ${i + j}:`, embedding.slice(0, 5));
                    missingEmbeddings++;
                    continue;
                }
                batchItems[j].vector = embedding;
                itemsToWrite.push(batchItems[j]);
            } else {
                missingEmbeddings++;
                console.warn(`VectHare: No embedding found for item ${i + j}, text: "${text.substring(0, 50)}..."`);
            }
        }

        if (missingEmbeddings > 0) {
            throw new Error(`VectHare: Failed to generate embeddings for ${settings.source} - ${missingEmbeddings} items missing in batch`);
        }

        // VEC-6: Write batch to database with retry logic
        console.log(`VectHare: Writing batch ${batchNum} to database (${itemsToWrite.length} items)`);
        try {
            await AsyncUtils.retry(async () => {
                throwIfAborted(abortSignal);
                await backend.insertVectorItems(collectionId, itemsToWrite, settings, abortSignal);
            }, RETRY_CONFIG);
        } catch (error) {
            // AbortError must not be swallowed by the "after retries" wrapper.
            if (error?.name === 'AbortError') throw error;
            throw new Error(`VectHare: Failed to write batch ${batchNum} to database after retries: ${error.message}`);
        }

        totalProcessed += itemsToWrite.length;

        // Update progress
        if (onProgress) {
            console.log(`[Core Vector API] Streamed ${totalProcessed}/${items.length} (${Math.round((totalProcessed / items.length) * 100)}%)`);
            onProgress(totalProcessed, items.length);
        }
    }

    console.log(`VectHare: Completed streaming ${totalProcessed} items to database`);
}

/**
 * Deletes vector items from a collection
 * @param {string} collectionId - The collection to delete from
 * @param {number[]} hashes - The hashes of the items to delete
 * @param {object} settings VectHare settings object
 * @returns {Promise<void>}
 */
export async function deleteVectorItems(collectionId, hashes, settings) {
    const backend = await getBackend(settings);
    try {
        // VEC-33: Wrap with health invalidation
        const result = await withHealthInvalidation(
            () => backend.deleteVectorItems(collectionId, hashes, settings),
            settings
        );
        // VEC-18: Record successful delete operation
        recordDelete(settings?.vector_backend || 'standard', hashes.length);
        return result;
    } catch (error) {
        // VEC-18: Record error
        recordError(settings?.vector_backend || 'standard', error);
        throw error;
    }
}

/**
 * Queries a single collection for similar vectors
 * Applies keyword boost system: overfetch → boost → trim
 * For client-side embedding sources (webllm, koboldcpp, bananabread), generates query embedding first.
 * @param {string} collectionId - The collection to query
 * @param {string} searchText - The text to query
 * @param {number} topK - The number of results to return
 * @param {object} settings VectHare settings object
 * @returns {Promise<{ hashes: number[], metadata: object[]}>} - Hashes and metadata of the results
 */
export async function queryCollection(collectionId, searchText, topK, settings) {
    const backend = await getBackend(settings);

    // Sources that require client-side embedding generation
    const clientSideEmbeddingSources = ['webllm', 'koboldcpp', 'bananabread'];
    let queryVector = null;

    // If source requires client-side embeddings, generate query vector
    if (clientSideEmbeddingSources.includes(settings.source)) {
        const queryItem = [searchText];
        try {
            const additionalArgs = await getAdditionalArgs(queryItem, settings);
            // additionalArgs.embeddings is a Record<string, number[]> where keys are original text
            if (additionalArgs.embeddings && additionalArgs.embeddings[searchText]) {
                queryVector = additionalArgs.embeddings[searchText];
            } else {
                // VEC-35: Fallback to server-side embedding instead of failing completely
                console.warn(`[VectHare] Client-side embedding generation returned empty result for ${settings.source}, falling back to server-side embedding`);
            }
        } catch (clientEmbedError) {
            // VEC-35: Fallback to server-side embedding when client-side fails
            console.warn(`[VectHare] Client-side embedding failed for ${settings.source}: ${clientEmbedError.message}. Falling back to server-side embedding.`);
        }
    }

    // Check if hybrid search is enabled
    if (settings.hybrid_search_enabled) {
        console.log('[VectHare] Hybrid search enabled, dispatching to hybrid search module');
        const queryStart = Date.now();
        try {
            const result = await hybridSearch(collectionId, searchText, topK, settings, { queryVector });
            const queryLatency = Date.now() - queryStart;
            recordQuery(settings?.vector_backend || 'standard', queryLatency);
            return result;
        } catch (error) {
            // VEC-18: Record query error
            recordError(settings?.vector_backend || 'standard', error);
            throw error;
        }
    }

    // Standard vector search flow
    // Overfetch to allow keyword-boosted chunks to surface
    const overfetchAmount = getOverfetchAmount(topK);
    // VEC-18: Track query latency for health dashboard
    const queryStart = Date.now();
    let rawResults;
    try {
        rawResults = await backend.queryCollection(collectionId, searchText, overfetchAmount, settings, queryVector);
        const queryLatency = Date.now() - queryStart;
        recordQuery(settings?.vector_backend || 'standard', queryLatency);
    } catch (error) {
        // VEC-18: Record query error
        recordError(settings?.vector_backend || 'standard', error);
        throw error;
    }

    // Convert to format expected by keyword boost
    const resultsForBoost = rawResults.metadata.map((meta) => ({
        hash: meta.hash,
        score: meta.score || 0,
        metadata: meta,
        text: meta.text || ''
    }));

    let finalResults = scoreResults(resultsForBoost, searchText, topK, settings, overfetchAmount);

    // Convert back to expected format
    return {
        hashes: finalResults.map(r => r.hash),
        metadata: finalResults.map(r => ({
            ...r.metadata,
            score: r.score,
            originalScore: r.originalScore || r.vectorScore,
            keywordBoost: r.keywordBoost,
            bm25Score: r.bm25Score,
            normalizedBM25: r.normalizedBM25,
            vectorScore: r.vectorScore,
            matchedKeywords: r.matchedKeywords,
            matchedKeywordsWithWeights: r.matchedKeywordsWithWeights,
            keywordBoosted: r.keywordBoosted,
            explain: {
                retrieval: 'vector',
                vectorScore: r.vectorScore ?? r.originalScore ?? r.score,
                keywordBoost: r.keywordBoost ?? 1,
                keywordBoostConfidence: r.keywordBoostConfidence ?? 0,
                keywordOverlapRatio: r.keywordOverlapRatio ?? 0,
                matchedKeywords: r.matchedKeywords || [],
                finalScore: r.score
            }
        }))
    };
}

function scoreResults(resultsForBoost, searchText, topK, settings, overfetchAmount = null) {
    let finalResults;

    // VEC-24: Ensure overfetchAmount has a valid fallback to prevent ReferenceError
    const safeOverfetchAmount = overfetchAmount ?? resultsForBoost.length;

    // Determine scoring method from settings
    const scoringMethod = settings.keyword_scoring_method || 'keyword'; // 'keyword', 'bm25', or 'hybrid'
    if (scoringMethod === 'bm25') {
        // Use BM25 scoring only
        const bm25Results = applyBM25Scoring(resultsForBoost, searchText, {
            k1: settings.bm25_k1 || 1.5,
            b: settings.bm25_b || 0.75,
            alpha: 0.5,
            beta: 0.5
        });
        finalResults = bm25Results.slice(0, topK);
    } else if (scoringMethod === 'hybrid') {
        // Use both keyword boost and BM25
        // VEC-24: Use safe overfetch amount
        const keywordBoostLimit = safeOverfetchAmount;
        const keywordBoosted = applyKeywordBoosts(resultsForBoost, searchText, keywordBoostLimit);
        const hybridResults = applyBM25Scoring(keywordBoosted, searchText, {
            k1: settings.bm25_k1 || 1.5,
            b: settings.bm25_b || 0.75,
            alpha: 0.6,
            beta: 0.4
        });
        finalResults = hybridResults.slice(0, topK);
    } else {
        // Use traditional keyword boost (default)
        finalResults = applyKeywordBoosts(resultsForBoost, searchText, topK);
    }
    return finalResults;
}

/**
 * Queries multiple collections for a given text.
 * For client-side embedding sources, generates query embedding once and reuses for all collections.
 * @param {string[]} collectionIds - Collection IDs to query
 * @param {string} searchText - Text to query
 * @param {number} topK - Number of results to return
 * @param {number} threshold - Score threshold
 * @param {object} settings VectHare settings object
 * @returns {Promise<Record<string, { hashes: number[], metadata: object[] }>>} - Results mapped to collection IDs
 */
export async function queryMultipleCollections(collectionIds, searchText, topK, threshold, settings) {
    const backend = await getBackend(settings);

    // Sources that require client-side embedding generation
    const clientSideEmbeddingSources = ['webllm', 'koboldcpp', 'bananabread'];
    let queryVector = null;

    // Generate query vector once for all collections (efficiency)
    if (clientSideEmbeddingSources.includes(settings.source)) {
        try {
            // getAdditionalArgs expects string[], not objects
            const additionalArgs = await getAdditionalArgs([searchText], settings);
            // additionalArgs.embeddings is a Record<string, number[]> where keys are original text
            if (additionalArgs.embeddings && additionalArgs.embeddings[searchText]) {
                queryVector = additionalArgs.embeddings[searchText];
            } else {
                // VEC-35: Fallback to server-side embedding instead of failing completely
                console.warn(`[VectHare] Client-side embedding generation returned empty result for ${settings.source}, falling back to server-side embedding`);
            }
        } catch (clientEmbedError) {
            // VEC-35: Fallback to server-side embedding when client-side fails
            console.warn(`[VectHare] Client-side embedding failed for ${settings.source}: ${clientEmbedError.message}. Falling back to server-side embedding.`);
        }
    }

    // Check if hybrid search is enabled - process each collection with hybrid search
    if (settings.hybrid_search_enabled) {
        console.log('[VectHare] Hybrid search enabled for multi-collection query');
        const processedResults = {};
        for (const collectionId of collectionIds) {
            try {
                const queryStart = Date.now();
                processedResults[collectionId] = await hybridSearch(collectionId, searchText, topK, settings, { queryVector });
                const queryLatency = Date.now() - queryStart;
                recordQuery(settings?.vector_backend || 'standard', queryLatency);
            } catch (error) {
                console.warn(`[VectHare] Hybrid search failed for ${collectionId}:`, error.message);
                // VEC-18: Record error
                recordError(settings?.vector_backend || 'standard', error);
                processedResults[collectionId] = { hashes: [], metadata: [] };
            }
        }
        return processedResults;
    }

    // Standard vector search flow
    // Get raw results from backend (with overfetch for each collection)
    const overfetchAmount = getOverfetchAmount(topK);
    // VEC-18: Track query latency for health dashboard
    const queryStart = Date.now();
    let rawResults;
    try {
        rawResults = await backend.queryMultipleCollections(collectionIds, searchText, overfetchAmount, threshold, settings, queryVector);
        const queryLatency = Date.now() - queryStart;
        recordQuery(settings?.vector_backend || 'standard', queryLatency);
    } catch (error) {
        // VEC-18: Record query error
        recordError(settings?.vector_backend || 'standard', error);
        throw error;
    }

    // Apply scoring to each collection's results
    const processedResults = {};

    for (const [collectionId, collectionResults] of Object.entries(rawResults)) {
        if (!collectionResults || !collectionResults.metadata) {
            processedResults[collectionId] = collectionResults;
            continue;
        }

        // Convert to format expected by scoring functions
        const resultsForBoost = collectionResults.metadata.map((meta) => ({
            hash: meta.hash,
            score: meta.score || 0,
            metadata: meta,
            text: meta.text || ''
        }));

        let finalResults = scoreResults(resultsForBoost, searchText, topK, settings, overfetchAmount);

        // Convert back to expected format
        processedResults[collectionId] = {
            hashes: finalResults.map(r => r.hash),
            metadata: finalResults.map(r => ({
                ...r.metadata,
                score: r.score,
                originalScore: r.originalScore || r.vectorScore,
                keywordBoost: r.keywordBoost,
                bm25Score: r.bm25Score,
                normalizedBM25: r.normalizedBM25,
                vectorScore: r.vectorScore,
                matchedKeywords: r.matchedKeywords,
                matchedKeywordsWithWeights: r.matchedKeywordsWithWeights,
                keywordBoosted: r.keywordBoosted
            }))
        };
    }

    return processedResults;
}

/**
 * Queries multiple collections with conditional activation filtering.
 * Collections that don't meet their activation conditions are skipped.
 *
 * @param {string[]} collectionIds - Collection IDs to potentially query
 * @param {string} searchText - Text to query
 * @param {number} topK - Number of results to return
 * @param {number} threshold - Score threshold
 * @param {object} settings - VectHare settings object
 * @param {object} context - Search context (from buildSearchContext)
 * @returns {Promise<Record<string, { hashes: number[], metadata: object[] }>>} - Results mapped to collection IDs
 */
export async function queryActiveCollections(collectionIds, searchText, topK, threshold, settings, context) {
    // Lazy import to avoid circular dependency
    const { filterActiveCollections } = await import('./collection-metadata.js');

    // Filter collections based on their activation conditions
    const activeCollectionIds = await filterActiveCollections(collectionIds, context);

    if (activeCollectionIds.length === 0) {
        console.log('VectHare: No collections passed activation conditions');
        return {};
    }

    // Query only the active collections
    const backend = await getBackend(settings);
    return await backend.queryMultipleCollections(activeCollectionIds, searchText, topK, threshold, settings);
}

/**
 * Purges the vector index for a collection.
 * @param {string} collectionId Collection ID to purge
 * @param {object} settings VectHare settings object
 * @returns {Promise<boolean>} True if deleted, false if not
 */
export async function purgeVectorIndex(collectionId, settings) {
    try {
        const backend = await getBackend(settings);
        await backend.purgeVectorIndex(collectionId, settings);
        console.log(`VectHare: Purged vector index for collection ${collectionId}`);
        return true;
    } catch (error) {
        // VEC-33: Invalidate health cache on operation error
        invalidateBackendHealth(settings?.vector_backend || 'standard', error);
        console.error('VectHare: Failed to purge', error);
        return false;
    }
}

/**
 * Purges the vector index for a file.
 * @param {string} collectionId File collection ID to purge
 * @param {object} settings VectHare settings object
 * @returns {Promise<void>}
 */
export async function purgeFileVectorIndex(collectionId, settings) {
    try {
        console.log(`VectHare: Purging file vector index for collection ${collectionId}`);
        const backend = await getBackend(settings);
        await backend.purgeFileVectorIndex(collectionId, settings);
        console.log(`VectHare: Purged vector index for collection ${collectionId}`);
    } catch (error) {
        // VEC-33: Invalidate health cache on operation error
        invalidateBackendHealth(settings?.vector_backend || 'standard', error);
        console.error('VectHare: Failed to purge file', error);
    }
}

/**
 * Purges all vector indexes.
 * @param {object} settings VectHare settings object
 * @returns {Promise<void>}
 */
export async function purgeAllVectorIndexes(settings) {
    try {
        const backend = await getBackend(settings);
        await backend.purgeAllVectorIndexes(settings);
        console.log('VectHare: Purged all vector indexes');
        toastr.success('All vector indexes purged', 'Purge successful');
    } catch (error) {
        // VEC-33: Invalidate health cache on operation error
        invalidateBackendHealth(settings?.vector_backend || 'standard', error);
        console.error('VectHare: Failed to purge all', error);
        toastr.error('Failed to purge all vector indexes', 'Purge failed');
    }
}

/**
 * Update chunk text (triggers re-embedding)
 * @param {string} collectionId - Collection ID
 * @param {number} hash - Chunk hash
 * @param {string} newText - New text content
 * @param {object} settings - VectHare settings
 */
export async function updateChunkText(collectionId, hash, newText, settings) {
    const backend = await getBackend(settings);
    return await backend.updateChunkText(collectionId, hash, newText, settings);
}

/**
 * Update chunk metadata (no re-embedding)
 * @param {string} collectionId - Collection ID
 * @param {number} hash - Chunk hash
 * @param {object} metadata - Metadata to update (keywords, enabled, etc.)
 * @param {object} settings - VectHare settings
 */
export async function updateChunkMetadata(collectionId, hash, metadata, settings) {
    const backend = await getBackend(settings);
    return await backend.updateChunkMetadata(collectionId, hash, metadata, settings);
}
