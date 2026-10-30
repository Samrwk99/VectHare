# VectHare I08 — Backend/provider compatibility

**Base:** `VectHare-I07-Fixed.zip` (cumulative I01–I07 retained).
**Scope:** I08 only — #60, #224, #130.

| Issue | Change |
|---|---|
| #60 | Backup compatibility checks and direct-vector import decisions now resolve the active embedding provider's configured model (e.g., `ollama_model`, `openai_model`) instead of an unrelated `settings.model`. Export metadata reflects the selected model, while an explicitly registered collection model remains authoritative during export. Missing/mismatched model information conservatively triggers re-embedding. |
| #224 | Standard/Vectra Similharity plugin insert payload now includes the same canonical provider parameters used by the native insert path (including alternate API URLs, where configured). |
| #130 | Plugin insert HTTP 404/405/501 can fall back to native `/api/vector/insert`, with fallback capability cached for later inserts. Authentication, transport, server and application-level errors are surfaced rather than silently retried. Native fallback warns when keyword/metadata support is reduced. Re-initialization resets the cached capability. |

## Changed files
- `core/providers.js` — shared `getConfiguredEmbeddingModel` helper.
- `core/collection-export.js` — correct embedding model for export, validation and both import paths.
- `backends/standard.js` — provider parameters on plugin requests, selective native fallback, insert response checks.
- `tests/i07-backup.node.test.mjs` — mock the added provider helper import in the existing harness.
- `tests/i08-provider-compat.node.test.mjs` — I08 tests.
- `package.json` — `test:i08` command and cumulative `test:repair` update.
- `I08-CHANGELOG.md` — in-project summary.

## Verification
- **I08 tests:** 13/13 pass.
- **I01–I08 cumulative tests:** 98/98 pass (`npm run test:repair`).
- **All JavaScript syntax checks:** pass.
- **ZIP integrity:** pass.
- **Live SillyTavern / Similharity testing:** NOT performed; the target plugin/provider endpoint schemas still require live confirmation. In particular, whether each provider-specific parameter is used by the installed Similharity version is not yet verified.

## Remaining limits
- Native Standard fallback does not preserve plugin-only chunk metadata in the vector backend. The caller is warned, but this route is a compatibility fallback, not feature parity.
- Cross-backend routing/capability contracts, canonical collection identity and safe write recovery remain Phase 2 work.
