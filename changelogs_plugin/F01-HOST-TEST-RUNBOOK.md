# F01 Disposable SillyTavern Host Test

Use **only a backed-up disposable SillyTavern installation and disposable chat data**. Install **both** matched F01 packages; F01 changes the executable-source fingerprint and must match the extension's compatibility pin. Ordinary database setup is still performed in the VectHare GUI.

1. Install `VectHare-Similharity-F01-Host-Source-Ownership.zip` as the Similharity server plugin, installing dependencies as needed. Install `VectHare-F01-Source-Attestation-Extension.zip` as the third-party VectHare extension. Restart the host and reload the browser.
2. Confirm S10/F01 build discovery is compatible. In VectHare settings, use **Verify current chat/branch ownership** for an existing **saved** chat. Expect a successful owned-source verification; writes remain disabled.
3. Create a branch/checkpoint in SillyTavern, save it, then verify it. It must not share the parent's opaque F01 source ID even when its `chat_metadata.integrity` is copied. The extension currently only shows the verification status, not source identifiers; compare sanitized server observations/logs if needed without exposing chat text. No vector record should be inserted.
4. Verify a lorebook through the GUI's **Verify lorebook ownership** field. Try a nonexistent name; it should be refused.
5. Test a group chat if one exists. The group file must list the chat. A chat not listed in the selected group must be refused.
6. Switch chats, reload and restart SillyTavern. Re-attest the same sources. The source-mapping file is persistent, and the IDs should remain stable. Do not delete or overwrite `.similharity/f01-host-sources.json` or its initialized marker.
7. Verify that Vector Insert, Delete, Reindex, and shared-backend legacy list/query are still denied. This is expected in F01.
8. If something fails, collect the HTTP status and `F01_*` error code, SillyTavern version, host OS, and sanitized folder layout. Do **not** send private chat text, credentials, or full user file paths.

**Expected limitation:** An unsaved chat cannot yet be attested, and browser active-chat identity remains a client-side observation. F01 does not automatically activate memory management; F02 must connect these source bindings to authorized public record reads.
