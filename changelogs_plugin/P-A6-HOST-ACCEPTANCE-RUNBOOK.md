# P-A.6 automated verification and live acceptance

## Automated checks

- Server/plugin: unit and suite tests of M1 plan/apply, physical reads, missing-vector regeneration, physical-provenance conflicts, registry-only recovery, stale physical read on commit, pending write no-retry, and all other existing server tests.
- Extension: complete managed-chat page processing and both Repair entry points; missing repair actions, registry reconciliation, conflict review, capability denial, interrupted batch and legacy-denial regressions.
- Automated suite totals are recorded in the handoff after the final rerun. Node 22.16 requires `--experimental-vm-modules` and may require `--no-opt` for stability.

## Mandatory live checks (not performed here)

1. Install the matching P-A.6 pair; configure and verify a valid server-owned embedding profile and source binding.
2. For each backend, run Sync; physically delete one exclusively owned active vector, then use Repair and verify that one M1/S04 receipt was VERIFIED, physical record exists and registry becomes ACTIVE again. Do **not** use a foreign or shared collection.
3. Remove only the local managed registry entry for a disposable source with a proven physically owned vector; run Repair, verify registry recovery without a physical insert. Do not tamper with real production registry files.
4. Edit/swipe a saved chat message; Repair updates the vector and revision. Deliberately introduce a conflicting foreign ownership scenario in a disposable fixture; Repair marks review and leaves other sources untouched.
5. Simulate an uncertain operation; confirm no automatic replay; test interrupted multi-page repair and a changed source fingerprint.
6. Check progress/result counts and that orphan review does not cause automatic deletion.
7. Validate profile preflight, provider compatibility, and retrieval prompt on the installed host. P19 storage fixture remains deliberately SKIPPED / UNVERIFIED.

These are not claims of actual host, provider or database certification.
