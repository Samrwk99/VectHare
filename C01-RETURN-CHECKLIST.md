# C01 return — acceptance checklist

| Acceptance requirement | Outcome | Evidence / outstanding prerequisite |
|---|---|---|
| Cumulative I01–I18 and Phase 0 retained | PASS | 199 + 33 tests |
| C04-A/B, C06-A/B, C11-A/B foundations retained | PASS | 24 + 31 tests |
| #158 same-hash cross-collection protection | LOCAL PASS | Scoped metadata; legacy hash deletion fails closed; coverage requirement strengthened |
| #158 export-before-delete for protected collections | MOCK PASS / LIVE BLOCKED | Verified receipt and exact record count required; real export UI and storage guarantee outstanding |
| #158 production diagnostics confined to owned test namespace | PREVIOUSLY TESTED | Existing reserved-namespace safeguards retained; no live diagnostics executed |
| #189 exhaustive ownership-qualified record inventory | MOCK PASS / LIVE BLOCKED | Duplicate/owner/end/count checks; source plugin has potentially false-empty reads; server consistency unverified |
| #189 authoritative all-collection inventory for orphan cleanup | MOCK PASS / LIVE BLOCKED | Automatic browser orphan cleanup prohibited; no deployed exhaustive tenant inventory proof |
| #216 tombstone, purge, readback, finalization | MOCK PASS / LIVE BLOCKED | Prepared / purge-sent / purged / finalized; strict zero-count readback; 50 C01 tests |
| #216 reject malformed resume and never blindly re-purge | PASS (local) | Invalid checkpoint, lost ACK and conflicting readback tests |
| #216 durable tombstone/finalization host persistence | **BLOCKED** | ST `saveSettingsDebounced()` provides no durable confirmation; production path returns false |
| #216 tenant-safe plugin purge | **BLOCKED** | Qdrant route calls physical `purgeAll`; Milvus unfiltered drop/error suppression; plugin unchanged as instructed |
| #216 actionable production recovery UI / backed safe replay | **BLOCKED** | Pending tombstones are warned about on load; replay remains disabled until contracts and durable storage are verified |
| #220 available vs empty vs unavailable/unknown metadata | PASS (local) | Existing explicit metadata status handling retained |
| Pinned source plugin inspected without modification | PASS | Source fingerprint audit matched provided ZIP; deployed version not attested |
| Real running SillyTavern/Similharity smoke tests | **NOT RUN** | No running disposable server supplied |
| Unrestricted live deletion authorized | **NO** | Safety gate remains closed |

## To finish C01 live acceptance

1. **A tenant-safe, fail-propagating server purge contract** for the configured backends. Qdrant shared-collection drop and Milvus catch/drop behavior must be addressed in a future plugin release, or those backends must remain excluded from collection deletion.
2. **Independent authoritative list/terminal-page and count readbacks**, including unambiguous tenant ownership. No error-to-empty fallback for destructive decisions.
3. **Host storage with durably acknowledged tombstone and finalization writes**, not a debounced save assumed successful.
4. **Protected export UI and a validated durable export receipt** for protected collections.
5. **Live disposable-server tests**: two tenants in one physical DB, transport lost-ACK, fail-500, partial inventory, process crash between stages, and preservation of unrelated tenant data.
6. Explicit operator review / reconciliation UI before replay, once the above guarantees exist.

**Handoff:** Continue independent C03/C07 work if the plugin remains frozen. Do not mark C01 fully operational or silently enable deletes.
