/**
 * VH-006: one reader for the plugin's /health capabilities, shared by the
 * storage resolver and leases. A successful answer is kept for the page; a
 * failed one is NOT (it is retried with a short backoff, and while the status
 * is unknown the callers refuse to write instead of assuming an old plugin).
 * A 404 means the route does not exist (no or a very old plugin) and is kept.
 */
import { vhLog } from '../utils/log.js';

export class PluginStatusUnknownError extends Error {
    constructor(message) { super(message); this.code = 'VH_PLUGIN_STATUS_UNKNOWN'; }
}

// The plugin <-> extension contract this build needs; must equal the plugin's
// PLUGIN_PROTOCOL. Raise both together only when the contract changes.
export const PLUGIN_PROTOCOL = 1;

let cached = null;
let inflight = null;
let pluginInfo = null; // { installed, version, protocol } from the last good answer
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function readPluginCapabilities() {
    if (cached) return cached;
    inflight ??= (async () => {
        let last = null;
        for (const delay of [0, 400, 1500]) {
            if (delay) await sleep(delay);
            try {
                const response = await fetch('/api/plugins/similharity/health');
                if (response.status === 404) { pluginInfo = { installed: false }; return {}; }
                if (!response.ok) { last = `HTTP ${response.status}`; continue; }
                const data = await response.json();
                pluginInfo = { installed: true, version: typeof data?.version === 'string' ? data.version : null,
                    protocol: Number.isInteger(data?.protocol) ? data.protocol : null };
                return data?.capabilities && typeof data.capabilities === 'object' ? data.capabilities : {};
            } catch (error) {
                last = error?.message || String(error);
            }
        }
        vhLog(`VectHare: plugin status check failed (${last}); will retry on the next operation`);
        throw new PluginStatusUnknownError(`The Similharity plugin did not answer its status check (${last}). ` +
            'Nothing was changed; try again in a moment.');
    })();
    try {
        cached = await inflight;
        return cached;
    } finally {
        inflight = null;
    }
}

/** For probes and after a plugin update: forget the cached answer. */
export function resetPluginCapabilitiesCache() { cached = null; inflight = null; pluginInfo = null; compatibility = null; }

/**
 * VH-015: a backend that the plugin reported as unable to store collections
 * (e.g. Qdrant older than 1.15). Writes are refused before anything is embedded.
 */
const writeRefusals = new Map();
export function setBackendWriteRefusal(backend, message) {
    if (message) writeRefusals.set(backend, String(message)); else writeRefusals.delete(backend);
}
export function backendWriteRefusal(backend) {
    return writeRefusals.get(backend) || null;
}

// ---------------------------------------------------------------------------
// Plugin / extension compatibility (shown in the health panel; one warning on load)
// ---------------------------------------------------------------------------
let extensionVersion = null;
let compatibility = null;

async function readExtensionVersion() {
    if (extensionVersion) return extensionVersion;
    try {
        const manifest = await (await fetch(new URL('../manifest.json', import.meta.url))).json();
        extensionVersion = typeof manifest?.version === 'string' ? manifest.version : 'unknown';
    } catch { extensionVersion = 'unknown'; }
    return extensionVersion;
}

/**
 * state: 'ok' | 'plugin-older' | 'extension-older' | 'missing' | 'unknown'
 * Compatible means the same PLUGIN_PROTOCOL; the version numbers are shown for
 * people (and bug reports), not compared.
 */
export async function checkPluginCompatibility() {
    const ext = await readExtensionVersion();
    try { await readPluginCapabilities(); } catch { /* status unknown */ }
    const info = pluginInfo;
    let state, message;
    if (!info) {
        state = 'unknown'; message = 'The Similharity plugin did not answer; compatibility not checked yet.';
    } else if (!info.installed) {
        state = 'missing'; message = 'The Similharity plugin is not installed. It is needed for Qdrant, LanceDB and Milvus, and for full Standard (Vectra) support.';
    } else if (info.protocol === null || info.protocol < PLUGIN_PROTOCOL) {
        state = 'plugin-older'; message = `The Similharity plugin${info.version ? ` (${info.version})` : ''} is older than this VectHare (${ext}) needs. Update the plugin to the same version, then restart SillyTavern.`;
    } else if (info.protocol > PLUGIN_PROTOCOL) {
        state = 'extension-older'; message = `This VectHare (${ext}) is older than the Similharity plugin (${info.version || 'unknown'}). Update VectHare to the same version.`;
    } else {
        state = 'ok'; message = `Similharity ${info.version || ''} and VectHare ${ext} work together.`;
    }
    compatibility = { state, message, extensionVersion: ext, pluginVersion: info?.version ?? null, pluginProtocol: info?.protocol ?? null, protocol: PLUGIN_PROTOCOL };
    return compatibility;
}

/** The last result of checkPluginCompatibility(), or null before the first check. */
export function getPluginCompatibility() { return compatibility; }
