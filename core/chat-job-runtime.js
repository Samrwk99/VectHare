/** Host identity adapter. No writes to chat metadata are performed here. */
import {getCurrentChatId} from '../../../../../script.js';
import {getContext} from '../../../../extensions.js';
import {getVerifiedChatOriginId} from './collection-ids.js';
import {createJobCoordinator} from './job-context.js';

export function currentChatIdentity() {
    const context = getContext();
    return {
        chatId: getCurrentChatId() ?? '',
        originId: getVerifiedChatOriginId() ?? '',
        groupId: context?.groupId ?? '',
        characterId: context?.characterId ?? context?.character_id ?? context?.chId ?? '',
    };
}
const safeStorage = (() => { try {return globalThis.localStorage || null;} catch {return null;} })();
export const chatJobs = createJobCoordinator({
    getIdentity: currentChatIdentity,
    storage: safeStorage,
});

/** Minimal join of operation-specific and UI-stop cancellation without requiring AbortSignal.any. */
export function anyJobSignal(...signals) {
    const valid = signals.filter(Boolean);
    if (valid.length === 0) return undefined;
    if (valid.length === 1) return valid[0];
    if (typeof AbortSignal.any === 'function') return AbortSignal.any(valid);
    const controller = new AbortController();
    const abort = signal => { if (!controller.signal.aborted) controller.abort(signal.reason); };
    for (const signal of valid) {
        if (signal.aborted) {abort(signal);break;}
        signal.addEventListener('abort',()=>abort(signal),{once:true});
    }
    return controller.signal;
}
