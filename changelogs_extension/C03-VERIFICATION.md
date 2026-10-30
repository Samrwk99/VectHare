# VectHare C03 — Verification report

**Execution:** 2026-10-27. Source: current cumulative extension working tree generated from `VectHare-I18-Phase0-C01-Return-Safety-Checkpoint.zip`. Similharity plugin source used as read-only reference; plugin not edited.

| Suite | Command | Tests passed |
|---|---|---:|
| I01–I18 | `npm run test:repair` | 199/199 |
| Phase 0 | `npm run test:p0` | 33/33 |
| C01 | `npm run test:c01` | 50/50 |
| C04/C06/C11-A | `npm run test:dependencies` | 24/24 |
| C04/C06/C11-B | `npm run test:dependency-b` | 31/31 |
| C03 | `npm run test:c03` | 38/38 |
| Plugin source evidence guard | `node --experimental-vm-modules --test tests/c01-plugin-contract.node.test.mjs` | 2/2 |

**Total: 377/377 passing Node tests**. All `.js` and `.mjs` files passed `node --check`. This suite does not include a live SillyTavern UI session or deployed Similharity backend validation. The optional Vitest suite was not executed because dependencies are not bundled in the ZIP.

## New fault injection scenarios

- A→B chat switch while retrieval is awaiting activation: no stale prompt or debug writes.
- Superseded generation while the same query is pending.
- Rename with stable persisted chat integrity UUID.
- Different chat integrity IDs, character/group scope, independent job cancellation.
- FIFO cancellation of queued middle waiter, holder throw, distinct collection keys.
- Lost acknowledgement, undefined response, explicit uncertain result, late ACK after client abort.
- Crash/restart restoration, corrupt marker fail-closed, pagehide teardown.
- In-flight write drain before purge; admission closed before cancellation.
- Scene cache delayed read from chat A after B becomes active.
- Session versus conversation activation history and cross-collection hash isolation.
- Long-chat marker compaction without losing aggregate uncertainty count.

## Not verified here

1. Actual host event names and ordering in the user's SillyTavern build.
2. Runtime integration with real UI, prompts, character/group branching and backup imports.
3. Whether browser storage survives a crash or is available in every deployment.
4. Post-abort server commit/ack semantics, actual server inventories and multi-tenancy safety.
5. C02 durable idempotent repair and C01 live deletion/purge acceptance.
