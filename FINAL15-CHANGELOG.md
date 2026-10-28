# VectHare — Step 15 verification changelog

Baseline: `VectHare-Step14-C14-Cumulative-Emotion-Similarity-Checkpoint.zip`. No Similharity plugin modifications.

## Defects corrected during cross-stage acceptance

1. **C02/C07 physical migration handoff:** registered `physical-id-migration` as a valid durable journal operation kind. Earlier C07 tests mocked the replacement callback; when exercised through the real C02 journal, the operation kind was rejected before any write could be journalled. Fix: `utils/c02-operation-journal.js`. Verified by a real cross-module insert/readback/delete/recovery test.
2. **C07 physical ID collision during staged upsert:** reject a target ID that is an existing *different* source record ID. Otherwise an insert could overwrite old content before the entire migration was verified. Fix: `utils/c07-physical-migration.js`; reason `target-id-overlaps-other-source`.
3. **C04 legacy registry many-to-one migration:** refuse two legacy sources mapping to the same qualified identity even when metadata is byte-identical. That case could merge two distinct registry ownership records. Fix: `utils/c04-registry-migration.js`; migration remains opt-in and requires durable persistence.

## New tests

`tests/final15-integration.node.test.mjs`: 8 cross-stage assertions covering the three fixes above; real C07→C02 commit and lost-ACK reconciliation; C10→C08 verified inclusion accounting, reload and stale chat; C11 verified NDJSON versus C01 protected backup receipt mismatch (fail closed); and C11 failed-page writer abort without completion receipt.

## Cumulative verification

* All previous 855 tests preserved and passed; new 8 tests passed; **863/863** across 46 individually isolated Node test files.
* **174/174** JavaScript/ESM files pass `node --check` on Node v22.16.0.
* No original files removed; exactly three original source files modified and one new integration test added, apart from these Step 15 reports.
* Source plugin inspected read-only. No plugin code included in the release ZIP.

## Explicit non-goals

This audit cannot create host durable settings acknowledgements, source plugin tenant-safe purge semantics, browser/IndexedDB live evidence or deployed model classification accuracy. No capability flags were promoted or safety blocks lifted.

