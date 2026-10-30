# M3v10 — Bounded source-scoped model activation

**Base:** M3v9. **Deliverable:** plugin 3.2.10-m3.14, extension 2.2.0-alpha.m3.14.

1. Added `m3-rebuild-activation.js`: one-use plan, saved-source re-attestation, verified staged target and registry, original and target logical collection locks, durable claim, new immutable activation-specific receipt, Qdrant smoke verification, target journal prepare/publish, and last-step source-specific selection commit.
2. Added `m3-source-selection.js`: private per-source profile/config record with integrity seal and terminal audit check. Global embedding profile never changes. M1 plans and mutation readback fence both selected profile generation and physical routing generation; selected embeddings use retained server-side profile credentials.
3. F02 reads reject mismatched embedding profiles and changes in selected source generation during a read; F02 diagnostic UI fetches the server-selected profile for Qdrant. M2 evidence uses the selected profile. M3 backup preflight and capture can follow selected-generation bindings, with end-of-capture selection checks.
4. Explicit rebuild-stage plan reserves a host-attested, deterministic S02 target for a new model. Read-only preview can derive a not-yet-reserved target without creating one.
5. VectHare adds guarded activation plan/execute, source-profile inspection and user confirmations. Browser cannot specify physical names, owners, vectors, credentials or target embedding profile for the activation.
6. Extended lifecycle audit sequences for `activate-rebuild`, source integrity manifest, relevant route inventory and focused failure tests.

**Scope limit:** one initial model activation generation and at most 256 ACTIVE records per stage. The source-specific model activation code is `ENABLED / AWAITING_MANUAL_TEST`, not real-host certified. Other M3 gaps remain explicit.
