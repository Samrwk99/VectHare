/**
 * VH-059: Qdrant stores a chunk's text with a generated ` [KEYWORDS: …]` suffix
 * (backends/qdrant.js) so the keywords are embedded too. Exports and imports
 * work with the original text; this removes exactly that generated suffix
 * (never user-authored tags) and keeps the text otherwise unchanged.
 */
export function stripGeneratedKeywordSuffix(text, keywords) {
    if (typeof text !== 'string' || !text) return text;
    if (!Array.isArray(keywords) || keywords.length === 0) return text;
    const keywordTexts = keywords.map(kw => kw?.text || kw).join(' ');
    const suffix = ` [KEYWORDS: ${keywordTexts}]`;
    const trimmedText = text.trimEnd();
    let originalText = trimmedText;
    while (originalText.endsWith(suffix)) originalText = originalText.slice(0, -suffix.length);
    // VH-103: a chunk whose keywords were edited after it was embedded still
    // carries the suffix built from its OLD keywords (a keyword edit changes the
    // stored keywords, not the embedded text). Trailing generated blocks are
    // removed too, so an export/import does not end with two suffixes. Only for
    // chunks that carry keywords, as before.
    const generatedBlock = / \[KEYWORDS: [^\]\n]*\]$/;
    while (generatedBlock.test(originalText)) originalText = originalText.replace(generatedBlock, '');
    if (originalText === trimmedText) return text;
    if (!originalText.trim()) return text; // a suffix-only chunk stays as it is
    return originalText + text.slice(trimmedText.length);
}
