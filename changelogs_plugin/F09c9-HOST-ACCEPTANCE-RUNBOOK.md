# F09c.9 — Milvus disposable real-host acceptance

Use a **disposable** Milvus instance/database and separate administrator-controlled local directory, never valuable or production vector data. An explicit fresh collection is created and **not automatically dropped**. Use the matched F09c.9 package only; preserve logs and timestamps.

1. Install the matched extension and plugin on your isolated host and verify the S10 plugin manifest and S11 pin. Ensure `@zilliz/milvus2-sdk-node` compatible with your Milvus server is installed in the plugin environment. Use a host-local Milvus endpoint (127.0.0.1 or localhost) on an explicit port; do not expose this probe to a remote service or untrusted operator.
2. Prepare a new private directory outside normal SillyTavern vectors, e.g. `mkdir -m 700 /tmp/vh-f09c9-admin` (or private host-equivalent). No symlinks or world-readable directory.
3. Run preflight (does not contact Milvus):

   `F09C9_PRIVATE_PARENT=/tmp/vh-f09c9-admin F09C9_MILVUS_ADDRESS=127.0.0.1:19530 node tools/f09c9-milvus-host-probe.mjs`

4. Only on a disposable server after confirming consent:

   `F09C9_PRIVATE_PARENT=/tmp/vh-f09c9-admin F09C9_MILVUS_ADDRESS=127.0.0.1:19530 F09C9_MODE=disposable F09C9_CONSENT=CREATE_NEW_DISPOSABLE_LOCAL_MILVUS_COLLECTION node tools/f09c9-milvus-host-probe.mjs`

5. Capture redacted JSON output, Milvus version, installed SDK version, unique collection identity, passed/failed stages, writer-lock and ledger evidence. No secrets in logs. Verify the collection was **not** dropped or purged. Review manually before any cleanup.
6. Run controlled tests with two separate cooperating writer processes sharing the same lock root, stale revisions, simulated timeout during insert/upsert/delete, process kill/restart, cross-user and cross-source refusal. Use fresh disposable collections per attempt; do not manually clear an uncertain lock without review. A clean disposable diagnostic alone is **not** production approval.

**Hard failures:** Existing collection touched, auto-drop, unexpected retry, wrong scope, wrong physical ID, lock bypass by a cooperating writer, misreported `VERIFIED`, or unauthorized mutation. Retain all diagnostic evidence and keep production permissions disabled until F09c.10/F09c.11 host acceptance.
