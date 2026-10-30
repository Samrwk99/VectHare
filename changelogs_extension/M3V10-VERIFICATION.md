# M3v10 verification

- **Similharity:** 751/751 tests passed in one full serial Node suite (`plugin-full-final.log`).
- **VectHare:** 1,171 passed in a combined serial run; the unchanged i05 metadata test process crashed in the Node experimental VM runner. The isolated i05 suite passed 15/15. **1,186 distinct tests passed across the two runs**, but the combined run was not clean (`extension-full-final.log`, `extension-i05-isolated.log`).
- **Targeted activation:** one-use activation and source-specific commitment, missing source, stage ownership, stale preview, retained locks after ambiguous receipt, authenticated source selection, typed UI requests. The final plugin full-suite log includes all targeted tests.
- **Source-integrity:** regenerated `S10-BUILD-MANIFEST.json` for the updated code and version, verified by the full plugin suite.
- **Physical Qdrant/SillyTavern acceptance:** not run in this workspace. The integration/fault tests use controlled Qdrant-shaped fixtures and do not establish real backend guarantees.
- **Matrix:** 70 legacy cells unchanged, 8 enabled; 57 blocked for implementation gaps; 5 unsupported by design. Additional bounded model activation capability: ENABLED / AWAITING_MANUAL_TEST.

Safety non-goals preserved: no unrestricted purge; no browser-supplied owner, physical name, vectors or credential; no automatic replay after ambiguous physical writes; no automatic uncertain-lock clearance; not a general model-change migration for collections over 256 records.
