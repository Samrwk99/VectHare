# VectHare F01 — Host-owned chat, branch, group and lorebook identity

**Checkpoint:** F01 (28 October 2026)
**Extension:** 2.2.0-alpha.s11.6-f01, derived from S11.5/H01
**Plugin:** 3.2.10-s10.5-f01, derived from S10.4/H01
**Intent:** Establish stable, authenticated, file-backed *source identity* without relaxing any existing safety gates.

## Implementation

1. Introduced `lib/f01-host-sources.js` and authenticated `POST /v2/sources/attest`. A selector can request a **solo chat**, **group chat**, or **lorebook** owned by the authenticated SillyTavern user. The request cannot supply a user ID, collection ID, record ID, physical storage location, or credential. Server-side resolution relies on `req.user` and `req.s03` only.
2. Solo chat lookup derives the chat folder from the character avatar filename, then checks the matching user-owned character avatar and `.jsonl` chat file. Group chat lookup verifies both the `.jsonl` file and the containing group's `.json` membership. Lorebook lookup is confined to the user's worlds directory.
3. Real-path, source-directory, file-type, symbolic-link, hard-link, traversal, and per-user-root checks reject unverified selectors. Chat headers are inspected with bounded reads; their `integrity` field is advisory, **not a grant**. A copied UUID cannot merge two saved branch files.
4. Introduced a persisted per-user source mapping at `vectors/.similharity/f01-host-sources.json` with an initialized marker, exclusive creation lock, atomic replacement and basic structural validation. Newly verified source files receive persistent opaque `f01_<UUID>` IDs; branch chats receive distinct `branchId` and `sourceId`. A same-file rename may retain its identity when a unique physical file signature can be verified. A changed source or ambiguous mapping is refused.
5. Added truthful API reporting: `HOST_FILE_OWNED` means *file ownership within the authenticated user's SillyTavern data*, **not** active-chat authorization, backend-record ownership, production-read certification or write permission. No vector mutations or backend connections are issued.
6. Added an extension request-gateway exception strictly for source-attestation selectors, a source attestation client, and GUI controls to verify the selected chat/branch or a named lorebook. An unrecognized v2 route remains denied. Existing public record reads and writes remain disabled.
7. Updated S10 local executable source fingerprint and the extension compatibility pin to the matching F01 plugin package; historical S01–S11 source manifests are retained as historical artifacts, not rewritten.

## Unchanged gates

- `POST /chunks/insert`, delete, purge, legacy shared reads, `POST /v2/records/*`, `/v2/reads/*` execution and `/v2/operations/submit` remain denied.
- Native Standard writes remain unprobed/denied.
- No Qdrant/Milvus/LanceDB/Vectra backend was accessed during F01 source testing.

## Limitations that remain

- A user can select *any source file belonging to that same authenticated user*; the server has no trustworthy assertion of the **currently active browser chat**. It explicitly returns `activeChatVerified:false`.
- F01 identifies a saved source file, **not** each individual scene, hard link, imported record or legacy collection. Those mappings need F02/F04 adapters and host-specific acceptance.
- New chats not yet persisted to disk cannot be attested. Changed/missing/duplicated legacy data can require manual review.
- A rename implemented as a copy-and-delete, ambiguous duplicated metadata, or a changed parent relationship may require a reviewed remapping instead of automatic identity continuity.
- No SillyTavern/Termux/Windows browser-host acceptance has been run in this environment.
- An identical chat header copied over an existing registered pathname can be indistinguishable from an ordinary host atomic save; this needs host-level persistent identity support for stronger anti-replacement proof.
