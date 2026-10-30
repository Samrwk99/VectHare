# F09c.5 — Host admission and next backend acceptance runbook

## Boundary of this package

This build adds a **cooperating-process lock candidate**, not a deployed exclusive-writer gateway. No public endpoint activates it. The plugin's existing F09b pilots still explicitly use the non-certified mode and must stay on disposable profiles. Do not deploy against valuable vectors.

## Local lock smoke test on a disposable machine

1. Extract the *matched* extension and plugin. Verify the manifest hashes. Do not mix F09c.4 and F09c.5 builds.
2. In the extracted plugin directory run `node --experimental-vm-modules --test tests/f09c5-writer-boundary.test.mjs`. This exercises a real separate Node writer and a killed Node process; it does not write vectors.
3. Ensure the lock root is an administrator-provisioned, private local filesystem directory shared by **all** cooperating mutators. Different lock roots cannot coordinate; NFS/cloud/network mounts are not certified.
4. Check the test rejects an insecure directory and a symlink. Confirm an uncertain/crashed writer leaves a persistent lock; inspect and investigate stale locks manually. **Never auto-delete or TTL-expire locks.**
5. Keep the `writerBoundary` opt-in until the write gateway and backend restrictions have independent proof. Do not use this local module as proof of a production-safe backend deployment.

## Required enforcement evidence per backend

| Backend | Host evidence before enabling any mutation |
|---|---|
| Qdrant | Verify actual version; create isolated disposable collection; isolate write API credentials inside a gateway; deny all direct network/write REST calls by extension clients and other users; prove legacy/raw routes cannot bypass gateway; run conditional applied/skipped/noop races and crash tests. Qdrant `completed` alone is not applied proof. |
| LanceDB | Prove only one trusted host writer can access the database directory; verify filesystem locking/atomicity, independent-process mutations, file permission isolation, and restart durability on the deployed OS. |
| Plugin Vectra | Prove the local index store is inaccessible to bypassing processes, control direct plugin/legacy mutation routes, and test simultaneous processes plus interrupted writes and storage consistency. |
| Milvus | Verify authentication/RBAC, network segregation and direct SDK/REST write denial for non-gateway clients; prove conflict semantics or exclusive writer restrictions, then run live race/crash tests. |

## Cross-backend acceptance gate

Capture redacted physical backend versions, endpoint reachability, effective process identity and ownership, backend permission configuration, independent competing writer attempts, confirmed denied bypass requests, ledger receipts and failed-restart behavior. Use disposable vectors. Maintain a separate evidence chain for each backend. A self-reported checklist or passing offline lock tests can never authorize `atomicBackendCertified`/`externalWriterScopeAttested` or set production matrix writes to true.

## Recovery caveat

The local guard deliberately leaves uncertain/aborted locks in place. Lock removal must be handled only under an independently reviewed recovery runbook after ensuring no writers or ambiguous operation can still be in flight. F10b must complete verified backup/recovery separately.
