# C08 — Acceptance checklist

| Original issue | Local implementation | Live acceptance | Evidence / constraints |
|---|---|---|---|
| #135 — World Info identity in both contexts | Implemented | Pending host event timing and payload verification | `utils/world-info-identity.js`, `index.js`, collection/chunk search contexts; simulated event tests. Previous-observed scan, not guaranteed current-turn. |
| #142 — Canonical WI world/entry references | Implemented | Pending host UI integration | `activeWorldInfoMatches()`, world-qualified semantic dedup, database-browser existing `worldName:uid` values, tests. |
| #73 — Role context | Preserved + verified | Host integration pending | Role-aligned deep `buildSearchContext()` pattern tests. |
| #80 — Speaker depth | Implemented + tests | Host integration pending | Exact per-rule positive lookback, including numeric strings. |
| #88 — Frequency only after final selection | **Foundation / gated** | **Blocked by C10 verified final inclusion receipt** | Unverified/dry runs never counted, idempotent same user turn on synthetic confirmed receipt; live frequency-conditioned chunks withheld until final receipt and durable accounting. |

**Result:** C08 identity/context implementation delivered; **C08 as a whole remains partially accepted**, not production-certified. No destructive operations enabled, and the Similharity plugin was not changed.

## Specific C10 handoff

1. Supply a verified final inclusion receipt **after** C09 selection and C10 trimming, not merely a successful `setExtensionPrompt`/`extension_prompts` registration.
2. Include the actual injected qualified logical `recordId`s, chat identity, collection key and stable user-turn ID; mark dry-run and uncertain receipts explicitly.
3. Store confirmed conversation-scope counts and turn-id deduplication durably before enabling live max-activation/cooldown; recovery of uncertain receipts must never double-count.
4. Flip the hard-coded C08 live safety gate only after a direct integration test proves no rejected candidate or truncated chunk consumes frequency.
5. Test WI event ordering and chat attribution on the actual SillyTavern host version.
