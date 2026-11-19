/**
 * VH-001: shared handling of /backend/init answers for Qdrant and Milvus.
 * On a multi-user SillyTavern server only an admin sets the connection; other
 * users are told once that their own address settings are not used.
 */
const noted = new Set();
const managed = new Set();

/** VH-052: true when the admin sets this backend's connection (the user's address settings are ignored). */
export function isManagedByAdmin(label) { return managed.has(String(label).toLowerCase()); }

export async function readInitResponse(response, label) {
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        let message = body;
        try { message = JSON.parse(body)?.error || body; } catch { /* plain text */ }
        const error = new Error(`[${label}] Failed to initialize ${label}: ${message || `${response.status} ${response.statusText}`}`);
        error.status = response.status;
        try { error.code = JSON.parse(body)?.code; } catch { /* none */ }
        throw error;
    }
    const data = await response.json().catch(() => ({}));
    if (data?.managedByAdmin) managed.add(String(label).toLowerCase());
    else managed.delete(String(label).toLowerCase());
    if (data?.managedByAdmin && !noted.has(label)) {
        noted.add(label);
        globalThis.toastr?.info?.(`${label} on this SillyTavern server is set up by the admin. Your own ${label} address settings are not used.`, 'VectHare', { timeOut: 8000 });
    }
    // VH-015: e.g. a Qdrant server too old to keep saved settings
    if (data?.warning && !noted.has(`${label}:warning`)) {
        noted.add(`${label}:warning`);
        globalThis.toastr?.warning?.(String(data.warning), 'VectHare', { timeOut: 15000 });
    }
    return data;
}
