# I01 — Destructive Controls, Cleanup and Delete-Result Handling

Based on `VectHare(3).zip`. Only I01 issues were targeted; subsequent repair groups are **not** implemented.

| Issue | Change | Main code |
|---|---|---|
| #170 | Diagnostic registry cleanup removes only explicitly marked, recognized diagnostic collections. User-created or unmarked names containing test substrings remain untouched. The production and visualizer diagnostics mark IDs they create. | `core/collection-loader.js`, `core/destructive-safety.js`, `diagnostics/{production-tests,visualizer-tests}.js` |
| #215 | Full Purge requires a successful HTTP response and rejects explicit JSON-level failures before clearing settings. Any rejected/invalid response preserves settings and reports an error. | `index.js`, `core/destructive-safety.js` |
| #6 | Vector purge checks an explicit backend failure result; failed collection deletes preserve registry/metadata and remain visible for retry. Browser ghost and bulk delete report failures instead of hiding them. | `core/core-vector-api.js`, `core/collection-loader.js`, `ui/{database-browser,ui-manager}.js` |

## Verification

- Run `npm run test:i01`: 9 dependency-free Node regression tests (pass).
- All JavaScript files passed `node --check`.
- The wider Vitest suite and live SillyTavern/Similharity integrations were **not run** in this isolated environment.

## Limits / next work

- A successful HTTP acknowledgement does not establish durable deletion on every backend. C01/C02 still need verified inventory, operation recovery, and coordinated writes.
- Legacy test-looking collection IDs are **intentionally retained** unless they were explicitly marked as created by these diagnostics; they can be reviewed manually.
- The general collection deletion path is not a distributed transaction: failures after an acknowledged vector deletion still require the planned Phase 2 recovery mechanisms.
