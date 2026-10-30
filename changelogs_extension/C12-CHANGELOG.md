# VectHare — C12 scene editing and temporal policy checkpoint

Baseline: Step 11 C11 cumulative ZIP. Date: 2026-10-28. Similharity plugin unchanged (not bundled).

## #235 — Scene metadata and reindex safety
- Removed the old `updateSceneChunkMetadata()` path that immediately saved scene edits to local settings and displayed success without updating backend data.
- Split scene patches into summary changes (search-affecting: must reindex) versus title/keyword changes (descriptive: may update metadata only). Reject edits to immutable scene identifiers and boundaries.
- Added `utils/c12-scene-update.js` with explicit backend update receipts and a C02/C07-dependent reindex coordinator. A changed summary requires a different physical ID, preserved `sceneId`, reviewed reference plan, and an atomic record/reference commit receipt.
- Connected all three scene editor blur handlers to checked receipts. The UI no longer reports a successful edit after an unverified or partial operation.
- Scene deletion now uses the C02 guarded replacement/deletion coordinator rather than re-enabling old chunks after a weak delete acknowledgement. Chat-owned scene timeline entries are removed only following a verified deletion.
- **Activation blocker:** Actual server-side `updatePayload`, scoped record readback, durable settings save, and atomic C02/C07 remapping contracts remain unverified for the unmodified plugin. As a result scene edits/reindex and deletion remain blocked in the live extension. No data migration was attempted.

## #94 — Per-collection temporal policies
- Implemented collection-specific policy resolution in the real retrieval stage. A collection's `temporalDecay` settings take precedence over the legacy global policy; missing settings have conservative type-aware defaults.
- Nostalgia and decay remain exclusive. Unrelated collections can receive different scores even when their records share a physical hash.
- Scoring preserves candidate identity by input index, not by hash-only mapping, and leaves original vector scores intact until the policy is applied.

## #84 — Independent scene timeline
- Added a chat-origin- and collection-qualified scene timeline in `core/scene-timeline.js`.
- Confirmed local scene creations record boundaries; UI marker discovery can provide advisory scene boundaries independently of whichever scene vectors match a retrieval query.
- Stable C07 message anchors are reconciled against the current chat; missing, reversed, ambiguous, or foreign anchors do not fall back to stale positions.
- The browser settings timeline is **not** a verified durable host record and the UI-discovered snapshot is **not** authoritative inventory. Neither is used as deletion or migration evidence. Existing scenes only become available if independently loaded or explicitly stored.

## #93 — Grouped chunk temporal age
- Added validated group age calculation using the newest known constituent message ID (`metadata.messageIds`), or scene end/message position for legacy records, rather than always the first message index.
- Reject corrupt, future, unbounded and missing membership; do not assign an invented age.

## Compatibility
- Previous C01/C02/C03/C04/C05/C06/C07/C08/C09/C10/C11 safety gates remain active.
- The original `applyTemporalDecayStage()` remains compatible with anonymous legacy test candidates while collection-qualified live candidates use C12 policy resolution.
- No Similharity plugin file was modified, copied into the extension, or distributed in this ZIP.
