# C12 acceptance checklist — local implementation vs live acceptance

| Issue | Local status | Remaining proof / constraints |
|---|---|---|
| #235 Scene metadata-only edits | **IMPLEMENTED / BLOCKED FOR LIVE USE** — local-only success path eliminated; explicit point update proof required; no re-embed for title/keywords | Plugin needs verified scoped metadata PATCH + independent point readback and host durable settings acknowledgement. |
| #235 Scene summary reindex | **IMPLEMENTED AS GUARDED COORDINATOR / BLOCKED FOR LIVE USE** — distinct replacement identity, preserved sceneId, reference plan and atomic commit required | C02 record replacement + C07 reference remap must be server-verified in one safe transaction; current plugin lacks proof. |
| #235 Scene delete/member restoration | **GUARDED** — C02 coordinator must prove delete before enabling members; timeline removed only on success | Verified backend tenant-scoped deletion and settings persistence missing. |
| #94 Per-collection temporal policies | **IMPLEMENTED LOCALLY** — used by live retrieval stage; distinct policies for distinct collection keys | End-to-end SillyTavern retrieval/debugger verification required. |
| #84 Independent chat scene timeline | **IMPLEMENTED LOCALLY** — chat-origin/collection sidecar + independently loaded advisory marker cache | Full host chat storage/persistence and complete legacy scene-list coverage unverified. |
| #93 Grouped chunk age | **IMPLEMENTED LOCALLY** — newest constituent ID; invalid memberships yield no inferred age | Verify against real grouped chat data and moved-message anchors. |
| Prior checkpoints | **REGRESSION PASS** — all prior 742 tests and 37 new C12 tests | Existing live backend and host limitations remain unchanged. |
| Full C12 production acceptance | **NOT COMPLETE** | Requires disposable host/plugin environment and pinned contracts; plugin not modified. |

## Release rules

1. A successful HTTP response is not a scene update receipt.
2. Do not remove an original scene/vector or activate replacement metadata until the replacement, all references, and host persistence have independent proof.
3. Scene timelines are advisory for temporal scoring, never deletion evidence.
4. Do not enable live scene editing, reindexing or deletion from synthetic tests alone.
