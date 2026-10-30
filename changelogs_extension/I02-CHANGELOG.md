# I02 — Secrets, Privacy and Unsafe HTML

Applied **on top of the I01-fixed project**. The I01 code and regression tests are retained.

| Issue | Changes | Files |
|---|---|---|
| #48 | Qdrant initialization no longer logs its credential-bearing configuration, raw response, or error body. Failure messages use HTTP status only. | `backends/qdrant.js` |
| #131 | Adds an explicit **Clear API Key** button. Clears the BananaBread secret's usable value on the SillyTavern server first; only then clears saved VectHare settings and refreshes the UI. Server rejection leaves local state intact and displays an error. Save/clear handlers report errors without logging key material. | `ui/ui-manager.js`, `utils/credential-controls.js` |
| #69 | Removes plaintext chunk/chat excerpts, extracted query keywords, repair text previews, and prompt verification previews from console logging. Keeps diagnostic counts and hashes. | `core/chat-vectorization.js`, `ui/search-debug.js` |
| #180 | Escapes imported collection IDs, matched keywords, keyword score breakdowns, chunk hashes and other untrusted values used by the Search Debugger, including attributes. | `ui/search-debug.js` |
| #194 | Escapes plaintext-mode keyword editor contents so imported `</textarea>` content cannot become markup. | `ui/chunk-visualizer.js` |
| #41 | Escapes collection names, IDs, source/backend/model strings, model descriptions and card data attributes, including quotation marks. | `ui/database-browser.js` |

## Verification

- `npm run test:repair`: **18/18 passed** (9 I01 tests, 9 I02 tests).
- `npm run test:i02`: **9/9 passed**, using malicious HTML strings, Qdrant response credential echoes, and simulated BananaBread secret revocation failures.
- All project JavaScript and `.mjs` files passed `node --check`.
- ZIP archive integrity verified.
- No live SillyTavern or Similharity backend tests were run.

## Limits

- BananaBread's clear action empties the active custom secret through SillyTavern's existing `/api/secrets/write` interface and clears the extension settings copy. It is **not** the protected-secret-storage migration planned for Phase 2 (C05).
- Local checks don't verify browser-specific UI integration or every possible HTML-producing component outside I02.
- I01's immediate deletion protections remain; the separate Phase 2 failure-recovery mechanisms are still outstanding.
