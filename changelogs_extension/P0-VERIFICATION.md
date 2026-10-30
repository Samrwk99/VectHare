# VectHare Phase 0 — local release verification

Input archive: `VectHare(4).zip`, baseline SHA-256 `2b59de6aa7036c5e18caee672735dab68271b33b8185cddb86de6e84c543aa03`.

- Original I01–I18 issue-group regressions: `npm run test:repair` — **199/199 PASS**.
- Phase 0 test suite: `npm run test:p0` — **33/33 PASS**.
- JavaScript and Node test source syntax: `node --check` over all `*.js` and `*.mjs` — **PASS**.
- ZIP integrity: documented in companion SHA256SUMS after build.
- Manifest settings/version unchanged at `2.2.0-alpha`.
- Real SillyTavern/Similharity server contracts and live destructive-operation smoke tests: **NOT RUN, UNKNOWN**.
- C01–C14 scope and 117 Phase 2 issues: **UNCHANGED/OPEN**.

**Go/no-go:** GO for local, isolated review and disposable-data testing of fail-closed safety behavior. NO-GO for claiming production destructive-operation compatibility or re-enabling backend purges without pinned server contract verification. No real backend vectors were used or affected in these local tests.

### P0-9 corrective checkpoint

Additional integration coverage: aborted middle waiter cannot overtake an active holder; active callback cannot release its lock on abort; a throwing active holder still serializes the next waiter. The previously reproduced failure was confirmed in the original Phase 0 ZIP and did not reproduce with the patch. Three additional tests were added (30 → 33).

Production certification, ownership evidence and live server capability verification remain pending; the patch only addresses the in-tab mutex cancellation ordering defect.
