# F09b.7 — Disposable host acceptance runbook

**Preconditions:** disposable SillyTavern profile, matched F09b.7 plugin and extension, backup normal profile, newly F03-provisioned v2 collection, valid F09b.5 server-managed embedding profile. Do not install over valuable or legacy vectors for this test.

1. Replace *both* package sources and restart SillyTavern. Verify S10 manifest and S11 pinned version and source fingerprint; a mismatched plugin must remain blocked.
2. Create a new saved World Info lorebook JSON with unique numeric UIDs, an enabled nonempty entry, a disabled entry, and an empty entry. Optionally place `vecthareLinks: [targetUid]` as an experimental annotation on the enabled entry in the disposable fixture (not a claim about official World Info compatibility).
3. Select the local supported plugin backend in VectHare, configure the matching embedding source/model/dimension/metric and use the F09b.7 read-only inspector. Confirm no automatic source mutation, vector write/delete, or prompt activation occurs.
4. Check the enabled item is reported `MISSING_VECTOR` before any F09b.6 explicitly-consented pilot write, and `IN_SYNC` after F09b.6 creates the exact record. The inspector itself must not write. Change the saved item text; confirm `STALE_VECTOR` without automatic revectorization.
5. Confirm disabled/empty source states remain visible even if an older exact vector still exists. No auto-delete or orphan classification is authorized.
6. Test declared source links to an eligible UID, a disabled UID, and a missing UID. Inspect bound / disabled / unresolved status only; never traverse or activate these links.
7. Test missing/duplicate UIDs, malformed link arrays, unsupported condition property types, untrusted browser-provided IDs/text/vectors/owners, stale or swapped saved-file content, symlinked/unowned file, cross-user source and mismatched backend or embedding. All must refuse, be redacted or remain strictly scoped.
8. Repeat after restart and across separate users/branches. Ensure no cross-scope source or record visibility. Record sanitized diagnostics and exact source/checkpoint versions.

**Hard fail:** any write/delete from F09b.7 inspector, unsafe scope, leaked original source text/keywords/vectors/secrets, silent prompt activation, unmanaged orphan deletion, source race accepted, stale client-supplied vector consumed, or unverified backend/collection activation.

This runbook is **not executed** in the provided environment. Passing it alone does not prove production-certified concurrency, live-condition semantics, disaster recovery or complete inventory.
