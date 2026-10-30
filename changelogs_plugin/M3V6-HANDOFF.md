# M3v6 → M3 completion handoff

The next work should target **M3.5 new-model rebuild end to end**, not another standalone foundational subsystem. For a safe cross-model rebuild, keep the old collection and its identity intact, obtain a server-authorized target embedding profile, attest saved source for each record, re-embed through M2's bounded coordinator into a freshly provisioned distinct identity, verify complete inventory/smoke queries, then make source reads switch atomically to the new profile binding with rollback retention. Do not alias a new dimension/model under the original embedding-derived S02 key; do not use browser-provided text/vector/credentials.

The other outstanding scope is safe repeated deletion/empty/restore after a journal alias has been published. M3 backup and destructive plan preflights are canonical-only; changing that requires matching immutable per-generation target receipts, managed registry, settled S04 ledger, and full physical readback, not simply bypassing `guardM3CanonicalBinding`.

**Recovery:** M3v6 supports only proof-bound quarantine of an already-committed collection-delete lock. Genuine uncertain `DISPATCH_PENDING` physical writes still require an administrator adjudication workflow with authoritative backend evidence, S04/S02 state reconciliation and crash-safety. Do not classify general `uncertain-recovery` as enabled yet.

Keep the v4 rules: turn a matrix cell `ENABLED/AWAITING_MANUAL_TEST` when its full executable path and safety tests pass, but never flip an incomplete contract or unsafe purge. Qdrant CRUD, logical backup/restore, canonical owned delete and scoped empty remain enabled from M3v5; real-host acceptance is user's responsibility.
