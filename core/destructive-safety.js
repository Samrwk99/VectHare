/**
 * Safety checks for destructive operations. These functions do not perform
 * deletions and deliberately fail closed on explicit backend errors.
 */

/**
 * Only the current diagnostics-generated collection ID formats are eligible
 * for automatic registry cleanup. Old substring-based names are not proof of
 * diagnostic ownership.
 */
export function isGeneratedDiagnosticCollectionId(collectionId) {
    return typeof collectionId === 'string'
        && /^vh:test:(?:visualizer|storage|embed)_\d{13}$/.test(collectionId);
}

/**
 * A 2xx HTTP status is necessary for the full purge to be considered
 * acknowledged. Some server versions return an empty body; JSON responses
 * are additionally checked for explicit application-level failure.
 */
export async function assertFullPurgeAcknowledged(response) {
    if (!response || !response.ok) {
        const status = response ? `${response.status} ${response.statusText || ''}`.trim() : 'no response';
        throw new Error(`Full purge was not accepted by the server (${status}); settings were preserved`);
    }

    const contentType = response.headers?.get?.('content-type') || '';
    if (contentType.includes('application/json')) {
        let result;
        try {
            result = await response.json();
        } catch (error) {
            throw new Error(`Could not verify full-purge response: ${error.message}`);
        }

        if (result && typeof result === 'object'
            && (result.success === false || result.ok === false
                || result.status === 'error' || result.status === 'failed'
                || (typeof result.error === 'string' && result.error.length > 0))) {
            throw new Error(`Full purge was rejected: ${result.error || result.message || result.status || 'server reported failure'}`);
        }
    }
}

/**
 * Keep the destructive network action and settings reset in one testable
 * sequence. A failed request never mutates the caller's settings object.
 */
export async function purgeAllAndResetSettings({ requestPurge, settings, persistSettings }) {
    const response = await requestPurge();
    await assertFullPurgeAcknowledged(response);

    for (const key of Object.keys(settings)) {
        if (key !== 'enabled') delete settings[key];
    }
    persistSettings();
}
