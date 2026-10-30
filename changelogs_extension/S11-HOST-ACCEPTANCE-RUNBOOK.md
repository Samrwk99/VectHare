# S11 — Disposable-host acceptance and activation gates

**Do not install this checkpoint over a valuable working setup.** Preserve backups of VectHare, Similharity, SillyTavern settings, and databases. The paired plugin is S10, unchanged.

## Setup

- Use a disposable SillyTavern profile with no valuable chats or vectors.
- Record exact SillyTavern version and plugin source hashes from trusted on-disk files, plugin+extension ZIP SHA-256, browser/Node versions, backend SDK/service versions, host auth mode, and username-separated storage roots.
- Test plugin access through normal authenticated SillyTavern routes; do not inject cookies/tokens into scripts or bypass CSRF checks.
- Inspect the `VectHare` settings panel: it should say `Similharity S10 detected (inspection only)` when the three v2 GETs are valid; otherwise show compatibility not verified. A success message does not enable any mutation.
- Confirm the outgoing network trace contains ONLY the 3 discovery GETs during S11 inspection, and no v2 mutation dispatch. Confirm unknown v2 and legacy mutation requests are blocked before network.

## Chat branches

- Create two distinct chats with independent `chat_metadata.integrity` and verify their local collection IDs differ.
- Fork a chat in a disposable profile and inspect what SillyTavern actually copies. If integrity is copied, VectHare should quarantine that ID, preventing accidental reuse. This may also be triggered by renaming a chat; this is an intentional conservative restriction until host-level identity is implemented.
- Repeat across reload, restart, second tab, and an actual host save. Test new branch histories, chat switching, deletion, regen, import and rename without assuming localStorage is trusted ownership evidence.
- Do not clear quarantine by manipulating localStorage to force writes. Resolve identity via an independently authorized host-bound remap process (not included in S11).

## Backend and prompt acceptance (currently BLOCKED/UNPROBED)

- With controlled disposable records, verify backend owner-scoped get/list/query, errors distinctly from empty, final outgoing prompt inclusion, World Info, and frequency behavior. Record sanitized request/response evidence.
- Use separate backend test harnesses for Qdrant, Milvus, LanceDB and plugin Vectra; native Standard routes require their own acceptance. Verify real SDK data persistence and readback after restart.
- For future mutations: require server-source owner grants, tested optimistic concurrency or single-writer guarantees, accurate vector readback, journal reconciliation, safe retries, cross-tenant same-hash tests and evidence of no destructive side effects.
- Verify complete consistent inventory (including >1,050 items and concurrent writes) before exporting or migrating valuable data.
- Preserve negative evidence for each blocked capability. Never change an E02 runtime cell based solely on reported plugin capabilities.

## Exit criteria

A backend/operation may move from `DENIED/UNPROBED` only when matched source + authenticated host + real backend tests + source-owner authorization + operation-specific receipts pass with restart and rollback evidence. No such acceptance results are included in this release.
