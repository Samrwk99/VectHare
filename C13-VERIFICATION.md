# VectHare C13 — Verification report

## Basis and limits

Source: cumulative Step 12 C12 ZIP. The Similharity plugin archive was left unchanged. No real SillyTavern host or deployed Similharity server was available in this run; all execution assertions below are **local** Node tests and source-level checks.

## Executed tests

- Original I01–I18 suite: **199 passed**.
- Phase 0: **33 passed**.
- C01, including plugin-source contract audit: **50 passed**.
- C04/C06/C11 A+B: **55 passed**.
- C03: **38 passed**.
- C07: **40 passed**.
- C02: **61 passed**.
- Step 6: **37 passed**.
- C05: **47 passed**.
- C08: **44 passed**.
- C09: **47 passed**.
- C10: **58 passed**.
- C11: **33 passed**.
- C12: **37 passed**.
- Prior total: **779/779**.
- New C13: **44/44**.
- **Cumulative total: 823/823 passed** in isolated serial Node test processes.

C13 fault and edge tests cover invalid/negative/oversize overlap; zero overlap; strategy-specific controls; repeated/empty windows; Unicode-surrogate safety; natural-boundary text; long unbroken words; deterministic chat grouping; duplicate text and distinct UIDs; bounded oversized messages; no in-place switch; distinct rebuild destination; invalid/stale rebuild inputs; imported scene markers/ranges; missing/nested/overlapping/unclosed scenes; preservation of membership and source metadata; and explicit index invalidation on filtering.

## Live limits

No browser-based host version handshake, server readback, tenant-scoped write/replace transaction, or durable migration acknowledgement was executed. New chunker code can be exercised in local preview and in the new-collection pipeline, but actual authenticated writes may be blocked by existing security gates. New strategy metadata is stamped only after the existing write pipeline returns without throwing; the unchanged C02 safety restrictions continue to govern the live write path. C13 migration plans intentionally do not perform destructive updates.

## Regression adjustments

- C07 extraction harness now supplies the added live strategy validator.
- Phase 0's formerly unsupported adaptive-chat assertion is now scoped to **live existing chats** and adds the new uploaded-chat positive assertion.
- I13 overlap=0 regression now executes the revised effective-overlap expression, checking zero behavior rather than matching an obsolete source string.

No old test was removed or made non-asserting.
