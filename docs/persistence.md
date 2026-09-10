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
