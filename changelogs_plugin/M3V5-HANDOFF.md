# M3v5 → next milestone handoff

## Current state
Qdrant single-record CRUD, logical backup/restore, pristine rollback, owned canonical deletion and *owned canonical scoped empty* have guarded executable UI and automated coverage. Matrix: 8/70 ENABLED/AWAITING_MANUAL_TEST; 57 BLOCKED; 5 UNSUPPORTED_BY_DESIGN.

## Incomplete M3 contracts
1. **M3.5 new-model rebuild**: binding identity includes model/dimension; implement server-authorized target profile staging, saved-source re-embedding via bounded M2 jobs, fresh independently provisioned target, full readback/smoke queries, explicit activation and retained old version. Never swap incompatible vectors under an old collection identity.
2. **Administrator uncertain-operation reconciliation**: implement evidence-bound M3 audit + S04 + S02 + physical inventory + process-liveness consistency, and a one-use administrator approval with proof-safe lock release. No force-release or speculative retry.
3. **General lifecycle after cutover**: make backup, delete and repeat-empty respect a versioned binding and independently attested managed evolution. Current destructive operations are canonical-only; avoid misleading blanket eligibility.

No further infrastructure-only iteration should be required for the finished scoped-empty path. Run user manual acceptance on disposable SillyTavern + Qdrant. Independent M4 work can proceed while the remaining M3 operations stay narrowly blocked.
