# F09c.4 — Host acceptance and single-writer architecture runbook

**Not permission to enable production writes.** Work only on a disposable SillyTavern profile and newly provisioned v2 collections, never historical or valuable vectors. Record versions, code fingerprints, redacted logs, source binding and operation UUIDs.

## A. Qdrant evidence experiment (real service, disposable data)

1. Deploy the matched VectHare/Similharity build in a *separate* disposable installation. Verify the S10 plugin fingerprint and S11 pin, Qdrant server version, binding, collection vector dimension and explicit per-user ownership. Use a Qdrant version supporting `update_mode` (v1.17.0 or newer).
2. From a trusted host-only harness (not a browser/production route), create a synthetic v2 point with a known revision and operation UUID. Verify exact physical ID, owner, branch, collection, vector hashes and revision using scoped get.
3. Issue a revision-filtered `update_only` operation with `wait=true`. Capture the raw response *including* operation status and ID, then read the point. Repeat with a stale revision that must be skipped. Compare response shapes. Do not interpret `completed` as proof of a match.
4. Repeat an `insert_only` against an existing synthetic physical ID, and perform filter-scoped delete with a stale revision. Capture whether the backend reports an operation success even when no record changes.
5. Use a separate credentialed process to write between preflight and conditional dispatch, including a writer that produces the exact desired final state. Test that apparently matching readback is not considered a successful VectHare mutation.
6. Repeat with a direct unconditioned upsert to establish whether any writer can bypass the revision rules, including the legacy Similharity write paths. The unsafe bypass must be blocked by deployment architecture before production certification.
7. Simulate lost responses/timeouts and process crashes immediately before and after dispatch, then restart. Preserve `SUBMITTED` and `UNCERTAIN` without automatic retry, promotion or deletion. Evaluate recovery under F10b rather than manually clearing the ledger.

## B. Enforced exclusive-writer architecture (alternative to authoritative CAS receipt)

The design must include **all** of the following, independently tested, before it can be considered an alternative: isolated Qdrant write endpoint; network/OS access controls that deny all non-gateway writers; write credentials held only by the trusted gateway; all browser and legacy direct writes blocked; authenticated per-user source binding; gateway-owned durable intention journal, exact operation identity and at-most-once dispatch semantics; staged backups; restart/recovery procedures; explicit failure and timeout refusal. Separate writers, external administrators and other plugins must not retain an unguarded write path to the same collection.

An application-level mutex, Qdrant `ordering=strong`, an S10 hash match, a self-reported single-writer flag, or a `completed` status is **not** a substitute for exclusive enforcement or an authoritative condition-match result.

## C. Backend matrix and evidence

- Qdrant: host version and conditional semantics; direct writer exclusion; race and crash behavior.
- LanceDB: separate process/file locking, transaction isolation, atomic revision comparison, recovery tests.
- Plugin Vectra: file/record locking with independent writers, crash consistency and ownership enforcement.
- Milvus: deployed collection mutation semantics, independent-writer conflict controls and recovery tests.

All four must have separate acceptance records. Never infer actual results from offline mock fixtures. If no authoritative CAS is available, restrict the backend to a separately certified exclusive-writer deployment or retain DENIED status.

## D. Hard failures

Unexpected cross-user/branch reads, overwritten independent revisions, unprotected raw upserts, completed-no-op marked applied, retry after uncertain dispatch, unregistered orphan cleanup, native Standard mutation, unscoped purge or production-matrix auto-activation. Stop, preserve sanitized evidence, and keep writes disabled.
