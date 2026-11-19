/**
 * HTML escaping shared by every UI module (VH-023).
 * Safe for element text and for quoted attribute values ("..." or '...').
 * null/undefined become ''; every other value is converted with String().
 */
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"'`]/g, ch => HTML_ESCAPES[ch]);
}

/**
 * Tagged template that escapes every interpolation. Use rawHtml() for a value
 * that is already trusted HTML (icons, fragments built with html``).
 */
export function html(strings, ...values) {
    let out = strings[0];
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        out += (v && v.__trustedHtml === true) ? v.value
            : Array.isArray(v) ? v.map(x => (x && x.__trustedHtml === true) ? x.value : escapeHtml(x)).join('')
            : escapeHtml(v);
        out += strings[i + 1];
    }
    return out;
}

export function rawHtml(value) {
    return { __trustedHtml: true, value: String(value ?? '') };
}
