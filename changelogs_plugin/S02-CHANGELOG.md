# S02 — Canonical Identity & Record Model — Implementation Changelog

**Baseline:** S01 ZIP, `3.2.1-s01.0` · **Result:** `3.2.2-s02.0` · **Date:** 28 October 2026

## Changes implemented

1. **Canonical v2 scope (`lib/s02-identity.js`):** Explicit `userScopeId`, `collectionId`, `type`, `sourceId`, optional `branchId` (chat only). NFC normalization and bounded input validation. Crucially, S02 does not read/attest the SillyTavern user; S03 must derive the trusted scope.
2. **Embedding identity:** Explicit source, model, vector dimension and distance metric. Different configurations produce distinct logical mapping keys; even identical dimensions with different models are not silently mixed.
3. **Stable record IDs:** Generated UUID record identity and deterministic scope-qualified, UUIDv8-format `physicalId`, independently of text content. `contentFingerprint()` is SHA-256 of text, not the physical point key. The target Milvus string primary-key/schema choice awaits S07 testing.
4. **Collision-resistant collection mapping:** SHA-256 of canonical positional fields including backend/scope/embedding; backend-compatible `vh2_` + 48 hexadecimal characters physical name. No automatic rename or deletion.
5. **Durable offline collection registry (`lib/s02-registry.js`):** Explicit reservation (not creation/activation) in an atomic JSON file with an exclusive cross-process directory lock, file fsync/atomic rename, initialization anchor, mapping collision checks, tamper detection, and fail-closed lock / registry loss. Registry is deliberately **not exposed via HTTP** and **not connected to current write paths**.
6. **Qdrant lossless legacy handling:** `qdrant-backend.js` `_parseCollectionName()` no longer silently discards name segments. Existing plain physical names continue to resolve. Qualified names with ambiguous colons fail before a database request; physical mapping requires reviewed registry/migration in S03/S09.
7. **LanceDB collision refusal:** Removed lossy `sanitizeTableName()` replacements for read and direct-insert paths. Names needing sanitization (e.g., `chat:abc` and `chat/abc`) are both rejected until explicitly mapped. Plain unambiguous table names still work. This is an intentional temporary read-compatibility restriction for potentially colliding legacy names.
8. **Read-only migration planner (`lib/s02-migration.js`, `tools/s02-migration-dry-run.mjs`):** Given a bounded locally supplied inventory, constructs a proposed old-hash→new record-ID mapping, detects unresolved owner/ID/collection problems, and *always* returns `cutoverAllowed:false` and `backupVerified:false`. Does not scan backend data, mutate, back up, or migrate anything.
9. **S01 restrictions retained:** No legacy HTTP insert/edit/delete/purge. Qdrant/Milvus destructive direct methods remain blocked. S02 makes no runtime capability unlock.
10. **Version and tests:** Plugin version `3.2.2-s02.0`, package scripts and 25 additional identity/migration tests (45 total with S01).

## Explicitly not delivered by S02

- Trusted host-authenticated scope, per-user backend instances and secure secret resolution (S03).
- New versioned insert/update/delete API and verified commit/recovery (S04).
- Activation of v2 collection mapping on existing databases; physical backends still use legacy read paths.
- Verification of legacy ownership. A caller-supplied `ownerVerified:true` in a dry-run inventory is not independent proof.
- Legacy data migration with backup, verified copy, cutover and rollback (S09).
- Live SillyTavern, browser, Qdrant, Milvus, LanceDB or Vectra certification.
- SillyTavern branch fork detection (VectHare extension-side work at S11).
