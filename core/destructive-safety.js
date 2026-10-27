import {writeBarrier} from '../utils/keyed-mutex.js';
import {parseCollectionKey} from '../utils/collection-keys.js';
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
export async function purgeAllAndResetSettings({ requestPurge, settings, persistSettings, contractVerified = false }) {
    if (contractVerified !== true) throw new Error('Global purge blocked: no verified backend purge contract (no request sent)');
    try {
        const drain = await writeBarrier.closeAndDrain({timeoutMs:15000});
        if (!drain.verified) throw new Error('Global purge blocked: writes in flight or unverified write completion; reconciliation required');
        const response = await requestPurge();
        await assertFullPurgeAcknowledged(response);
        for (const key of Object.keys(settings)) {
            if (key !== 'enabled') delete settings[key];
        }
        persistSettings();
    } finally { writeBarrier.reopen(); }
}

/** Phase 0 fail-closed deletion decision. Must run again inside the collection lock. */
export function guardDelete({key, operation='orphan-cleanup', inventory, metadata, ownership, outcome}={}) {
    const fail=reason=>({allowed:false,reason,evidence:{operation}});
    if (!parseCollectionKey(key)) return fail('invalid-or-unqualified-key');
    if (ownership?.verified!==true || ownership?.key!==key) return fail('ownership-unverified');
    if (operation==='orphan-cleanup' || operation==='reconciliation' || operation==='overwrite') {
        if (inventory?.complete!==true || inventory?.scope!==key) return fail('incomplete-inventory');
        if (metadata?.available!==true) return fail('metadata-unavailable');
    }
    if (operation==='targeted-delete' && metadata?.available!==true) return fail('metadata-unavailable');
    if (outcome && outcome.status!=='confirmed') return fail('unconfirmed-operation');
    return {allowed:true,reason:'verified-guard',evidence:{operation,key}};
}

/** False/undefined/status-unknown are not deletion acknowledgements. */
export function requireConfirmedDeleteAck(result) {
    if (result === true || result?.status === 'confirmed') return true;
    throw new Error('Delete/purge acknowledgement is unverified; preserve registry and metadata (reconciliation required)');
}
