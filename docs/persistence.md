# Persistence

## Why Two Storage Layers

Zustand's `persist` middleware is great for small structured state (UI preferences, book metadata). It automatically serializes/deserializes on app open/close, handles migrations, and integrates with React's reactivity.

But it's terrible for large binary data. Serializing a 100MB book file into JSON every time state changes would be catastrophic. And foliate-js position snapshots (the `locations` field) can reach 50-100MB across opened books.

So: **Zustand for structured metadata, SQLite for blobs.**

## SQLite Schema

File: `~/.local/share/work.fundamentals.theorem/theorem.db`

### Table: `books`
Book registration stub. The `data` BLOB is written empty (`X''`); the actual book file lives only in `book-cache/{id}.book`. Legacy full BLOBs are reclaimed on startup.

### Table: `covers`
Cover images stored as `data_url` (base64 data URI). The legacy `data` BLOB column is cleared on startup and is not read.

### Table: `kv_store`
String key-value store. Used by:
- **Zustand persist adapter** (`persist-storage.ts`) — serializes all 6 persisted stores as JSON blobs
- **StarDict/MDict manifests** — stores dictionary metadata (`theorem-stardict:{id}:manifest`)
- **Sync provisioning flag** — tracks whether the device has been provisioned to iroh-docs

### Table: `blob_store`
Binary key-value store. Used by:
- **Book locations** — foliate-js position snapshots (`locations:{bookId}`)

> Dictionary binaries used to live here under `theorem-stardict:{id}:*`; they are now read from disk and the legacy BLOBs are reclaimed on startup.

### Table: `materialized_books`
Tracks which books have been materialized to the `book-cache/` directory. The `source_updated_at` column allows invalidation when the source book data changes.

### Table: `book_metadata`
Per-book JSON metadata snapshot. Written with the full serialized `Book` on metadata edits and sync; read by the Rust CLI.

### Table: `book_annotations`
Per-book annotation records. Each row is one annotation. The `annotation_json` column stores the full annotation object. Indexed by `book_id` for fast per-book queries.

### Table: `books_fts`
FTS5 virtual table for full-text search across book titles and authors. Updated on import and re-indexed on batch operations.

## Connection Management

A single r2d2 connection pool (max 4 connections on desktop, 2 on Android) manages all SQLite access:

**PRAGMAs applied on every connection acquisition:**
- `busy_timeout = 5000` — Wait up to 5 seconds for locked tables
- `cache_size = -8000` — 8MB page cache
- `mmap_size = 268435456` — 256MB memory-mapped I/O
- `temp_store = MEMORY` — Temp tables in memory
- `journal_size_limit = 67108864` — WAL file capped at 64MB

**Schema-level PRAGMAs (set once at migration):**
- `journal_mode = WAL` — Write-Ahead Logging for concurrent read/write
- `synchronous = NORMAL` — Durability with WAL, good balance
- `foreign_keys = ON`

All connections go through `with_connection(app, |conn| operation(conn))` which acquires a connection from the pool and handles errors. No raw `Connection::open()` calls in hot paths.

## Backups, Snapshots and Startup Safety

`src-tauri/src/db_backup.rs` owns everything that copies the database. It opens connections of its own only where SQLite's online backup API needs them (a destination it can write, a snapshot file); reading the live database for a backup still goes through `with_connection`.

### Startup guard

`lib.rs` setup calls `db_backup::run_startup_guard` instead of calling `run_schema_migrations` directly:

1. If a check is due — the app version changed since the last check (the only time migrations have work to do), the last check is 24 h old, or the clock moved backwards — run `PRAGMA quick_check`.
2. If it passes, copy the database with the backup API to `db-snapshots/theorem-<unix-seconds>-v<version>.db` (a single file in rollback-journal mode) and keep only the two newest. A damaged database never replaces a good snapshot.
3. Run migrations. A damaged database is not migrated (no VACUUM on a broken file).
4. The outcome is kept as the database health: `ok`, `corrupt` or `migration_failed`, with the message and the snapshots on offer. `db-health.json` records when the last check passed and for which version.

`main.tsx` asks `db_health_status` before rendering. When the database needs attention it renders the recovery screen instead of the app, and store writes are suspended so nothing is written over the damaged file. The screen offers each snapshot, a backup file, or "continue anyway" (`db_health_dismiss`, then a reload).

**Why not every start.** `quick_check` reads every page, so its cost grows with the database. Measured on a synthetic library (covers, metadata, annotations, RSS bodies, FTS) with a warm page cache: 56 MB took 24 ms to check and 72 ms to snapshot; 566 MB took 210 ms and 635 ms. A cold cache or a phone's flash is slower. Once a day plus every update keeps the cost off almost every start while still checking before each migration. Detecting an unclean shutdown was rejected as the trigger: Android ends the process without a clean exit almost every time, so it would mean checking on every start there. A database that breaks between checks still surfaces: SQLite errors from migrations that mention corruption are reported as `corrupt`.

Disk cost: two snapshots, each about the size of the database (covers are stored in it).

### Backup archive (`.theorem-backup`)

A zip written entry by entry to `<target>.partial`, then renamed. Nothing larger than a copy buffer is held in memory.

| Entry | Content |
|-------|---------|
| `manifest.json` (first) | `format`, `formatVersion`, `appVersion`, `createdAt`, `platform`, `schema` (tables, `user_version`), `counts` (books, annotations, vocabulary, feeds, articles, sessions, book/audiobook/dictionary files, missing book files), `includesDictionaries`, `totalBytes` |
| `theorem.db` | Backup-API snapshot with the device identity stripped, then `VACUUM`ed (deflated) |
| `book-cache/<id>.book` | One per book in `book_metadata`/`books` whose file is on this device (stored, not recompressed) |
| `audiobooks/...` | Generated companion audiobooks |
| `dictionaries/...` | Only when the user asks for them |

**Never included**: `iroh-key`, `sync-identity.json`, `sync-paired-devices.json`, `iroh-docs/`, `iroh-blobs/`, models, caches. Inside the database, the settings' `deviceSync` (device id, name, paired devices and their sync doc tickets) is emptied, OPDS catalogs lose their `auth`, and `theorem_sync_provisioned` is deleted. The snapshot is `VACUUM`ed afterwards because free pages copied from the live file can still hold older copies of those values.

Attached audiobooks that live outside the app folder (`audioTrack` pointing at the user's own files) are not copied.

### Restore

1. Validate the manifest (format, format version, not made by a newer Theorem).
2. Extract `theorem.db` to `restore-staging/`, run `quick_check`, require the Theorem tables, and compare book and annotation counts with the manifest.
3. Extract files whose names map to `book-cache/<safe-name>.book`, `audiobooks/...` or `dictionaries/...` (anything else, `..` components, absolute paths and drive letters are skipped). The book file count must match the manifest.
4. Move the files into place (same names are replaced; other files stay, since the previous database refers to them).
5. Keep the current database as `theorem.db.pre-restore` (backup API, or a raw copy when it is too damaged to read).
6. Copy this device's own `deviceSync` and catalog credentials into the incoming database, and drop its provisioned flag so the restored library is pushed to the sync document again.
7. Copy the staged database into the live file with the backup API. Pool connections stay valid and see the new data, so no process restart is needed (Tauri cannot restart on Android). Only when the pool has not opened the file yet may an unreadable live file be replaced on disk instead.
8. Run migrations (an older backup) and reload the webview.

Before restoring, the frontend flushes pending store writes, then suspends persistence and clears `theorem-unload:` snapshots so nothing from the old library is written over the restored one.

## Zustand Store Persistence

Each store defines:
- `version` — Bump on schema change, triggers `migrate` callback
- `partialize` — Strips non-serializable or redundant fields (e.g., `locations`, file paths, `data:` cover URLs, computed caches)
- `migrate` — Version migration functions (e.g., `0to1`, `1to2`)
- `onRehydrateStorage` — Post-rehydration behavior

The persist adapter wraps Tauri's SQLite KV store for desktop, and `localStorage` for the web fallback.

## Data Flow: What Goes Where

| Data | Storage | Why |
|------|---------|-----|
| Book metadata (title, author, progress) | Zustand `libraryStore` | Needs reactivity for library UI |
| Companion audiobook (`audioTrack`: file path, position, speed, chapters) | Zustand `libraryStore` (optional `Book` field) | Synced with the book record; generated audiobooks live at `app_data_dir()/audiobooks/<id>.ogg` |
| Book binary | filesystem `book-cache/{id}.book` (the `books.data` BLOB is a stub) | Binary, not reactive |
| Book cover (as data URL) | SQLite `covers` | Binary-ish, not reactive |
| Foliate locations | SQLite `blob_store` | Too large for Zustand |
| Annotations | SQLite `book_annotations` (per-book) + Zustand `libraryStore.annotations` (global index) | Per-book for fast queries, global for sync |
| Settings | Zustand `settingsStore` | Small, reactive |
| Reading stats | Zustand `settingsStore` | Small, reactive |
| Vocabulary terms | Zustand `vocabularyStore` | Moderate, reactive |
| RSS feeds & articles | Zustand `rssStore` | Moderate, reactive |
| Dictionary files | filesystem `dictionaries/{id}/` (manifest in `kv_store`) | Binary |
| Sync pairs | filesystem `sync-paired-devices.json` | Small, not reactive |
| Sync data | iroh-docs CRDT doc | Managed by iroh |
