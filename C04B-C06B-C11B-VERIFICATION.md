# C04-B / C06-B / C11-B verification record

## Baseline
`VectHare-I18-Phase0-C01-C04A-C06A-C11A-Checkpoint.zip`.

## Local test commands (executed with Node and the project's package.json)

| Command | Pass | Fail |
|---|---:|---:|
| `npm run test:repair` | 199 | 0 |
| `npm run test:p0` | 33 | 0 |
| `npm run test:c01` | 35 | 0 |
| `npm run test:dependencies` | 24 | 0 |
| `node --experimental-vm-modules --test tests/c04b-c06b-c11b.node.test.mjs` | 31 | 0 |

- Combined: **322 pass, 0 fail**.
- `node --check` for all JavaScript and module test sources: passed.
- New tests cover migration preview, ambiguous owner quarantine, conflicting aliases, stale-plan rejection, pre-migration backups, successful rollback and rollback refusal after further writes, oversize snapshot, chat/character origin enforcement, imported owner handling, ambiguous chat policies, deletion-policy rollback, read/write facade failures, lost acknowledgements, explicit owner and count-scoped inventory, old export cap, and four backend contract ledgers.

## Explicitly not verified

- No live SillyTavern settings durability acknowledgement.
- No pinned Similharity source code, server commit/version, or independent plugin schema capture.
- No live shared-tenant Qdrant/Milvus isolation test, LanceDB pagination test, or native Standard purge smoke test.
- No full C11 streaming export of 120k real records; the C11-A fake backend tests cover that record count.
- No registry migration performed on a user's deployed settings.
- No execution of optional destructive actions against real collections.

**Acceptance:** local source and tests only. Runtime capability ledger must remain conservative; C01 live deletion cannot activate from this checkpoint.
