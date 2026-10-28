# F07 — Verification and limitations

## Offline evidence
- Similharity: **305/305 tests passed** using `node --experimental-vm-modules --test tests/*.test.mjs`. Includes F07 new-only provisioning, receipt and schema checks, S04 synthetic record lifecycle, source-bound manual pilot, malicious request-shape rejection and the earlier checkpoints.
- VectHare: **1,125 assertions across 65 isolated test files**, no retry required.
- All current `.js` and `.mjs` sources passed `node --check`.
- Source-manifest regeneration and extension/plugin fingerprint match checked in build; matched packages additionally ZIP-verified.

## What the tests DO prove
- F03 Vectra creates only a server-generated NEW v2 index, with one-time receipt and retry refusal in a disposable filesystem fixture.
- The read and mutation interfaces use trusted source bindings and physical index names derived by S02, not browser-owned IDs.
- The F07 adapter + S04 ledger completes synthetic insert, readback, query, metadata update, stale-revision rejection, paging, local-index reopen and delete using a simulated Vectra SDK.
- Client gates reject path/owner injection and unauthorized native Standard mutation requests.
- A 403 or 500 is not considered a working native endpoint.

## What they DO NOT prove
- The installed Vectra SDK on a real Termux, Windows or Linux SillyTavern host behaves exactly like the mocks.
- Real independent-process restart durability, crash recovery, source ownership across simultaneous writers, or live native Standard mutation semantics.
- End-to-end normal VectHare chat/summaries/World Info memory CRUD or prompt recall.
- Safe full inventory, backup/export/migration/purge, or general production-write readiness.

## Decision
**F07 GUARDED DEVELOPMENT CANDIDATE.** Do not remove existing E02 safety gates or use legacy collections as disposable test targets. Continue to F08 Milvus implementation and F09–F12 shared workflow, recovery, GUI and live acceptance. Host test evidence is required before promotion.
