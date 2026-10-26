/** Unicode-aware lexical segmentation shared by BM25 and keyword extraction. */
export function normalizeLexicalText(text) {
    return String(text ?? '').normalize('NFKC').toLocaleLowerCase();
}

/** Return repeated terms, not a set: document term frequency requires occurrences. */
export function lexicalTokens(text, { minLength = 1 } = {}) {
    const normalized = normalizeLexicalText(text);
    const matches = normalized.match(/[\p{L}\p{N}]+/gu) || [];
    const result = [];
    for (const token of matches) {
        if (Array.from(token).length >= minLength) result.push(token);
        // CJK text often has no spaces. Add overlapping bigrams as a portable
        // fallback so overlapping phrases can match without Intl.Segmenter.
        if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(token)) {
            const chars = Array.from(token);
            if (chars.length > 2) {
                for (let i = 0; i < chars.length - 1; i++) {
                    const pair = chars.slice(i, i + 2).join('');
                    if (Array.from(pair).length >= minLength) result.push(pair);
                }
            }
        }
    }
    return result;
}

/** Whole token / contiguous phrase match; unlike includes, rejects word fragments. */
export function containsLexicalPhrase(text, phrase) {
    const query = normalizeLexicalText(text);
    const target = normalizeLexicalText(phrase).trim();
    if (!target) return false;
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(target) &&
        !/\s/u.test(target)) {
        return lexicalTokens(query).includes(target);
    }
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // A token is bounded by Unicode letters/numbers, not only ASCII \w.
    const flexible = escaped.replace(/\s+/g, '\\s+');
    return new RegExp(`(?<![\\p{L}\\p{N}])${flexible}(?![\\p{L}\\p{N}])`, 'u').test(query);
}
