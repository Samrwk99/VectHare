# P-A.6 Final Automated Test Results — 30 October 2026

| Component | Tests passed | Test assertions failed | Execution |
|---|---:|---:|---|
| Similharity Plugin | 875 | 0 | Node.js 22.16, 99 files in seven bounded batches with `--experimental-vm-modules` |
| VectHare Extension | 1,256 | 0 | Node.js 22.16, 89 files in eight bounded batches with `--no-opt --experimental-vm-modules` |
| **Combined** | **2,131** | **0** | All batches exited 0; the final extension batch was executed separately after an overall command timed out. |

The full plugin/extension suite ran with no assertion failures. These are not live tests with SillyTavern, Qdrant, LanceDB, Vectra, Milvus, an embedding provider or a disposable production storage fixture. The separate Vitest suite was not run. Source safety gates/capability matrix remain unchanged.

New P-A.6 regression cases specifically prove: active registry/physically absent vector guarded repair; registry-only recovery with no physical write; owner conflict review; WRITE_PENDING no replay; same-source action revalidation; physical drift prior to registry adoption; registry compare-and-set refusing stale/pending; capability-denied updates becoming review without stopping other records; multi-record review continuing.
