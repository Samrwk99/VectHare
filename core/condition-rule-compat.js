/** I06: Normalize legacy Chunk Visualizer rules without silently enabling unsupported conditions. */
export const EVALUATED_CONDITION_TYPES = Object.freeze([
    'pattern', 'keyword', 'speaker', 'messageCount', 'timeOfDay', 'emotion',
    'characterPresent', 'randomChance', 'generationType', 'swipeCount',
    'lorebookActive', 'isGroupChat', 'scoreThreshold', 'recency', 'frequency',
]);

const LIST_TYPES = new Set(['pattern', 'keyword', 'speaker', 'emotion', 'characterPresent', 'generationType', 'lorebookActive']);
const COUNT_TYPES = new Set(['messageCount', 'swipeCount']);
const splitValues = value => Array.isArray(value) ? value : String(value ?? '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);

/** An immutable, evaluated schema: { type, negate, value?, settings: typed fields }. */
export function normalizeConditionRule(rule) {
    if (!rule || typeof rule !== 'object') return { type: '', settings: {}, negate: false };
    const settings = { ...(rule.settings || {}) };
    const value = settings.value ?? rule.value;
    if (LIST_TYPES.has(rule.type) && settings.values == null && settings.patterns == null && value != null) {
        if (rule.type === 'pattern' || rule.type === 'keyword') settings.patterns = splitValues(value);
        else settings.values = splitValues(value);
    }
    if (COUNT_TYPES.has(rule.type) && settings.count == null && value != null) {
        const matched = String(value).trim().match(/^(>=|<=|==|=|>|<)?\s*(\d+)$/);
        if (matched) {
            settings.count = Number(matched[2]);
            settings.operator ??= ({ '>=':'gte', '<=':'lte', '=':'eq', '==':'eq', '>':'gt', '<':'lt' })[matched[1]] || 'gte';
        }
    }
    if (rule.type === 'randomChance' && settings.probability == null && value != null && String(value).trim() !== '') {
        settings.probability = Number(String(value).replace('%', ''));
    }
    if (rule.type === 'isGroupChat' && settings.isGroup == null) {
        settings.isGroup = value == null || String(value).trim() === '' ? true : value === true || String(value).toLowerCase() === 'true';
    }
    if (rule.type === 'timeOfDay' && (!settings.startTime || !settings.endTime) && typeof value === 'string') {
        const times = value.trim().match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
        if (times) {
            settings.startTime ??= times[1];
            settings.endTime ??= times[2];
        } else if (value.trim()) {
            settings.invalidLegacyRange = true;
        }
    }
    return { ...rule, negate: rule.negate ?? rule.negated ?? false, settings };
}

/** Maximum configured condition lookback; does not couple activation to semantic query depth. */
export function getRequiredConditionDepth(conditions, initial = 0) {
    if (!conditions?.enabled || !Array.isArray(conditions.rules)) return initial;
    return conditions.rules.reduce((depth, rawRule) => {
        const rule = normalizeConditionRule(rawRule);
        const configured = rule.settings.scanDepth ?? rule.settings.lookback;
        const defaultDepth = rule.type === 'pattern' || rule.type === 'keyword' ? 10 : 0;
        const needed = Number(configured ?? defaultDepth);
        return Math.max(depth, Number.isFinite(needed) && needed > 0 ? Math.floor(needed) : 0);
    }, initial);
}
