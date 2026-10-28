# F04 Host acceptance — Termux Qdrant, disposable test only

## Before installation

1. Use a disposable SillyTavern profile and newly created test chat. Back up the existing extension/plugin, settings, and vector databases. Never install this build over your only copy of important data.
2. Install the F04 **extension and plugin together** from the matched ZIP. Restart SillyTavern. They are pinned to an exact plugin source fingerprint; do not mix F03/F04 files.
3. Start Qdrant on the **same device/network namespace** as the SillyTavern Node.js process. Verify `curl -fsS http://127.0.0.1:6333/collections` (adjust the port if your GUI uses another loopback port). This may be Qdrant under Termux or another Linux environment, so confirm Node.js can reach it.
4. In VectHare GUI configure Qdrant **Local**. Use the existing connection Save/Test control. Cloud/default connections are **not** permitted in the F04 pilot.

## Create the dedicated v2 test namespace

1. Save a brand-new disposable chat. Unsaved chats have no F01 file-backed identity.
2. In the F01 source verifier, confirm the saved source is owned by the logged-in SillyTavern user.
3. In F03 collection setup, choose **Qdrant** and provide your **exact** embedding provider/model, dimension, and metric. Preview the generated `vh2_...` name, then deliberately confirm creating a **NEW empty** collection. Do not repeat provisioning if the receipt says UNCERTAIN.
4. Confirm F03 receipt state `SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED`. This means the server inspected the schema; it does **not** mean the running service is release certified.

## Test one complete F04 record lifecycle

The new **F04 — Qdrant v2 manual mutation PILOT** panel is independent of ordinary VectHare memory workflows. Use the same embedding identity as F03.

1. Select **insert**, revision `0`; enter a short synthetic sentence and a vector with *exactly* the configured dimension. For a disposable 3-dimensional F03 collection, for example, use `[0.1,0.2,0.3]`. Enter optional metadata `{"test":"f04"}`. Leave the record UUID empty so VectHare generates a fresh one.
2. Check the explicit consent box and press **Execute one F04 pilot mutation**. Expect `VERIFIED`, a record UUID and revision `1`. Do not attempt a second insert for the same record ID.
3. In F02 v2 read controls, use the same chat/backend/embedding identity and **get** the record UUID. Confirm owner scope, text, metadata and actual vector.
4. Select **update**, keep the same record UUID, set revision `1`, change both text and vector, and submit with fresh consent. Expect revision `2`. Perform the same F02 readback.
5. Select **metadata**, keep the same record UUID, set revision `2`, enter a metadata JSON object and submit. Expect revision `3`. Check that text and physical vector remained unchanged.
6. Select **delete**, keep the same record UUID, set revision `3`, and submit. Expect revision `4` as the operation target, with the record absent in F02 get. There is no global purge.
7. Restart SillyTavern and inspect the operation receipt using **Inspect last operation receipt** before closing the page. After reload, paste the saved operation UUID into the receipt input and inspect it from the GUI. Also re-check that the record is absent.
8. Try an old revision, unauthorized source, wrong vector dimension, a branch using copied integrity, and an operation UUID replay. All must fail **without mutation**.

## Important fail/uncertainty handling

- If a response says `UNCERTAIN`, `SUBMITTED`, or you lose the connection after clicking Execute, **do not click Execute again**. Record the operation UUID and inspect `/v2/operations/:id` through the authenticated route or the GUI receipt control. The pilot does not automatically repeat, repair, purge or reconcile uncertain writes.
- If F03 schema/owner indexes or F01 saved-source ownership cannot be verified, do not bypass the refusal. Report the exact `F04_...`, `F03_...`, `S04_...` or `S06_...` code.
- These are real writes, despite the word pilot. Keep them isolated from important existing vector databases.

## Evidence needed for promotion

Capture anonymized status codes and operation IDs (not API keys or personal chat text), full Qdrant version, Qdrant vector schema, model/dimension/metric, success readbacks before and after restart, two-user and two-branch isolation results, concurrent worker interference, external writer interference, and failure-injection results. A success on the mock HTTP fixture does not replace this real-host testing.
