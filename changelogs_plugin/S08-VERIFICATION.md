# S08 — Verification report

**Build:** 3.2.8-s08.0 · **Baseline:** S07 · **Scope:** offline mocks and source checks only.

- Cumulative Node test suite: **187/187 PASS**, 0 FAIL (`npm run test:s08`).
- S08-added test cases: **23**; previous cumulative baseline: **164**.
- JavaScript syntax check: `npm run check:s08` (count in package test report).
- New local adapters require exact canonical S02 collection/record identities and S05 server-attested bindings; all public writes remain disabled.
- Mocked LanceDB schema check rejects missing v2 fields or wrong dimensions. Both adapters reject altered payloads, noncanonical float32 vectors, stale revisions and forged branch/tenant mutation plans.
- Tests exercise insert → independently read back → update/metadata revision → scoped delete → verify absence for each backend on disposable mocks.
- Tests exercise failed backend operations, uncertain update acknowledgements, Vectra transaction cancellation and S04 ledger integration.
- Both backend adapters traversed 1,090 test records without claiming snapshot consistency or export certification.
- Confirmed S01 legacy route gates are unchanged and new S08 adapters are not registered on public HTTP routes.

## Explicitly NOT tested / NOT certified

Real LanceDB native/Arrow SDK or Vectra runtime; installed-version API compatibility; actual SillyTavern host authentication, user and chat/branch grants; backend persistence/restart; filesystem durability; concurrent-process writers; snapshot export; native SillyTavern Standard endpoints; existing legacy migration; final model prompt integration.

**Release decision:** NO new public reads/writes enabled; do not install over a working data-bearing plugin. This is an implementation-and-test checkpoint for S09/S10/S11 integration, not a production release.
