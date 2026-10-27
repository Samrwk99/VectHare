/**
 * ============================================================================
 * VECTHARE TEXT CLEANING MANAGER
 * ============================================================================
 * Standalone UI for managing text cleaning regex patterns.
 * Accessible from the Actions panel.
 *
 * @author Coneja Chibi
 * @version 1.0.0
 * ============================================================================
 */

import { saveSettingsDebounced } from '../../../../../script.js';
import { uuidv4 } from '../../../../utils.js';
import {
    BUILTIN_PATTERNS,
    CLEANING_PRESETS,
    getCleaningSettings,
    saveCleaningSettings,
    preparePatternImport,
    testPattern,
} from '../core/text-cleaning.js';

/**
 * Opens the Text Cleaning Manager modal
 */
let cleaningManagerDraft = null;
let cleaningManagerSession = 0;

function copyCleaningSettings(settings) {
    return {
        ...settings,
        customPatterns: (settings.customPatterns || []).map(p => ({ ...p })),
        enabledBuiltins: [...(settings.enabledBuiltins || [])],
    };
}

/** Read and validate the entire modal without modifying stored settings. */
function collectCleaningDraft() {
    const draft = copyCleaningSettings(cleaningManagerDraft);
    draft.selectedPreset = $('#vecthare_tcm_preset').val();
    if (draft.selectedPreset !== 'custom' && !Object.hasOwn(CLEANING_PRESETS, draft.selectedPreset)) {
        return { success: false, error: 'Select a valid cleaning preset' };
    }
    draft.enabledBuiltins = [];
    $('#vecthare_tcm_builtin_patterns input:checked').each(function() {
        draft.enabledBuiltins.push($(this).data('id'));
    });
    const updates = [];
    let error = null;
    $('#vecthare_tcm_custom_patterns .vecthare-tcm-custom-item').each(function() {
        const field = $(this).find('.vecthare-tcm-custom-pattern');
        const rawPattern = field.val();
        const enabled = $(this).find('.vecthare-tcm-custom-enabled').is(':checked');
        const parsed = parseRegexString(rawPattern);
        const validation = parsed ? validateRegex(parsed.pattern, parsed.flags) : { valid: !enabled, error: 'Enabled patterns cannot be empty' };
        if (!validation.valid || (enabled && !parsed?.pattern)) {
            field.css('border-color', 'var(--vecthare-danger)');
            error = `Invalid regex: ${validation.error || 'Enabled patterns cannot be empty'}`;
            return false;
        }
        field.css('border-color', '');
        updates.push({
            id: $(this).data('id'),
            enabled,
            name: $(this).find('.vecthare-tcm-custom-name').val(),
            pattern: parsed?.pattern || '',
            replacement: $(this).find('.vecthare-tcm-custom-replacement').val(),
            flags: parsed?.flags || 'gi',
        });
    });
    if (error) return { success: false, error };
    const existing = new Map(draft.customPatterns.map(pattern => [String(pattern.id), pattern]));
    draft.customPatterns = updates.map(update => ({ ...existing.get(String(update.id)), ...update }));
    return { success: true, settings: draft };
}

function refreshDraftPatterns() {
    $('#vecthare_tcm_custom_patterns').html(renderCustomPatterns(cleaningManagerDraft.customPatterns));
    rebindDeleteHandlers();
}

export function openTextCleaningManager() {
    // Remove existing modal if present
    $('#vecthare_text_cleaning_modal').remove();

    const settings = copyCleaningSettings(getCleaningSettings());
    cleaningManagerDraft = settings;
    cleaningManagerSession++;

    const html = `
        <div id="vecthare_text_cleaning_modal" class="vecthare-modal">
            <div class="vecthare-modal-overlay"></div>
            <div class="vecthare-modal-content vecthare-text-cleaning-content">
                <div class="vecthare-modal-header">
                    <h3>
                        <i class="fa-solid fa-broom"></i>
                        Text Cleaning Manager
                    </h3>
                    <button class="vecthare-modal-close" id="vecthare_tcm_close">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>

                <div class="vecthare-tcm-body">
                    <p class="vecthare-tcm-intro">
                        Configure regex patterns to clean text before vectorization.
                        Patterns are applied in order to remove HTML tags, metadata, and unwanted content.
                    </p>

                    <!-- Current Preset Display -->
                    <div class="vecthare-tcm-section">
                        <div class="vecthare-tcm-section-header">
                            <h4>Active Preset</h4>
                        </div>
                        <div class="vecthare-tcm-preset-info">
                            <select id="vecthare_tcm_preset" class="vecthare-select">
                                ${Object.entries(CLEANING_PRESETS).map(([id, preset]) => `
                                    <option value="${id}" ${settings.selectedPreset === id ? 'selected' : ''}>
                                        ${preset.name}
                                    </option>
                                `).join('')}
                                <option value="custom" ${settings.selectedPreset === 'custom' ? 'selected' : ''}>
                                    Custom
                                </option>
                            </select>
                            <span class="vecthare-tcm-preset-desc" id="vecthare_tcm_preset_desc">
                                ${getPresetDescription(settings.selectedPreset)}
                            </span>
                        </div>
                    </div>

                    <!-- Built-in Patterns -->
                    <div class="vecthare-tcm-section">
                        <div class="vecthare-tcm-section-header">
                            <h4>Built-in Patterns</h4>
                            <span class="vecthare-tcm-hint">Used when preset is "Custom"</span>
                        </div>
                        <div class="vecthare-tcm-patterns-grid" id="vecthare_tcm_builtin_patterns">
                            ${Object.values(BUILTIN_PATTERNS).map(p => `
                                <label class="vecthare-tcm-pattern-item" title="${escapeHtml(p.pattern)}">
                                    <input type="checkbox" data-id="${p.id}"
                                           ${settings.enabledBuiltins?.includes(p.id) ? 'checked' : ''}>
                                    <div class="vecthare-tcm-pattern-info">
                                        <span class="vecthare-tcm-pattern-name">${p.name}</span>
                                        <code class="vecthare-tcm-pattern-regex">${escapeHtml(p.pattern.substring(0, 40))}${p.pattern.length > 40 ? '...' : ''}</code>
                                    </div>
                                </label>
                            `).join('')}
                        </div>
                    </div>

                    <!-- Custom Patterns -->
                    <div class="vecthare-tcm-section">
                        <div class="vecthare-tcm-section-header">
                            <h4>Custom Patterns</h4>
                            <div class="vecthare-tcm-actions">
                                <button class="vecthare-btn-sm vecthare-btn-secondary" id="vecthare_tcm_add_pattern">
                                    <i class="fa-solid fa-plus"></i> Add
                                </button>
                                <button class="vecthare-btn-sm vecthare-btn-secondary" id="vecthare_tcm_save_template">
                                    <i class="fa-solid fa-bookmark"></i> Save Template
                                </button>
                                <button class="vecthare-btn-sm vecthare-btn-secondary" id="vecthare_tcm_import">
                                    <i class="fa-solid fa-upload"></i> Import
                                </button>
                                <button class="vecthare-btn-sm vecthare-btn-secondary" id="vecthare_tcm_export">
                                    <i class="fa-solid fa-download"></i> Export
                                </button>
                                <input type="file" id="vecthare_tcm_import_file" accept=".json" hidden>
                            </div>
                        </div>
                        <div class="vecthare-tcm-custom-list" id="vecthare_tcm_custom_patterns">
                            ${renderCustomPatterns(settings.customPatterns || [])}
                        </div>
                    </div>

                    <!-- Pattern Tester -->
                    <div class="vecthare-tcm-section">
                        <div class="vecthare-tcm-section-header">
                            <h4>Pattern Tester</h4>
                        </div>
                        <div class="vecthare-tcm-tester">
                            <div class="vecthare-tcm-tester-row">
                                <input type="text" id="vecthare_tcm_test_pattern" placeholder="Find regex (e.g. /pattern/gi)" class="vecthare-input">
                                <input type="text" id="vecthare_tcm_test_replacement" placeholder="Replace with" class="vecthare-input">
                                <button class="vecthare-btn-primary" id="vecthare_tcm_test_run">
                                    <i class="fa-solid fa-play"></i> Test
                                </button>
                            </div>
                            <textarea id="vecthare_tcm_test_input" rows="3" placeholder="Sample text to test against..." class="vecthare-textarea"></textarea>
                            <div class="vecthare-tcm-test-result" id="vecthare_tcm_test_result"></div>
                        </div>
                    </div>
                </div>

                <div class="vecthare-modal-footer">
                    <button class="vecthare-btn-secondary" id="vecthare_tcm_cancel">Close</button>
                    <button class="vecthare-btn-primary" id="vecthare_tcm_save">
                        <i class="fa-solid fa-save"></i> Save Changes
                    </button>
                </div>
            </div>
        </div>
    `;

    $('body').append(html);
    $('#vecthare_text_cleaning_modal').fadeIn(200);

    bindEvents();
}

/**
 * Gets preset description
 */
function getPresetDescription(presetId) {
    const descriptions = {
        none: 'No cleaning applied - text vectorized as-is',
        html_formatting: 'Removes font, color, bold/italic tags but keeps text content',
        metadata_blocks: 'Removes hidden divs and details/summary sections',
        ai_reasoning: 'Removes <thinking> and <tucao> AI reasoning tags',
        comprehensive: 'All formatting, metadata, and reasoning tags removed',
        nuclear: 'Strips ALL HTML tags - plain text only',
        custom: 'Uses your selected built-in and custom patterns',
    };
    return descriptions[presetId] || '';
}

/**
 * Renders custom patterns list
 */
function renderCustomPatterns(patterns) {
    if (!patterns || patterns.length === 0) {
        return `<div class="vecthare-tcm-empty">No custom patterns. Click "Add" or "Import" to create patterns.</div>`;
    }

    return patterns.map(p => {
        // Convert old format (pattern + flags) to /pattern/flags format if needed
        let displayPattern = p.pattern || '';
        if (displayPattern && !displayPattern.startsWith('/') && p.flags) {
            displayPattern = `/${displayPattern}/${p.flags}`;
        }

        return `
            <div class="vecthare-tcm-custom-item" data-id="${p.id}">
                <input type="checkbox" class="vecthare-tcm-custom-enabled" ${p.enabled !== false ? 'checked' : ''} title="Enable/disable">
                <input type="text" class="vecthare-tcm-custom-name" value="${escapeHtml(p.name)}" placeholder="Name">
                <input type="text" class="vecthare-tcm-custom-pattern" value="${escapeHtml(displayPattern)}" placeholder="/pattern/gi">
                <input type="text" class="vecthare-tcm-custom-replacement" value="${escapeHtml(p.replacement || '')}" placeholder="Replace with (empty = remove)">
                <button class="vecthare-btn-icon vecthare-btn-danger" data-action="delete" title="Delete">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        `;
    }).join('');
}

/**
 * Escapes HTML entities
 */
function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
}

/**
 * Parses a regex string in /pattern/flags format (like ST's native regex)
 * Also accepts plain patterns (assumes 'gi' flags)
 * @param {string} input - Regex string
 * @returns {{pattern: string, flags: string}|null}
 */
function parseRegexString(input) {
    if (!input) return null;

    // Try to parse /pattern/flags format
    const match = input.match(/^\/([\s\S]*)\/([a-z]*)$/i);
    if (match) {
        return { pattern: match[1], flags: match[2] || 'g' };
    }

    // Plain pattern - use default flags
    return { pattern: input, flags: 'gi' };
}

/**
 * Validates a regex pattern
 * @param {string} pattern
 * @param {string} flags
 * @returns {{valid: boolean, error?: string}}
 */
function validateRegex(pattern, flags) {
    try {
        new RegExp(pattern, flags);
        return { valid: true };
    } catch (e) {
        return { valid: false, error: e.message };
    }
}

/**
 * Rebinds delete handlers for custom patterns (scoped to modal, not document)
 */
function rebindDeleteHandlers() {
    $('#vecthare_tcm_custom_patterns [data-action="delete"]').off('click').on('click', function() {
        // First preserve any unsaved field edits, then remove from the draft only.
        const current = collectCleaningDraft();
        if (!current.success) {
            toastr.error(current.error, 'VectHare');
            return;
        }
        cleaningManagerDraft = current.settings;
        const id = String($(this).closest('.vecthare-tcm-custom-item').data('id'));
        cleaningManagerDraft.customPatterns = cleaningManagerDraft.customPatterns.filter(p => String(p.id) !== id);
        refreshDraftPatterns();
    });
}

/**
 * Binds event handlers
 */
function bindEvents() {
    // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
    $('#vecthare_text_cleaning_modal').on('mousedown touchstart', function(e) {
        e.stopPropagation();
    });

    // Close handlers
    $('#vecthare_tcm_close, #vecthare_tcm_cancel').on('click', closeModal);
    $('#vecthare_text_cleaning_modal .vecthare-modal-overlay').on('click', closeModal);

    // Preset change
    $('#vecthare_tcm_preset').on('change', function() {
        const presetId = $(this).val();
        $('#vecthare_tcm_preset_desc').text(getPresetDescription(presetId));
    });

    // Add pattern to modal draft. Close/Cancel discards it.
    $('#vecthare_tcm_add_pattern').on('click', () => {
        const current = collectCleaningDraft();
        if (!current.success) {
            toastr.error(current.error, 'VectHare');
            return;
        }
        cleaningManagerDraft = current.settings;
        cleaningManagerDraft.customPatterns.push({
            id: uuidv4(), name: 'New Pattern', pattern: '', replacement: '',
            flags: 'gi', enabled: false, builtin: false,
        });
        refreshDraftPatterns();
    });

    // Initial bind for delete handlers
    rebindDeleteHandlers();

    // Import patterns
    $('#vecthare_tcm_import').on('click', () => {
        $('#vecthare_tcm_import_file').click();
    });

    $('#vecthare_tcm_import_file').on('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        const session = cleaningManagerSession;
        reader.onload = (event) => {
            if (session !== cleaningManagerSession || !$('#vecthare_text_cleaning_modal').length) return;
            const current = collectCleaningDraft();
            if (!current.success) {
                toastr.error(current.error, 'VectHare');
                return;
            }
            const result = preparePatternImport(event.target.result, current.settings);
            if (!result.success) {
                toastr.error(`Import failed: ${result.error}`, 'VectHare');
                return;
            }
            cleaningManagerDraft = result.settings;
            $('#vecthare_tcm_preset').val(cleaningManagerDraft.selectedPreset);
            $('#vecthare_tcm_preset_desc').text(getPresetDescription(cleaningManagerDraft.selectedPreset));
            $('#vecthare_tcm_builtin_patterns input').each(function() {
                $(this).prop('checked', cleaningManagerDraft.enabledBuiltins.includes($(this).data('id')));
            });
            refreshDraftPatterns();
            toastr.success(result.isTemplate
                ? `Template "${result.templateName}" staged (${result.count} new patterns)`
                : `Staged ${result.count} patterns. Save Changes to apply.`, 'VectHare');
        };
        reader.onerror = () => toastr.error('Unable to read the pattern file', 'VectHare');
        reader.readAsText(file);
        $(this).val('');
    });

    // Save as template (prompts for name, saves full config)
    $('#vecthare_tcm_save_template').on('click', () => {
        const templateName = prompt('Enter a name for this template:', 'My Cleaning Template');
        if (!templateName) return;

        const current = collectCleaningDraft();
        if (!current.success) {
            toastr.error(current.error, 'VectHare');
            return;
        }
        const settings = current.settings;
        const currentPreset = settings.selectedPreset;
        const enabledBuiltins = settings.enabledBuiltins;

        const template = {
            name: templateName,
            version: '1.0',
            createdAt: new Date().toISOString(),
            preset: currentPreset,
            enabledBuiltins: enabledBuiltins,
            customPatterns: settings.customPatterns || [],
        };

        const json = JSON.stringify(template, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `vecthare-template-${templateName.toLowerCase().replace(/\s+/g, '-')}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toastr.success(`Template "${templateName}" saved`, 'VectHare');
    });

    // Export patterns (custom patterns only)
    $('#vecthare_tcm_export').on('click', () => {
        const current = collectCleaningDraft();
        if (!current.success) {
            toastr.error(current.error, 'VectHare');
            return;
        }
        const json = JSON.stringify(current.settings.customPatterns, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'vecthare-cleaning-patterns.json';
        a.click();
        URL.revokeObjectURL(url);
        toastr.success('Patterns exported', 'VectHare');
    });

    // Test pattern
    $('#vecthare_tcm_test_run').on('click', () => {
        const rawPattern = $('#vecthare_tcm_test_pattern').val();
        const replacement = $('#vecthare_tcm_test_replacement').val();
        const sampleText = $('#vecthare_tcm_test_input').val();

        if (!rawPattern || !sampleText) {
            toastr.warning('Enter a pattern and sample text');
            return;
        }

        const parsed = parseRegexString(rawPattern);
        if (!parsed) {
            toastr.error('Invalid pattern format');
            return;
        }

        const result = testPattern(parsed.pattern, parsed.flags, replacement, sampleText);
        const resultEl = $('#vecthare_tcm_test_result');

        if (result.success) {
            resultEl.html(`
                <div class="vecthare-tcm-test-success">
                    <strong>Result:</strong>
                    <pre>${escapeHtml(result.result)}</pre>
                </div>
            `);
        } else {
            resultEl.html(`
                <div class="vecthare-tcm-test-error">
                    <i class="fa-solid fa-times-circle"></i> ${escapeHtml(result.error)}
                </div>
            `);
        }
    });

    // One validated settings commit. A failed field leaves stored settings untouched.
    $('#vecthare_tcm_save').on('click', () => {
        const current = collectCleaningDraft();
        if (!current.success) {
            toastr.error(current.error, 'VectHare');
            return;
        }
        saveCleaningSettings(current.settings);
        saveSettingsDebounced();
        toastr.success('Text cleaning settings saved', 'VectHare');
        closeModal();
    });
}

/**
 * Closes the modal
 */
function closeModal() {
    cleaningManagerDraft = null;
    cleaningManagerSession++;
    $('#vecthare_text_cleaning_modal').fadeOut(200, function() {
        $(this).remove();
    });
}
