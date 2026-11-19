/**
 * VectHare key store client (Step 7 / U1).
 *
 * Qdrant/Milvus credentials are kept by the Similharity plugin in a per-user
 * server file, not in extension_settings (settings.json, backups, screenshots).
 * The browser can only learn whether a key is set, replace it, or remove it;
 * the plugin has no route that returns a value.
 *
 * Fingerprints: collection stores remember a destination string that includes a
 * hash of the key (chatStoreDestination). Moving a key out of settings must not
 * change that string, or existing chats would look like they moved to another
 * store. So the same hash is kept in settings as `<name>_fingerprint`
 * (a change detector, not a credential) and used whenever the key itself is
 * blank.
 */

import { getRequestHeaders, saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { getStringHash } from '../../../../utils.js';
import { vhLog } from '../utils/log.js';

export const SECRET_NAMES = ['qdrant_api_key', 'milvus_token', 'milvus_password'];

const FINGERPRINT_FIELD = {
    qdrant_api_key: 'qdrant_key_fingerprint',
    milvus_token: 'milvus_token_fingerprint',
    milvus_password: 'milvus_password_fingerprint',
};

const ROUTE = '/api/plugins/similharity/secrets';

/** Last known status: { qdrant_api_key: bool, ... } or null when unknown. */
let lastStatus = null;
let migrationWarned = false;

/**
 * Hash that identifies a key without being the key. Equals the hash used before
 * the key store existed, so destinations stay identical across migration.
 * @param {object} settings
 * @param {string} name One of SECRET_NAMES
 * @returns {number}
 */
export function keyFingerprint(settings, name) {
    const plain = String(settings?.[name] || '');
    if (plain) return getStringHash(plain);
    const stored = settings?.[FINGERPRINT_FIELD[name]];
    return typeof stored === 'number' ? stored : getStringHash('');
}

/** Cached status without a request (null = never fetched or last fetch failed). */
export function getCachedSecretStatus() {
    return lastStatus;
}

/**
 * Asks the plugin which keys are set.
 * @returns {Promise<{ok: boolean, status: object|null, error?: string}>}
 */
export async function fetchSecretStatus() {
    try {
        const response = await fetch(`${ROUTE}/status`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({}),
        });
        if (!response.ok) {
            lastStatus = null;
            return { ok: false, status: null, error: `HTTP ${response.status}` };
        }
        const data = await response.json();
        lastStatus = data?.status && typeof data.status === 'object' ? data.status : null;
        return { ok: Boolean(lastStatus), status: lastStatus };
    } catch (error) {
        lastStatus = null;
        return { ok: false, status: null, error: error.message };
    }
}

/**
 * True when a key is available to the plugin (stored) or still in settings
 * (migration pending).
 */
export async function isSecretAvailable(settings, name) {
    if (settings?.[name]) return true;
    const result = await fetchSecretStatus();
    return Boolean(result.status?.[name]);
}

function applyToSettings(name, fingerprint) {
    const targets = [extension_settings.vecthare];
    for (const target of targets) {
        if (!target) continue;
        target[name] = '';
        target[FINGERPRINT_FIELD[name]] = fingerprint;
    }
}

/**
 * Stores (or, with an empty value, removes) a key in the plugin, confirms it,
 * then blanks the plaintext setting and records the fingerprint.
 * Throws on any failure and leaves settings untouched in that case.
 * @param {string} name
 * @param {string} value Empty string removes the key.
 * @param {object} [settings] Live settings object to keep in sync with extension_settings.
 */
export async function setSecret(name, value, settings) {
    if (!SECRET_NAMES.includes(name)) throw new Error(`Unknown secret: ${name}`);
    const text = String(value ?? '');
    const response = await fetch(`${ROUTE}/set`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name, value: text }),
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Key store rejected the change (HTTP ${response.status}) ${detail}`.trim());
    }
    const confirmed = await fetchSecretStatus();
    if (!confirmed.status || Boolean(confirmed.status[name]) !== Boolean(text)) {
        throw new Error('Key store did not confirm the change');
    }
    const fingerprint = getStringHash(text);
    applyToSettings(name, fingerprint);
    if (settings && settings !== extension_settings.vecthare) {
        settings[name] = '';
        settings[FINGERPRINT_FIELD[name]] = fingerprint;
    }
    saveSettingsDebounced();
}

/**
 * One-time move of keys still present in settings into the key store.
 * Each key: set -> status confirms -> blank setting. Any failure leaves that
 * key exactly where it was and warns once per session.
 * @param {object} settings
 * @returns {Promise<{migrated: string[], failed: string[]}>}
 */
export async function migrateSecretsFromSettings(settings) {
    const pending = SECRET_NAMES.filter(name =>
        String(extension_settings.vecthare?.[name] || settings?.[name] || '') !== '');
    const result = { migrated: [], failed: [] };
    for (const name of pending) {
        const value = String(extension_settings.vecthare?.[name] || settings?.[name] || '');
        try {
            await setSecret(name, value, settings);
            result.migrated.push(name);
        } catch (error) {
            console.warn(`VectHare: Could not move ${name} to the key store; it stays in settings for now:`, error.message);
            result.failed.push(name);
        }
    }
    if (result.migrated.length) {
        vhLog(`VectHare: Moved ${result.migrated.length} credential(s) out of settings into the key store`);
    }
    if (result.failed.length && !migrationWarned) {
        migrationWarned = true;
        toastr.warning(
            'VectHare could not move your Qdrant/Milvus credentials into its key store (is the Similharity plugin running and up to date?). ' +
            'They stay in settings until it works.', 'VectHare', { timeOut: 10000 });
    }
    return result;
}
