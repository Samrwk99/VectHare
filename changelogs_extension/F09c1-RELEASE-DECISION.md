# F09c.1 release decision — NO GO

**F09c has advanced, but is NOT completed or production certified.** The new S04 engine defaults to a fail-closed atomic-only contract, while the existing explicitly consented F09b pilots retain their uncertified development-only check-then-write modes. A verified atomic adapter and real-backend evidence are still missing for Qdrant, LanceDB, Vectra and Milvus. Never equate the simulated CAS tests or source fingerprint with actual backend certification.

**Keep disabled:** production writes, background sync, automatic orphan deletion, unscoped purge, legacy vector mutation, native Standard mutation, and automatic crash-time mutation reconciliation. F10b/F11b/F12b cannot silently remove this gate.

**Next F09c requirements:** (1) implement or prove backend-enforced atomic compare-and-mutate or independently enforced exclusive single-writer deployment per target; (2) verify against external writers and restart/crash on disposable real host; (3) review redacted independently captured evidence; (4) enable only explicitly certified backend/host combos after separate release decision.
