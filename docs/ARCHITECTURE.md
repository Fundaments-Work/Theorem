# Architecture

## High-Level Design

```
┌─────────────────────────────────────────────────────┐
│                    App.tsx                            │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────┐  │
│  │ Sidebar   │  │ Titlebar │  │ Route Switch        │  │
│  │ (desktop) │  │         │  │ (useUIStore driven) │  │
│  └──────────┘  └──────────┘  └────────────────────┘  │
│  ┌──────────┐                          │              │
│  │ BottomNav│                    ┌──────┴──────┐      │
│  │ (mobile) │                    │ Lazy routes │      │
│  └──────────┘                    └──────┬──────┘      │
└────────────────────────────────────────┼─────────────┘
                                         │
              ┌──────────────────────────┼──────────────────────────────────────┐
              │         Features         │                                      │
         ┌────┴─────┐ ┌──────┴──────┐ ┌──┴───────┐ ┌────────────┐ ┌───────────┐ │
         │  Reader   │ │  Library    │ │ Discover│ │ Feeds      │ │ Vocabulary│ │
         │ (2 engs)  │ │ (virtual)   │ │ (OPDS)  │ │ (RSS/Atom) │ │ (StarDict)│ │
         └──────────┘ └─────────────┘ └──────────┘ └────────────┘ └───────────┘ │
              │                                                                 │
         ┌────┴─────────────────────────────────────────────────────────────────┘
         │
    ┌────┴────┐
    │  Core    │
    │  Stores  │◄──── Zustand persist ────► SQLite (via Tauri)
    │  Lib     │
    │  Services│
    └─────────┘
         │
    ┌────┴──────────────────┐
    │     Tauri Backend      │
    │  ┌──────┬──────┬────┐  │
    │  │ DB   │ Sync │ TTS│  │
    │  │EPUB  │ File │HTTP│  │
    │  │Parser│Xfer  │    │  │
    │  └──────┴──────┴────┘  │
    └────────────────────────┘
```

## Data Flow

### Book Import → Library → Reader

```
File system          Tauri command            JS import pipeline        Store
  │                     │                         │                     │
  ├─ epub/pdf/... ──► read_file() ──► importBooksIncremental() ───► libraryStore
  │                                          │                            │
  │                                    ┌──────┴──────┐                    │
  │                                    │ contentHash  │                    │
  │                                    │ (SHA-256     │                    │
  │                                    │  dedup)      │                    │
  │                                    │ metadata     │                    │
  │                                    │ extraction   │                    │
  │                                    │ cover        │                    │
  │                                    │ extraction   │                    │
  │                                    └─────────────┘                    │
  │                                                                       │
  │    Later: select book ──► useUIStore.setRoute("reader", bookId)       │
  │                              │                                        │
  │                         Reader.tsx loads book:
  │                           ├─ EPUB/MOBI → FoliateEngine
  │                           └─ PDF       → PDFJsEngine
```

### Sync Data Flow

```
Device A                              Device B
  │                                       │
  │  provisionToIrohDocs()                │
  │  (serializes all store state          │
  │   into iroh-docs entries)             │
  │                                       │
  │  docsSetEntry("book:{id}", ...)       │
  │  docsSetEntry("annotations", ...)     │
  │  docsSetEntry("settings", ...)        │
  │  ...                                  │
  │                                       │
  │  docsSyncNow(peerDeviceId) ──────────►│
  │  (iroh-docs CRDT sync via gossip)     │
  │                                       │
  │◄──── docs-entry-changed (events) ─────│
  │◄──── docs-sync-finished (event) ──────│
  │                                       │
  │  hydrateFromIrohDocs()                │
  │  mergeIncomingData()                  │
  │   ├─ mergeBooks()                     │
  │   ├─ mergeAnnotations()               │
  │   └─ mergeSettings()                  │
  │                                       │
  │  Open synced book:                    │
  │  download_book_file(peerId,           │
  │    bookId, destPath) ────────────────►│
  │  (direct-to-disk, no IPC)             │
  │◄──── progress events ────────────────│
  │◄──── OK/ERR (status only) ───────────│
```

### Reader Rendering

```
Reader.tsx
  │
  ├─ Non-PDF (EPUB, MOBI, FB2, CBZ, CBR)
  │   └─ ReaderViewport
  │       └─ useDocumentReader
  │           └─ FoliateEngine
  │               └─ foliate-js view.js (iframed content)
  │                   ├─ paginator.js (CSS grid column layout)
  │                   ├─ epub.js (OPF/spine parsing)
  │                   └─ overlay.js (highlight rendering)
  │
  └─ PDF
      └─ PDFReader (lazy loaded)
          └─ PDFJsEngine
              └─ pdfjs-dist (canvas rendering)
                  ├─ text layer (selection)
                  └─ annotation layer (highlights/drawings)
```

## State Architecture

All state lives in 6 Zustand stores. Each persisted store saves to SQLite via Tauri commands (`sqlite_set_kv` / `sqlite_get_kv` from `database.rs`).

```
uiStore (persisted, version 1; partialize: route/book/sidebar)
  ├─ currentRoute, currentBookId
  ├─ sidebarOpen, searchQuery
  ├─ vaultSyncStatus, deviceSyncStatus
  └─ downloadingBookId (set while syncing a book file on-demand)

libraryStore (persisted, version 6)
  ├─ books: Book[]
  ├─ annotations: Annotation[]
  ├─ collections: Collection[]
  └─ deletionTombstones: DeletionTombstone[]

settingsStore (persisted, version 11)
  ├─ settings: AppSettings
  ├─ stats: ReadingStats
  └─ settingsLastModifiedAt: string

vocabularyStore (persisted, version 5)
  ├─ vocabularyTerms: VocabularyTerm[]
  └─ installedDictionaries: InstalledDictionary[]

rssStore (persisted, version 1)
  ├─ feeds: RssFeed[]
  └─ articles: RssArticle[]

opdsStore (persisted, version 2)
  ├─ catalogs: OpdsCatalog[]
  ├─ activeCatalogId: string | null
  ├─ currentFeedUrl: string | null
  └─ feedHistory: string[]
```

**Non-persisted data lives in SQLite directly:**
- `book.locations` — foliate position snapshots (BLOB column, prefix `locations:{bookId}`)
- Book binary data and covers (materialized to `book-cache/`)
- StarDict/MDict dictionary files (on disk under `dictionaries/{id}/`; legacy `blob_store` entries auto-migrated)
- Book metadata and annotations (separate tables with FK to books)

## Reader Architecture

Two rendering paths converge in `Reader.tsx`:

```
Reader.tsx orchestrates:
  ├─ Book loading (detect format → choose engine)
  ├─ Annotation sync (store ↔ engine ↔ panel)
  ├─ Search (engine-native or PDF.js)
  ├─ Narration (ImmersionPlayer: neural/platform TTS · AudiobookBar: companion audio)
  └─ Navigation state (pagination, position tracking)

Non-PDF path:
  ReaderViewport → useDocumentReader → FoliateEngine → foliate-js view.js

PDF path:
  PDFReader → PDFJsEngine → pdfjs-dist
```

The foliate-js submodule at `src/features/reader/foliate-js/` is vendored upstream (johnfactotum/foliate-js). We never edit it directly. Instead, `scripts/sync-foliate-js.sh` copies the files we need into `src/features/reader/foliate-js-runtime/` and applies runtime patches. This is where our modifications live.

Runtime patches applied by `scripts/patches/`:
| Patch | File | What it does |
|-------|------|-------------|
| `view-js-runtime.patch` | `view.js` | Injects `prefetchPromise` for parallel Rust cache, adds per-file lazy zip loading fallback |
| `epub-js-runtime.patch` | `epub.js` | Deduplicates in-flight `loadText` calls for concurrent href fetches |
| `paginator-js-runtime.patch` | `paginator.js` | Overrides `#container` to use `overflow:clip` (non-scrollable) and positions pages via `transform: translateX/Y` instead of scrollLeft/scrollTop; guards `#container` sizing for zero-dimension fallback |
| `dict-js-runtime.patch` | `dict.js` | Adds gzip/dictzip decompression for StarDict dictionary files |

The `scripts/sync-foliate-js.sh` script also replaces the vendored PDF.js import with `pdfjs-dist` from npm and removes unused files (PDF.js vendor, rollup config, etc.).

## Sync Architecture

Three protocols, one per concern:

| Protocol | Purpose | Crate |
|----------|---------|-------|
| iroh-docs | CRDT-based structured data sync (books, annotations, settings) | `iroh-docs` |
| iroh-gossip | Live peer discovery and event propagation | `iroh-gossip` |
| iroh-blobs | CRDT entry content storage (for iroh-docs internal use) | `iroh-blobs` |
| iroh-mdns | LAN peer discovery via mDNS | `iroh-mdns-address-lookup` |
| theorem-file/v1 | Custom QUIC protocol for book file transfer (not iroh-blobs) | `file_transfer.rs` |

Sync lifecycle:
1. **Start**: `iroh_start` initializes iroh endpoint, attaches to docs+gossip+blobs
2. **Pair**: QR code exchange → bidirectional key registration → doc import
3. **Accept loop**: Subscribes to each paired device's doc, establishes gossip mesh via `doc.start_sync()`
4. **Provision**: All store state serialized into per-key iroh-docs entries
5. **Sync**: `docs_sync_now` triggers CRDT reconciliation with a peer (15s timeout)
6. **Merge**: Incoming data merged with CRDT Last-Write-Wins and domain-specific conflict resolution
7. **Live**: `docs-entry-changed` events stream real-time changes during sync; gossip `NeighborUp` triggers auto-sync
8. **File transfer**: On-demand `download_book_file` writes directly to `book-cache/` from Rust (no IPC), with progress events
