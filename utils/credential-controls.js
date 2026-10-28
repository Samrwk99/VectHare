/**
 * Legacy compatibility wrapper, retained for callers of the old BananaBread
 * clear API. C05 never accepts the old HTTP-only revocation acknowledgement.
 * A confirmed protected-store revocation AND acknowledged settings persistence
 * are required before this can report completion.
 */
import { createWriteOnlySecretAdapter, scrubCredentialSettings, ProtectedCredentialUnavailable } from './c05-protected-credentials.js';

export async function clearBananaBreadKey(settings, fetchImpl, headers, persistSettings) {
    const adapter = createWriteOnlySecretAdapter({fetchImpl, getHeaders: () => headers});
    await adapter.deleteSecret('bananabread_api_key');
    if (typeof persistSettings !== 'function' || await persistSettings(scrubCredentialSettings(settings)) !== true) {
        // Secret may have been revoked; legacy setting must remain until
        // a durable settings update can be confirmed (no false "cleared").
        throw new ProtectedCredentialUnavailable();
    }
    delete settings.bananabread_api_key;
    return { confirmed: true };
}
