# F10b.4 — Recovery investigation and retained-lock evidence

Baseline: F10b.3 matched VectHare and Similharity packages.

- Added private administrator-only `lib/f10b4-recovery-investigation.js` and `tools/f10b4-admin-investigate.mjs` to Similharity.
- Reads and integrity-checks scoped S04 receipts, F09b.4 managed-record states, and F09c.10 physical-collection lock. Reads all bounded local owner receipts so conflicting owner/scope content fails closed.
- Repeats the read-only snapshot and compares source evidence hashes before returning a result; reports `UNRESOLVED_MUTATION_BLOCKED`, `RETAINED_LOCK_REQUIRES_HOST_REVIEW`, or `NO_RETAINED_LOCK_OBSERVED`.
- Stages an opt-in, private SHA-256-checked review case; verifies it without modifying live control-plane files. Review is **not** independent attestation.
- Detects inconsistent managed intents, unexpected files, broken checksums, symlinks, wrong owner/collection, and malformed lock entries.
- Added 14 targeted negative/positive controls, including all pending receipt states and refusal to clear a terminal receipt's retained lock.
- Updated plugin manifest, plugin version, extension compatibility pin, and extension version; normal runtime mutation paths unchanged.

**Explicitly not implemented:** retained-lock release, mutation replay, ledger state promotion, managed-intent correction, backend-authoritative reconciliation, live physical recovery, backup/restore certification, Milvus backup. F10b remains OPEN.
