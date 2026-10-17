# VectHare P0 #8 — Qdrant shared-collection isolation

## What changed

**Both** the VectHare extension and the Similharity server plugin must be updated.
The updated server plugin exposes `GET /api/plugins/similharity/qdrant/tenant-capabilities`.
VectHare checks this contract before enabling shared-collection operations. On an
older plugin, shared-mode operations fail closed rather than overwrite or purge
another logical collection's vectors.

In shared mode, different logical VectHare collections still live inside the
physical Qdrant collection `vecthare_multitenancy`. Each point now uses a stable
UUID generated from `(logical collection ID, chunk hash)`; the original hash is
still stored in the payload. Server-side `content_type` filters scope searches,
listings, lookups, edits, statistics, deletes, and purges. A dimension mismatch
is an error, **not permission to delete an existing collection**.

Qdrant separate-collection mode is unchanged.

## Existing / legacy data

- Prior shared-mode numeric-hash points remain readable when their payload has
  the correct `content_type`. No automatic data migration or deletion occurs.
- Rewriting a chunk already held under a legacy numeric ID may leave both its
  legacy point and the new tenant-scoped point until explicit cleanup. Do not
  purge original collections to resolve duplicates. Legacy hash collisions that
  already overwrote data cannot be reconstructed by this update.
- Existing unverified collection write bindings remain read-only until settings
  compatibility and ownership are explicitly established (P1 work remains).

## Re-vectorize and backup policy

The P0 staged-replacement system is preserved. It builds a **new logical
collection**, changes the chat binding only after successful insertion, and
**retains the old logical collection**. This works in shared-collection mode
because the backup and replacement use different tenant identities in the same
physical Qdrant collection. This release does **not** automatically purge old
collections or implement automatic cleanup suggestions. A future cleanup UI may
list unused backups, but deletion must require explicit confirmation.

## Installation

1. Back up SillyTavern extension settings, the existing VectHare folder, the
   `plugins/similharity` server plugin and your Qdrant data/snapshot.
2. Replace the existing VectHare extension source with the **complete patched
   VectHare** directory from this bundle.
3. Replace the files in the SillyTavern **server-side** `plugins/similharity`
   directory with the patched `VectFox-Similharity-Plugin` source (its folder
   name should still be `similharity`). Do **not** replace dependencies or
   credentials with placeholders; preserve any existing `node_modules` and
   install dependencies if the plugin is not already installed.
4. Restart SillyTavern so the server plugin code reloads; reload VectHare in
   your client. If you use git auto-updates for the plugin, do not let an
   upstream `git pull` silently replace these local patched files.
5. Test two disposable chats with matching text in shared Qdrant mode. Confirm
   that deleting one chat's vectors doesn't affect the other. Then test your
   existing data. Keep the backup until verified.

## Verification (non-live)

- VectHare: `node --experimental-vm-modules tests/p0-safety.mjs`
- Plugin: `node tests/p0-tenant-isolation.mjs`
- JavaScript syntax: `node --check` across changed and remaining `.js` files.
- ZIP integrity checked.

**Limitations:** No live Qdrant/SillyTavern test was available. The bridge and
backend behaviours were tested with isolated mocks; test on a disposable
collection before relying on it for irreplaceable memories. The plugin provides
logical separation between collections within one SillyTavern user; it is not
an authentication boundary between different untrusted users.
