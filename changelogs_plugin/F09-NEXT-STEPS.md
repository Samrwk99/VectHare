# F09 handoff — activate ordinary memory workflows carefully

1. Build a common authenticated VectHare memory service facade that uses F01 source identities, F02 scoped reads and F03-provisioned collections, with per-operation write authorization from F04–F08 pilots. Do NOT route legacy hash-only mutations to v2 endpoints.
2. Integrate automatic chat vectorization, chunk tracking, summary vectors, lorebooks/World Info, linked memories, revectorization and full retrieval-to-prompt flow for individually certified backends.
3. Establish a strict embedding generation interface and GUI configuration; use server-managed credentials, pin embedding model/dimension/metric per collection and handle model changes via a safe reindex/migration plan.
4. Resolve external-writer and two-user / two-branch mutation safety before promoting production write capability. Continue to gate any unproven backend operation.
5. Verify all backend-specific contracts separately (Qdrant F05, LanceDB F06, plugin Vectra/native Standard F07, Milvus F08). Do not treat synthetic SDK tests as live acceptance.
6. Then F10 verified inventory/backup/migration/rollback; F11 unified GUI and diagnostics; F12 independent host/OS test matrix and release acceptance.
