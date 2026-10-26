# I06 — Activation, lorebook policies and conditional rules

Base: I05 cumulative build. Scope: I06 only (11 tracked issues).

| Issue | Implemented correction |
|---|---|
| #141 | Condition and trigger lookback depth is calculated independently of semantic query depth; chunk and collection patterns receive enough recent messages. |
| #232 | Lorebook key arrays and UID `0` are handled without throwing or losing matches. |
| #225 | The `only_selected` lorebook policy no longer removes ordinary chat/document collections. |
| #132 | Legacy Visualizer `settings.value` rules are converted to typed evaluation settings; new rules are normalized and validated before saving. |
| #226 | Unsupported `similarity`, `dependency`, `chunkActive` and other unimplemented rule types are rejected by validation and cannot activate under NOT. No new evaluators were invented. |
| #133 | New Visualizer rules use `negate`; existing saved `negated` rules are interpreted compatibly. |
| #136 | Chunk conditions receive the actual generation type instead of defaulting to `normal`. |
| #143 | Chunk conditions receive the real group-chat state. |
| #144 | Chunk emotion conditions receive the current character name for Expressions integration. |
| #230 | Legacy time ranges are parsed and evaluated, including ranges that cross midnight; invalid legacy values are rejected. |
| #231 | Character-present rules compare complete speaker names, ignoring whitespace and case, not substrings. |

## Files changed
- `core/chat-vectorization.js`
- `core/conditional-activation.js`
- `core/condition-rule-compat.js` (new)
- `ui/chunk-visualizer.js`
- `tests/i06-conditions.node.test.mjs` (new)
- `package.json` (test scripts)

## Verification
- `npm run test:i06` — 10/10 focused tests passed.
- `npm run test:repair` — 75/75 cumulative tests passed.
- `node --check` across all `.js` source files — passed.
- ZIP CRC/integrity checked.

## Limitations
- No live SillyTavern/Similharity/Expressions integration test was performed.
- Active World Info identity/event integration and post-injection frequency accounting remain Phase 2 (C08). Unsupported condition types remain explicitly rejected instead of being silently treated as valid; they can be edited or removed in the UI.
- Canonical identity, reliable job cancellation and other Phase 2 mechanisms are not included.
