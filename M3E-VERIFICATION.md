# M3e — Verification report

## Evidence obtained

- **Plugin automated tests:** `700/700` tests passed in the main partition (excluding `f09c10-runtime-lock.test.mjs`); `12/12` passed in its own process. Total **712/712** assertions passed over the two runs. See `plugin-partition.log` and `runtime-lock-alone.log`.
- Combined plugin invocation produced one cancelled timing-sensitive test (`f09c10-runtime-lock.test.mjs`, `Promise resolution is still pending...`), not a failed assertion; one isolated rerun was also cancelled, but a subsequent isolated rerun passed. Do not claim a clean combined full-suite run.
- **M3e focused:** `8/8` tests passed covering one-shot restore/cutover, lost Qdrant acknowledgement and retained lock, absence of automatic retry, bad smoke result, M1 planning and S04 generation-fenced mutation, post-cutover managed evolution requiring verified ledger receipts, stale saved source before claim and unforgeable lock holder.
- **Extension focused:** `2/2` M3 UI tests passed; extension executable was unchanged from M3d. No claim that its full suite was rerun in M3e.
- `S10-BUILD-MANIFEST.json` regenerated; records **84** source files at plugin version `3.2.10-m3.5`.
- ZIP archive integrity tested separately at packaging.

## Environmental constraints

- No local SillyTavern or Qdrant process was observed; the conventional `127.0.0.1:6333` Qdrant endpoint refused connections, and Docker/Podman were unavailable in this workspace.
- All M3e Qdrant tests used controlled Qdrant-shaped in-memory fixtures, **not** a real Qdrant instance. Their results are *implementation evidence only*.
- Real-host acceptance for M0/M1/M2/M3 remains open. In particular, Qdrant HTTP semantics, concurrent unrelated writers, restored target index and payload fidelity, crash-restart recovery, rollback, decommission and rebuild have not been certified.
- No production capability is marked `ENABLED` by this package.
