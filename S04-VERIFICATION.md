# S04 Verification — Source/Offline Only

**Result:** 95/95 Node tests passed; 23/23 JavaScript syntax files passed.  
**Live SillyTavern host:** NOT TESTED  
**Real Qdrant/Milvus/LanceDB/Vectra operations:** NOT TESTED  
**Authorization of chat/lore/branch source:** NOT CERTIFIED  
**Any write capability unlocked:** NO

## Verification run

- `npm run test:s04`: cumulative tests for S01, S02, S03 and S04; 95 passing, 0 failing in an offline Node test run.
- `npm run check:s04`: Node syntax check of all `.js` and `.mjs` source/test/tool files.
- Tests execute internal mutation coordinator against **in-memory fake backend adapters** to simulate durable outcomes, stale revision, response loss, wrong ownership, readback failure, duplicate/replay denial, branch identity split, and metadata changes. This does **not** certify real backend semantics.
- Public route tests verify validation-only preflight and unconditional submit/reconcile refusal. Actual `index.js` middleware registration is also tested via a VM/mocked host.
- No network operations, real SillyTavern installation, real database writes or migration performed.

## Test-specific limits

- New-instance ledger readback exercises files written by another `OperationLedger` instance, not a restarted SillyTavern process or physically durable disk after power loss.
- Directory-based locks fail closed when left behind by crashes; no unsafe automatic expiry is implemented.
- The test adapter updates revisions synchronously in memory; this does not demonstrate server-side CAS/atomic transactions or real backend concurrency.
- Backend-authoritative source scoping and isolation are NOT obtained by validating a caller's scope strings.
- Real crash, disk-full, symlink-race, concurrent multi-process, malformed backend-ack and network adversarial tests remain necessary.

## Activation decision

**NO-GO for vector mutation activation.** Continue S05–S08 contracts and disposable-host validation, then selectively update per-backend operation permissions. Do not change E02/E06 VectHare runtime policy on S04 test results alone.
