/** The diagnostic embedding URL must be identical to the normal embedding URL.
 * Do not silently fall back to localhost:8080 when SillyTavern has another URL. */
export function diagnosticLlamaCppUrl(settings, sillyTavernUrl) {
    const selected = settings?.use_alt_endpoint ? settings?.alt_endpoint_url : sillyTavernUrl;
    if (typeof selected !== 'string' || !selected.trim()) {
        throw new Error('llama.cpp embedding URL is not configured (check SillyTavern URL or VectHare alternate endpoint)');
    }
    let parsed;
    try { parsed = new URL(selected.trim()); } catch {
        throw new Error('llama.cpp embedding URL is invalid');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
        throw new Error('llama.cpp embedding URL must be an HTTP(S) address without embedded credentials');
    }
    return selected.trim();
}
