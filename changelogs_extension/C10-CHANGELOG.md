# C10 — Prompt Budget and Final-Inclusion Receipt | Development Checkpoint

**Baseline:** `VectHare-Step9-C09-Cumulative-Retrieval-Checkpoint.zip`  
**Baseline SHA-256:** `e6647c66007dea86abe1f05ce1fa7b358c314f6e9748077798c262936608b209`  
**Plugin status:** `VectHare-Similharity-Plugin.zip` is read-only and not included or modified.  
**Plugin SHA-256:** `51f74de9c7e57524cc3f1f881b03069805e654b162a8f5ccb77d012b0a2604a7`

## #115 — Token-aware injection planning

- Added `utils/prompt-budget.js` and integrated the planner in `rearrangeChat` **after final C09 selection and all late filters**, before `setExtensionPrompt`.
- Reads `getContext().maxContext` and the host `getTokenCountAsync`/`getTokenCount` helper when available. A failed tokenizer falls back to a deliberately conservative UTF-16 length estimate, visibly labelled as approximate.
- Applies configurable `injection_token_cap` (default 1024 tokens), `injection_safety_margin` (128), and `injection_context_reserve` (512), always reserving at least half the host max context for non-VectHare content. Unknown max context / exhausted headroom refuses injection.
- Counts collection, global, chunk wrappers, all prompt positions, and C10 markers against one shared budget. Ranked chunks are retained if possible, trimmed at Unicode code point boundaries when required, otherwise dropped. Each omission/trim is recorded in the debugger.
- The registration call consumes the exact formatted, frozen block snapshots that the planner counted. This prevents an intervening macro change from changing text after token-count verification.
- New UI controls for cap and safety margin and a debugger budget summary.

## #187 — Final prompt assembly receipts

- Added `utils/prompt-receipts.js` with per-generation random markers and explicit `registered`, `included`, `partial`, `notIncluded`, and `unknown` states. Only matching complete marker-wrapped blocks in an observed host event are confirmed as included.
- Subscribes in `index.js` to `CHAT_COMPLETION_PROMPT_READY` (structured chat messages) and `GENERATE_AFTER_COMBINE_PROMPTS` (text completion prompt string). Verified registered prompt objects alone do **not** prove host inclusion.
- Receipts are isolated by chat identity and generation nonce and invalidated on a new retrieval, chat switch, message edit/delete/swipe, or pagehide. Dry-run and malformed event payloads do not become inclusion proof.
- Search debugger shows registration separately from verified assembly; green verification styling now requires an observed `included` receipt.
- Introduced `utils/durable-frequency-ledger.js`: verified inclusion can be checkpointed per chat, qualified collection, record and user turn, with readback and replay-safe deduplication; no chunk texts or credentials are stored. Trimmed frequency-conditioned records are not accounted as complete.

## Safety / limitations

**C08 #88 remains gated:** The delivered extension leaves `C08_FINAL_INCLUSION_RECEIPT_AVAILABLE = false`. Actual host event ordering, completion-style payloads, generation lifecycle and long-term storage behavior have **not** been verified in a deployed SillyTavern instance. Enabling frequency-conditioned chunks based only on simulated hooks would be unsafe. Their candidate selection stays fail-closed.

The host prompt can contain other extensions, system messages, and chat history that VectHare does not control. Reserving half the context plus a safety margin is conservative budgeting, **not an exact guarantee of complete host context fit**. Host token counts and assembled-prompt observation do not prove the backend ultimately received an identical request; live acceptance requires captures for both completion styles.

No plugin source was changed; no backend deletion, unsafe replacement, or plaintext credential path was re-enabled.

## Verification / deliverables

- **709/709** cumulative Node tests passed, including **58 C10** tests.
- **161** JavaScript/ESM syntax checks passed.
- Regression update was limited to adapting older isolated VM test harnesses to new, required prompt receipt and budget dependencies (no safety checks loosened).
- Changed **11** pre-existing files; added **8** files; removed **0** files; all other archive source files preserved.
- See `C10-CHECKLIST.md`, `C10-VERIFICATION.md`, and `C10-RELEASE-MANIFEST.json`.
