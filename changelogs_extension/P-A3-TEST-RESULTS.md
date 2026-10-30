# P-A.3 — Regression evidence

| Suite | Execution | Passed | Failed | Notes |
|---|---|---:|---:|---|
| Extension | 5 bounded `node --experimental-vm-modules --test --test-concurrency=1` batches of all 88 test files | 1244 | 0 | Final test output `/mnt/data/pa_ext_final_1.log`–`_5.log` (local working logs) |
| Plugin | 4 bounded first groups, 15 individual S01–S09 files, and S10 group | 861 | 0 | Full monolithic run reported 832 passing before timeout; bounded verification passed remainder. |

Key negative paths: missing selected embedding profile blocks all DB writes; stale source/owner cursor denied; 250 and 1000 saved records; lost S04 acknowledgement never replayed; direct Repair cannot reach old hash paths; P19 storage diagnostic never invokes legacy insert; prompt injection refuses stale chat and condition-bearing lorebook candidates.

**Not tested:** running installed SillyTavern, user-host provider instances, real physical Qdrant/LanceDB/Vectra/Milvus, real model prompt consumption, cross-process restart under load. End-to-end live acceptance is outstanding.
