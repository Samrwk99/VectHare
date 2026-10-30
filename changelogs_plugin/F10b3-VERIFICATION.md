# F10b.3 — Verification

## Offline validation

- Similharity full suite: **544/544 passed**, clean single run, `node --experimental-vm-modules --test tests/*.test.mjs`.
- New F10b.3 tests: **17/17 passed**. Both local backend fixtures copied to separate fresh directories, checked for byte-exact content and later tampering. Qdrant snapshot staging exercised with injected fake HTTP responses, with no restore/network action.
- VectHare extension suite: **1,169/1,169 passed**, clean single run.
- The plugin local executable-source inventory includes **64 files** and matches the pinned extension manifest.
- Native LanceDB/Vectra SDK reopen: **NOT RUN**. Qdrant collection restore: **NOT RUN**. Milvus backup/restore: **NOT IMPLEMENTED**.
- Real host and physical vector/metadata completeness: **NOT CERTIFIED**.

## Scope of evidence

Local test fixtures prove no-overwrite, byte-for-byte staging, path refusal and corruption-detection logic. They do **not** prove Qdrant snapshot restorability, LanceDB/Vectra physical consistency, semantic inventory equivalence or compatibility with the user's Termux host. Neither backup provenance nor a single atomic control-plane/database snapshot has been established.
