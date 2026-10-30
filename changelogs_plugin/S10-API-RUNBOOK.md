# S10 API and deployment-identity runbook

## Status and limitations

This is a development-only, **fail-closed** checkpoint. `GET /health` is available without the new S03 user-context requirement; `GET /capabilities`, `GET /v2/capabilities`, `GET /v2/contracts`, and `GET /v2/build` require the authenticated SillyTavern user context. The plugin assumes the installed host routing layer provides authentication and appropriate CSRF handling; this has not been tested on the real host.

- `GET /health`: lightweight plugin/checkpoint/version and measured fingerprint, `productionCertified: false`.
- `GET /capabilities` and `GET /v2/capabilities`: per-backend operation **statuses**, not permissions. `DENIED_NOT_LIVE_CERTIFIED` is not overridden by client flags.
- `GET /v2/build`: runtime source fingerprint, manifest fingerprint and measured file count; explicitly reports no deployment/host/dependency/backend attestation.
- `GET /v2/contracts`: stable documented fail-closed v2 interface; no certified record-operation execution contract yet.
- `POST /v2/operations/preflight` and `POST /v2/reads/preflight`: validate shapes but never authorize source access or execute requests.
- `POST /v2/records/{insert,update,delete}`, `/v2/collections/{clear,migrate}`, `/v2/operations/execute`: HTTP 409, `S10_OPERATION_NOT_CERTIFIED`.
- S04 submit/reconcile, S05 read execution and legacy write endpoints remain blocked by their original gates.

## Source fingerprint

1. On **trusted source only**, use `npm run build:s10` after all intentional executable source changes.
2. Run `npm run check:s10` and `npm run test:s10`.
3. Record both the SHA-256 of the distributed ZIP and the `sourceFingerprint` from the locally generated `S10-BUILD-MANIFEST.json`.
4. The plugin refuses to register routes on missing, added or changed executable source files relative to the manifest.
5. Compare the installed host's `/v2/build` fingerprint against the independently recorded trusted artifact fingerprint. A matching self-report is **not cryptographic remote attestation**: an attacker controlling plugin source and its manifest can replace both. The host, executable Node runtime, dependencies and actual backend services are not authenticated by this mechanism.
6. Never promote an operation merely because version/fingerprint matches. Live operation-specific tests and explicit authorization policy are additional prerequisites.

## S11 acceptance prerequisites

- Exact authenticated SillyTavern revision and verified chat/lorebook/scene/**branch** ownership, including copied branch metadata and cross-user isolation.
- Demonstrated end-to-end retrieval into the final outgoing model request and settings durability after restart.
- Real Qdrant/Milvus read, write, ownership and concurrency/CAS challenge tests; vector precision/readback reconciliation.
- Real LanceDB/Vectra SDK compatibility and durability; native Standard endpoints separately evaluated.
- Snapshot-consistent, independently verified >1,050-record inventory before certifying complete export or production migration.
- Real backend-native migration/backup/restore/rollback (S09 only rehearsed JSON fixtures).
- At least two accepted disposable runs including one after restart. No productive dataset used for probes.

## Rollback

Preserve the unmodified S09 and original Similharity archives. This build has not migrated data and has not enabled writes. Revert code/configuration as a matched installation while taking care not to restore older unsafe routes against valuable databases. Backup data independently before any future upgrade or migration.
