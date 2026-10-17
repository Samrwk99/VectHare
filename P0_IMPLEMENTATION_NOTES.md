# VectHare P0 implementation notes — 17 October 2026

This package contains the **complete VectHare extension**, based on the previously
patched llama.cpp/Qdrant-endpoint ZIP. All existing project source and documentation
are included; the P0 regression harness is `tests/p0-safety.mjs`.

## P0 1–13: implementation status

1. **Uploaded chat target:** Uploaded chats now create their own independently
   named collection; they never inherit the currently open chat's destination.
2. **Metadata erased during refresh:** Automatic cleanup no longer deletes
   settings/locks based on partial discoveries or bare-ID comparisons.
3. **Cross-backend collision:** Full `backend:source:collection` identity is used
   for metadata, bindings and retrieval; ambiguous legacy aliases are not
   silently interpreted as belonging to another backend.
4. **Wrong same-character suggestion:** Auto-Sync discovery considers exact
   chat IDs and explicit bindings, not character-name substring matches.
5. **Connect discards selection:** The chosen full collection key is persisted
   as that chat's binding; syncing targets that binding only. Unverified legacy
   collections may be connected **read-only**, not automatically written to.
6. **Replace All safeguard:** Current-chat detection uses the correct source
   property; replacement stages a new collection without first deleting the
   old vectors and switches the binding only after insertion succeeds.
7. **Missing write ownership:** A separate persistent chat-to-collection
   binding is enforced; two chats cannot concurrently claim write ownership.
   Exclusive chat and character locks also restrict write access. Unverified
   legacy bindings are read-only.
8. **Qdrant multitenancy:** Implemented with the companion, patched Similharity
   plugin supplied in the distribution bundle. Tenant-qualified UUID point IDs
   prevent collisions between two logical collections containing identical hashes.
   The plugin applies `content_type` filters server-side to list, query, lookup,
   stats, metadata edit, per-hash delete and whole-tenant purge. The extension
   checks an explicit plugin capability contract before shared-mode operations
   and refuses unsafe operations with an old plugin. The shared physical Qdrant
   collection is preserved during tenant purge. This behaviour is covered by
   isolated mock-Qdrant tests; **live integration remains outstanding**.
9. **Qdrant purge false error:** Removed undefined-variable references; purge
   checks HTTP and response failure conditions before reporting success.
10. **Delete falsely reports success:** Failed purge retains registry entries,
    metadata and bindings. Backend/source mismatch blocks deletion.
11. **Import Overwrite mixes vectors:** Overwrite aborts unless the existing
    collection purge explicitly succeeds.
12. **Purge All erases settings after failed server request:** The UI checks
    HTTP and JSON failure results before resetting extension settings.
13. **Resync clears registry before discovery:** Resync/refresh preserves the
    registry until discovery succeeds and never deletes merely unobserved entries.

## Expected safety behaviour

- Existing legacy collections with missing/unverified original model or
  chunking settings can be selected and **connected read-only**. This also
  blocks manual and automatic writes, in accordance with the agreed policy.
- Collections created by the revised Content Vectorizer gain an explicitly
  verified write binding. Complete per-collection embedding-profile capture
  and compatibility revalidation are **P1** work and are not implemented here.
- The old collection remains available after successful staged replacement.
  Cleanup of unused collections is a separate, explicit action.
- No automatic collection or metadata deletion occurs when a server is offline.

## Testing and limitations

- `node --experimental-vm-modules tests/p0-safety.mjs`: 35 isolated P0
  regression assertions, including updated Qdrant tenant routing checks.
- `node tests/p0-tenant-isolation.mjs` inside the companion Similharity plugin:
  9 isolated Qdrant simulation checks for tenant ID separation, matching hashes,
  filtering, deletion, overwrite safety and dimension mismatch.
- All extension JavaScript files pass `node --check`.
- `git diff --check` is clean.
- Full Vitest suite **not executed**: npm dependencies could not be installed
  from the registry in this environment.
- **No live SillyTavern, Similharity or Qdrant server** was available. E2E
  validation therefore remains unverified; Qdrant contract tests use a mock.

**Recommendation:** Back up the existing extension settings and vector database
before installation. Test Connect, staged Replace All and ordinary Qdrant
separate-collection mode on a disposable chat first.
