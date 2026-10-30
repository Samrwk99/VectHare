# F09c.10 — Release decision

**F09c.10 restricted implementation: COMPLETE.** All normal **S04-based v2 mutation workflows** and F03 collection provisioning now participate in a trusted per-user-root, per-physical-collection cooperating-writer gate. Cross-process local race/forced interruption tests passed. This does NOT certify that every legacy/direct plugin API or external application is lock-mediated; legacy/native Standard v2 mutations remain denied.

**Production: NO GO.** Qdrant, LanceDB, plugin Vectra and Milvus host diagnostics have not been run against actual database installations in this environment. The cooperative writer model requires each participating VectHare process to share the same trusted storage root, with real filesystem atomic-creation semantics and safe crash behavior. These physical conditions have not been independently certified on the target Termux/SillyTavern host.

**Accepted deployment boundary:** unrelated direct database writers are outside the guarantee. Do not substitute the new lock for externally enforced backend CAS or claim coverage over nonparticipating programs.

**Residual limitations:** a crash/UNCERTAIN result retains the lock until independently investigated. There is deliberately no automatic stale-lock takeover, forced reconciliation, migration, purge, backup/restore or automatic production write activation. Full recovery is addressed by F10b. F09c.11 must review real-host evidence per backend before any capability matrix changes.

**Next:** run all four administrator-only disposable host diagnostics, verify two real cooperating host processes and crash/restart cases, then F09c.11 per-backend acceptance decisions. F09c remains OPEN until then.
