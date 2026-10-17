import { saveVectHareSettingsDebounced as saveSettingsDebounced } from './settings-durability.js';
/**
 * Fail-closed guard for the physical Qdrant destination behind a logical key.
 * A backend/source/name is NOT enough to identify a collection on a remote server.
 * No keys, credentials or authentication query parameters are recorded here.
 */
import { extension_settings } from '../../../../extensions.js';

import { parseRegistryKey } from './collection-ids.js';

function state() {
    extension_settings.vecthare ||= {};
    return extension_settings.vecthare;
}

export function qdrantDestination(settings) {
    if ((settings?.vector_backend || 'standard') !== 'qdrant') return null;
    let origin;
    if (settings.qdrant_use_cloud) {
        if (!settings.qdrant_url) throw new Error('Qdrant URL is not configured');
        const url = new URL(settings.qdrant_url);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid Qdrant URL protocol');
        // Ignore credentials, hash fragments, search params, and trailing slashes.
        origin = `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
    } else {
        const host = String(settings.qdrant_host || 'localhost').toLowerCase().replace(/\/+$/, '');
        origin = `http://${host}:${Number(settings.qdrant_port || 6333)}`;
    }
    return `qdrant:v1:${origin}:multitenancy=${settings.qdrant_multitenancy === true}`;
}

export function qdrantKey(collectionId, settings) {
    const parsed = parseRegistryKey(collectionId);
    if (parsed.backend && parsed.backend !== 'qdrant') throw new Error('Wrong backend for Qdrant collection');
    return `qdrant:${parsed.source || settings.source || 'transformers'}:${parsed.collectionId}`;
}

function map() {
    const values = state();
    values.qdrantPhysicalIdentities ||= {};
    return values.qdrantPhysicalIdentities;
}

/** Reads do not bind a legacy collection to whichever server happens to be selected. */
export function assertQdrantIdentity(collectionId, settings, {allowNew = false} = {}) {
    const key = qdrantKey(collectionId, settings);
    const actual = qdrantDestination(settings);
    const expected = map()[key];
    if (expected && expected !== actual) {
        throw new Error(`Collection ${key} belongs to a DIFFERENT Qdrant server or tenancy mode. Switch back to its original server or explicitly migrate it. No operation performed.`);
    }
    if (!expected) {
        const values = state();
        const alreadyKnown = Object.hasOwn(values.collections || {}, key) ||
            (values.vecthare_collection_registry || []).includes(key) ||
            Object.values(values.chatCollectionBindings || {}).some(item => item?.registryKey === key);
        if (alreadyKnown || !allowNew) {
            throw new Error(`Qdrant collection ${key} has no confirmed physical-server identity. Review the server and use Database Browser's explicit legacy-server confirmation. No operation performed.`);
        }
    }
    return {key, identity: actual, newIdentity: !expected};
}

/** Claim an identity ONLY after a successful insert into a previously unknown name. */
export function claimQdrantIdentity(collectionId, settings) {
    const {key, identity} = assertQdrantIdentity(collectionId, settings, {allowNew: true});
    map()[key] = identity;
    saveSettingsDebounced();
    return key;
}

/** Explicit, one-time migration of known legacy keys; never permits reassignment. */
export function confirmLegacyQdrantServer(settings) {
    const identity = qdrantDestination(settings);
    if (!identity) throw new Error('Select a Qdrant backend first');
    const values = state();
    const keys = new Set((values.vecthare_collection_registry || []).filter(key => parseRegistryKey(key).backend === 'qdrant'));
    for (const key of Object.keys(values.collections || {})) {
        if (parseRegistryKey(key).backend === 'qdrant') keys.add(key);
    }
    for (const binding of Object.values(values.chatCollectionBindings || {})) {
        if (parseRegistryKey(binding?.registryKey).backend === 'qdrant') keys.add(binding.registryKey);
    }
    for (const key of keys) {
        if (map()[key] && map()[key] !== identity) {
            throw new Error(`Refusing to assign ${key} to another Qdrant server; existing server identity must remain intact.`);
        }
    }
    for (const key of keys) map()[key] ||= identity;
    saveSettingsDebounced();
    return keys.size;
}

export function forgetQdrantIdentity(collectionId, settings) {
    if ((settings?.vector_backend || 'standard') !== 'qdrant') return;
    const key = qdrantKey(collectionId, settings);
    assertQdrantIdentity(key, settings);
    delete map()[key];
    saveSettingsDebounced();
}
