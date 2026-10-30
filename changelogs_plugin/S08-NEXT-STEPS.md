# S09 handoff — Migration and compatibility

1. Use the cumulative S08 ZIP as the source baseline; preserve all S01–S08 public gates. Retain original plugin and existing dataset backups untouched.
2. Implement a read-only *authoritative* legacy dataset inventory, distinguish trusted source mapping from client metadata, enumerate conflicts/duplicates and refuse ambiguous ownership.
3. Design backend-specific v2 schema provisioning using pinned, real SDK versions. S08 LanceDB/Vectra adapters currently expect an existing, explicitly mapped v2 schema/index; DO NOT silently create tables/indexes during legacy startup.
4. Implement backup/snapshot, dry run, copy-to-new-target, independent verification, and reversible cutover; never rewrite source hashes/physical IDs in place without a verified mapping.
5. Maintain complete legacy reference mapping (including chat branches, lorebooks, scenes and chunk references), and quarantine ambiguous or colliding legacy records.
6. Require write quiescence or another proven consistent snapshot across the migration. Do not use offset traversal or a mere page count as complete authoritative inventory.
7. Resolve LanceDB SDK `update()` and `orderBy()/offset()` native compatibility, Arrow fixed-vector schema, revision count acknowledgements and multi-process isolation before promoting the S08 adapter.
8. Resolve plugin Vectra vs native Standard differences; test actual Vectra SDK item IDs, transactions, index persistence/restart and owner fields separately from SillyTavern native `/api/vector` calls.
9. Preserve S06 Qdrant and S07 Milvus concurrency/CAS, native SDK/vector precision and host source authorization blockers until live evidence exists.
10. S10/S11 must connect only accepted server contracts and verify disposable-host end-to-end insert → readback → retrieve → prompt → update → delete → export → restart, twice separated by a restart.
