# F04 Verification — 28 October 2026

## Tested versions

- VectHare extension `2.2.0-alpha.s11.9-f04`.
- Similharity plugin `3.2.10-s10.8-f04`.
- Exact source fingerprint: `1d13562e109129ca487f85eab24f1a5681b7b6f1fcb651c5d9c95bae35977e67`.

## Test results

- **Plugin:** 286/286 offline tests passed (`node --experimental-vm-modules --test tests/*.test.mjs`).
- **Extension:** 62/62 independent Node VM-module test files passed, 1,107 successful test assertions, zero failed files, zero retries.
- All plugin and extension JavaScript/ES-module files passed `node --check`.
- New F04 tests cover request shape restrictions, local-only and explicit consent, connection/origin/header restrictions, missing/uncertain/wrong-owner F03 receipts, verified index inspection, actual S04-ledger + S06-Qdrant simulated create/update/metadata/delete lifecycle, idempotency refusal, revision conflict, UNCERTAIN acknowledgement and no replay, browser E02 allowlist vs legacy-denied routes, response overclaim refusal, GUI controls, and read-only operation status.
- The S04 ledger replay error now returns a stable `S04_OPERATION_EXISTS`; the legacy S04 fixture metadata update was corrected to preserve its original vector and text in accordance with the stronger F04 verification contract.
- Matched plugin source-manifest and exact extension pin checked before packaging; see `F04-SOURCE-MANIFEST.json`.

## What the results do not prove

The Qdrant REST service used in the new integration tests is a **disposable mocked service** that implements the relevant HTTP contract. No connection to the user's Termux Qdrant, real Qdrant Cloud, actual SillyTavern host installation, a live Milvus server, or a native LanceDB/Vectra SDK was exercised in this F04 checkpoint. Cross-process local filesystem locking has prior offline tests; interference by an external database writer is **not** proven safe. Automated recovery after an interrupted metadata update cannot be verified without preserving original vector evidence and therefore remains UNCERTAIN.

## Status

**Off-line development checkpoint, not production activation.** The *manual, consented, source-bound local Qdrant v2 pilot* can execute actual record mutations when run against an accessible local server. This is a test capability, not a claim that the host deployment or normal memory workflows are safe to enable. Ordinary insert/edit/delete/revectorize and backend cleanup remain blocked by the E02 safety matrix and S01 legacy boundary.
