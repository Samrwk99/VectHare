# F09 verification and limitations

- Plugin cumulative Node suite: **317 passed, 0 failed**. Includes F09 request validation, owner/collection scope rejection, unique UUID candidate parsing, mocked route tests and an integrated F01/F02 saved chat and copied-branch namespace test.
- Extension isolated Node VM suite: **1134 passed, 0 failed, across 67 test files**. Retries: [{"file": "c12-integration.node.test.mjs", "codes": [1, 0]}]. The one retry was not independently diagnosed as a VM crash; a retry is not equivalent to a clean first-pass run.
- Focused extension compatibility and F09 tests after final fingerprint update: **27 passed, 0 failed**.
- Plugin and extension source syntax checks passed using `node --check` over JS/MJS files.
- F09 route reuses the server F02 source attestation, registry and schema checks. It is not a new production authorization or a verified full database inventory.
- No real SillyTavern host, Termux Qdrant or native LanceDB/Vectra/Milvus SDK exercise occurred in this container. No live production capability is certified.
