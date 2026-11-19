/**
 * Step 9a / P1: read-only storage report (client side).
 *
 * Asks the Similharity plugin where every collection VectHare's metadata file
 * knows about is physically stored, how many vectors it holds and where its
 * saved original settings were found. The plugin reads collections.json and
 * the backends itself; this module only sends today's settings (so the report
 * can say what today's settings-based rule would pick) and shapes the result
 * for display.
 *
 * Writes nothing: no backend, no VectHare metadata, no settings.
 */

import { getRequestHeaders } from '../../../../../script.js';
import { getModelField } from './providers.js';

const ROUTE = '/api/plugins/similharity/storage/report';

/** Human labels for the layouts the plugin reports. */
export const LAYOUT_LABELS = Object.freeze({
    'per-collection': 'Own store',
    'legacy-mt': 'Shared (old Qdrant multitenancy)',
    'legacy-shared': 'Shared (Milvus vecthare_main)',
    'mt-v2': 'Shared, multitenancy v2 (vecthare_mt_<size>)',
    'conflict': 'Conflict: found in more than one place',
    'not-found': 'Not found',
    'unknown': 'Unknown',
});

export const CONFIG_LABELS = Object.freeze({
    found: 'found',
    missing: 'missing',
    multiple: 'found in more than one place',
    invalid: 'invalid',
    unavailable: 'could not be read',
});

/** Whether the installed plugin offers the report. */
export async function storageReportSupported() {
    try {
        const response = await fetch('/api/plugins/similharity/health');
        if (!response.ok) return false;
        const data = await response.json();
        return data?.capabilities?.storageReport === 1;
    } catch {
        return false;
    }
}

/** Today's settings, as the report's "today's rule" reference. */
export function reportDefaults(settings) {
    const source = settings?.source || 'transformers';
    const modelField = getModelField(source);
    return {
        backend: settings?.vector_backend || 'standard',
        source,
        model: modelField ? String(settings?.[modelField] || '') : '',
        qdrantMultitenancy: Boolean(settings?.qdrant_multitenancy),
    };
}

/**
 * Runs the report.
 * @param {object} settings VectHare settings
 * @param {{signal?: AbortSignal}} options
 * @returns {Promise<{ok: true, report: object}|{ok: false, reason: string}>}
 */
export async function fetchStorageReport(settings, { signal } = {}) {
    if (!await storageReportSupported()) {
        return { ok: false, reason: 'The installed Similharity plugin does not offer the storage report. Update the plugin (13.29 or later) and restart SillyTavern.' };
    }
    let response;
    try {
        response = await fetch(ROUTE, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ defaults: reportDefaults(settings) }),
            signal,
        });
    } catch (error) {
        return { ok: false, reason: `The plugin could not be reached: ${error.message}` };
    }
    let data = null;
    try { data = await response.json(); } catch { /* handled below */ }
    if (!response.ok || data?.success !== true || !Array.isArray(data.collections)) {
        return { ok: false, reason: data?.error || `The plugin returned HTTP ${response.status}` };
    }
    return { ok: true, report: data };
}

/** Short plain-text lines that summarise a report (also used in the copy). */
export function summarizeStorageReport(report) {
    const s = report.summary || {};
    const lines = [];
    const server = report.server || {};
    lines.push(`Server: ${server.mode || 'unknown'}${server.users ? ` (${server.users} user folder${server.users === 1 ? '' : 's'})` : ''}` +
        `${server.confirmed ? '' : ' - not confirmed'}`);
    const layouts = Object.entries(s.layouts || {}).map(([k, v]) => `${v} ${LAYOUT_LABELS[k] || k}`).join(', ');
    lines.push(`Collections checked: ${s.collections ?? 0}${layouts ? ` - ${layouts}` : ''}`);
    if (s.configMissing || s.configMultiple || s.configInvalid) {
        lines.push(`Saved settings: ${s.configMissing || 0} missing, ${s.configMultiple || 0} in more than one place, ${s.configInvalid || 0} invalid`);
    }
    if (s.locators !== undefined) {
        lines.push(`Recorded locations: ${s.locators}${s.locatorDisagrees ? ` (${s.locatorDisagrees} do not match what was found)` : ''}`);
    }
    if (s.todayRuleDisagrees) {
        lines.push(`${s.todayRuleDisagrees} collection(s) are stored somewhere today's switch would not look; with a recorded location they keep working.`);
    }
    if (s.unreferenced) lines.push(`${s.unreferenced} physical store(s) no VectHare record points at.`);
    return lines;
}
