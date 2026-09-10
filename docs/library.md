# Library

## Why Virtual Scrolling

At 10,000 books, rendering a DOM node for every book would consume gigabytes of memory and freeze the main thread. The library uses `@tanstack/react-virtual` to render only the ~30 rows visible in the viewport. As the user scrolls, rows are recycled and repopulated.

The `BookCard` component is wrapped in `React.memo` with a custom comparator that checks only the fields rendered in the card (title, author, progress, cover, favorite, view mode). Unrelated state changes won't trigger re-renders.

## Import Pipeline

```
User action (drop file / pick dialog / scan folder)
  │
  ▼
importBooksIncremental()
  ├─ Desktop (Tauri): invoke ingest_books_native
  │    └─ Rust batch ingest: parallel read, SHA-256 dedup, per-format
  │       metadata + SIMD cover extraction → book-cache/ + books row + FTS
  └─ Mobile / web: JS path
       ├─ read_file (Tauri) → ArrayBuffer
       ├─ contentHash = SHA-256(buffer) → dedup check against existing books
       ├─ Detect format from extension
       ├─ CBR → read_cbr_as_cbz (Rust unrar-ng → zip conversion; Tauri only)
       ├─ Extract metadata via cover-extractor.ts (per-format strategy)
       ├─ Extract cover image
       ├─ addBook() → libraryStore mutation (batched for multi-import)
       ├─ sqlite_save_book_data → writes to book-cache/ (books.data is a stub)
       └─ sqlite_index_book_fts → FTS5 index update

Web fallback (non-Tauri):
  ├─ IndexedDB via idb-keyval
  └─ CBR → CBZ conversion unavailable (imported as .cbr)
```

**Dedup logic:**
- Books with the same `contentHash` (SHA-256 of file contents) are treated as duplicates
- The first import wins — subsequent imports are skipped
- Re-importing the same file path updates the file path but preserves annotations and progress

## Virtual Scrolling Architecture

```
LibraryPage
  └─ useVirtualizer (from @tanstack/react-virtual)
       ├─ scrollRef (scrollable container div)
       ├─ Virtual row → MemoizedBookCard (custom memo comparator)
       └─ Three view modes: grid / list / compact
            ├─ grid: 2-8 columns depending on container width
            ├─ list: 1 column with full metadata
            └─ compact: 3-6 columns, minimal metadata
```

The virtualizer calculates rows based on container width (column count) and estimated row height. After render, actual row heights are measured and the virtualizer adjusts. This means initial render might show a flash before heights stabilize, but it avoids measuring every item upfront.

## Search

Two-tier search:
1. **FTS5** (SQLite): Fast, indexed search via `sqlite_search_books(query, limit)`. Used for committed search queries (when user presses Enter). Returns matching book IDs and titles.
2. **Client-side** (`filtering.ts`): Fuse.js fuzzy search over title, author, tags, and format, plus filter/sort on the already-loaded `books` array. Supports sorting by title, author, date added, last read, progress, rating. Combined with FTS results for full-text + metadata filtering.

The `useLibraryStore` has result caches (`WeakMap`-based) for search results, recent books, favorites, and categories. These are invalidated when the `books` array reference changes (Zustand immutability).

## Format Support

| Format | Reader Engine | Import Notes |
|--------|---------------|--------------|
| EPUB | Foliate | Reflowable, preferred format |
| MOBI | Foliate | Legacy Kindle format |
| AZW / AZW3 | Foliate | Kindle Format 8 |
| FB2 | Foliate | FictionBook XML |
| CBZ | Foliate | Comic book ZIP |
| CBR | Foliate (converted) | Converted to CBZ via Rust unrar-ng |
| PDF | PDF.js | Fixed-layout, range-based reads |

## Folder Scanning

`scan_library_folder_desktop(path)` recursively walks a directory and collects all supported files. On Android, `scan_library_folder_mobile(uri)` uses the SAF (Storage Access Framework) via a custom Tauri plugin.

The scan returns file paths; importing them is a separate step (`importBooksIncremental`) to avoid blocking the UI during long scans on network drives.
