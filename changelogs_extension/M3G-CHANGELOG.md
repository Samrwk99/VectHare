# M3g — lifecycle execution evidence and recovery visibility

**Baseline:** M3f (`Similharity 3.2.10-m3.6`, `VectHare 2.2.0-alpha.m3.3`).
**Result:** M3g PARTIAL. Do not treat M3 as completed or publicly certified.

## Implemented

1. New `lib/m3-execution-audit.js` adds append-only, owner-bound, filesystem-synced per-operation checkpoints with stage ordering and checksum chaining. It uses the existing private M3 lifecycle lease holder and requires the durable one-use claim before writing its first event.
2. Restore, rollback and canonical decommission private trusted paths now record `CLAIMED`, `DISPATCH_PENDING`, `PHYSICAL_VERIFIED`, `JOURNAL_PUBLISHED` (where applicable) and `COMMITTED`. The pre-dispatch checkpoint is durably written *before* any uncertain Qdrant mutation. Failure after claim retains the logical collection lock.
3. `inspectM3LifecycleRecovery` verifies the original one-use claim and checkpoint chain, returning a safe investigation classification. A claimed operation is `REVIEW_REQUIRED`, whether it has no checkpoints, a partial chain, or a terminal chain. It does not authorize retry or lock release.
4. New authenticated plugin GET `/v2/m3/operations/:operationId/evidence` returns owner-bound read-only evidence. No physical names, credentials or vectors are accepted in this request.
5. VectHare request gateway now validates the exact read-only evidence URL and denies body/query/method changes. M3 panel adds an operation UUID evidence inspector with status text, not a destructive action.
6. Added M3 audit integrity and crash-boundary tests, extended existing lifecycle and UI regressions; bumped plugin and extension manifest versions.

## Limits / reasons M3 is not complete

- Source and journal evidence are NOT authoritative proof of Qdrant outcome or lock-release eligibility. Independent physical inventory, ledger, registry and live-process investigation are still required.
- The M3 public `execute` endpoint stays `M3_COLLECTION_GATEWAY_NOT_CERTIFIED`; only the private server-internal restore, pristine rollback and canonical deletion implementations can dispatch, and only through their protected holders.
- Scoped empty/re-provision, changed-inventory lossless rollback, new embedding model rebuild and an approved recovery lock-release path remain unimplemented.
- No live SillyTavern / real Qdrant certification was obtained. All capability cells preserve the M3f mode.

## Developer notes

The checkpoint chain is a corruption-evident local audit, not a cryptographically signed remote record or a replacement for S04/M2 decisions. Do not conflate `COMMITTED` with an administrator permission to remove a retained physical lock. The existing S01 / legacy endpoint denials remain active.
