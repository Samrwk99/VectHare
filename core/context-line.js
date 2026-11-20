/**
 * SillyTavern's context line (the orange dashed line in the chat): which chat
 * messages were inside the prompt at the last generation.
 *
 * SillyTavern records it after building each prompt (setInContextMessages):
 * chat_metadata.lastInContextMessageId = chat.length - count, where count is
 * the number of chat messages that fitted, plus one for a swipe, regenerate or
 * continue. VectHare's recall runs BEFORE that, so it uses the line from the
 * previous generation. The number of messages that fitted is carried forward
 * (the line moves on as new messages arrive), shifted by one for a swipe as
 * SillyTavern does.
 *
 * Used for:
 * - "Skip memories already in context": memories of the open chat that are
 *   still in the prompt are not recalled (replaces Dedup Depth while known);
 * - keeping in-chat injections inside the context (a block placed above the
 *   line is cut by SillyTavern together with the oldest messages);
 * - "Place memories at the top of the context";
 * - the readout in the settings panel.
 */
import { chat_metadata, getCurrentChatId } from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';
import * as tokenizers from '../../../../tokenizers.js';

const SHIFT_TYPES = new Set(['swipe', 'regenerate', 'continue']);

let generationType = 'normal';
/** @type {null|{chatId: string, lineIndex: number, promptCount: number, allFit: boolean}} */
let record = null;

/** GENERATION_STARTED (type, params, dryRun) and the generate interceptor. */
export function noteGenerationType(type, dryRun = false) {
    if (dryRun) return;
    generationType = typeof type === 'string' && type ? type : 'normal';
}

/** A chat switch: the recorded line belongs to the previous chat. */
export function forgetContextLine() {
    record = null;
}

function liveChat() {
    try {
        const chat = getContext()?.chat;
        return Array.isArray(chat) ? chat : [];
    } catch {
        return [];
    }
}

/** Indices of the messages SillyTavern counts (hidden/system ones are not sent). */
function countedIndices(chat, end = chat.length) {
    const out = [];
    for (let i = 0; i < end; i++) {
        const message = chat[i];
        if (message && (!message.is_system || Array.isArray(message.extra?.tool_invocations))) out.push(i);
    }
    return out;
}

/**
 * GENERATE_AFTER_DATA (data, dryRun): SillyTavern has just set the line for
 * the prompt it built. Records how many messages fitted.
 */
export function recordContextLine(dryRun = false) {
    if (dryRun) return;
    const chat = liveChat();
    const line = chat_metadata?.lastInContextMessageId;
    const chatId = getCurrentChatId();
    if (!chatId || !Number.isInteger(line) || line < 0) return;
    const shifted = SHIFT_TYPES.has(generationType);
    const counted = countedIndices(chat);
    const countWithShift = chat.length - line;
    const promptCounted = countedIndices(chat, generationType === 'swipe' ? chat.length - 1 : chat.length);
    const promptCount = countWithShift - (shifted ? 1 : 0);
    const allFit = line === 0 || promptCount >= promptCounted.length;
    // Where SillyTavern draws the line: the count-th shown message from the end.
    const lineIndex = allFit ? (counted[0] ?? 0) : counted[Math.max(0, counted.length - countWithShift)];
    record = { chatId, lineIndex, promptCount: allFit ? Infinity : promptCount, allFit };
}

/**
 * The line for the generation now being built.
 * @param {string} [type] generation type
 * @returns {{known: boolean, limitReached: boolean, inContext: number[], promptMessages: number[], line: number|null, source: string}}
 *   inContext: indices (in the live chat) of the messages expected in this prompt.
 */
export function readContextLine(type = 'normal') {
    const chat = liveChat();
    const end = type === 'swipe' && chat.length ? chat.length - 1 : chat.length;
    const promptMessages = countedIndices(chat, end);
    const unknown = { known: false, limitReached: false, inContext: [], promptMessages, line: null, source: 'unknown' };
    const chatId = getCurrentChatId();
    if (!chatId) return unknown;
    const all = source => ({ known: true, limitReached: false, inContext: promptMessages, promptMessages,
        line: promptMessages[0] ?? null, source });

    if (record && record.chatId === chatId) {
        if (record.allFit || record.promptCount >= promptMessages.length) return all('generation');
        const inContext = promptMessages.slice(promptMessages.length - record.promptCount);
        return { known: true, limitReached: true, inContext, promptMessages, line: inContext[0], source: 'generation' };
    }
    // After a reload: SillyTavern's saved line (no count to carry forward).
    const saved = chat_metadata?.lastInContextMessageId;
    if (Number.isInteger(saved) && saved >= 0) {
        if (saved === 0) return all('saved');
        const inContext = promptMessages.filter(index => index >= saved);
        if (inContext.length >= promptMessages.length) return all('saved');
        return { known: true, limitReached: true, inContext, promptMessages, line: inContext[0] ?? null, source: 'saved' };
    }
    return unknown;
}

/**
 * The settings panel readout: where SillyTavern's line is now.
 * @returns {{state: 'no-chat'|'unknown'|'all'|'line', text: string, from?: number, to?: number, count?: number}}
 */
export function describeContextLine() {
    const chatId = getCurrentChatId();
    if (!chatId) return { state: 'no-chat', text: 'No chat open' };
    const chat = liveChat();
    const counted = countedIndices(chat);
    const last = chat.length - 1;
    let from = null;
    if (record && record.chatId === chatId) {
        if (record.allFit) from = 0;
        else from = Math.min(record.lineIndex, Math.max(0, last));
    } else {
        const saved = chat_metadata?.lastInContextMessageId;
        if (Number.isInteger(saved) && saved >= 0) from = saved;
    }
    if (from === null) return { state: 'unknown', text: 'Not known yet — generate once in this chat' };
    const inside = counted.filter(index => index >= from);
    if (from === 0 || inside.length >= counted.length) {
        return { state: 'all', text: `Context limit not reached yet — all ${counted.length} messages are in context`, count: counted.length };
    }
    return { state: 'line', text: `In context: messages #${from}–#${last} (${inside.length})`, from, to: last, count: inside.length };
}

/** Token count with SillyTavern's tokenizer for the current API. */
export async function countTokens(text) {
    const value = String(text ?? '');
    try {
        if (typeof tokenizers.getTokenCountAsync === 'function') return await tokenizers.getTokenCountAsync(value);
        if (typeof tokenizers.getTokenCount === 'function') return tokenizers.getTokenCount(value);
    } catch (error) {
        console.debug('VectHare: token count failed, estimating:', error?.message || error);
    }
    return Math.ceil(value.length / 3.5);
}

/**
 * How many of the oldest in-context messages a block of `tokens` pushes out of
 * the context (plus one for safety): the block must sit below them to stay in.
 * @param {number[]} inContext live-chat indices, oldest first
 * @param {number} tokens
 */
export async function messagesDisplacedBy(inContext, tokens) {
    if (!(tokens > 0)) return 0;
    const chat = liveChat();
    let sum = 0;
    let k = 0;
    while (k < inContext.length && sum < tokens) {
        const message = chat[inContext[k]];
        sum += await countTokens(`${message?.name ?? ''}: ${message?.mes ?? ''}`);
        k++;
    }
    return k + 1;
}

/** For tests. */
export function _contextLineRecord() {
    return record;
}
