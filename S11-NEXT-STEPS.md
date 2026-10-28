# After S11 — remaining gates before functionality can be reactivated

S11 is an integration-only checkpoint. S10's public v2 record paths still refuse execution. No backend writes or migration cutovers have been enabled.

## H01 — Authenticated host ownership

Implement and verify trusted SillyTavern-side binding between authenticated users and chat, branch, lorebook, scene and collection identities. Distinguish branch copies from renames and imports. Never use localStorage, a browser-submitted ID or copied `chat_metadata.integrity` as server ownership proof. Provide audited grants and verified persisted remapping, then test two accounts, separate tabs and restarts.

## H02 — Public read execution

Connect the S05–S08 internal adapters through authenticated, server-authorized v2 read routes, with independent ownership validation and backend-error propagation. On a disposable SillyTavern host, establish final outgoing prompt inclusion, World Info and frequency gating. Revisit the E02 runtime matrix one cell at a time.

## H03 — Safe real writes and recovery

For each backend independently, establish stable primary keys, SDK/model compatibility, actual readback (with storage precision), multi-writer exclusion or atomic revision guarantees, retry/reconciliation, two-user isolation, duplicate-hash protection and restart durability. Wire S04's journal to authorized routes only after passing challenge tests. Native SillyTavern Standard endpoints require separate verification.

## H04 — Inventory and migration

Prove complete consistent inventory with over 1,050 records and concurrent mutations, then implement and exercise backend-native backup, staged copies, reference remapping, verified cutover and rollback. S09's JSON fixture rehearsal is not production migration.

## H05 — Acceptance/release

Test full workflow create → vectorize → retrieve → final prompt → edit/reindex → delete → verified export → restart, repeat twice (including after restart), capture sanitized evidence and publish per-backend PASS/FAIL/BLOCKED/UNPROBED decisions. Only then unlock individual operations; keep physical unscoped purge permanently prohibited.
