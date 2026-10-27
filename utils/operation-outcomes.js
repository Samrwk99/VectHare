import { redactSecrets } from './security.js';
import { isFeatureEnabled } from './phase0-rollout.js';
let serial = 0;
const events = [];
const MAX_EVENTS = 100;
const allowedReasons = new Set(['not-sent','unverified-capability','transport-after-send','no-http-status','server-or-timeout','http-rejected','malformed-response','application-rejected','missing-items','invalid-count','partial-ack','verified-count','unverified-count','verified-success','missing-acknowledgement','verified-empty-ack','late-response','unknown']);
function emit(operation, status, reason, counts={}) {
    const event = redactSecrets({operationId:operation.operationId,kind:operation.kind,collectionKey:operation.collectionKey,status,reason:allowedReasons.has(reason) ? reason:'unknown',...(isFeatureEnabled('verboseOperationEvents') ? Object.fromEntries(Object.entries(counts).filter(([k,v])=>['accepted','deleted','expected'].includes(k) && Number.isSafeInteger(v))) : {})});
    events.push(event);
    if (events.length > MAX_EVENTS) events.shift();
    return event;
}
export function beginOperation(kind, collectionKey) {
    const id = `p0-${Date.now().toString(36)}-${++serial}`;
    return {operationId:id,kind,collectionKey,status:'pending',startedAt:Date.now()};
}
export function settleOperation(operation, result) {
    if (operation.status !== 'pending') { emit(operation,operation.status,'late-response'); return operation.status; }
    operation.status = ['confirmed','failed','uncertain','unsupported'].includes(result?.status) ? result.status:'uncertain';
    emit(operation, operation.status, result?.reason, result || {});
    return operation.status;
}
export function canAuthorizeDestructiveFollowup(result) {return result?.status === 'confirmed';}
export function getOperationEvents() {return events.map(event => ({...event}));}
export function clearOperationEvents() { events.length=0; }
