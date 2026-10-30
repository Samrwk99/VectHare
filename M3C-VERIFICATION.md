# M3c verification

## Automated
- Similharity: `node tools/s10-build-manifest.mjs`; `node --experimental-vm-modules --test tests/*.test.mjs` => **698 passed / 0 failed**. New tests assert forged alias denial, missing target proof denial, generation fencing, missing S04 dispatch fence denial, full target schema/inventory verification, immutable target receipts, tamper detection and journal/backup association.
- VectHare: `node --experimental-vm-modules --test tests/m3-collections-ui.node.test.mjs` => **2 passed / 0 failed**.
- VectHare full combined run `node --experimental-vm-modules --test --test-concurrency=1 tests/*.node.test.mjs`: **1170 passed, one C12 test-file process crashed (SIGSEGV)**, no ordinary test assertion failures. `tests/c12-integration.node.test.mjs` independently => **7/7 passed**, therefore **1177 assertions/tests passed across partitioned coverage**, but **NOT a single green combined run**. See `ext-full.log` and `ext-c12-alone.log`.
- No live Qdrant service, SillyTavern host, Docker or Podman found in the runtime; no real-Qdrant end-to-end acceptance was performed.

## Production certification
- No production capability enabled. The active matrix remains 0 newly promoted cells / 70.
- New server-only modules are tested on disposable and synthetic fixtures, not authoritative real-host evidence.
- M0 and M1 real Qdrant acceptance, M2 assisted physical-lock reconciliation and M3 transaction/acceptance gates remain OPEN.

## Limitations of implemented pieces
- Public F02 binding still **fails closed** after published aliases; its dependency injection and target-specific receipt check must be integrated.
- M1/F03 do not yet consume an alias target receipt through the public route; S04 has an internal trusted plan/fence contract but coordinated journal/source/target write locks are not integrated.
- The internal target receipt verifies a physical readback but DOES NOT authorize restore, collection delete, empty, rebuild, or cutover execution.
- Backup is a private plaintext logical backup and excludes SillyTavern chats/secrets; do not call this a certified production restore system.
