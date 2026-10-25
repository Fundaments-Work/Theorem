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
| A device is lost or retired | Unpairing first tells the other device (`?unpaired` over the book protocol, 4 s at most), which then forgets this one too. It removes the device from the allowlist and revokes any pairing-time permission, then restarts the sync engine, which closes connections already open to it (the gate only checks new ones). The doc shared with it is recorded in `sync-docs-to-drop.json` and deleted as the engine starts, before anything opens it. Each pairing has its own doc, so a removed device never had the docs shared with other devices. A removed device that was offline learns it on its next attempt: it is refused (close code 403), says "The other device has removed this device" and forgets that device (`sync-peer-removed`). The refusal comes over a connection authenticated as that device, so no one else can make a device forget its pairing. |
| The sync key leaks to other local users | `iroh-key` is written `0600` (existing keys are tightened at start), and a key that fails to read is never silently replaced (that would unpair every device). |

Tests: `sync_access.rs` (IDs, paths, symlinks, secrets, allowlist, and two endpoints over loopback proving the gate on the wire), `iroh_sync.rs` `pairing_tests` (the full pairing exchange with the user's answer scripted: accept, decline, wrong/expired secrets, spoofed identity, oversized frames), `database/sync_merge.rs` (planted paths, bad IDs, kv keys).

Sync scenarios (`src-tauri/src/sync_scenarios.rs`) run real iroh nodes, each with its own data folder, over loopback: three devices A–B–C (A and C not paired) with edits, conflicts, deletions while a device is off, expired deletion records, a copy passed on through the middle device, and unpairing; highlights of one book edited on two devices at once, deleted on one and edited on another, deleted while a device is off for months, and taken with their book; a device on an older version (one entry per annotation) paired with this one, and three devices moving to per-book entries one after another; an exchange cut off midway; pairing and sync through a local relay with no direct addresses; and, ignored by default, a 5,000-book / 50,000-highlight library (`cargo test --release --lib scenarios::a_large_library -- --ignored --nocapture`). The app's TypeScript layer (provisioning, merging, deletion records) is modelled there after the rules below; a device can also run as a version before protocol 3.

## Pairing

```
Device A (shows QR)                      Device B (scans)
  generate_pairing_qr()
    opens a pairing session (secret S)
    waits ≤3 s for the relay
    QR v2: nodeId, deviceId, name,
           dialable addrs, relay URL, S
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

Both sides also exchange their sync protocol (`SYNC_PROTOCOL`, 3 in this version). Declining, closing the dialog or waiting 90 s refuses. The approval is asked once per pairing; afterwards the device is recognised by its key on every connection. Only Device Sync shows a QR code, and leaving the page or closing the code withdraws its secret, so a request cannot arrive where the prompt would not be seen. `close_pairing_qr` withdraws the secret when the QR dialog closes. Paired devices are stored in `sync-paired-devices.json` keyed by `device_id`; every change goes through `SyncTransportState::persist_paired`, which also updates the allowlist. A file that cannot be parsed is kept as `sync-paired-devices.json.corrupt` instead of being overwritten.

## Sync lifecycle

### 1. Start (`iroh_start`)

Binds the endpoint (with `PeerGate`), starts the accept loop: blobs store, gossip, docs engine, then the router for blobs, gossip, docs, pairing and book files. For each paired device it opens (or re-imports from the stored ticket) the shared doc, subscribes to its events and starts live sync. Opening a store that is briefly locked by an engine still shutting down is retried before it is treated as corrupt. `iroh_start` only restarts an engine that gave up; one that is merely slow (a phone waking the app) is left alone.

### 2. Provision (`provisionToIrohDocs`)

Writes local state into the docs, one entry per item: `book:{id}` (without file paths), `cover:{id}` (covers too large to inline), `collection:{id}`, `vocab:{id}`, `rss_feed:{id}`, `rss_article:{id}`, `tomb:{entityType}:{entityId}` (deletion records), plus `settings` and `reading_stats`; annotations as one entry per book (below). Only entries that changed since the last provisioning are sent (`_provisionedValues`, short hashes), in batches of 400 (`docs_set_entries`), a book's annotations kept in one batch. Rust skips an entry equal to the one this device already wrote under that key: rewriting it would date it now, as if just edited, which is how a device used to bring back items deleted while it was away.

**Annotations, one entry per book** (sync protocol 3, `src-tauri/src/sync_annotations.rs`). The app still sends `anno:{bookId}:{annotationId}` (`global` for no book); Rust puts each into this device's entry for that book, `annos:{bookId}:`, which holds the book's annotations by ID, as the app wrote them, and a deletion marker (ID and time, ms) for each one this device deleted: `{"annotations":{…},"deleted":{"a2":1761400000000}}`. A book's entry is rewritten only when one of its annotations changed. 50,000 highlights in 5,000 books are 5,000 entries instead of 50,000, and storing entries is what makes a large first exchange slow (see Measured). The key ends in `:` because iroh-docs keys are paths: writing a key removes the same device's older entries under it, so `annos:b1` would wipe `annos:b12` (the book part never contains `:`).

Reading combines **per annotation** every device's book entry and every per-annotation entry (from older versions, or left from before), by the record's own stamps (`updatedAt`, then `createdAt`; a marker's time; for an emptied per-annotation entry, when it was emptied; when it was written only if a record has none). The newer change wins; on a tie a deletion wins. So an annotation missing from one device's entry is not deleted, and edits to different highlights of one book on two devices both survive. The app receives the result as before, `anno:` entries and `deleted` keys, and merges it with its own rules (newer `updatedAt`, `baseUpdatedAt` conflicts in the native merge). A changed book entry delivers only the annotations it holds.

Devices on protocol 2 read only `anno:` entries: to their docs this device also writes those, alongside the book entries. Where both sides read book entries, no `anno:` entry is written any more, and those already in the doc stay: removing them is not safe (an emptied entry reads as a deletion, and a prefix deletion does not hold, see Deletions). They never win wrongly, because this device's book entry always holds its newer change and the merge goes by stamps, not by kind of entry. On start each device copies its own emptied `anno:` entries into its book entries as markers of the same time (`fold_single_deletions`), so those deletions hold even if an empty entry is lost. A new pairing gets a new doc, with book entries only.

Edits between rounds go through the store→docs bridge (`subscribeZustandToIrohDocs`) with the same keys. Entities just received from a peer are not written back.

Older versions read only whole-list entries (`annotations`, `collections`, `vocabulary`, `rss_feeds`, `rss_articles`, `deletion_tombstones`). They are still written while a paired device runs one (protocol below 2, or never reported), and Rust sends them only to that device's doc. Once a device reports protocol 2, this device deletes its own list entries from the doc they share. Versions on protocol 2 ignore the `annos:` entries.

Provisioning also removes this device's doc entries for deleted items and its expired deletion records (`docs_purge_entities`, `docs_retain_own_entries`; see Deletions).

### 3. A sync round (`runDeviceSync`)

1. Provision.
2. `docs_sync_now(peer)` first probes the peer over the book protocol (`probe_peer`): a hello (`?hello {"name","protocol"}`, never a book ID) answered with the peer's own (`HELLO {...}`). An answer means reachable and still paired, and both devices save the other's current name and protocol, so a rename shows on the other device by the next round. Close code 403 means it removed this device (forgotten here too); no answer within 6 s, connecting included, means offline. Only then is the peer queued for reconciliation. The probe exists because iroh-docs checks the connection teardown before the sync result, so a refused sync and a completed one both end with "Failed to close connection"; after the probe, a teardown-only error counts as synced.
3. Wait for **that peer's** `docs-sync-finished` (filtered by its node ID). `synced: false`, or nothing within 30 s, means the peer was not reached: the round returns `success: false` ("Peer offline") and the data stays dirty for the next round. The 30 s count from the last sign that the exchange is still going: entries arriving from that peer (`docs-sync-activity`, the receiving side) or, when the 30 s are up, the peer still answering a probe (the sending side sees no entries); 20 minutes at most. A large library's first exchange takes minutes (see Measured). `lastSyncAt` is recorded only for a finished exchange.
4. Hydrate: `docs_get_changed_entries` returns only keys whose content (the hashes of every device's copy, deletions included) changed since the last read the app acknowledged, and in `deleted` the items whose newest entry is a deletion (see Deletions). Content, not timestamps, so a device with a wrong clock is never skipped. Every device's entry of a key is read, not only the one written last (see Merge). An entry whose content has not arrived is left out and read again next time; the read waits for such content once (150 ms), never per entry, and fetches it from the paired devices (3 s at most): iroh-docs asks for an entry's content only when the entry arrives, so content lost to an exchange cut off midway was otherwise never asked for again. The read is acknowledged (`docs_ack_entries`) only after the merge was persisted; otherwise it comes again. The first read after start, and one every 30 minutes, is full.
5. Merge (below).

Rounds never overlap: a second caller waits for the running round (and shares its result for the same peer). Cancelling is a generation counter, so a cancel with nothing running (unpairing) cannot block the next round or download.

### 4. Merge

With several paired devices, each key's copies are combined in Rust (annotations per annotation, see Provision): records (`book:`, `annotation:`, `collection:`, `cover:`, `rss_article:`, `rss_feed:`, `tomb:`, `vocab:`) take whole the copy with the newest change by the record's own stamps (`metadataUpdatedAt`, `updatedAt`, `lastReadAt`, `deletedAt`, `addedAt`, `createdAt`), by when it was written only when those tie or are missing. When it was written misleads: a device passing on an item it received (the middle one of three) writes its copy at its next provisioning, possibly after another device's newer edit it has not read yet; objects merge field by field with newer copies winning; lists (from older devices) are concatenated for the app to deduplicate. The app folds `tomb:` and `rss_feed:` entries into the lists its merge works on.

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

### Conflicts

Two devices can change the same item before they sync, each without seeing the other's change. The newer change wins, as the rules above say. Before this version that happened silently; now the native merge recognises it and lists it in Settings → Device Sync.

Every edit records the version it was made on: books carry `metadataUpdatedAt` and `metadataBaseAt` (the previous `metadataUpdatedAt`), annotations `updatedAt` and `baseUpdatedAt`. An incoming copy whose stamp differs from the local one is a conflict only when the newer edit's base is older than the other edit, i.e. it was made without seeing it, and only for the fields where the two differ. Edits made one after the other, after a sync, never conflict.

`sync_conflicts` (SQLite) stores each conflict once (the full reads repeat entries): the item, which side's change is in use, and per differing field the value in use and the value replaced. Conflicts are listed for 30 days (`sqlite_list_sync_conflicts`) until dismissed (`sqlite_dismiss_sync_conflicts`; dismissed ones are not listed again). Live books and annotations are persisted through the native merge too, so a conflict is found whichever path merges first. A toast announces new conflicts once per burst and opens Device Sync; a round's summary counts them. In the list, "Use the replaced version" applies those values as a new edit (so it becomes the newest and syncs like any change), and "Keep the one in use" dismisses.

### 5. Deletions

A deletion creates a tombstone (deletion record, `tomb:` entry) that syncs and stops the item being re-inserted, including by the native merge, which skips tombstoned books and annotations even when the same batch still carries their entries. Tombstones expire after 90 days; their `tomb:` entries leave the doc with them.

Deletions also live in the docs themselves, and those never expire. `docs_purge_entities` removes this device's entries for every tombstoned item (a book takes its cover and annotations with it); iroh-docs records each removal as an empty entry, kept and synced like any other. Annotations are not removed but marked: in this device's book entry, the record of a deleted annotation (every annotation, for a deleted book) becomes a deletion marker, read back as `deleted` like an empty entry. Markers never expire either, so the 90-day case below holds for highlights too. They are also sturdier than empty entries: when an entry arrives, iroh-docs 0.101 checks it only against non-empty entries above its key, so after a prefix deletion a device that still held older entries under the prefix put some back (seen in the scenarios); a book entry is never emptied, and an older copy of it never replaces a newer one. Reads include these (`Query::single_latest_per_key().include_empty()`): a key whose newest entry in any doc is a deletion is reported as deleted (in `docs_get_changed_entries`, and live in `docs-entry-batch` after checking that nothing newer was written to the key). The app turns a deletion of an item it still has into a tombstone, unless the item changed here after it was deleted there (added, edited or read later), which keeps it, like an edit made after the deletion anywhere.

So a device that comes back after more than 90 days, when every tombstone has expired, still drops what was deleted meanwhile: its unchanged copies are not rewritten (above), so the deletions stay newest. Provisioning goes further: `docs_set_entries` never writes over a key whose newest entry is a deletion (even one this device never wrote, or changed since). It returns those items in `deleted` instead, and the app deletes them here too, unless the item changed here after the deletion, in which case it writes it again with `force` and it stays everywhere. Live edits (`docs_set_entry`) are always written: they are newer than any deletion. Tested with a real iroh-docs engine in `sync_commands.rs` (`a_device_back_after_months_does_not_bring_back_what_was_deleted`).

### 6. Live updates

Remote doc entries arrive as `docs-entry-batch` events `{ entries, deleted }` (Rust batches them, ~300 ms or 64 entries, newest value per key). An entry is dropped as our own echo only if it equals the value this device last wrote for that key. An `annos:` entry arrives as the combined state, in that doc, of the annotations it holds (`anno:` entries and `deleted` keys). `book:`, `anno:` and `collection:` entries are merged in 200 ms batches; others after 500 ms; deletion records (`tomb:`, the old list, and `deleted`) accumulate and are applied when idle, to the library, words, feeds and articles. Live books and annotations go through the native merge (which also finds conflicts; a direct save is the fallback), and deletions are applied to SQLite as well, so a restart before the next round loses nothing.

### 7. Auto sync

| Trigger | When |
|---|---|
| App start | after 5 s |
| Timer | every 2 min if something changed locally; forced every 10 min |
| Return to the app | forced, 30 s cooldown |
| Peer comes online (`docs-peer-online`) | forced, 30 s cooldown |
| Library edit | 2 s debounce; reading progress at most every 30 s |
| Tray / title bar "Sync now" | immediately, every paired device in turn |

Settings → Device Sync shows each paired device as Online/Offline, and when it last synced. While the page is open each device is probed every 20 s (`sync_probe_device`), and connections idle for 12 s count as gone (QUIC's default is 30 s; iroh sends a keep-alive every 5 s), so a device that vanished shows as offline within about 12 s.

## Device names

A device is named after the system: the computer name on desktop (the pretty hostname on Linux, `ComputerName` on macOS, `COMPUTERNAME` on Windows), maker and model on Android (`ro.product.manufacturer`, `ro.product.model`). The user can rename it in Device Sync (`set_device_name`, saved in `sync-device-name.txt`; empty goes back to the system name). Names are cleaned (control characters, spaces, 64 characters) and travel in the pairing messages and in every hello, so the other device's list follows a rename (`paired-devices-changed`).

## Book files

Books travel over `theorem-file/v1`, on demand, not with metadata.

- **Serving** (`FileTransferHandler`): only for allowed peers; one request line (≤512 bytes, 15 s) with a book ID; looks in `book-cache/{id}.book`, `book-cache/{id}`, `book-cache/{id}.*`, then the SQLite blob, then the paths the local library records. Every path passes `servable_book_path`. Replies `OK {size}\n{bytes}` or `ERR {msg}\n` (`PEER_BOOK_DELETED` for a tombstoned book).
- **Requesting** (`download_book_file(peerDeviceId, bookId)`, returns the saved path): validates the ID, streams 1 MB chunks to `book-cache/{id}.book.download.tmp` and renames it, emitting `download-progress` `{ book_id, progress, downloaded, total }`. Connect and stream-open time out after 15 s, reads after 120 s. `downloadBookOnDemand` tries the last peer first, then every paired device, and always clears its spinner.

## Commands

`iroh_start`, `iroh_stop`, `generate_pairing_qr`, `close_pairing_qr`, `submit_pairing_code`, `respond_pairing_request`, `get_device_identity`, `set_device_fingerprint`, `set_device_name`, `get_paired_devices` (without the doc's write ticket), `unpair_device`, `sync_probe_device`, `docs_create_sync_doc`, `docs_import_sync_doc`, `docs_set_entry`, `docs_set_entries`, `docs_retain_own_entries`, `docs_get_all_entries`, `docs_get_changed_entries`, `docs_ack_entries`, `docs_purge_entities`, `docs_sync_now`, `clear_sync_databases` (`sync_commands.rs`), `download_book_file` (`file_transfer.rs`), `sqlite_list_sync_conflicts`, `sqlite_dismiss_sync_conflicts` (`offload_commands.rs`).

Events: `pairing-progress`, `pairing-confirm-request`, `pairing-confirm-closed`, `pairing-completed`, `docs-entry-batch` `{ entries, deleted }`, `docs-pending-content-ready`, `docs-sync-finished` `{ peer, synced, received, sent }`, `docs-sync-activity` `{ peer }` (entries arriving from that peer, at most every 2 s), `docs-peer-online` / `docs-peer-offline` `{ peer }`, `sync-peer-presence` `{ peer, online }`, `sync-peer-removed` `{ deviceId, deviceName }`, `paired-devices-changed`, `doc-reimported`, `sync-doc-missing`, `download-progress`. In the app: `theorem:sync-conflicts` (a window event) when a merge found conflicts.

## Measured

Desktop (Linux, debug build) with the Android 15 emulator behind its NAT, 2026-10-22 (device names: the desktop's hostname, "Google sdk_gphone64_x86_64" for the emulator):

| What | Result |
|---|---|
| Pairing, from Accept to paired on both sides | 0.2–0.4 s |
| Wrong secret / old code / used code / closed QR / 5 wrong guesses | refused before the user is asked |
| Sync round, nothing changed | 50–110 ms (changed-only reads) |
| Sync round with changes | 130–250 ms |
| Change made while the phone was off, after a cold start of the app | 14.7 s (≈6 s app start + 5 s startup delay) |
| Book download, 27 KB / 40 MB | 29 ms / 4.5 s (8.9 MB/s), checksums equal |
| Round with the peer offline | "Peer offline" after 6.1 s (was 30 s), data kept dirty |
| Settings label after the phone app was killed | Offline after 7 s during a round, 14.8 s without one (was 30 s); Online 6.8 s after the app starts |
| Round after the other device unpaired this one | "removed this device" in 0.4 s |
| Unpairing with both online | 1.7 s; the other device drops this one at once and says so |
| Unpairing a device that is off | 6.1 s (3 s notice + engine restart); it forgets this device 14.9 s after it next starts |
| Rename | reaches the other device in the next round (0.6 s) |
| Annotation added / deleted on the desktop, live | on the phone after 2.2 s / gone after 3.5 s |
| Book deleted while the phone was off, deletion record then expired (the 90-day case) | dropped by the phone 10.3 s after it started, not sent back |
| Favourite on the phone in airplane mode, tag on the desktop 5 s later | one conflict on each side (phone: "your change was replaced"); "Use the replaced version" on the phone reached the desktop live, no new conflict |
| First round after pairing (3 books) | 113 ms; doc holds only per-item entries |

Large library, 2026-10-25 (`a_large_library`, release build, two devices in one process on loopback; 5,000 books with descriptions and cover references, 50,000 highlights, 17 MiB). Before: one entry per highlight (protocol 2, 55,000 entries); after: one per book (protocol 3, 10,000 entries), same machine and day:

| What | One per highlight | One per book |
|---|---|---|
| First provisioning (all written, batches of 400) | 37.5 s | 10.2 s |
| Provisioning again with nothing changed (every app start) | 2.3 s | 0.8 s |
| First exchange, until the other device holds everything | 340 s; its docs engine answers nothing else meanwhile (iroh-docs storing the entries, not the content downloads: the same without them) | 62 s |
| Round with nothing changed: exchange / read | 0.08 s / 0.12 s | 0.02 s / 0.02 s |
| Full read of every item (first after start, then every 30 min) | 3.3 s | 0.7 s |
| One edit: exchange / read on the other device | 0.11 s / 0.12 s | 0.02 s / 0.02 s |
| Purge after a deleted book / a deleted highlight (every group of this device read) | 0.00 s / – | 0.00 s / 0.42 s |
| Data folder per device | 88–96 MiB | 36–40 MiB |
| Peak memory, both devices together | 436 MiB | 254 MiB |

Through a local relay with no direct addresses (`devices_sync_through_a_relay_alone`, `pairing_works_through_a_relay_alone`): pairing 1.0 s, exchanges 2.3–2.8 s; both inside the 6 s probe. A relay over the internet adds its round trips; that needs a real network test: two devices on different networks (say a phone on mobile data and a desktop on Wi-Fi, mDNS off with `THEOREM_DISABLE_MDNS=1`), then pairing, a round, and Settings → Device Sync's Online label.
| Unpaired stranger fetching `../theorem.db`, `../iroh-key`, the docs protocol | refused at the handshake, never reaches a handler |
