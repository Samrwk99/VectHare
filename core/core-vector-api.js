import { vhLog } from '../utils/log.js';
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

import { addInsertionProvenance } from './vector-provenance.js';
import { getRequestHeaders } from '../../../../../script.js';
import { vecthareState, assertStoreAuthoritative, refreshStoreIfStale } from './vecthare-store.js';
import { acquireLease, withLease } from './leases.js';
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
import { resolveCollectionOperationSettings, snapshotCollectionOperationSettings,
    createInitialVectorizationConfig, readInitialVectorizationConfig,
    assertCollectionOperationSettingsStable,
    noteCollectionHashClaims, forgetCollectionHashClaims, hasSharedChunkRecords,
    registryEntriesMissingHashClaims, getCollectionMeta } from './collection-metadata.js';
import { parseRegistryKey } from './collection-ids.js';
import { resolveStorage, settingsForCollectionStorage, assertNoStorageConflict, assertStorageWritable,
    scopedTenancySupported } from './storage-resolver.js';
import AsyncUtils from '../utils/async-utils.js';
import StringUtils from '../utils/string-utils.js';
import {
    RATE_LIMIT_CALLS,
    RATE_LIMIT_WINDOW_MS,
    API_TIMEOUT_MS,
    RETRY_MAX_ATTEMPTS,
    RETRY_INITIAL_DELAY_MS,
    RETRY_MAX_DELAY_MS,
    RETRY_BACKOFF_MULTIPLIER,
    VECTOR_LIST_LIMIT
} from './constants.js';

// Only VectHare's own collection namespace may be mutated. ST's native
// vector directory is shared and accepting an arbitrary collection ID here
// could overwrite/delete another extension's or vanilla ST's vectors.
export function assertVectHareCollectionForWrite(collectionId) {
    if (typeof collectionId !== 'string' || !/^vecthare_[A-Za-z0-9_.-]+$/.test(collectionId)) {
        throw new Error('Refusing to modify an unverified/non-VectHare vector collection');
    }
}

// Notify the Status UI only after a write has successfully reached the DB.
// Window events keep the backend/API independent of the progress panel.
function notifyDatabaseChanged(collectionId = null) {
    // C12: a write changes which hashes a collection holds.
    try { forgetCollectionHashClaims(collectionId || null); } catch { /* index is best-effort */ }
    if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
        window.dispatchEvent(new CustomEvent('vecthare:database-changed', { detail: { collectionId } }));
    }
}

// The plugin retains an exact, VectHare-owned purge intent across reloads.
// An interrupted purge must never be reconstructed from current settings alone.
async function standardPurgeRecovery(collectionId, action, record = undefined) {
    const response = await fetch('/api/plugins/similharity/identity-ledger/purge-recovery', {
        method: 'POST', headers: getRequestHeaders(),
        body: JSON.stringify({ collectionId, action, ...(record ? { record } : {}) }),
    });
    if (!response.ok) throw new Error(`Standard purge recovery ${action}: HTTP ${response.status}`);
    const result = await response.json();
    if (result.success !== true) throw new Error(`Standard purge recovery ${action} was not confirmed`);
    return result;
}

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

// #40: the historical default (5 calls / 60s) is a cloud-API courtesy limit and
// made local embedding painfully slow. Providers that run on the user's own
// machine are not throttled while the setting is still at that default; any
// other configured value is the user's explicit choice and is always honoured.
const LOCAL_EMBEDDING_PROVIDERS = ['transformers', 'ollama', 'llamacpp', 'vllm',
    'koboldcpp', 'bananabread', 'webllm', 'extras'];
const LEGACY_DEFAULT_RATE_LIMIT_CALLS = 5;
const LEGACY_DEFAULT_RATE_LIMIT_INTERVAL = 60;
function effectiveRateLimitCalls(settings) {
    const maxCalls = settings.rate_limit_calls || 0;
    if (maxCalls <= 0) return 0;
    const atLegacyDefault = maxCalls === LEGACY_DEFAULT_RATE_LIMIT_CALLS &&
        (settings.rate_limit_interval || LEGACY_DEFAULT_RATE_LIMIT_INTERVAL) === LEGACY_DEFAULT_RATE_LIMIT_INTERVAL;
    if (atLegacyDefault && LOCAL_EMBEDDING_PROVIDERS.includes(settings.source)) return 0;
    return maxCalls;
}

// #52: backends whose plugin query route accepts a ready-made query vector.
const PREEMBED_QUERY_BACKENDS = ['qdrant', 'lancedb', 'milvus'];

/**
 * #52: embeds a RAG query once for a given embedding configuration so a
 * multi-collection search does not repeat it per collection. Best-effort:
 * returns null and lets each collection embed its own query on failure.
 * @param {string} searchText Query text
 * @param {object} settings Resolved operation settings
 * @returns {Promise<number[]|null>} Query vector, or null when unavailable
 */
async function embedQueryForSettings(searchText, settings) {
    try {
        const modelField = getModelField(settings.source);
        const response = await fetch('/api/plugins/similharity/get-embedding', {
            method: 'POST', headers: getRequestHeaders(),
            body: JSON.stringify(getVectorsRequestBody({
                source: settings.source,
                model: modelField ? settings[modelField] || '' : '',
                text: searchText,
                isQuery: true, // #14: asymmetric providers embed queries differently
            }, settings)),
        });
        if (!response.ok) throw AsyncUtils.httpError(response, `Query embedding failed: ${response.status}`);
        const data = await response.json();
        if (!Array.isArray(data.embedding) || !data.embedding.length ||
            !data.embedding.every(Number.isFinite)) {
            throw new Error('Invalid query embedding');
        }
        return data.embedding;
    } catch (error) {
        console.warn('VectHare: Shared query embedding unavailable; using per-collection fallback:', error.message);
        return null;
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
        const maxCalls = effectiveRateLimitCalls(settings); // 0 = disabled
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
                vhLog(`VectHare: Rate limit reached. Waiting ${Math.round(waitTime / 1000)}s...`);
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

// Retry configuration for transient failures (matches AsyncUtils.retry signature)
/**
 * R13: Detects an abort error (user pressed Stop and we cancelled the request).
 * Aborts must NEVER be retried - the user asked for the work to stop.
 * @param {Error} error
 * @returns {boolean}
 */
function isAbortError(error) {
    return error?.name === 'AbortError' || error?.code === 20 || error?.message?.includes('abort');
}

/**
 * R13: Makes an await abortable: rejects with AbortError as soon as the signal
 * fires, instead of waiting for the underlying request. The underlying promise
 * is detached (its eventual result/rejection is swallowed) - for server-side
 * embedding sources the server may still complete and write a valid chunk,
 * which is harmless: chunks are written as complete units and the next sync's
 * hash diff reconciles either outcome. Never partial data.
 * @param {Promise<any>} promise
 * @param {AbortSignal|null} abortSignal
 * @returns {Promise<any>}
 */
function makeAbortable(promise, abortSignal) {
    if (!abortSignal) return promise;
    // Swallow the detached promise's eventual outcome to avoid
    // unhandled-rejection noise when we've already returned via abort.
    // R13 fix: attached BEFORE the already-aborted early return too - if the
    // signal fired before we were called, the underlying request can still
    // reject later (e.g. server-side failure) and must not surface as an
    // unhandled rejection.
    promise.catch(() => { /* detached after abort - intentionally ignored */ });
    if (abortSignal.aborted) {
        return Promise.reject(new DOMException('Aborted by user (Stop)', 'AbortError'));
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(new DOMException('Aborted by user (Stop)', 'AbortError'));
        abortSignal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => { abortSignal.removeEventListener('abort', onAbort); resolve(value); },
            (error) => { abortSignal.removeEventListener('abort', onAbort); reject(error); }
        );
    });
}

/**
 * R17 (user-reported hang): Universal guard for ALL backend operations.
 * Every backend await is now:
 *  - TIMEOUT-BOUNDED (API_TIMEOUT_MS * 4): a hung server-side request (e.g.
 *    the ST server stuck on an Ollama call) can no longer stall the run
 *    forever - previously getBackend/deleteVectorItems/getSavedHashes had
 *    NO timeout, so Stop/Pause looked dead while Ollama sat idle.
 *  - ABORTABLE: the caller's await is freed the instant the user presses
 *    Stop (the underlying request is detached and its outcome reconciled
 *    by the next sync's hash diff - chunks are written whole or not at all).
 * @param {Function} fn - () => Promise for the backend operation
 * @param {AbortSignal|null} abortSignal
 * @param {string} label - Operation label for the timeout error
 * @returns {Promise<any>}
 */
async function withOpGuard(fn, abortSignal, label) {
    const op = fn();
    // Prevent unhandled-rejection noise if the timeout loses the race
    op.catch(() => { /* detached - see timeout below */ });
    const bounded = AsyncUtils.timeout(op, API_TIMEOUT_MS * 4, `${label} timed out - backend unresponsive`);
    return await makeAbortable(bounded, abortSignal);
}

const RETRY_CONFIG = {
    maxAttempts: RETRY_MAX_ATTEMPTS,
    delay: RETRY_INITIAL_DELAY_MS,
    maxDelay: RETRY_MAX_DELAY_MS,
    backoffFactor: RETRY_BACKOFF_MULTIPLIER,
    shouldRetry: (error) => isRetryableError(error),
};

const RETRYABLE_STATUS = new Set([408, 425, 429, 502, 503, 504]);
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET']);

/**
 * VH-069: whether a failed call is worth trying again. Decided on the HTTP
 * status (or network error code) when the error carries one. Text is only
 * used for the browser's own network failures and for a status code that
 * stands on its own in a backend message ("...: 503 Service Unavailable") -
 * never for digits or words inside a collection id or a refusal (it used to
 * retry any message containing "503", "fetch" or "network").
 * @param {any} error
 * @returns {boolean}
 */
export function isRetryableError(error) {
    // R13: NEVER retry an abort - the user explicitly stopped the work
    if (isAbortError(error)) return false;
    const status = Number(error?.status ?? error?.statusCode);
    if (Number.isInteger(status) && status >= 100) return RETRYABLE_STATUS.has(status);
    if (NETWORK_CODES.has(error?.code) || NETWORK_CODES.has(error?.cause?.code)) return true;
    const message = String(error?.message || '').trim();
    // Browsers' fetch() network failures (Chrome, Firefox, Safari).
    if (/^(failed to fetch|load failed|networkerror when attempting to fetch resource\.?)$/i.test(message)) return true;
    if (/\btimed out\b|\brate limit(ed)?\b|\btoo many requests\b/i.test(message)) return true;
    // A status code on its own, as the backends print it: "...: 503 Service Unavailable".
    return /(?:^|[\s:(])(429|502|503|504)(?=[\s).,:]|$)/.test(message);
}

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
            vhLog(`VectHare DEBUG llamacpp (core-vector-api): use_alt_endpoint=${settings.use_alt_endpoint}, alt_endpoint_url="${settings.alt_endpoint_url}", ST_url="${textgenerationwebui_settings.server_urls[textgen_types.LLAMACPP]}", final apiUrl="${body.apiUrl}"`);
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
export async function getAdditionalArgs(items, settings, onProgress = null, abortSignal = null) {
    const args = {};
    switch (settings.source) {
        case 'webllm':
            args.embeddings = await createWebLlmEmbeddings(items, settings);
            break;
        case 'koboldcpp': {
            const { embeddings, model } = await createKoboldCppEmbeddings(items, settings, onProgress, abortSignal);
            args.embeddings = embeddings;
            args.model = model;
            break;
        }
        case 'bananabread': {
            const { embeddings, model } = await createBananaBreadEmbeddings(items, settings, abortSignal);
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
async function createKoboldCppEmbeddings(items, settings, onProgress = null, abortSignal = null) {
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

        // #45: rate limiting counts every provider call, retries included, so
        // the limiter sits inside the retry rather than around it.
        const result = await AsyncUtils.retry(async () => {
            return await dynamicRateLimiter.execute(async () => {
                const serverUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.KOBOLDCPP];
                if (!serverUrl) {
                    throw new Error('KoboldCpp URL not found');
                }

                const cleanUrl = serverUrl.replace(/\/$/, '');
                const controller = new AbortController();
                const abort = () => controller.abort();
                if (abortSignal?.aborted) abort();
                abortSignal?.addEventListener('abort', abort, { once: true });
                const timer = setTimeout(abort, API_TIMEOUT_MS * 4);
                let data;
                try {
                    const response = await fetch(`${cleanUrl}/v1/embeddings`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            input: batchItems,
                            model: settings.koboldcpp_model || 'koboldcpp',
                        }),
                        signal: controller.signal,
                    });
                    if (!response.ok) {
                        throw AsyncUtils.httpError(response,
                            `Failed to get KoboldCpp embeddings: ${response.status} ${response.statusText}`);
                    }
                    data = await response.json();
                } finally {
                    clearTimeout(timer);
                    abortSignal?.removeEventListener('abort', abort);
                }

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
            vhLog(`[KoboldCpp] Calling progress callback: ${embeddedSoFar}/${items.length}`);
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
async function createBananaBreadEmbeddings(items, settings, abortSignal = null) {
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

    // #45: retries are provider calls too; the limiter is inside the retry.
    return await AsyncUtils.retry(async () => {
        return await dynamicRateLimiter.execute(async () => {
            const serverUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : 'http://localhost:8008';
            const cleanUrl = serverUrl.replace(/\/$/, '');

            const headers = {
                'Content-Type': 'application/json',
            };

            // Use extension settings for API key (custom keys aren't returned by ST's readSecretState)
            if (settings.bananabread_api_key) {
                headers['Authorization'] = `Bearer ${settings.bananabread_api_key}`;
            }

            // R13: signalAbort - Stop truly cancels client-side embedding fetches
            const fetchPromise = fetch(`${cleanUrl}/v1/embeddings`, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({
                    input: cleanedItems,
                    model: settings.bananabread_model || 'bananabread',
                }),
                signal: abortSignal || undefined,
            });

            const response = await AsyncUtils.timeout(fetchPromise, API_TIMEOUT_MS * 20, 'BananaBread embedding request timed out');

            if (!response.ok) {
                throw AsyncUtils.httpError(response,
                    `Failed to get BananaBread embeddings: ${response.status} ${response.statusText}`);
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
export async function getSavedHashes(collectionId, settings, includeMetadata = false, abortSignal = null, strictMetadata = false) {
    // R17: guarded - collection reads during/around runs were unabortable+untimed
    const backend = await withOpGuard(() => getBackend(settings), abortSignal, 'Backend initialization (read)');

    if (!includeMetadata) {
        return await withOpGuard(
            () => backend.getSavedHashes(collectionId, settings),
            abortSignal,
            'Read saved hashes'
        );
    }

    // R16 FIX (consistency + correctness): hashes and metadata now come from a
    // SINGLE backend request. The previous implementation made TWO separate
    // fetches and callers zipped them BY INDEX: any concurrent write between
    // the two requests (e.g. auto-sync reacting to the very message edit the
    // user is repairing) shifted the mapping onto the WRONG hashes - breaking
    // replacement detection and protected-chunk classification in repair and
    // reverse sync. The inline second fetch also bypassed the backend's
    // registry-prefix stripping, multitenancy collection mapping, and
    // content_type filtering. backend.listChunks does all of it correctly in
    // one request.
    // R19 FIX: the R18 edit referenced an undefined `hashes` variable here -
    // instant ReferenceError, silently caught by the fallback below, which
    // returned hashes-only and made every repair abort with "Chunk metadata
    // unavailable". (User-confirmed; the console line
    // "Metadata read failed, returning hashes only: hashes is not defined"
    // was the smoking gun.)
    //
    // Correct design: the AUTHORITATIVE hash list comes from the backend's own
    // filtered read (respects Qdrant multitenancy content_type filtering, so
    // no other chats' chunks leak in); metadata comes from listChunks; the two
    // are joined BY HASH. Two requests, yes - but a hash-keyed join is
    // SKEW-TOLERANT: a concurrent write between the two reads can only cause
    // a missing hash to map to {} (treated as unprotected-but-current), never
    // to ANOTHER chunk's metadata (the R16 index-zipping failure mode).
    // Qdrant reads one complete metadata snapshot. Other backends retain
    // their authoritative hash read and hash-keyed metadata join.
    if (settings.vector_backend === 'qdrant') {
        const data = await withOpGuard(
            () => backend.listChunks(collectionId, settings, {
                offset: 0, limit: Number.MAX_SAFE_INTEGER, strictRead: strictMetadata,
            }), abortSignal, 'Read collection metadata');
        const items = data?.items;
        if ((strictMetadata && (data?.success !== true || data.offset !== 0)) ||
            !Array.isArray(items) || data.hasMore !== false ||
            !Number.isSafeInteger(data.total) || data.total !== items.length || items.some(item =>
            item?.hash === undefined || !item.metadata ||
            typeof item.metadata.text !== 'string' ||
            String(item.metadata.hash) !== String(item.hash))) {
            throw new Error('Incomplete or invalid Qdrant metadata response');
        }
        return {
            hashes: items.map(item => item.hash),
            metadata: items.map(item => item.metadata),
        };
    }

    if (strictMetadata) {
        // Repair needs a COMPLETE, aligned inventory. The ordinary hash API on
        // other backends may be capped; never join a truncated list to metadata
        // or turn a failed metadata request into an apparently empty collection.
        const pageSize = 500;
        const items = [];
        let offset = 0;
        let expectedTotal = null;
        while (true) {
            const page = await withOpGuard(
                () => backend.listChunks(collectionId, settings, {
                    offset, limit: pageSize, strictRead: true,
                }), abortSignal, 'Read complete collection metadata');
            if (page?.success !== true || !Array.isArray(page.items) ||
                page.offset !== offset || typeof page.hasMore !== 'boolean' ||
                !Number.isSafeInteger(page.total) || page.total < 0 ||
                page.items.length > pageSize ||
                (page.hasMore && page.items.length !== pageSize)) {
                throw new Error(`VectHare: Invalid or incomplete collection inventory for ${collectionId}`);
            }
            if (expectedTotal === null) expectedTotal = page.total;
            if (page.total !== expectedTotal || offset + page.items.length > expectedTotal ||
                page.hasMore !== (offset + page.items.length < expectedTotal)) {
                throw new Error(`VectHare: Collection inventory changed or was truncated for ${collectionId}`);
            }
            for (const item of page.items) {
                // Adapters put hash/text either at the record top level or
                // inside metadata. Accept either, require them to agree, and
                // hand Repair normalized values for every distinct record.
                const meta = item?.metadata;
                const hash = item?.hash ?? meta?.hash;
                const text = item?.text ?? meta?.text;
                if (!meta || typeof meta !== 'object' || Array.isArray(meta) ||
                    !['number', 'string'].includes(typeof hash) ||
                    typeof text !== 'string' ||
                    (item.hash != null && meta.hash != null && String(item.hash) !== String(meta.hash)) ||
                    (item.text != null && meta.text != null && item.text !== meta.text)) {
                    throw new Error(`VectHare: Incomplete chunk metadata for ${collectionId}`);
                }
                items.push({ hash, metadata: { ...meta, hash, text } });
            }
            offset += page.items.length;
            if (!page.hasMore) {
                if (offset !== expectedTotal) {
                    throw new Error(`VectHare: Incomplete collection inventory for ${collectionId}`);
                }
                break;
            }
        }
        return { hashes: items.map(item => item.hash), metadata: items.map(item => item.metadata) };
    }

    const hashes = await withOpGuard(
        () => backend.getSavedHashes(collectionId, settings),
        abortSignal,
        'Read saved hashes'
    );

    try {
        const data = await withOpGuard(
            () => backend.listChunks(collectionId, settings, {
                offset: 0,
                limit: VECTOR_LIST_LIMIT,
            }),
            abortSignal,
            'Read collection metadata'
        );
        const items = data?.items || data?.chunks || [];
        const metaByHash = new Map(items.map(item => {
            // Flat records are accepted only when their hash and text are explicit.
            let metadata = strictMetadata
                ? (item?.metadata ?? (item?.hash !== undefined && typeof item?.text === 'string' ? item : null))
                : (item?.metadata || item);
            // VH-105: LanceDB (and others) keep hash/text on the record, not in
            // its metadata. Copy them in when metadata lacks them, as the strict
            // inventory above does, so export, scenes and the loader see the text.
            if (metadata && typeof metadata === 'object' && metadata !== item) {
                const hash = metadata.hash ?? item?.hash;
                const text = metadata.text ?? item?.text;
                if (metadata.hash == null || metadata.text == null) metadata = { ...metadata, ...(hash != null ? { hash } : {}), ...(typeof text === 'string' ? { text } : {}) };
            }
            return [String(item?.hash ?? metadata?.hash), metadata];
        }));
        if (strictMetadata && hashes.some(hash => {
            const metadata = metaByHash.get(String(hash));
            return !metadata || typeof metadata !== 'object' ||
                String(metadata.hash) !== String(hash) ||
                typeof metadata.text !== 'string';
        })) {
            throw new Error(`VectHare: Incomplete chunk metadata for ${collectionId}`);
        }
        return {
            hashes: hashes,
            metadata: hashes.map(h => metaByHash.get(String(h)) || {}),
        };
    } catch (error) {
        if (strictMetadata) throw error;
        console.warn('VectHare: Metadata read failed, returning hashes only:', error.message);
        // Fallback: hashes-only (old format) - callers treat missing metadata
        // as "cannot classify protected chunks" and skip accordingly.
        // R20: this fallback was a bare unbounded await - the last surviving
        // instance of the R17 hang class (it lives in an error path, i.e.
        // exactly where nobody looks while debugging a hang).
        return await withOpGuard(
            () => backend.getSavedHashes(collectionId, settings),
            abortSignal,
            'Read saved hashes (fallback)'
        );
    }
}

// VH-077: Milvus VARCHAR limit for chunk text (characters)
const MILVUS_TEXT_MAX = 65535;
const milvusTooLongNoted = new Set();

/**
 * Inserts vector items into a collection
 * Handles batching and rate limiting.
 * For client-side embedding sources (webllm, koboldcpp, bananabread), generates embeddings first.
 * @param {string} collectionId - The collection to insert into
 * @param {{ hash: number, text: string }[]} items - The items to insert
 * @param {object} settings VectHare settings object
 * @param {Function} onProgress - Optional callback (embedded, total) => void for progress updates
 * @returns {Promise<void>}
 */
export async function insertVectorItems(collectionId, items, settings, onProgress = null, abortSignal = null) {
    assertVectHareCollectionForWrite(collectionId);
    // 9b: saved settings found in more than one place -> no writes.
    assertNoStorageConflict(collectionId, settings?.vector_backend);
    // 9c: legacy Qdrant multitenancy is read-only (with a capable plugin).
    await assertStorageWritable(collectionId, settings);
    // #49: an item whose text is empty (or only whitespace) after cleaning
    // cannot be embedded; providers either error or return nothing useful.
    // Previously such items were sent as a single space.
    const embeddable = items.filter(item => {
        const text = typeof item === 'string' ? item : item?.text;
        return typeof text === 'string' && text.trim().length > 0;
    });
    if (embeddable.length !== items.length) {
        const dropped = items.length - embeddable.length;
        if (!embeddable.length) {
            throw new Error(`All ${dropped} item(s) are empty after text cleaning; nothing to embed`);
        }
        console.warn(`VectHare: Skipping ${dropped} item(s) with no text after cleaning`);
        items = embeddable;
    }
    // VH-077: Milvus stores chunk text in a VARCHAR(65535) field. A longer chunk
    // can never be stored there; leave it out (before embedding) and say so once,
    // instead of failing the whole batch on every Sync.
    if ((settings?.vector_backend || '') === 'milvus') {
        const tooLong = items.filter(item => typeof item?.text === 'string' && [...item.text].length > MILVUS_TEXT_MAX);
        if (tooLong.length) {
            items = items.filter(item => !tooLong.includes(item));
            const fresh = tooLong.filter(item => !milvusTooLongNoted.has(`${collectionId}:${item.hash}`));
            for (const item of tooLong) milvusTooLongNoted.add(`${collectionId}:${item.hash}`);
            console.warn(`VectHare: ${tooLong.length} chunk(s) in ${collectionId} are longer than Milvus can store (${MILVUS_TEXT_MAX} characters) and were not stored`);
            if (fresh.length && typeof toastr !== 'undefined') {
                toastr.warning(`${fresh.length} message chunk(s) are longer than Milvus can store (${MILVUS_TEXT_MAX} characters) and are not kept as memories. ` +
                    'Shorten those messages or use a smaller chunk size; everything else is stored.', 'VectHare', { timeOut: 15000 });
            }
            if (!items.length) return;
        }
    }
    // C13 (detect only): two different texts with the same hash cannot both be
    // stored - the hash is the record's key, so the second would replace or be
    // ignored by the backend without notice. Keep the first, skip the others,
    // and say so. Identical texts are ordinary duplicates and are left alone.
    {
        const seenText = new Map();
        const collisions = [];
        const normalized = value => String(value ?? '').replace(/\s+/g, ' ').trim();
        items = items.filter(item => {
            if (!item || typeof item !== 'object' || item.hash === undefined || item.hash === null) return true;
            const key = String(item.hash);
            const text = normalized(item.text);
            if (!seenText.has(key)) {
                seenText.set(key, text);
                return true;
            }
            if (seenText.get(key) === text) return true;
            collisions.push(key);
            return false;
        });
        if (collisions.length) {
            console.warn(`VectHare: ${collisions.length} chunk(s) not stored in ${collectionId}: hash collision (different texts share hash ${[...new Set(collisions)].slice(0, 5).join(', ')})`);
            if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
                window.dispatchEvent(new CustomEvent('vecthare:hash-collision', {
                    detail: { collectionId, count: collisions.length, hashes: [...new Set(collisions)] },
                }));
            }
        }
    }
    // Write-only, optional provenance. Existing hash keys, chunk order and
    // insert behavior are unchanged; no reader uses the new metadata yet.
    items = await addInsertionProvenance(collectionId, items);
    // R17: getBackend was previously an UNABORTABLE, UNTIMED await executed
    // once per item - the exact place a run could hang forever with Stop
    // unable to free it (user symptom: "stopping hangs on embedding" while
    // Ollama logs show no activity).
    const backend = await withOpGuard(() => getBackend(settings), abortSignal, 'Backend initialization');

    // #21: the operation's embedding identity is captured here and re-checked
    // before every batch. Changing provider, model or endpoint mid-run would
    // otherwise embed the rest of the same operation into a different space.
    const embeddingIdentity = () => {
        const modelField = getModelField(settings.source);
        return JSON.stringify([settings.source || 'transformers',
            modelField ? settings[modelField] || '' : '',
            settings.use_alt_endpoint ? settings.alt_endpoint_url || '' : '',
            settings.vector_backend || 'standard']);
    };
    const capturedIdentity = embeddingIdentity();
    const assertSameEmbeddingIdentity = () => {
        if (embeddingIdentity() !== capturedIdentity) {
            throw new Error('Embedding provider/model changed during this operation; insert aborted');
        }
    };

    // Sources that require client-side embedding generation
    const clientSideEmbeddingSources = ['webllm', 'koboldcpp', 'bananabread'];

    try {
        // If source requires client-side embeddings, use streaming approach
        if (clientSideEmbeddingSources.includes(settings.source)) {
            vhLog(`VectHare: Streaming embeddings and writing for ${settings.source}...`);

            // Extract text strings - getAdditionalArgs expects string[], not objects
            const textStrings = items.map(item => {
                const text = item.text || item;
                // Ensure we have valid text (not empty after cleaning)
                return typeof text === 'string' && text.trim().length > 0 ? text : ' ';
            });

            // Use streaming embedding generation with immediate writes
            await streamEmbeddingsAndWrite(backend, collectionId, items, textStrings, settings, onProgress,
                abortSignal, assertSameEmbeddingIdentity);
        } else {
            // Server-side embeddings - backend handles everything
            // VEC-6: Use configurable batch size for optimized bulk inserts
            // Keep the one-item cap for Transformers; Ollama uses the configured batch size.
            const smallBatchProviders = ['transformers'];
            const configuredBatchSize = settings.insert_batch_size || 50;
            const BATCH_SIZE = smallBatchProviders.includes(settings.source) ? 1 : configuredBatchSize;
            const batches = chunkArray(items, BATCH_SIZE);

            const hasRateLimit = effectiveRateLimitCalls(settings) > 0;
            vhLog(`VectHare: Processing ${items.length} items in ${batches.length} batch(es) of up to ${BATCH_SIZE}${hasRateLimit ? ` with rate limit (Max ${settings.rate_limit_calls} calls / ${settings.rate_limit_interval}s)` : ''}`);

            for (let i = 0; i < batches.length; i++) {
                assertSameEmbeddingIdentity();
                const processBatch = async () => {
                    await AsyncUtils.retry(async () => {
                        // R17: timeout-bounded + abortable (was a bare unbounded fetch)
                        // #45: each attempt (including retries) takes its own
                        // rate-limit slot - a retry is another provider call.
                        const attempt = () => withOpGuard(
                            () => backend.insertVectorItems(collectionId, batches[i], settings),
                            abortSignal,
                            'Batch insert'
                        );
                        await (hasRateLimit ? dynamicRateLimiter.execute(attempt, settings) : attempt());
                    }, RETRY_CONFIG);
                };

                // R13: abortable - Stop cancels the wait instantly. For server-side
                // sources the detached request may still complete server-side and
                // write a valid chunk, which the next sync's hash diff reconciles.
                await makeAbortable(processBatch(), abortSignal);

                notifyDatabaseChanged(collectionId);
                if (onProgress) {
                    const embeddedCount = (i + 1) * BATCH_SIZE;
                    const actualEmbedded = Math.min(embeddedCount, items.length);
                    // #34: this provider embeds and writes in one request, so
                    // there is no separate phase to report.
                    onProgress(actualEmbedded, items.length, 'Embedding and writing');
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
async function streamEmbeddingsAndWrite(backend, collectionId, items, textStrings, settings, onProgress,
    abortSignal = null, assertSameEmbeddingIdentity = null) {
    // VEC-6: Use configurable batch size for optimized bulk inserts
    const EMBEDDING_BATCH_SIZE = settings.insert_batch_size || 50;
    let totalProcessed = 0;
    const totalBatches = Math.ceil(textStrings.length / EMBEDDING_BATCH_SIZE);

    vhLog(`VectHare: Streaming ${items.length} items in ${totalBatches} batch(es) of up to ${EMBEDDING_BATCH_SIZE}`);

    // Process embeddings in batches
    for (let i = 0; i < textStrings.length; i += EMBEDDING_BATCH_SIZE) {
        const batchEnd = Math.min(i + EMBEDDING_BATCH_SIZE, textStrings.length);
        const batchTextStrings = textStrings.slice(i, batchEnd);
        const batchItems = items.slice(i, batchEnd);
        const batchNum = Math.floor(i / EMBEDDING_BATCH_SIZE) + 1;
        assertSameEmbeddingIdentity?.(); // #21: same embedding space for the whole run

        vhLog(`VectHare: Embedding batch ${batchNum}/${totalBatches} (items ${i + 1}-${batchEnd})`);
        // #34: the phase is reported by whoever performs it, not guessed from a
        // percentage. Here embedding and writing really are separate steps.
        onProgress?.(totalProcessed, items.length, 'Embedding');

        // Generate this batch once; provider/back-end retries are handled downstream.
        let additionalArgs;
        try {
            // R13: abortable - Stop cancels client-side embedding work instantly.
            additionalArgs = await makeAbortable(
                getAdditionalArgs(batchTextStrings, settings, null, abortSignal), abortSignal);
        } catch (error) {
            if (isAbortError(error)) throw error; // R13: propagate verbatim, no wrapping
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
        vhLog(`VectHare: Writing batch ${batchNum} to database (${itemsToWrite.length} items)`);
        onProgress?.(totalProcessed, items.length, 'Writing to database');
        try {
            // R13: abortable. R17: also timeout-bounded (was unbounded).
            await makeAbortable(AsyncUtils.retry(async () => {
                await withOpGuard(
                    () => backend.insertVectorItems(collectionId, itemsToWrite, settings),
                    abortSignal,
                    'Streamed batch write'
                );
            }, RETRY_CONFIG), abortSignal);
        } catch (error) {
            if (isAbortError(error)) throw error; // R13: propagate verbatim, no wrapping
            throw new Error(`VectHare: Failed to write batch ${batchNum} to database after retries: ${error.message}`);
        }

        totalProcessed += itemsToWrite.length;
        notifyDatabaseChanged(collectionId);

        // Update progress
        if (onProgress) {
            vhLog(`[Core Vector API] Streamed ${totalProcessed}/${items.length} (${Math.round((totalProcessed / items.length) * 100)}%)`);
            onProgress(totalProcessed, items.length, 'Written');
        }
    }

    vhLog(`VectHare: Completed streaming ${totalProcessed} items to database`);
}

/**
 * Deletes vector items from a collection
 * @param {string} collectionId - The collection to delete from
 * @param {number[]} hashes - The hashes of the items to delete
 * @param {object} settings VectHare settings object
 * @returns {Promise<void>}
 */
export async function deleteVectorItems(collectionId, hashes, settings, abortSignal = null) {
    assertVectHareCollectionForWrite(collectionId);
    assertNoStorageConflict(collectionId, settings?.vector_backend);
    await assertStorageWritable(collectionId, settings);
    // R17: guarded - deletes during a run were unabortable+untimed awaits
    const backend = await withOpGuard(() => getBackend(settings), abortSignal, 'Backend initialization (delete)');
    try {
        // VEC-33: Wrap with health invalidation. R17: abortable + timeout-bounded.
        const result = await withOpGuard(
            () => withHealthInvalidation(
                () => backend.deleteVectorItems(collectionId, hashes, settings),
                settings
            ),
            abortSignal,
            'Delete vectors'
        );
        // VEC-18: Record successful delete operation
        recordDelete(settings?.vector_backend || 'standard', hashes.length);
        notifyDatabaseChanged(collectionId);
        return result;
    } catch (error) {
        // VEC-18: Record error
        recordError(settings?.vector_backend || 'standard', error);
        throw error;
    }
}

/**
 * C12: reads the hash list of every registered collection that has not been
 * read yet this session, so getChunkMetadata can tell whether a pre-#23 shared
 * record belongs to exactly one collection. Does nothing when no shared record
 * exists. A collection that cannot be read stays unproven, and the shared
 * record is then not applied to any collection (fail closed).
 * @param {object} settings VectHare settings
 * @returns {Promise<number>} How many collections were newly read
 */
export async function primeChunkHashClaims(settings) {
    let newlyRead = 0;
    if (!hasSharedChunkRecords()) return newlyRead;
    for (const entry of registryEntriesMissingHashClaims()) {
        const parsed = parseRegistryKey(entry);
        const collectionId = parsed.collectionId || entry;
        // Only read collections that live in the backend/source being used;
        // reading another backend's collection through these settings would
        // return an empty list that looks like "holds nothing".
        if ((parsed.backend && parsed.backend !== settings.vector_backend) ||
            (parsed.source && settings.source && parsed.source !== settings.source)) continue;
        try {
            const hashes = await getSavedHashes(collectionId, settings);
            if (Array.isArray(hashes)) {
                noteCollectionHashClaims(collectionId, hashes);
                newlyRead++;
            }
        } catch (error) {
            console.debug(`VectHare: could not read hashes of ${collectionId} for annotation ownership: ${error.message}`);
        }
    }
    return newlyRead;
}

// RAG is read-only: older collections without provenance may still be searched
// (unverified), but confirmed mismatches and unreadable records are excluded.
const ragCompatibilityWarnings = new Set();
async function getQueryCollectionSettings(collectionId, settings, issueSink = null) {
    // VH-052: a collection on another backend/server is skipped with one notice
    // per chat, instead of being searched where it does not exist.
    try {
        const { collectionLivesElsewhere, noteChatLivesElsewhere } = await import('./backend-elsewhere.js');
        if (collectionLivesElsewhere(collectionId, settings).length) {
            if (String(collectionId).includes('vecthare_chat_')) noteChatLivesElsewhere(collectionId, settings);
            const key = `${collectionId}:elsewhere`;
            if (!ragCompatibilityWarnings.has(key)) {
                ragCompatibilityWarnings.add(key);
                console.warn(`VectHare: RAG skipping ${collectionId}: its vectors are on another backend or server`);
            }
            return null;
        }
    } catch (error) {
        console.debug(`VectHare: backend check for ${collectionId} failed: ${error.message}`);
    }
    // VH-044: the cached saved settings must notice changes another tab or
    // device made (one small request, at most every 2 s).
    await refreshStoreIfStale().catch(() => false);
    try {
        const result = await resolveCollectionOperationSettings(collectionId, settings, 'rag',
            { pipeline: 'rag', strategy: 'query' }, { readOnly: true, ragCache: true }); // VH-044
        if (result.status === 'legacy_readonly') {
            // VH-061: used only when nothing shows it was made differently.
            const { legacyVerdict, noteLegacyNotUsed } = await import('./legacy-collections.js');
            const verdict = await legacyVerdict(collectionId, result.settings || settings);
            if (!verdict.usable) {
                noteLegacyNotUsed(collectionId, getCollectionMeta(collectionId)?.displayName, verdict.reason);
                return null;
            }
            const key = `${collectionId}:legacy_readonly`;
            if (!ragCompatibilityWarnings.has(key)) {
                ragCompatibilityWarnings.add(key);
                console.warn(`VectHare: RAG using unverified legacy collection ${collectionId} (needs re-vectorizing)`);
            }
        }
        return result.settings;
    } catch (error) {
        const key = `${collectionId}:blocked:${error.message}`;
        if (!ragCompatibilityWarnings.has(key)) {
            ragCompatibilityWarnings.add(key);
            console.warn(`VectHare: RAG skipping collection ${collectionId}: ${error.message}`);
        }
        // C10: the console warning above is once per session; the caller's
        // sink gets every skip so the user can be told why memories are missing.
        if (Array.isArray(issueSink)) issueSink.push({ collectionId, reason: String(error?.message || error) });
        return null;
    }
}

/** Separate collections by effective query embedding/storage settings. Never
 * query two different embedding spaces with one prepared query vector. */
async function groupQueryCollections(collectionIds, settings) {
    const located = await Promise.all(collectionIds.map(async collectionId => ({
        collectionId, settings: await getQueryCollectionSettings(collectionId, settings),
    })));
    const groups = new Map();
    for (const entry of located) {
        if (!entry.settings) continue;
        const snapshot = createInitialVectorizationConfig(entry.settings, { pipeline: 'rag', strategy: 'query' });
        if (!snapshot) continue;
        const key = JSON.stringify([snapshot.embedding, snapshot.storage]);
        if (!groups.has(key)) groups.set(key, { collectionIds: [], settings: entry.settings });
        groups.get(key).collectionIds.push(entry.collectionId);
    }
    return [...groups.values()];
}

/**
 * Queries a single collection for similar vectors
 * Applies keyword boost system: overfetch → boost → trim
 * For client-side embedding sources (webllm, koboldcpp, bananabread), generates query embedding first.
 * @param {string} collectionId - The collection to query
 * @param {string} searchText - The text to query
 * @param {number} topK - The number of results to return
 * @param {object} settings VectHare settings object
 * @param {Map|null} queryVectorCache Shared query-vector cache
 * @param {Array|null} issueSink Optional array that receives {collectionId, reason} when the collection is skipped
 * @returns {Promise<{ hashes: number[], metadata: object[]}>} - Hashes and metadata of the results
 */
export async function queryCollection(collectionId, searchText, topK, settings, queryVectorCache = null, issueSink = null) {
    const resolved = await getQueryCollectionSettings(collectionId, settings, issueSink);
    if (!resolved) return { hashes: [], metadata: [] };
    settings = resolved;
    // #52: collections sharing one embedding configuration share one query
    // vector. Keyed by the resolved provider/model/endpoint, so a collection
    // saved with different embedding settings never reuses a foreign vector.
    const vectorCacheKey = queryVectorCache ? [settings.source,
        getModelField(settings.source) ? settings[getModelField(settings.source)] || '' : '',
        settings.use_alt_endpoint ? settings.alt_endpoint_url || '' : ''].join('|') : null;
    const queryChunking = { pipeline: 'rag', strategy: 'query' };
    const capturedConfig = createInitialVectorizationConfig(settings, queryChunking);
    assertCollectionOperationSettingsStable(capturedConfig, settings, queryChunking);
    const backend = await getBackend(settings);

    // Sources that require client-side embedding generation
    const clientSideEmbeddingSources = ['webllm', 'koboldcpp', 'bananabread'];
    let queryVector = null;

    // If source requires client-side embeddings, generate query vector
    if (vectorCacheKey && queryVectorCache.has(vectorCacheKey)) {
        queryVector = queryVectorCache.get(vectorCacheKey);
    } else if (clientSideEmbeddingSources.includes(settings.source)) {
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
        if (vectorCacheKey && Array.isArray(queryVector) && queryVector.length) {
            queryVectorCache.set(vectorCacheKey, queryVector);
        }
    } else if (vectorCacheKey && PREEMBED_QUERY_BACKENDS.includes(settings.vector_backend)) {
        // #52: embed once for this configuration; later collections reuse it.
        queryVector = await embedQueryForSettings(searchText, settings);
        if (Array.isArray(queryVector) && queryVector.length) {
            queryVectorCache.set(vectorCacheKey, queryVector);
        }
    }

    // Check if hybrid search is enabled
    if (settings.hybrid_search_enabled) {
        vhLog('[VectHare] Hybrid search enabled, dispatching to hybrid search module');
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
    const resultsForBoost = rawResults.metadata.map((meta, idx) => ({
        hash: meta.hash || rawResults.hashes[idx],
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
    const groups = await groupQueryCollections(collectionIds, settings);
    const results = {};
    for (const group of groups) {
        try {
            Object.assign(results, await queryMultipleCollectionsForSettings(group.collectionIds,
                searchText, topK, threshold, group.settings));
        } catch (error) {
            console.warn('VectHare: RAG failed for a saved embedding configuration:', error.message);
        }
    }
    return results;
}

async function queryMultipleCollectionsForSettings(collectionIds, searchText, topK, threshold, settings) {
    const queryChunking = { pipeline: 'rag', strategy: 'query' };
    const capturedConfig = createInitialVectorizationConfig(settings, queryChunking);
    assertCollectionOperationSettingsStable(capturedConfig, settings, queryChunking);
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

    // #52: one query, one embedding. Every plugin-backed backend can take the
    // vector, so none of them re-embeds the same query per collection.
    if (!queryVector && !clientSideEmbeddingSources.includes(settings.source) &&
        collectionIds.length > 1 && PREEMBED_QUERY_BACKENDS.includes(settings.vector_backend)) {
        queryVector = await embedQueryForSettings(searchText, settings);
    }

    // Check if hybrid search is enabled - process each collection with hybrid search
    if (settings.hybrid_search_enabled) {
        vhLog('[VectHare] Hybrid search enabled for multi-collection query');
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
        const resultsForBoost = collectionResults.metadata.map((meta, idx) => ({
            hash: meta.hash || collectionResults.hashes[idx],
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
        vhLog('VectHare: No collections passed activation conditions');
        return {};
    }

    // Guard the direct backend route too. Query each embedding space using
    // its own saved settings rather than applying one global model to all.
    const groups = await groupQueryCollections(activeCollectionIds, settings);
    const results = {};
    for (const group of groups) {
        try {
            const queryChunking = { pipeline: 'rag', strategy: 'query' };
            const capturedConfig = createInitialVectorizationConfig(group.settings, queryChunking);
            assertCollectionOperationSettingsStable(capturedConfig, group.settings, queryChunking);
            const backend = await getBackend(group.settings);
            Object.assign(results, await backend.queryMultipleCollections(group.collectionIds,
                searchText, topK, threshold, group.settings));
        } catch (error) {
            console.warn('VectHare: RAG failed for a saved embedding configuration:', error.message);
        }
    }
    return results;
}

/**
 * Purges the vector index for a collection.
 * @param {string} collectionId Collection ID to purge
 * @param {object} settings VectHare settings object
 * @returns {Promise<boolean>} True if deleted, false if not
 */
export async function purgeVectorIndex(collectionId, settings, options = {}) {
    // Phase 1: never purge while VectHare's own metadata is uncertain - the
    // destination and ownership checks below depend on it.
    assertStoreAuthoritative('Purging a collection');
    // 8B: ownership/destination checks below must see other tabs' changes.
    await refreshStoreIfStale({ minIntervalMs: 0 }).catch(() => false);
    // H3: with Qdrant multitenancy every collection shares one store and the
    // plugin cannot remove one of them on its own (its purge would target a
    // collection name that does not exist there and report success while the
    // vectors stay). Refuse up front; nothing is changed.
    // 9b: the collection's own layout decides (its locator, or today's setting).
    if ((settings?.vector_backend || 'standard') === 'qdrant' &&
        resolveStorage(collectionId, settings, 'qdrant').layout === 'legacy-mt') {
        const reason = 'Deleting a single collection is not available while Qdrant multitenancy is on ' +
            '(all collections share one store). Nothing was changed.';
        if (options.diagnostics && typeof options.diagnostics === 'object') options.diagnostics.reason = reason;
        console.warn(`VectHare: ${reason} (${collectionId})`);
        return false;
    }
    // 9c: a v2 collection can only be removed by a plugin that scopes it.
    if (resolveStorage(collectionId, settings).v2 && !await scopedTenancySupported()) {
        const reason = 'This collection uses a newer storage layout that the installed plugin does not support. ' +
            'Update the plugin; nothing was changed.';
        if (options.diagnostics && typeof options.diagnostics === 'object') options.diagnostics.reason = reason;
        return false;
    }
    // 8C: no delete while another tab/device is working on this collection.
    let purgeLease = null;
    try {
        purgeLease = await acquireLease(parseRegistryKey(collectionId).collectionId || collectionId, { label: 'Delete' });
    } catch (error) {
        if (error?.code !== 'VH_LEASE_HELD') throw error;
        if (options.diagnostics && typeof options.diagnostics === 'object') options.diagnostics.reason = error.message;
        console.warn(`VectHare: ${error.message} (${collectionId})`);
        return false;
    }
    try {
        // The name check is VectHare's standing protection for collections it
        // does not own. The single exception is a deletion the user explicitly
        // confirmed for a named destination they recognise as theirs - an old
        // collection predating VectHare's ownership markers would otherwise be
        // undeletable forever. Nothing else in this module accepts that flag.
        if (options.userConfirmedUnownedDeletion === true) {
            console.warn(`VectHare: Purging ${collectionId} on explicit user authority - ` +
                'VectHare cannot verify it owns this collection');
        } else {
            assertVectHareCollectionForWrite(collectionId);
        }
        const backendName = settings?.vector_backend || 'standard';
        const isStandard = backendName === 'standard' || backendName === 'vectra';
        // A collection VectHare cannot prove is its own has no VectHare
        // identity ledger, so the Standard ledger-recovery machinery below has
        // nothing to protect and nothing to recover - and its own routes are
        // (correctly) closed to non-VectHare identities. Purge the destination
        // directly instead of failing on a record that cannot exist.
        if (isStandard && options.userConfirmedUnownedDeletion === true) {
            const backend = await getBackend(settings);
            await backend.purgeVectorIndex(collectionId,
                { ...settings, __vecthareConfirmUnowned: true });
            vhLog(`VectHare: Purged vector index for collection ${collectionId}`);
            notifyDatabaseChanged(collectionId);
            return true;
        }
        if (isStandard) {
            const source = settings?.source || 'transformers';
            const modelField = getModelField(source);
            const modelFolder = modelField ? (settings[modelField] || '') : '';
            const destination = JSON.stringify([backendName, source, modelFolder]);
            // VH-099: "vectra" and "standard" are two names for this backend (older
            // registry entries use "vectra"); a pending record under either is ours.
            const sameDestination = recorded => ['standard', 'vectra'].some(name =>
                recorded === JSON.stringify([name, source, modelFolder]));
            const stored = await standardPurgeRecovery(collectionId, 'read');
            if (!['found', 'missing'].includes(stored.status)) {
                throw new Error('Standard purge recovery record is invalid or unavailable');
            }
            let pending = stored.status === 'found' ? stored.record : null;
            if (pending && !sameDestination(pending.destination)) {
                throw new Error('Pending Standard ledger cleanup belongs to different collection settings');
            }
            const location = { backend: backendName, source, model: modelFolder };
            let saved = await readInitialVectorizationConfig(collectionId, settings, location);
            const absent = () => saved.status === 'missing' && saved.physicalAbsent === true;
            if (pending) {
                // The physical-absence check is read-only. Never use the native
                // accessor here: listing a missing Vectra index can recreate it.
                if (!absent()) {
                    if (saved.status !== 'valid' || saved.config.identityLedger !== 1 ||
                        saved.config.recordedAt !== pending.originalRecordedAt ||
                        saved.config.embedding.provider !== source ||
                        (saved.config.embedding.model || '') !== (pending.binding.model || '') ||
                        JSON.stringify({
                            backend: saved.config.storage.backend,
                            source: saved.config.embedding.provider,
                            model: saved.config.embedding.model || '',
                            storage: saved.config.storage,
                            chunking: saved.config.chunking,
                        }) !== JSON.stringify(pending.binding)) {
                        throw new Error('Pending Standard purge cannot verify original collection; cleanup blocked');
                    }
                }
            } else {
                // The provenance requirement protects VECTORS: it stops a purge
                // whose destination cannot be proven to be the one the
                // collection was written to. A collection the caller has just
                // read as empty at this exact destination holds no vectors to
                // protect, so an empty collection with no recorded
                // configuration stays deletable instead of being stuck.
                const provenanceVerified = saved.status === 'valid' &&
                    saved.config.embedding.provider === source &&
                    (!modelField || (saved.config.embedding.model || '') === modelFolder);
                // A legacy or incompatible collection must not be permanently
                // undeletable. Provenance is one way to prove the destination;
                // the caller may instead have proved it independently - the
                // collection was just confirmed to exist at THIS recorded
                // destination, that destination is a backend-qualified registry
                // entry for this identity, and the identity is VectHare-owned.
                // Either proof is enough to delete; neither is enough to embed,
                // sync, repair or rebuild, which still require the real config.
                if (!provenanceVerified && options.verifiedEmpty !== true &&
                    options.ownershipVerified !== true &&
                    options.userConfirmedUnownedDeletion !== true) {
                    throw new Error('Cannot verify this collection\'s original model/source, and its ' +
                        'ownership and destination were not independently verified either; purge blocked. ' +
                        `Unverified: original configuration (${saved.status}${saved.reason ? `: ${saved.reason}` : ''}).`);
                }
                if (!provenanceVerified) {
                    console.warn(`VectHare: Purging ${collectionId} without a verifiable original ` +
                        `configuration (${options.verifiedEmpty === true
                            ? 'confirmed empty at this destination'
                            : 'ownership and destination independently verified'})`);
                }
                if (saved.status === 'valid' && saved.config.identityLedger === 1) {
                    const config = saved.config;
                    const binding = {
                        backend: config.storage.backend,
                        source: config.embedding.provider,
                        model: config.embedding.model || '',
                        storage: config.storage,
                        chunking: config.chunking,
                    };
                    // VH-099: the record's backend must be the saved one (the plugin
                    // checks record.backend === binding.backend); a "vectra" registry
                    // entry for a collection saved as "standard" sent both names and
                    // every delete failed with "purge recovery prepare: HTTP 400".
                    const recordBackend = ['standard', 'vectra'].includes(binding.backend) ? binding.backend : backendName;
                    pending = { version: 1, collectionId, backend: recordBackend,
                        source, modelFolder, destination: JSON.stringify([recordBackend, source, modelFolder]),
                        originalRecordedAt: config.recordedAt, binding };
                    // Must be durable BEFORE native deletion removes the original
                    // saved configuration. An unconfirmed write blocks the purge.
                    await standardPurgeRecovery(collectionId, 'prepare', pending);
                }
            }
            if (!absent()) {
                const backend = await getBackend(settings);
                await backend.purgeVectorIndex(collectionId, options.userConfirmedUnownedDeletion === true
                    ? { ...settings, __vecthareConfirmUnowned: true } : settings);
            }
            if (pending) {
                saved = await readInitialVectorizationConfig(collectionId, settings, location);
                if (!absent()) {
                    throw new Error('Standard purge not verified empty; VectHare ledger retained for recovery');
                }
                const response = await fetch('/api/plugins/similharity/identity-ledger/save', {
                    method: 'POST', headers: getRequestHeaders(),
                    body: JSON.stringify({ collectionId, binding: pending.binding, ledger: null }),
                });
                if (!response.ok || (await response.json()).success !== true) {
                    throw new Error('Native vectors purged, but VectHare ledger cleanup was not confirmed');
                }
                // If this call fails, the durable intent remains. Retrying after
                // a restart can safely repeat the idempotent ledger invalidation.
                await standardPurgeRecovery(collectionId, 'clear', pending);
            }
        } else {
            const backend = await getBackend(settings);
            await backend.purgeVectorIndex(collectionId, options.userConfirmedUnownedDeletion === true
                ? { ...settings, __vecthareConfirmUnowned: true } : settings);
        }
        vhLog(`VectHare: Purged vector index for collection ${collectionId}`);
        notifyDatabaseChanged(collectionId);
        return true;
    } catch (error) {
        // VEC-33: Invalidate health cache on operation error
        invalidateBackendHealth(settings?.vector_backend || 'standard', error);
        // Hand the real reason back so the caller can report what is
        // unverified instead of a generic failure.
        if (options.diagnostics && typeof options.diagnostics === 'object') {
            options.diagnostics.reason = error.message;
        }
        console.error('VectHare: Failed to purge', error);
        return false;
    } finally {
        await purgeLease?.release();
    }
}

/**
 * Purges the vector index for a file.
 * @param {string} collectionId File collection ID to purge
 * @param {object} settings VectHare settings object
 * @returns {Promise<void>}
 */
export async function purgeFileVectorIndex(collectionId, settings) {
    if ((settings?.vector_backend || 'standard') === 'qdrant' &&
        resolveStorage(collectionId, settings, 'qdrant').layout === 'legacy-mt') {
        // H3: see purgeVectorIndex.
        throw new Error('Deleting a single collection is not available while Qdrant multitenancy is on. Nothing was changed.');
    }
    try {
        assertVectHareCollectionForWrite(collectionId);
        vhLog(`VectHare: Purging file vector index for collection ${collectionId}`);
        const backend = await getBackend(settings);
        await backend.purgeFileVectorIndex(collectionId, settings);
        vhLog(`VectHare: Purged vector index for collection ${collectionId}`);
        notifyDatabaseChanged(collectionId);
    } catch (error) {
        // VEC-33: Invalidate health cache on operation error
        invalidateBackendHealth(settings?.vector_backend || 'standard', error);
        console.error('VectHare: Failed to purge file', error);
    }
}

/**
 * VH-093: the same server written two ways ("localhost:6333/" vs
 * "127.0.0.1:6333") is still the same server.
 */
function sameServerAddress(a, b) {
    const norm = value => {
        if (!value) return '';
        try {
            const text = String(value);
            const url = new URL(text.includes('://') ? text : `http://${text}`);
            let host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
            if (host === 'localhost' || host === '::1' || host === '0.0.0.0' || /^127\./.test(host)) host = '127.0.0.1';
            const port = url.port || (url.protocol === 'https:' ? '443' : '80');
            return `${url.protocol}//${host}:${port}${url.pathname.replace(/\/+$/, '')}`;
        } catch {
            return String(value).trim().toLowerCase();
        }
    };
    return norm(a) === norm(b);
}

/**
 * VH-093: whether a chat's recorded store destination names the same server as
 * today's settings. Only the server counts here: the API-key fingerprint is a
 * change detector, and where the collection lives on that server is checked
 * separately.
 */
function sameStoreServer(backend, recorded, current) {
    if (recorded === current) return true;
    let r, c;
    try { r = JSON.parse(recorded); c = JSON.parse(current); } catch { return false; }
    if (!Array.isArray(r) || !Array.isArray(c)) return false;
    if (backend === 'qdrant') {
        if (Boolean(r[0]) !== Boolean(c[0])) return false;
        return r[0] ? sameServerAddress(r[1], c[1]) : sameServerAddress(`${r[2] || 'localhost'}:${r[3] || 6333}`, `${c[2] || 'localhost'}:${c[3] || 6333}`);
    }
    if (backend === 'milvus') {
        const addr = x => x[0] || `${x[1] || 'localhost'}:${x[2] || 19530}`;
        return sameServerAddress(addr(r), addr(c));
    }
    return false;
}

/**
 * Purge registered VectHare-owned collections only. Never invoke a backend's
 * global purge, since those backends can share vanilla SillyTavern storage.
 * Fail closed (and keep VectHare settings) when a registered destination cannot
 * be verified; caller may retry after restoring the backend connection.
 */
export async function purgeAllVectorIndexes(settings, options = {}) {
    assertStoreAuthoritative('Full Purge');
    // 8C: Purge All runs alone - an exclusive lease, only granted while no other
    // tab/device holds any lease, blocks all other work until it finishes.
    return await withLease('*', () => purgeAllVectorIndexesLeased(settings, options), { label: 'Purge All' });
}

async function purgeAllVectorIndexesLeased(settings, options = {}) {
    const { getCollectionRegistry, discoverExistingCollections } = await import('./collection-loader.js');
    // VH-092: see what the servers hold now (as the Database Browser does), so
    // found collections are purged too and every location that can be recorded is.
    try { await discoverExistingCollections(settings); } catch (error) {
        console.warn('VectHare: Purge could not refresh the collection list first:', error?.message || error);
    }
    const { parseRegistryKey, getBoundChatDetails, chatStoreDestination } =
        await import('./collection-ids.js');
    const { readInitialVectorizationConfig, createInitialVectorizationConfig,
        locateQdrantCollectionByPresence, verifyPhysicalCollectionExistence } =
        await import('./collection-metadata.js');
    // VH-028: a bare id next to its backend:source:id twin is the same collection
    // (older builds registered both); purge it once, through the qualified key.
    const fullRegistry = [...new Set(getCollectionRegistry())];
    const qualifiedIds = new Set(fullRegistry.filter(key => parseRegistryKey(key).backend)
        .map(key => parseRegistryKey(key).collectionId));
    const aliases = fullRegistry.filter(key => !parseRegistryKey(key).backend && qualifiedIds.has(key));
    const registry = fullRegistry.filter(key => !aliases.includes(key));
    const visited = new Set();
    let removed = 0;
    const skipped = [];
    const ignored = [];
    // S6: `onIssue` lets a caller list each kept/unverified entry in the panel.
    const skip = text => { skipped.push(text); options.onIssue?.(text); };
    // A deleted/undiscovered registry entry must not make us discard the only
    // saved mapping to a collection that may still contain VectHare vectors.
    const knownDestinations = new Set(registry.map(key => {
        const p = parseRegistryKey(key);
        return `${p.backend === 'vectra' ? 'standard' : p.backend}:${p.source}:${p.collectionId}`;
    }));
    const registeredIds = new Set(registry.map(key => parseRegistryKey(key).collectionId));
    for (const [key, meta] of Object.entries(extension_settings.vecthare?.collections || {})) {
        const id = parseRegistryKey(key).collectionId;
        if (/^vecthare_[A-Za-z0-9_.-]+$/.test(id) && !registeredIds.has(id) &&
            (meta?.createdAt || Number(meta?.chunkCount) > 0)) {
            skip(`unregistered-metadata:${id}`);
        }
    }
    for (const [id, rec] of Object.entries(
        vecthareState().chatCollectionBindings?.byCollection || {})) {
        for (const store of rec?.stores || []) {
            const name = store.backend === 'vectra' ? 'standard' : store.backend;
            const destination = `${name}:${store.source}:${id}`;
            if (knownDestinations.has(destination)) continue;
            // VH-092: a chat binding whose store is missing from the registry is
            // purged (or found already gone) like a registered one, instead of
            // stopping the whole purge; its mapping is cleared only afterwards.
            if (['standard', 'lancedb', 'qdrant', 'milvus'].includes(name) && store.source &&
                /^vecthare_[A-Za-z0-9_.-]+$/.test(id)) {
                registry.push(destination);
                knownDestinations.add(destination);
            } else {
                skip(`unregistered:${destination}`);
            }
        }
    }
    let purgeStep = 0;
    for (const registryKey of registry) {
        options.onProgress?.({ done: purgeStep, total: registry.length,
            id: parseRegistryKey(registryKey).collectionId });
        purgeStep++;
        const parsed = parseRegistryKey(registryKey);
        const id = parsed.collectionId;
        const backendName = parsed.backend === 'vectra' ? 'standard' : parsed.backend;
        const source = parsed.source;
        // Discovery may also record other ST vector collections. Ignore those
        // entirely; they are not owned by VectHare and are not purge targets.
        try { assertVectHareCollectionForWrite(id); }
        catch { ignored.push(registryKey); continue; }
        if (!backendName || !source ||
            !['standard', 'lancedb', 'qdrant', 'milvus'].includes(backendName)) {
            skip(`${registryKey} (its entry does not say which backend and provider it is on)`);
            continue;
        }
        const destination = `${backendName}:${source}:${id}`;
        if (visited.has(destination)) continue;
        visited.add(destination);
        // VH-092 (as VH-089): a Qdrant collection without a locator is looked up
        // where it really is, not where today's multitenancy switch points.
        if (backendName === 'qdrant') {
            await locateQdrantCollectionByPresence(id, { ...settings, vector_backend: backendName, source }).catch(() => null);
        }
        // 9b: storage switches describe this collection (its locator, or today's).
        const operationSettings = settingsForCollectionStorage(id, { ...settings, vector_backend: backendName, source });
        // VH-092: confirmed absent at its own location = nothing left to purge.
        // Only an explicit 'absent' counts (a shared old store answers 'unverified').
        try {
            const where = await verifyPhysicalCollectionExistence(id, operationSettings, { backend: backendName, source });
            const locationKnown = !['qdrant', 'milvus'].includes(backendName) ||
                resolveStorage(id, operationSettings, backendName).fromLocator === true;
            if (where.existence === 'absent' && locationKnown) {
                removed++;
                continue;
            }
        } catch { /* checked again by the steps below */ }
        // Shared-store cleanup is unsafe unless the backend can prove scoped
        // deletion. Do not remove the Qdrant multitenancy or Milvus parent.
        // 9c (P7): lifted for the new layouts when the plugin scopes them.
        const storageNow = resolveStorage(id, operationSettings, backendName);
        if ((backendName === 'milvus' && !(storageNow.v2 && await scopedTenancySupported())) ||
            (backendName === 'qdrant' && storageNow.layout === 'legacy-mt')) {
            skip(`${registryKey} (it is in an older shared store that cannot remove one collection; ` +
                'move it in Database Browser > Storage, or delete it there)');
            continue;
        }
        const binding = getBoundChatDetails(id);
        if (binding) {
            const destinations = binding.stores || [];
            if (destinations.length && !destinations.some(store =>
                (store.backend === backendName || (backendName === 'standard' && store.backend === 'vectra')) &&
                store.source === source && store.destination &&
                sameStoreServer(backendName, store.destination, chatStoreDestination(operationSettings, id)))) {
                skip(`${registryKey} (its chat is linked to it on another server or backend)`);
                continue;
            }
        }
        // Remote address must match the database's saved original location;
        // merely changing VectHare's active backend is not authorization.
        if (backendName === 'qdrant') {
            const saved = await readInitialVectorizationConfig(id, operationSettings,
                { backend: backendName, source });
            const actual = createInitialVectorizationConfig(operationSettings,
                { pipeline: 'rag', strategy: 'query' });
            // VH-093: what must match is the server (the address, however it is
            // written) and the provider. Where it lives on that server (its own
            // collection or a shared store) is established separately above.
            let why = null;
            if (saved.status !== 'valid') {
                why = saved.status === 'missing'
                    ? 'no saved VectHare settings were found for it on this server, so it cannot be confirmed as yours; delete it in the Database Browser if it is'
                    : `its saved settings could not be read (${saved.status}${saved.reason ? `: ${saved.reason}` : ''})`;
            } else if (!actual) {
                why = 'the current settings could not be described';
            } else if (saved.config.embedding?.provider !== source) {
                why = `it was made with ${saved.config.embedding?.provider || 'another provider'}, but it is listed under ${source}`;
            } else if (saved.config.storage?.backend !== actual.storage?.backend ||
                !sameServerAddress(saved.config.storage?.address, actual.storage?.address)) {
                why = `it was made on ${saved.config.storage?.address || 'another server'}, not on the server selected now (${actual.storage?.address || 'unknown'})`;
            }
            if (why) {
                skip(`${registryKey} (${why})`);
                continue;
            }
        }
        const purgeDiagnostics = {};
        if (!await purgeVectorIndex(id, operationSettings, { diagnostics: purgeDiagnostics })) {
            skip(`${registryKey} (${purgeDiagnostics.reason || 'the backend did not confirm the delete'})`);
            continue;
        }
        // #27: an acknowledged purge is not proof of deletion, and the caller
        // clears VectHare's tracking on the strength of this result. Confirm the
        // destination no longer holds the collection's backend-resident record.
        // This uses the read-only provenance accessor on purpose: listing a
        // missing Vectra index through the native API can recreate it.
        try {
            const after = await readInitialVectorizationConfig(id, operationSettings,
                { backend: backendName, source });
            const gone = after.status === 'missing' &&
                (!['standard', 'lancedb'].includes(backendName) || after.physicalAbsent !== false);
            if (!gone) {
                skip(`unverified-deletion:${registryKey}`);
                continue;
            }
        } catch (error) {
            console.warn(`VectHare: Could not verify deletion of ${id}:`, error.message);
            skip(`unverified-deletion:${registryKey}`);
            continue;
        }
        removed++;
    }
    // A fresh unregistered installation is empty, but any unknown registered
    // collection means we cannot truthfully report a complete purge.
    options.onProgress?.({ done: registry.length, total: registry.length, id: null });
    return { success: skipped.length === 0, removed, skipped, ignored };
}

/**
 * Update chunk text (triggers re-embedding)
 * @param {string} collectionId - Collection ID
 * @param {number} hash - Chunk hash
 * @param {string} newText - New text content
 * @param {object} settings - VectHare settings
 */
export async function updateChunkText(collectionId, hash, newText, settings) {
    assertVectHareCollectionForWrite(collectionId);
    // VH-034 / VH-039 (option C): a chat chunk's text follows its message; an
    // edited copy would be re-added next to the original by the next Sync.
    if (String(parseRegistryKey(collectionId).collectionId || collectionId).startsWith('vecthare_chat_')) {
        throw new Error('Chat chunks follow the chat; edit the message instead.');
    }
    assertNoStorageConflict(collectionId, settings?.vector_backend);
    await assertStorageWritable(collectionId, settings);
    settings = await resolveEmbeddingSettingsForEdit(collectionId, settings);
    const backend = await getBackend(settings);
    return await backend.updateChunkText(collectionId, hash, newText, settings);
}

/**
 * #60: a manual re-embed must use the collection's recorded embedding space.
 * A confirmed mismatch or unreadable record blocks the edit; a legacy collection
 * with no record keeps its previous behaviour (nothing is assigned to it).
 */
/**
 * VH-048: on the Standard backend each embedding model keeps its own copy of a
 * collection (one folder per model). Deleting a collection after the model was
 * changed used today's model and so looked in the wrong folder. This answers
 * the settings with the model the collection was made with, taken from its own
 * saved settings, when those settings are on the same backend and provider.
 * Anything else (another backend, no saved settings) is returned unchanged.
 * @param {string} collectionId
 * @param {object} settings Settings addressing the destination to delete
 * @returns {Promise<object>}
 */
export async function withCollectionModelForStandard(collectionId, settings) {
    const backend = settings?.vector_backend || 'standard';
    if (!['standard', 'vectra'].includes(backend)) return settings;
    const source = settings?.source || 'transformers';
    const field = getModelField(source);
    if (!field) return settings;
    try {
        // Only the model is needed, so the saved record is read directly (no
        // model given: the plugin searches the model folders) rather than
        // resolving the full embedding settings, which refuses when, say, the
        // endpoint cannot be reproduced.
        const saved = await readInitialVectorizationConfig(collectionId, settings, { backend, source });
        const savedModel = saved?.status === 'valid' && saved.config?.embedding?.provider === source
            ? saved.config.embedding.model : null;
        if (typeof savedModel === 'string' && savedModel && savedModel !== settings[field]) {
            vhLog(`VectHare: ${collectionId} was made with ${source} model "${savedModel}"; deleting that copy`);
            return { ...settings, [field]: savedModel };
        }
    } catch (error) {
        console.debug('VectHare: Could not read the saved model for delete:', error?.message || error);
    }
    return settings;
}

export async function resolveEmbeddingSettingsForEdit(collectionId, settings) {
    const result = await resolveCollectionOperationSettings(collectionId, settings, 'rag',
        { pipeline: 'rag', strategy: 'query' }, { readOnly: true });
    return result.settings;
}

/**
 * Update chunk metadata (no re-embedding)
 * @param {string} collectionId - Collection ID
 * @param {number} hash - Chunk hash
 * @param {object} metadata - Metadata to update (keywords, enabled, etc.)
 * @param {object} settings - VectHare settings
 */
export async function updateChunkMetadata(collectionId, hash, metadata, settings) {
    assertVectHareCollectionForWrite(collectionId);
    assertNoStorageConflict(collectionId, settings?.vector_backend);
    await assertStorageWritable(collectionId, settings);
    const backend = await getBackend(settings);
    return await backend.updateChunkMetadata(collectionId, hash, metadata, settings);
}
