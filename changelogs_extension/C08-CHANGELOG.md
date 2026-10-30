# VectHare C08 — Activation Context and Frequency Accounting

**Baseline:** Step 7 C05 cumulative security checkpoint. **Similharity plugin:** read-only, not modified, not included in the extension ZIP.

## Implemented in this checkpoint

- **#135 — World Info activation context:** Added `utils/world-info-identity.js`, a collection/chat-scoped cache of actually observed host `WORLD_INFO_ACTIVATED` entries. It uses source-world plus UID and rejects missing provenance; keyed-map and event-array shapes are supported. The most recently observed scan is used by both collection and chunk condition contexts; unverified extension setting values cannot spoof an activated host entry. A chat change clears the cached observation. Event timing relative to the generation interceptor still requires testing on the pinned SillyTavern installation; the cache is *not* represented as a verified current-turn scan.
- **#142 — Matching selected lorebook entries:** Collection/chunk `lorebookActive` conditions now compare qualified `world:uid` values or a whole-world selection. Bare UIDs only work when unambiguous. A keyword is no longer misinterpreted as an entry identity. Both the semantic-WI merge deduplicator and the WI activation rule retain world provenance, including UID zero.
- **#73 — Message roles:** Preserved aligned `messageRoles` and deep role-filtered pattern context from Phase 0; expanded C08 tests.
- **#80 — Speaker lookback:** Rule-level lookback is applied for speaker and character-presence conditions; sanitized numeric-string lookbacks now work as expected.
- **#88 — Frequency accounting foundation, NOT live-finalized:** Added `utils/activation-frequency-ledger.js`: chat/qualified-collection/logical-record/turn keys, session/conversation scopes, dry-run protection, verified final-inclusion receipt validation, same-turn deduplication, and separate pending/unverified records. Removed the dangerous frequency write at the *condition-filtering* stage. The post-prompt-registration path records an unverified receipt, not a spent activation. The future C10 integration must provide authoritative final inclusion after prompt-budget selection; without it, live frequency-conditioned chunks are **withheld** to avoid silently bypassing limits or spending them on rejected candidates.
- **Unknown World Info is not inactive:** When the host has not provided a valid observed WI scan, a negated `lorebookActive` rule does not treat absence of evidence as proof of inactivity.
- **C08 tests:** Added `tests/c08-activation.node.test.mjs` with host-independent event/identity, role/depth, frequency, isolation, and integration tests. Updated two old test harnesses for the new dependencies and tightened their assertions; no previous safety check was disabled.

## Constraints and blockers

1. **C10 final budget/inclusion receipt** is needed before live max-activation/cooldown rules can count safely. Registering an extension prompt in `extension_prompts` is insufficient to prove final inclusion. The current local ledger is **process-memory only** and does not claim durable cross-restart history.
2. **Actual SillyTavern event ordering and payload** must be verified against the user's pinned installation. Known documentation/types describe `WORLD_INFO_ACTIVATED` with `{world,uid}` entries, but the installed host version was not supplied here. The provided Similharity plugin is a backend plugin, not a host runtime.
3. Existing C01/C02/C04/C06/C07 and C05 live backend/persistence blockers remain unchanged; this checkpoint does not enable deletion, replacement or plaintext credential handling.
4. Delayed World Info events without an origin ID in the host payload cannot be independently attributed to a historical chat after a switch; on chat change the cache is cleared rather than reused.

## Files

- Added: `utils/world-info-identity.js`, `utils/activation-frequency-ledger.js`, `tests/c08-activation.node.test.mjs`.
- Changed: `core/chat-vectorization.js`, `core/conditional-activation.js`, `core/world-info-integration.js`, `index.js`, `package.json`, `tests/i06-conditions.node.test.mjs`, `tests/i15-search-debugger.node.test.mjs`.
- Unchanged: supplied plugin ZIP and all preexisting backend adapters, deletion gates and C05 credential rules.
