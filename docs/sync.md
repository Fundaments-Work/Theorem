# P2P Device Sync

## Why iroh

Theorem syncs books, annotations, settings, vocabulary, and RSS data between devices with no server. The iroh stack enables this:

- **iroh-docs** provides CRDT-based document sync — both sides can write concurrently, and the documents converge to the same state. This is essential for a local-first app where both devices may modify the same book's metadata while offline.
- **iroh-gossip** propagates presence and sync events between connected peers. Each paired device's doc joins a gossip mesh — when one peer syncs, data propagates to all mesh members automatically.
- **iroh-blobs** is used internally by iroh-docs for CRDT entry content. (Book files use a separate custom QUIC protocol, not iroh-blobs.)
- **iroh-mdns-address-lookup** discovers peers on the same LAN without configuration.

Sync is always compiled (no feature gate). It's a core product feature.

## Pairing Protocol

```
Device A                          Device B
  │                                  │
  │  getDeviceIdentity()             │
  │  (returns deviceId +             │
  │   publicKey + fingerprint)       │
  │                                  │
  │  generate_pairing_qr()           │
  │  (QR encodes device identity     │
  │   + relay URL + pairing ticket)  │
  │                                  │
  │  ┌──── QR code ────────────┐     │
  │  │                         │     │
  │  │ ←─── scan / submit ─────│────►│ submit_pairing_code()
  │  │                         │     │  (decodes QR + calls
  │  └─────────────────────────┘     │   iroh_pair to register)
  │                                  │
  │  docs_import_sync_doc(ticket)    │
  │  (imports the shared CRDT doc    │
  │   created by Device A)           │
  │                                  │
  │◄───── Connected ────────────────►│
```

Once paired, devices are stored in `sync-paired-devices.json` as a `HashMap<String, PairedDevice>` keyed by `device_id`. Deduplication by `iroh_node_id` prevents duplicates from re-pairing after data reset. Re-pairing is needed only if both devices clear their sync databases.

## Sync Lifecycle

### 1. Start (`iroh_start`)

Called from `ensureResponderSyncReady()` in App.tsx. Initializes:
- iroh `Endpoint` (QUIC-based P2P transport) — registers ALPNs for docs, gossip, blobs, and custom pairing/file-transfer
- iroh-docs `DocsEngine` for CRDT documents
- iroh-blobs `FsStore` for CRDT content storage
- iroh-gossip swarm for event propagation
- mDNS discovery for LAN peers

Stored in a global `SyncTransportState` managed by Tauri.

### 2. Accept Loop

`start_accept_loop()` starts a long-lived tokio task that:
- Creates the gossip overlay via `iroh_gossip::Gossip::builder().spawn()`
- Spawns iroh-docs with gossip integration: `Docs::persistent(path).spawn(endpoint, blobs, gossip)`
- For each paired device's sync doc: opens/imports the doc, calls `subscribe_doc_events()` to listen for live changes, and calls `doc.start_sync(vec![peer_addr])` to establish the gossip mesh
- Sets up the router to accept connections for blobs, gossip, docs, pairing, and file-transfer

The accept loop runs for the entire app lifecycle. If a doc event stream dies, it re-subscribes (up to 10 retries, capped at 3 subscribe failures).

### 3. Provision

`provisionToIrohDocs()` serializes all store state into the iroh-docs document as individual key-value entries:
- `book:{bookId}` — per-book metadata (stripped of file paths and data: cover URLs)
- `annotations` — full annotations array
- `collections` — full collections array
- `deletion_tombstones` — sync-aware deletion markers
- `vocabulary` — vocabulary terms
- `settings` — full settings + `_settingsUpdatedAt` timestamp
- `reading_stats` — reading statistics
- `rss_feeds` / `rss_articles` — RSS data

### 4. Sync

`docs_sync_now(peerDeviceId)` triggers CRDT reconciliation with a single peer. The Rust backend:
1. Opens the shared sync doc (re-importing from ticket if doc was lost)
2. Calls `doc.start_sync(vec![peer_addr])` with a 15-second timeout
3. During sync, `subscribe_doc_events` streams live `InsertRemote`/`ContentReady` events to the JS side via `docs-entry-changed` Tauri events
4. Fires `docs-sync-finished` on completion, `docs-pending-content-ready` when content is staged
5. `NeighborUp` gossip events propagate to all mesh members — triggering `docs-peer-online` which auto-syncs

The `runDeviceSync()` JS function orchestrates a complete sync round:
1. `ensureResponderSyncReady()` — starts iroh and provisions
2. `provisionToIrohDocs()` — writes local state to the shared doc
3. Listens for `docs-pending-content-ready` and `docs-sync-finished` events (settles when BOTH fire or 30s timeout)
4. Calls `docsSyncNow(peerDeviceId)` — triggers the Rust-side sync
5. `hydrateFromIrohDocs()` — reads all entries from all paired docs via `docsGetAllEntries()`
6. `mergeIncomingData()` — merges all incoming entries into local Zustand stores

### 5. Merge

`mergeIncomingData()` on the JS side processes all incoming entries:

| Domain | Strategy |
|--------|----------|
| Books | By contentHash/blobHash dedup. Newer `lastReadAt` wins progress. Union of tags, favorites, ratings. |
| Annotations | Newer `updatedAt` wins. Filtered by tombstones. |
| Collections | Union of bookIds. Newer name/description wins. |
| Vocabulary | Merged by normalized term+language. Deduped meanings. |
| Settings | Newer `_settingsUpdatedAt` timestamp wins. Preserves local `deviceSync` config. |
| Reading stats | Max of each stat. Union of daily activity. Streaks recomputed. |
| RSS feeds | By URL. Merged metadata. |
| RSS articles | By ID. Union of read/favorite status. |
| Deletion tombstones | Union of all tombstones with older-than-90-day pruning. |

### 6. Live Listener

After sync completes, `initDocsLiveListener()` subscribes to `docs-entry-changed` Tauri events. Remote changes made after the initial sync are streamed incrementally:
- `book:` keys are batched (200ms debounce, progressive flush)
- `annotation:` / `collection:` keys merge immediately
- Other keys buffer (500ms debounce, max 2000 pending entries)

### 7. Auto Sync

`startAutoSync()` manages recurring sync:

| Trigger | Delay/Interval |
|---------|----------------|
| App startup | 5 seconds |
| Periodic | Every 2 minutes |
| Visibility change | 30s cooldown |
| Peer comes online (`NeighborUp` → `docs-peer-online`) | 30s cooldown |
| Tray "Sync Now" | Immediate |
| Store mutation | 2 second debounce |

## File Transfer

Books are transferred using a custom QUIC stream protocol with ALPN `theorem-file/v1`, NOT iroh-blobs. This was changed from iroh-blobs to avoid transferring 20GB+ of book data during metadata sync — books are downloaded on-demand when the user opens them.

### Serving (`FileTransferHandler`)

The `FileTransferHandler` struct (in `file_transfer.rs`) implements `iroh::protocol::ProtocolHandler`. When a peer requests a file:
1. Receives the book ID as a text line
2. Tries to read from `book-cache/{bookId}.book` (fastest path)
3. Falls back to reading from SQLite `books` table if not in `book-cache` (locally-imported books)
4. Responds with `OK {size}\n{data}` or `ERR {msg}\n`

Cover images travel as `data:` URLs inside the synced book metadata (downsampled to ≤200×300 webp), not through the file-transfer protocol.

### Requesting (`download_book_file`)

On the requesting device:
1. `downloadBookOnDemand(bookId)` iterates all paired peers
2. Calls Rust command `download_book_file(peerId, bookId, destPath)`
3. Rust connects to peer via iroh QUIC transport, sends book ID
4. Reads response in 1MB chunks and writes directly to `book-cache/{bookId}.book` (no data passes through IPC — avoids OOM on Android)
5. Emits `download-progress` Tauri events as percentage changes (throttled to ~100 events max)
6. On success: marks `syncedWithoutFile: false`, updates `filePath`/`storagePath`

The `request_book_file` command (returns data through IPC) exists but has no callers; all real downloads use `download_book_file`.

### Progress UI

The Reader component listens for `download-progress` events:
```
{ book_id: string, progress: f64 (0–100), downloaded: usize, total: usize }
```
Shows a real progress bar with file size (e.g., "12.5 MB / 45.3 MB (28%)") instead of an indeterminate spinner. The "Connecting to peer..." message is shown until the first progress event arrives.

### Timeouts

All I/O operations in the file transfer path use a 120-second timeout:
- `connect` — QUIC connection establishment
- `open_bi` — bidirectional stream open
- `read_line` / `read_exact` — reading status line and data chunks

The Reader has an additional 120-second timeout on the polling loop. If exceeded, the user sees a "Book download timed out" message with a "Try Again" button.

## Conflict Resolution

Conflicts are detected during merge and surfaced to the user:
- **Book progress**: If both sides read the same book to different positions, the remote wins if its progress was recorded more recently
- **Annotations**: If both sides edit the same annotation, the newer `updatedAt` wins
- **Settings**: Remote wins if its `_settingsUpdatedAt` is newer. Local `deviceSync` configuration is preserved (it's device-specific)

Conflicts are rendered in the sync UI as a list with "local won" / "remote won" labels.
