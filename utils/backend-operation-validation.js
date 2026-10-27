/** Conservative response classification. No implicit acknowledgement of writes. */
const WRITE_KINDS = new Set(['insert','write','upsert','delete','purge','replace','update']);
export function validateOperation({kind, sent = false, httpStatus, payload, transportError, expectedCount, capabilities = {}} = {}) {
    const write = WRITE_KINDS.has(kind);
    const make = (status, reason, extra={}) => ({status,reason,...extra});
    if (capabilities.supported !== true) return make('unsupported','unverified-capability');
    if (!sent) return make('failed','not-sent');
    if (transportError) return make(write ? 'uncertain':'failed','transport-after-send');
    if (!Number.isInteger(httpStatus)) return make(write ? 'uncertain':'failed','no-http-status');
    if (httpStatus === 408 || httpStatus >= 500) return make(write ? 'uncertain':'failed','server-or-timeout');
    if (httpStatus < 200 || httpStatus >= 300) return make('failed','http-rejected');
    if (payload === null || payload === undefined || typeof payload !== 'object' || Array.isArray(payload)) {
        if (write && capabilities.emptySuccessAcknowledgement === true && (payload == null || payload === '')) return make('confirmed','verified-empty-ack');
        return make(write ? 'uncertain':'failed','malformed-response');
    }
    if (payload.success === false || payload.ok === false || payload.error || payload.status === 'error' || payload.status === 'failed') {
        return make(write && capabilities.applicationFailurePrecommit !== true ? 'uncertain':'failed','application-rejected');
    }
    if (!write) {
        const items = payload.items ?? payload.results ?? payload.chunks;
        if (!Array.isArray(items)) return make('failed','missing-items');
        return make('confirmed','read-ok',{items});
    }
    const count = kind === 'delete' || kind === 'purge' ? (payload.deleted ?? payload.count) : (payload.accepted ?? payload.inserted ?? payload.count);
    const countKey = kind === 'delete' || kind === 'purge' ? 'deleted' : 'accepted';
    if (count !== undefined) {
        if (!Number.isSafeInteger(count) || count < 0) return make('uncertain','invalid-count');
        if (Number.isSafeInteger(expectedCount) && count !== expectedCount) return make('uncertain','partial-ack',{[countKey]:count,expected:expectedCount});
        if (capabilities.countAcknowledgement === true) return make('confirmed','verified-count',{[countKey]:count});
        return make('uncertain','unverified-count',{[countKey]:count});
    }
    if (capabilities.successAcknowledgement === true && (payload.success === true || payload.ok === true)) return make('confirmed','verified-success');
    return make('uncertain','missing-acknowledgement');
}
export function requireConfirmedDeleteAck(outcome) {
    if (!outcome || outcome.status !== 'confirmed') throw new Error('Destructive operation not verified; requires reconciliation');
    return true;
}
