# E04 — Manual Real-Host Acceptance Plan (NOT executed)

**Safety:** use the user's disposable SillyTavern installation and throwaway data. This checklist intentionally contains no destructive probes and no credentials. Record exact SillyTavern commit, plugin file hashes, backend versions, browser, time, request captures with private content removed. Do not change Similharity.

## A. Prompt assembly and token budget
1. Start with a single eligible retrieval hit and verify the displayed registration status is not mislabelled as final inclusion.
2. Capture both supported host assembly events for chat completion and text completion; compare the event schema to `utils/prompt-receipts.js`, including multi-part messages.
3. Capture the final *actual* request sent to the model with unique marker-wrapped text. Check each final-inclusion receipt against complete marker boundaries; do not treat an intermediate event as a guaranteed final request.
4. Test truncated and omitted blocks, two placements, dry-run generation, cancellation, chat changes, swipes, regeneration and two-tab use. No frequency count may be spent on an unverified event.
5. Test small and large context sizes, Unicode and macro expansion. Compare host token counts to planner estimates. Preserve context and generation reserve.

## B. World Info
6. Observe real `WORLD_INFO_ACTIVATED` payloads (or documented equivalent event for installed host). Confirm world-qualified UID fields.
7. Trigger two exclusive lorebooks at different and equal priorities. Confirm one deterministic winner, no unseen book activation, and no cross-book UID collision.
8. Trigger an empty activation; verify previous-scan cache is cleared for the current chat but not other chats. Trigger a malformed event; verify it does not overwrite an observed snapshot.
9. Copy and rename a lorebook; verify activated semantic hits are deduplicated by world+UID, not only UID or keywords.

## C. Linked retrieval and lexical fallback
10. Exercise a hard link to an absent chunk. Confirm a missing verified getByIds contract causes an explicit limited result, not an unscoped fallback.
11. Under a demonstrably scoped getByIds contract, test missing, disabled, wrong-tenant, duplicate, group-conflict and capped expansion records.
12. For Qdrant and Milvus, verify read-only native hybrid result fields and ownership. Without a proven lexical interface, verify vector-only fallback is accurately signalled.

## D. Exports
13. Test wrong qualified collection key, missing capability, backend list failure and count mismatch: **no verified backup** should be created.
14. Where pagination/count capability is independently proven, export >1,050 records, verify terminal condition, checksum, counts, tenant ownership and failure on changed/missing pages.
15. Test browser file-save cancellation, low disk quota and large streaming behavior. Verify a completed filename is never used as evidence by itself.
16. Verify legacy JSON and PNG backups visibly communicate UNVERIFIED and size restrictions.

## E. Readiness decision
17. Publish sanitized evidence for each backend separately: version/fingerprint, operation, proof, observed result, failure handling, and production switch status.
18. Keep frequency, verified exports, missing hard-link expansion and unsafe mutations gated until each required proof is obtained. E05/E06 remain the capability-unlock checkpoints.
