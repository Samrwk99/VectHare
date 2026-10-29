# F09b.8 — Disposable integrated host acceptance runbook (NOT EXECUTED)

## Preconditions

Use a **disposable** SillyTavern user/profile and new F03-provisioned v2 collections. Back up normal data; never test against legacy or valuable vectors. Install both packages from this exact F09b.8 matched release and restart. Verify plugin `/v2/build`, `/v2/capabilities`, `/v2/contracts` agree with the S11 expected version/fingerprint. Record sanitized S10 result and backend source receipts.

## Integrated workflow sequence

1. Through GUI, configure and test the F09b.5 server-managed embedding profile (source/model/dimension/metric). Use a dummy dedicated credential only where actually required; no credential should enter browser readback or logs. Check mismatch refusal.
2. On each targeted backend with a **fresh, separately provisioned collection**, open a saved test chat, run F09b.3 preview/explicit one-record write and confirm exact F02 scoped readback. Change the chat; confirm stale-preview refusal, then a fresh explicitly confirmed exact update.
3. Run F09b.4 exact delete on a still-present chat message. Confirm physical absence and durable `DELETED` managed marker; rerun F09b.3 and confirm the record is not silently recreated. Never clear registry files to force a retry.
4. Add an existing saved summary and lorebook with stable numeric UIDs. Run F09b.6 read-only preview and a single explicitly consented pilot lorebook write; verify actual stored UUID, source hash, revision and embedding dimensions. Do not infer deletion for missing or disabled entries.
5. Run F09b.7 read-only inspector: before/after exact lorebook write report `MISSING_VECTOR` then `IN_SYNC`; a changed file reports `STALE_VECTOR`; a disabled link target and missing UID remain diagnostics only. Ensure inspection never performs writes, deletes, prompt activation or link traversal.
6. Recheck the same paths after host restart. Test other users, group chats, branched saved chats, different collections/backend selections, denied scope fields, symlinks and file swaps. A source/collection/owner mismatch must refuse. Confirm no plaintext, vector or credential leaks into GUI responses.
7. Inject a controlled backend timeout on a disposable record. Inspect the `UNCERTAIN` receipt read-only. Do **not** retry or auto-reconcile without a separately certified crash recovery policy.
8. Include real concurrent independent backend writer tests and observed CAS behavior for F09c; passing this runbook *alone* does not certify external-writer concurrency.

## Hard fail conditions

Cross-user/source or collection data access, unauthorized vector creation/update/delete, reappearance after managed deletion, silent retry of an `UNCERTAIN` write, unverified schema, leaked source/secret/vector, unintended native/legacy route activation, or collection purge. Preserve redacted operation IDs and logs, then stop.

## Result

This handover **does not claim this host run was performed**. No production capability matrix unlock is justified by offline tests or by this runbook alone.
