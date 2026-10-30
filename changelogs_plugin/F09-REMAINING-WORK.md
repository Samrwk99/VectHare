# F09 remaining implementation and acceptance work

## F09b — Complete ordinary-memory service, then selectively activate it

1. Server-managed **embedding generation** across configured providers, with GUI setup of protected credentials and model identity; verify output dimensions, metric, model changes and source alignment. Reject unapproved provider connection details from the browser.
2. Hash-free **chat synchronization**: stable message/chunk UUIDs, explicit source-bound record IDs, C02/C10 replacement ledger integration, versioned comparisons and independent verification after restart. Never infer complete inventory from an ordinary list page.
3. Authorized per-backend **normal mutation routes** (not the disposable pilot routes). Establish exclusive-writer behavior or real database CAS, verify crash/restart recovery, and record atomicity tests. Enable per operation/backend only with actual host evidence.
4. Rewire ordinary chat, summary and World Info **create/edit/reindex/delete** to these v2 routes. Separate Native Standard from plugin Vectra. Preserve security ownership and branch independence.
5. Build **query-text -> embedding -> F02 scoped query -> stable candidate activation -> filtering/dedup/links -> C10 token budget -> final prompt receipt**. Include actual generation-time stop/cancel behavior; never inject cross-branch or unverified text.
6. Test model-change migrations, missing/duplicate records, corrupt metadata, concurrent sessions, two users/branches, chat save/rename/restart, and all supported backend SDKs against real SillyTavern installations.
7. Expose supported operation states in the GUI, with clear unavailable/recovery messages. Prove the original I01–I18/C01–C14 workflows have not regressed.

Only then can the scope originally described as **F09 — normal VectHare workflow restoration** be considered complete. F10 inventory/backup/migration, F11 unified GUI and F12 live release acceptance remain separate phases.
