/**
 * VH-043: protection against user regex patterns that take exponential time
 * ("catastrophic backtracking"), such as /(a+)+$/ or /(\w+\s?)*$/.
 *
 * A browser cannot interrupt a running regex, so a bad pattern in a trigger or
 * condition froze the tab on every generation. This module:
 *   - spots the usual shape of such patterns statically (a repeated group whose
 *     body is itself one repeated item, possibly with optional items around it);
 *   - lets triggers/conditions skip such a pattern (and say so, once);
 *   - caps how much text a trigger/condition scans;
 *   - reports a pattern that still ran slowly, naming it, and stops using it
 *     for the rest of the session where skipping is safe.
 *
 * The static check is a heuristic: it catches the classic forms and has no
 * false positives on ordinary patterns such as (\s*\n)+, but it cannot prove a
 * pattern safe (e.g. overlapping alternations like (a|aa)+ are not detected).
 */

/** Text a trigger or condition looks at: the most recent part of the chat. */
export const MAX_PATTERN_SCAN_CHARS = 10000;
/** A single match slower than this is reported. */
export const SLOW_PATTERN_MS = 250;

const UNBOUNDED = /^(?:[+*]|\{\d+,\})/;
const ANY_QUANT = /^(?:[+*?]|\{\d+(?:,\d*)?\})/;

/**
 * Splits a regex source into top-level atoms with their quantifiers.
 * Groups are returned with their inner source.
 * @param {string} src
 * @returns {{atom: string, group: string|null, quant: string, alternation?: boolean}[]}
 */
function atomsOf(src) {
    const atoms = [];
    let i = 0;
    while (i < src.length) {
        const ch = src[i];
        let atom = ''; let group = null;
        if (ch === '|') { atoms.push({ atom: '|', group: null, quant: '', alternation: true }); i++; continue; }
        if (ch === '\\') { atom = src.slice(i, i + 2); i += 2;
            // \u{…}, \p{…}, \k<…>
            if (/^[pPuk]$/.test(atom[1]) && (src[i] === '{' || src[i] === '<')) {
                const close = src.indexOf(src[i] === '{' ? '}' : '>', i); if (close > 0) { atom += src.slice(i, close + 1); i = close + 1; }
            }
        } else if (ch === '[') {
            let j = i + 1; if (src[j] === '^') j++; if (src[j] === ']') j++;
            while (j < src.length && src[j] !== ']') { if (src[j] === '\\') j++; j++; }
            atom = src.slice(i, j + 1); i = j + 1;
        } else if (ch === '(') {
            let depth = 0; let j = i;
            for (; j < src.length; j++) {
                if (src[j] === '\\') { j++; continue; }
                if (src[j] === '[') { while (j < src.length && src[j] !== ']') { if (src[j] === '\\') j++; j++; } continue; }
                if (src[j] === '(') depth++;
                else if (src[j] === ')' && --depth === 0) break;
            }
            atom = src.slice(i, j + 1);
            group = atom.slice(1, -1).replace(/^\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/, '');
            if (/^\?(?:=|!|<=|<!)/.test(atom.slice(1))) group = null; // lookarounds repeat nothing
            i = j + 1;
        } else if (ch === '^' || ch === '$') { atom = ch; i++; atoms.push({ atom, group: null, quant: '', anchor: true }); continue; }
        else { atom = ch; i++; }
        const q = src.slice(i).match(ANY_QUANT);
        let quant = q ? q[0] : '';
        i += quant.length;
        if (src[i] === '?' || src[i] === '+') i++; // lazy / possessive marker
        atoms.push({ atom, group, quant });
    }
    return atoms;
}

const optional = quant => quant === '?' || quant === '*' || /^\{0(?:,\d*)?\}$/.test(quant);

/** Does this (group body) source contain an unbounded repetition anywhere? */
function hasUnbounded(src) {
    return atomsOf(src).some(a => UNBOUNDED.test(a.quant) || (a.group !== null && hasUnbounded(a.group)));
}

/**
 * Is a repeated group's body "one repeated item" - the shape that backtracks
 * exponentially when the overall match fails? Every alternative is checked.
 */
function bodyIsSingleRepeat(body) {
    const alternatives = [[]];
    for (const a of atomsOf(body)) {
        if (a.alternation) alternatives.push([]); else if (!a.anchor) alternatives[alternatives.length - 1].push(a);
    }
    return alternatives.some(alt => {
        const required = alt.filter(a => !optional(a.quant));
        const repeating = alt.filter(a => UNBOUNDED.test(a.quant) || (a.group !== null && hasUnbounded(a.group)));
        // e.g. (a+), (\w+\s?), ([a-z]*), ((ab)+) : one repeating item and nothing
        // else that must match in each round.
        return repeating.length >= 1 && required.length <= 1 &&
            (required.length === 0 || repeating.includes(required[0]));
    });
}

/**
 * VH-043: answers a short reason when the pattern has the shape that freezes
 * the page (nested unbounded repetition), otherwise null.
 * @param {string} source Regex source (without slashes)
 * @returns {string|null}
 */
export function riskyRegexReason(source) {
    const src = String(source ?? '');
    const visit = (s) => {
        for (const a of atomsOf(s)) {
            if (a.group === null) continue;
            if (UNBOUNDED.test(a.quant) && bodyIsSingleRepeat(a.group)) {
                return `the repeated group ${a.atom}${a.quant} repeats something that is itself repeated, ` +
                    'which can take minutes on some text';
            }
            const inner = visit(a.group);
            if (inner) return inner;
        }
        return null;
    };
    try { return visit(src); } catch { return null; }
}

const reported = new Set();
const disabled = new Set();

/**
 * Tells the user once per session about a pattern that is skipped or slow.
 * @param {string} key
 * @param {string} message
 */
function reportOnce(key, message) {
    if (reported.has(key)) return;
    reported.add(key);
    console.warn(`VectHare: ${message}`);
    try {
        globalThis.toastr?.warning?.(message, 'VectHare', { timeOut: 15000 });
    } catch { /* no toast in this context */ }
}

/**
 * Tests a trigger or condition pattern safely: a risky pattern (or one that ran
 * slowly before) is skipped and counts as "no match"; only the last
 * MAX_PATTERN_SCAN_CHARS characters of the text are scanned; a slow match is
 * reported with the pattern and not used again this session.
 * @param {RegExp} regex
 * @param {string} text
 * @param {string} where Where the pattern comes from, for the message
 * @returns {boolean}
 */
export function safePatternTest(regex, text, where = 'pattern') {
    const label = `/${regex.source}/${regex.flags}`;
    if (disabled.has(label)) return false;
    const reason = riskyRegexReason(regex.source);
    if (reason) {
        disabled.add(label);
        reportOnce(label, `A ${where} ${label} is not used: ${reason}. Edit it, e.g. remove the outer repetition.`);
        return false;
    }
    const value = String(text ?? '');
    const scanned = value.length > MAX_PATTERN_SCAN_CHARS ? value.slice(-MAX_PATTERN_SCAN_CHARS) : value;
    regex.lastIndex = 0;
    const started = Date.now();
    const result = regex.test(scanned);
    const took = Date.now() - started;
    if (took > SLOW_PATTERN_MS) {
        disabled.add(label);
        reportOnce(label, `A ${where} ${label} took ${took} ms to check and is not used for the rest of this ` +
            'session. Simplify it.');
    }
    return result;
}

/**
 * Times a text-cleaning replacement. Cleaning patterns are never skipped here
 * (that would change chunk text and hashes); a slow one is only reported.
 * @param {RegExp} regex
 * @param {string} text
 * @param {string} replacement
 * @param {string} name
 * @returns {string}
 */
export function timedCleaningReplace(regex, text, replacement, name) {
    const started = Date.now();
    const result = text.replace(regex, replacement);
    const took = Date.now() - started;
    if (took > SLOW_PATTERN_MS) {
        const label = `/${regex.source}/${regex.flags}`;
        reportOnce(`clean:${label}`, `The text-cleaning pattern "${name || label}" took ${took} ms on one message. ` +
            `Simplify it in Text Cleaning${riskyRegexReason(regex.source) ? ` (${riskyRegexReason(regex.source)})` : ''}.`);
    }
    return result;
}

/** For tests: forget what was reported or switched off this session. */
export function resetSafeRegexState() {
    reported.clear();
    disabled.clear();
}
