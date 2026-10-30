# M1 — Verification and unfulfilled gate declaration

## Automated checks

- Plugin `node tools/s10-build-manifest.mjs`: PASS.
- Plugin `node --experimental-vm-modules --test tests/*.test.mjs`: PASS, **665/665** assertions, final complete run.
- Extension `.node.test.mjs` suite: **1,173/1,173 test assertions pass when run as five partitioned invocations** (477 + 377 + 135 + 103 + 81). Includes standalone/focused new M1 policy/client tests.
- Full all-at-once extension test harness: NOT GREEN due to intermittent **SIGSEGV in Node experimental VM runner** from existing unrelated C12/C09 tests; the same files pass individually/in smaller partitions. Do **not** equate the partitioned pass with a clean monolithic test command. See crash logs and partitioned logs.
- New M1 mocked lifecycle includes insert/update/revectorize/delete/tombstone/explicit restore; S04 receipt and physical lock; stale source, replay and foreign ownership; failed acceptance; safe F03 bootstrap and receipt persistence.

## Host and real-backend evidence

- **NO** executable real-host disposable SillyTavern + Qdrant acceptance supplied or performed here.
- **NO** authoritative real-Qdrant idempotent-upsert / revision-readback spike performed; this is carried forward from M0.
- **NO** real-host fault-injection / crash-at-dispatch proof, concurrent writers proof, real embedding-model mismatch proof, or connection/credential host certification performed.
- **NO** per-operation backend certification has been flipped on. Matrix of 70 cells remains default fail-closed; see `M1-CAPABILITY-MATRIX.json`.
- `M1` implementation-complete is **not** the same as milestone gate fully passed. M1 acceptance must occur on a disposable host and backend before any `ENABLED` status.

## Fail-closed operational contract

Production execute and initial collection provisioning require separate administrator-held, real-host acceptance records for Qdrant and the relevant operation; HTTP users cannot submit evidence. The host version must match the administrator-configured stable-version marker. No evidence = preview/planning only, no write dispatch. The acceptance file must not be created from offline tests or generated as a convenience.

## Platform/contract boundaries

The tested lock and ticket durability are same-host/cooperative; no claim is made for distributed deployments or for unrelated native/external writers. Windows/Termux permission, path, lock and hard-link smoke tests are still required. Explicit tombstones protect only managed v2 records. Browser-invoked legacy write APIs remain denied.
