# S03 — Authorization & Isolation: Handoff from S02

1. **Trusted scope resolver**: derive `userScopeId` strictly from the SillyTavern authenticated request context; never trust browser supplied values. Verify actual host auth/CSRF/router behavior. Server authorize each collection/source and branch identifier; reject missing, conflicting, spoofed scopes. Chat branch fork detection remains VectHare/SillyTavern integration work at S11.
2. **Per-user backend configuration**: replace mutable global Qdrant/Milvus connections and LanceDB first-user `basePath` with host-authorized keyed connection/storage context; partition caches and protect credentials on server.
3. **Registry integration with authorization**: only accept `CollectionRegistry` directory from trusted host user configuration; reserve v2 mapping within authorized scope and explicitly bind it to backend adapters. Never resolve a legacy namespace through string splitting or lossy table sanitization.
4. **Legacy compatibility strategy**: build inventory with physically verified owner evidence; hold ambiguous Qdrant/LanceDB names in review; issue an explicit mapping manifest without automatic data mutation. Version and back up the registry alongside its data in S09.
5. **No unlock until S04**: implement authorized and verified v2 mutations (operation ID, expected revision, independently read-back, explicit uncertain states). Keep S01 legacy mutations blocked even after S03 scope resolver is present.
6. **Test**: two authenticated users with identical text/record UUID, two branch IDs, two Qdrant/Milvus configs, two LanceDB roots, restarted host, concurrent calls; prove isolation with real backend fixtures and evidence receipts.

**Current state:** S02 identity library and offline registry are complete locally; S03 host trust, server wiring, physical database schema, and any live claims are still pending.
