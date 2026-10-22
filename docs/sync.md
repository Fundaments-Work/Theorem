# P2P Device Sync

Theorem syncs books, annotations, settings, vocabulary and RSS data directly between your own devices, with no server. This document describes how it works and what protects it.

## Why iroh

- **iroh** gives every device a long-lived Ed25519 identity (its *node ID*) and QUIC connections that prove it: a connection can only come from the device holding that node's private key. Addresses (LAN, relay) are only hints for reaching a node; they never establish identity.
- **iroh-docs** is the CRDT document store: both sides write concurrently and converge.
- **iroh-gossip** spreads live changes and presence (`NeighborUp` / `NeighborDown`) between paired devices.
- **iroh-blobs** carries doc entry content. Book files use our own protocol (`theorem-file/v1`), downloaded on demand.
- **iroh-mdns-address-lookup** finds paired devices on the same LAN.

Sync is always compiled in (no feature gate).

## Security model

The design follows KDE Connect and Syncthing (identity = public key, explicit approval, pinning) rather than LocalSend, whose address-based device trust allowed impersonation (CVE-2025-54792).

| Threat | Protection |
|---|---|
| A stranger on the same network connects | Every connection, incoming **and outgoing**, on every protocol (docs, blobs, gossip, book files) is closed right after the handshake unless the other node is paired: an iroh endpoint hook, `PeerGate` (`src-tauri/src/sync_access.rs`). The pairing protocol is the only exception, and it demands a secret. |
| Someone pairs without permission | Pairing needs the one-time secret in the QR code (256 bits, valid 10 minutes, single use, burned after 5 wrong guesses, replaced by a new QR code, withdrawn when the QR dialog closes). The device showing the QR code then asks the user to **approve**; both screens show the same 6-digit code, derived from both node IDs and the secret, so a photographed QR code or a device in the middle shows different digits. |
| A device lies about who it is | The paired identity is the connection's verified node ID, never a field of the request. |
| Memory exhaustion by a pairing message | Messages are capped at 64 KiB (checked before allocating) and time out. |
| A peer asks for a file that is not a book | A request names a book ID (`[A-Za-z0-9._-]`, no `..`, ≤128 chars), never a path. Only files in `book-cache/`, or outside the app's data folder with a book extension, are served, after resolving symlinks. The database, the sync key and settings are never sent. |
| A paired device plants data | Incoming books lose device-local fields (`filePath`, `storagePath`, `syncedWithoutFile`; a cover only as an inline `data:image/`); book IDs that are not plain IDs are skipped; only the synced keys (`settings`, `reading_stats`, `collections`, `rss_feeds`, `collection:*`, `cover:*`) reach `kv_store`; downloads go to `book-cache/{id}.book`, a path Rust derives itself, capped at 4 GiB. |
| A device is lost or retired | Unpairing removes it from the allowlist at once (it can no longer connect, and we no longer send to it) and deletes the doc shared with it. Each pairing has its own doc, so a removed device never had the docs shared with other devices. |
| The sync key leaks to other local users | `iroh-key` is written `0600` (existing keys are tightened at start), and a key that fails to read is never silently replaced (that would unpair every device). |

Tests: `sync_access.rs` (IDs, paths, symlinks, secrets, allowlist, and two endpoints over loopback proving the gate on the wire), `iroh_sync.rs` `pairing_tests` (the full pairing exchange with the user's answer scripted: accept, decline, wrong/expired secrets, spoofed identity, oversized frames), `database.rs` (planted paths, bad IDs, kv keys).

## Pairing

```
Device A (shows QR)                      Device B (scans)
  generate_pairing_qr()
    opens a pairing session (secret S)
    QR v2: nodeId, deviceId, name,
           LAN addrs, relay URL, S
                       ── scan / paste ──►  submit_pairing_code()
                                              rejects QR v1 ("update Theorem")
                                              lets A connect back for 2 min
                       ◄── theorem-sync/v1 ── connect to A's node ID (TLS proves it)
                                              pairing-progress {step:"confirm", code}
  redeem S (single use)                       shows the 6-digit code
  pairing-confirm-request
    {requestId, deviceName, code}
  user taps Accept ──► respond_pairing_request(requestId, true)
  saves B (node ID from the connection),
  creates the shared doc, returns a
  write ticket  ──────────────────────────►  saves A, imports the doc
```

Declining, closing the dialog or waiting 90 s refuses. `close_pairing_qr` withdraws the secret when the QR dialog closes. Paired devices are stored in `sync-paired-devices.json` keyed by `device_id`; every change goes through `SyncTransportState::persist_paired`, which also updates the allowlist. A file that cannot be parsed is kept as `sync-paired-devices.json.corrupt` instead of being overwritten.

## Sync lifecycle

### 1. Start (`iroh_start`)

Binds the endpoint (with `PeerGate`), starts the accept loop: blobs store, gossip, docs engine, then the router for blobs, gossip, docs, pairing and book files. For each paired device it opens (or re-imports from the stored ticket) the shared doc, subscribes to its events and starts live sync. Opening a store that is briefly locked by an engine still shutting down is retried before it is treated as corrupt. `iroh_start` only restarts an engine that gave up; one that is merely slow (a phone waking the app) is left alone.

### 2. Provision (`provisionToIrohDocs`)

Writes local state into the docs: `book:{id}` (without file paths), `cover:{id}` (covers too large to inline), `settings`, `reading_stats`, `collections`, `vocabulary`, `rss_feeds`, `rss_articles`, `deletion_tombstones`. Per-item edits between rounds go through the store→docs bridge (`subscribeZustandToIrohDocs`): `book:`, `anno:{bookId}:{annotationId}`, `collection:`, `rss_article:`. What was written is remembered (`_provisionedValues`), so unchanged values are not written again, and entities just received from a peer are not written back. Provisioning also removes this device's doc entries for deleted items (`docs_purge_entities`, see Deletions).

### 3. A sync round (`runDeviceSync`)

1. Provision.
2. `docs_sync_now(peer)` queues the peer for reconciliation.
3. Wait for **that peer's** `docs-sync-finished` (filtered by its node ID). `synced: false`, or nothing within 30 s, means the peer was not reached: the round returns `success: false` ("Peer offline") and the data stays dirty for the next round. `lastSyncAt` is recorded only for a finished exchange.
4. Hydrate: `docs_get_changed_entries` returns only keys whose content (the hashes of every device's copy) changed since the last read the app acknowledged. Content, not timestamps, so a device with a wrong clock is never skipped. The read is acknowledged (`docs_ack_entries`) only after the merge was persisted; otherwise it comes again. The first read after start, and one every 30 minutes, is full.
5. Merge (below).

Rounds never overlap: a second caller waits for the running round (and shares its result for the same peer). Cancelling is a generation counter, so a cancel with nothing running (unpairing) cannot block the next round or download.

### 4. Merge

With several paired devices, each key's copies are combined in Rust: records (`book:`, `anno:`, `annotation:`, `collection:`, `cover:`, `rss_article:`, `vocab:`) take the newest copy whole; objects merge field by field with newer copies winning; lists are concatenated for the app to deduplicate.

`sqlite_merge_sync_entries` then writes SQLite **in one transaction**, and `mergeIncomingData` updates the stores. All merges (rounds, live batches, progressive flushes, tombstones) run one at a time, and library changes are applied per ID onto the current store, so an edit made while a merge awaits survives it.

| Domain | Rule |
|---|---|
| Book details (title, author, description, publisher, language, ISBN, date, category, favourite, tags, rating, completion, series) | Edits are stamped (`metadataUpdatedAt`, set by the library actions when one of these changes). The newer stamp wins them as a unit, removals included. Without stamps on either side (older versions): union of tags, favourite if either, highest rating. |
| Reading position (progress, location) | The newer `lastReadAt` wins both together; on a tie, the higher progress with its own location. |
| Annotations | Newer `updatedAt` wins (also in SQLite). |
| Collections | Union of book IDs; newer name/description wins. |
| Vocabulary | By normalized term + language; newer `updatedAt` wins in SQLite, earliest creation date kept. |
| Settings | Newer `_settingsUpdatedAt` wins, on every path (rounds and live). Local `deviceSync` config is kept. |
| Reading stats | Max of each stat, union of daily activity, streaks recomputed. |
| RSS feeds / articles | By URL / ID. Read and favourite are kept if either side has them; furthest progress. |
| Deletion tombstones | Union, pruned after 90 days. |

Unchanged books are not rewritten in SQLite.

### 5. Deletions

A deletion creates a tombstone that syncs and stops the item being re-inserted, including by the native merge, which skips tombstoned books and annotations even when the same batch still carries their entries. Doc entries outlive a deletion, though, and tombstones expire after 90 days, so `docs_purge_entities` removes this device's entries for every tombstoned item (a book takes its cover and annotations with it). A doc deletion only covers its own author, so each device removes its own copies as the tombstones reach it. A device offline for longer than 90 days can still bring back items deleted meanwhile.

### 6. Live updates

Remote doc entries arrive as `docs-entry-batch` events (Rust batches them, ~300 ms or 64 entries, newest value per key). An entry is dropped as our own echo only if it equals the value this device last wrote for that key. `book:`, `anno:` and `collection:` entries are merged in 200 ms batches; others after 500 ms; tombstones when idle.

### 7. Auto sync

| Trigger | When |
|---|---|
| App start | after 5 s |
| Timer | every 2 min if something changed locally; forced every 10 min |
| Return to the app | forced, 30 s cooldown |
| Peer comes online (`docs-peer-online`) | forced, 30 s cooldown |
| Library edit | 2 s debounce; reading progress at most every 30 s |
| Tray / title bar "Sync now" | immediately, every paired device in turn |

Settings → Device Sync shows each paired device as Online/Offline from the gossip neighbour events, and when it last synced.

## Book files

Books travel over `theorem-file/v1`, on demand, not with metadata.

- **Serving** (`FileTransferHandler`): only for allowed peers; one request line (≤512 bytes, 15 s) with a book ID; looks in `book-cache/{id}.book`, `book-cache/{id}`, `book-cache/{id}.*`, then the SQLite blob, then the paths the local library records. Every path passes `servable_book_path`. Replies `OK {size}\n{bytes}` or `ERR {msg}\n` (`PEER_BOOK_DELETED` for a tombstoned book).
- **Requesting** (`download_book_file(peerDeviceId, bookId)`, returns the saved path): validates the ID, streams 1 MB chunks to `book-cache/{id}.book.download.tmp` and renames it, emitting `download-progress` `{ book_id, progress, downloaded, total }`. Connect and stream-open time out after 15 s, reads after 120 s. `downloadBookOnDemand` tries the last peer first, then every paired device, and always clears its spinner.

## Commands

`iroh_start`, `iroh_stop`, `generate_pairing_qr`, `close_pairing_qr`, `submit_pairing_code`, `respond_pairing_request`, `get_device_identity`, `set_device_fingerprint`, `get_paired_devices`, `unpair_device`, `docs_create_sync_doc`, `docs_import_sync_doc`, `docs_set_entry`, `docs_get_all_entries`, `docs_get_changed_entries`, `docs_ack_entries`, `docs_purge_entities`, `docs_sync_now`, `clear_sync_databases` (`sync_commands.rs`), plus `download_book_file` (`file_transfer.rs`).

Events: `pairing-progress`, `pairing-confirm-request`, `pairing-confirm-closed`, `pairing-completed`, `docs-entry-batch`, `docs-pending-content-ready`, `docs-sync-finished` `{ peer, synced, received, sent }`, `docs-peer-online` / `docs-peer-offline` `{ peer }`, `doc-reimported`, `sync-doc-missing`, `download-progress`.
