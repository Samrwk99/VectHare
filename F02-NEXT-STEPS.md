# F02 Handoff — Public Read Integration

**F01 delivers:** authenticated, per-user persisted source bindings for saved solo chats, group chats and lorebooks. It does **not** certify a browser's active chat, scene membership or backend records.

1. Use the F01 source mapping as a **server-derived scope**, not a client-selected `scope`, `collectionId`, `userScopeId` or `branchId`.
2. Design v2 public `get`, `query` and bounded `list` endpoints that re-check F01 host-source ownership per request. Do not use a cached browser response as authorization. Unrecognized legacy records stay quarantined.
3. Implement/verify backend-specific collection provisioning with the S02 registry and F01 source binding; the F01 registry itself does **not** prove a Qdrant/Milvus physical collection or record belongs to that source.
4. Validate Qdrant/LanceDB/Vectra/Milvus owner fields and independent readback on live disposable backends. Use real backend filters, not metadata-only client assertions; distinguish list for display from consistent full inventory.
5. Map VectHare's chat, lorebook and branch collection readers to F01-derived v2 IDs. A host branch with copied `integrity` must still have independent retrieval. Avoid automatically importing existing hash-based legacy memories.
6. Specify a host integration for active-chat binding and dynamic chat creation; F01 only attests existing owned files. Resolve ambiguous renames/imports and scene/hard-link ownership before claiming complete host-source support.
7. Add guarded public-read capability cells **only after** actual authenticated host and backend tests. Keep all writes disabled through F02.

Do not bypass the S10/E02 safety matrix or rename F01 `HOST_FILE_OWNED` as evidence of production database authorization.
