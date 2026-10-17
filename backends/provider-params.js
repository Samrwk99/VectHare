/**
 * Provider-specific parameters sent to SillyTavern vector APIs and the
 * Similharity plugin. The URL belongs to the embedding provider, not to the
 * vector storage backend (Qdrant, LanceDB, etc.).
 */

import { extension_settings } from '../../../../extensions.js';
import { textgen_types, textgenerationwebui_settings } from '../../../../textgen-settings.js';
import { oai_settings } from '../../../../openai.js';

/**
 * Build provider-specific parameters for API requests.
 * @param {object} settings - VectHare settings
 * @param {boolean} isQuery - Whether this is a query operation
 * @returns {object} Provider-specific parameters
 */
export function getProviderSpecificParams(settings, isQuery = false) {
    const params = {};
    const source = settings.source;

    switch (source) {
        case 'extras':
            params.extrasUrl = extension_settings.apiUrl;
            params.extrasKey = extension_settings.apiKey;
            break;

        case 'cohere':
            params.input_type = isQuery ? 'search_query' : 'search_document';
            break;

        case 'ollama':
            params.apiUrl = settings.use_alt_endpoint
                ? settings.alt_endpoint_url
                : textgenerationwebui_settings.server_urls[textgen_types.OLLAMA];
            params.keep = !!settings.ollama_keep;
            break;

        case 'llamacpp':
            params.apiUrl = settings.use_alt_endpoint
                ? settings.alt_endpoint_url
                : textgenerationwebui_settings.server_urls[textgen_types.LLAMACPP];
            console.debug('VectHare DEBUG llamacpp: endpoint selected (URL redacted)');
            break;

        case 'vllm':
            params.apiKey = settings.vllm_api_key || '';
            params.apiUrl = settings.use_alt_endpoint
                ? settings.alt_endpoint_url
                : textgenerationwebui_settings.server_urls[textgen_types.VLLM];
            break;

        case 'bananabread':
            params.apiUrl = settings.use_alt_endpoint
                ? settings.alt_endpoint_url
                : 'http://localhost:8008';
            // Custom BananaBread keys live in VectHare settings, not ST's
            // secret_state (which has no registered key for this provider).
            if (settings.bananabread_api_key) {
                params.apiKey = settings.bananabread_api_key;
            }
            break;

        case 'koboldcpp':
            params.apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.KOBOLDCPP];
            break;
        case 'nanogpt':
            params.apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : 'https://nano-gpt.com/api/v1';
            params.apiKey = settings.nanogpt_api_key || '';
            break;
        case 'custom':
            params.apiUrl = settings.alt_endpoint_url;
            params.apiKey = settings.custom_api_key || '';
            params.customEndpointMode = settings.custom_endpoint_mode || 'base';
            break;
        case 'openrouter':
        case 'electronhub':
            if (settings.use_alt_endpoint) {
                params.apiUrl = settings.alt_endpoint_url;
                params.apiKey = settings[`${source}_api_key_override`] || '';
            }
            break;
        case 'palm':
            params.api = 'makersuite';
            break;

        case 'vertexai':
            params.api = 'vertexai';
            params.vertexai_auth_mode = oai_settings.vertexai_auth_mode;
            params.vertexai_region = oai_settings.vertexai_region;
            params.vertexai_express_project_id = oai_settings.vertexai_express_project_id;
            break;

        default:
            break;
    }

    return params;
}

