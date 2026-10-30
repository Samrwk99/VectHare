# VectHare P-B.1 — Managed Saved-Record Browser

**Date:** 30 October 2026  
**Matched plugin:** Similharity 3.2.11-p-b.1  
**Status:** partial P-B implementation, automated-test verified; live integration not certified.

## Implemented

- Database Browser now mounts a **separate, authenticated managed saved-source browser** for current saved chat or an explicitly named saved lorebook, Qdrant/LanceDB/Vectra/Milvus. The old discovery list continues to exist and is **not** treated as canonical managed inventory.
- Strict `POST /v2/m1/records/browse` client: server-generated signed cursor, source fingerprint, server-owned binding/physical readback and no caller-controlled owner, vector, text, collection or physical name. Each page displays saved text, UUID, source/registry state and physical verification status. The UI distinguishes source-page completion from whole-collection inventory verification.
- Managed record actions use M1 plan → explicit confirmation → one-use execute → verified receipt, with source change and profile readiness checks. Saved text is edited in SillyTavern first; the plugin never accepts an arbitrary browser text replacement.
- Old hash-based Chunk Visualizer is not opened on managed-v2 records. Its save/delete/text paths also fail closed if a managed v2 result reaches them.
- The orphaned-group "Fix" diagnostic no longer rewrites local membership based on an incomplete legacy hash list. It reports preview-only UNVERIFIED with zero changes pending P14 durable metadata receipts.
- Browser UI discards stale, in-flight results on source, backend or collection-selection changes.

## Explicit limitations

- This is **saved-source record browsing**. It does not claim physical inventory completeness, list physical orphan/foreign records or traverse historical generations. P13/P16 full physical inventory and scene-marker migration remain open.
- The Database Browser's older local discovery, legacy `chunks/list`, import/export and delete controls have **not** been replaced. In particular P08 collection lifecycle UI integration is not complete. Existing guarded lifecycle controls are still in the settings panel; no new destructive permission is granted.
- P07's direct in-place source-text editor and summary controls have no managed mutation commit; direct edits must be made to the saved source and followed by revectorize. M7 summary approval remains future work.
- P14 durable scene metadata commits, P22 server-authoritative collection list and P29 durable group update remain open. The obsolete purge button was not touched.
- Manual test on real SillyTavern and each real backend is outstanding.
