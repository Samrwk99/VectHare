/**
 * ============================================================================
 * VECTHARE CHUNKING STRATEGIES
 * ============================================================================
 * Unified chunking system for all content types.
 * Each strategy is a pure function that takes text and options, returns chunks.
 *
 * CHAT STRATEGIES (unit-based, no size controls):
 * - per_message: Each message = one chunk
 * - conversation_turns: User+AI pairs = one chunk
 * - message_batch: N messages = one chunk
 *
 * TEXT STRATEGIES (size-based):
 * - adaptive: Smart splitting at natural boundaries
 * - paragraph: Split on double newlines
 * - section: Split on markdown headers
 * - sentence: Group sentences to target size
 *
 * CONTENT STRATEGIES:
 * - per_entry: Each lorebook entry = one chunk
 * - per_field: Each character field = one chunk
 * - combined: Merge then chunk with adaptive
 *
 * @author Coneja Chibi
 * @version 3.0.0
 * ============================================================================
 */

import { DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP } from './constants.js';

/**
 * C13 versioned strategy definitions. A change to a chunk boundary changes its
 * physical hash. Existing collections must never be silently re-chunked.
 */
export const CHUNKER_VERSION = 2;
export const SIZE_BASED_STRATEGIES = new Set(['adaptive', 'sentence', 'dialogue']);

/** Validate overlap before work begins; overlapping chunks must advance. */
export function validateOverlap(chunkSize, chunkOverlap) {
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 2 || chunkSize > 1000000)
        throw new Error('C13: chunkSize must be an integer from 2 to 1000000');
    if (!Number.isSafeInteger(chunkOverlap) || chunkOverlap < 0 || chunkOverlap >= chunkSize)
        throw new Error('C13: chunkOverlap must be an integer >= 0 and smaller than chunkSize');
}

/**
 * Overlap on the original input text, not on the already-overlapped output.
 * Never synthesizes repeated identical chunks, empty chunks, or non-progress.
 * Text strategies preserve the order and natural boundaries of base chunks;
 * exceptionally long base chunks are split into bounded windows.
 */
export function applyTextOverlap(baseChunks, chunkSize, overlap) {
    validateOverlap(chunkSize, overlap);
    const blocks = baseChunks.filter(c => (typeof c === 'string' ? c : c?.text || '').trim());
    if (!overlap) return blocks;
    const output = [];
    for (let blockIndex=0; blockIndex<blocks.length;blockIndex++) {
        const base=blocks[blockIndex];
        const source=typeof base === 'string' ? base : base.text;
        const baseMetadata=typeof base === 'string' ? {} : base.metadata || {};
        let offset=0;
        while (offset<source.length) {
            const prefix=output.length ? output[output.length-1].text.slice(-overlap) : '';
            // Separate consecutive semantic blocks rather than gluing the
            // final word of one paragraph to the first word of the next.
            const separator=offset===0 && output.length && !/\s$/.test(prefix) && !/^\s/.test(source)
                && chunkSize-prefix.length>1 ? ' ' : '';
            const capacity=chunkSize-prefix.length-separator.length;
            if (capacity<1) throw new Error('C13: chunk overlap leaves no room for content');
            let end=Math.min(source.length,offset+capacity);
            if (end<source.length && /[\uD800-\uDBFF]/.test(source[end-1])) end--;
            if (end===offset) throw new Error('C13: chunkSize too small for Unicode text');
            const part=source.slice(offset,end);
            const text=prefix+separator+part;
            if (text.trim() && text!==output[output.length-1]?.text)
                output.push({text,metadata:{...baseMetadata,overlapPrefixLength:prefix.length+separator.length,
                    sourceBlock:blockIndex,sourceOffset:offset,sourceEnd:end}});
            offset=end;
        }
    }
    return output;
}

/**
 * Adaptive chat grouping retains exact member references and never coalesces
 * incompatible physical records. Each group is bounded by chunkSize and is
 * deterministic for unchanged message content/order/options.
 */
export function adaptiveChatGroups(messages, {chunkSize = 500} = {}) {
    validateOverlap(chunkSize, 0);
    if (!Array.isArray(messages)) throw new Error('C13: adaptive chat requires message array');
    const output = [];
    let current = [];
    let size = 0;
    const flush = () => {
        if (!current.length) return;
        const text = current.map(x => x.text).join('\n\n');
        const raw = current.map(x => x.raw).join('\n\n');
        const membership = [...new Set(current.map(x => x.id).filter(x => x !== undefined && x !== null))];
        output.push({text, raw, metadata: {
            strategy: 'adaptive', chunkerVersion: CHUNKER_VERSION,
            messageIds: membership, startIndex: membership[0], endIndex: membership[membership.length - 1],
            messageRefs: [...new Set(current.map(x => x.ref).filter(Boolean))],
            messageHashes: [...new Set(current.map(x => x.hash).filter(x => x !== undefined))],
            segmentOffsets: current.map(x => ({id:x.id, from:x.from, to:x.to})),
        }});
        current = []; size = 0;
    };
    for (const msg of messages) {
        const displayed = String(msg?.text ?? msg?.mes ?? '');
        const original = String(msg?.raw ?? msg?.text ?? msg?.mes ?? '');
        const id = msg?.index ?? msg?.id;
        const role = msg?.is_user ? 'User' : String(msg?.speaker || msg?.name || 'Character');
        const prefix = `[${role}]: `;
        // Keep membership when a single message exceeds the limit.
        // Preserve the corresponding source substring for stable hashing.
        const maxPart = Math.max(1, chunkSize - prefix.length);
        if (prefix.length >= chunkSize) throw new Error('C13: chunkSize too small for chat role label');
        let from = 0;
        while (from < displayed.length || (from === 0 && !displayed.length)) {
            let to = Math.min(displayed.length, from + maxPart);
            if (to < displayed.length && /[\uD800-\uDBFF]/.test(displayed[to - 1])) to--;
            if (to === from && displayed.length) throw new Error('C13: chunkSize too small for Unicode chat text');
            const visiblePart = displayed.slice(from, to);
            const originalPart = original.slice(from, to);
            const unit = {text: prefix + visiblePart, raw: prefix + originalPart + `\u0000segment:${from}:${to}:${original.length}`,
                id, ref:msg?.messageRef, hash:msg?.hash, from, to};
            const needed = unit.text.length + (current.length ? 2 : 0);
            if (current.length && size + needed > chunkSize) flush();
            current.push(unit); size += unit.text.length + (current.length > 1 ? 2 : 0);
            from = to || displayed.length;
        }
    }
    flush();
    return output;
}

/** Parse explicit upload scene boundaries; never infer scene ownership from text alone. */
export function parseUploadedScenes(messages, metadata={}) {
    if (!Array.isArray(messages)) throw new Error('C13: uploaded scenes require message array');
    const normalized = messages.map((msg, index) => ({...msg, __index:index}));
    const declared = Array.isArray(metadata?.scenes) ? metadata.scenes : null;
    const ranges = [];
    if (declared?.length) {
        for (const item of declared) {
            const start = item.start ?? item.sceneStart;
            const end = item.end ?? item.sceneEnd;
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end >= messages.length || end < start)
                throw new Error('C13: invalid imported scene range');
            ranges.push({start,end,title:item.title ?? null});
        }
    } else {
        let pending = null;
        for (let i=0; i<normalized.length; i++) {
            const msg = normalized[i];
            const start = msg.sceneStart === true || msg.extra?.vecthare?.sceneStart === true || /^\s*\[SCENE START\]/i.test(msg.mes || msg.text || '');
            const end = msg.sceneEnd === true || msg.extra?.vecthare?.sceneEnd === true || /^\s*\[SCENE END\]/i.test(msg.mes || msg.text || '');
            if (start) {
                if (pending !== null) throw new Error('C13: nested imported scene start');
                pending = i;
            }
            if (end) {
                if (pending === null) throw new Error('C13: scene end without start');
                ranges.push({start:pending,end:i,title:msg.sceneTitle || null});
                pending = null;
            }
        }
        if (pending !== null) throw new Error('C13: unclosed imported scene');
    }
    ranges.sort((a,b)=>a.start-b.start);
    for (let i=1; i<ranges.length; i++)
        if (ranges[i].start <= ranges[i-1].end) throw new Error('C13: overlapping imported scenes');
    if (!ranges.length) throw new Error('C13: no complete scene markers found in upload');
    return ranges.map((scene,sceneIndex)=>{
        const members = normalized.slice(scene.start,scene.end+1);
        return {text:members.map(m=>`[${m.is_user?'User':(m.name || 'Character')}]: ${m.mes ?? m.text ?? ''}`).join('\n\n'),
            metadata:{strategy:'per_scene',chunkerVersion:CHUNKER_VERSION,isScene:true,sceneIndex,
                sceneStart:scene.start,sceneEnd:scene.end,sceneTitle:scene.title,
                messageIds:members.map(m=>m.__index)}};
    });
}

/**
 * Main entry point - chunks text using specified strategy
 * @param {string|Array|object} text - Text to chunk (format depends on strategy)
 * @param {object} options - Chunking options
 * @param {string} options.strategy - Strategy ID
 * @param {number} options.chunkSize - Target chunk size in characters (for text strategies)
 * @param {number} options.batchSize - Messages per batch (for message_batch strategy)
 * @returns {Array<{text: string, metadata: object}>} Array of chunks
 */
export async function chunkText(text, options = {}) {
    const {
        strategy = 'adaptive',
        chunkSize = DEFAULT_CHUNK_SIZE,
        chunkOverlap = DEFAULT_CHUNK_OVERLAP,
        batchSize = 4,
        conversationTurnOrder = 'user_character',
        sourceMetadata = {},
    } = options;

    if (!text) {
        return [];
    }

    // Objects are allowed for per_field strategy
    const isObject = typeof text === 'object' && !Array.isArray(text);
    if (typeof text !== 'string' && !Array.isArray(text) && !isObject) {
        return [];
    }

    // Select strategy
    const strategyFn = STRATEGIES[strategy];
    if (!strategyFn) throw new Error(`Unsupported chunking strategy: ${strategy}`);
    if (SIZE_BASED_STRATEGIES.has(strategy) && !Array.isArray(text)) validateOverlap(chunkSize, chunkOverlap);
    const sourceChunks = strategyFn(text, { chunkSize, chunkOverlap, batchSize, conversationTurnOrder, sourceMetadata });
    const chunks = SIZE_BASED_STRATEGIES.has(strategy) && !Array.isArray(text)
        ? applyTextOverlap(sourceChunks, chunkSize, chunkOverlap) : sourceChunks;

    // Add metadata to each chunk
    return chunks.map((chunk, index) => ({
        text: typeof chunk === 'string' ? chunk : chunk.text,
        metadata: {
            chunkIndex: index,
            totalChunks: chunks.length,
            strategy: strategy,
            ...(SIZE_BASED_STRATEGIES.has(strategy) || (strategy === 'per_scene' && Array.isArray(text)) ? {chunkerVersion:CHUNKER_VERSION} : {}),
            ...(typeof chunk === 'object' ? chunk.metadata : {}),
        },
    }));
}

/**
 * Pair consecutive speaker turns in the selected order. Runs of messages
 * from the same speaker are one logical turn; unmatched edge turns remain
 * separate chunks rather than being paired in the wrong order.
 * @param {Array} messages Chronological chat messages with .is_user
 * @param {string} order 'user_character' or 'character_user'
 * @returns {Array<Array>} Message groups in their original order
 */
export function groupConversationTurns(messages, order = 'user_character') {
    if (!Array.isArray(messages) || messages.length === 0) return [];

    const turns = [];
    for (const message of messages) {
        const last = turns[turns.length - 1];
        if (last && Boolean(last[0].is_user) === Boolean(message.is_user)) {
            last.push(message);
        } else {
            turns.push([message]);
        }
    }

    const startsWithUser = order !== 'character_user';
    const groups = [];
    for (let i = 0; i < turns.length;) {
        if (Boolean(turns[i][0].is_user) === startsWithUser && i + 1 < turns.length) {
            groups.push([...turns[i], ...turns[i + 1]]);
            i += 2;
        } else {
            groups.push(turns[i]);
            i++;
        }
    }
    return groups;
}

/**
 * Strategy implementations
 */
const STRATEGIES = {
    // =========================================================================
    // CHAT STRATEGIES (unit-based)
    // =========================================================================

    /**
     * Per Message - each message becomes one chunk
     * @param {Array} messages - Array of message objects with .text or .mes
     */
    per_message: (messages, options) => {
        if (!Array.isArray(messages)) {
            // Single text input - treat as one chunk
            const text = typeof messages === 'string' ? messages : (messages.text || messages.mes || String(messages));
            return [text];
        }

        const chunks = [];
        for (const msg of messages) {
            const text = typeof msg === 'string' ? msg : (msg.text || msg.mes || '');
            const speaker = msg.is_user ? 'User' : (msg.name || 'Character');
            const isUser = msg.is_user || false;
            const messageId = msg.index ?? msg.id ?? msg.send_date;

            chunks.push({
                text,
                metadata: {
                    speaker,
                    isUser,
                    messageId,
                },
            });
        }
        return chunks;
    },

    /**
     * Conversation Turns - pairs user + AI messages together
     * @param {Array} messages - Array of message objects
     */
    conversation_turns: (messages, options) => {
        if (!Array.isArray(messages) || messages.length === 0) {
            return [];
        }

        const chunks = [];
        for (const pair of groupConversationTurns(messages, options.conversationTurnOrder)) {
            // Combine texts with speaker labels
            const combinedText = pair.map(m => {
                const role = m.is_user ? 'User' : (m.name || 'Character');
                const text = m.text || m.mes || '';
                return `[${role}]: ${text}`;
            }).join('\n\n');

            chunks.push({
                text: combinedText,
                metadata: {
                    strategy: 'conversation_turns',
                    messageIds: pair.map(m => m.index ?? m.id),
                    startIndex: pair[0].index ?? pair[0].id,
                    endIndex: pair[pair.length - 1].index ?? pair[pair.length - 1].id,
                },
            });
        }
        return chunks;
    },

    /**
     * Message Batch - groups N messages together
     * @param {Array} messages - Array of message objects
     * @param {object} options - Must include batchSize
     */
    message_batch: (messages, options) => {
        if (!Array.isArray(messages) || messages.length === 0) {
            return [];
        }

        const batchSize = options.batchSize || 4;
        const chunks = [];

        for (let i = 0; i < messages.length; i += batchSize) {
            const batch = messages.slice(i, i + batchSize);

            // Combine texts with speaker labels
            const combinedText = batch.map(m => {
                const role = m.is_user ? 'User' : (m.name || 'Character');
                const text = m.text || m.mes || '';
                return `[${role}]: ${text}`;
            }).join('\n\n');

            chunks.push({
                text: combinedText,
                metadata: {
                    strategy: 'message_batch',
                    batchSize: batch.length,
                    messageIds: batch.map(m => m.index ?? m.id),
                    startIndex: batch[0].index ?? batch[0].id,
                    endIndex: batch[batch.length - 1].index ?? batch[batch.length - 1].id,
                },
            });
        }
        return chunks;
    },

    /**
     * Per Scene - scenes are vectorized via UI markers, not this function
     * This strategy returns empty because scenes are created by createSceneChunk()
     * when the user marks a scene end. Auto-sync skips processing for this strategy.
     */
    per_scene: (messages, options) => {
        if (!Array.isArray(messages)) throw new Error('C13: per_scene upload requires parsed messages');
        return parseUploadedScenes(messages, options.sourceMetadata || {});
    },

    /**
     * Adaptive - intelligent splitting at natural boundaries
     * Tries paragraphs first, then sentences, then words
     */
    adaptive: (text, options) => {
        if (Array.isArray(text)) return adaptiveChatGroups(text, options);
        return adaptiveChunk(text, options);
    },

    // =========================================================================
    // TEXT STRATEGIES (for documents, URLs, etc.)
    // =========================================================================

    /**
     * Split on paragraph boundaries (double newlines)
     */
    paragraph: (text, options) => {
        if (typeof text !== 'string') {
            return [String(text)];
        }
        const paragraphs = text.split(/\n\n+|^---+$/m).filter(p => p.trim());
        return paragraphs.map(p => p.trim());
    },

    /**
     * Split on markdown section headers
     */
    section: (text, options) => {
        if (typeof text !== 'string') {
            return [String(text)];
        }

        const headerRegex = /^(#{1,6})\s+(.+)$/gm;
        const sections = [];
        let lastIndex = 0;
        let match;

        while ((match = headerRegex.exec(text)) !== null) {
            if (match.index > lastIndex) {
                const beforeContent = text.slice(lastIndex, match.index).trim();
                if (beforeContent) {
                    sections.push(beforeContent);
                }
            }
            lastIndex = match.index;
        }

        if (lastIndex < text.length) {
            sections.push(text.slice(lastIndex).trim());
        }

        // If no headers found, fall back to paragraph
        if (sections.length === 0) {
            return STRATEGIES.paragraph(text, options);
        }

        return sections.filter(s => s);
    },

    /**
     * Split on sentence boundaries, grouping to target size
     */
    sentence: (text, options) => {
        if (typeof text !== 'string') {
            return [String(text)];
        }

        const sentences = text
            .split(/(?<=[.!?])\s+/)
            .filter(s => s.trim())
            .map(s => s.trim());

        const chunks = [];
        let currentChunk = '';

        for (const sentence of sentences) {
            if (currentChunk.length + sentence.length + 1 <= options.chunkSize) {
                currentChunk += (currentChunk ? ' ' : '') + sentence;
            } else {
                if (currentChunk) chunks.push(currentChunk);
                currentChunk = sentence;
            }
        }

        if (currentChunk) chunks.push(currentChunk);
        return chunks;
    },

    // =========================================================================
    // CONTENT STRATEGIES (lorebook, character, etc.)
    // =========================================================================

    /**
     * Per Entry - each lorebook entry becomes one chunk
     */
    per_entry: (entries, options) => {
        if (!Array.isArray(entries)) {
            return [typeof entries === 'string' ? entries : String(entries)];
        }
        return entries.map(e => {
            const text = typeof e === 'string' ? e : (e.text || e.content || String(e));
            return {
                text,
                metadata: {
                    entryName: e.comment || e.name || e.key?.[0] || undefined,
                    keys: e.key || e.keys || undefined,
                },
            };
        });
    },

    /**
     * Per Field - each character field becomes one chunk
     */
    per_field: (fields, options) => {
        if (typeof fields !== 'object' || Array.isArray(fields)) {
            return [String(fields)];
        }
        return Object.entries(fields)
            .filter(([, value]) => value && typeof value === 'string' && value.trim())
            .map(([field, value]) => ({
                text: value,
                metadata: { field },
            }));
    },

    /**
     * Per Page - each wiki page becomes one chunk while preserving page metadata.
     */
    per_page: (pages, options) => {
        if (!Array.isArray(pages)) {
            const text = typeof pages === 'string' ? pages : (pages.text || String(pages));
            return [text];
        }
        return pages.map(p => {
            if (typeof p === 'string') {
                return { text: p, metadata: {} };
            }
            return {
                text: p.text || '',
                metadata: { ...(p.metadata || {}) },
            };
        });
    },

    /**
     * Combined - merge all content then chunk with adaptive
     */
    combined: (content, options) => {
        let combined = '';

        if (typeof content === 'object' && !Array.isArray(content)) {
            combined = Object.values(content)
                .filter(v => v && typeof v === 'string')
                .join('\n\n');
        } else if (Array.isArray(content)) {
            combined = content.map(t => typeof t === 'string' ? t : (t.text || '')).join('\n\n');
        } else {
            combined = String(content);
        }

        return adaptiveChunk(combined, options);
    },

    /**
     * Dialogue-aware - keeps quoted speech intact
     */
    dialogue: (text, options) => {
        if (typeof text !== 'string') {
            return [String(text)];
        }

        const dialogueRegex = /"[^"]+"|'[^']+'|「[^」]+」|『[^』]+』/g;
        let chunks = [];
        let currentChunk = '';
        let lastIndex = 0;

        let match;
        while ((match = dialogueRegex.exec(text)) !== null) {
            const before = text.slice(lastIndex, match.index);
            currentChunk += before;

            const dialogue = match[0];

            if (currentChunk.length + dialogue.length <= options.chunkSize) {
                currentChunk += dialogue;
            } else {
                if (currentChunk.trim()) chunks.push(currentChunk.trim());
                currentChunk = dialogue;
            }

            lastIndex = match.index + dialogue.length;
        }

        currentChunk += text.slice(lastIndex);
        if (currentChunk.trim()) chunks.push(currentChunk.trim());

        // Split any oversized chunks
        const finalChunks = [];
        for (const chunk of chunks) {
            if (chunk.length <= options.chunkSize) {
                finalChunks.push(chunk);
            } else {
                finalChunks.push(...adaptiveChunk(chunk, options));
            }
        }

        return finalChunks;
    },
};

/**
 * Adaptive chunking - splits at natural boundaries respecting size limits
 * Tries: paragraphs → sentences → words
 */
function adaptiveChunk(text, options) {
    if (typeof text !== 'string') {
        return [String(text)];
    }

    const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
    const chunks = [];
    const paragraphs = text.split(/\n\n+/).filter(p => p.trim());

    let currentChunk = '';

    for (const para of paragraphs) {
        const trimmedPara = para.trim();
        if (!trimmedPara) continue;

        if (currentChunk.length + trimmedPara.length + 2 > chunkSize) {
            if (currentChunk) {
                chunks.push(currentChunk.trim());
                currentChunk = '';
            }

            if (trimmedPara.length > chunkSize) {
                chunks.push(...splitLargeParagraph(trimmedPara, chunkSize));
            } else {
                currentChunk = trimmedPara;
            }
        } else {
            currentChunk += (currentChunk ? '\n\n' : '') + trimmedPara;
        }
    }

    if (currentChunk) chunks.push(currentChunk.trim());

    return chunks.length > 0 ? chunks : [text];
}

/**
 * Splits a large paragraph at sentence boundaries, then words if needed
 */
function splitLargeParagraph(text, maxSize) {
    validateOverlap(maxSize,0);
    // Prefer sentence boundaries, then words. Long unbroken words still need
    // bounded output; use code-point-safe cuts to avoid partial surrogate pairs.
    const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
    const parts=[];
    for (const sentence of sentences) {
        if (!sentence.trim()) continue;
        if (sentence.length<=maxSize) {parts.push(sentence.trim());continue;}
        const words=sentence.trim().split(/\s+/);
        for (const word of words) {
            if (word.length<=maxSize) {parts.push(word);continue;}
            let rest=word;
            while (rest.length) {
                let cut=Math.min(maxSize,rest.length);
                if (cut<rest.length && /[\uD800-\uDBFF]/.test(rest[cut-1])) cut--;
                if (cut<=0) throw new Error('C13: chunkSize too small for a Unicode character');
                parts.push(rest.slice(0,cut));rest=rest.slice(cut);
            }
        }
    }
    const chunks=[];let current='';
    for (const part of parts) {
        if (!part) continue;
        if (current && current.length+1+part.length>maxSize) {chunks.push(current);current='';}
        if (part.length>maxSize) throw new Error('C13: failed to bound oversized text');
        current += (current?' ':'')+part;
    }
    if (current) chunks.push(current);
    return chunks;
}

/**
 * Get available strategies
 */
export function getAvailableStrategies() {
    return Object.keys(STRATEGIES);
}

/**
 * Check if a strategy is unit-based (doesn't use size controls)
 */
export function isUnitStrategy(strategyId) {
    return ['per_message', 'conversation_turns', 'message_batch', 'per_entry', 'per_field'].includes(strategyId);
}

/**
 * Get chat-specific strategies
 */
export function getChatStrategies() {
    // Live chat does not expose adaptive until C02/C07 migration can commit.
    return ['per_message', 'conversation_turns', 'message_batch', 'per_scene'];
}

/**
 * C13 dry-run plan for non-destructive chunk-strategy rebuilds. A new physical
 * collection ID is mandatory; these plans are not authorization to delete or
 * mutate the old collection. Activation remains behind C02/C06 proof gates.
 */
export function planChunkStrategyRebuild({oldCollectionKey, newCollectionKey, strategy, oldChunkerVersion = 1, newChunkerVersion = CHUNKER_VERSION, sourceRecordCount} = {}) {
    if (!oldCollectionKey || !newCollectionKey || oldCollectionKey === newCollectionKey)
        throw new Error('C13: rebuild requires a distinct, qualified destination collection');
    const valid = key => /^((standard|qdrant|milvus|lancedb):[^:]+:[^:]+)$/.test(key);
    if (!valid(oldCollectionKey) || !valid(newCollectionKey)) throw new Error('C13: invalid qualified collection key');
    if (!['adaptive','per_scene','sentence','dialogue'].includes(strategy))
        throw new Error('C13: unsupported versioned rebuild strategy');
    if (!Number.isSafeInteger(sourceRecordCount) || sourceRecordCount < 0)
        throw new Error('C13: rebuild requires an independently verified record count');
    if (!Number.isSafeInteger(oldChunkerVersion) || !Number.isSafeInteger(newChunkerVersion) || newChunkerVersion <= oldChunkerVersion)
        throw new Error('C13: new chunker version must advance');
    return Object.freeze({kind:'c13-chunker-rebuild',status:'dry-run',
        oldCollectionKey,newCollectionKey,strategy,oldChunkerVersion,newChunkerVersion,
        sourceRecordCount,preservesOriginal:true,requiresVerifiedC02Commit:true,
        requiresCompleteReferenceMigration:true,automaticActivation:false});
}
