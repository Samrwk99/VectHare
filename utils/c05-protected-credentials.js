/**
 * C05: Write-only, fail-closed credentials interface.
 *
 * This is deliberately NOT a browser vault. A future Similharity server plugin
 * must resolve secrets using its user-scoped server-side store. The pinned
 * unmodified plugin has no resolver/capability route, so authenticated features
 * must remain unavailable. No method reads a secret value from the server.
 */
import { redactSecrets } from './security.js';

export const C05_SECRETS = Object.freeze({
    qdrant_api_key: 'vecthare_qdrant_api_key',
    milvus_password: 'vecthare_milvus_password',
    milvus_token: 'vecthare_milvus_token',
    bananabread_api_key: 'bananabread_api_key',
});
export const C05_SECRET_FIELDS = Object.freeze(Object.keys(C05_SECRETS));
export const C05_CONTRACT = 'vecthare-user-scoped-secrets-v1';

export class ProtectedCredentialUnavailable extends Error {
    constructor() {
        super('Secure credentials require a compatible server-side Similharity secret resolver. Authenticated operations are disabled; no plaintext fallback is permitted.');
        this.name = 'ProtectedCredentialUnavailable';
    }
}

/** Refuse credentials embedded in configurable endpoint URLs. These would
 * otherwise bypass protected storage and leak into ordinary settings. */
export function credentialBearingUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return false;
    try {
        const url = new URL(value);
        if (url.username || url.password) return true;
        for (const [key] of url.searchParams) {
            if (/(?:api[_-]?key|token|password|passwd|secret|authorization|credential|access[_-]?key)/i.test(key)) return true;
        }
    } catch {
        // Do not attempt to authenticate from non-URL local addresses here.
        return /(?:^[a-z][a-z0-9+.-]*:\/\/[^\s]+@|[?&](?:api[_-]?key|token|password|secret)=)/i.test(value);
    }
    return false;
}

export function assertNoCredentialsInUrl(value) {
    if (credentialBearingUrl(value)) throw new ProtectedCredentialUnavailable();
}

/** Preserve legacy values until verified authenticated migration; never export them. */
export function legacyCredentialFields(settings = {}) {
    return C05_SECRET_FIELDS.filter(field => typeof settings?.[field] === 'string' && settings[field].length > 0);
}

export function scrubCredentialSettings(snapshot = {}) {
    // Clone no secrets into ordinary settings; do not mutate the source.
    const result = { ...snapshot };
    for (const field of C05_SECRET_FIELDS) delete result[field];
    return result;
}

function acceptedAck(text) {
    if (text.trim() === 'ok') return true;
    try { return JSON.parse(text)?.success === true; } catch { return false; }
}

async function confirmedWrite(fetchImpl, getHeaders, key, value) {
    const response = await fetchImpl('/api/secrets/write', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ key, value }),
    });
    if (!response?.ok || !acceptedAck(await response.text())) throw new ProtectedCredentialUnavailable();
}

/**
 * Only accept an explicit per-user capability contract. HTTP 200, the old
 * /backend/health route, or an ordinary plugin version are not sufficient.
 */
export async function verifyServerSecretContract(fetchImpl, getHeaders) {
    try {
        const response = await fetchImpl('/api/plugins/similharity/capabilities/secrets', {
            headers: getHeaders(), cache: 'no-store',
        });
        if (!response?.ok) return { verified: false, reason: 'resolver-unavailable' };
        const data = await response.json();
        if (data?.protocol !== C05_CONTRACT || data?.userScope !== 'request-user'
            || data?.writeOnlyBrowser !== true || data?.serverSideResolution !== true
            || data?.authenticatedProbe !== true
            || !C05_SECRET_FIELDS.every(field => data?.supportedKeys?.includes(C05_SECRETS[field]))) {
            return { verified: false, reason: 'resolver-contract-unverified' };
        }
        return { verified: true, protocol: C05_CONTRACT };
    } catch {
        return { verified: false, reason: 'resolver-unavailable' };
    }
}

export function createWriteOnlySecretAdapter({ fetchImpl, getHeaders, authenticatedProbe, persistSettings }) {
    if (typeof fetchImpl !== 'function' || typeof getHeaders !== 'function') throw new TypeError('Server transport required');
    const requireField = (field) => {
        if (!Object.hasOwn(C05_SECRETS, field)) throw new TypeError('Unknown protected credential key');
        return C05_SECRETS[field];
    };
    const requireContract = async () => {
        if (!(await verifyServerSecretContract(fetchImpl, getHeaders)).verified) throw new ProtectedCredentialUnavailable();
    };
    const verifyAuthenticated = async field => {
        // The proof is performed server-side, with the user-scoped stored key.
        // No key value goes back to or through this browser route.
        if (typeof authenticatedProbe === 'function') {
            if (await authenticatedProbe(field) !== true) throw new ProtectedCredentialUnavailable();
            return;
        }
        const response = await fetchImpl('/api/plugins/similharity/capabilities/secrets/test', {
            method: 'POST', headers: getHeaders(),
            body: JSON.stringify({ key: C05_SECRETS[field] }),
        });
        if (!response?.ok) throw new ProtectedCredentialUnavailable();
        const receipt = await response.json();
        if (receipt?.protocol !== C05_CONTRACT || receipt?.userScope !== 'request-user'
            || receipt?.key !== C05_SECRETS[field] || receipt?.authenticated !== true) {
            throw new ProtectedCredentialUnavailable();
        }
    };
    return Object.freeze({
        async hasSecret(field) {
            const key = requireField(field);
            await requireContract();
            const response = await fetchImpl('/api/secrets/read', { method: 'POST', headers: getHeaders(), cache: 'no-store' });
            if (!response?.ok) throw new ProtectedCredentialUnavailable();
            const state = await response.json();
            // ST may omit custom keys; omission means UNKNOWN, not absence.
            if (!Object.hasOwn(state ?? {}, key) || typeof state[key] !== 'boolean') throw new ProtectedCredentialUnavailable();
            return state[key];
        },
        async setSecret(field, value) {
            const key = requireField(field);
            if (typeof value !== 'string' || !value.trim()) throw new TypeError('Nonempty credential required');
            await requireContract();
            await confirmedWrite(fetchImpl, getHeaders, key, value);
            await verifyAuthenticated(field);
            return { confirmed: true };
        },
        async deleteSecret(field) {
            const key = requireField(field);
            await requireContract();
            await confirmedWrite(fetchImpl, getHeaders, key, '');
            // A rejected or ambiguous state is not proof that the secret was removed.
            const state = await fetchImpl('/api/secrets/read', { method: 'POST', headers: getHeaders(), cache: 'no-store' });
            if (!state?.ok || (await state.json())?.[key] !== false) throw new ProtectedCredentialUnavailable();
            return { confirmed: true };
        },
        async migrateLegacySecret(field, settings) {
            requireField(field);
            const value = settings?.[field];
            if (typeof value !== 'string' || !value) return { status: 'not-needed' };
            try {
                await requireContract();
                if (typeof persistSettings !== 'function') throw new ProtectedCredentialUnavailable();
                await confirmedWrite(fetchImpl, getHeaders, C05_SECRETS[field], value);
                // Must prove the protected secret authenticated, NOT just that it was saved.
                await verifyAuthenticated(field);
                const updated = scrubCredentialSettings(settings);
                // The host must explicitly acknowledge a durable save. A debounce isn't proof.
                if (await persistSettings(updated) !== true) throw new ProtectedCredentialUnavailable();
                delete settings[field];
                return { status: 'confirmed' };
            } catch {
                return { status: 'blocked', reason: 'migration-not-verified' };
            }
        },
        redact: redactSecrets,
    });
}

/** Called before any cached backend is returned. Legacy plaintext is not a
 * supported credential source, even if a previously cached connection exists. */
export function assertNoLegacyCredentialFallback(settings = {}, backend = settings?.vector_backend) {
    if (settings?.source === 'bananabread') throw new ProtectedCredentialUnavailable();
    if (backend === 'qdrant' && settings?.qdrant_use_cloud && settings?.qdrant_api_key) throw new ProtectedCredentialUnavailable();
    if (backend === 'milvus' && (settings?.milvus_password || settings?.milvus_token)) throw new ProtectedCredentialUnavailable();
}

/** Block authenticated usage even when the caller forgets to include a legacy value. */
export function requireServerCredentialResolution() {
    throw new ProtectedCredentialUnavailable();
}
