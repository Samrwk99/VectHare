# F10 — Bounded source-scoped recovery evidence (development checkpoint)

**Baseline:** F09 matched pair, VectHare `2.2.0-alpha.s11.14-f09` and Similharity `3.2.10-s10.13-f09`.
**This checkpoint:** VectHare `2.2.0-alpha.s11.15-f10` and Similharity `3.2.10-s10.14-f10`.

## Implemented

- Added authenticated `POST /v2/recovery/capture`, `/status`, and `/download` routes. Every request reattests the owned saved chat, branch, group chat or lorebook file and resolves its exact v2 collection with the existing F01/F02 code.
- Only the selected v2 physical collection is queried. Browser-supplied owner, tenant, collection, physical record or arbitrary file paths are refused. Old legacy/hash collection paths are never traversed.
- Capture performs two independent bounded page walks, validates each page/cursor/record, compares the resulting record sets by stable UUID and contents, and re-reads each record by UUID before accepting the capture. Uses strict F02 backend schema and ownership checks; no second ad-hoc backend read contract.
- Bounded to 300 records, 16 pages per pass, 50 records/page, and an 8 MiB persisted JSON payload. Too-large, changing, inconsistent or malformed captures refuse rather than return partial success.
- Captures are written under the authenticated user's `.similharity/f10-captures/` directory with private permissions, exclusive file creation, fsync on supported hosts, per-capture UUID and SHA-256 checksum. Readback rechecks hash, source binding, user identity and data structure.
- Read-only status and evidence download, both from the VectHare GUI. Downloaded files are conspicuously named `NOT-A-FULL-BACKUP`.
- Added explicit opt-in, upfront wording and conservative response validation in the GUI; no automatic capture or background database write.
- Added runtime contract discovery and exact plugin fingerprint pinning for the matched components.

## Explicitly NOT implemented/certified

- **No atomic/snapshot-consistent full inventory.** Two matching scans do not protect against independent writers, backend pagination anomalies or changes after the final readback.
- **No verified full backup, production restore, migration/cutover, collection deletion, purge, legacy-data import or automatic memory writes.** Existing S09 offline migration rehearsals remain separate and require independent authoritative evidence.
- **No certification of Qdrant, LanceDB, Vectra, Milvus or native SillyTavern Standard on the user's actual host.** Native Standard does not inherit plugin-Vectra capabilities.
- **F09's broader automatic embedding/chat synchronization/summary/World Info writes/prompt injection work remains open.**
- The SHA-256 checksum detects accidental or unprivileged on-disk changes, not a privileged local actor capable of modifying both the file and its checksum.

## Source and rollback

F09 source archives are unchanged. Restore the exact F09 matched extension and plugin package to roll back this checkpoint; keep private F10 capture files as investigation evidence unless independently reviewed.
