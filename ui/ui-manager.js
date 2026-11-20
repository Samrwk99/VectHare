import { escapeHtml } from '../utils/html.js';
import { vhLog } from '../utils/log.js';
/**
 * ============================================================================
 * VECTHARE UI MANAGER
 * ============================================================================
 * Handles ALL UI rendering and event binding
 * Keeps index.js clean and lean
 *
 * @author Coneja Chibi
 * @version see manifest.json
 * ============================================================================
 */

import { saveSettingsDebounced, getCurrentChatId, eventSource, event_types } from '../../../../../script.js';
import { vecthareState } from '../core/vecthare-store.js';
import { extension_settings, openThirdPartyExtensionMenu } from '../../../../extensions.js';
import { writeSecret, SECRET_KEYS, secret_state, readSecretState } from '../../../../secrets.js';
import { getWebLlmProvider as getSharedWebLlmProvider } from '../providers/webllm.js';
import { openVisualizer } from './chunk-visualizer.js';
import { openDatabaseBrowser } from './database-browser.js';
import { openContentVectorizer } from './content-vectorizer.js';
import { openSearchDebugModal, getLastSearchDebug } from './search-debug.js';
import { openTextCleaningManager } from './text-cleaning-manager.js';
import { resetBackendHealth } from '../backends/backend-manager.js';
import { getHealthIndicatorHtml, getHealthModalHtml, initializeHealthDashboard, checkBackendHealth } from './health-dashboard.js';
import { getChatCollectionId } from '../core/chat-vectorization.js';
import { isCollectionEnabled, isCollectionAutoSyncEnabled } from '../core/collection-metadata.js';
import { getProviderSpecificParams } from '../backends/provider-params.js';
import { describeContextLine } from '../core/context-line.js';
import { doesChatHaveVectors, getCollectionRegistry, invalidateCollectionInventory } from '../core/collection-loader.js';
import { parseRegistryKey } from '../core/collection-ids.js';
import { getModelField } from '../core/providers.js';
import { getChunkingStrategies } from '../core/content-types.js';
import { fetchSecretStatus, setSecret } from '../core/secret-store.js';
import { checkPluginCompatibility, readBackendServerInfo, readSillyTavernInfo } from '../core/plugin-health.js';

/**
 * Applies the current settings snapshot without overwriting collection metadata
 * and registry updates written by other UI/code paths while the panel was open.
 * @param {object} settingsSnapshot
 */
function applySettingsSnapshot(settingsSnapshot) {
    const { collections, vecthare_collection_registry, ...safeSettings } = settingsSnapshot;
    Object.assign(extension_settings.vecthare, safeSettings);
}

/**
 * Turns a password input into a key-store field: "Key set ✓ [Replace] [Remove]"
 * when a key is stored, otherwise the input plus a Save button. The key itself
 * is never read back into the page; it goes to the plugin's key store only.
 * @param {string} inputSelector
 * @param {string} name One of the key store names (qdrant_api_key, ...)
 * @param {object} settings
 */
function bindSecretField(inputSelector, name, settings) {
    const $input = $(inputSelector);
    if (!$input.length) return;
    const originalPlaceholder = $input.attr('placeholder') || '';
    $input.val('');
    const $row = $('<div class="vecthare-secret-row" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:4px;"></div>');
    $input.after($row);

    let state = { known: false, set: Boolean(settings[name]) };
    let replacing = false;

    const button = (label, handler) =>
        $('<button type="button" class="vecthare-btn-secondary"></button>').text(label).on('click', handler);

    const render = () => {
        $row.empty();
        if (!state.known && !settings[name]) {
            // Plugin unreachable: the key cannot be stored, so do not pretend.
            $input.hide();
            $row.append($('<small></small>').text('Key store unavailable (Similharity plugin not reachable).'));
            $row.append(button('Retry', refresh));
            return;
        }
        if (state.set && !replacing) {
            $input.hide();
            $row.append($('<small></small>').text(
                settings[name] ? 'Key set ✓ (moving to key store)' : 'Key set ✓'));
            $row.append(button('Replace', () => { replacing = true; render(); $input.trigger('focus'); }));
            $row.append(button('Remove', remove));
            return;
        }
        $input.show().attr('placeholder', originalPlaceholder).val('');
        $row.append(button('Save', save));
        if (replacing) $row.append(button('Cancel', () => { replacing = false; render(); }));
    };

    const refresh = async () => {
        const result = await fetchSecretStatus();
        state = { known: result.ok, set: Boolean(result.status?.[name]) || Boolean(settings[name]) };
        render();
    };

    const save = async () => {
        const value = String($input.val()).trim();
        if (!value) { toastr.warning('Enter a key first'); return; }
        try {
            await setSecret(name, value, settings);
            $input.val('');
            replacing = false;
            state = { known: true, set: true };
            resetBackendHealth();
            invalidateCollectionInventory(); // K3
            toastr.success('Key saved');
        } catch (error) {
            toastr.error(`Could not save the key: ${error.message}`);
        }
        render();
    };

    const remove = async () => {
        try {
            await setSecret(name, '', settings);
            state = { known: true, set: false };
            replacing = false;
            resetBackendHealth();
            invalidateCollectionInventory(); // K3
            toastr.info('Key removed');
        } catch (error) {
            toastr.error(`Could not remove the key: ${error.message}`);
        }
        render();
    };

    $input.on('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void save(); } });
    render();
    void refresh();
}

/**
 * Renders the VectHare settings UI
 * @param {string} containerId - The container element ID to render into
 * @param {object} settings - VectHare settings object
 * @param {object} callbacks - Object containing callback functions
 * @param {Function} callbacks.onVectorizeAll - Called when "Vectorize All" is clicked
 * @param {Function} callbacks.onPurge - Called when "Purge" is clicked
 * @param {Function} callbacks.onRunDiagnostics - Called when "Run Diagnostics" is clicked
 */
/**
 * Extension, plugin, SillyTavern and (Qdrant / Milvus) versions, in the style of
 * the diagnostics header (core/plugin-health.js). Each gets ✓ (works), ⚠ (works
 * in part), ✗ (does not work) or ? (unknown); anything but ✓ is explained on a
 * line below. Used at the top of Core Settings and in the diagnostics results.
 */
const VERSION_ICON = {
    ok: '<i class="fa-solid fa-circle-check" style="color: var(--vecthare-success);"></i>',
    partial: '<i class="fa-solid fa-triangle-exclamation" style="color: var(--vecthare-warning);"></i>',
    bad: '<i class="fa-solid fa-circle-xmark" style="color: var(--vecthare-danger);"></i>',
    unknown: '<i class="fa-solid fa-circle-question" style="color: var(--grey70);"></i>',
};
const VERSION_NOTE_COLOR = { partial: 'var(--vecthare-warning)', bad: 'var(--vecthare-danger)', unknown: 'inherit' };

function versionInfoHtml(c, server = null, st = null) {
    if (!c) return '<i class="fa-solid fa-info-circle"></i> Checking versions…';
    const sep = '<span style="margin: 0 10px;">•</span>';
    const items = [], notes = [];
    const add = (label, value, kind, note) => {
        items.push(`<strong>${escapeHtml(label)}:</strong> ${value}${kind ? ` ${VERSION_ICON[kind]}` : ''}`);
        if (note && kind && kind !== 'ok') notes.push(`<div style="margin-top: 6px; color: ${VERSION_NOTE_COLOR[kind]};">${VERSION_ICON[kind]} ${escapeHtml(note)}</div>`);
    };
    const extension = c.extensionVersion && c.extensionVersion !== 'unknown' ? `v${escapeHtml(c.extensionVersion)}` : 'Unknown';
    items.push(`<strong>Extension:</strong> ${extension}`);
    // plugin: compatible / mismatch / missing / not answering
    const plugin = c.pluginVersion ? `v${escapeHtml(c.pluginVersion)}` : (c.state === 'missing' ? 'Not installed' : 'Unknown');
    const pluginKind = { ok: 'ok', 'plugin-older': 'partial', 'extension-older': 'partial', missing: 'bad', unknown: 'unknown' }[c.state] || 'unknown';
    add('Plugin', c.state === 'ok' ? `${plugin} <span style="color: var(--vecthare-success);">compatible</span>` : plugin, pluginKind, c.message);
    // SillyTavern
    if (st) {
        const kind = { ok: 'ok', partial: 'partial', unsupported: 'bad', unknown: 'unknown' }[st.state] || 'unknown';
        add('SillyTavern', st.version ? `v${escapeHtml(st.version)}` : 'Unknown', kind, st.message);
    }
    // Qdrant / Milvus server when that backend is selected
    if (server) {
        const shown = String(server.version || '').replace(/^v(?=\d)/i, '');
        const value = server.connected ? (shown ? `${/^\d/.test(shown) ? 'v' : ''}${escapeHtml(shown)}` : 'version unknown') : 'not connected';
        const kind = !server.connected ? 'unknown' : server.writable === false ? 'partial' : server.version ? 'ok' : 'unknown';
        const note = !server.connected ? server.message
            : server.writable === false ? server.message
            : server.version ? '' : `${server.name} did not report its version.`;
        add(server.name, value, kind, note);
    }
    return `<i class="fa-solid fa-info-circle"></i> ${items.join(sep)}${notes.join('')}`;
}

let versionInfoSettings = null;
let versionInfoListening = false;
async function refreshVersionInfo() {
    const el = $('#vecthare_version_info');
    if (!el.length) return;
    try {
        const backend = versionInfoSettings?.vector_backend;
        const [c, server, st] = await Promise.all([checkPluginCompatibility(), readBackendServerInfo(backend), readSillyTavernInfo()]);
        if (versionInfoSettings?.vector_backend !== backend) return; // switched meanwhile; a newer refresh follows
        el.html(versionInfoHtml(c, server, st));
    } catch { el.html(versionInfoHtml({ state: 'unknown' })); }
}

export function renderSettings(containerId, settings, callbacks) {
    vhLog('VectHare UI: Rendering settings...');

    const html = `
        <div id="vecthare_settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>VectHare - Advanced RAG</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">

                    <!-- Core Settings Card -->
                    <div class="vecthare-card">
                        <div class="vecthare-card-header">
                            <h3 class="vecthare-card-title">
                                <span class="vecthare-icon">
                                    <i class="fa-solid fa-cog"></i>
                                </span>
                                Core Settings
                            </h3>
                            <p class="vecthare-card-subtitle">Configure embedding provider and vectorization parameters</p>
                        </div>
                        <div class="vecthare-card-body">

                            <div id="vecthare_version_info" class="vecthare-diagnostics-version" style="padding: 10px 15px; background: var(--black30alpha); border-radius: 8px; margin-bottom: 15px; font-size: 0.9em; color: var(--grey70);">${versionInfoHtml(null)}</div>

                            <label for="vecthare_vector_backend">
                                <small>Vector Backend</small>
                            </label>
                            <select id="vecthare_vector_backend" class="vecthare-select">
                                <option value="standard">Standard (ST's Vectra - file-based)</option>
                                <option value="lancedb">LanceDB (disk-based, scalable)</option>
                                <option value="qdrant">Qdrant (production vector search)</option>
                                <option value="milvus">Milvus (popular open source engine)</option>
                            </select>
                            <small class="vecthare-help-text" style="display: block; margin-top: -8px; margin-bottom: 16px; opacity: 0.7; font-size: 0.85em; line-height: 1.5;">
                                • Standard: ST's built-in Vectra (best for <100k vectors)<br>
                                • LanceDB: Disk-based, handles millions of vectors (requires plugin)<br>
                                • Qdrant: Production-grade with HNSW, filtering, cloud support<br>
                                • Milvus: High-performance, scalable vector database
                            </small>

                            <!-- Qdrant Settings (shown only when Qdrant backend is selected) -->
                            <div id="vecthare_qdrant_settings" style="display: none;">
                                <label class="checkbox_label">
                                    <input type="checkbox" id="vecthare_qdrant_use_cloud" />
                                    <span>Use Qdrant Cloud</span>
                                </label>

                                <!-- Local Qdrant Settings -->
                                <div id="vecthare_qdrant_local_settings">
                                    <label for="vecthare_qdrant_host">
                                        <small>Qdrant Host:</small>
                                    </label>
                                    <input type="text" id="vecthare_qdrant_host" class="vecthare-input" placeholder="localhost" />

                                    <label for="vecthare_qdrant_port">
                                        <small>Qdrant Port:</small>
                                    </label>
                                    <input type="number" id="vecthare_qdrant_port" class="vecthare-input" placeholder="6333" />
                                </div>

                                <!-- Cloud Qdrant Settings -->
                                <div id="vecthare_qdrant_cloud_settings" style="display: none;">
                                    <label for="vecthare_qdrant_url">
                                        <small>Qdrant Cloud URL:</small>
                                    </label>
                                    <input type="text" id="vecthare_qdrant_url" class="vecthare-input" placeholder="https://xxx.cloud.qdrant.io" />

                                    <label for="vecthare_qdrant_api_key">
                                        <small>API Key:</small>
                                    </label>
                                    <input type="password" id="vecthare_qdrant_api_key" class="vecthare-input" placeholder="Your Qdrant Cloud API key" />
                                </div>

                                <!-- Qdrant Multitenancy Setting -->
                                <div style="margin-top: 10px; padding: 8px; background: rgba(0,0,0,0.1); border-radius: 4px;">
                                    <label class="checkbox_label" title="When enabled, uses a single Qdrant collection with content_type filtering (multitenancy). When disabled, creates separate collections for each content type (better isolation).">
                                        <input type="checkbox" id="vecthare_qdrant_multitenancy" />
                                        <span>Use Multitenancy (Single Collection)</span>
                                    </label>
                                    <small class="vecthare_hint" style="display: block; margin-top: 4px;">
                                        <strong>Multitenancy ON:</strong> new collections share one Qdrant collection per vector size, kept separate from each other server-side<br>
                                        <strong>Multitenancy OFF:</strong> each new collection gets its own Qdrant collection (better isolation)<br>
                                        The switch decides where NEW collections go; existing ones stay where they are (see Database Browser &gt; Storage). Chats in the old shared store are read-only: Vectorize offers a rebuild that moves them.
                                    </small>
                                </div>
                            </div>

                            <!-- Milvus Settings (shown only when Milvus backend is selected) -->
                            <div id="vecthare_milvus_settings" style="display: none;">
                                <label for="vecthare_milvus_host">
                                    <small>Milvus Host:</small>
                                </label>
                                <input type="text" id="vecthare_milvus_host" class="vecthare-input" placeholder="localhost" />

                                <label for="vecthare_milvus_port">
                                    <small>Milvus Port:</small>
                                </label>
                                <input type="number" id="vecthare_milvus_port" class="vecthare-input" placeholder="19530" />

                                <label for="vecthare_milvus_address">
                                    <small>Full Address (Optional):</small>
                                </label>
                                <input type="text" id="vecthare_milvus_address" class="vecthare-input" placeholder="http://localhost:19530" />
                                <small class="vecthare_hint">Overrides Host/Port if set (e.g. for cloud instances)</small>

                                <label for="vecthare_milvus_username">
                                    <small>Username (Optional):</small>
                                </label>
                                <input type="text" id="vecthare_milvus_username" class="vecthare-input" />

                                <label for="vecthare_milvus_password">
                                    <small>Password (Optional):</small>
                                </label>
                                <input type="password" id="vecthare_milvus_password" class="vecthare-input" />

                                <label for="vecthare_milvus_token">
                                    <small>API Token (Optional):</small>
                                </label>
                                <input type="password" id="vecthare_milvus_token" class="vecthare-input" placeholder="For cloud instances" />

                                <div style="margin: 10px 0; padding: 8px; background: rgba(0,0,0,0.1); border-radius: 4px;">
                                    <label class="checkbox_label" title="Where NEW Milvus collections go. Existing collections stay where they are.">
                                        <input type="checkbox" id="vecthare_milvus_multitenancy" />
                                        <span>Use Multitenancy (shared store per vector size)</span>
                                    </label>
                                    <small class="vecthare_hint" style="display: block; margin-top: 4px;">
                                        <strong>ON (default):</strong> new collections share one Milvus collection per vector size, separated server-side (fits hosted Milvus collection limits)<br>
                                        <strong>OFF:</strong> each new collection gets its own Milvus collection<br>
                                        Needs the Similharity plugin that comes with this VectHare; existing collections stay where they are.
                                    </small>
                                </div>

                                <label for="vecthare_milvus_dimensions">
                                    <small>Embedding Dimensions:</small>
                                </label>
                                <input type="number" id="vecthare_milvus_dimensions" class="vecthare-input" placeholder="Auto (768)" min="1" />
                                <small class="vecthare_hint">Manually set dimension size if auto-detection fails (e.g. 1536, 4096). Required for some models on first run.</small>
                            </div>

                            <label for="vecthare_source">
                                <small>Embedding Provider</small>
                            </label>
                            <select id="vecthare_source" class="vecthare-select">
                            <option value="transformers">Transformers (Local)</option>
                            <option value="bananabread">BananaBread</option>
                            <option value="openai">OpenAI</option>
                            <option value="ollama">Ollama</option>
                            <option value="cohere">Cohere</option>
                            <option value="togetherai">Together AI</option>
                            <option value="extras">Extras API</option>
                            <option value="electronhub">ElectronHub</option>
                            <option value="openrouter">OpenRouter</option>
                            <option value="llamacpp">LlamaCPP</option>
                            <option value="vllm">vLLM</option>
                            <option value="koboldcpp">KoboldCPP</option>
                            <option value="webllm">WebLLM</option>
                            <option value="palm">Google PaLM</option>
                            <option value="vertexai">Google VertexAI</option>
                            <option value="mistral">Mistral AI</option>
                            <option value="nomicai">Nomic AI</option>
                        </select>
                            <small class="vecthare_hint">Changing the embedding provider, model or chunking settings applies to <b>new</b> collections only. Existing collections keep the settings they were created with.</small>

                        <!-- Provider-Specific Settings -->
                        <div id="vecthare_provider_settings">

                            <!-- ElectronHub Model -->
                            <div class="vecthare_provider_setting" data-provider="electronhub">
                                <label for="vecthare_electronhub_model">
                                    <small>ElectronHub Model:</small>
                                </label>
                                <input type="text" id="vecthare_electronhub_model" class="vecthare-input" placeholder="text-embedding-3-small" />
                                <small class="vecthare_hint">Enter ElectronHub-compatible model ID (e.g., text-embedding-3-small, text-embedding-3-large)</small>
                            </div>

                            <!-- Alternative Endpoint (for local providers) -->
                            <div class="vecthare_provider_setting" data-provider="ollama,vllm,llamacpp,koboldcpp,bananabread">
                                <label class="checkbox_label">
                                    <input type="checkbox" id="vecthare_use_alt_endpoint" />
                                    <span>Use Alternative Endpoint</span>
                                </label>
                                <input type="text" id="vecthare_alt_endpoint_url" class="vecthare-input" placeholder="http://localhost:11434" />
                                <small class="vecthare_hint">Override default API URL for this provider</small>
                            </div>

                            <!-- BananaBread Info & Reranking -->
                            <div class="vecthare_provider_setting" data-provider="bananabread">
                                <small class="vecthare_info">
                                    <i class="fa-solid fa-info-circle"></i>
                                    BananaBread default: http://localhost:8008. Supports MixedBread AI and Qwen3 embedding models.
                                </small>
                                <label class="checkbox_label" style="margin-top: 8px;">
                                    <input type="checkbox" id="vecthare_bananabread_rerank" />
                                    <span>Enable Reranking</span>
                                </label>
                                <small class="vecthare_hint">Re-score results using BananaBread's reranker for better relevance</small>
                                <label for="vecthare_bananabread_apikey" style="margin-top: 8px;">
                                    <small>BananaBread API Key:</small>
                                </label>
                                <input type="password" id="vecthare_bananabread_apikey" class="vecthare-input" placeholder="Paste key here to save..." autocomplete="off" />
                            </div>

                            <!-- WebLLM Model -->
                            <div class="vecthare_provider_setting" data-provider="webllm">
                                <small class="vecthare_info" id="vecthare_webllm_status">
                                    <i class="fa-solid fa-spinner fa-spin"></i>
                                    Checking WebLLM availability...
                                </small>
                                <label for="vecthare_webllm_model">
                                    <small>WebLLM Model:</small>
                                </label>
                                <select id="vecthare_webllm_model" class="vecthare-select"></select>
                                <div style="display: flex; gap: 8px; margin-top: 8px;">
                                    <button id="vecthare_webllm_load" class="menu_button">
                                        <i class="fa-solid fa-download"></i> Load Model
                                    </button>
                                    <button id="vecthare_webllm_install" class="menu_button menu_button_icon">
                                        <i class="fa-solid fa-puzzle-piece"></i> Install Extension
                                    </button>
                                </div>
                                <small class="vecthare_hint">WebLLM requires the WebLLM extension and a WebGPU-compatible browser (Chrome 113+, Edge 113+)</small>
                            </div>

                            <!-- Ollama Model -->
                            <div class="vecthare_provider_setting" data-provider="ollama">
                                <label for="vecthare_ollama_model">
                                    <small>Ollama Model:</small>
                                </label>
                                <input type="text" id="vecthare_ollama_model" class="vecthare-input" placeholder="mxbai-embed-large" />
                                <label class="checkbox_label">
                                    <input type="checkbox" id="vecthare_ollama_keep" />
                                    <span>Keep Model in Memory</span>
                                </label>
                                <small class="vecthare_hint">Enter the model name from your local Ollama installation</small>
                            </div>

                            <!-- KoboldCPP Info -->
                            <div class="vecthare_provider_setting" data-provider="koboldcpp">
                                <small class="vecthare_info">
                                    <i class="fa-solid fa-info-circle"></i>
                                    KoboldCPP uses the currently loaded model for embeddings. Ensure your model supports embeddings.
                                </small>
                            </div>

                            <!-- LlamaCPP Info -->
                            <div class="vecthare_provider_setting" data-provider="llamacpp">
                                <small class="vecthare_info">
                                    <i class="fa-solid fa-info-circle"></i>
                                    LlamaCPP requires the --embedding flag to be enabled. Restart your server with this flag if not already set.
                                </small>
                            </div>

                            <!-- OpenAI Model -->
                            <div class="vecthare_provider_setting" data-provider="openai">
                                <label for="vecthare_openai_model">
                                    <small>OpenAI Model:</small>
                                </label>
                                <select id="vecthare_openai_model" class="vecthare-select">
                                    <option value="text-embedding-ada-002">text-embedding-ada-002</option>
                                    <option value="text-embedding-3-small">text-embedding-3-small</option>
                                    <option value="text-embedding-3-large">text-embedding-3-large</option>
                                </select>
                            </div>

                            <!-- Cohere Model -->
                            <div class="vecthare_provider_setting" data-provider="cohere">
                                <label for="vecthare_cohere_model">
                                    <small>Cohere Model:</small>
                                </label>
                                <select id="vecthare_cohere_model" class="vecthare-select">
                                    <option value="embed-english-v3.0">embed-english-v3.0</option>
                                    <option value="embed-multilingual-v3.0">embed-multilingual-v3.0</option>
                                    <option value="embed-english-light-v3.0">embed-english-light-v3.0</option>
                                    <option value="embed-multilingual-light-v3.0">embed-multilingual-light-v3.0</option>
                                    <option value="embed-english-v2.0">embed-english-v2.0</option>
                                    <option value="embed-english-light-v2.0">embed-english-light-v2.0</option>
                                    <option value="embed-multilingual-v2.0">embed-multilingual-v2.0</option>
                                    <option value="embed-multilingual-light-v2.0">embed-multilingual-light-v2.0</option>
                                </select>
                            </div>

                            <!-- TogetherAI Model -->
                            <div class="vecthare_provider_setting" data-provider="togetherai">
                                <label for="vecthare_togetherai_model">
                                    <small>Together AI Model:</small>
                                </label>
                                <select id="vecthare_togetherai_model" class="vecthare-select">
                                    <option value="togethercomputer/m2-bert-80M-32k-retrieval">togethercomputer/m2-bert-80M-32k-retrieval</option>
                                    <option value="togethercomputer/m2-bert-80M-8k-retrieval">togethercomputer/m2-bert-80M-8k-retrieval</option>
                                    <option value="togethercomputer/m2-bert-80M-2k-retrieval">togethercomputer/m2-bert-80M-2k-retrieval</option>
                                    <option value="WhereIsAI/UAE-Large-V1">WhereIsAI/UAE-Large-V1</option>
                                    <option value="BAAI/bge-large-en-v1.5">BAAI/bge-large-en-v1.5</option>
                                    <option value="BAAI/bge-base-en-v1.5">BAAI/bge-base-en-v1.5</option>
                                    <option value="sentence-transformers/msmarco-bert-base-dot-v5">sentence-transformers/msmarco-bert-base-dot-v5</option>
                                    <option value="bert-base-uncased">bert-base-uncased</option>
                                </select>
                            </div>

                            <!-- vLLM Model -->
                            <div class="vecthare_provider_setting" data-provider="vllm">
                                <label for="vecthare_vllm_model">
                                    <small>vLLM Model:</small>
                                </label>
                                <input type="text" id="vecthare_vllm_model" class="vecthare-input" placeholder="Model name" />
                                <small class="vecthare_hint">Enter the model name from your vLLM deployment</small>
                            </div>

                            <!-- Google Model (PaLM/VertexAI) -->
                            <div class="vecthare_provider_setting" data-provider="palm,vertexai">
                                <label for="vecthare_google_model">
                                    <small>Google Model:</small>
                                </label>
                                <select id="vecthare_google_model" class="vecthare-select">
                                    <option value="text-embedding-005">text-embedding-005</option>
                                    <option value="text-embedding-004">text-embedding-004</option>
                                    <option value="text-multilingual-embedding-002">text-multilingual-embedding-002</option>
                                    <option value="textembedding-gecko">textembedding-gecko</option>
                                    <option value="textembedding-gecko-multilingual">textembedding-gecko-multilingual</option>
                                </select>
                            </div>

                            <!-- NomicAI API Key -->
                            <div class="vecthare_provider_setting" data-provider="nomicai">
                                <button id="vecthare_nomicai_api_key" class="menu_button">
                                    <i class="fa-solid fa-key"></i> Set Nomic API Key
                                </button>
                                <small class="vecthare_hint">Configure your Nomic API key in SillyTavern settings</small>
                            </div>

                            <!-- OpenRouter Model -->
                            <div class="vecthare_provider_setting" data-provider="openrouter">
                                <label for="vecthare_openrouter_model">
                                    <small>OpenRouter Model:</small>
                                </label>
                                <input type="text" id="vecthare_openrouter_model" class="vecthare-input" placeholder="openai/text-embedding-3-large" />
                                <small class="vecthare_hint">Enter OpenRouter-compatible model ID</small>
                                <label for="vecthare_openrouter_apikey" style="margin-top: 8px;">
                                    <small>OpenRouter API Key:</small>
                                </label>
                                <input type="password" id="vecthare_openrouter_apikey" class="vecthare-input" placeholder="Paste key here to save..." autocomplete="off" />
                            </div>

                        </div>

                            <!-- API Rate Limiting -->
                            <div class="vecthare-setting-group" style="margin-top: 16px; margin-bottom: 16px; padding-top: 16px; border-top: 1px solid var(--grey30);">
                                <label>
                                    <small>API Rate Limiting (0 to disable)</small>
                                </label>
                                <div style="display: flex; gap: 10px;">
                                    <div style="flex: 1;">
                                        <label for="vecthare_rate_limit_calls" style="display: block; margin-bottom: 4px;">
                                            <small>Max Calls</small>
                                        </label>
                                        <input type="number" id="vecthare_rate_limit_calls" class="vecthare-input" min="0" placeholder="5" />
                                    </div>
                                    <div style="flex: 1;">
                                        <label for="vecthare_rate_limit_interval" style="display: block; margin-bottom: 4px;">
                                            <small>Interval (sec)</small>
                                        </label>
                                        <input type="number" id="vecthare_rate_limit_interval" class="vecthare-input" min="1" placeholder="60" />
                                    </div>
                                </div>
                                <small class="vecthare_hint">Limit the number of API requests per time interval</small>
                            </div>

                            <label for="vecthare_insert_batch_size">
                                <small>Insert Batch Size: <span id="vecthare_insert_batch_size_value">50</span></small>
                            </label>
                            <input type="range" id="vecthare_insert_batch_size" class="vecthare-slider" min="1" max="100" step="1" />
                            <small class="vecthare_hint">Chunks sent per embedding request (1-100). Once changed, chat Sync/Repair also take this many per pass (default 5, or 8 for local Transformers). Lower it if your embedding server rejects large requests.</small>

                            <label class="checkbox_label" style="margin-top: 16px;">
                                <input type="checkbox" id="vecthare_debug_logging" />
                                <span>Debug logging</span>
                            </label>
                            <small class="vecthare_hint">Write VectHare's detailed progress lines to the browser console (off keeps the console quiet; warnings and errors are always shown)</small>

                            <label for="vecthare_min_chat_length" style="margin-top: 16px;">
                                <small>Minimum Messages Before Injection</small>
                            </label>
                            <input type="number" id="vecthare_min_chat_length" class="vecthare-input" min="0" max="100" step="1" placeholder="0" />
                            <small class="vecthare_hint">Minimum number of messages in chat before RAG injection starts (0 = inject immediately)</small>

                            <label for="vecthare_rag_timeout_seconds" style="margin-top: 16px;">
                                <small>Retrieval time limit (seconds)</small>
                            </label>
                            <input type="number" id="vecthare_rag_timeout_seconds" class="vecthare-input" min="0" max="300" step="1" placeholder="15" />
                            <small class="vecthare_hint">If the embedding or vector backend does not answer within this time, the message is sent without memories (0 = wait as long as it takes)</small>

                            <label for="vecthare_score_threshold">
                                <small>Similarity Threshold: <span id="vecthare_threshold_value">0.25</span></small>
                            </label>
                            <input type="range" id="vecthare_score_threshold" class="vecthare-slider" min="0" max="1" step="0.05" />
                            <small class="vecthare_hint">Minimum relevance score for retrieval</small>

                            <!-- Keyword Scoring Method -->
                            <label style="margin-top: 16px;">
                                <small>Keyword Scoring Method</small>
                            </label>
                            <select id="vecthare_keyword_scoring_method" class="vecthare-select">
                                <option value="keyword">Keyword Boost</option>
                                <option value="bm25">BM25 (Langchain)</option>
                                <option value="hybrid">Hybrid (Both)</option>
                            </select>
                            <small class="vecthare_hint">Algorithm for keyword-based relevance scoring</small>

                            <!-- BM25 Parameters (shown when BM25 or Hybrid is selected) -->
                            <div id="vecthare_bm25_params" style="display: none; margin-top: 12px; padding: 12px; background: rgba(0,0,0,0.1); border-radius: 8px;">
                                <label for="vecthare_bm25_k1">
                                    <small>BM25 k1 (TF saturation): <span id="vecthare_bm25_k1_value">1.5</span></small>
                                </label>
                                <input type="range" id="vecthare_bm25_k1" class="vecthare-slider" min="0.5" max="3.0" step="0.1" />
                                <small class="vecthare_hint">Controls term frequency saturation (1.2-2.0 typical)</small>

                                <label for="vecthare_bm25_b" style="margin-top: 8px;">
                                    <small>BM25 b (Length norm): <span id="vecthare_bm25_b_value">0.75</span></small>
                                </label>
                                <input type="range" id="vecthare_bm25_b" class="vecthare-slider" min="0" max="1" step="0.05" />
                                <small class="vecthare_hint">Controls document length normalization (0.75 typical)</small>
                            </div>

                            <!-- Hybrid Search (Vector + Full-Text) -->
                            <div style="margin-top: 16px; padding: 12px; background: rgba(0,100,200,0.1); border-radius: 8px; border: 1px solid rgba(0,100,200,0.2);">
                                <label class="checkbox_label" for="vecthare_hybrid_search_enabled" style="margin-bottom: 8px;">
                                    <input id="vecthare_hybrid_search_enabled" type="checkbox" />
                                    <span><small><b>Enable Hybrid Search</b></small></span>
                                </label>
                                <small class="vecthare_hint">Combines vector similarity with full-text (BM25) search using rank fusion</small>

                                <div id="vecthare_hybrid_params" style="display: none; margin-top: 12px;">
                                    <label style="margin-top: 8px;">
                                        <small>Fusion Method</small>
                                    </label>
                                    <select id="vecthare_hybrid_fusion_method" class="vecthare-select">
                                        <option value="rrf">RRF (Reciprocal Rank Fusion)</option>
                                        <option value="weighted">Weighted Linear Combination</option>
                                    </select>
                                    <small class="vecthare_hint">RRF is parameter-free and robust; Weighted allows fine-tuning</small>

                                    <div id="vecthare_hybrid_weights" style="display: none; margin-top: 12px;">
                                        <label for="vecthare_hybrid_vector_weight">
                                            <small>Vector Weight: <span id="vecthare_hybrid_vector_weight_value">0.5</span></small>
                                        </label>
                                        <input type="range" id="vecthare_hybrid_vector_weight" class="vecthare-slider" min="0" max="1" step="0.1" />

                                        <label for="vecthare_hybrid_text_weight" style="margin-top: 8px;">
                                            <small>Text Weight: <span id="vecthare_hybrid_text_weight_value">0.5</span></small>
                                        </label>
                                        <input type="range" id="vecthare_hybrid_text_weight" class="vecthare-slider" min="0" max="1" step="0.1" />
                                    </div>

                                    <div id="vecthare_hybrid_rrf_settings" style="margin-top: 12px;">
                                        <label for="vecthare_hybrid_rrf_k">
                                            <small>RRF K Constant: <span id="vecthare_hybrid_rrf_k_value">60</span></small>
                                        </label>
                                        <input type="range" id="vecthare_hybrid_rrf_k" class="vecthare-slider" min="1" max="100" step="1" />
                                        <small class="vecthare_hint">Higher K = more weight to top-ranked results (60 is typical)</small>
                                    </div>

                                    <label class="checkbox_label" for="vecthare_hybrid_native_prefer" style="margin-top: 12px;">
                                        <input id="vecthare_hybrid_native_prefer" type="checkbox" checked />
                                        <span><small>Prefer Native Backend Hybrid</small></span>
                                    </label>
                                    <small class="vecthare_hint">Use Qdrant/Milvus native hybrid if available (faster)</small>
                                </div>
                            </div>

                            <!-- Custom Stopwords -->
                            <div style="margin-top: 16px; padding: 12px; background: rgba(100,100,100,0.1); border-radius: 8px;">
                                <label for="vecthare_custom_stopwords">
                                    <small><b>Custom Stopwords</b></small>
                                </label>
                                <textarea id="vecthare_custom_stopwords" class="vecthare-textarea" rows="2"
                                    placeholder="{{char}}, {{user}}, character, scene, location..."
                                    style="margin-top: 4px;"></textarea>
                                <small class="vecthare_hint">Words to exclude from keyword extraction. Supports ST macros: {{char}}, {{user}}, {{charIfNotGroup}}, etc.</small>
                            </div>

                            <label for="vecthare_query_depth" style="margin-top: 12px;">
                                <small>Query Depth: <span id="vecthare_query_depth_value">2</span> messages</small>
                            </label>
                            <input type="range" id="vecthare_query_depth" class="vecthare-slider" min="1" max="20" step="1" />
                            <small class="vecthare_hint">How many recent messages to include in search query</small>

                            <label for="vecthare_deduplication_depth" style="margin-top: 12px;">
                                <small>Dedup Depth: <span id="vecthare_deduplication_depth_value">50</span> messages</small>
                            </label>
                            <input type="range" id="vecthare_deduplication_depth" class="vecthare-slider" min="0" max="500" step="10" />
                            <small class="vecthare_hint">Recent messages to check for duplicates (0 = check all, lower = allow older content to resurface)</small>

                            <label class="checkbox_label" for="vecthare_skip_in_context_memories" style="margin-top: 12px;">
                                <input id="vecthare_skip_in_context_memories" type="checkbox" class="checkbox" />
                                <span>Skip memories already in context</span>
                            </label>
                            <small class="vecthare_hint">Memories of this chat whose messages are still inside SillyTavern's context line (the orange dashed line) are not recalled; a grouped memory is skipped if any part is inside. Until the context limit is reached, no memories of this chat are recalled. Other collections are unaffected. Replaces Dedup Depth, which is used until the line is known.</small>
                            <small class="vecthare_hint" id="vecthare_context_readout" style="display: block; margin-top: 4px;"></small>

                            <div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
                                <label for="vecthare_topk" style="margin:0; white-space:nowrap;"><small>Top K</small></label>
                                <input id="vecthare_topk" type="number" class="vecthare-input" min="1" style="width:90px;" />
                                <small class="vecthare_hint" style="margin-left:8px;">Number of results to retrieve per collection</small>
                            </div>

                            <label style="margin-top: 16px;">
                                <small>Injection Position</small>
                            </label>
                            <select id="vecthare_injection_position" class="vecthare-select">
                                <option value="2">Before Main Prompt</option>
                                <option value="0">After Main Prompt</option>
                                <option value="1">In-Chat @ Depth</option>
                            </select>
                            <small class="vecthare_hint">Where retrieved chunks appear in the prompt</small>

                            <div id="vecthare_injection_depth_row" style="margin-top: 12px; display: none;">
                                <label for="vecthare_injection_depth">
                                    <small>Injection Depth: <span id="vecthare_injection_depth_value">2</span></small>
                                </label>
                                <input type="range" id="vecthare_injection_depth" class="vecthare-slider" min="0" max="50" step="1" />
                                <small class="vecthare_hint">Messages from end of chat to insert at. Kept inside the context: memories set deeper than SillyTavern's context line would be cut, so they are moved just inside it.</small>

                                <label class="checkbox_label" for="vecthare_memories_at_context_top" style="margin-top: 8px;">
                                    <input id="vecthare_memories_at_context_top" type="checkbox" class="checkbox" />
                                    <span>Place memories at the top of the context</span>
                                </label>
                                <small class="vecthare_hint">Puts in-chat memories just inside the context line instead of at the depth above (as far in as their own size needs).</small>
                            </div>

                        </div>
                    </div>

                    <!-- Global Temporal Weighting Defaults Card -->
                    <div class="vecthare-card">
                        <div class="vecthare-card-header">
                            <h3 class="vecthare-card-title">
                                <span class="vecthare-icon">
                                    <i class="fa-solid fa-clock"></i>
                                </span>
                                Temporal Weighting Defaults
                            </h3>
                            <p class="vecthare-card-subtitle">Default settings for new collections (can be overridden per-collection)</p>
                        </div>
                        <div class="vecthare-card-body">

                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
                                <input type="checkbox" id="vecthare_default_decay_enabled" />
                                <label for="vecthare_default_decay_enabled" style="margin: 0;">
                                    <small>Enable temporal weighting by default</small>
                                </label>
                            </div>

                            <div id="vecthare_default_decay_type_section" class="vecthare-subsection-disabled">
                                <label style="margin-bottom: 4px;">
                                    <small>Default Type</small>
                                </label>
                                <div style="display: flex; gap: 12px; margin-bottom: 12px;">
                                    <label style="display: flex; align-items: center; gap: 4px; margin: 0;">
                                        <input type="radio" name="vecthare_default_decay_type" value="decay" />
                                        <small>Decay (favor recent)</small>
                                    </label>
                                    <label style="display: flex; align-items: center; gap: 4px; margin: 0;">
                                        <input type="radio" name="vecthare_default_decay_type" value="nostalgia" />
                                        <small>Nostalgia (favor old)</small>
                                    </label>
                                </div>
                            </div>

                            <small class="vecthare_hint">These defaults apply to newly created collections. Existing collections keep their settings.</small>

                        </div>
                    </div>

                    <!-- RAG Context Card -->
                    <div class="vecthare-card">
                        <div class="vecthare-card-header">
                            <h3 class="vecthare-card-title">
                                <span class="vecthare-icon">
                                    <i class="fa-solid fa-quote-left"></i>
                                </span>
                                RAG Context
                            </h3>
                            <p class="vecthare-card-subtitle">Add context prompts to help the AI understand retrieved content</p>
                        </div>
                        <div class="vecthare-card-body">

                            <label for="vecthare_rag_context">
                                <small>Global Context Prompt</small>
                            </label>
                            <textarea id="vecthare_rag_context" class="vecthare-textarea" rows="3" placeholder="e.g., The following information may be relevant to your conversation with {{user}}:"></textarea>
                            <small class="vecthare_hint">Shown before all RAG content. Supports {{user}} and {{char}} variables.</small>

                            <label for="vecthare_rag_xml_tag" style="margin-top: 12px;">
                                <small>Global XML Tag (optional)</small>
                            </label>
                            <input type="text" id="vecthare_rag_xml_tag" class="vecthare-input" placeholder="e.g., retrieved_context" />
                            <small class="vecthare_hint">Wraps all RAG content in &lt;tag&gt;...&lt;/tag&gt;. Leave empty for no wrapping.</small>

                            <label class="checkbox_label" for="vecthare_include_keywords_in_rag_context" style="margin-top: 12px;">
                                <input id="vecthare_include_keywords_in_rag_context" type="checkbox" class="checkbox" />
                                <span>Include Keywords in RAG Context</span>
                            </label>
                            <small class="vecthare_hint">Show stored keyword annotations in injected Qdrant RAG memories. Does not affect keyword searching or Semantic World Info.</small>

                            <label class="checkbox_label" for="vecthare_apply_prompt_regex_to_memories" style="margin-top: 12px;">
                                <input id="vecthare_apply_prompt_regex_to_memories" type="checkbox" class="checkbox" />
                                <span>Apply "Alter Outgoing Prompt" Regex to Memories</span>
                            </label>
                            <small class="vecthare_hint">Runs your SillyTavern regex scripts on recalled memories as they would run in the prompt: User Input / AI Output scripts on chat memories by who wrote each part, World Info scripts on lorebook memories; other memories are unchanged. Stored memories are never changed. Depth limits count the newest recalled chat memory as the injection depth, the next as one deeper, and so on (by rank, not real age).</small>

                            <div class="vecthare_info" style="margin-top: 16px; padding: 8px 12px; border-radius: 4px; background: var(--SmartThemeBlurTintColor); font-size: 0.85em;">
                                <i class="fa-solid fa-info-circle"></i>
                                <span>Collection and chunk-level context can be set in the Database Browser and Chunk Visualizer respectively.</span>
                            </div>

                        </div>
                        </div>

                        <!-- World Info Settings Card -->
                        <div class="vecthare-card">
                            <div class="vecthare-card-header">
                                <h3 class="vecthare-card-title">
                                    <span class="vecthare-icon">
                                        <i class="fa-solid fa-globe"></i>
                                    </span>
                                    World Info settings
                                </h3>
                                <p class="vecthare-card-subtitle">Semantic activation of World Info entries from vectorized lorebooks</p>
                            </div>
                            <div class="vecthare-card-body">
                                <label class="checkbox_label" for="vecthare_enabled_world_info" title="Enable semantic activation of World Info entries from vectorized lorebooks based on chat context similarity.">
                                    <input id="vecthare_enabled_world_info" type="checkbox" class="checkbox">
                                    <span>Enable Semantic WI Activation</span>
                                </label>

                                <div id="vecthare_world_info_settings" style="margin-top:10px; display:none;">
                                    <small style="display:block; margin-bottom:8px; opacity:0.85;">
                                        Activates World Info entries from <strong>vectorized lorebooks</strong> based on semantic similarity to recent chat messages. Complements keyword-based activation.
                                    </small>

                                    <div style="display:flex; gap:12px;">
                                        <div style="flex:1;">
                                            <label for="vecthare_world_info_threshold"><small>Score Threshold</small></label>
                                            <input id="vecthare_world_info_threshold" type="number" class="vecthare-input" min="0" max="1" step="0.01" />
                                        </div>
                                        <div style="flex:1;">
                                            <label for="vecthare_world_info_top_k"><small>Top-K per Lorebook</small></label>
                                            <input id="vecthare_world_info_top_k" type="number" class="vecthare-input" min="1" max="20" />
                                        </div>
                                        <div style="flex:1;">
                                            <label for="vecthare_world_info_query_depth"><small>Query Depth</small></label>
                                            <input id="vecthare_world_info_query_depth" type="number" class="vecthare-input" min="1" max="10" />
                                        </div>
                                    </div>

                                    <div style="margin-top:10px;">
                                        <label for="vecthare_wi_test_input"><small>Test Messages (one per line)</small></label>
                                        <textarea id="vecthare_wi_test_input" class="vecthare-textarea" rows="3" placeholder="Enter test messages, one per line..."></textarea>
                                        <div style="display:flex; gap:8px; margin-top:8px;">
                                            <button id="vecthare_wi_test_btn" class="vecthare-btn-secondary">Test Semantic WI</button>
                                            <button id="vecthare_wi_dump_registry" class="vecthare-btn-secondary">Dump Registry</button>
                                            <button id="vecthare_wi_apply_first" class="vecthare-btn-primary" title="Copies the text of the first World Info entry found by meaning, so you can paste it into the World Info editor">Copy First Semantic Hit</button>
                                        </div>
                                    </div>

                                    <div style="margin-top:10px; display:flex; gap:12px; align-items:center;">
                                        <label class="checkbox_label" for="vecthare_enabled_for_all">
                                            <input id="vecthare_enabled_for_all" type="checkbox" />
                                            <span>Enabled for all entries</span>
                                        </label>
                                        <div style="flex:1"></div>
                                        <div style="width:160px;">
                                            <label for="vecthare_max_entries"><small>Max Entries</small></label>
                                            <input id="vecthare_max_entries" type="number" class="vecthare-input" min="1" max="9999" />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- Chat Auto-Sync Card -->
                    <div class="vecthare-card">
                        <div class="vecthare-card-header">
                            <h3 class="vecthare-card-title">
                                <span class="vecthare-icon">
                                    <i class="fa-solid fa-comments"></i>
                                </span>
                                Chat Auto-Sync
                            </h3>
                            <p class="vecthare-card-subtitle">Configure how chat messages are vectorized</p>
                        </div>
                        <div class="vecthare-card-body">

                            <label class="checkbox_label" for="vecthare_autosync_enabled">
                                <input type="checkbox" id="vecthare_autosync_enabled" />
                                <span>Enable Auto-Sync</span>
                            </label>
                            <small class="vecthare_hint">Automatically vectorize new chat messages</small>

                            <!-- Collection lock moved to Database Browser (per-collection settings) -->

                            <!-- Read-only. This chat collection's chunking and text cleaning are
                                 whatever its original vectorization recorded, and auto-sync and
                                 Repair reproduce them. They are changed by re-vectorizing
                                 (Vectorize Content > Replace All), never from this card. -->
                            <div id="vecthare_chat_config_readonly" style="margin-top: 12px;">
                                <label><small>Chunking Strategy</small></label>
                                <div id="vecthare_chat_config_strategy" class="vecthare_hint">Not Configured</div>
                                <label style="margin-top: 8px;"><small>Text Cleaning</small></label>
                                <div id="vecthare_chat_config_cleaning" class="vecthare_hint">Not Configured</div>
                                <small class="vecthare_hint" style="margin-top: 4px; margin-bottom: 12px; display: block;">
                                    This chat collection's original vectorization settings. To change them,
                                    re-vectorize the chat from Vectorize Content.
                                </small>
                            </div>

                        </div>
                    </div>

                    <!-- Actions Card -->
                    <div class="vecthare-card">
                        <div class="vecthare-card-header">
                            <h3 class="vecthare-card-title">
                                <span class="vecthare-icon">
                                    <i class="fa-solid fa-bolt"></i>
                                </span>
                                Actions
                            </h3>
                            <p class="vecthare-card-subtitle">Manage your vector database</p>
                        </div>
                        <div class="vecthare-card-body">

                            <div class="vecthare-actions-grid">
                                <button id="vecthare_vectorize_content" class="vecthare-action-btn vecthare-btn-primary vecthare-action-featured">
                                    <i class="fa-solid fa-plus-circle"></i>
                                    <span>Vectorize Content</span>
                                </button>
                                <!-- VectHare+ R10: live vectorization status - click to open the progress panel -->
                                <button id="vecthare_vectorization_status" class="vecthare-action-btn vecthare-btn-secondary" style="grid-column: 1 / -1; text-align: left; justify-content: flex-start;" title="Click to show the vectorization progress panel">
                                    <i class="fa-solid fa-gauge-high"></i>
                                    <span id="vecthare_vectorization_status_text">Status: checking…</span>
                                </button>
                                <!-- Repair Chunks fixes previously indexed vectors; Sync Chat handles
                                     unvectorized backlog. Keep Repair available for registered collections. -->
                                <button id="vecthare_continue_vectorization" class="vecthare-action-btn vecthare-btn-primary" style="display: none;">
                                    <i class="fa-solid fa-screwdriver-wrench"></i>
                                    <span>Repair Chunks</span>
                                </button>
                                <button id="vecthare_vectorize_all" class="vecthare-action-btn vecthare-btn-secondary">
                                    <i class="fa-solid fa-sync"></i>
                                    <span>Sync Chat</span>
                                </button>
                                <button id="vecthare_database_browser" class="vecthare-action-btn vecthare-btn-secondary">
                                    <i class="fa-solid fa-folder-open"></i>
                                    <span>Database Browser</span>
                                </button>
                                <button id="vecthare_run_diagnostics" class="vecthare-action-btn vecthare-btn-secondary">
                                    <i class="fa-solid fa-stethoscope"></i>
                                    <span>Diagnostics</span>
                                </button>
                                <button id="vecthare_view_results" class="vecthare-action-btn vecthare-btn-secondary">
                                    <i class="fa-solid fa-bug"></i>
                                    <span>Debug Query</span>
                                </button>
                                <button id="vecthare_purge" class="vecthare-action-btn vecthare-btn-danger-outline">
                                    <i class="fa-solid fa-trash"></i>
                                    <span>Purge</span>
                                </button>
                                <button id="vecthare_text_cleaning" class="vecthare-action-btn vecthare-btn-secondary">
                                    <i class="fa-solid fa-broom"></i>
                                    <span>Text Cleaning</span>
                                </button>
                                ${getHealthIndicatorHtml()}
                            </div>

                            <label class="checkbox_label" for="vecthare_include_production_tests" style="margin-top: 20px;">
                                <input type="checkbox" id="vecthare_include_production_tests" />
                                <span>Include Production Tests</span>
                            </label>
                            <small class="vecthare_hint">Tests actual embedding generation, storage, and retrieval (slower but thorough)</small>

                        </div>
                    </div>

                </div>
            </div>
        </div>

        <!-- Diagnostics Modal -->
        <div id="vecthare_diagnostics_modal" class="vecthare-modal" style="display: none;">
            <div class="vecthare-modal-overlay"></div>
            <div class="vecthare-modal-content vecthare-diagnostics-modal">
                <div class="vecthare-modal-header">
                    <h3>
                        <i class="fa-solid fa-stethoscope"></i>
                        <span id="vecthare_diagnostics_title">Run Diagnostics</span>
                    </h3>
                    <button class="vecthare-modal-close" id="vecthare_diagnostics_close">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
                <div class="vecthare-modal-body">
                    <!-- Phase 1: Category Selection -->
                    <div id="vecthare_diagnostics_selection" class="vecthare-diagnostics-phase">
                        <p class="vecthare-diagnostics-intro">Select which diagnostic categories to run:</p>

                        <div class="vecthare-diagnostics-categories">
                            <label class="vecthare-diagnostics-category-option">
                                <input type="checkbox" id="vecthare_diag_infrastructure" checked>
                                <div class="vecthare-diagnostics-category-card">
                                    <i class="fa-solid fa-server"></i>
                                    <div class="vecthare-diagnostics-category-info">
                                        <strong>Infrastructure</strong>
                                        <span>Backend connections, plugins, API endpoints</span>
                                    </div>
                                </div>
                            </label>

                            <label class="vecthare-diagnostics-category-option">
                                <input type="checkbox" id="vecthare_diag_configuration" checked>
                                <div class="vecthare-diagnostics-category-card">
                                    <i class="fa-solid fa-sliders"></i>
                                    <div class="vecthare-diagnostics-category-info">
                                        <strong>Configuration</strong>
                                        <span>Settings validation, chunk size, thresholds</span>
                                    </div>
                                </div>
                            </label>

                            <label class="vecthare-diagnostics-category-option">
                                <input type="checkbox" id="vecthare_diag_visualizer" checked>
                                <div class="vecthare-diagnostics-category-card">
                                    <i class="fa-solid fa-eye"></i>
                                    <div class="vecthare-diagnostics-category-info">
                                        <strong>Visualizer</strong>
                                        <span>Chunk editing, deletion, summary vectors</span>
                                    </div>
                                </div>
                            </label>

                            <label class="vecthare-diagnostics-category-option">
                                <input type="checkbox" id="vecthare_diag_production">
                                <div class="vecthare-diagnostics-category-card">
                                    <i class="fa-solid fa-vial"></i>
                                    <div class="vecthare-diagnostics-category-info">
                                        <strong>Production Tests</strong>
                                        <span>Live embedding, storage, retrieval tests</span>
                                    </div>
                                </div>
                            </label>
                        </div>

                        <div class="vecthare-diagnostics-actions">
                            <button class="vecthare-btn-secondary" id="vecthare_diag_cancel">Cancel</button>
                            <button class="vecthare-btn-primary" id="vecthare_diag_run">
                                <i class="fa-solid fa-play"></i> Run Diagnostics
                            </button>
                        </div>
                    </div>

                    <!-- Phase 2: Running -->
                    <div id="vecthare_diagnostics_running" class="vecthare-diagnostics-phase" style="display: none;">
                        <div class="vecthare-diagnostics-spinner">
                            <i class="fa-solid fa-spinner fa-spin"></i>
                            <span>Running diagnostics...</span>
                        </div>
                    </div>

                    <!-- Phase 3: Results -->
                    <div id="vecthare_diagnostics_results" class="vecthare-diagnostics-phase" style="display: none;">
                        <div id="vecthare_diagnostics_content"></div>
                        <div class="vecthare-diagnostics-footer">
                            <button class="vecthare-btn-secondary" id="vecthare_diag_back">
                                <i class="fa-solid fa-arrow-left"></i> Run Again
                            </button>
                            <button class="vecthare-btn-secondary" id="vecthare_diag_copy">
                                <i class="fa-solid fa-copy"></i> Copy Report
                            </button>
                            <button class="vecthare-btn-danger" id="vecthare_diag_fix_all" style="display: none;">
                                <i class="fa-solid fa-wand-magic-sparkles"></i> Fix All Issues
                            </button>
                            <button class="vecthare-btn-primary" id="vecthare_diag_done">Done</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        ${getHealthModalHtml()}
    `;

    // Sanity debug: confirm the generated HTML contains the lock button marker
    try {
        vhLog(`VectHare: renderSettings built HTML contains lock marker:`, String(html).indexOf('vecthare_lock_collection') >= 0);
        const target = document.getElementById(containerId);
        vhLog(`VectHare: renderSettings target container exists:`, !!target, 'containerId=', containerId);
    } catch (e) {
        console.warn('VectHare: renderSettings pre-append debug failed', e);
    }

    $(`#${containerId}`).append(html);

    // Debug: log presence of lock button after rendering and observe for later appearance
    try {
        vhLog(`VectHare: renderSettings appended to ${containerId}. lock button present:`, !!document.getElementById('vecthare_lock_collection'));
        if (!document.getElementById('vecthare_lock_collection')) {
            const containerEl = document.getElementById(containerId);
            if (containerEl && window.MutationObserver) {
                const mo = new MutationObserver((mutations, obs) => {
                    if (document.getElementById('vecthare_lock_collection')) {
                        vhLog('VectHare: lock button appeared in DOM');
                        obs.disconnect();
                    }
                });
                mo.observe(containerEl, { childList: true, subtree: true });
            }
        }
    } catch (e) {
        console.warn('VectHare: debug check failed', e);
    }

    // Bind all events
    bindSettingsEvents(settings, callbacks);

    // Initialize collapsible cards
    initializeCollapsibleCards();

    // Initialize modal
    initializeDiagnosticsModal();

    // Initialize health dashboard
    initializeHealthDashboard();

    // Extension / plugin (and Qdrant / Milvus) versions at the top of Core Settings
    versionInfoSettings = settings;
    void refreshVersionInfo();
    if (!versionInfoListening) {
        versionInfoListening = true;
        document.addEventListener('vecthare:backend-checked', () => { void refreshVersionInfo(); });
    }

    vhLog('VectHare UI: Settings rendered');
}

/**
 * Initializes diagnostics modal functionality
 */
function initializeDiagnosticsModal() {
    // Close button
    $('#vecthare_diagnostics_close').on('click', function() {
        closeDiagnosticsModal();
    });

    // Click overlay to close
    $('#vecthare_diagnostics_modal .vecthare-modal-overlay').on('click', function() {
        closeDiagnosticsModal();
    });

    // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
    // Note: This modal is inside the drawer so it doesn't strictly need this,
    // but we include it for consistency with other modals
    $('#vecthare_diagnostics_modal').on('mousedown touchstart', function(e) {
        e.stopPropagation();
    });

    // ESC key to close
    $(document).on('keydown', function(e) {
        if (e.key === 'Escape' && $('#vecthare_diagnostics_modal').is(':visible')) {
            closeDiagnosticsModal();
        }
    });

    // Cancel button
    $('#vecthare_diag_cancel').on('click', function() {
        closeDiagnosticsModal();
    });

    // Done button
    $('#vecthare_diag_done').on('click', function() {
        closeDiagnosticsModal();
    });

    // Back button - go back to selection
    $('#vecthare_diag_back').on('click', function() {
        showDiagnosticsPhase('selection');
        $('#vecthare_diagnostics_title').text('Run Diagnostics');
    });

    // Run button - execute diagnostics
    $('#vecthare_diag_run').on('click', async function() {
        await executeDiagnostics();
    });
}

/**
 * Closes the diagnostics modal and resets to selection phase
 */
function closeDiagnosticsModal() {
    $('#vecthare_diagnostics_modal').fadeOut(200, function() {
        // Reset to selection phase for next open
        showDiagnosticsPhase('selection');
        $('#vecthare_diagnostics_title').text('Run Diagnostics');
    });
}

/**
 * Shows a specific phase of the diagnostics modal
 * @param {string} phase - 'selection', 'running', or 'results'
 */
function showDiagnosticsPhase(phase) {
    $('#vecthare_diagnostics_selection').hide();
    $('#vecthare_diagnostics_running').hide();
    $('#vecthare_diagnostics_results').hide();
    $(`#vecthare_diagnostics_${phase}`).show();
}

// Console error capture for diagnostics
let capturedConsoleLogs = [];
let originalConsoleError = null;
let originalConsoleWarn = null;

/**
 * Starts capturing console errors and warnings
 */
function startConsoleCapture() {
    capturedConsoleLogs = [];

    // Store originals
    originalConsoleError = console.error;
    originalConsoleWarn = console.warn;

    // Override console.error
    console.error = function(...args) {
        capturedConsoleLogs.push({
            type: 'error',
            message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '),
            timestamp: new Date().toISOString(),
            stack: new Error().stack
        });
        originalConsoleError.apply(console, args);
    };

    // Override console.warn
    console.warn = function(...args) {
        capturedConsoleLogs.push({
            type: 'warning',
            message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '),
            timestamp: new Date().toISOString()
        });
        originalConsoleWarn.apply(console, args);
    };
}

/**
 * Stops capturing console errors and returns captured logs
 * @returns {Array} Captured console logs
 */
function stopConsoleCapture() {
    // Restore originals
    if (originalConsoleError) {
        console.error = originalConsoleError;
        originalConsoleError = null;
    }
    if (originalConsoleWarn) {
        console.warn = originalConsoleWarn;
        originalConsoleWarn = null;
    }

    return capturedConsoleLogs;
}

/**
 * Executes diagnostics based on selected categories
 */
async function executeDiagnostics() {
    const settings = extension_settings.vecthare;

    // Get selected categories
    const runInfrastructure = $('#vecthare_diag_infrastructure').prop('checked');
    const runConfiguration = $('#vecthare_diag_configuration').prop('checked');
    const runVisualizer = $('#vecthare_diag_visualizer').prop('checked');
    const runProduction = $('#vecthare_diag_production').prop('checked');

    if (!runInfrastructure && !runConfiguration && !runVisualizer && !runProduction) {
        toastr.warning('Please select at least one category to run');
        return;
    }

    // Show running phase
    showDiagnosticsPhase('running');
    $('#vecthare_diagnostics_title').text('Running Diagnostics...');

    // Start capturing console errors
    startConsoleCapture();

    try {
        // Import and run diagnostics
        const { runDiagnostics } = await import('../diagnostics/index.js');
        const results = await runDiagnostics(settings, runProduction);

        // Stop capturing and get logs
        const consoleLogs = stopConsoleCapture();

        // Filter results based on selected categories
        const filteredResults = {
            version: results.version,
            categories: {},
            checks: [],
            overall: results.overall,
            timestamp: results.timestamp,
            consoleErrors: consoleLogs
        };

        if (runInfrastructure && results.categories.infrastructure) {
            filteredResults.categories.infrastructure = results.categories.infrastructure;
            filteredResults.checks.push(...results.categories.infrastructure);
        }
        if (runConfiguration && results.categories.configuration) {
            filteredResults.categories.configuration = results.categories.configuration;
            filteredResults.checks.push(...results.categories.configuration);
        }
        if (runVisualizer && results.categories.visualizer) {
            filteredResults.categories.visualizer = results.categories.visualizer;
            filteredResults.checks.push(...results.categories.visualizer);
        }
        if (runProduction && results.categories.production) {
            filteredResults.categories.production = results.categories.production;
            filteredResults.checks.push(...results.categories.production);
        }

        // Add console errors as a category if any were captured
        if (consoleLogs.length > 0) {
            filteredResults.categories.console = consoleLogs.map(log => ({
                name: `Console ${log.type}`,
                status: log.type === 'error' ? 'fail' : 'warning',
                message: log.message.substring(0, 200) + (log.message.length > 200 ? '...' : ''),
                category: 'console'
            }));
            filteredResults.checks.push(...filteredResults.categories.console);
        }

        // Recalculate overall status based on filtered results
        const failCount = filteredResults.checks.filter(c => c.status === 'fail').length;
        const warnCount = filteredResults.checks.filter(c => c.status === 'warning').length;
        filteredResults.overall = failCount > 0 ? 'issues' : warnCount > 0 ? 'warnings' : 'healthy';

        // Show results
        showDiagnosticsResults(filteredResults);

    } catch (error) {
        stopConsoleCapture();
        console.error('VectHare Diagnostics error:', error);
        toastr.error('Failed to run diagnostics: ' + error.message);
        showDiagnosticsPhase('selection');
        $('#vecthare_diagnostics_title').text('Run Diagnostics');
    }
}

/**
 * Initializes collapsible functionality
 */
function initializeCollapsibleCards() {
    $('.vecthare-collapsible-header').on('click', function() {
        const content = $(this).next('.vecthare-collapsible-content');
        const icon = $(this).find('.vecthare-collapsible-icon');

        content.slideToggle(200);
        icon.toggleClass('rotated');
    });
}

// Use shared WebLLM provider singleton from providers/webllm.js
// This ensures the same engine instance is shared with core-vector-api.js
const getWebLlmProvider = getSharedWebLlmProvider;

/**
 * Checks if WebLLM is supported (browser + extension)
 * Shows user-friendly toast notifications with actionable guidance
 * @returns {boolean} True if WebLLM is available
 */
function isWebLlmSupported() {
    // Check 1: Browser supports WebGPU API
    if (!('gpu' in navigator)) {
        const warningKey = 'vecthare_webllm_browser_warning_shown';
        if (!sessionStorage.getItem(warningKey)) {
            toastr.error(
                'Your browser does not support the WebGPU API. Please use Chrome 113+, Edge 113+, or another WebGPU-compatible browser.',
                'WebLLM - Browser Not Supported',
                { preventDuplicates: true, timeOut: 0, extendedTimeOut: 0 }
            );
            sessionStorage.setItem(warningKey, '1');
        }
        return false;
    }

    // Check 2: WebLLM extension is installed
    if (!Object.hasOwn(SillyTavern, 'llm')) {
        const warningKey = 'vecthare_webllm_extension_warning_shown';
        if (!sessionStorage.getItem(warningKey)) {
            toastr.error(
                'WebLLM extension is not installed. Click here to install it.',
                'WebLLM - Extension Required',
                {
                    timeOut: 0,
                    extendedTimeOut: 0,
                    preventDuplicates: true,
                    onclick: () => openThirdPartyExtensionMenu('https://github.com/SillyTavern/Extension-WebLLM'),
                }
            );
            sessionStorage.setItem(warningKey, '1');
        }
        return false;
    }

    // Check 3: WebLLM extension supports embeddings
    if (typeof SillyTavern.llm.generateEmbedding !== 'function') {
        const warningKey = 'vecthare_webllm_update_warning_shown';
        if (!sessionStorage.getItem(warningKey)) {
            toastr.error(
                'Your WebLLM extension is outdated and does not support embeddings. Please update the extension.',
                'WebLLM - Update Required',
                { preventDuplicates: true, timeOut: 0, extendedTimeOut: 0 }
            );
            sessionStorage.setItem(warningKey, '1');
        }
        return false;
    }

    return true;
}

/**
 * Executes a function with WebLLM error handling
 * @param {Function} func - Function to execute
 * @returns {Promise<any>} Result of function or undefined on error
 */
async function executeWithWebLlmErrorHandling(func) {
    try {
        return await func();
    } catch (error) {
        console.error('VectHare: WebLLM operation failed', error);
        if (!(error instanceof Error)) {
            return;
        }
        switch (error.cause) {
            case 'webllm-not-available':
                toastr.error(
                    'WebLLM extension is not installed. Click here to install it.',
                    'WebLLM Error',
                    {
                        timeOut: 0,
                        extendedTimeOut: 0,
                        preventDuplicates: true,
                        onclick: () => openThirdPartyExtensionMenu('https://github.com/SillyTavern/Extension-WebLLM'),
                    }
                );
                break;
            case 'webllm-not-updated':
                toastr.error(
                    'Your WebLLM extension needs updating. It does not support embeddings.',
                    'WebLLM Update Required',
                    { timeOut: 0, extendedTimeOut: 0, preventDuplicates: true }
                );
                break;
            default:
                toastr.error(
                    `WebLLM error: ${error.message}`,
                    'WebLLM Error',
                    { preventDuplicates: true }
                );
        }
    }
}

/**
 * Loads available WebLLM models into the dropdown
 * @param {object} settings - VectHare settings object
 */
export async function loadWebLlmModels(settings) {
    return executeWithWebLlmErrorHandling(async () => {
        const provider = getWebLlmProvider();
        const models = provider.getModels();
        const $select = $('#vecthare_webllm_model');

        $select.empty();

        if (!models || models.length === 0) {
            $select.append($('<option>', { value: '', text: 'No embedding models available' }));
            return;
        }

        for (const model of models) {
            $select.append($('<option>', {
                value: model.id,
                text: model.toString ? model.toString() : model.id,
            }));
        }

        // Auto-select saved model or first available
        if (settings.webllm_model && models.some(m => m.id === settings.webllm_model)) {
            $select.val(settings.webllm_model);
        } else if (models.length > 0) {
            settings.webllm_model = models[0].id;
            $select.val(settings.webllm_model);
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        }
    });
}

/**
 * Updates the WebLLM status display based on availability
 * @returns {boolean} True if WebLLM is available
 */
/**
 * VectHare+ R10: Updates the Actions-card status line text.
 * Pure DOM function; the caller (index.js) computes the wording.
 * @param {string} text
 */
export function updateVectorizationStatus(text) {
    const $text = $('#vecthare_vectorization_status_text');
    if ($text.length === 0) return; // UI not rendered yet
    $text.text(text);
}

/**
 * VectHare+: Shows/hides the "Repair Chunks" action button (id unchanged:
 * vecthare_continue_vectorization).
 * Called by resume-on-load detection whenever the backlog state is known.
 * @param {boolean} hasBacklog True when there are unvectorized groups pending
 * @param {number} [pending] Pending group count (for the tooltip)
 * @param {number} [total] Total group count (for the tooltip)
 */
export function updateContinueVectorizationButton(mode, pending = 0, total = 0) {
    const $btn = $('#vecthare_continue_vectorization');
    if ($btn.length === 0) return; // UI not rendered yet
    // R23: mode-based visibility. 'backlog' = pending work (original behavior).
    // 'available' = collection exists but no pending backlog - the button STAYS
    // visible because repair is a safe no-op when clean ("Nothing to repair").
    // The old boolean hide-on-no-backlog made a working tool vanish based on a
    // racy async check (user: button disappeared after actions, reappeared
    // after reload). 'hide' = no collection for this chat.
    if (mode === 'backlog') {
        $btn.attr('title', `${pending} of ${total} message groups pending. Use Sync Chat to finish vectorizing them; Repair Chunks fixes previously indexed chunks.`);
        $btn.show();
    } else if (mode === 'available') {
        $btn.attr('title', 'No pending backlog right now. Click to run a repair pass anyway (removes stale/duplicate vectors of edited or deleted messages - reports "Nothing to repair" if all is clean).');
        $btn.show();
    } else {
        $btn.hide();
    }
}

/**
 * Refreshes the auto-sync checkbox state from current chat's collection
 * Call this when chat changes to keep UI in sync
 * @param {object} settings - VectHare settings object (unused, kept for API compatibility)
 */
let autoSyncRefreshId = 0;
let chatConfigDisplayId = 0;
let chatConfigShown = { key: null, at: 0 };

/**
 * Read-only display of the chunking strategy and text cleaning this chat's
 * collection was ACTUALLY vectorized with, read from its verified original
 * vectorization configuration at its recorded destination.
 *
 * The current global settings are never shown here: auto-sync and Repair
 * reproduce the collection's saved configuration, so showing today's settings
 * would misreport what runs. Nothing is written and nothing is guessed - a
 * chat with no collection reads "Not Configured", and a configuration that is
 * missing, invalid or unverifiable reads "Unknown".
 *
 * @param {object} settings VectHare settings (used only to address the backend)
 */
export function refreshChatVectorizationConfig(settings) {
    const requestId = ++chatConfigDisplayId;
    const strategyEl = $('#vecthare_chat_config_strategy');
    const cleaningEl = $('#vecthare_chat_config_cleaning');
    if (!strategyEl.length || !cleaningEl.length) return;

    const chatId = getCurrentChatId();
    const collectionId = getChatCollectionId();
    const destinations = collectionId
        ? getCollectionRegistry().filter(key => (parseRegistryKey(key).collectionId || key) === collectionId)
        : [];
    // This refresh shares its entry point with the auto-sync checkbox, which
    // runs several times per chat switch. One read per chat is enough, and the
    // key changes as soon as the chat gains (or loses) a recorded destination.
    const key = `${chatId}|${collectionId || ''}|${destinations.join(',')}`;
    if (chatConfigShown.key === key && Date.now() - chatConfigShown.at < 5000) return;

    const settle = (strategyText, cleaningText, detail = '') => {
        // A later chat switch always wins; a stale read never paints.
        if (requestId !== chatConfigDisplayId || getCurrentChatId() !== chatId) return;
        strategyEl.text(strategyText).attr('title', detail);
        cleaningEl.text(cleaningText).attr('title', detail);
        chatConfigShown = { key, at: Date.now() };
    };

    if (!collectionId) {
        settle('Not Configured', 'Not Configured', 'This chat has no vector collection yet.');
        return;
    }
    if (!destinations.length) {
        settle('Not Configured', 'Not Configured',
            'This chat has not been vectorized yet, so it has no recorded configuration.');
        return;
    }

    strategyEl.text('Reading…').attr('title', '');
    cleaningEl.text('Reading…').attr('title', '');

    void (async () => {
        try {
            const { readInitialVectorizationConfig } = await import('../core/collection-metadata.js');
            let last = null;
            for (const registryKey of destinations) {
                const destination = parseRegistryKey(registryKey);
                const saved = await readInitialVectorizationConfig(collectionId, settings, {
                    backend: destination.backend || undefined,
                    source: destination.source || undefined,
                });
                last = saved;
                if (saved.status === 'valid' && saved.config) {
                    settle(describeOriginalChunking(saved.config),
                        describeOriginalCleaning(saved.config),
                        `Recorded ${saved.config.recordedAt || 'at vectorization'}.`);
                    return;
                }
            }
            settle('Unknown', 'Unknown',
                `The original configuration is ${last?.status || 'unverified'}` +
                `${last?.reason ? ` (${last.reason})` : ''}. Nothing is assumed about it.`);
        } catch (error) {
            console.warn('VectHare: Could not read this chat collection\'s original configuration:', error);
            settle('Unknown', 'Unknown', `The original configuration could not be read (${error.message}).`);
        }
    })();
}

/**
 * Formats a verified original configuration's chunking for display.
 * @param {object} config Verified original vectorization configuration
 * @returns {string}
 */
function describeOriginalChunking(config) {
    const chunking = config.chunking;
    if (!chunking || typeof chunking !== 'object' || typeof chunking.strategy !== 'string') {
        return 'Unknown';
    }
    const known = getChunkingStrategies('chat').find(item => item.id === chunking.strategy);
    const name = known?.name || chunking.strategy;
    const extra = [];
    if (chunking.strategy === 'message_batch' && chunking.batchSize != null) {
        extra.push(`batches of ${chunking.batchSize}`);
    }
    if (chunking.strategy === 'conversation_turns' && chunking.conversationTurnOrder) {
        extra.push(chunking.conversationTurnOrder === 'character_user'
            ? 'Character → User' : 'User → Character');
    }
    if (chunking.pipeline && chunking.pipeline !== 'sync-chat') {
        extra.push(`vectorized as ${chunking.pipeline}`);
    }
    return extra.length ? `${name} (${extra.join(', ')})` : name;
}

/**
 * Formats a verified original configuration's text cleaning for display.
 * @param {object} config Verified original vectorization configuration
 * @returns {string}
 */
function describeOriginalCleaning(config) {
    const cleaning = config.textCleaning;
    if (!cleaning || typeof cleaning !== 'object' || typeof cleaning.applied !== 'boolean') {
        return 'Unknown';
    }
    if (!cleaning.applied) return 'Not applied';
    const patterns = Array.isArray(cleaning.activePatterns) ? cleaning.activePatterns.length : null;
    const preset = cleaning.preset || 'none';
    return patterns === null ? `Preset: ${preset}`
        : `Preset: ${preset} · ${patterns} pattern${patterns === 1 ? '' : 's'}`;
}

/** The context line readout under "Skip memories already in context". */
export function refreshContextReadout() {
    const element = $('#vecthare_context_readout');
    if (!element.length) return;
    try {
        element.text(describeContextLine().text);
    } catch (error) {
        element.text('');
        console.debug('VectHare: context readout failed:', error?.message || error);
    }
}

export function refreshAutoSyncCheckbox(settings) {
    const requestId = ++autoSyncRefreshId;
    const chatId = getCurrentChatId();
    const collectionId = getChatCollectionId();
    // Same card, same chat: keep the read-only configuration display in step,
    // including on chat switches (this already runs on CHAT_CHANGED).
    refreshChatVectorizationConfig(settings);
    if (!collectionId) {
        $('#vecthare_autosync_enabled').prop('checked', false);
        return;
    }
    // Dynamically import to avoid circular dependency
    import('../core/collection-metadata.js').then(({ isCollectionAutoSyncEnabled }) => {
        if (requestId !== autoSyncRefreshId || getCurrentChatId() !== chatId ||
            getChatCollectionId() !== collectionId) return;
        const isEnabled = isCollectionAutoSyncEnabled(collectionId);
        $('#vecthare_autosync_enabled').prop('checked', isEnabled);
    }).catch(error => console.warn('VectHare: Could not refresh auto-sync state:', error));
}

export function updateWebLlmStatus() {
    const $status = $('#vecthare_webllm_status');
    const $installBtn = $('#vecthare_webllm_install');
    const $loadBtn = $('#vecthare_webllm_load');
    const $modelSelect = $('#vecthare_webllm_model');

    // Check browser support
    if (!('gpu' in navigator)) {
        $status.html('<i class="fa-solid fa-exclamation-triangle" style="color: var(--warning-color, #f39c12);"></i> Your browser does not support WebGPU. Use Chrome 113+ or Edge 113+.');
        $installBtn.hide();
        $loadBtn.prop('disabled', true);
        $modelSelect.prop('disabled', true);
        return false;
    }

    // Check extension installed
    if (!Object.hasOwn(SillyTavern, 'llm')) {
        $status.html('<i class="fa-solid fa-exclamation-circle" style="color: var(--error-color, #e74c3c);"></i> WebLLM extension not installed. Click "Install Extension" below.');
        $installBtn.show();
        $loadBtn.prop('disabled', true);
        $modelSelect.prop('disabled', true);
        return false;
    }

    // Check extension supports embeddings
    if (typeof SillyTavern.llm.generateEmbedding !== 'function') {
        $status.html('<i class="fa-solid fa-exclamation-triangle" style="color: var(--warning-color, #f39c12);"></i> WebLLM extension is outdated. Please update it to support embeddings.');
        $installBtn.show().find('i').removeClass('fa-puzzle-piece').addClass('fa-rotate');
        $installBtn.find('span, text').text(' Update Extension');
        $loadBtn.prop('disabled', true);
        $modelSelect.prop('disabled', true);
        return false;
    }

    // All good!
    $status.html('<i class="fa-solid fa-check-circle" style="color: var(--success-color, #2ecc71);"></i> WebLLM extension is installed and ready.');
    $installBtn.hide();
    $loadBtn.prop('disabled', false);
    $modelSelect.prop('disabled', false);
    return true;
}

/**
 * Toggles provider-specific settings visibility
 * @param {string} selectedProvider - Currently selected provider
 * @param {object} settings - VectHare settings object
 */
function toggleProviderSettings(selectedProvider, settings) {
    // Hide all provider-specific settings
    $('.vecthare_provider_setting').hide();

    // Show settings for selected provider
    $(`.vecthare_provider_setting`).each(function() {
        const providers = $(this).attr('data-provider').split(',');
        if (providers.includes(selectedProvider)) {
            $(this).show();
        }
    });

    // Handle WebLLM-specific initialization
    if (selectedProvider === 'webllm') {
        const isSupported = updateWebLlmStatus();
        if (isSupported) {
            loadWebLlmModels(settings);
        }
    }
}

/**
 * Shows a confirmation modal when enabling auto-sync on a chat with existing vectors
 * If multiple collections match, lets user pick which one to use
 * @param {Array} allMatches - Array of matching collections [{collectionId, registryKey, chunkCount, source, backend}]
 * @param {object} settings - VectHare settings for purge operations
 * @returns {Promise<{action: string, selectedCollection?: object}>} User's choice
 */
async function showAutoSyncConfirmModal(allMatches, settings) {
    // Import unified delete function for ghost cleanup
    const { deleteCollection } = await import('../core/collection-loader.js');

    return new Promise((resolve) => {
        const hasMultiple = allMatches.length > 1;
        const hasGhosts = allMatches.some(m => m.chunkCount === 0);

        // Build collection list HTML
        const collectionListHtml = allMatches.map((match, index) => {
            const displayId = match.collectionId.length > 35
                ? match.collectionId.substring(0, 18) + '...' + match.collectionId.substring(match.collectionId.length - 12)
                : match.collectionId;
            const isGhost = match.chunkCount === 0;
            const isRecommended = index === 0 && !isGhost;

            return `
                <div class="vecthare-collection-option ${isGhost ? 'ghost' : ''}" data-index="${index}" style="
                    background: var(--SmartThemeBlurTintColor);
                    padding: 12px;
                    border-radius: 8px;
                    margin-bottom: 10px;
                    cursor: pointer;
                    border: 2px solid ${isRecommended ? 'var(--SmartThemeQuoteColor)' : 'transparent'};
                    opacity: ${isGhost ? '0.6' : '1'};
                    position: relative;
                ">
                    ${isRecommended ? '<span style="position: absolute; top: -8px; right: 10px; background: var(--SmartThemeQuoteColor); color: var(--SmartThemeBodyColor); font-size: 0.7em; padding: 2px 6px; border-radius: 4px;">RECOMMENDED</span>' : ''}
                    ${isGhost ? '<span style="position: absolute; top: -8px; right: 10px; background: var(--SmartThemeFontColorOverrideWarning, #f0ad4e); color: #000; font-size: 0.7em; padding: 2px 6px; border-radius: 4px;">GHOST</span>' : ''}
                    <div style="display: flex; justify-content: space-between; align-items: start;">
                        <div style="flex: 1; min-width: 0;">
                            <div style="font-family: monospace; word-break: break-all; font-size: 0.85em; margin-bottom: 6px;">
                                ${escapeHtml(displayId)}
                            </div>
                            <div style="font-size: 0.8em; color: var(--SmartThemeQuoteColor);">
                                <i class="fa-solid fa-cube"></i> <strong>${match.chunkCount}</strong> chunks
                                ${match.source ? `<span style="margin-left: 10px;"><i class="fa-solid fa-database"></i> ${escapeHtml(match.source)}</span>` : ''}
                            </div>
                        </div>
                        ${isGhost ? `
                            <button class="menu_button menu_button_icon vecthare-delete-ghost" data-index="${index}" style="margin-left: 10px; color: var(--SmartThemeFontColorOverrideWarning, #f0ad4e);" title="Delete this ghost collection">
                                <i class="fa-solid fa-trash"></i>
                            </button>
                        ` : ''}
                    </div>
                </div>
            `;
        }).join('');

        const modalHtml = `
            <div id="vecthare_autosync_confirm_modal" class="vecthare-modal" style="display: flex;">
                <div class="vecthare-modal-content" style="max-width: 500px;">
                    <div class="vecthare-modal-header">
                        <h3><i class="fa-solid fa-link"></i> ${hasMultiple ? 'Multiple Collections Found' : 'Existing Collection Found'}</h3>
                        <button class="vecthare-modal-close" data-action="cancel">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                    <div class="vecthare-modal-body" style="padding: 20px;">
                        <p style="margin-bottom: 15px;">
                            ${hasMultiple
                                ? `Found <strong>${allMatches.length}</strong> collections matching this chat.${hasGhosts ? ' <span style="color: var(--SmartThemeFontColorOverrideWarning, #f0ad4e);">Ghost collections (0 chunks) can be deleted.</span>' : ''}`
                                : 'This chat already has a vectorized collection:'}
                        </p>
                        <div style="max-height: 300px; overflow-y: auto; margin-bottom: 15px;">
                            ${collectionListHtml}
                        </div>
                        <p style="margin-bottom: 10px; font-size: 0.9em; color: var(--SmartThemeQuoteColor);">
                            ${hasMultiple ? 'Click a collection to select it, then choose an action.' : 'What would you like to do?'}
                        </p>
                    </div>
                    <div class="vecthare-modal-footer" style="display: flex; gap: 10px; padding: 15px 20px; border-top: 1px solid var(--SmartThemeBorderColor);">
                        <button class="menu_button" data-action="continue" style="flex: 1; border: 2px solid var(--SmartThemeQuoteColor);" title="Enable auto-sync and CONTINUE vectorization from where it last stopped (keeps all completed vectors - does NOT re-vectorize)">
                            <i class="fa-solid fa-forward"></i> Continue (Resume)
                        </button>
                        <button class="menu_button" data-action="reconnect" style="flex: 1;">
                            <i class="fa-solid fa-plug"></i> Connect
                        </button>
                        <button class="menu_button" data-action="revectorize" style="flex: 1;">
                            <i class="fa-solid fa-rotate"></i> Re-vectorize
                        </button>
                        <button class="menu_button menu_button_icon" data-action="cancel">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;

        const $modal = $(modalHtml);
        $('body').append($modal);

        // Track selected collection (default to first/best)
        let selectedIndex = 0;
        $modal.find('.vecthare-collection-option').first().css('border-color', 'var(--SmartThemeQuoteColor)');

        // Handle collection selection
        $modal.find('.vecthare-collection-option').on('click', function(e) {
            if ($(e.target).closest('.vecthare-delete-ghost').length) return; // Don't select when clicking delete

            selectedIndex = parseInt($(this).data('index'));
            $modal.find('.vecthare-collection-option').css('border-color', 'transparent');
            $(this).css('border-color', 'var(--SmartThemeQuoteColor)');
        });

        // Handle ghost deletion - uses unified deleteCollection()
        $modal.find('.vecthare-delete-ghost').on('click', async function(e) {
            e.stopPropagation();
            const index = parseInt($(this).data('index'));
            const ghost = allMatches[index];

            if (!confirm(`Delete ghost collection?\n\n${ghost.collectionId}\n\nThis will remove it from disk.`)) return;

            try {
                // Use unified delete function - handles vectors, registry, AND metadata
                const deleteSettings = {
                    ...settings,
                    source: ghost.source || settings.source,
                };
                const result = await deleteCollection(ghost.collectionId, deleteSettings, ghost.registryKey);

                // Remove from UI
                allMatches.splice(index, 1);
                $(this).closest('.vecthare-collection-option').fadeOut(200, function() {
                    $(this).remove();
                    // Re-index remaining items
                    $modal.find('.vecthare-collection-option').each((i, el) => {
                        $(el).attr('data-index', i);
                        $(el).find('.vecthare-delete-ghost').attr('data-index', i);
                    });
                });

                if (result.success) {
                    toastr.success('Ghost collection deleted', 'VectHare');
                } else {
                    toastr.warning(`Partial deletion: ${result.errors.join(', ')}`, 'VectHare');
                }

                // If no collections left, close modal
                if (allMatches.length === 0) {
                    $modal.remove();
                    resolve({ action: 'revectorize' });
                } else if (selectedIndex >= allMatches.length) {
                    selectedIndex = 0;
                    $modal.find('.vecthare-collection-option').first().css('border-color', 'var(--SmartThemeQuoteColor)');
                }
            } catch (error) {
                console.error('VectHare: Failed to delete ghost', error);
                toastr.error('Failed to delete ghost collection', 'VectHare');
            }
        });

        // Handle action buttons
        $modal.find('[data-action]').on('click', function() {
            const action = $(this).data('action');
            $modal.remove();
            resolve({
                action,
                selectedCollection: action === 'reconnect' ? allMatches[selectedIndex] : null
            });
        });

        // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
        $modal.on('mousedown touchstart', function(e) {
            e.stopPropagation();
        });

        // Close on background click
        $modal.on('click', function(e) {
            if (e.target === this) {
                $modal.remove();
                resolve({ action: 'cancel' });
            }
        });

        // Handle escape key
        $(document).one('keydown.autosync_modal', function(e) {
            if (e.key === 'Escape') {
                $modal.remove();
                resolve({ action: 'cancel' });
            }
        });
    });
}

/**
 * Binds event handlers to UI elements
 * @param {object} settings - VectHare settings object
 * @param {object} callbacks - Callback functions
 */
/**
 * Asks what a Full Purge should remove. Both choices delete VectHare's own
 * vectors and its metadata; only one of them also resets VectHare's settings.
 * Resolves to 'all', 'data', or null when the user cancels.
 * @returns {Promise<'all'|'data'|null>}
 */
export function openPurgeOptionsDialog() {
    return new Promise(resolve => {
        if ($('#vecthare_purge_options_modal').length === 0) {
            $('body').append(`
            <div id="vecthare_purge_options_modal" class="vecthare-modal">
                <div class="vecthare-modal-content vecthare-rename-dialog popup">
                    <div class="vecthare-modal-header">
                        <h3>Full Purge</h3>
                        <button class="vecthare-btn-icon" id="vecthare_purge_options_close">✕</button>
                    </div>
                    <div class="vecthare-rename-body">
                        <p>Both choices delete every VectHare-owned vector collection and all of
                        VectHare's stored metadata for them: the collection registry, collection
                        records and preferences, chunk annotations, chat bindings and identity
                        ledgers.</p>
                        <p><strong>Your chats, characters and SillyTavern's own data are not
                        touched, and collections VectHare does not own are left alone.</strong></p>
                        <p>Choose whether your VectHare settings go too:</p>
                        <ul>
                            <li><strong>Everything</strong> — also resets VectHare's settings
                            (backend, embedding provider and model, chunking, RAG, decay and the
                            rest) to their defaults.</li>
                            <li><strong>Vectors &amp; metadata only</strong> — keeps your settings
                            exactly as they are, so you can re-vectorize with the same
                            configuration.</li>
                        </ul>
                        <p><small>Nothing is deleted until the vector purge has completed and been
                        verified. This cannot be undone.</small></p>
                    </div>
                    <div class="vecthare-modal-footer">
                        <button class="vecthare-btn" id="vecthare_purge_options_cancel">Cancel</button>
                        <button class="vecthare-btn vecthare-btn-danger" id="vecthare_purge_options_data">
                            Purge Vectors &amp; Metadata
                        </button>
                        <button class="vecthare-btn vecthare-btn-danger" id="vecthare_purge_options_all">
                            Purge Everything
                        </button>
                    </div>
                </div>
            </div>
            `);
            $('#vecthare_purge_options_modal').on('mousedown touchstart', e => e.stopPropagation());
        }

        const modal = $('#vecthare_purge_options_modal');
        const finish = choice => {
            modal.off('.vecthareePurge');
            $('#vecthare_purge_options_close, #vecthare_purge_options_cancel, ' +
              '#vecthare_purge_options_data, #vecthare_purge_options_all').off('.vecthareePurge');
            modal.removeClass('active').hide();
            resolve(choice);
        };
        $('#vecthare_purge_options_close').on('click.vecthareePurge', () => finish(null));
        $('#vecthare_purge_options_cancel').on('click.vecthareePurge', () => finish(null));
        $('#vecthare_purge_options_data').on('click.vecthareePurge', () => finish('data'));
        $('#vecthare_purge_options_all').on('click.vecthareePurge', () => finish('all'));
        modal.on('click.vecthareePurge', function (event) {
            if (event.target === this) finish(null);
        });
        modal.addClass('active').show();
    });
}

let uiCallbacks = {};

/**
 * Refreshes what a committed chat collection rebuild invalidates: the
 * Chat Auto-Sync card's read-only configuration display and the cached
 * collection/vectorization status. The Database Browser re-reads collections
 * when it is opened, so nothing is pushed into it here.
 */
export function refreshAfterChatCollectionRebuild() {
    refreshChatVectorizationConfig(extension_settings.vecthare);
    try {
        uiCallbacks.onCollectionsChanged?.();
    } catch (error) {
        console.warn('VectHare: Collection status could not be refreshed:', error);
    }
}

function bindSettingsEvents(settings, callbacks) {
    uiCallbacks = callbacks || {};
    // Auto-sync enable/disable - now per-collection instead of global
    // Initial state is set by refreshAutoSyncCheckbox() after chat loads
    $('#vecthare_autosync_enabled')
        .on('input', async function() {
            const enabling = $(this).prop('checked');
            const $checkbox = $(this);

            const chatId = getCurrentChatId();
            if (!chatId) {
                // No chat open - warn and don't enable
                toastr.warning('Open a chat first before enabling auto-sync');
                $checkbox.prop('checked', false);
                return;
            }

            let collectionId = getChatCollectionId();
            if (!collectionId && enabling) {
                // A new/unvectorized chat is intentionally not bound on open.
                // The vectorizer creates the binding only when it writes.
                $checkbox.prop('checked', false);
                openContentVectorizer('chat');
                return;
            }
            if (!collectionId) {
                $checkbox.prop('checked', false);
                return;
            }
            const stillCurrent = () => getCurrentChatId() === chatId && getChatCollectionId() === collectionId;

            // Import the metadata functions
            const { setCollectionAutoSync } = await import('../core/collection-metadata.js');
            if (!stillCurrent()) { refreshAutoSyncCheckbox(settings); return; }

            // If enabling, check if we need to set up the collection first
            if (enabling) {
                // SINGLE SOURCE OF TRUTH: Use doesChatHaveVectors which runs discovery
                const { hasVectors, allMatches } = await doesChatHaveVectors(settings);
                if (!stillCurrent()) { refreshAutoSyncCheckbox(settings); return; }

                if (!hasVectors) {
                    // No vectors found anywhere - open vectorizer panel
                    $checkbox.prop('checked', false);
                    toastr.info('Set up your chat vectorization first');
                    openContentVectorizer('chat');
                    return;
                }

                // Found existing vectors - show confirmation modal with all matches
                const result = await showAutoSyncConfirmModal(allMatches, settings);
                if (!stillCurrent()) { refreshAutoSyncCheckbox(settings); return; }

                if (result.action === 'cancel') {
                    // User cancelled - don't enable
                    $checkbox.prop('checked', false);
                    return;
                }

                if (result.action === 'reconnect' && result.selectedCollection) {
                    // Connect to selected collection
                    const selected = result.selectedCollection;
                    toastr.success(`Connected to collection with ${selected.chunkCount} chunks`, 'Auto-Sync Enabled');
                    vhLog(`VectHare: Auto-sync enabled - connected to ${selected.collectionId} (${selected.chunkCount} chunks)`);
                } else if (result.action === 'revectorize') {
                    // User wants to start fresh - open vectorizer
                    $checkbox.prop('checked', false);
                    openContentVectorizer('chat');
                    return;
                }
            }

            // Save to per-collection metadata instead of global setting
            setCollectionAutoSync(collectionId, enabling);

            if (!enabling) {
                toastr.info('Auto-sync disabled for this chat');
            } else {
                toastr.success('Auto-sync enabled for this chat');
            }
            vhLog(`VectHare: Chat auto-sync for ${collectionId}: ${enabling ? 'enabled' : 'disabled'}`);
            // VH-067: a "continue" branch here read `result` outside its scope (a
            // ReferenceError every time auto-sync was enabled) and the confirm
            // modal never answers "continue"; it was removed.
        });

        // Collection lock handled inside Database Browser per-collection settings

    // Chat chunking and text cleaning are read-only here: they belong to the
    // collection, not to the current global settings, and are set by
    // vectorizing or rebuilding. Shown from the collection's verified original
    // configuration only.
    refreshChatVectorizationConfig(settings);

    // Vector backend selection
    $('#vecthare_vector_backend')
        .val(settings.vector_backend || 'standard')
        .on('change', function() {
            settings.vector_backend = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
            // K3: drop the cached inventory so the Database Browser re-reads on next open
            invalidateCollectionInventory();
            // VH-052: say which collections will not be used now.
            void import('../core/backend-elsewhere.js').then(m => m.warnAfterBackendChange(settings)).catch(() => {});

            // Show/hide Qdrant settings
            if (settings.vector_backend === 'qdrant') {
                $('#vecthare_qdrant_settings').show();
            } else {
                $('#vecthare_qdrant_settings').hide();
            }
            if (settings.vector_backend === 'milvus') {
                $('#vecthare_milvus_settings').show();
            } else {
                $('#vecthare_milvus_settings').hide();
            }

            vhLog(`VectHare: Vector backend changed to ${settings.vector_backend}`);
            void refreshVersionInfo(); // and again when the connection check below finishes
            // Preserve existing invalidation and check the newly selected backend.
            resetBackendHealth();
            void checkBackendHealth(settings);
        });

    // Qdrant cloud toggle
    $('#vecthare_qdrant_use_cloud')
        .prop('checked', settings.qdrant_use_cloud || false)
        .on('change', async function() {
            settings.qdrant_use_cloud = $(this).prop('checked');
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
            void import('../core/backend-elsewhere.js').then(m => m.warnAfterBackendChange(settings)).catch(() => {}); // VH-052

            // Toggle between local and cloud settings
            if (settings.qdrant_use_cloud) {
                $('#vecthare_qdrant_local_settings').hide();
                $('#vecthare_qdrant_cloud_settings').show();
            } else {
                $('#vecthare_qdrant_local_settings').show();
                $('#vecthare_qdrant_cloud_settings').hide();
            }

            // Reset backend health to force re-initialization with new config
            vhLog('VectHare: Qdrant mode changed, forcing re-initialization...');
            resetBackendHealth('qdrant');

            // Only an actual mode change triggers reinitialization.
            if (settings.vector_backend === 'qdrant') {
                const modeChecked = settings.qdrant_use_cloud;
                const healthy = await checkBackendHealth(settings);
                // Ignore completion notifications for a mode no longer selected.
                if (settings.vector_backend !== 'qdrant' || settings.qdrant_use_cloud !== modeChecked) return;
                if (healthy) {
                    toastr.success(
                        `Qdrant re-initialized in ${settings.qdrant_use_cloud ? 'cloud' : 'local'} mode`,
                        'VectHare'
                    );
                } else {
                    toastr.warning('Failed to reinitialize Qdrant', 'VectHare');
                }
            }
        });

    // Display saved mode without firing the change handler during page load.
    $('#vecthare_qdrant_local_settings').toggle(!settings.qdrant_use_cloud);
    $('#vecthare_qdrant_cloud_settings').toggle(!!settings.qdrant_use_cloud);

    // Qdrant settings
    $('#vecthare_qdrant_host')
        .val(settings.qdrant_host || 'localhost')
        .on('input', function() {
            settings.qdrant_host = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
            void import('../core/backend-elsewhere.js').then(m => m.warnAfterBackendChange(settings)).catch(() => {}); // VH-052
        });

    $('#vecthare_qdrant_port')
        .val(settings.qdrant_port || 6333)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.qdrant_port = isNaN(value) ? 6333 : value;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
            void import('../core/backend-elsewhere.js').then(m => m.warnAfterBackendChange(settings)).catch(() => {}); // VH-052
        });

    $('#vecthare_qdrant_url')
        .val(settings.qdrant_url || '')
        .on('input', function() {
            settings.qdrant_url = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
            void import('../core/backend-elsewhere.js').then(m => m.warnAfterBackendChange(settings)).catch(() => {}); // VH-052
        });

    bindSecretField('#vecthare_qdrant_api_key', 'qdrant_api_key', settings);

    // 9c: Milvus multitenancy toggle (new collections only)
    $('#vecthare_milvus_multitenancy')
        .prop('checked', settings.milvus_multitenancy !== false)
        .on('change', function() {
            settings.milvus_multitenancy = $(this).prop('checked');
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // Qdrant multitenancy toggle
    $('#vecthare_qdrant_multitenancy')
        .prop('checked', settings.qdrant_multitenancy || false)
        .on('change', function() {
            settings.qdrant_multitenancy = $(this).prop('checked');
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // Show Qdrant settings if backend is qdrant
    if (settings.vector_backend === 'qdrant') {
        $('#vecthare_qdrant_settings').show();
    }

    // Milvus settings
    $('#vecthare_milvus_host')
        .val(settings.milvus_host || 'localhost')
        .on('input', function() {
            settings.milvus_host = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
            void import('../core/backend-elsewhere.js').then(m => m.warnAfterBackendChange(settings)).catch(() => {}); // VH-052
        });

    $('#vecthare_milvus_port')
        .val(settings.milvus_port || 19530)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.milvus_port = isNaN(value) ? 19530 : value;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
            void import('../core/backend-elsewhere.js').then(m => m.warnAfterBackendChange(settings)).catch(() => {}); // VH-052
        });

    $('#vecthare_milvus_username')
        .val(settings.milvus_username || '')
        .on('input', function() {
            settings.milvus_username = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    bindSecretField('#vecthare_milvus_password', 'milvus_password', settings);
    bindSecretField('#vecthare_milvus_token', 'milvus_token', settings);

    $('#vecthare_milvus_dimensions')
        .val(settings.milvus_dimensions || '')
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.milvus_dimensions = isNaN(value) ? '' : value;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_milvus_address')
        .val(settings.milvus_address || '')
        .on('input', function() {
            settings.milvus_address = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
            void import('../core/backend-elsewhere.js').then(m => m.warnAfterBackendChange(settings)).catch(() => {}); // VH-052
        });

    // Show Milvus settings if backend is milvus
    if (settings.vector_backend === 'milvus') {
        $('#vecthare_milvus_settings').show();
    }

    // Embedding provider
    $('#vecthare_source')
        .val(settings.source)
        .on('change', function() {
            settings.source = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
            toggleProviderSettings(settings.source, settings);
            vhLog(`VectHare: Embedding provider changed to ${settings.source}`);
            // Keep existing cache reset and refresh the displayed health.
            resetBackendHealth();
            invalidateCollectionInventory(); // K3
            void checkBackendHealth(settings);
        });

    // K3: any embedding-model change also makes the cached Browser inventory stale
    $(document).off('change.vecthareStale').on('change.vecthareStale',
        '#vecthare_settings select[id$="_model"], #vecthare_settings input[id$="_model"]',
        () => invalidateCollectionInventory());

    // Score threshold
    $('#vecthare_score_threshold')
        .val(settings.score_threshold)
        .on('input', function() {
            const value = parseFloat($(this).val());
            const safeValue = isNaN(value) ? 0.3 : value;
            $('#vecthare_threshold_value').text(safeValue.toFixed(2));
            settings.score_threshold = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });
    $('#vecthare_threshold_value').text(settings.score_threshold.toFixed(2));

    // Deduplication depth
    $('#vecthare_deduplication_depth')
        .val(settings.deduplication_depth ?? 50)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? 50 : Math.max(0, value);
            $('#vecthare_deduplication_depth_value').text(safeValue);
            settings.deduplication_depth = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });
    $('#vecthare_deduplication_depth_value').text(settings.deduplication_depth ?? 50);

    // Keyword scoring method
    $('#vecthare_keyword_scoring_method')
        .val(settings.keyword_scoring_method || 'keyword')
        .on('change', function() {
            settings.keyword_scoring_method = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();

            // Show/hide BM25 parameters
            if (settings.keyword_scoring_method === 'bm25' || settings.keyword_scoring_method === 'hybrid') {
                $('#vecthare_bm25_params').show();
            } else {
                $('#vecthare_bm25_params').hide();
            }
            vhLog(`VectHare: Keyword scoring method changed to ${settings.keyword_scoring_method}`);
        });

    // Show/hide BM25 params based on initial setting
    if (settings.keyword_scoring_method === 'bm25' || settings.keyword_scoring_method === 'hybrid') {
        $('#vecthare_bm25_params').show();
    }

    // BM25 k1 parameter
    $('#vecthare_bm25_k1')
        .val(settings.bm25_k1 || 1.5)
        .on('input', function() {
            const value = parseFloat($(this).val());
            const safeValue = isNaN(value) ? 1.5 : value;
            $('#vecthare_bm25_k1_value').text(safeValue.toFixed(1));
            settings.bm25_k1 = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });
    $('#vecthare_bm25_k1_value').text((settings.bm25_k1 || 1.5).toFixed(1));

    // BM25 b parameter
    $('#vecthare_bm25_b')
        .val(settings.bm25_b || 0.75)
        .on('input', function() {
            const value = parseFloat($(this).val());
            const safeValue = isNaN(value) ? 0.75 : value;
            $('#vecthare_bm25_b_value').text(safeValue.toFixed(2));
            settings.bm25_b = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });
    $('#vecthare_bm25_b_value').text((settings.bm25_b || 0.75).toFixed(2));

    // ========== Hybrid Search Settings ==========

    // Enable Hybrid Search checkbox
    $('#vecthare_hybrid_search_enabled')
        .prop('checked', settings.hybrid_search_enabled || false)
        .on('change', function() {
            const enabled = $(this).prop('checked');
            settings.hybrid_search_enabled = enabled;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
            $('#vecthare_hybrid_params').toggle(enabled);
            vhLog(`VectHare: Hybrid search ${enabled ? 'enabled' : 'disabled'}`);
        });
    // Initialize visibility
    $('#vecthare_hybrid_params').toggle(settings.hybrid_search_enabled || false);

    // Fusion method selector
    $('#vecthare_hybrid_fusion_method')
        .val(settings.hybrid_fusion_method || 'rrf')
        .on('change', function() {
            settings.hybrid_fusion_method = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
            // Show weights only for weighted method, RRF settings for RRF
            const isWeighted = settings.hybrid_fusion_method === 'weighted';
            $('#vecthare_hybrid_weights').toggle(isWeighted);
            $('#vecthare_hybrid_rrf_settings').toggle(!isWeighted);
            vhLog(`VectHare: Hybrid fusion method changed to ${settings.hybrid_fusion_method}`);
        });
    // Initialize visibility based on current method
    const isWeightedMethod = (settings.hybrid_fusion_method || 'rrf') === 'weighted';
    $('#vecthare_hybrid_weights').toggle(isWeightedMethod);
    $('#vecthare_hybrid_rrf_settings').toggle(!isWeightedMethod);

    // Vector weight slider
    $('#vecthare_hybrid_vector_weight')
        .val(settings.hybrid_vector_weight ?? 0.5)
        .on('input', function() {
            const value = parseFloat($(this).val());
            const safeValue = isNaN(value) ? 0.5 : value;
            $('#vecthare_hybrid_vector_weight_value').text(safeValue.toFixed(1));
            settings.hybrid_vector_weight = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });
    $('#vecthare_hybrid_vector_weight_value').text((settings.hybrid_vector_weight ?? 0.5).toFixed(1));

    // Text weight slider
    $('#vecthare_hybrid_text_weight')
        .val(settings.hybrid_text_weight ?? 0.5)
        .on('input', function() {
            const value = parseFloat($(this).val());
            const safeValue = isNaN(value) ? 0.5 : value;
            $('#vecthare_hybrid_text_weight_value').text(safeValue.toFixed(1));
            settings.hybrid_text_weight = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });
    $('#vecthare_hybrid_text_weight_value').text((settings.hybrid_text_weight ?? 0.5).toFixed(1));

    // RRF K constant slider
    $('#vecthare_hybrid_rrf_k')
        .val(settings.hybrid_rrf_k || 60)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? 60 : value;
            $('#vecthare_hybrid_rrf_k_value').text(safeValue);
            settings.hybrid_rrf_k = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });
    $('#vecthare_hybrid_rrf_k_value').text(settings.hybrid_rrf_k || 60);

    // Prefer native backend hybrid checkbox
    $('#vecthare_hybrid_native_prefer')
        .prop('checked', settings.hybrid_native_prefer !== false)
        .on('change', function() {
            settings.hybrid_native_prefer = $(this).prop('checked');
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // Query depth (how many recent messages to include in search query)
    $('#vecthare_query_depth')
        .val(settings.query || 2)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? 2 : value;
            $('#vecthare_query_depth_value').text(safeValue);
            settings.query = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });
    $('#vecthare_query_depth_value').text(settings.query || 2);

    // Top K - number of results retrieved per collection (top-K)
    $('#vecthare_topk')
        .val((settings.top_k ?? settings.insert) || 3)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? (settings.insert || 3) : value;
            settings.top_k = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // World Info Integration settings
    $('#vecthare_enabled_world_info')
        .prop('checked', settings.enabled_world_info || false)
        .on('change', function() {
            const enabled = $(this).prop('checked');
            settings.enabled_world_info = enabled;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
            // Show/hide the detailed world info settings panel
            $('#vecthare_world_info_settings').toggle(enabled);
        });

    $('#vecthare_world_info_threshold')
        .val(settings.world_info_threshold ?? 0.3)
        .on('input', function() {
            const value = parseFloat($(this).val());
            const safeValue = isNaN(value) ? 0.3 : Math.max(0, Math.min(1, value));
            settings.world_info_threshold = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_world_info_top_k')
        .val(settings.world_info_top_k ?? 3)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? 3 : Math.max(1, Math.min(20, value));
            settings.world_info_top_k = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_world_info_query_depth')
        .val(settings.world_info_query_depth ?? 3)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? 3 : Math.max(1, Math.min(10, value));
            settings.world_info_query_depth = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_enabled_for_all')
        .prop('checked', settings.world_info_enabled_for_all || false)
        .on('change', function() {
            settings.world_info_enabled_for_all = $(this).prop('checked');
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_max_entries')
        .val(settings.world_info_max_entries ?? 10)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.world_info_max_entries = isNaN(value) ? 10 : Math.max(1, Math.min(9999, value));
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // Custom stopwords
    $('#vecthare_custom_stopwords')
        .val(settings.custom_stopwords || '')
        .on('input', function() {
            settings.custom_stopwords = $(this).val();
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // Initialize world info settings visibility based on current setting
    $('#vecthare_world_info_settings').toggle(settings.enabled_world_info || false);

    // Debug buttons: Test semantic WI and dump registry
    $('#vecthare_wi_test_btn').on('click', async function() {
        try {
            const raw = $('#vecthare_wi_test_input').val() || '';
            const recentMessages = raw.split('\n').map(s => s.trim()).filter(Boolean);
            const activeEntries = [];
            const cfg = window.extension_settings?.vecthare || settings;

            vhLog('VectHare: Running semantic WI test with messages:', recentMessages);

            // Primary: use initialized hooks if available
            if (window.VectHare_WorldInfo && typeof window.VectHare_WorldInfo.getSemanticEntries === 'function') {
                const entries = await window.VectHare_WorldInfo.getSemanticEntries(recentMessages, activeEntries, cfg);
                vhLog('VectHare: Semantic WI test results (via window hooks):', entries);
                toastr.info(`Semantic WI test completed - ${entries.length} entries (see console)`);

                // If no entries found, provide extended diagnostics to help debug
                if (!entries || entries.length === 0) {
                    try {
                        vhLog('VectHare: No semantic entries — dumping registry and per-collection query info...');
                        const registry = vecthareState().registry || [];
                        vhLog('VectHare: Collection registry:', registry);

                        const coreApi = await import('../core/core-vector-api.js');
                        const metaMod = await import('../core/collection-metadata.js');

                        for (const collKey of registry) {
                            try {
                                if (!collKey.includes('lorebook')) continue; // focus on lorebooks
                                const meta = metaMod.getCollectionMeta(collKey);
                                vhLog(`VectHare: Collection meta for ${collKey}:`, meta);

                                // Check saved hashes (true=include metadata)
                                if (coreApi.getSavedHashes) {
                                    try {
                                        const saved = await coreApi.getSavedHashes(collKey, cfg, true);
                                        vhLog(`VectHare: getSavedHashes for ${collKey}:`, saved && saved.hashes ? saved.hashes.length + ' hashes' : saved);
                                    } catch (hErr) {
                                        console.warn(`VectHare: getSavedHashes failed for ${collKey}:`, hErr.message);
                                    }
                                }

                                // Run a direct vector query against this collection
                                try {
                                    const qres = await coreApi.queryCollection(collKey, recentMessages.join('\n'), cfg.world_info_top_k || 3, cfg);
                                    vhLog(`VectHare: queryCollection result for ${collKey}:`, qres);
                                } catch (qErr) {
                                    console.warn(`VectHare: queryCollection failed for ${collKey}:`, qErr.message);
                                }
                            } catch (inner) {
                                console.warn('VectHare: Error inspecting collection', collKey, inner.message);
                            }
                        }

                        toastr.info('Extended WI diagnostics written to console (registry + per-collection queries)');
                    } catch (diagErr) {
                        console.error('VectHare: Failed to run extended WI diagnostics', diagErr);
                        toastr.error('Failed to run WI diagnostics: ' + (diagErr.message || diagErr));
                    }
                }

                return;
            }

            // Fallback: try dynamic import of module (in case initialization order differed)
            try {
                const mod = await import('../core/world-info-integration.js');
                const fn = mod.getSemanticWorldInfoEntries || mod.getSemanticEntries || mod.default;
                if (!fn || typeof fn !== 'function') {
                    throw new Error('WorldInfo module does not export a usable function');
                }
                const entries = await fn(recentMessages, activeEntries, cfg);
                vhLog('VectHare: Semantic WI test results (via dynamic import):', entries);
                toastr.info(`Semantic WI test completed - ${entries.length} entries (see console)`);
                return;
            } catch (impErr) {
                console.warn('VectHare: Dynamic import fallback failed:', impErr.message);
                toastr.error('VectHare: WorldInfo hooks not initialized and dynamic import failed: ' + impErr.message);
                return;
            }

        } catch (e) {
            console.error('VectHare: Semantic WI test failed', e);
            try { toastr.error('Semantic WI test failed: ' + (e.message || String(e))); } catch (_) {}
        }
    });

    $('#vecthare_wi_dump_registry').on('click', function() {
        try {
            const registry = vecthareState().registry || [];
            vhLog('VectHare: Collection registry dump:', registry);
            toastr.info(`Collection registry dumped to console (${registry.length} items)`);
        } catch (e) {
            console.error('VectHare: Failed to dump registry', e);
            toastr.error('Failed to dump registry: ' + e.message);
        }
    });

    // Apply first semantic hit to ST World Info (best-effort)
    $('#vecthare_wi_apply_first').on('click', async function() {
        try {
            const raw = $('#vecthare_wi_test_input').val() || '';
            const recentMessages = raw.split('\n').map(s => s.trim()).filter(Boolean);
            const cfg = window.extension_settings?.vecthare || settings;

            if (!window.VectHare_WorldInfo || !window.VectHare_WorldInfo.getSemanticEntries) {
                toastr.error('VectHare: WorldInfo hooks not initialized');
                return;
            }

            const entries = await window.VectHare_WorldInfo.getSemanticEntries(recentMessages, [], cfg);
            if (!entries || entries.length === 0) {
                toastr.info('No semantic entries found');
                return;
            }

            const first = entries[0];
            // VH-075 (user decision a): SillyTavern has no function to activate one
            // entry from outside, so this test tool copies it (it only ever did).
            const text = first.content || (Array.isArray(first.key) ? first.key.join(', ') : String(first.key));
            try {
                await navigator.clipboard.writeText(text);
                toastr.info('First semantic hit copied to the clipboard. Paste it into the World Info editor if you want to use it.');
            } catch (e) {
                vhLog('VectHare: Clipboard write failed, showing content in console');
                vhLog('Semantic entry content:', text);
                toastr.info('Semantic entry logged to console. Paste into World Info editor to activate.');
            }

        } catch (e) {
            console.error('VectHare: Copy semantic WI failed', e);
            toastr.error('Failed to copy the semantic WI entry: ' + e.message);
        }
    });

    // Injection position (where chunks appear in prompt)
    $('#vecthare_injection_position')
        .val(settings.position ?? 0)
        .on('change', function() {
            const value = parseInt($(this).val());
            settings.position = value;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
            // Show/hide depth slider based on position
            $('#vecthare_injection_depth_row').toggle(value === 1);
        });
    // Initialize depth row visibility
    $('#vecthare_injection_depth_row').toggle((settings.position ?? 0) === 1);

    // Injection depth (for in-chat position)
    $('#vecthare_injection_depth')
        .val(settings.depth ?? 2)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? 2 : value;
            $('#vecthare_injection_depth_value').text(safeValue);
            settings.depth = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });
    $('#vecthare_injection_depth_value').text(settings.depth ?? 2);

    // RAG Context settings
    $('#vecthare_rag_context')
        .val(settings.rag_context || '')
        .on('input', function() {
            settings.rag_context = $(this).val();
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_rag_xml_tag')
        .val(settings.rag_xml_tag || '')
        .on('input', function() {
            // Sanitize: only allow alphanumeric, underscore, hyphen
            const sanitized = $(this).val().replace(/[^a-zA-Z0-9_-]/g, '');
            $(this).val(sanitized);
            settings.rag_xml_tag = sanitized;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_include_keywords_in_rag_context')
        .prop('checked', settings.include_keywords_in_rag_context === true)
        .on('change', function() {
            settings.include_keywords_in_rag_context = $(this).prop('checked');
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_skip_in_context_memories')
        .prop('checked', settings.skip_in_context_memories !== false)
        .on('change', function() {
            settings.skip_in_context_memories = $(this).prop('checked');
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });
    $('#vecthare_memories_at_context_top')
        .prop('checked', settings.memories_at_context_top === true)
        .on('change', function() {
            settings.memories_at_context_top = $(this).prop('checked');
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });
    refreshContextReadout();

    $('#vecthare_apply_prompt_regex_to_memories')
        .prop('checked', settings.apply_prompt_regex_to_memories !== false)
        .on('change', function() {
            settings.apply_prompt_regex_to_memories = $(this).prop('checked');
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // Global temporal weighting defaults
    const updateDecayTypeSection = (enabled) => {
        const $section = $('#vecthare_default_decay_type_section');
        const $radios = $section.find('input[type="radio"]');

        if (enabled) {
            $section.removeClass('vecthare-subsection-disabled');
            $radios.prop('disabled', false);
            // Select the saved type (or default to 'decay') when enabling
            const savedType = settings.default_decay_type || 'decay';
            $(`input[name="vecthare_default_decay_type"][value="${savedType}"]`).prop('checked', true);
        } else {
            $section.addClass('vecthare-subsection-disabled');
            $radios.prop('disabled', true).prop('checked', false);
        }
    };

    $('#vecthare_default_decay_enabled')
        .prop('checked', settings.default_decay_enabled || false)
        .on('change', function() {
            const enabled = $(this).prop('checked');
            settings.default_decay_enabled = enabled;
            updateDecayTypeSection(enabled);
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // Initialize the section state
    updateDecayTypeSection(settings.default_decay_enabled || false);

    $('input[name="vecthare_default_decay_type"]').on('change', function() {
        settings.default_decay_type = $(this).val();
        applySettingsSnapshot(settings);
        saveSettingsDebounced();
    });

    // Provider-specific settings

    // ElectronHub model
    $('#vecthare_electronhub_model')
        .val(settings.electronhub_model)
        .on('change', function() {
            settings.electronhub_model = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // Alternative endpoint
    $('#vecthare_use_alt_endpoint')
        .prop('checked', settings.use_alt_endpoint)
        .on('input', function() {
            settings.use_alt_endpoint = $(this).prop('checked');
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
            $('#vecthare_alt_endpoint_url').toggle(settings.use_alt_endpoint);
        });

    $('#vecthare_alt_endpoint_url')
        .val(settings.alt_endpoint_url)
        .toggle(settings.use_alt_endpoint)
        .on('input', function() {
            settings.alt_endpoint_url = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // WebLLM model
    $('#vecthare_webllm_model')
        .val(settings.webllm_model)
        .on('change', function() {
            settings.webllm_model = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // WebLLM Load Model button
    $('#vecthare_webllm_load').on('click', async function() {
        const modelId = settings.webllm_model;

        if (!modelId) {
            toastr.warning('Please select a WebLLM model first', 'No Model Selected');
            return;
        }

        if (!isWebLlmSupported()) {
            return; // isWebLlmSupported already shows appropriate error
        }

        const $button = $(this);
        const originalHtml = $button.html();
        $button.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Loading...');

        await executeWithWebLlmErrorHandling(async () => {
            const provider = getWebLlmProvider();
            await provider.loadModel(modelId);
            toastr.success(`WebLLM model "${modelId}" loaded successfully`, 'Model Loaded');
        });

        $button.prop('disabled', false).html(originalHtml);
    });

    // WebLLM Install Extension button
    $('#vecthare_webllm_install').on('click', function(e) {
        e.preventDefault();
        e.stopPropagation();

        if (Object.hasOwn(SillyTavern, 'llm')) {
            toastr.info('WebLLM extension is already installed. Try refreshing the page.', 'Already Installed');
            return;
        }

        openThirdPartyExtensionMenu('https://github.com/SillyTavern/Extension-WebLLM');
    });

    // Ollama model
    $('#vecthare_ollama_model')
        .val(settings.ollama_model)
        .on('input', function() {
            settings.ollama_model = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // U3: VectHare's console.log output is off unless this is on.
    $('#vecthare_debug_logging')
        .prop('checked', settings.debug_logging === true)
        .on('input', function() {
            settings.debug_logging = $(this).prop('checked');
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_ollama_keep')
        .prop('checked', settings.ollama_keep)
        .on('input', function() {
            settings.ollama_keep = $(this).prop('checked');
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // BananaBread reranking
    $('#vecthare_bananabread_rerank')
        .prop('checked', settings.bananabread_rerank)
        .on('input', function() {
            settings.bananabread_rerank = $(this).prop('checked');
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // BananaBread API key
    // Note: We store in extension settings because custom keys aren't returned by ST's readSecretState()
    const updateBananaBreadKeyDisplay = () => {
        const savedKey = settings.bananabread_api_key;
        if (savedKey) {
            // Mask the key for display (show last 4 chars)
            const masked = savedKey.length > 4
                ? '*'.repeat(Math.min(savedKey.length - 4, 8)) + savedKey.slice(-4)
                : '*'.repeat(savedKey.length);
            $('#vecthare_bananabread_apikey').attr('placeholder', `Key saved: ${masked}`);
        } else {
            $('#vecthare_bananabread_apikey').attr('placeholder', 'Paste key here to save...');
        }
    };
    updateBananaBreadKeyDisplay();

    $('#vecthare_bananabread_apikey')
        .on('change', async function() {
            const value = String($(this).val()).trim();
            if (value) {
                // Store in extension settings (primary storage for this key)
                settings.bananabread_api_key = value;
                applySettingsSnapshot(settings);
                saveSettingsDebounced();

                // Also write to ST secrets for potential future compatibility
                await writeSecret('bananabread_api_key', value);

                toastr.success('BananaBread API key saved');
                $(this).val('');
                updateBananaBreadKeyDisplay();
            }
        });

    // OpenAI model
    $('#vecthare_openai_model')
        .val(settings.openai_model)
        .on('change', function() {
            settings.openai_model = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // Cohere model
    $('#vecthare_cohere_model')
        .val(settings.cohere_model)
        .on('change', function() {
            settings.cohere_model = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // TogetherAI model
    $('#vecthare_togetherai_model')
        .val(settings.togetherai_model)
        .on('change', function() {
            settings.togetherai_model = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // vLLM model
    $('#vecthare_vllm_model')
        .val(settings.vllm_model)
        .on('input', function() {
            settings.vllm_model = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // Google model
    $('#vecthare_google_model')
        .val(settings.google_model)
        .on('change', function() {
            settings.google_model = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // Nomic key lives in SillyTavern's own API settings (not stored by VectHare)
    $('#vecthare_nomicai_api_key').on('click', function() {
        toastr.info('Set the Nomic API key in SillyTavern: API Connections > Nomic AI (text embeddings). VectHare reads it from there.', 'VectHare', { timeOut: 8000 });
    });

    // OpenRouter model
    $('#vecthare_openrouter_model')
        .val(settings.openrouter_model)
        .on('input', function() {
            settings.openrouter_model = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // OpenRouter API key - saves directly to ST secrets
    // Show existing key if set
    const updateOpenRouterKeyDisplay = () => {
        const secrets = secret_state[SECRET_KEYS.OPENROUTER];
        if (Array.isArray(secrets) && secrets.length > 0) {
            const activeSecret = secrets.find(s => s.active) || secrets[0];
            if (activeSecret?.value) {
                $('#vecthare_openrouter_apikey').attr('placeholder', activeSecret.value);
            }
        }
    };
    updateOpenRouterKeyDisplay();

    $('#vecthare_openrouter_apikey')
        .on('change', async function() {
            const value = String($(this).val()).trim();
            if (value) {
                await writeSecret(SECRET_KEYS.OPENROUTER, value);
                await readSecretState(); // Refresh state to get masked value
                toastr.success('OpenRouter API key saved');
                $(this).val(''); // Clear input
                updateOpenRouterKeyDisplay(); // Show masked key in placeholder
            }
        });

    // Rate Limiting
    $('#vecthare_rate_limit_calls')
        .val(settings.rate_limit_calls || 0)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.rate_limit_calls = isNaN(value) ? 0 : value;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_rate_limit_interval')
        .val(settings.rate_limit_interval || 60)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.rate_limit_interval = isNaN(value) ? 60 : value;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // VEC-6: Insert Batch Size
    $('#vecthare_insert_batch_size')
        .val(settings.insert_batch_size || 50)
        .on('input', function() {
            const value = parseInt($(this).val());
            $('#vecthare_insert_batch_size_value').text(value);
            settings.insert_batch_size = value;
            settings.insert_batch_size_set = true; // see getSyncBatchSize
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });
    $('#vecthare_insert_batch_size_value').text(settings.insert_batch_size || 50);

    // Minimum chat length before injection starts
    $('#vecthare_min_chat_length')
        .val(settings.min_chat_length ?? 0)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.min_chat_length = isNaN(value) ? 0 : Math.max(0, value);
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // VH-019: retrieval deadline
    $('#vecthare_rag_timeout_seconds')
        .val(settings.rag_timeout_seconds ?? 15)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.rag_timeout_seconds = isNaN(value) ? 15 : Math.min(300, Math.max(0, value));
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // Action buttons
    $('#vecthare_vectorize_content').on('click', () => {
        // The caller decides whether this chat needs a re-vectorization
        // confirmation first; without a handler, the plain setup opens.
        if (callbacks.onVectorizeContent) callbacks.onVectorizeContent();
        else openContentVectorizer();
    });
    $('#vecthare_vectorize_all').on('click', callbacks.onVectorizeAll);
    // VectHare+ R7/R10: Repair Chunks button (formerly "Continue Vectorization";
    // visibility managed by updateContinueVectorizationButton)
    if (callbacks.onContinueVectorization) {
        $('#vecthare_continue_vectorization').on('click', callbacks.onContinueVectorization);
    }
    // VectHare+ R10: status display - click opens (or revives) the progress panel
    if (callbacks.onVectorizationStatusClick) {
        $('#vecthare_vectorization_status').on('click', () => callbacks.onVectorizationStatusClick());
    }
    $('#vecthare_purge').on('click', callbacks.onPurge);
    $('#vecthare_run_diagnostics').on('click', callbacks.onRunDiagnostics);
    $('#vecthare_include_production_tests')
        .prop('checked', settings.include_production_tests || false)
        .on('change', function() {
            settings.include_production_tests = $(this).prop('checked');
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_database_browser').on('click', () => {
        openDatabaseBrowser();
    });
    $('#vecthare_view_results').on('click', () => {
        openSearchDebugModal();
    });
    $('#vecthare_text_cleaning').on('click', () => {
        openTextCleaningManager();
    });

    // Initialize provider-specific settings visibility
    toggleProviderSettings(settings.source, settings);

    // VH-074: the Cotton-Tales emotion settings had handlers but no controls in
    // any template, so they were removed. The classifier itself stays available
    // to Cotton-Tales through window.VectHareEmotionClassifier
    // (core/emotion-classifier.js); its settings are the emotion_* keys of
    // VectHare's settings.
}


// Store current diagnostic results for copy/filter functionality
let currentDiagnosticResults = null;
let currentDiagnosticFilter = 'all'; // 'all', 'pass', 'warning', 'fail'

/**
 * Shows diagnostics results in the results phase
 * @param {object} results - Diagnostics results object
 */
export function showDiagnosticsResults(results) {
    // Store results globally for copy/filter functionality
    currentDiagnosticResults = results;
    currentDiagnosticFilter = 'all';

    renderDiagnosticsContent(results, 'all');

    // Show results phase
    showDiagnosticsPhase('results');
}

/**
 * Renders diagnostic content with optional status filter
 * @param {object} results - Diagnostics results object
 * @param {string} filter - Filter: 'all', 'pass', 'warning', 'fail'
 */
function renderDiagnosticsContent(results, filter = 'all') {
    const output = $('#vecthare_diagnostics_content');
    output.empty();

    vhLog('VectHare UI: Rendering diagnostics with results:', results);

    const statusIcons = {
        'pass': '<i class="fa-solid fa-circle-check" style="color: var(--vecthare-success);"></i>',
        'warning': '<i class="fa-solid fa-triangle-exclamation" style="color: var(--vecthare-warning);"></i>',
        'fail': '<i class="fa-solid fa-circle-xmark" style="color: var(--vecthare-danger);"></i>',
        'skipped': '<i class="fa-solid fa-circle-minus" style="color: var(--grey70);"></i>'
    };

    const categoryTitles = {
        infrastructure: '<i class="fa-solid fa-server"></i> Infrastructure',
        configuration: '<i class="fa-solid fa-sliders"></i> Configuration',
        visualizer: '<i class="fa-solid fa-eye"></i> Visualizer',
        production: '<i class="fa-solid fa-vial"></i> Production Tests',
        console: '<i class="fa-solid fa-terminal"></i> Console Logs'
    };

    // Count stats
    const passCount = results.checks.filter(c => c.status === 'pass').length;
    const warnCount = results.checks.filter(c => c.status === 'warning').length;
    const failCount = results.checks.filter(c => c.status === 'fail').length;
    // VH-070: only actions that exist get a button; only real fixes count for Fix All.
    const fixableCount = results.checks.filter(c => c.fixable && fixKind(c.fixAction) === 'fix' &&
        (c.status === 'fail' || c.status === 'warning')).length;

    // Filter checks if needed
    const filterCheck = (check) => {
        if (filter === 'all') return true;
        return check.status === filter;
    };

    const renderChecks = (checks) => {
        const filteredChecks = checks.filter(filterCheck);
        if (filteredChecks.length === 0) {
            return '<div class="diagnostic-item-empty">No items match current filter</div>';
        }
        return filteredChecks.map(check => `
            <div class="diagnostic-item ${escapeHtml(check.status)}" data-fix-action="${escapeHtml(check.fixAction || '')}" data-status="${escapeHtml(check.status)}">
                <div class="diagnostic-main">
                    <span class="diagnostic-icon">${statusIcons[check.status] || ""}</span>
                    <span class="diagnostic-label">${escapeHtml(check.name)}</span>
                    <span class="diagnostic-message">${check.message}</span>
                </div>
                ${check.fixable && fixKind(check.fixAction) ? `
                    <button class="diagnostic-fix-btn" data-fix-action="${escapeHtml(check.fixAction)}" data-check-name="${escapeHtml(check.name)}">
                        <i class="fa-solid ${fixKind(check.fixAction) === 'fix' ? 'fa-wrench' : 'fa-arrow-right'}"></i>
                        ${fixKind(check.fixAction) === 'fix' ? 'Fix' : 'Show me'}
                    </button>
                ` : ''}
            </div>
        `).join('');
    };

    const html = `
        <!-- Version Info -->
        <div class="vecthare-diagnostics-version" style="padding: 10px 15px; background: var(--black30alpha); border-radius: 8px; margin-bottom: 15px; font-size: 0.9em; color: var(--grey70);">
            ${versionInfoHtml(results.version?.compatibility || { state: 'unknown', extensionVersion: results.version?.extension, pluginVersion: results.version?.plugin }, results.version?.server || null, results.version?.sillytavern || null)}
        </div>

        <!-- Summary Stats Bar (Clickable Filters) -->
        <div class="vecthare-diagnostics-stats">
            <div class="vecthare-diag-stat pass ${filter === 'pass' ? 'active' : ''}" data-filter="pass" title="Click to filter by passed">
                ${statusIcons.pass}
                <span class="vecthare-diag-stat-count">${passCount}</span>
                <span class="vecthare-diag-stat-label">Passed</span>
            </div>
            <div class="vecthare-diag-stat warning ${filter === 'warning' ? 'active' : ''}" data-filter="warning" title="Click to filter by warnings">
                ${statusIcons.warning}
                <span class="vecthare-diag-stat-count">${warnCount}</span>
                <span class="vecthare-diag-stat-label">Warnings</span>
            </div>
            <div class="vecthare-diag-stat fail ${filter === 'fail' ? 'active' : ''}" data-filter="fail" title="Click to filter by failed">
                ${statusIcons.fail}
                <span class="vecthare-diag-stat-count">${failCount}</span>
                <span class="vecthare-diag-stat-label">Failed</span>
            </div>
        </div>

        ${filter !== 'all' ? `
            <div class="vecthare-diag-filter-notice">
                <span>Showing only: <strong>${escapeHtml(filter)}</strong></span>
                <button class="vecthare-diag-clear-filter" data-filter="all">
                    <i class="fa-solid fa-times"></i> Show All
                </button>
            </div>
        ` : ''}

        ${Object.entries(results.categories).map(([category, checks]) => {
            if (checks.length === 0) return '';

            // Category-level stats
            const catPass = checks.filter(c => c.status === 'pass').length;
            const catWarn = checks.filter(c => c.status === 'warning').length;
            const catFail = checks.filter(c => c.status === 'fail').length;
            const catTotal = checks.length;
            const filteredCount = checks.filter(filterCheck).length;

            // Don't show category if all items filtered out
            if (filter !== 'all' && filteredCount === 0) return '';

            return `
                <div class="diagnostic-category" data-category="${escapeHtml(category)}">
                    <div class="diagnostic-category-header" data-collapsed="false">
                        <h4 class="diagnostic-category-title">
                            <span class="diagnostic-category-collapse-icon">
                                <i class="fa-solid fa-chevron-down"></i>
                            </span>
                            ${categoryTitles[category] || `<i class="fa-solid fa-folder"></i> ${escapeHtml(category)}`}
                        </h4>
                        <div class="diagnostic-category-stats">
                            <span class="diag-cat-stat pass" title="Passed">${escapeHtml(catPass)}</span>
                            <span class="diag-cat-stat warning" title="Warnings">${escapeHtml(catWarn)}</span>
                            <span class="diag-cat-stat fail" title="Failed">${escapeHtml(catFail)}</span>
                        </div>
                    </div>
                    <div class="diagnostic-category-content">
                        <div class="vecthare-diagnostics">
                            ${renderChecks(checks)}
                        </div>
                    </div>
                </div>
            `;
        }).join('')}
    `;

    output.html(html);

    // Update title based on results
    const titleText = results.overall === 'healthy'
        ? 'All Checks Passed!'
        : results.overall === 'warnings'
            ? 'Completed with Warnings'
            : 'Issues Found';
    $('#vecthare_diagnostics_title').text(titleText);

    // Show/hide Fix All button based on fixable issues
    if (fixableCount > 0) {
        $('#vecthare_diag_fix_all')
            .show()
            .html(`<i class="fa-solid fa-wand-magic-sparkles"></i> Fix All (${fixableCount})`)
            .off('click')
            .on('click', function() {
                void handleFixAll(results.checks);
            });
    } else {
        $('#vecthare_diag_fix_all').hide();
    }

    // Bind filter click handlers on stat boxes
    $('.vecthare-diag-stat').off('click').on('click', function() {
        const clickedFilter = $(this).data('filter');
        // Toggle: if already active, show all; otherwise apply filter
        if (currentDiagnosticFilter === clickedFilter) {
            currentDiagnosticFilter = 'all';
        } else {
            currentDiagnosticFilter = clickedFilter;
        }
        renderDiagnosticsContent(currentDiagnosticResults, currentDiagnosticFilter);
    });

    // Bind clear filter button
    $('.vecthare-diag-clear-filter').off('click').on('click', function() {
        currentDiagnosticFilter = 'all';
        renderDiagnosticsContent(currentDiagnosticResults, 'all');
    });

    // Bind category collapse handlers
    $('.diagnostic-category-header').off('click').on('click', function() {
        const $header = $(this);
        const $content = $header.next('.diagnostic-category-content');
        const isCollapsed = $header.attr('data-collapsed') === 'true';

        if (isCollapsed) {
            $content.slideDown(200);
            $header.attr('data-collapsed', 'false');
            $header.find('.diagnostic-category-collapse-icon i').removeClass('fa-chevron-right').addClass('fa-chevron-down');
        } else {
            $content.slideUp(200);
            $header.attr('data-collapsed', 'true');
            $header.find('.diagnostic-category-collapse-icon i').removeClass('fa-chevron-down').addClass('fa-chevron-right');
        }
    });

    // Bind individual fix button click handlers
    // VH-070: a row turns green only when its fix succeeded and Diagnostics,
    // run again, no longer reports it.
    $('.diagnostic-fix-btn').off('click').on('click', async function(e) {
        e.stopPropagation();
        const $button = $(this);
        const action = $button.data('fix-action');
        const check = (currentDiagnosticResults?.checks || []).find(c =>
            c.fixAction === action && c.name === $button.data('check-name')) || { fixAction: action, fixable: true };
        $button.prop('disabled', true);
        const result = await handleDiagnosticFix(check);
        $button.prop('disabled', false);
        if (result.kind === 'fix' && result.success) await rerunDiagnosticsAfterFix();
    });

    // Bind copy button
    $('#vecthare_diag_copy').off('click').on('click', function() {
        copyDiagnosticsReport(currentDiagnosticResults);
    });
}

/**
 * Generates and copies a nicely formatted diagnostics report
 * Respects the current filter selection
 * @param {object} results - Diagnostics results object
 */
function copyDiagnosticsReport(results) {
    if (!results) {
        toastr.warning('No diagnostic results to copy');
        return;
    }

    const filter = currentDiagnosticFilter;
    const isFiltered = filter !== 'all';

    // Filter checks if a specific filter is active
    const filterCheck = (check) => {
        if (!isFiltered) return true;
        return check.status === filter;
    };

    const timestamp = new Date(results.timestamp).toLocaleString();

    // Total counts (always show these for context)
    const totalPass = results.checks.filter(c => c.status === 'pass').length;
    const totalWarn = results.checks.filter(c => c.status === 'warning').length;
    const totalFail = results.checks.filter(c => c.status === 'fail').length;
    const totalCount = totalPass + totalWarn + totalFail;

    // Filtered counts
    const filteredChecks = results.checks.filter(filterCheck);
    const filteredCount = filteredChecks.length;

    const statusSymbols = {
        'pass': '✓',
        'warning': '⚠',
        'fail': '✗',
        'skipped': '○'
    };

    const filterNames = {
        'pass': 'PASSED ONLY',
        'warning': 'WARNINGS ONLY',
        'fail': 'FAILURES ONLY'
    };

    // Get current settings for the report
    const settings = extension_settings.vecthare;
    const backend = settings.vector_backend || 'standard';
    const source = settings.source || 'none';
    const modelField = getModelField(source);
    const model = modelField ? (settings[modelField] || 'not set') : 'n/a (provider handles it)';
    // VH-115: these read settings that do not exist (qdrant_mode,
    // qdrant_cloud_url), so the report always said "local" with the local
    // address; and local providers showed a made-up default address.
    const qdrantMode = settings.qdrant_use_cloud ? 'cloud' : 'local';
    const qdrantUrl = backend === 'qdrant'
        ? (settings.qdrant_use_cloud ? (settings.qdrant_url || 'not set')
            : `${settings.qdrant_host || 'localhost'}:${settings.qdrant_port || 6333}`)
        : null;

    // Provider URL: the address real embedding uses
    let providerUrl = 'n/a';
    try {
        const params = getProviderSpecificParams(settings);
        providerUrl = params.apiUrl || params.extrasUrl || 'n/a';
    } catch { /* n/a */ }

    // VH-115: auto-sync is per chat (the old global switch is not used)
    let chatReportLine = 'no chat open';
    try {
        const chatCollectionId = getChatCollectionId();
        const key = chatCollectionId ? getCollectionRegistry().find(k => k === chatCollectionId || k.endsWith(`:${chatCollectionId}`)) : null;
        chatReportLine = !chatCollectionId ? 'no chat open'
            : !key ? 'not vectorized'
            : `vectorized, ${isCollectionEnabled(key) ? 'enabled' : 'disabled'}, auto-sync ${isCollectionAutoSyncEnabled(key) ? 'on' : 'off'}`;
    } catch { /* unknown */ }

    let report = `╔══════════════════════════════════════════════════════════════╗
║              VECTHARE DIAGNOSTICS REPORT                      ║
╚══════════════════════════════════════════════════════════════╝

📅 Generated: ${timestamp}
📦 Extension Version: ${results.version?.extension || 'Unknown'}
🔌 Plugin Version: ${results.version?.plugin || 'Not installed'}
${isFiltered ? `🔍 Filter: ${filterNames[filter]} (${filteredCount} of ${totalCount} checks)\n` : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                      CURRENT SETTINGS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Backend:           ${backend}${backend === 'qdrant' ? ` (${qdrantMode})` : ''}
  Embedding Source:  ${source}
  Model:             ${model}${providerUrl !== 'n/a' ? `\n  Provider URL:      ${providerUrl}` : ''}${qdrantUrl ? `\n  Qdrant URL:        ${qdrantUrl}` : ''}
  Score Threshold:   ${settings.score_threshold || 0.5}
  Query Depth:       ${settings.query || 3}
  This Chat:         ${chatReportLine}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                         SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ✓ Passed:   ${String(totalPass).padStart(3)}${filter === 'pass' ? ' ◀ showing' : ''}
  ⚠ Warnings: ${String(totalWarn).padStart(3)}${filter === 'warning' ? ' ◀ showing' : ''}
  ✗ Failed:   ${String(totalFail).padStart(3)}${filter === 'fail' ? ' ◀ showing' : ''}
  ─────────────────
  Total:      ${String(totalCount).padStart(3)}

`;

    const categoryNames = {
        infrastructure: '🔧 INFRASTRUCTURE',
        configuration: '⚙️  CONFIGURATION',
        visualizer: '👁️  VISUALIZER',
        production: '🧪 PRODUCTION TESTS',
        console: '💻 CONSOLE LOGS'
    };

    for (const [category, checks] of Object.entries(results.categories)) {
        // Filter checks for this category
        const filteredCatChecks = checks.filter(filterCheck);
        if (filteredCatChecks.length === 0) continue;

        // Show filtered counts vs total for this category
        const catTotal = checks.length;
        const catFiltered = filteredCatChecks.length;
        const catStats = isFiltered
            ? `(${catFiltered} of ${catTotal})`
            : `(✓${checks.filter(c => c.status === 'pass').length} ⚠${checks.filter(c => c.status === 'warning').length} ✗${checks.filter(c => c.status === 'fail').length})`;

        report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${categoryNames[category] || category.toUpperCase()}  ${catStats}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

`;

        for (const check of filteredCatChecks) {
            const symbol = statusSymbols[check.status] || '?';
            const name = check.name.padEnd(28);
            report += `  ${symbol} ${name} ${check.message}\n`;
        }

        report += '\n';
    }

    // Add console errors if present (only when showing all or failures)
    if (results.consoleErrors && results.consoleErrors.length > 0 && (!isFiltered || filter === 'fail')) {
        report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💻 CONSOLE ERRORS CAPTURED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

`;
        for (const error of results.consoleErrors) {
            report += `  [${error.type.toUpperCase()}] ${error.message}\n`;
            if (error.stack) {
                report += `           ${error.stack.split('\n')[0]}\n`;
            }
        }
        report += '\n';
    }

    report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                      END OF REPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

    // Copy to clipboard
    const filterMsg = isFiltered ? ` (${filterNames[filter]})` : '';
    navigator.clipboard.writeText(report).then(() => {
        toastr.success(`Diagnostics report${filterMsg} copied to clipboard`, 'VectHare');
    }).catch(err => {
        console.error('Failed to copy:', err);
        toastr.error('Failed to copy report');
    });
}

/**
 * Opens the diagnostics modal (starts at selection phase)
 */
export function openDiagnosticsModal() {
    showDiagnosticsPhase('selection');
    $('#vecthare_diagnostics_title').text('Run Diagnostics');
    $('#vecthare_diag_production').prop('checked', !!extension_settings.vecthare?.include_production_tests);
    $('#vecthare_diagnostics_modal').fadeIn(200);
}

/**
 * VH-070: what a Diagnostics action does. 'fix' changes something and is
 * confirmed by running Diagnostics again; 'guide' takes the user to the place
 * (or dialog) where they fix it themselves. Anything else gets no button.
 */
const DIAGNOSTIC_FIXES = {
    enable_chats: 'fix', fix_threshold: 'fix', fix_counts: 'fix',
    cleanOrphanedMetadata: 'fix', cleanOrphanedGroupMembers: 'fix',
    vectorize_all: 'guide', revectorize: 'guide', configure_provider: 'guide', configure_url: 'guide',
    configure_api_key: 'guide', configure_qdrant: 'guide', install_lancedb: 'guide',
    install_webllm: 'guide', update_webllm: 'guide', fix_qdrant_dimension: 'guide',
};
function fixKind(action) { return DIAGNOSTIC_FIXES[action] || null; }

/** Runs Diagnostics again with the options of the last run and shows the result. */
async function rerunDiagnosticsAfterFix() {
    try { await executeDiagnostics(); } catch (error) { console.warn('VectHare: Diagnostics re-run failed:', error); }
}

/**
 * Handles fixing all fixable issues (real fixes only, one after another),
 * then runs Diagnostics again so the result shows what is really fixed.
 * @param {Array} checks - Array of diagnostic checks
 */
async function handleFixAll(checks) {
    const fixableChecks = checks.filter(c => c.fixable && fixKind(c.fixAction) === 'fix' &&
        (c.status === 'fail' || c.status === 'warning'));
    if (fixableChecks.length === 0) {
        toastr.info('No fixable issues found');
        return;
    }
    $('#vecthare_diag_fix_all').prop('disabled', true);
    let succeeded = 0;
    const failed = [];
    for (const check of fixableChecks) {
        const result = await handleDiagnosticFix(check, true);
        if (result.success) succeeded++;
        else failed.push(`${check.name}: ${result.message || 'not fixed'}`);
    }
    $('#vecthare_diag_fix_all').prop('disabled', false);
    if (failed.length) {
        toastr.warning(`${succeeded} of ${fixableChecks.length} fix(es) ran; not fixed: ${failed.join('; ')}`, 'VectHare Diagnostics', { timeOut: 12000 });
    } else {
        toastr.success(`${succeeded} fix(es) ran; checking again…`, 'VectHare Diagnostics');
    }
    await rerunDiagnosticsAfterFix();
}

/**
 * Handles one diagnostic action.
 * @param {object} check - the check (fixAction, data)
 * @param {boolean} silent - suppress toasts (Fix All)
 * @returns {Promise<{success: boolean, kind: string|null, message?: string}>}
 */
async function handleDiagnosticFix(check, silent = false) {
    const settings = extension_settings.vecthare;
    const action = typeof check === 'string' ? check : check?.fixAction;
    const kind = fixKind(action);
    const done = (success, message, level = success ? 'success' : 'warning') => {
        if (!silent && message) toastr[level](message, 'VectHare Diagnostics');
        return { success, kind, message };
    };
    const showSetting = (selector, message) => {
        closeDiagnosticsModal();
        $(selector)[0]?.scrollIntoView?.({ behavior: 'smooth' });
        return done(false, message, 'info');
    };
    try {
        switch (action) {
            case 'enable_chats':
                $('#vecthare_autosync_enabled').prop('checked', true).trigger('change');
                return done(true, 'Chat auto-sync enabled');
            case 'fix_threshold':
                $('#vecthare_score_threshold').val(0.25).trigger('change');
                return done(true, 'Score threshold reset to 0.25');
            case 'fix_counts':
                // Only Top K has a control in the panel.
                if ((settings.top_k ?? settings.insert) < 1) $('#vecthare_topk').val(3).trigger('change');
                return done(true, 'Top K set to 3');
            case 'cleanOrphanedMetadata':
            case 'cleanOrphanedGroupMembers': {
                const { executeFixAction } = await import('../diagnostics/index.js');
                const result = await executeFixAction({ ...check, fixable: true });
                return done(!!result?.success, result?.message || (result?.success ? 'Fixed' : 'Not fixed'));
            }
            case 'install_webllm':
            case 'update_webllm': {
                const { executeFixAction } = await import('../diagnostics/index.js');
                const result = await executeFixAction({ ...check, fixable: true });
                return done(false, result?.message, 'info');
            }
            case 'vectorize_all':
            case 'revectorize':
                closeDiagnosticsModal();
                $('#vecthare_vectorize_all').trigger('click');
                return done(false, null);
            case 'configure_provider':
                return showSetting('#vecthare_provider_settings', 'Select an embedding provider here');
            case 'configure_url':
                return showSetting('#vecthare_provider_settings', 'Set the API URL in the provider settings');
            case 'configure_api_key':
                return done(false, 'Add the API key in SillyTavern: Settings > API Connections', 'info');
            case 'configure_qdrant':
                return showSetting($('#vecthare_qdrant_settings').is(':visible') ? '#vecthare_qdrant_settings' : '#vecthare_vector_backend',
                    'Set the Qdrant address here (local default: localhost:6333)');
            case 'install_lancedb':
                return done(false, 'LanceDB needs the Similharity plugin with its dependencies installed (npm install in its folder), then restart SillyTavern. Or choose another backend.', 'info');
            case 'fix_qdrant_dimension':
                if (!silent) showQdrantDimensionFixDialog();
                return done(false, null);
            default:
                return done(false, `No fix is available for "${action}"`);
        }
    } catch (error) {
        console.warn(`VectHare: fix ${action} failed:`, error);
        return done(false, `Fix failed: ${error.message}`, 'error');
    }
}

/**
 * Shows a dialog with options to fix Qdrant dimension mismatch
 */
async function showQdrantDimensionFixDialog() {
    // Get the check data from the current diagnostics results
    const check = currentDiagnosticResults?.checks?.find(c => c.fixAction === 'fix_qdrant_dimension');
    const data = check?.data || {};

    const collectionDim = data.collectionDimension || '?';
    const currentDim = data.currentDimension || '?';
    const sources = data.collectionSources?.join(', ') || 'unknown';
    const models = data.collectionModels?.length > 0 ? data.collectionModels.join(', ') : '(not recorded)';
    const pointsCount = data.pointsCount || 0;

    const dialogHtml = `
        <div class="vecthare-dimension-fix-dialog">
            <h3 style="margin-top: 0; color: var(--vecthare-danger);">
                <i class="fa-solid fa-triangle-exclamation"></i> Vector Dimension Mismatch
            </h3>

            <div class="vecthare-dimension-info" style="background: var(--SmartThemeBlurTintColor); padding: 12px; border-radius: 8px; margin-bottom: 16px;">
                <p style="margin: 0 0 8px 0;"><strong>Your Qdrant collection:</strong></p>
                <ul style="margin: 0; padding-left: 20px;">
                    <li><strong>${collectionDim}</strong> dimensions</li>
                    <li>Source: <strong>${escapeHtml(sources)}</strong></li>
                    <li>Model: <strong>${escapeHtml(models)}</strong></li>
                    <li><strong>${pointsCount.toLocaleString()}</strong> vectors stored</li>
                </ul>

                <p style="margin: 12px 0 8px 0;"><strong>Your current embedding model:</strong></p>
                <ul style="margin: 0; padding-left: 20px;">
                    <li><strong>${currentDim}</strong> dimensions</li>
                </ul>
            </div>

            <p style="margin-bottom: 16px;">These dimensions don't match. You have two options:</p>

            <div class="vecthare-dimension-options" style="display: flex; flex-direction: column; gap: 12px;">
                <button id="vecthare_dim_fix_purge" class="vecthare-btn-danger" style="padding: 12px; text-align: left;">
                    <i class="fa-solid fa-trash"></i>
                    <strong>Start fresh</strong>
                    <br><small style="opacity: 0.8;">How to remove the affected collections (${pointsCount.toLocaleString()} vectors) and re-vectorize with your current model</small>
                </button>

                <button id="vecthare_dim_fix_switch" class="vecthare-btn-secondary" style="padding: 12px; text-align: left;">
                    <i class="fa-solid fa-rotate-left"></i>
                    <strong>I'll switch my embedding model back</strong>
                    <br><small style="opacity: 0.8;">Keep your vectors; change your embedding settings to match (${escapeHtml(sources)}${escapeHtml(models !== '(not recorded)' ? ': ' + models : '')})</small>
                </button>

                <button id="vecthare_dim_fix_cancel" class="vecthare-btn-secondary" style="padding: 12px; text-align: left;">
                    <i class="fa-solid fa-clock"></i>
                    <strong>Hold off for now</strong>
                    <br><small style="opacity: 0.8;">I'll figure it out later</small>
                </button>
            </div>
        </div>
    `;

    // Use callGenericPopup for the dialog
    const { callGenericPopup, POPUP_TYPE } = await import('../../../../popup.js');

    callGenericPopup(dialogHtml, POPUP_TYPE.TEXT, '', {
        okButton: false,
        cancelButton: false,
        wide: false,
        allowVerticalScrolling: true,
    });

    // Bind button handlers
    $('#vecthare_dim_fix_purge').off('click').on('click', () => {
        // H2: VectHare never drops a shared Qdrant store. This button used to
        // call a plugin route that does not exist (so it always failed); it now
        // says how to start fresh safely instead.
        $('.popup-button-close').click();
        toastr.info('To start fresh: delete the affected collections in the Database Browser (or use Purge All), then re-vectorize. VectHare never deletes a shared store directly.',
            'VectHare', { timeOut: 12000 });
        closeDiagnosticsModal();
    });

    $('#vecthare_dim_fix_switch').off('click').on('click', () => {
        $('.popup-button-close').click();
        toastr.info(`Switch your embedding provider to "${sources}"${models !== '(not recorded)' ? ` with model "${models}"` : ''} to match your stored vectors.`);
        closeDiagnosticsModal();
        // Scroll to provider settings
        $('#vecthare_provider_settings')[0]?.scrollIntoView({ behavior: 'smooth' });
    });

    $('#vecthare_dim_fix_cancel').off('click').on('click', () => {
        $('.popup-button-close').click();
    });
}

/**
 * Hides diagnostics output
 */
export function hideDiagnosticsResults() {
    $('#vecthare_diagnostics_output').hide();
}
