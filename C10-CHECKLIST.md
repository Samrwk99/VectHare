# C10 — Acceptance checklist

| Issue / requirement | Local status | Live status | Evidence / remaining action |
|---|---|---|---|
| **#115 — Token-aware budget** | **Implemented, tested** | **Pending host acceptance** | Budget planner uses host max context, optional host tokenizer, safety reserve and configurable cap; trims/omits after final C09 selection. Confirm real token counts and memory/history headroom in installed host. |
| #115 — Count actual rendered text | **Implemented, tested** | Pending real prompt capture | Count and freeze exact rendered blocks including global/collection/chunk wrappers and unique markers, then register same text. Test real host macro/tokenizer behavior. |
| #115 — No oversized block registration | **Implemented, tested** | Pending real capture | Fail-closed on unavailable context; mock-tokenizer/Unicode/position/fallback tests. Host owns other prompt sections; extension cannot certify total context usage. |
| **#187 — Host assembly receipt** | **Implemented, tested** | **Pending live host event verification** | Both chat/text assembly listeners installed; `included` only for whole marker-wrapped blocks observed in event. Confirm event timing and payload with supported SillyTavern versions. |
| #187 — Correct diagnostic status | **Implemented, tested** | Pending live inspection | Registered-only distinct from final `included` / `partial` / `notIncluded` / `unknown`; debugger displays actual observation and budget. |
| #187 — Cancellation, multi-position, dry run | **Implemented, tested** | Pending live acceptance | Chat switch and lifecycle invalidate pending receipts; dry-run/unknown payload cannot confirm; multi-position receipts independent. |
| **C08 #88 frequency integration** | **Receipt + durable ledger foundation implemented** | **GATED — not accepted for live use** | Per-turn, qualified record receipt persistence with readback/replay guards. Live frequency-conditioned candidates remain withheld until completion-style event timing and durable browser storage are certified on target host. |

## Exit gate for live host acceptance

1. Identify exact supported SillyTavern version/commit, tokenizer implementation and effective context size for chat-completion and text-completion APIs.
2. Capture both real assembled prompt events with marker-wrapped chunks, a truncated/omitted chunk, and a multi-position injection. Verify `included / notIncluded / unknown` report precisely what the host assembled; test dry runs and chat switches.
3. Verify actual model request token totals, preserving chat history and generation budget in small and large contexts.
4. Test frequency rules across swipes, regenerations, reload, two tabs, storage failures and incomplete host events before removing C08’s hard gate.
5. Keep C01/C02/C04/C06/C07/C05 backend safety blocks until their independent acceptance gates are met.

**Overall:** C10 local implementation delivered. Production/live host acceptance remains **open**; the Similharity plugin remains unchanged.
