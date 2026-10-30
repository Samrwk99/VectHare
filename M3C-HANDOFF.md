# M3c continuation — critical remaining work (do not jump to M4 as though M3 is finished)

## Next highest priority: single, versioned mutation and routing boundary
1. **Atomic cutover exclusion**: make M3 journal prepare/publish and S04/M1/M2 workers share one authoritative collection-wide lock plus deterministic physical target locks, not independent lock roots. A fresh generation check must occur under the lock immediately before dispatch, with crash-safe retained lock/quarantine. Never infer no concurrent physical writers merely from a local marker.
2. **Canonical → target receipt binding**: safely integrate `resolveM3VerifiedTarget` with authenticated F02, M1, F03, S04, S05, M2, M3 backup and provisioning paths. Resolve journal generation server-side on every request. An alias gets no rights from an unverified stored receipt; require the target schema and physical inventory proof. Reject plans/tickets/jobs from previous generations.
3. **Production restore transaction**: plan with complete current source/registry/ledger + mandatory logical backup, typed approval, exact fresh target, single-use M3/S04 operation claim; persist pre-dispatch state and acquire source+target locks; restore exactly once with checkpoint, full paginated vector/payload/index verification and smoke queries; issue target receipt; prepare/publish cutover only after downstream versioned bindings are proven; keep source for rollback. Ambiguous results enter M2 adjudication with the lock retained.
4. **Owned collection decommission**: quiesce jobs and sync, establish full physical inventory == managed v2 registry, fresh backup and source fingerprint, durable one-use operation claim and typed consent; dispatch a single exact collection delete, verify absence, write S02 DELETED tombstone; on ambiguity retain lock and mapping. Shared or foreign physical records prohibit deletion.
5. **Scoped empty**: reuse decommission then fresh identical F03 provisioning and explicitly preserve tombstones/history, no broad purge.
6. **Model-change rebuild**: M2 saved-source re-embedding job into a fresh F03 schema, full verification and shared cutover primitive, rollback retention.
7. **Real host**: latest stable disposable SillyTavern + real Qdrant, close inherited M0/M1/M2 gates, then repeat M3 backup/restore/rollback/delete/empty/rebuild + crashes. Only then enable each per-backend operation in the matrix.

## Non-negotiable
- No `ENABLED` by editing JSON without evidence; no bypassing S01/S04, no unscoped purge.
- No replay of `SUBMITTED`/`UNCERTAIN`, no auto release of unbound physical locks.
- No adding M4 certification as a blocker to completing the Qdrant reference backend first.
