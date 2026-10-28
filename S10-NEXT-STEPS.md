# S11 handoff — VectHare integration and controlled activation

**S10 provides a stable, fail-closed inspection API; it does not provide certified public v2 record execution.** Do not mark operations ALLOWED solely based on S10's version, build fingerprint, fixture tests or capability descriptions.

1. Confirm actual installed Similharity files match the S10 source fingerprint and independently recorded release ZIP SHA-256; record plugin, SillyTavern, Node, browser, backend SDK and backend service versions. S10's self-reported manifest is not remote attestation.
2. Inspect the current E06 VectHare and build a versioned v2-client adapter for capability/build/contract discovery, fail-closed responses, operation receipts and migration status. Avoid bulk-unlocking the existing E02 runtime matrix.
3. Implement **trusted server-side source authorization** for each chat, branch, lorebook, scene and collection. Verify branch creation actually assigns distinct persistent IDs; detect copied `chat_metadata.integrity` and prevent branch cross-access. Host source grants must not come from body metadata alone.
4. Finalize and connect v2 record get/list/query/mutation routes only after authoritative owner mapping and backend-specific live contracts are established. S04 engine and S05–S08 adapters are fixture-only and do not currently authorize public execution.
5. Address multi-writer revision/CAS and unsafe retry races on Qdrant and Milvus; verify exact or tolerance-aware vector readback against real backend storage, including restart and external writers.
6. Prove SDK/schema/persistence for LanceDB and plugin Vectra; separately probe native SillyTavern Standard endpoints instead of assuming plugin coverage.
7. Demonstrate consistent inventory under concurrent writes, failure propagation, owner checks, stable pagination, and verified exports; otherwise keep those cells conditional/denied.
8. Move S09 fixture migration toward real backend-native backup/staging/rollback, but do not perform valuable-data cutover until sources, snapshots and reference mappings are independently verified.
9. Run disposable, authenticated real-host acceptance: two users, two branches, same-hash records, insert/edit/delete, timeout/recovery, cross-tab/restart, World Info, final outgoing prompt, large inventories.
10. Only then change individually accepted backend × operation policy cells with explicit test evidence and rollback instructions. Produce matched plugin/extension ZIPs and backend-specific release notes.

**Fallback:** If no real host/backend is available during S11, deliver an integration-only candidate and explicit BLOCKED/UNPROBED results; do not claim reactivation or release certification.
