# F09c.10 — Integrated real-host acceptance (disposable data only)

**Not executed in this build environment.** Use the matched F09c.10 extension and plugin on a disposable SillyTavern profile with new v2 collections; preserve normal deployments. Do not turn on production writes or manually erase unknown locks.

## A. Build and scope

1. Verify the deployed plugin's S10 source manifest and the extension's S11 version/fingerprint pin match the package; confirm all four backend production mutation flags remain DENIED.
2. Verify `req.s03.vectorsPath` is a trusted **absolute, private, nonsymlinked directory** shared by every cooperating VectHare process managing that same source/user/collection. The lock root is `<vectorsPath>/.similharity/f09c10-writer-locks`; it must reside on a filesystem whose exclusive file creation is atomic between the intended Node processes. Different roots cannot coordinate.
3. Confirm all normal v2 workflows use S04 and F03 provisioning is mediated. Do not use legacy/direct write interfaces for acceptance.

## B. Per-backend disposable diagnostics

Run the F09c.6 Qdrant, F09c.7 LanceDB, F09c.8 plugin Vectra and F09c.9 Milvus administrator-only CLI tools in this package according to their matching earlier host runbooks (included). Their disposable mode requires exact explicit consent and makes a new dataset. **Do not automatically delete/drop/cleanup** collections or uncertain locks. Capture SDK/server version, redacted JSON, physical collection identity, F03 receipt, every operation UUID and failure code.

## C. Cooperative runtime concurrency

1. Start two *distinct* Node/SillyTavern host processes using the exact same private user root and fresh v2 collection, under an administrator-controlled test account. While process A has a dispatched v2 write in progress, attempt a different v2 mutation in process B. It must fail `F09C5_WRITER_BUSY` without backend mutation or new receipt.
2. Confirm success releases the lock and a subsequent new operation is allowed. Confirm a stale revision and other pre-dispatch refusal also release the lock; verify unchanged backend and per-record F03/S04 receipts.
3. Simulate an acknowledged-unknown backend response and a crash/`SIGKILL` during dispatch using disposable records. The collection must remain locked; restarts must not steal it, retry the operation UUID or report the mutation `VERIFIED` without sufficient evidence.
4. Check scoped isolation across two users, chats, branches, lorebook UIDs and collections. Distinct physical collections must not block each other unnecessarily; same collection must serialize.
5. For provisioning, hold the runtime collection lock in process A and attempt F03 provisioning in process B. F03 must fail without creating a physical schema. Conversely, create a verified fresh F03 collection, then test S04 writes to it.

## D. Acceptance rules

- **Hard failure:** interleaved cooperating VectHare writes, wrong source/collection, cross-user exposure, unexpected replay, false `VERIFIED`, automatic unlock of uncertain work, touching existing valuable vectors, unsupported legacy/native/purge activation, or a lock on different roots incorrectly treated as shared.
- **Still required for F09c.11:** independently reviewable physical outputs per backend, OS/SDK versions, crash/restart and source isolation evidence, and all remaining F10b recovery limitations.
- **Accepted exception:** unrelated processes writing directly to the database outside the cooperating VectHare boundary are not in scope.
- Passing local tests or a set of manually checked boxes is **never** itself a production release attestation.
