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

let cached = null;
let inflight = null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function readPluginCapabilities() {
    if (cached) return cached;
    inflight ??= (async () => {
        let last = null;
        for (const delay of [0, 400, 1500]) {
            if (delay) await sleep(delay);
            try {
                const response = await fetch('/api/plugins/similharity/health');
                if (response.status === 404) return {};
                if (!response.ok) { last = `HTTP ${response.status}`; continue; }
                const data = await response.json();
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
export function resetPluginCapabilitiesCache() { cached = null; inflight = null; }

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
