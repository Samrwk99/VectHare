/**
 * Applies SillyTavern's "Alter Outgoing Prompt" regex scripts to recalled
 * memories, the way SillyTavern applies them to what it puts in a prompt.
 * Runs only on the text pulled for injection; nothing stored is changed.
 *
 *  - Chat memories: "User Input" scripts on the user's parts, "AI Output"
 *    scripts on the character's. A per-message memory carries who wrote it; a
 *    grouped memory (turns, batches) carries a record of its parts
 *    (speakerParts). Older grouped memories are split at their [Name]: labels,
 *    with the open chat used only to tell who wrote what. A memory that cannot
 *    be split safely is sent as stored.
 *  - Lorebook memories: "World Info" scripts, as SillyTavern does for entries.
 *  - Anything else (documents, pages, character cards, files): unchanged -
 *    SillyTavern applies no regex to those in a prompt either.
 *
 * Depth: injected into the chat at depth N, the most recent chat memory counts
 * as depth N, the next most recent N+1, and so on (ranks, not real ages); other
 * memories count as N, like SillyTavern's lorebook entries at depth. Injected
 * before/after the prompt, depth limits do not apply (as in SillyTavern).
 */
import { getContext } from '../../../../extensions.js';
import { getStringHash } from '../../../../utils.js';
import { parseCollectionId, parseRegistryKey, COLLECTION_TYPES } from './collection-ids.js';

const PLACEMENT = { USER_INPUT: 1, AI_OUTPUT: 2, WORLD_INFO: 5 };
const IN_CHAT = 1; // extension_prompt_types.IN_CHAT

let engine = null;        // SillyTavern's getRegexedString, once loaded
let engineLoaded = false;

/** Loads SillyTavern's regex function (once). Without it, memories go as stored. */
export async function loadMemoryRegexEngine() {
    if (engineLoaded) return engine;
    engineLoaded = true;
    try {
        const module = await import('../../../regex/engine.js');
        engine = typeof module.getRegexedString === 'function' ? module.getRegexedString : null;
    } catch (error) {
        console.warn('VectHare: SillyTavern regex scripts could not be loaded; memories are sent as stored', error?.message || error);
        engine = null;
    }
    return engine;
}

/** For tests: use this function instead of SillyTavern's. */
export function setMemoryRegexEngineForTests(fn) { engine = fn; engineLoaded = true; }

function bareCollectionId(collectionId) {
    const parsed = parseRegistryKey(String(collectionId || ''));
    return parsed?.collectionId || String(collectionId || '');
}

function memoryKind(chunk) {
    const type = parseCollectionId(bareCollectionId(chunk.collectionId))?.type;
    if (type === COLLECTION_TYPES.CHAT) return 'chat';
    if (type === COLLECTION_TYPES.LOREBOOK) return 'lorebook';
    return 'other';
}

/** Valid recorded parts for this exact text, or null. */
function recordedParts(text, parts, expectedCount) {
    if (!Array.isArray(parts) || !parts.length) return null;
    if (expectedCount && parts.length !== expectedCount) return null;
    let previousEnd = -2;
    for (const [i, part] of parts.entries()) {
        if (!part || !['user', 'character'].includes(part.role)) return null;
        const { start, end } = part;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length) return null;
        // each part is "[Label]: " + message text, separated by a blank line
        const head = text.slice(i === 0 ? 0 : previousEnd + 2, start);
        if (i > 0 && text.slice(previousEnd, previousEnd + 2) !== '\n\n') return null;
        if (!/^\[[^\]\n]*\]: $/.test(head)) return null;
        previousEnd = end;
    }
    return previousEnd === text.length ? parts : null;
}

let fingerprintOf = message => getStringHash(String(message?.mes ?? ''));

/** Who wrote message `index` of the open chat, if it is still the message stored (same fingerprint). */
function roleFromOpenChat(index, hash, fromOpenChat) {
    if (!fromOpenChat || hash == null || index == null) return null;
    const chat = getContext()?.chat;
    const message = Array.isArray(chat) ? chat[Number(index)] : null;
    if (!message || message.is_system) return null;
    return String(fingerprintOf(message)) === String(hash) ? (message.is_user ? 'user' : 'character') : null;
}

/** Names of the characters in the open chat (may include the user's own name). */
function characterNames() {
    const context = getContext() || {};
    const names = new Set();
    if (context.name2) names.add(String(context.name2));
    const group = Array.isArray(context.groups) ? context.groups.find(g => String(g?.id) === String(context.groupId)) : null;
    for (const avatar of group?.members || []) {
        const character = (context.characters || []).find(c => c?.avatar === avatar);
        if (character?.name) names.add(String(character.name));
    }
    return names;
}

/** Split an older grouped memory at its [Name]: labels; null when not safe. */
function partsFromLabels(text, meta, fromOpenChat) {
    const ids = Array.isArray(meta?.messageIds) ? meta.messageIds : null;
    if (!ids?.length) return null;
    const pieces = text.split(/\n\n(?=\[[^\]\n]*\]: )/);
    if (pieces.length !== ids.length) return null;
    const userName = String(getContext()?.name1 || '');
    const hashes = Array.isArray(meta.messageHashes) ? meta.messageHashes : [];
    const parts = [];
    let position = 0;
    for (const [i, piece] of pieces.entries()) {
        const m = /^\[([^\]\n]*)\]: /.exec(piece);
        if (!m) return null;
        const label = m[1];
        // 1. the open chat, when the message is still there unchanged
        let role = roleFromOpenChat(ids[i], hashes[i], fromOpenChat);
        // 2. the label, only when it can only mean one side (otherwise: as stored)
        if (!role) {
            // a name that is both the user's and a character's settles nothing
            const characters = characterNames();
            if (label === 'User') role = 'user';
            else if (label === 'Character') role = 'character';
            else if (userName && label === userName && !characters.has(label)) role = 'user';
            else if (characters.has(label) && label !== userName) role = 'character';
        }
        if (!role) return null;
        parts.push({ role, start: position + m[0].length, end: position + piece.length });
        position += piece.length + 2;
    }
    return parts;
}

function chatParts(chunk, text, fromOpenChat) {
    const meta = chunk.metadata || {};
    const strategy = meta.strategy;
    if (strategy === 'conversation_turns' || strategy === 'message_batch') {
        const expected = Array.isArray(meta.messageIds) ? meta.messageIds.length : 0;
        return recordedParts(text, meta.speakerParts, expected) || partsFromLabels(text, meta, fromOpenChat);
    }
    if (strategy === 'per_message' || strategy === undefined) {
        let role = typeof meta.is_user === 'boolean' ? (meta.is_user ? 'user' : 'character')
            : typeof chunk.is_user === 'boolean' ? (chunk.is_user ? 'user' : 'character') : null;
        if (!role) {
            const index = meta.messageId ?? meta.index ?? chunk.index;
            const hash = Array.isArray(meta.messageHashes) ? meta.messageHashes[0] : chunk.hash;
            role = roleFromOpenChat(index, hash, fromOpenChat);
        }
        return role ? [{ role, start: 0, end: text.length }] : null;
    }
    return null; // scenes and other chat forms: sent as stored
}

function applyScripts(text, placement, depth) {
    try {
        const out = engine(text, placement, { isPrompt: true, isMarkdown: false, ...(typeof depth === 'number' ? { depth } : {}) });
        return typeof out === 'string' ? out : text;
    } catch (error) {
        console.warn('VectHare: a regex script failed on a memory; that part is sent as stored', error?.message || error);
        return text;
    }
}

function rewriteChat(text, parts, depth) {
    let out = '';
    let cursor = 0;
    for (const part of parts) {
        out += text.slice(cursor, part.start);
        out += applyScripts(text.slice(part.start, part.end),
            part.role === 'user' ? PLACEMENT.USER_INPUT : PLACEMENT.AI_OUTPUT, depth);
        cursor = part.end;
    }
    return out + text.slice(cursor);
}

/**
 * Returns copies of `chunks` with `text` changed by the scripts (the input is
 * not modified). `textOf(chunk)` gives the text that would be injected.
 * @param {object[]} chunks memories for ONE injection position
 * @param {{position:number, depth:number}} where that position
 * @param {(chunk: object) => string} textOf
 * @param {{openChatCollectionId?: string, messageFingerprint?: (message: object) => any,
 *   generatedSuffixOf?: (text: string, chunk: object) => string}} [options]
 */
export function applyPromptRegexToMemories(chunks, where, textOf, options = {}) {
    if (!engine || !Array.isArray(chunks) || !chunks.length) return chunks;
    if (typeof options.messageFingerprint === 'function') fingerprintOf = options.messageFingerprint;
    const atDepth = Number(where?.position) === IN_CHAT && Number.isFinite(Number(where?.depth));
    const base = atDepth ? Number(where.depth) : null;
    const openChatId = options.openChatCollectionId ? bareCollectionId(options.openChatCollectionId) : null;
    const fromOpenChat = chunk => Boolean(openChatId) && bareCollectionId(chunk.collectionId) === openChatId;

    // Depth ladder: chat memories by recency - the open chat's newest first,
    // then other chats' memories in recall order; everything else at N.
    const chatChunks = chunks.filter(c => memoryKind(c) === 'chat');
    const ordered = [
        ...chatChunks.filter(fromOpenChat).sort((a, b) => Number(b.index ?? 0) - Number(a.index ?? 0)),
        ...chatChunks.filter(c => !fromOpenChat(c)),
    ];
    const rank = new Map(ordered.map((chunk, i) => [chunk, i]));

    return chunks.map(chunk => {
        const kind = memoryKind(chunk);
        if (kind === 'other') return chunk;
        const full = String(textOf(chunk) ?? '');
        if (!full) return chunk;
        // A generated keyword list kept in the text ("Include Keywords in RAG
        // Context") is VectHare's, not the message's: set aside, re-added after.
        const tail = typeof options.generatedSuffixOf === 'function' ? String(options.generatedSuffixOf(full, chunk) || '') : '';
        const text = tail && full.endsWith(tail) ? full.slice(0, full.length - tail.length) : full;
        const done = next => (next === text ? chunk : { ...chunk, text: next + (text === full ? '' : tail) });
        const depth = base === null ? null : base + (kind === 'chat' ? (rank.get(chunk) ?? 0) : 0);
        if (kind === 'lorebook') return done(applyScripts(text, PLACEMENT.WORLD_INFO, depth));
        const parts = chatParts(chunk, text, fromOpenChat(chunk));
        if (!parts) return chunk;
        return done(rewriteChat(text, parts, depth));
    });
}
