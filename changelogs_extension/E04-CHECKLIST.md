# E04 — Completion Checklist

## Extension-side work complete (locally tested)
- [x] Preserve E03 cumulative sources and E02 safety restrictions.
- [x] Review C08/C09/C10/C11 read-only workflow boundaries.
- [x] Harden chat-completion inclusion receipts against cross-message false joins.
- [x] Preserve safe same-message multipart prompt inclusion and dry-run refusal.
- [x] Fix stale WI previous-scan cache after explicitly empty observations.
- [x] Preserve previous scan when malformed or ambiguous WI events occur.
- [x] Apply deterministic one-winner C09 exclusivity to semantic WI retrieval.
- [x] Deduplicate world-qualified repeated WI entries and clamp WI query/display bounds.
- [x] Refuse disabled/false-enabled results from required hard-linked lookups.
- [x] Add verified-export preflight *before* the browser save file opens.
- [x] Keep C08 live frequency hard gate closed.
- [x] Keep backend contract flags unknown and E02 mutation deny policy unchanged.
- [x] Run new E04 tests (28/28) and historical suite (965/965 total).
- [x] Run E01, E02, E03 and E04 static audits and JavaScript syntax checks.
- [x] Record host-dependent constraints and provide a manual host acceptance plan.
- [x] No Similharity modifications.

## Outstanding: must not be called complete or enabled without live evidence
- [ ] Check the exact deployed SillyTavern version and exported event_types names.
- [ ] Verify `CHAT_COMPLETION_PROMPT_READY` and `GENERATE_AFTER_COMBINE_PROMPTS` *actual* payloads and their timing relative to final request serialization.
- [ ] Compare marker-wrapped blocks with requests actually sent to the model and measure actual tokenizer/context headroom.
- [ ] Verify generation stop/regenerate/swipe/chat switch invalidation on the installed host.
- [ ] Observe real World Info activation payloads and timing, including empty scans and cloned/renamed lorebooks.
- [ ] Verify linked-member fetch only after independently scoped `getByIds` contract evidence; keep unsupported reads unavailable.
- [ ] Verify native Qdrant/Milvus hybrid retrieval behavior, lexical result provenance, and fallback UI under real backend errors.
- [ ] Verify complete scoped inventory, stable pagination, counts and file receipt on each backend before enabling C11 verified exports.
- [ ] Verify durable frequency ledger and final host inclusion receipts across reload/two tabs before enabling frequency conditions.
- [ ] Test actual browser download/permissions, large NDJSON streams, and malformed PNG files.
- [ ] Run integration acceptance on the user's disposable SillyTavern environment (E07).

**Release status:** E04 local read-only improvements delivered; production host integration **uncertified**. E05/E06 backend capability activation remains separately gated.
