# F04 Release decision

**Decision: DEVELOPMENT / HOST-ACCEPTANCE PILOT; NOT production-ready.**

What F04 establishes offline: a public, authenticated, source-bound mutation route for Qdrant local v2 collections only; actual S04 ledger and S06 adapter execution; full insert/update/metadata/delete lifecycle verified against simulated Qdrant responses; explicit consent; Qdrant schema+indexes and F03 receipt checks; fail-closed uncertainty and replay refusal; GUI controls with receipt lookup.

What F04 does **not** establish: real Termux/Windows/Linux backend correctness; reliable cross-process and external writer revision semantics; native atomic CAS; successful crash recovery; production prompt-retrieval integration; normal vectorization/memory CRUD; LanceDB/Vectra/Milvus/Standard writes; safe migration/export/backup/purge. These are open release blockers, not toggle switches.

**Production capability matrix remains DENIED for ordinary inserts, edits, deletes, revectorization, collection purge and verified exports.** The new F04 pilot endpoint is specifically labelled experimental/uncertified, and is accessible only after deliberate GUI consent, an exact F03 source-bound receipt, schema and owner-index checks, server-side owner re-attestation, and other restrictions.

Do not use the F04 ZIP as a daily-driver replacement or enable global E02 mutation cells based on its offline tests.
