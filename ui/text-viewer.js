/**
 * Read-only window with the full text of one chunk. Used by the Vectorize
 * dialog's chunk preview. Closing it (×, Close, Escape, a click outside)
 * returns to what was open before; nothing else changes.
 */
import { escapeHtml } from '../utils/html.js';

/**
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.text
 * @param {Array<string|{text: string}>} [options.keywords]
 * @param {Element|JQuery} options.appendTo where the window goes (it covers this element)
 * @param {Element|null} [options.returnFocusTo] focused again after closing
 * @param {boolean} [options.fixed] cover the whole screen (for a scrolling dialog)
 */
export function openTextViewer({ title, text, keywords = [], appendTo, returnFocusTo = null, fixed = false }) {
    $('.vecthare-chunk-text-viewer').remove();
    const body = typeof text === 'string' ? text : '';
    const words = body.split(/\s+/).filter(Boolean).length;
    const list = Array.isArray(keywords) ? keywords : [];
    const keywordLine = list.length
        ? `<div class="vecthare-chunk-text-viewer-keywords"><i class="fa-solid fa-key"></i> ${list.map(kw => escapeHtml(kw?.text ?? kw)).join(', ')}</div>` : '';

    const overlay = $(`
        <div class="vecthare-editor-overlay vecthare-chunk-text-viewer${fixed ? ' vecthare-chunk-text-viewer-fixed' : ''}" role="dialog" aria-modal="true" aria-label="Full chunk text">
            <div class="vecthare-editor-dialog">
                <div class="vecthare-editor-header">
                    <h3><i class="fa-solid fa-file-lines"></i> ${escapeHtml(title || 'Chunk')}</h3>
                    <button class="vecthare-editor-close vecthare-chunk-text-viewer-x" title="Close">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
                <div class="vecthare-editor-body">
                    <div class="vecthare-chunk-text-viewer-meta">${escapeHtml(body.length)} characters · ${escapeHtml(words)} words</div>
                    <div class="vecthare-chunk-text-viewer-text" tabindex="0">${body ? escapeHtml(body) : '<em>(no text)</em>'}</div>
                    ${keywordLine}
                </div>
                <div class="vecthare-chunk-text-viewer-footer">
                    <button class="menu_button vecthare-chunk-text-viewer-copy" title="Copy the full text"><i class="fa-solid fa-copy"></i> Copy</button>
                    <button class="menu_button vecthare-chunk-text-viewer-close">Close</button>
                </div>
            </div>
        </div>
    `);
    const close = () => {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        if (returnFocusTo && document.contains(returnFocusTo)) returnFocusTo.focus?.();
    };
    // Escape closes only this window, not the dialog behind it.
    const onKey = e => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        close();
    };
    document.addEventListener('keydown', onKey, true);
    // SillyTavern closes drawers on mousedown/touchstart; keep it inside.
    overlay.on('mousedown touchstart', e => e.stopPropagation());
    overlay.on('click', function (e) {
        e.stopPropagation();
        if (e.target === this) close();
    });
    overlay.find('.vecthare-chunk-text-viewer-x, .vecthare-chunk-text-viewer-close').on('click', e => { e.preventDefault(); close(); });
    overlay.find('.vecthare-chunk-text-viewer-copy').on('click', async e => {
        e.preventDefault();
        try {
            await navigator.clipboard.writeText(body);
            toastr.success('Chunk text copied', 'VectHare', { timeOut: 2000 });
        } catch {
            // older browsers / no clipboard permission: select it for Ctrl+C
            const range = document.createRange();
            range.selectNodeContents(overlay.find('.vecthare-chunk-text-viewer-text')[0]);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            toastr.info('Text selected - press Ctrl+C (Cmd+C) to copy', 'VectHare', { timeOut: 4000 });
        }
    });
    $(appendTo).append(overlay);
    overlay.find('.vecthare-chunk-text-viewer-close').trigger('focus');
    return close;
}
