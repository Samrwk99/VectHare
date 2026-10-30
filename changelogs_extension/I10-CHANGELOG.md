# I10 — Prompt content, wrapper and cleanup correctness

Based on `VectHare-I09-Fixed.zip`. Previous I01–I09 changes are retained.

| Issue | Fix |
|---|---|
| #50 | Clear previous extension prompt tags before the quiet-generation early return (also before missing-chat exits). |
| #181 | Reject missing/empty/placeholder vector text before deduplication and prompt formatting; record skips in debug fates. Injection has a second validation gate. |
| #65 | Apply global context/XML wrappers to **each** position/depth prompt group instead of stripping global wrappers for multi-position injection. |
| #64 | Clear all existing numbered position tags by enumerating registered prompts, rather than assuming at most ten. |
| #29 | Keep the dormant World Info helper on a separate reserved prompt tag instead of overwriting the main RAG prompt; clean the legacy tag on later generations. |

## Verification

- `npm run test:i10`: 9/9 passed.
- `npm run test:repair`: 119/119 passed (I01–I10).
- `node --check`: passed for all JavaScript and MJS files.
- ZIP integrity checked.
- **Not tested** inside a running SillyTavern or Similharity server. Phase 2 prompt-receipt and concurrency protection remain outstanding.

No host settings migrations or backend changes.
