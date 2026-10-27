/**
 * ============================================================================
 * VECTHARE TEXT CLEANING
 * ============================================================================
 * Pre-vectorization text cleaning with regex patterns.
 * Strips HTML, metadata blocks, and custom tags before chunking.
 *
 * @author Coneja Chibi
 * @version 1.0.0
 * ============================================================================
 */

import { extension_settings } from '../../../../extensions.js';
import { uuidv4 } from '../../../../utils.js';

// ============================================================================
// BUILT-IN PRESETS
// ============================================================================

/**
 * Built-in cleaning patterns that users can enable
 */
export const BUILTIN_PATTERNS = {
    strip_font_tags: {
        id: 'strip_font_tags',
        name: 'Strip Font Tags (keep text)',
        pattern: '<font[^>]*>([\\s\\S]*?)</font>',
        replacement: '$1',
        flags: 'gi',
        builtin: true,
    },
    strip_color_spans: {
        id: 'strip_color_spans',
        name: 'Strip Color Spans (keep text)',
        pattern: '<span[^>]*style="[^"]*color[^"]*"[^>]*>([\\s\\S]*?)</span>',
        replacement: '$1',
        flags: 'gi',
        builtin: true,
    },
    strip_bold_italic: {
        id: 'strip_bold_italic',
        name: 'Strip Bold/Italic Tags (keep text)',
        pattern: '</?(?:b|i|u|em|strong)>',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
    strip_hidden_divs: {
        id: 'strip_hidden_divs',
        name: 'Strip Hidden Divs',
        pattern: '<div[^>]*style="[^"]*display:\\s*none[^"]*"[^>]*>[\\s\\S]*?(?:</div>|$)',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
    strip_details_blocks: {
        id: 'strip_details_blocks',
        name: 'Strip Details/Summary Blocks',
        pattern: '<details>[\\s\\S]*?</details>',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
    strip_thinking_tags: {
        id: 'strip_thinking_tags',
        name: 'Strip <thinking> Tags',
        pattern: '<thinking>[\\s\\S]*?</thinking>',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
    strip_tucao_tags: {
        id: 'strip_tucao_tags',
        name: 'Strip <tucao> Tags',
        pattern: '<tucao>[\\s\\S]*?</tucao>',
        replacement: '',
        flags: 'gi',
        builtin: true,
    },
    strip_all_html: {
        id: 'strip_all_html',
        name: 'Strip ALL HTML Tags (keep text)',
        pattern: '<[^>]+>',
        replacement: '',
        flags: 'g',
        builtin: true,
    },
};

/**
 * Preset groups for quick selection
 */
export const CLEANING_PRESETS = {
    none: {
        id: 'none',
        name: 'None',
        description: 'No cleaning applied',
        patterns: [],
    },
    html_formatting: {
        id: 'html_formatting',
        name: 'Strip HTML Formatting',
        description: 'Removes font, color, bold/italic tags but keeps the text',
        patterns: ['strip_font_tags', 'strip_color_spans', 'strip_bold_italic'],
    },
    metadata_blocks: {
        id: 'metadata_blocks',
        name: 'Strip Metadata Blocks',
        description: 'Removes hidden divs, details/summary sections',
        patterns: ['strip_hidden_divs', 'strip_details_blocks'],
    },
    ai_reasoning: {
        id: 'ai_reasoning',
        name: 'Strip AI Reasoning Tags',
        description: 'Removes thinking, tucao, and similar tags',
        patterns: ['strip_thinking_tags', 'strip_tucao_tags'],
    },
    comprehensive: {
        id: 'comprehensive',
        name: 'Comprehensive Clean',
        description: 'All formatting, metadata, and reasoning tags',
        patterns: ['strip_font_tags', 'strip_color_spans', 'strip_bold_italic', 'strip_hidden_divs', 'strip_details_blocks', 'strip_thinking_tags', 'strip_tucao_tags'],
    },
    nuclear: {
        id: 'nuclear',
        name: 'Strip All HTML',
        description: 'Removes ALL HTML tags - plain text only',
        patterns: ['strip_all_html'],
    },
};

// ============================================================================
// SETTINGS MANAGEMENT
// ============================================================================

/**
 * Gets the cleaning settings from extension_settings
 * @returns {object} Cleaning settings
 */
export function getCleaningSettings() {
    if (!extension_settings.vecthare) {
        extension_settings.vecthare = {};
    }
    if (!extension_settings.vecthare.cleaning) {
        extension_settings.vecthare.cleaning = {
            selectedPreset: 'none',
            customPatterns: [],
            enabledBuiltins: [],
        };
    }
    return extension_settings.vecthare.cleaning;
}

/**
 * Saves cleaning settings
 * @param {object} settings - Settings to save
 */
export function saveCleaningSettings(settings) {
    if (!extension_settings.vecthare) {
        extension_settings.vecthare = {};
    }
    extension_settings.vecthare.cleaning = settings;
}

/**
 * Gets all active patterns (builtin + custom)
 * @returns {Array<object>} Array of active pattern objects
 */
export function getActivePatterns(presetOverride = undefined) {
    const settings = getCleaningSettings();
    const patterns = [];

    // If using a preset, get its patterns
    const selectedPreset = presetOverride ?? settings.selectedPreset;
    if (selectedPreset && selectedPreset !== 'custom') {
        const preset = CLEANING_PRESETS[selectedPreset];
        if (preset) {
            for (const patternId of preset.patterns) {
                if (BUILTIN_PATTERNS[patternId]) {
                    patterns.push(BUILTIN_PATTERNS[patternId]);
                }
            }
        }
    } else {
        // Custom mode - use enabled builtins + custom patterns
        for (const patternId of (settings.enabledBuiltins || [])) {
            if (BUILTIN_PATTERNS[patternId]) {
                patterns.push(BUILTIN_PATTERNS[patternId]);
            }
        }
        for (const custom of (settings.customPatterns || [])) {
            if (custom.enabled !== false) {
                patterns.push(custom);
            }
        }
    }

    return patterns;
}

// ============================================================================
// TEXT CLEANING
// ============================================================================

/**
 * Applies a single pattern to text
 * @param {string} text - Text to clean
 * @param {object} pattern - Pattern object with pattern, replacement, flags
 * @returns {string} Cleaned text
 */
function applyPattern(text, pattern) {
    try {
        const regex = new RegExp(pattern.pattern, pattern.flags || 'g');
        return text.replace(regex, pattern.replacement || '');
    } catch (e) {
        console.warn(`VectHare: Invalid regex pattern "${pattern.name || pattern.pattern}":`, e.message);
        return text;
    }
}

/**
 * Cleans text using all active patterns
 * @param {string} text - Text to clean
 * @returns {string} Cleaned text
 */
export function cleanText(text, presetOverride = undefined) {
    if (!text || typeof text !== 'string') return text;

    const patterns = getActivePatterns(presetOverride);
    if (patterns.length === 0) return text;

    let result = text;
    for (const pattern of patterns) {
        result = applyPattern(result, pattern);
    }

    // Clean up extra whitespace left behind
    result = result.replace(/\n{3,}/g, '\n\n').trim();

    return result;
}

/**
 * Cleans an array of messages
 * @param {Array<object>} messages - Messages with .mes or .text property
 * @returns {Array<object>} Messages with cleaned text
 */
export function cleanMessages(messages, presetOverride = undefined) {
    if (!Array.isArray(messages)) return messages;

    return messages.map(msg => {
        const cleaned = { ...msg };
        if (cleaned.mes) {
            cleaned.mes = cleanText(cleaned.mes, presetOverride);
        }
        if (cleaned.text) {
            cleaned.text = cleanText(cleaned.text, presetOverride);
        }
        return cleaned;
    });
}

// ============================================================================
// CUSTOM PATTERN MANAGEMENT
// ============================================================================

/**
 * Adds a custom cleaning pattern
 * @param {object} pattern - Pattern to add
 * @returns {string} The ID of the added pattern
 */
export function addCustomPattern(pattern) {
    const settings = getCleaningSettings();
    const id = pattern.id || uuidv4();

    const newPattern = {
        id,
        name: pattern.name || 'Custom Pattern',
        pattern: pattern.pattern,
        replacement: pattern.replacement || '',
        flags: pattern.flags || 'g',
        enabled: true,
        builtin: false,
    };

    settings.customPatterns = settings.customPatterns || [];
    settings.customPatterns.push(newPattern);
    saveCleaningSettings(settings);

    return id;
}

/**
 * Updates a custom pattern
 * @param {string} id - Pattern ID
 * @param {object} updates - Fields to update
 */
export function updateCustomPattern(id, updates) {
    const settings = getCleaningSettings();
    if (!settings.customPatterns || !Array.isArray(settings.customPatterns)) {
        return false;
    }

    const index = settings.customPatterns.findIndex(p => p.id === id);

    if (index !== -1 && index !== undefined) {
        settings.customPatterns[index] = {
            ...settings.customPatterns[index],
            ...updates,
        };
        saveCleaningSettings(settings);
        return true;
    }
    return false;
}

/**
 * Removes a custom pattern
 * @param {string} id - Pattern ID to remove
 */
export function removeCustomPattern(id) {
    const settings = getCleaningSettings();
    settings.customPatterns = (settings.customPatterns || []).filter(p => p.id !== id);
    saveCleaningSettings(settings);
}

/**
 * Toggles a builtin pattern
 * @param {string} id - Builtin pattern ID
 * @param {boolean} enabled - Whether to enable
 */
export function toggleBuiltinPattern(id, enabled) {
    const settings = getCleaningSettings();
    settings.enabledBuiltins = settings.enabledBuiltins || [];

    if (enabled && !settings.enabledBuiltins.includes(id)) {
        settings.enabledBuiltins.push(id);
    } else if (!enabled) {
        settings.enabledBuiltins = settings.enabledBuiltins.filter(x => x !== id);
    }

    saveCleaningSettings(settings);
}

// ============================================================================
// IMPORT/EXPORT
// ============================================================================

/**
 * Exports custom patterns as JSON
 * @returns {string} JSON string of custom patterns
 */
export function exportPatterns() {
    const settings = getCleaningSettings();
    return JSON.stringify(settings.customPatterns || [], null, 2);
}

/**
 * Validates and merges an imported pattern list into a detached settings draft.
 * No caller settings or persisted state are mutated on success or failure.
 * @param {string} json
 * @param {object} baseSettings Current settings or an unsaved modal draft
 * @returns {{success:boolean,count:number,settings?:object,isTemplate?:boolean,templateName?:string,error?:string}}
 */
export function preparePatternImport(json, baseSettings) {
    try {
        const data = JSON.parse(json);
        const isTemplate = data !== null && typeof data === 'object' && !Array.isArray(data);
        if (!Array.isArray(data) && !isTemplate) {
            throw new Error('Expected a pattern array or a template object');
        }
        if (isTemplate && !Array.isArray(data.customPatterns)) {
            throw new Error('Template must contain a customPatterns array');
        }
        if (!baseSettings || typeof baseSettings !== 'object' || Array.isArray(baseSettings)) {
            throw new Error('Invalid current cleaning settings');
        }

        const rawPatterns = isTemplate ? data.customPatterns : data;
        const validatedPatterns = rawPatterns.map((pattern, index) => {
            if (!pattern || typeof pattern !== 'object' || Array.isArray(pattern)) {
                throw new Error(`Pattern ${index + 1} must be an object`);
            }
            if (typeof pattern.pattern !== 'string' || !pattern.pattern) {
                throw new Error(`Pattern ${index + 1} must have a non-empty regex`);
            }
            if (pattern.flags !== undefined && typeof pattern.flags !== 'string') {
                throw new Error(`Pattern ${index + 1} has invalid flags`);
            }
            if (pattern.name !== undefined && typeof pattern.name !== 'string') {
                throw new Error(`Pattern ${index + 1} has an invalid name`);
            }
            if (pattern.replacement !== undefined && typeof pattern.replacement !== 'string') {
                throw new Error(`Pattern ${index + 1} has an invalid replacement`);
            }
            if (pattern.enabled !== undefined && typeof pattern.enabled !== 'boolean') {
                throw new Error(`Pattern ${index + 1} has an invalid enabled value`);
            }
            const flags = pattern.flags ?? 'g';
            try {
                new RegExp(pattern.pattern, flags);
            } catch (e) {
                throw new Error(`Pattern ${index + 1} has invalid regex: ${e.message}`);
            }
            return {
                name: pattern.name || 'Imported Pattern',
                pattern: pattern.pattern,
                replacement: pattern.replacement ?? '',
                flags,
                enabled: isTemplate ? pattern.enabled !== false : true,
            };
        });

        if (isTemplate && data.preset !== undefined &&
            (typeof data.preset !== 'string' ||
             (data.preset !== 'custom' && !Object.hasOwn(CLEANING_PRESETS, data.preset)))) {
            throw new Error('Template has an unknown cleaning preset');
        }
        if (isTemplate && data.enabledBuiltins !== undefined &&
            (!Array.isArray(data.enabledBuiltins) ||
             !data.enabledBuiltins.every(id => typeof id === 'string' && Object.hasOwn(BUILTIN_PATTERNS, id)))) {
            throw new Error('Template has invalid built-in pattern IDs');
        }
        if (isTemplate && data.name !== undefined && typeof data.name !== 'string') {
            throw new Error('Template has an invalid name');
        }

        const settings = {
            ...baseSettings,
            customPatterns: Array.isArray(baseSettings.customPatterns)
                ? baseSettings.customPatterns.map(pattern => ({ ...pattern })) : [],
            enabledBuiltins: Array.isArray(baseSettings.enabledBuiltins)
                ? [...baseSettings.enabledBuiltins] : [],
        };
        if (isTemplate && data.preset !== undefined) settings.selectedPreset = data.preset;
        if (isTemplate && data.enabledBuiltins !== undefined) {
            settings.enabledBuiltins = [...data.enabledBuiltins];
        }

        // Validate every record before generating IDs or changing the draft.
        const known = new Set(settings.customPatterns.map(pattern => pattern.pattern));
        let count = 0;
        for (const pattern of validatedPatterns) {
            if (known.has(pattern.pattern)) continue;
            known.add(pattern.pattern);
            settings.customPatterns.push({ id: uuidv4(), ...pattern, builtin: false });
            count++;
        }
        return {
            success: true, count, settings, isTemplate,
            ...(isTemplate ? { templateName: data.name || 'Unnamed Template' } : {}),
        };
    } catch (e) {
        return { success: false, count: 0, error: e.message };
    }
}

/** Import patterns atomically for callers outside the Text Cleaning Manager. */
export function importPatterns(json) {
    const result = preparePatternImport(json, getCleaningSettings());
    if (result.success) {
        saveCleaningSettings(result.settings);
    }
    return result;
}

/**
 * Tests a pattern against sample text
 * @param {string} pattern - Regex pattern
 * @param {string} flags - Regex flags
 * @param {string} replacement - Replacement string
 * @param {string} sampleText - Text to test against
 * @returns {{success: boolean, result?: string, error?: string}}
 */
export function testPattern(pattern, flags, replacement, sampleText) {
    try {
        const regex = new RegExp(pattern, flags || 'g');
        const result = sampleText.replace(regex, replacement || '');
        return { success: true, result };
    } catch (e) {
        return { success: false, error: e.message };
    }
}
