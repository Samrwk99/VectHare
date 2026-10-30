# F09b.7 — Links, conditions and lifecycle (restricted read-only pilot)

Baseline: VectHare F09b.6 `2.2.0-alpha.s11.24-f09b6` and Similharity F09b.6 `3.2.10-s10.23-f09b6` matched pair.
Updated: VectHare `2.2.0-alpha.s11.25-f09b7` and Similharity `3.2.10-s10.24-f09b7`.

## Implemented

- Added `lib/f09b7-link-conditions.js`, with authenticated `/v2/workflows/link-condition-preview` read-only route for a single saved host-owned World Info lorebook.
- Read the source via the existing F01-attested, same-inode F09b.6 safe file reader; reject unverified origins, oversized or unsupported structure, duplicate/nonstable UIDs, and unsafe client selectors.
- Derive F09b.6-compatible per-source record UUIDs from saved numeric lorebook UIDs. Read each exact record through F02's authorized v2 `get`, with source ownership, scope and schema checks; re-read the source after backend observations and refuse changes.
- Report saved-source lifecycle states `IN_SYNC`, `MISSING_VECTOR`, `STALE_VECTOR`, `DISABLED_SOURCE`, `EMPTY_SOURCE` without deletion authority or orphan inference. Disabled source entries remain visible for diagnostics.
- Support **optional, experimental, source-owned** `vecthareLinks: [numericUid, ...]` annotation, at most eight distinct non-self references per entry. Report bound, disabled/empty and unresolved targets without traversal or automatic activation. This is **not** a verified SillyTavern native World Info link format and has no impact on prompt injection.
- Summarize supported saved lorebook activation-related fields (`constant`, `key`, `keysecondary`, `selective`, `selectiveLogic`) as **counts/flags only**. Do not evaluate conditions or provide active-turn claims. No keyword text leaks to the browser.
- Added extension read-only GUI, strict response validator, fail-closed request gateway rule, capability/contract discovery, exact S11 plugin version and fingerprint pin.
- Added tests for allowed and malformed topology, duplicate UID, self/duplicate/unresolved links, source change, origin/scope tampering, data redaction, GUI schema validation and request gateway refusal.
- Existing F09b.3/F09b.4/F09b.5/F09b.6 guarded pilots and other release NO GO rules remain unchanged.

## Deliberately not implemented/activated

- Editing or persisting links or conditions to vectors; general graph traversal, link-triggered search, hard-link expansion or circular-dependency scheduling.
- Live prompt condition evaluation, World Info host activation/scan parity, condition-based injection, condition frequency accounting, or native Standard engine integration.
- Auto-delete of disabled/empty entries, automatic orphan cleanup, auto sync, cross-collection links, uncertain-operation reconciliation, legacy migration or blanket purge.
- Production writes/reads certification, real Termux/Windows/SillyTavern provider/backend acceptance and external-writer concurrency guarantees.

This is a narrow F09b.7 **implementation checkpoint**, not completion of full links/conditions/lifecycle parity. Outstanding items must remain visible through F09b.8/F09c and later dedicated work.
