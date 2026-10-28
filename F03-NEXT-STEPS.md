# F03 Handoff — Backend Mutation Safety, Concurrency and Readback

F02 only opens the guarded public v2 read plane; it does **not** establish a completed collection lifecycle.

1. Prove backend-native v2 collection/table/index provisioning (Qdrant/Milvus/LanceDB/Vectra) without touching old data, using user-confirmed disposable targets, schema index checks and explicit failure/rollback receipts.
2. Resolve Qdrant/Milvus lack of atomic revision compare-and-swap; design server-wide mutation serialization plus tested concurrency behavior across processes, not only a JavaScript Map/lock. Keep external writers and stale revision hazards in scope.
3. Verify vector readback with actual backend quantization/normalization behavior, including Qdrant cosine and Milvus float32. Never simply disable vector consistency checks to make tests green.
4. Connect F01's attested saved sources, S02 registry and S04 ledger to authorized production insert/update/delete only once a corresponding backend contract passes live acceptance. Block legacy hash-point mutation and auto-migration.
5. Validate native SillyTavern Standard endpoint contracts separately from Similharity Vectra; do not infer native mutation safety from F02 reads.
6. Complete automatic memory pipeline mapping (v2 UUID model versus legacy hashes), embedding generation and final-prompt insertion in the extension in later F04/F09 stages.
7. Run actual disposable SillyTavern/Termux and backend tests, two runs separated by restart, adversarial tenant/branch isolation, error injection and >1,050-record listing; do not claim verified export without snapshot/completeness evidence.

**Current F02 decision:** guarded v2 source-bound get/list/query routes exist and pass offline tests; globally enabled reads, existing legacy retrieval, all mutations, verified export, physical purge and production release are NOT CERTIFIED.
