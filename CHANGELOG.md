# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.8] - 2026-09-23 (Beta)

### Reading System

- **PDF links and Theorem Lens** — Citations, footnotes, TOC links and URLs in PDFs are clickable. Hovering an internal link shows a borderless preview of the destination rendered from the page; clicking it jumps to the exact spot, even on pages not loaded yet. Back/forward history (Alt+←/→, mouse buttons 4/5, Android back).
- **PDF smoothness** — Wheel and pinch zoom preview with a transform and re-render once, anchored under the cursor; the initial fit no longer opens a third of a page down. Rendered pages live in a bounded LRU (6 pages / 24 MP on desktop, 3 / 8 MP on Android). Canvas and text layer render separately, so text selection survives scrolling and no longer blinks. On WebKitGTK the time blocked during a zoom dropped from 1483 ms to 136 ms.
- **PDF features** — Page thumbnails (Navigation → Pages, rendered only when the viewer is idle), Present mode (F5: full screen, one page at a time), Print (Ctrl+P, desktop), embedded attachments listed in Book Info with Save, Define/Copy for selected text (same dictionary as EPUB), logical page labels (`xii (12)`, go to `A-3`), match-case / whole-word search with F3 cycling, and document properties (producer, PDF version, page size, correctly parsed creation dates). Pages are always shown as the file draws them: the old dark/sepia filters, which also recoloured photos, are gone. The tool palette and View panel use the reader's square style. JPX, JBIG2 and CCITT images now decode; the pdf.js cmaps, fonts and wasm decoders ship at the right paths (they were missing from builds), with a post-build check.
- **EPUB** — Selections highlight glyphs only, like PDF, instead of flooding margins. Only the visible chapter's highlights are drawn (one call instead of about 1,000 on open). Books are read by byte range, and every chapter and image is decompressed in Rust (`epub_read_entry`) instead of zip.js on the UI thread.
- **Fast scrolling** — A fling or scrollbar drag renders entering pages at low resolution first (instead of leaving them white), then sharp when scrolling stops.
- **No UI-thread blocking from native calls** — 64 Tauri commands (SQLite, PDF/EPUB reads, file reads, RSS and article fetches, metadata parsing) used to run on the window's main thread; they now run on a background pool. SQLite calls keep their order through a FIFO queue.

### Fixed

- **In-book search** — Finds the literal text, every occurrence on every page, instead of "fuzzy" results made of scattered letters; PDF search uses the text pdf.js decodes. EPUB match positions stay correct around characters whose lowercase has a different length (e.g. "İ").
- **Library search** — No more unrelated titles matched by scattered letters (only compact matches or word-start acronyms like "lotr"). Shelves use the same native search as the Library, results no longer flash, a failed search falls back instead of showing nothing, and deleted or renamed books no longer linger in the search index.
- **Rotated PDF pages** — Pages a PDF marks as rotated (common in scans) were drawn sideways.
- **No lost data on quit** — Pending writes (library, progress, reading time) are flushed to SQLite before the window closes, the app quits from the tray, or it goes to the background.
- **Sync after page turns** — Reading progress syncs at most every 30 s instead of starting a full sync round two seconds after each page turn (a source of periodic stutters).
- **Statistics in local time** — Reading days, streaks, goals and the daily reminder used UTC dates.
- **Reading speed** — Measured over the whole time on a page instead of counting each page twice.
- **Vocabulary and annotation storage** — Replaced the dual-write to JSON blobs with SQLite as the single source of truth on native platforms. State serialization drops full arrays from `kv_store`, eliminating JSON stringification overhead and preventing resurrected items during rehydration.
- **Sync merge in Rust** — `sqlite_merge_sync_entries` directly applies incoming gossip updates and deletion tombstones for books, annotations, vocabulary, and RSS articles within an atomic SQLite transaction, returning granular diff reports of changed entity IDs so in-memory stores update incrementally without full-collection re-stringifications or IPC roundtrips.
- **Relational library store** — Decoupled book metadata persistence from giant JSON blobs in `kv_store` on native platforms into individual `book_metadata` rows in SQLite. `partialize` excludes books from Zustand persistence payload, and `updateProgress` saves reading state directly via `sqlite_update_book_progress` without re-serializing the library or triggering FTS re-indexing on every page turn.
- **Vocabulary sync** — Merges write only changed terms and propagate deletions.
- **RSS** — Favorites are never aged out; other articles are kept for 30 days, newest 500. Feeds refresh four at a time. All Markdown is rendered by `pulldown-cmark` in Rust, with raw HTML and `javascript:` links neutralised.
- **Vault export** — Only changed notes are rewritten; notes for removed books are deleted unless you edited them. Obsidian, Logseq, Minimalist, and Custom (Knap) presets with an integrated live template editor, syntax validation, and wikilink/callout filters; the native and fallback exporters write byte-identical notes and file names (shared golden tests).
- **Covers** — Stored as raw image bytes (a third smaller than base64; converted on first start) and served from SQLite via `theorem-cover://` without decoding, instead of loading every cover into memory at startup; synced as their own entries.
- **RSS sync** — Each article syncs as its own entry, so changing one article no longer re-sends every article.
- **Audiobook encoder** — libopus is now linked statically; release builds had been loading the system `libopus.so.0`.
- **Android build** — Ported to jni 0.22 after the Dependabot bump.

### Dependencies

- zip 4 → 8, bzip2 0.4 → 0.6, jni 0.21 → 0.22, iroh-mdns-address-lookup; removed `@mozilla/readability`, `markdown-it`, `@zip.js/zip.js` (dev) and foliate's vendored fflate copy (npm `fflate` is used); one libopus build instead of two. CI now runs clippy for Android.


### Performance

- **Fuzzy Search: Eliminated N×keys RegExp Allocations** — In `src/core/lib/search/fuzzy.ts`, the word-boundary `RegExp` was previously constructed inside `scoreFieldMatch` for every book × every field on every keystroke. For a 1000-book library with 4 fields, that was 4000+ `RegExp` objects per keystroke. Introduced `scoreFieldMatchFast` which accepts a pre-compiled `RegExp` from the caller; `rankByFuzzyQuery` now compiles it once per query and passes it into the inner scorer, reducing per-search `RegExp` allocations to exactly 1.
- **Library Sort: Schwartzian Transform Eliminates Date Allocations** — In `src/features/library/filtering.ts`, `new Date()` was called inside the sort comparator (O(n log n) calls = ~20,000 Date allocations per sort on a 1000-book library). Replaced with a Schwartzian transform: timestamps are pre-computed once before sorting into a decorated array, the sort operates on raw numbers, then the books are extracted back out. Zero transient Date allocations in the comparator.
- **Book Model Cache: Cleanup on Eviction** — In `src/features/reader/engines/foliate-engine.ts`, the 2-entry LRU book model cache silently dropped evicted entries without calling any cleanup, leaving EPUB ZIP decompressor state and inflated chapter buffers alive (50–100MB leak per eviction). Cache now stores `{book, cleanup}` pairs and calls `cleanup()` → `book.destroy?.()` before evicting the oldest entry. Cache Map type narrowed from `Map<string, any>` to `Map<string, {book: unknown; cleanup: () => void}>`.
- **Reader.tsx: Remove Redundant `useMemo` Wrapping `useShallow`** — `useShallow` already guarantees stable reference equality when values are shallowly equal. The additional `useMemo` wrapping its result added one extra object allocation and comparison per render. Removed; `settings` is now the direct `useShallow` result.
- **Annotations & Bookmarks: Eliminate Whole-Books Array Subscription** — `AnnotationsPage` and `BookmarksPage` subscribed to the entire `books` array (`useLibraryStore(s => s.books)`), causing a re-render on every progress tick for any book in the library. Replaced with `getBook` (O(1) selector); each page now derives its title/book lookup only from the bookIds present in its own annotations/bookmarks via `useMemo`.
- **Vite Bundle: Vendor Chunk Splits for `@tanstack`, `sonner`, `@radix-ui`** — These stable dependencies previously landed in the main app chunk, busting the browser cache on every app code change. Added `tanstack` and `ui-vendors` manual chunks to `vite.config.ts` so they get independent, long-lived cache entries.

### Fixed

- **Library Multi-Select Repaired; Shelf Selection Mode Added (#109)** — Selection checkboxes and selected rings now render in grid, list, and compact views; keyboard Enter/Space toggles in selecting mode; toolbar toggle exposes `data-action="toggle-select-mode"` so Ctrl+A works; selection lookups use a `Set`. New shelf-detail selection mode: Select All, Shift+click range select, and a shelf-aware bar (Remove from Shelf, Add to Shelf, Mark Read/Unread, Delete with confirm). New single-set batch store actions (`addBooksToCollection`, `removeBooksFromCollection`, `markBooksCompleted`, `markBooksUnread`, `removeBooks`) so batch confirms dismiss instantly.
- **Route Keep-Alive with Mount-on-First-Visit (#103)** — Non-reader routes stay mounted behind `hidden` toggles with per-route mount-on-first-visit, so back-navigation is an instant class toggle preserving scroll position, filters, and virtualizer caches. The reader stays exclusive so engines unmount on exit.
- **Reader Open-Path Navigation Retry (#105)** — Initial `goTo` runs with a 15s budget plus one retry instead of a single 6s timeout that false-positived under spine/CSS load.
- **RSS Renders All Entity Shapes (#107)** — Article body prefers `fullContent`; the sanitizer iteratively decodes named, decimal, hex, and double-encoded entities (including mixed genuine+escaped payloads) before sanitize, with markdown detection running on decoded text. Rust `article_epub` detects namespaced/attributed markup (`<p xmlns>`) instead of requiring exact `<p>`/`<div>`, so reader EPUB conversion no longer escapes real markup into visible tags.
- **Updater Beta Channel (#106)** — Pre-release builds fall back to a GitHub Releases prerelease lookup with semver comparison; new "Beta Available → View Beta Release" UI. Stable path unchanged.
- **IPC Access for Reader Windows (#102)** — `default.json` capability now covers `reader_*` windows (previously only `main`, so every invoke in second windows was ACL-denied). Frontend memory trim routes through `trim_memory` with a 5s throttle.
- **Device-Local Vault Path Kept on Sync** — `mergeSettings` preserves `existing.vault` like `deviceSync`, so a peer's empty path no longer clobbers this device's export folder.

### Performance

- **Sync Bridge Persistent Identity Indexes** — The docs subscriber rebuilt Maps/Sets and re-serialized every entity on each notification. Now a single pass with O(1) referential-identity fast paths; only changed entities stringify. Exact deletion semantics preserved.
- **Live Gossip Batching** — Annotation/collection keys coalesce over 200ms into one merge + one setState; tombstone re-merges trail 500ms into an idle callback; merged-book lookup uses an index Map instead of per-item `.find`.
- **Persist Pipeline Off the `set()` Hot Path** — New deferred JSON storage adapter coalesces bursts and stringifies in an idle callback, with memoized `partialize` skipping rebuilds when persisted slices are unchanged. Rehydrate, migrations, and hide/unload flushes preserved.
- **Absolute Virtual Rows Everywhere** — Library, Shelves, Bookmarks, and Annotations use absolute `translateY` rows with no per-row measuring.
- **Shared Solid Scrollbar** — One `.scrollbar-solid` utility (opaque thumb, reserved gutter) on all list surfaces.
- **Article Highlight Single Pass** — One text-index walk plus binary-search lookups replaces a full tree walk per highlight.
- **Discover Indexed Title Checks** — Shared WeakMap-cached title Set replaces per-card books scans.
- **Reader Navbar Composites Opaque** — Dropped `backdrop-blur-xl` over its solid surface.

## [1.5.7] - 2026-09-18 (Beta)

### Fixed

- **Mobile EPUB Navigation & Image Rendering Stabilization** — Restored immediate, fluid page turns and eliminated blank pages across illustrated and media-rich EPUBs:
  - In `foliate-js-runtime/paginator.js`, eliminated the blocking pre-layout image decoding wait and 200ms `visibility: hidden` blanking, restoring immediate synchronous layout rendering and zero-latency `#turnPage` resolution.
  - Fixed CSS multi-column fragmentation: removed `break-inside: avoid` and `-webkit-column-break-inside: avoid` on parent `<p>`, `<div>`, and `<figure>` containers that caused the browser column formatter to abandon columns and generate blank pages before images.
  - Removed `display: block` and `height: auto !important` overrides on `img` elements, preserving natural aspect ratios and fluid column fitting with `object-fit: contain`.
  - Calibrated touch gesture axis locking to 10px with natural horizontal dominance, preventing swipe drops on diagonal thumb arcs.
  - Preserved chapter blob URLs during active reading sessions to prevent broken image assets on previous-chapter navigation.
- **Ghost Book Elimination on P2P Sync Deletions** — Fixed ghost book cards remaining in the library when a book was deleted on a paired peer:
  - In `src-tauri/src/file_transfer.rs`, added checks against `deletion_tombstones` and `deletedAt` metadata, returning an explicit `PEER_BOOK_DELETED` status if a requested book has been deleted.
  - In `src/core/lib/sync-orchestrator.ts`, immediately merged incoming `deletion_tombstones` over Iroh gossip and purged deleted book cards from local state without delay.
  - In `src/features/reader/Reader.tsx`, handled `PEER_BOOK_DELETED` by pruning the local ghost card, displaying an informative toast (*"This book was deleted on the source device."*), and routing to the Library.
- **Android Hardware Back Button Navigation Stack** — Intercepted Tauri `onCloseRequested` / hardware back button events in `src/App.tsx`:
  - Dismisses active overlays, sheets, and reader panels in LIFO order via `dispatchBackAction()`.
  - Navigates from Reader view back to Library before closing.
  - Minimizes or exits the app only when on the root Library route with no active overlays.

### Improved & Performance

- **Note Export Clean Typography & Knap AST Templating** —
  - In `src-tauri/src/vault_export.rs` and `src/core/lib/vault-sync.ts`, cleaned YAML frontmatter to include only essential properties (`title`, `author`, `type: "theorem-book-highlights"`, single `total_highlights: N`, and `tags: [theorem, highlights]`), removing internal paths, formats, and redundant duplicate counts.
  - Overhauled Markdown body formatting: removed artificial numbered headings (`### 1. Highlight`), redundant color labels, timestamps, and divider lines. Quotes are formatted cleanly as `> ==quote==` with user notes placed directly underneath.
  - Integrated `@obsidianmd/knap` AST template engine in frontend export settings for safe, custom Markdown templates with 0 bytes added to the native Rust binary.
- **SQLite Memory Reclaim & Low-Memory OS Trimming** —
  - Enhanced native `trim_memory` command in `src-tauri/src/database.rs` and `lib.rs` to run `PRAGMA shrink_memory;` and `PRAGMA wal_checkpoint(PASSIVE);` on SQLite connections alongside `libc::malloc_trim(0)` on Linux and Android Bionic `mallopt(-101, 0)` (`M_PURGE`).
  - Wired `document.visibilityState === 'hidden'` in `src/App.tsx` to automatically trigger `trim_memory` whenever Theorem is minimized or backgrounded, preventing background process termination by the Android OS Low Memory Killer (LMK).
- **Native Rust Readability Engine** — Integrated Mozilla's Readability port in Rust (`readability` crate) with full DOM scoring into `src-tauri/src/article_extractor.rs`, parsing and scoring article HTML in Rust in <3ms.

## [1.5.6] - 2026-09-18 (Beta)

### Fixed

- **Memory & CPU Spike on Book Opening** — Eliminated excessive ~1.3GB memory consumption and CPU pegging when opening books:
  - In `src/features/reader/Reader.tsx`, decoupled `tts_engine_preload` from unconditional book open hooks so neural ONNX models are compiled only when Immersion Reading is actively enabled.
  - Added an unmount hook that triggers `tts_engine_unload` and a new native `trim_memory` command calling `libc::malloc_trim(0)`, releasing dormant glibc thread arenas back to the OS kernel.
  - Reaped Linux `spd-say` and `killall` child processes in `src-tauri/src/tts_linux.rs` via detached wait threads, preventing `<defunct>` zombie process accumulation.
- **P2P Device Sync PDF & Non-Materialized On-Demand File Transfers** — Fixed persistent *"Book File Not Available"* errors when attempting to open or download PDFs and EPUBs synced from paired devices:
  - **SQLite Persistence Key Alignment**: Fixed `find_in_db` in `src-tauri/src/file_transfer.rs` querying `persist:theorem-library`. Theorem stores state under `zustand:theorem-library` via `SQLITE_PERSIST_KEY_PREFIX`. Updated queries to check `zustand:theorem-library` (and fallback variations) to accurately extract desktop-imported book file paths (`filePath`, `storagePath`).
  - **File Path Normalization & Percent-Decoding**: Added `normalize_candidate_path` in `file_transfer.rs` handling `file://` scheme prefixes, percent-encoded spaces and symbols (`percent_decode_str`), and Windows drive formats (`/C:/...` -> `C:/...`).
  - **Direct LAN IP/Port Connection Fallback**: Configured `EndpointAddr` with `last_ip` and `last_port` socket addresses in `connect_and_request` to ensure reliable direct peer connections on local networks when relays are delayed or unreachable. Refreshes and persists verified socket addresses upon successful transfers.
  - **Two-Way Pairing Address Capture**: Updated `PairingProtocolHandler::accept` in `src-tauri/src/iroh_sync.rs` to extract remote IP and port from `conn.paths()` and record them in `PairedDevice`, establishing direct LAN addressing immediately upon pairing.
  - **Atomic Safe Downloads**: Updated `download_book_file` to stream incoming bytes into a `.download.tmp` temporary file before atomically renaming to `.book`, cleaning up incomplete artifacts on network timeout or failure.
  - **Immediate Progress & Reload Flow**: Emitted an initial `0.0%` event immediately upon connection in `file_transfer.rs` and attached the progress listener on mount in `Reader.tsx`. Cleared `loadedBookIdRef.current` upon transfer completion so the reader seamlessly mounts the newly acquired book without stalling on "Book File Not Available".
- **Mobile EPUB Navigation & Touch Gesture Handling** — Restored smooth EPUB navigation and thumb gesture ergonomics:
  - In `foliate-js-runtime/paginator.js`, restored GPU-promoted 300ms CSS transform slide transitions for page turns and snap releases while keeping transitions cleanly disabled during finger drags and frame-by-frame JS interpolation.
  - Refined gesture axis arbitration (`absDx > 16 && absDx > absDy * 1.3`) so natural curved thumb swipes reliably turn pages without locking into vertical scroll.
  - Set `touchAction: 'none'` on paginated viewport containers in `ReaderViewport.tsx`, eliminating mobile WebView gesture arbitration delays.
- **Download Failure UI Polish** — Removed the extraneous "Go to Sync Settings" button from the reader download failure modal, establishing a clean, unified two-button action group (*Back to Library* and *Try Again*).

### Improved & Performance

- **Dependency Modernization** —
  - Removed deprecated `@types/dompurify` and `@types/uuid` (types are now bundled upstream).
  - Updated frontend dependencies to latest versions, including `vitest` & `@vitest/coverage-v8` `5.0.1`, `@tanstack/react-virtual` `3.14.13`, `zod` `4.6.5`, `react-i18next` `17.0.14`, `lucide-react` `1.47.0`, and `jsdom` `30.1.0`.
  - Updated 44 Rust crates via `cargo update` to latest compatible releases.
- **Dynamic Deferred Sentry Loading** — Refactored `src/core/lib/sentry.ts` and `src/main.tsx` to dynamically import `@sentry/react` only when a valid Sentry DSN is resolved at runtime. Sheds **270 KB (88 KB gzip)** from the synchronous critical startup path for local, offline, and dev instances.
- **React Re-render Isolation & Fine-Grained Selectors** —
  - In `Library.tsx`, extracted `<DailyHighlightBanner />` as an isolated memoized component, removing the `annotations` array subscription from `LibraryPage`. Prevents full library re-renders (1,000+ cards) when annotations are created, updated, or synced.
  - In `Sidebar.tsx`, replaced whole-object `stats` subscriptions with primitive `currentStreak` selectors, preventing sidebar thrashing during background reading progress flushes.
  - In `Reader.tsx`, decoupled the `feeds` array subscription from the active book reader and isolated reader-specific settings via shallow derivation, ensuring background RSS feed refreshes and non-reader settings modifications never trigger reader viewport re-renders.
- **SQLite Composite Query Indexes** — Added `idx_rss_articles_feed_fetched ON rss_articles(feed_id, fetched_at DESC)`, `idx_rss_articles_fetched_at ON rss_articles(fetched_at DESC)`, and `idx_reading_sessions_date_created ON reading_sessions(session_date DESC, created_at DESC)` in `src-tauri/src/database.rs`, converting in-memory sort scans into instant index lookups.
- **Zero-Allocation Rust Search & Clone Elimination** —
  - Replaced allocating string-lowercasing search in `src-tauri/src/epub_rewriter.rs` (`find_ci`) with zero-allocation byte window scanning (`windows(len).position(|w| w.eq_ignore_ascii_case(...))`), saving tens of 100KB–500KB OPF string allocations per metadata write.
  - In `src-tauri/src/epub_parser.rs` (`prefetch_sync`), moved owned `EpubMeta` fields directly, eliminating redundant heap string clones and pre-inflated chapter map duplication.
  - In `src-tauri/src/batch_ingest.rs`, moved base64 cover strings directly into `NativeBookRecord` without cloning.
- **Cloudflare DTO Data Layouts** — Applied `Box<str>` and `Box<[T]>` across Rust DTOs (`book_search.rs`, `opds_parser.rs`, `article_extractor.rs`, `mobi_parser.rs`, `audiobook.rs`, `mdict.rs`, `stardict.rs`), shedding 8 bytes of excess allocator capacity per field.

## [1.5.5] - 2026-09-14 (Beta)

### Fixed

- **P2P Device Sync PDF On-Demand Downloads (Issue #89)** — Fixed on-demand book download failures from paired devices for books imported on desktop. Enhanced `FileTransferHandler::locate_book` in `src-tauri/src/file_transfer.rs` to locate books across all local storage targets: materialized `book-cache/{id}.book` and `book-cache/{id}`, SQLite `books.data` BLOBs, `book_metadata` table entries (`filePath`, `file_path`, `storagePath`, `storage_path`), and the Zustand library state stored in SQLite `kv_store` (`persist:theorem-library`). Replaced in-memory whole-file buffering with zero-RAM-spike streaming from filesystem `File` handles to QUIC send streams via `tokio::io::copy`.
- **Cross-Page Text Highlighting in PDF and EPUB Readers (Issue #90)** — In `PDFAnnotationLayer.tsx`, implemented sub-range clipping to `textLayerNode` with boundary point comparison so selections spanning across pages isolate text belonging strictly to each respective page. Filtered client rects to the page layer's physical bounding box (`layerRect`), preventing inverted coordinates on previous pages. Replaced immediate `selection.removeAllRanges()` with a deferred cleanup (80ms) to allow multiple intersecting page layers to capture their segment of a multi-page selection. In `Reader.tsx`, updated `resolvePickerPosition()` to anchor using the last client rect from `Range.getClientRects()` rather than `getBoundingClientRect()`, preventing popover menu offset across CSS multi-column paginated layouts.
- **Mobile Immersion Reading and Text-to-Speech on Android (Issue #91)** — Handled `null` voice lists returned by Android's `TextToSpeech.getVoices()` in `TtsAudioPlugin.kt` (`doSpeak`, `getVoices`, `synthesizeToFile`) with `currentTts.voices?.let { ... }`, eliminating unhandled Kotlin `NullPointerException` crashes when `defaultTtsSettings.voice` is set. Enabled TTS by default in `settingsStore.ts` (`defaultTtsSettings.enabled: true`) and ensured `onToggleImmersion` is always available for non-PDF books in `Reader.tsx`, automatically enabling TTS when toggled. Allowed mobile users to access the voice and speed settings popup in `ReaderNavbar.tsx` on Android (`(neuralReady || isAndroid())`) to adjust narration speed (0.75×–1.5×).
- **Sync Gossip and Reading Progress Propagation (Issue #92)** — Fixed a premature bailout in `provisionToIrohDocs()` (`src/core/lib/sync-orchestrator.ts`) where `needsProvision` evaluated to `false` after the first application launch, causing subsequent reading progress mutations and last read timestamps to skip `docsSetEntry()`. Removed the premature bailout so that per-key diffing against `_provisionedValues` runs on every sync round, correctly pushing modified `progress`, `currentLocation`, and `lastReadAt` timestamps to `iroh-docs` and triggering `iroh-gossip` propagation across connected peers. Updated `defaultDeviceSyncSettings` in `settingsStore.ts` to default `autoSyncEnabled: true` and `syncOnConnect: true`, migrating legacy configurations to schema version 12.

## [1.5.4] - 2026-09-14 (Beta)

### Added

- **Pitch-Preserving Audio Time-Stretching (WSOLA)** — Integrated high-fidelity Waveform Similarity Overlap-Add (WSOLA) time-domain algorithm into native Rust playback (`src-tauri/src/audio_player.rs`) with normalized cross-correlation phase alignment and Hann window crossfading. Enables smooth narration playback speed control (0.5×–3.0×) without pitch shifting or robotic frequency distortion across both mono and stereo channels.
- **Native Audio Volume & Speed Controls** — Exposed Tauri commands `tts_audio_set_speed`, `tts_audio_get_speed`, `tts_audio_set_volume`, and `tts_audio_get_volume` controlling the native Rodio sink and WSOLA buffer stretching directly in Rust, wired dynamically through `ImmersionPlayer.ts`.
- **Native PDF In-Book Search Engine** — Implemented a streaming, zero-allocation PDF content search engine in native Rust (`src-tauri/src/book_search.rs`). Parses indirect PDF object streams, decompresses Flate/Deflate content streams, parses PDF text operators (`Tj`, `TJ`, `'`, `"`, hex strings, and glyph kerning offsets), and runs Rayon parallel page searches with UTF-8 byte-slice context snippet extraction.
- **Instant Native PDF Search Fast-Path** — Integrated the native PDF search engine directly into the reader viewport (`src/features/reader/engines/pdfjs-engine.tsx`). In Tauri desktop/mobile environments, queries execute in parallel in Rust (~15ms) and stream directly into the search panel with instant `pdf:page:N` jump coordinates, falling back cleanly to the JS worker in pure web browsers.
- **Native Readability Article Extractor** — Added `extract_article_from_html_native` in `src-tauri/src/article_extractor.rs`, executing fast HTML cleaning, article candidate scoring, and metadata extraction via `quick-xml` directly in Rust.
- **Dynamic Frontend Readability Code-Splitting** — Code-split `@mozilla/readability` and `dompurify` in `ArticleExtractorService.ts`, dynamically loading them only when parsing web articles in browser environments. This sheds over 120KB of minified parser code from the initial frontend chunk.
- **Direct In-Rust SQLite P2P Sync Merging** — Added `sqlite_merge_sync_entries` in `src-tauri/src/database.rs`, merging incoming Iroh-gossip documents directly inside an atomic SQLite transaction. Directly updates `book_metadata`, `book_annotations`, `books_fts`, and `kv_store` while cascading `deletion_tombstones`, eliminating double-hop IPC serialization and preventing Last-Write-Wins collisions.
- **Relational SQLite Vocabulary Storage Subsystem** — Added a dedicated normalized `vocabulary` table in `src-tauri/src/database.rs` with indexed lookup by `(normalized_term, language)` and `created_at`. Automatic idempotent zero-data-loss database migration (`run_v154_database_migrations`) unpacks existing terms from `zustand:theorem-vocabulary` into the relational store inside an atomic transaction while preserving the original `kv_store` blob as an immutable backup.
- **Native EPUB Table of Contents (TOC) Pre-Parsing** — Implemented zero-copy streaming pre-parsing for both EPUB 3 Navigation documents (`<nav epub:type="toc">` / `<nav role="doc-toc">`) and EPUB 2 NCX files (`<navMap><navPoint>...`) in `src-tauri/src/epub_parser.rs` using `quick-xml`. Parses nested chapter hierarchies, resolves intra-book relative hrefs with URL fragments, unescapes entities, and packages the result into compact `Box<str>` / `Option<Box<[TocItemDto]>>` Cloudflare data layouts inside `prefetch_zip_metadata`.
- **Instant Foliate Reader Table of Contents Display** — Wired the pre-parsed TOC directly into the EPUB bridge (`src/core/lib/tauri-epub-bridge.ts`) and reader runtime (`src/features/reader/foliate-js-runtime/view.js` and `epub.js`), allowing the webview reader to immediately populate chapters and landmarks without blocking on DOMParser XML parsing on the main thread.
- **Direct Library Annotation Navigation** — Added interactive "Open in book" navigation directly from cards and context menus in `src/features/library/Annotations.tsx`, instantly opening the book and jumping to the precise highlight or note location.
- **SQLite Vocabulary Persistence & Sync Integration** — Connected `saveVocabularyTerm`, `deleteVocabularyTerm`, and `onRehydrateStorage` in `vocabularyStore.ts` and `sync-orchestrator.ts` to SQLite relational CRUD operations (`sqlite_get_vocabulary_terms`, `sqlite_save_vocabulary_term`, `sqlite_delete_vocabulary_term`). Automatically reconciles relational SQLite terms on app startup and synchronizes mutations.

### Fixed

- **Reader Page Turn Component Thrashing** — Eliminated full 2,800-line React component tree re-renders on every page turn in `src/features/reader/Reader.tsx`. Decoupled the `stats` subscription from the active component tree and deferred visible word count extraction to `requestIdleCallback` after a 1,000ms reading dwell timeout, ensuring buttery 60fps page turns.
- **Instant Intra-Section Navigation & Deadlocks** — Removed artificial `await wait(100)` delay during intra-section page turns in `src/features/reader/foliate-js-runtime/paginator.js`. Ensured the `#locked` flag is released in a `finally` block so failed or aborted section loads can never wedge the page turning pipeline.
- **Bounded Section Navigation & Spine Error Suppression** — Added `#canGoToIndex()` boundary checks prior to `#goTo` calls in `paginator.js`, preventing spurious `Failed to load section` warnings and blank screen states when swiping past the boundaries of the book.
- **Event Listener Leak in Reader Iframe** — Guarded iframe selection listener attachments with `(doc).__theorem_selection_attached` idempotency flag in `src/features/reader/engines/foliate-engine.ts`, eliminating runaway event listener accumulation and duplicated tap triggers across chapter transitions.
- **Controls Tap-to-Toggle Latency** — Removed the artificial 120ms tap-suppression delay in `foliate-engine.ts` and accelerated chrome toggle transitions from 300ms to 150ms `ease-out`, restoring instant responsive chrome toggling.
- **Mobile Swipe Sensitivity & Axis Disambiguation** — Calibrated mobile touch swipe thresholds in `paginator.js` (20% width displacement, 0.2 px/ms velocity) and removed the 180ms hold timer lock, allowing diagonal and hesitant thumb swipes to complete naturally without false-positive selection locks.
- **PDF Continuous Scroll Blanks & Height Collapse** — Expanded `PAGE_PROXY_KEEP_WINDOW` to 50 in `src/features/reader/engines/pdfjs-engine.tsx` (retaining up to 80 loaded page proxies), keeping page placeholders sized accurately and preventing DOM collapse, scroll jumping, and blank renders during rapid scrolling.
- **Cross-Device Goal & Reminder Duplication** — Synchronized `lastGoalNotifiedDate` and `lastDailyReminderDate` in `src/core/store/settingsStore.ts` and `src/core/lib/sync-import.ts`. Flushes reading stats silently on book close and suppresses foreground OS notifications when the application window is focused.
- **Paginator Uncollapse Non-Object Anchor Error** — Fixed an unhandled promise rejection in `paginator.js` where `('collapsed' in range)` was evaluated on numeric anchors (`1`, `0`, fractions) during settings re-renders and column layout updates.
- **Highlight Recovery via Text Walker** — Added `findRangeByText` fallback in `src/features/reader/foliate-js-runtime/view.js` to reliably render highlights even when DOM restructuring invalidates serialized CFI character offsets.

### Improved & Performance

- **Complete Elimination of `fuse.js`** — Removed the `fuse.js` runtime dependency from `package.json` and replaced it in `src/core/lib/search/fuzzy.ts` with a lightweight, zero-dependency fuzzy matching engine. Provides exact prefix, word-boundary, substring, and subsequence compactness scoring while reducing bundle overhead to 2KB.
- **High-Velocity PDF Edge Prefetching** — Increased PDF continuous scroll edge prefetch lookahead to $2.0 \times \text{viewport}$ and expanded concurrent batch loading to 8 pages for seamless continuous scrolling.
- **Testing Integrity & Boundary Hardening** — Expanded `tests/reading-time-adaptive.test.ts` and `tests/paginator-navigation.test.ts` with rigorous edge-case and outlier suites (0 words, negative words, 100,000 words, exact 5.0s/180.0s dwell boundaries, corrupt fractions, lock safety, and gesture classification). All 348 Vitest tests and Rust unit tests pass cleanly.

## [1.5.3] - 2026-09-13

### Added

- **Hybrid Two-Tier Search Engine (`SQLite FTS5` + `nucleo-matcher`)** — Completely replaced JavaScript `fuse.js` in desktop and mobile environments with a native Rust two-tier search architecture (`src-tauri/src/fuzzy_search.rs`). Tier 1 leverages SQLite `books_fts` FTS5 index to prune large libraries on disk down to candidate sets in ~1ms without heap allocation. Tier 2 uses SIMD-accelerated Smith-Waterman matching (`nucleo-matcher`, powering Helix editor) to rank candidates, recover typos, and compute exact matching UTF-32 character indices in ~0.1ms.
- **UI Match Character Highlighting (`<HighlightMatch />`)** — Reusable, high-performance UI letter highlighting component (`src/ui/HighlightMatch.tsx`) that visually accentuates matched character segments in book titles, authors, annotations, and bookmarks across grid, compact, and list views as the user types. Grouping contiguous matched characters minimizes React DOM nodes for zero-lag 60fps typing.
- **Native Standards-Compliant Article EPUB Packaging** — Offloaded EPUB packaging directly to Rust using the `zip` crate (`src-tauri/src/article_epub.rs`), eliminating JavaScript `fflate` (`zipSync`) on the main thread and preventing UI thread stutters when opening web articles and RSS entries.
- **Morphological Lemmatizer & Irregular Inflection Stemmer** — Native Rust stemmer (`src-tauri/src/stemmer.rs`) integrated into MDict (`mdict.rs`) and StarDict (`stardict.rs`) dictionary engines. Provides automatic inflection, irregular verb, and plural normalization for near-100% dictionary hit rates without network fallbacks.
- **Zero-Data-Loss Relational Migration Subsystem** — Added dedicated SQLite relational tables for `rss_feeds`, `rss_articles`, `rss_article_content` (separating heavy article bodies from metadata), and `reading_sessions` (time-series analytics) in `src-tauri/src/database.rs`. Automatically and idempotently migrates legacy JSON blobs from `kv_store` into normalized tables inside an atomic transaction while preserving the original `kv_store` values as immutable backups.
- **Decoupled Relational RSS & KV Store Footprint Reduction** — Decoupled full HTML content from Zustand persistence, shrinking `zustand:theorem-rss` from 25MB+ down to <50KB and eliminating 150ms V8 GC stalls on feed mutations.
- **Full Relational Storage & Session Telemetry API** — Exposed native Tauri commands and typed TypeScript wrappers for RSS feed/article/content CRUD and reading session recording. Reading time hook flushes active session telemetry directly to relational tables while feeding daily goal reminders.
- **Atomic P2P Annotation Sync** — Hardened Iroh Docs P2P synchronization with atomic item-level keys (`anno:<bookId>:<annotationId>`) to prevent overwrite collisions and ensure rapid delta replication across paired devices.
- **Windowed Library Query API** — Added `sqlite_query_books_window` Tauri command with native limit/offset cursor queries to support large library virtualization.

### Improved & Performance

- **Off-Thread Cover Downsampling Across All Ingestion Paths** — Fully wired native Rayon cover downsampling (`downsample_cover`) into `cover-extractor.ts` and `storage.ts`, eliminating DOM `<canvas>` image resizing on desktop and mobile Tauri runtimes.
- **Eliminated JS `Fuse.js` Overhead** — Removed runtime `Fuse` object instantiation and heap-allocated searchable item caches in `filtering.ts`, dropping library filtering memory pressure and query latency to near-zero.
- **Robust Cross-Platform Search Fallbacks** — Seamlessly falls back to token matching in pure browser and mock environments while running native two-tier search in desktop and mobile Tauri runtimes.

## [1.5.2] - 2026-09-13

### Added

- **Native Speech Text Normalizer** — High-performance deterministic rule-based expansion of numbers, dates, 4-digit years, Roman numerals, currencies, percentages, fractions, units, and abbreviations in native Rust (`src-tauri/src/text_normalizer.rs`). Shared across Supertonic neural TTS runtime, desktop platform narration, and offline companion audiobook generation.
- **Single-Shot Rayon Obsidian Vault Exporter** — Rayon multi-threaded native batch export for Obsidian book highlight notes and Lemma SRS flashcard decks (`src-tauri/src/vault_export.rs`). Replaces sequential IPC file-write loops with a single concurrent native filesystem export (<5ms).
- **Native quick-xml Streaming RSS Parser** — Zero-copy SAX feed parsing over byte slices (`src-tauri/src/rss_parser.rs`), cutting feed ingestion from 150ms–400ms down to 2ms–5ms. Adopts Cloudflare data layouts (`Box<str>` and `Box<[T]>`) to eliminate heap capacity slack.
- **Off-Thread Cover Processing & Dominant Color Extraction** — Offloads cover downsampling and WebP encoding to a background thread pool via the native `image` crate (`src-tauri/src/image_ops.rs`), accompanied by fast 32x32 histogram dominant color palette quantization (<0.2ms) without main-thread DOM `<canvas>` overhead.
- **EPUB CFI Range Parsing & Spatial Ordering** — Added native Rust parsing and spatial ordering for EPUB CFI ranges (`src-tauri/src/epubcfi.rs`), enabling exact start-anchor resolution across reflowable chapters.

### Improved & Performance

- **Zero-Allocation In-Book Search Snippets** — Refactored snippet context slicing (`src-tauri/src/book_search.rs`) to use `text.char_indices()` byte slicing, eliminating transient `Vec<char>` heap allocations for 10× faster search throughput.
- **Cross-Column & Cross-Page Highlight Engine** — Precision refactoring of Foliate's Overlayer (`foliate-js-runtime/overlayer.js`) to render individual line fragments via `Range.getClientRects()`, strictly filtering zero-dimension rects across column gutters and multi-column pagination spreads.
- **Foliate Paginator Anchor Stabilization** — Locked non-collapsed range anchors to `startContainer` in `paginator.js`, completely eliminating page-flipping oscillations when highlights span column or viewport page boundaries.
- **Mobile Touch Disambiguation Barrier** — Introduced a 120ms tap-suppression barrier in `foliate-engine.ts`, establishing a strict gesture hierarchy that eliminates false-positive page turns during mobile selection and drag gestures.

## [1.5.1] - 2026-09-11

### Added

- **Set-and-Forget Obsidian Vault Auto-Sync** — Automatically synchronizes markdown notes to your Obsidian vault without needing manual clicks. Sync triggers immediately upon choosing an export folder and runs seamlessly in the background with a 2-second debounce on any highlight, note, or vocabulary change.
- **Lemma Spaced-Repetition (FSRS) Deck Export** — Vocabulary exports to `<VaultRoot>/Theorem/Vocabulary.md` structured as a native flashcard deck for the Lemma Obsidian plugin. Frontmatter includes `tags: [flashcards]` for automatic deck indexing, while cards use standard `---card---` delimiters, pronunciation, context quotes, and stable `^fsrs-vocab-<id>` block IDs to preserve FSRS review history and scheduling across exports.
- **Idiomatic Obsidian Book Highlights** — Book notes are now organized under `<VaultRoot>/Theorem/Books/` using native Obsidian `> ==highlight==` markdown formatting instead of raw HTML `<mark>` tags. Removed dead/unregistered deep links in favor of portable, clean markdown.

### Fixed

- **Silent Reader Exit** — Eliminated nagging "You're X min short" toast notifications whenever closing a book or navigating away from the reader. Exiting the reader now flushes reading stats completely silently.
- **Deduplicated Goal Met Celebrations** — Enforced daily celebration deduplication via `stats.lastGoalNotifiedDate`, guaranteeing that achieving your daily reading goal only triggers a celebration notification strictly once per calendar day.
- **Global Daily Goal Reminder (8 PM)** — Moved the daily goal reminder hook to the global application root (`App.tsx`) and removed the restriction requiring >0 minutes read today, ensuring that users who haven't yet opened the app or read are reliably reminded to read at their scheduled reminder time.

## [1.5.0] - 2026-09-11

### Added

- **Adaptive Reading Time Estimation** — Pure mathematical calculation engine for reading speed and progress (`src/features/reader/lib/reading-time.ts`). Tracks organic dwell time on each page turn, filtering out rapid skimming (<5s) and idle periods (>180s), clamped between 80 and 800 WPM, and smoothed with exponential moving average ($\alpha = 0.15$). The reader navbar now displays both chapter and book remaining time (e.g. `"14 min in chapter · 2 hr left"`), intelligently omitting redundant chapter time on the final chapter.
- **Immersion Reading Pace Lock** — When Text-to-Speech narration is active, reading time estimates automatically lock to the true machine speaking cadence ($160 \times \text{speed}$ WPM) without polluting the reader's human reading average.
- **Audiobook-Grade Text Normalization** — Added automated text pre-processing for natural speech synthesis (`src/features/reader/audio/text-normalization.ts`), expanding cardinal integers into words, ordinal numbers (`1st` $\rightarrow$ "first"), 4-digit years (`1984` $\rightarrow$ "nineteen eighty-four"), Roman numerals in titles and names (`Chapter IV`, `Henry VIII`), currencies (`$12.50`), percentages, fractions, and common abbreviations (`Dr.`, `Mr.`, `e.g.`, `etc.`).

### Improved & Performance

- **Fast Streaming TTS & Reduced Latency** — Reduced intra-sentence silence from 300ms to 80ms for seamless audio playback across sentence chunks without jarring acoustic gaps.
- **Dynamic ONNX Memory Management** — Supertonic neural sessions are automatically unloaded after 60 seconds of idle inactivity, freeing ~400MB of RAM. Memory is also immediately released on reader exit.
- **Idempotent ORT Initialization** — Wrapped dynamic ONNX Runtime initialization in a process-wide `OnceLock`, enabling fast and reliable session recreation whenever narration resumes after an idle unload.
- **Disk Cache Cap & Background Eviction** — Lowered the local WAV audio cache limit from 1GB to a lean 150MB, moving LRU cache trimming to a background thread to prevent disk I/O from stalling the audio synthesis pipeline.
- **Optimized Prefetching** — Aligned prefetch cache keys with streaming chunk normalization, caching only the leading chunk of the upcoming page to eliminate redundant background computation.

### Fixed

- **Highlight Navigation Context Popup** — Navigating to an existing highlight or bookmark from the sidebar or annotations panel no longer falsely triggers text selection or pops open the highlight context menu.
- **TTS Auto-Play on Pause Bug** — Added explicit `paused` state tracking in Rust's `NativePlayer` (`audio_player.rs`), preventing background chunks appended during pause from resuming audio unexpectedly.
- **Initial TTS Premature Page Turn** — Eliminated an errant boundary check that triggered an immediate page-turn when clicking Play for the first time.
- **Instant Playback Resume** — Clicking Play while paused immediately unpauses the active native player instead of restarting speech synthesis from scratch.
- **Fallback Text Extraction on Play** — If page text extraction has not finished caching when Play is clicked, the player extracts visible text on-demand rather than failing silently.
- **Sentence Highlighting Cleanup** — Removed sentence-level overlay DOM mutations during TTS playback, preventing layout shifts and scrolling disruptions.

## [1.4.3] - 2026-09-07

### Fixed

- **Settings panel hidden by bottom bar on mobile** — The `FloatingPanel` (used for reader settings, bookmarks, TOC, etc.) was rendered with `z-[var(--z-dropdown)]` (z-50) while the reader's bottom navigation bar uses `z-[140]`. On mobile, where the panel slides up as a full-width bottom sheet, the navbar was painting on top of it, cropping off the bottom portion. Raised `FloatingPanel` to `z-[150]` to ensure it always appears above the reader chrome.
- **Touch highlight toolbar flash / selection glitch** — When dragging to extend a text selection on touch devices, `selectionchange` was firing continuously mid-drag, causing the `HighlightColorPicker` toolbar to appear and disappear repeatedly (visible flicker). The selection capture is now deferred: `touchstart` sets an `isTouchActive` flag and `selectionchange` only updates the navigation lock during an active touch gesture; the actual callback is processed exactly once on `touchend`. This eliminates the mid-drag toolbar flash. Based on the same deferred-popup pattern used by Readest.
- **iOS native callout menu obscuring highlight toolbar** — Added `-webkit-touch-callout: none` to the reader iframe CSS. On iOS, this suppresses the system "Look Up / Copy / Share" bubble that appeared over Theorem's own `HighlightColorPicker` toolbar after text selection. Native selection handles and the magnifying loupe remain fully functional.

## [1.4.2] - 2026-09-07

### Fixed

- **Touch selection & swipe gesture decoupling** — Fixed glitching and accidental page turns when selecting text to highlight using touch/stylus. In `paginator.js`, a finger hold (>180ms) now locks the gesture into selection mode and prevents swiping; swipe movement threshold was raised from 8px to 20px with horizontal dominance requirements; and active selections automatically snap the viewport back to full-page alignment if displaced.
- **Removed duplicate FoliateEngine swipe handler** — Stripped redundant `touchend` page-turning logic in `foliate-engine.ts` that competed with Paginator and triggered false page-turns during selection drag gestures.
- **Non-blocking highlight overlays** — Highlight SVG elements now use `pointer-events: none`, allowing native touch and mouse selection to freely pass through or cross over existing highlights without interference. Highlight taps continue to be resolved via native document click hit-testing.

## [1.4.1] - 2026-09-07

### Fixed

- **Android TTS companion app visibility** ([#71](https://github.com/Fundaments-Work/Theorem/issues/71)) — Declared `<queries>` for `android.intent.action.TTS_SERVICE` in both the app manifest and the Android TTS plugin manifest, resolving Android 11+ package visibility restrictions and allowing Theorem to discover and select the Theorem Neural Voice companion engine (`work.fundamentals.theorem.neuralvoice`).
- **Instant highlight creation and tap responsiveness** ([#72](https://github.com/Fundaments-Work/Theorem/issues/72)) — Synchronized `this.annotationLocations` during `addHighlight()`, `addAnnotation()`, and `removeHighlight()`. Tapping newly created highlights now hits the fast-path immediately (<16ms) without falling back to DOM traversals or swallowing tap events. Added 300ms event deduplication across `pointerup`, `touchend`, and `click`.
- **CLI top-level help and version routing** — Fixed argument inspection in `maybe_dispatch` so running `theorem --help`, `theorem -h`, `theorem --version`, or `theorem -V` executes directly in the terminal instead of launching the GUI window.

### Improved & Performance

- **Bundle code-splitting & footprint** — Extracted `lucide-react` and `@sentry` into dedicated vendor chunks via `manualChunks`, reducing the main frontend bundle from 553 kB to 282 kB (~50% reduction) and eliminating Vite chunk size warnings.
- **Dynamic import optimization** — Converted `html-to-image` in `ShareCardModal` to load dynamically on demand, removing the `[INEFFECTIVE_DYNAMIC_IMPORT]` bundler warning.

## [1.4.0] - 2026-09-07

### Added

- **Neural Voice (Supertonic 3, desktop)** — Full offline fp32 neural TTS. The fp32 ONNX models, voice styles, and the ONNX Runtime dylib (~400MB) are downloaded on first use from the `supertonic-assets` GitHub releases with SHA-256 verification — nothing ships in the app. Rust inference via `ort` (`load-dynamic`) with sentence-aware chunking, a 1GB content-hash WAV cache, and next-chunk prefetch. Ten voices (F1–M5), 31 languages, speed control. Playback runs through native Rust audio (`rodio`/`cpal`) with real pause/resume/seek. Managed in Settings → General → Neural Voice.
- **Companion Audiobooks** — Attach a DRM-free `.m4b`/`.m4a`/`.mp3` to any book from its context menu; the reader's immersion mode upgrades into a human-narrated player (scrubber over the real duration, ±15s skips, speed chips, chapter menu, sleep timer, lock-screen media controls, synced playback position). Chapters, duration and cover are parsed natively in Rust (including a QuickTime chapter-track walker for M4B).
- **Save as Audiobook (desktop)** — Generate a complete audiobook from an open book with the neural voice: one click narrates every section and encodes a single Ogg Opus file (~16MB/hour at 36kbps mono) with chapter marks, then attaches it to the book. Background task with progress and cancel.
- **Headless CLI & TUI** — `theorem <command>` gives agents and terminals full app parity: library, shelves, search, read, dict, extract, annotations, bookmarks, RSS, OPDS, sync, storage, stats, export, and open. JSON output (`--json`) for scripting, TTY-aware colored output with the THEOREM logo, and an interactive ratatui TUI (`theorem tui`). Enable/disable from Settings → General with startup auto-heal.
- **Native Memory-Mapped StarDict & MDict Engine** — Native Rust StarDict and MDict `.mdx` parsers with `memmap2`, decompressing 64KB zlib blocks on demand with sub-millisecond lookup latency (<0.5ms) and instant offline fallback.
- **Android TTS engine selection** — Enumerate and switch system TTS engines from Settings (fixing silent engine-switch failures), with real word-boundary events for the immersion reader and `synthesizeToFile` support. Neural narration on Android uses the installable Theorem Neural Voice companion engine app.
- **Build stamp** — Settings → About shows the git hash and source commit date the binary was built from, making a stale locally built release binary visible at a glance.

### Improved

- **Organization migration to Fundaments-Work** — Migrated all external repository links, releases, Supertonic asset downloads, StarDict dictionaries, and companion engine APKs to `fundaments-work`.
- **Desktop launcher resolution** — Prevented debug or unbundled binaries from shadowing the standalone production AppImage on desktop.
- **P2P sync** — Remote doc entries are batched into single IPC events for faster sync; deletion tombstones older than 90 days are pruned at startup.
- **Android footprint** — Panic=abort, `opt-level=z`, cmap pruning, and locale filtering reduce APK size.
- **Reader immersion player** — Replaced the estimated completion timer with real audio playback when the neural voice is installed; Android pause/resume now resumes from the engine's actual word position.
- **Desktop neural narration streaming** — Playback position and seek now span the entire streamed page; queue underruns while later chunks synthesize no longer stall playback or jump the scrubber; the next page's first chunks are synthesized in the background while the current page reads.

### Fixed

- **MOBI text extraction** — Added native HUFF/CDIC (Huffman) decompression for compression-type-2 MOBI files, and corrected the PalmDOC LZ77 distance layout (11-bit, was misread as 9-bit) so compressed MOBI books extract clean text instead of garbled fragments. Books that mislabel themselves as compression 2 without HUFF/CDIC records fall back to PalmDOC decoding.

## [1.3.0] - 2026-08-30

### Added

- **Theorem Lens (In-Place Footnote & Citation Peek Portals)** — Tapping footnotes,
  citations, `<aside>` blocks, and bibliographic references now displays a dynamic,
  anchored popover balloon right above or below the link. Allows reading notes,
  inspecting formulas, and copying text without losing reading position or jumping
  to the back of the book.
- **Companion Audiobook & Immersion Integration Plan** — Added full architectural
  specification and GitHub issue template for attaching DRM-free `.m4b`/`.mp3` audio tracks
  to books with native variable-speed playback, sleep timers, and Iroh P2P sync.
- **Comprehensive Project Documentation & Strategy** — Added `docs/discover.md`,
  `docs/COMPETITIVE_STRATEGY_BLUEPRINT.md`, and synchronized all feature guides with
  the latest codebase implementation.

### Fixed & Performance

- **PDF Navigation Synchronization & Smooth Scroll** — Resolved previous-page
  navigation stalls in continuous scroll mode by deferring DOM scrolling until target
  page wrappers are mounted, and pre-loading adjacent pages (`page - 1`, `page + 1`)
  in single-page mode for instantaneous (0ms) page transitions.
- **PDF Single-Page Auto-Fit & Centering** — Switched to `m-auto` layout on page wrappers
  to prevent CSS flex clipping and automatically applied `page-fit` zoom when switching
  to single-page presentation mode.
- **PDF Engine Memory Reclamation & Disposal** — Ensured `loadingTask.destroy()` is
  invoked on document unmount, deallocated canvas pixel buffers (`width = 0; height = 0;`),
  cleared text layers, and triggered `sqliteShrinkMemory()` on reader close.
- **PDF Presentation Mode Persistence** — Added `presentationMode` (`scroll` vs `paged`)
  to `PdfViewState` in SQLite and Zod sync schemas, persisting per-book display settings.
- **Universal Route Error Boundary Layout** — Standardized error handling layout and
  typography across all app views.

## [1.2.1] - 2026-08-29

### Added

- **Discover Editorial Storefront & 75,000+ Global Catalog Search (#59)** —
  Browse and download books directly into your Theorem library with 1-click import.
  Features curated editorial sections (Timeless Essentials, Restored Editions via
  Standard Ebooks, Philosophy & Thought, Classic Fiction), live debounced global
  search across 75,000+ public domain classics, `@tanstack/react-virtual` DOM
  virtualization, and support for custom self-hosted OPDS 1.2 feeds (Calibre, Kavita,
  Komga).
- **Theorem Clothbound Cover Engine** — Deterministic typography and 7 refined
  clothbound bookcloth color palettes (`crimson`, `obsidian`, `navy`, `forest`,
  `ochre`, `slate`, `plum`) with double hairline rules for books missing bundled
  artwork.
- **In-Place Footnote & Citation Popovers** — Tapping footnotes, citations, and
  noteref links now reveals a non-disruptive, elegant popover overlay with rendered
  HTML, copy action, and an optional jump button, without losing your reading location.
- **Native Brand Splash Screen** — Instant 0ms first-frame splash screen featuring
  the Theorem Q.E.D. emblem directly rendered by the webview on boot, seamlessly
  fading out once storage hydration completes.

### Fixed & Performance

- **Adaptive SQLite Memory & Pool Optimization (#58)** — Configured platform-aware
  database pools and memory limits (2 connections and 32MB mmap on Android; 4 connections
  and 256MB mmap on Desktop) along with an automatic background `visibilitychange`
  listener executing `PRAGMA shrink_memory;` when Theorem is minimized or tabbed away.
- **Mobile Navigation & Hardware Back Button** — Resolved Android back button
  history stack desynchronization by removing synthetic sentinels, implementing
  clean LIFO state preservation in `src/App.tsx`, and adding automatic back-button
  dismissal to all modals and dialogs.
- **Reader Titlebar Status & Progress** — Placed a dedicated reading progress and
  chapter indicator centered in desktop titlebars, and ensured page/chapter status
  is always clearly visible on mobile screens.
- **PDF.js GPU Memory Deallocation** — Reset canvas dimensions (`width = 1, height = 1`)
  and released `ImageBitmap` references on page unmount to eliminate GPU backing store
  retention during rapid scrolling.
- **Mobile Performance & IPC Optimization** — Completely eliminated mobile lag and
  UI stutter on Android by configuring `tauri_plugin_log` to use `Stdout` only,
  preventing hundreds of background IPC log events from flooding the Android JNI
  bridge and starving the JavaScript thread.
- **Reader Re-render Elimination** — Memoized reader history callbacks and decoupled
  render hooks in `ReaderViewport` to prevent infinite re-render loops on page turns.

## [1.2.0] - 2026-08-29

### Added

- **Library "Unshelved" filter** — Added an "Unshelved" quick filter option to
  both desktop and mobile library filter menus to easily find books that are not
  assigned to any shelf or collection.
- **Google Play Books-style jump navigation** — Following links, citations,
  footnotes, TOC chapters, or bookmarks now features location undo/redo controls
  (`<Undo2 />` / `<Redo2 />`) directly in the top titlebar when controls are
  revealed, along with `Alt+Left` / `Alt+Right` keyboard shortcuts. The reading
  viewport remains 100% clean and distraction-free with zero floating badges.

### Fixed

- **Centralized back navigation & mobile gestures** — Fixed the Android hardware
  and gesture back button navigation via a centralized LIFO handler stack.
  Back actions cleanly dismiss open modals and overlays, step back through
  reading jumps, and exit back to the library or OS at the root.
- **Reader Titlebar Back Button** — Clicking the top-left back button in the
  reader titlebar now directly flushes progress and returns to the Library
  instead of stepping backward through previous page turns.
- **Desktop blank page on TOC / menu navigation** — Fixed an issue in the Foliate
  paginator runtime where navigating to a chapter from the Table of Contents or
  menu on desktop landed on a blank padding page (page 0), requiring a manual page
  turn before text rendered. Paged navigation now anchors directly to content
  page $\ge 1$.
- **Shelves responsive grid alignment** — Synchronized Shelves and Shelf Detail
  column calculations and CSS responsive grid breakpoints with the Library page
  (`2xl:grid-cols-8`, `xl:grid-cols-7`, `lg:grid-cols-5`, `md:grid-cols-4`,
  `sm:grid-cols-3`, `grid-cols-2`), unifying view mode preferences and fixing
  grid collapsing to 2 columns on search.
- **Startup diagnostics & logging** — Added explicit startup lifecycle
  breadcrumbs and structured file logging targets to aid troubleshooting early exits.
- **Yearly Book Goal undercounted** — The yearly goal showed far fewer books
  than were actually completed because the counter was only incremented on the
  reader's auto-completion path; books marked "Finish" manually (library
  context menu, batch bar, shelves) or completed earlier/synced-in were never
  counted. The yearly count is now derived from the library itself (books with
  a `completedAt` in the current year), so it is always accurate and can't
  drift. Applied to the Statistics "Yearly Book Goal" bar, the page subtext,
  and the Share Stats card.
- **Metadata edits did not sync** — After editing a book's info, the changes
  did not propagate to devices that already had the book. The peer merge kept
  its own (old) values for description, publisher, language, ISBN, published
  date, and category (`match.X || inc.X`), and title/author only adopted
  longer values. The merge now adopts the incoming metadata, so edits made
  after an initial sync reach other devices.
- **Cover edits did not sync** — Changing or removing a cover showed only on
  the editing device. `data:` cover paths were stripped from the sync payload
  (and `coverBlobHash` was never used to transfer the bytes), so peers kept
  the old cover. Covers (already downsampled to ≤200×300 webp) are now
  serialized into the book payload, and the merge adopts an incoming `data:`
  cover, so cover changes propagate.

### Changed

- **Settings "Current Progress" removed** — The Yearly Book Goal progress bar
  in Settings duplicated the Statistics page, so it was removed to avoid
  confusion.
- **Settings storage now shows only downloaded books** — The Books row in
  Data & Storage previously summed `fileSize` over the whole synced library
  (including books synced from another device whose files aren't stored
  locally) and showed the total book count. It now shows only the books
  actually downloaded to the device and their on-disk size, with a note for
  any sync-only books that aren't downloaded yet. The Library page continues
  to show the total library count.
- **Statistics "Books Completed" no longer shows a fake target** — The bar
  previously implied a goal by rendering `26 / 31` where the `/31` was just
  "completed + 5", not a real goal. It now renders as a plain count.

## [1.1.0] - 2026-08-18

### Added

- **Book export** — Right-click a book (or select several and use the batch
  Export action) to copy the original file out of the app:
  - Desktop: native save dialog via `@tauri-apps/plugin-dialog` + `writeFile`.
  - Android: a new `save_file_mobile` command writes to the system Downloads
    folder (``Download/Theorem``) through the mobile-folder-scan plugin's
    MediaStore `saveFile` method.
  - Browser/web: `<a download>` fallback when Tauri is unavailable.
  - Books synced from another device are fetched on demand from a paired peer
    first, with a clear message when none is available.
  - Results surface as a toast notification (`sonner`) instead of an alert.
- **Edit Book Info** — A full metadata editor that replaces the old
  title-only rename. Access it from the book's context menu ("Edit Info") or
  the new Edit button in Book Info. Editable fields: title, author,
  description, publisher, published date, language, ISBN, category, tags, and
  rating.
- **Cover editing** — Change or remove a book's cover from the same Edit modal
  via device image picker or a fetch-from-URL field, with an instant preview.
  Changes are written into EPUB files as well as the library (see below).
- **EPUB metadata/cover write-back** — New `rewrite_epub_metadata` Rust
  command updates the OPF `<metadata>` dc: fields and replaces or embeds the
  cover image (manifest + cover meta updated) directly in the stored `.book`
  file. Encrypted EPUBs are rejected; the browser gets a best-effort fflate
  fallback (`epub-write-browser.ts`) that keeps the `mimetype` entry stored
  uncompressed. Edits are saved in-app even when file write-back fails (e.g.
  a synced book not yet downloaded).
- **Back to previous reading location** — Clicking a citation or footnote and
  the mobile back gesture/hardware back now returns you to the page you were
  on before following the link:
  - Browser back gesture and Android hardware back step through foliate's
    built-in location history (panels/color picker are closed first).
  - Desktop shortcut `Alt+Left` / `Alt+Right` (previous/next location).
  - EPUB only; PDF has no location history and is unaffected.
- **Workbench remembers your last card** — The card view (and the active
  filter, sort, and list/cards toggle) is remembered per session in
  `sessionStorage` (`theorem-workbench:view-state`). Navigate away and back
  and you land on the exact card you were reading, resolved by annotation id
  so resorting or filtering doesn't lose your place.

### Fixed

- **Edit Book Info modal could not scroll** — The modal's `<form>` wrapper
  broke the flex layout, so the body never shrank and the footer (Save
  button) was clipped below the 90vh viewport limit on smaller screens. The
  form is now a flex column so `ModalBody` scrolls and Save stays visible.
- **Rust unit tests for EPUB parsing** — Two `epub_parser` fixtures used a
  truncated `<package xmlns="http:...">` namespace URI (introduced by an
  overly aggressive comment-strip pass), which made `test_locate_toc_sources`
  and `test_read_epub_metadata_full` fail. The fixture tag was repaired; the
  full Rust test suite is green again.

## [1.0.10] - 2026-08-07

### Added

- **Success icon for sync notifications** — A green-check notification icon is
  bundled as a Tauri resource and shown for "Sync Complete" OS notifications.
  Sync errors still use the default app icon, so a completed sync no longer
  looks like an alert.

### Fixed

- **Shelves page could not scroll to the last book** — The shelf detail grid
  used a hardcoded `calc(100vh - 12rem)` height plus `content-visibility: auto`
  inside a non-flex ancestor, so `flex-1 min-h-0` was inert and the final
  virtualized rows were unreachable. Replaced it with the Library page's flex
  height chain (`h-full flex flex-col` → `flex min-h-0 flex-1 flex-col`) and
  dropped the `content-visibility` class from the scroll container.
- **Reading time undercounted (≈half)** — Every visibility hide flushed with
  `Math.floor()` and discarded the sub-minute remainder, then the start clock
  reset on show, so a ~30 minute session could record ~15. The tracker now
  accumulates milliseconds and carries the remainder across hide/show/pause/
  resume/unmount; the unmount flush also writes to `stats` (total, daily
  activity, streak) instead of only the per-book time. Stats are read fresh
  from the store during flushes to avoid stale lost updates.
- **Weekly digest showed 60× too much time** — The Statistics "This Week" card
  rendered `formatReadingTime(weekMinutes * 60)`, turning minutes into hours.
- **Excessive sync notifications** — `docs-sync-finished` fires on every iroh
  round, so every auto-sync (2-min interval, startup, tab refocus, peer
  online, mutation flush, doc re-import) posted an OS notification. Sync
  notifications are now sent only for manually triggered syncs (Quick Sync in
  the titlebar, Sync Now in Settings). Auto-sync feedback stays in the
  in-app status pill.
- **Sync lifecycle hardening** — `docs_api` is cleared on engine stop and
  accept-loop exit, and a generation counter guards liveness checks so callers
  fail fast against a stale snapshot instead of blocking on a dead engine
  (`0535dc2`, `75be052`).
- **Sync engine startup races** — The accept loop now initializes the docs
  engine even with zero paired devices (fixing first-time pairing timeouts);
  old accept-loop shutdown is awaited before a fresh loop spawns; pairing
  spawn paths are serialized under a lock and endpoint TOCTOU removed; and
  snapshot polling uses `tokio::time::sleep` instead of blocking a worker
  thread (`6f1be37`, `cebcf6c`, `5ab1fc1`, `abc04dd`).
- **Sync 100MB wipe + deadlocks** — The docs size-cap wipe now stops and
  awaits the engine before deleting files; recovery paths release
  `paired_devices` before awaiting `docs_api` (lock-order inversion); and the
  pairing readiness poll requires the snapshot generation to match the current
  accept loop (`e22befc`, `574d4b4`).
- **Sync lost data on provision skip** — Manual "Sync Now" with auto-sync
  disabled skipped provisioning entirely (the gate relied on `_dataDirty`,
  which is never set when auto-sync is off), silently never pushing local
  changes. The gate now skips only for structural reasons; a per-key cache
  still avoids rewriting unchanged data (`a1bf94f`).
- **Sync write errors swallowed** — `docs_set_entry` returned success even
  when every per-doc write failed, silently dropping user data. It now returns
  the first failure and logs each one so the frontend can retry (`48d6899`).

### Changed

- **Sync provisioning trimmed** — Rounds now provision only books/domains
  whose serialized value actually changed (or after a forced re-provision),
  instead of rewriting the whole library (~1008 IPC writes per round for a
  1000-book library). Content polling in `docs_get_all_entries` no longer
  waits up to 400ms per missing blob (`cfd1364`, `b2a1088`).

## [1.0.9] - 2026-07-25

### Added

- **Reading Goal Notifications** — Three-tier notification system:
  - Real-time goal-met detection: OS notification + in-app toast when you hit your daily reading goal
  - Session-end reminder: notifies when you close a reading session short of your goal
  - Scheduled daily reminder: periodic Rust-side check at your configured reminder time
- **Sync Completion Notifications** — OS notification on sync finish or error (toggleable in Settings)
- **Notification Settings UI** — Goal Notifications toggle, Daily Reminder Time picker, Sync Notifications toggle
- **Rust command `sqlite_check_goal_reminder`** — Reads today's reading stats from SQLite for the reminder timer
- **Proactive notification permission request** — Calls `requestNotificationPermission()` on app startup so the OS prompt appears immediately instead of waiting for the first lazy notification call
- **QR scan cancel toast** — Shows a sonner toast when the native QR scanner is dismissed, instead of silently swallowing the cancel

### Fixed

- **Reader scroll mode blank screen on switch** — When switching from paged to scroll mode, the `overflow: hidden` from `columnize()` persisted on the iframe `<html>` element, clipping content to the viewport. `scrolled()` now sets `overflow: visible`. Additionally, the `transform: translateX/Y()` that `#setViewPosition()` applied during paginated mode was never cleared — the view element stayed positioned off-screen. `Paginator.render()` now resets the transform when entering scroll mode.
- **Notifications never triggered** — `notifyIfGranted()` callers existed in `useReadingTime.ts`, `useDailyGoalReminder.ts`, and `sync-orchestrator.ts`, but `requestNotificationPermission()` was never called, so the OS permission prompt never appeared on Android 13+ or desktop.

### Changed

- **`annotations.find()` → O(1) Map lookups** — Reader hot paths (highlight tap, note save, bookmark toggle) now use `useMemo`'d `Map<string, Annotation>` lookups instead of linear array scans. The foliate engine also gained a `annotationLocations` Map for O(1) highlight-click detection.
- **Onboarding flow text updated** — Steps 3-5 now mention TTS immersion reading, speed-reading, reading status filter, P2P LAN sync alongside markdown export. `docs/onboarding.md` rewritten to match the actual component.

## [1.0.8] - 2026-07-20

### Added

- **Tauri plugins (5)** — Logging (structured file+webview), native OS notifications,
  window state persistence, global shortcuts (Ctrl+Shift+F → Library,
  Ctrl+Shift+R → Feeds), in-app updater.
- **Check for Updates** — Settings → About tab has a "Check for Updates" button
  that queries GitHub releases. Shows version info, installs & prompts restart.
- **Issue templates** — Bug report and feature request forms at
  `.github/ISSUE_TEMPLATE/`.
- **Signing keys guide** — `docs/SIGNING-KEYS.md` documents Tauri Updater (Ed25519)
  and Android APK (JKS) key setup, GitHub Secrets integration, and release workflow.

### Fixed

- **Vocabulary sync broken by Zod enum** — `VocabularyTermSchema.providerHistory`
  only allowed `"stardict"`, but terms created via the free dictionary API had
  `"free-dictionary-api"`. Sync validation silently rejected the entire vocabulary
  domain when any term had the missing enum value. Added
  `"free-dictionary-api"` to the enum.
- **Repo URLs outdated** — All `sapienskid/theorem` and `sapienskid/wiktionary-stardict`
  references updated to `fundaments-work/Theorem` and
  `fundaments-work/wiktionary-stardict` across all source files.
- **Tests outdated** — Two release tests fixed: spinner CSS moved from inline
  HTML to `src/index.css`, and settle threshold changed from `>= 3` to `>= 2`.

### Changed

- **CI auto-publishes updater artifacts** — `release.yml` now passes
  `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to all
  `tauri-action` steps. `createUpdaterArtifacts: true` enables automatic
  `latest.json` generation.

## [1.0.7] - 2026-07-19

### Fixed

- **Production Tauri: book shows "1-2 lines and white"** — Two interrelated fixes:

  **1. Invalid iframe sandbox flag** — The reader iframe had `allow-clipboard-write` in the `sandbox` attribute, which is not a valid sandbox token (it's a Permissions-Policy directive). WebKitGTK (Tauri's production WebView on Linux) rejects the entire sandbox attribute when it encounters an invalid flag, dropping the iframe into maximum sandboxing. This broke foliate-js page-positioning logic that relies on `allow-same-origin` to read iframe content dimensions and set up CSS columns. Reverted to `allow-same-origin allow-scripts`.

  **2. CSP `'unsafe-inline'` ignored due to Tauri style nonce injection** — An inline `<style>` tag in `index.html` (loading spinner, added in v1.0.7) triggered Tauri's CSP processing pipeline: the build system injects `__TAURI_STYLE_NONCE__` into `<style>` elements, and at runtime replaces it with a real nonce + adds `'nonce-xxx'` to `style-src`. Per CSP spec, when a nonce source is present in a directive, `'unsafe-inline'` is ignored — so all dynamic inline styles (including foliate-js's `<style>` elements inside the reader iframe that set column-width, height, padding) were blocked. The loading spinner CSS is now in `src/index.css` (loaded via `<link>` from `'self'`), eliminating the inline `<style>` element and keeping `'unsafe-inline'` intact.

  **3. Tauri IPC blocked by CSP** — The CSP `connect-src` was missing `ipc:` and `http://ipc.localhost`, causing Tauri's custom IPC protocol to fail and fall back to postMessage. Added `ipc: http://ipc.localhost` to `connect-src`.

- **Production builds must not ship with devtools** — Removed `devtools` feature flag from `tauri` dependency in `Cargo.toml`.

### Added

- **On-demand download progress** — Reader shows a real progress bar with file size (e.g., `12.5 MB / 45.3 MB (28%)`) instead of an indeterminate spinner when downloading synced books. Progress events emitted from Rust in 1MB chunks, throttled to percentage changes.
- **Memorized reader state** — Reader now persists `downloadingBookId` and `downloadProgress` across renders. "Try Again" button on all error screens.

### Changed

- **File transfer: streaming writes with no IPC** — `download_book_file` writes received data directly to `book-cache/{id}.book` from Rust in 1MB chunks. Zero bytes pass through the Tauri IPC bridge. Previously, the entire file was returned via IPC as JSON `number[]`, causing 360MB+ allocations that crashed Android with OOM (heap limit 256MB).
- **File transfer: 120s timeouts** — All I/O operations (connect, open_bi, read_line, read_exact) now have 120s timeouts. Previously, `request_book_file` could hang indefinitely on unreachable peers.
- **File transfer: SQLite fallback** — `FileTransferHandler` falls back to reading from SQLite `books` table when the file is not in `book-cache`. Previously only served from `book-cache`, meaning locally-imported books (stored in SQLite) were unavailable to peers.
- **Sync: gossip-based bidirectional auto-sync** — `NeighborUp` events now properly trigger `runDeviceSync` on the peer via `docs-peer-online`. The `iroh_node_id` field was missing from `PairedDeviceInfo`, making the peer-matching `d.irohNodeId === nodeId` always fail. Auto-sync when a peer comes online was completely dead.
- **Sync: settle threshold fixed** — `signalSettle()` checks `>= 2` instead of `>= 3`. Only 2 events (`docs-pending-content-ready` + `docs-sync-finished`) ever call signalSettle, so the threshold of 3 was never reached — every sync round waited the full 30s timeout.
- **Sync: event subscription on doc recovery** — `subscribe_doc_events` is now called after re-importing a sync doc from ticket in `docs_sync_now`. Previously, doc subscriptions were lost during recovery, causing no live events to flow.
- **Sync: `_bridgePaused` guard for all stores** — Vocabulary, RSS, and settings store subscriptions now check `_bridgePaused` during provisioning, preventing writes during initial data sync.
- **Reader: shortcuts useEffect moved before early returns** — The keyboard shortcuts registration useEffect is now called before all early-return guards (downloading, error, syncedWithoutFile). Previously, the shortcuts useEffect was duplicated — one copy before and one after the early returns — causing "Rendered more hooks than during the previous render" errors when transitioning from the download screen to the reader.
- **Reader: polling loop timeout** — The `while (syncedWithoutFile)` polling loop now has a 120-second timeout. Previously it hung forever if the download failed.
- **Annotations page: fully responsive card view** — Touch swipe navigation, icon-based mobile toolbars, clipped dot indicators, `touch-manipulation` on all interactive elements.

### Performance

- **Memory: eliminate unnecessary Blob copy** — When the MIME type already matches, use the blob directly instead of `new Blob([blob], type)`, which duplicated the entire book in JS memory. Saves one full copy (50-100MB for large EPUBs).
- **Memory: call EPUB.destroy() on engine teardown** — `FoliateEngine.destroy()` now calls `EPUB.destroy()`, which revokes all blob URLs created for sections, CSS, images, and fonts. Previously, blob URLs accumulated until page refresh.
- **Memory: unload previous fixed-layout spreads** — `goToSpread()` now calls `unload()` on the previous spread's sections. Fixed-layout books (children's books, comics) were leaking all visited spreads' blob URLs.
- **Memory: cover extraction early-return before file re-read** — The `hasRealCover && coverExtractionDone` check now runs BEFORE `getBookData()`, avoiding a full re-read of the book from storage when cover is already extracted.
- **Memory: metadata-only EPUB prefetch** — Rust `prefetch_zip_metadata` no longer pre-decodes all EPUB section HTML files (up to 100 sections, ~3-6MB of JS strings). Only metadata files (container.xml, OPF, NAV, NCX, encryption) are prefetched. Sections load lazily via zip.js.
- **Binary size: removed unused Rust dependencies** — `read_zip_entry` wrapper removed after section prefetch elimination.

### Fixed (Android)

- **ndk_context restore** — Re-added JNI `initNdkContext` and `ndk-context` dependency. iroh's `netwatch` → `netdev` → `ndk_context::android_context()` panics if the Android JVM/context are not initialized before any iroh networking operations run. Without this, the app crashed on Android 15 at startup.
- **ndk_context init after super.onCreate** — `initNdkContext(applicationContext)` moved after `super.onCreate()` to ensure `applicationContext` is non-null when the JNI call fires.
- **CBR/RAR desktop-only** — `unrar-ng` (bundled UnRAR C++ source) uses `lutimes()` which was removed from Android's bionic libc in NDK 28. CBR conversion works on desktop; Android returns a clear "not supported" error to avoid compilation failure.
- **accept loop gate** — When no paired devices exist, the accept loop registers only pairing + file_transfer handlers, skipping gossip/docs creation. This prevents the `ndk_context::android_context()` panic on fresh Android installs with no paired devices.
- **Top-bar single-device sync** — Sync button now syncs only the first paired device instead of iterating all, preventing sequential timeouts on offline peers.
- **Mobile safe-area padding** — All pages (Settings, Statistics, Bookmarks, Annotations, Feeds, Vocabulary, Shelves) now use `pb-[calc(var(--spacing-2xl)+env(safe-area-inset-bottom))]` to clear the bottom navigation on notched devices.

### Fixed (Sync)

- **Duplicate pairing by iroh_node_id** — The dedup check only matched by `fingerprint`, which is empty on Android (and often empty on desktop). Added `iroh_node_id`-based dedup in both `handle_pair_req` and `submit_pairing_code`.
- **Frontend duplicate device list** — `DeviceSync.tsx` filtered by `deviceId` before appending, preventing duplicate entries in the local React state.

### Fixed (General)

- **Stuck "Downloading Book" screen** — Added 120s timeout, clears `downloadingBookId` on timeout, shows "Book download timed out" error with retry.
- **Broken reader state after download failure** — New guard renders "Book File Not Available" screen when `syncedWithoutFile` is true but not currently downloading, instead of showing a broken reader view.
- **"Rendered more hooks than during the previous render"** — Removed duplicate shortcuts useEffect that was left after the move. When transitioning from "Downloading" screen (early return fired, 1 shortcuts hook) to reader (no early return, 2 shortcuts hooks), React detected the mismatch and threw.

## [1.0.6] - 2026-07-06

### Added

- **Keyboard shortcuts** (global + reader-scoped) — `Ctrl+1`–`7` navigate between pages, `Ctrl+,` for Settings, `Ctrl+F` for search, `Ctrl+B` for sidebar toggle, `?` for shortcuts help. Reader shortcuts: `Ctrl+D` bookmark, `Ctrl+T` TOC, `Ctrl+S` settings, `Ctrl+A` annotations, `F11` fullscreen. Shortcuts reference available in Settings → Shortcuts tab.
- **Auto-advance immersion reading** — When TTS finishes reading a page in immersion mode, it automatically turns to the next page and starts speaking. Chains continuously until the book ends or the user stops playback.
- **Bookmarks page redesign** — Bookmarks now match the AnnotationCard design language with proper borders, MoreVertical dropdown menu, and serif blockquote styling.
- **PDF paged navigation mode** — Scroll-snap based paged mode for PDFs (engine support maintained, UI toggle deferred).

### Changed

- **TTS: removed Kokoro/ONNX neural engine** (~52 MB binary saved) — Replaced with native OS speech: `android.speech.tts.TextToSpeech` on Android, `say`/NSSpeechSynthesizer on macOS, `spd-say`/`espeak-ng` on Linux, PowerShell/SAPI on Windows. Zero Rust dependencies, zero model download. Audio now starts instantly — no model warmup delay.
- **TTS: real pause/resume** — Pause now stops at the estimated word position (158 wpm audiobook rate, self-calibrating). Resume continues from where speech was paused, not the beginning of the section.
- **TTS: disabled on web** — Web Speech API support was janky. TTS is now Tauri-only (Android + desktop). Settings show "Not available in web browser" on web.
- **Sync: event-driven, not timer-based** — Sync now uses dirty-tracking across all three layers (JS orchestrator, Rust background loop, sync daemon). Mutation-triggered sync fires within seconds; periodic syncs become no-ops when nothing changed. The Rust 5-minute loop checks a data version counter and only initiates sync when data actually changed.
- **Sync: autoSyncEnabled toggle respected** — The Rust background sync loop now stops when auto-sync is turned off. Previously it ran regardless of the toggle setting.
- **Sync: Android WorkManager data loss fixed** — The JNI standalone sync round (WorkManager) now persists incoming peer data to `sync-incoming-cache.json` before its ephemeral runtime exits. On next app boot, `get_incoming_sync_data` loads and merges this cache.
- **Bookmarks page** redesigned to match AnnotationCard design language.

### Fixed

- **RSS duplicate subscriptions** — `useRssStore.addFeed` and `refreshFeed` now normalize feed and article URLs (lowercase + trailing-slash strip) before comparison.
- **RSS remove feed UX** — Replaced dropdown action menu with direct hover-triggered trash button.
- **RSS duplicate images** — Article card summaries now hide inline `<img>` and `<figure>` elements to prevent duplicate image display.
- **Shelf search and context menus** — ShelfDetail uses shared `MemoizedBookCard`, `BookInfoModal`, and context menu. Bulk "Add to Shelf" fixed.
- **Android TTS crash** — `TextToSpeech` constructor must run on UI thread. All TTS operations now go through `Handler(Looper.getMainLooper()).post()`.
- **TTS reads wrong page** — `getVisibleTextForTts()` was returning entire section text instead of visible portion. Fixed to use `visibleRange.cloneContents()`.
- **Settings page re-render** — Extracted `StorageTab` as memo component, removed heavy subscriptions from parent.
- **Reader remount on navigation** — Removed `key={currentRoute}` from `RouteErrorBoundary` that forced full remount on every route change.

### Performance

- **Binary size: ~83 MB → ~28 MB** — Removed Kokoro/ONNX TTS stack (52 MB). Added `panic = "abort"`, `strip = "symbols"`. Removed 12 TTS crates, 3 Rust source files.
- **Event-driven sync** — All three sync layers use dirty-tracking. No more wasted manifest builds + SHA-256 hashing + HTTP round-trips when data unchanged. Mutation-triggered sync debounces to 5 seconds.
- **Virtual scrolling** (all list pages) — Library, Shelves, Annotations, Bookmarks, Vocabulary now use `@tanstack/react-virtual` with padding-based approach. DOM node count reduced by 85-98% for large collections. Overscan: 3 rows.
- **Background cover hydration** — `coversHydrated=true` set immediately on rehydrate. Covers hydrate incrementally in batches of 48, unblocking the UI.
- **WebP cover downsampling** — Covers resized to 200px, saved as WebP (quality 0.75), decoded asynchronously.
- **LRU-capped caches** — coverCache=100, thumbnailCache=200, materializedPathCache=500, blobCache=3. Persist storage skips values >500KB.
- **PDF zoom rescaling** — ImageBitmap cache for GPU-scaled instant zoom feedback. DOM window = canvas window + 4 pages. Search capped at 500 pages.
- **Barrel import elimination** — All imports now use direct module paths instead of `src/core/index.ts`, enabling tree-shaking.
- **Zustand selector anti-patterns** — Individual selectors instead of destructuring in ContextMenu, ReaderBookmarks, and other hot-path components.
- **Shared context menu portal** — Single global `ContextMenuRoot` replaces per-card portals.
- **Fuse index caching** — `WeakMap<Book[], Fuse>` caches search index. Debounced search (250ms).
- **Navigation fix** — Removed `key={currentRoute}` from RouteErrorBoundary (prevented full remount on route change).
- **DailyActivity pruning** — Capped to 365 days on rehydrate (was unbounded).
- **DeletionTombstone GC** — Garbage-collected on store rehydrate (was only during sync).

## [1.0.5] - 2026-07-03

### Added

- **RSS feed Markdown rendering** — Articles that include Markdown-formatted content (headings, bold, italic, links, lists, code blocks, etc.) are now converted to styled HTML at render time using `markdown-it` (v14). Both the article reader view and the feed card abstract render Markdown properly. Conversion also runs during initial feed import and article extraction for forward storage.
- **RSS article deletion** — Articles can now be deleted individually from the feed list. Deletions propagate as sync tombstones so the removal syncs to paired devices.
- **RSS article right-click context menu** — Feed article cards now have a context menu with: Read Article, Open Original, Copy Link, Mark Read/Unread, and Delete Article. The inline delete button has been removed in favor of the context menu.
- **Library multi-select** — A new "Select" button in the library toolbar toggles batch selection mode with checkboxes on every book card. Once selected, a bottom action bar appears with bulk operations: Mark Read, Mark Unread, Add to Shelf, and Delete. BookCard click behavior switches to toggle selection when in select mode.

### Changed

- **Feed card summary rendering** — Article abstracts on the feed page now render as rich HTML (links, bold, italic) instead of stripped plain text, giving a proper content preview.

### Fixed

- **Sync manifest rejected by peer (403 Forbidden) after pairing** — The sync-daemon grabbed the fixed port (43935) before the Tauri app, forcing it to a random fallback port. The daemon only loaded `paired_devices` at startup and never refreshed them, so devices paired by the Tauri app were unknown to the daemon's server. Two fixes:
  - `decrypt_request` now reloads `sync-paired-devices.json` from disk when a device lookup misses in the in-memory HashMap, so both the daemon and Tauri app servers pick up newly paired devices immediately.
  - The sync-daemon's auto-sync loop reloads paired devices from disk before each round (every 120s), ensuring periodic refresh even without an incoming request trigger.
- **Paired scanner IP not recorded** — `handle_pair` previously saved `last_ip: ""` and `last_port: 0` for the scanner, preventing the host from initiating sync back to the scanner. Now captures the client's real IP via `axum::ConnectInfo` so the host can reach the scanner without waiting for the scanner to initiate first.
- **Install script** — `curl | bash` install now handles `BASH_SOURCE` being unbound when piped via stdin.

## [1.0.4] - 2026-07-03

### Added

- **Sync-daemon bundled as Tauri sidecar** — The `sync-daemon` binary is now built and bundled inside deb/rpm/AppImage packages. On startup, the app launches it as a child process for 24/7 background sync.
- **One-command Linux install** — `curl -fsSL https://raw.githubusercontent.com/fundaments-work/Theorem/main/scripts/install-linux.sh | bash` auto-detects the distro, downloads the latest release, installs the app, **extracts the sync-daemon**, and creates a **systemd user service** (`theorem-daemon.service`) for persistent background sync.
- **Systemd user service** — `theorem-daemon.service` runs the sync-daemon as a user service, auto-starts on login, and survives app restart/quit/reboot. Enable manually: `systemctl --user enable --now theorem-daemon`.
- **Android notification permission request** — On Android 13+, `POST_NOTIFICATIONS` is now properly requested before the foreground service starts. The system dialog appears when enabling sync, making the persistent notification visible.
- **Android ProGuard/R8 keep rules** — `proguard-rules.pro` now keeps all `work.fundamentals.theorem.syncworker.*` classes so R8 doesn't strip reflectively-called plugin methods in release builds.

### Changed

- **Build scripts** — `makepackage-linux.sh` builds the sync-daemon before `pnpm tauri build` so it's included in the bundle. `release.yml` CI does the same.
- **Install script overhaul** — `install-linux.sh` now downloads from GitHub, detects the distro (deb/rpm/AppImage), installs the app + daemon + systemd service in one command.

### Fixed

- **Android foreground notification not showing** — `SyncWorkerPlugin.startWorker()` now calls `requestPermissionForAliases("notifications")` on Android 13+ before starting the service. Previously it only checked and logged.
- **Android R8 stripping** — `consumerProguardFiles` now points to the existing `proguard-rules.pro` instead of the missing `consumer-rules.pro`. Includes `-keep class work.fundamentals.theorem.syncworker.** { *; }`.

## [1.0.3] - 2026-07-02

### Added

- **Android background sync daemon** — `sync-daemon` sidecar binary with embedded HTTP server for LAN sync. Runs as a foreground service (`connectedDevice` type) with persistent notification. WorkManager periodic sync every 15 minutes + battery optimization exemption. Survives task removal.
- **Android sync foreground service** — `SyncForegroundService.kt` manages the persistent notification and lifecycle. Auto-starts on app launch. Updates notification with sync status messages.
- **Android device identity** — Stable per-device ID generated on first launch, stored in app preferences. Used for sync pairing and authentication.
- **Sync daemon status in settings** — UI shows daemon running/stopped status, last sync time. Control API via HTTP on loopback.
- **Back arrow in article reader** — Dedicated floating back arrow below the mobile status bar with `safe-area-inset-top` support. Prevents stale article state from hijacking book opens.
- **RSS feed deletion sync** — Tombstone propagation ensures deleted feeds are removed on paired devices.
- **Colored sync status indicator** — Replaced rotating `animate-spin` icon with status dot: idle (grey), syncing (amber+pulse), synced (green), error (red). Last synced label moved to left of icon.
- **Page-turn animation on all navigations** — `#setViewPosition` now always animates in paginated mode (not just same-chapter turns). Touch drag stays instant via `animate=false`.

### Changed

- **TTS: native audio on desktop** — Completely removed Web Audio API for TTS playback. Desktop now uses `rodio` (Rust audio library) for gapless native audio output. Android uses raw `AudioTrack` via a custom Tauri plugin. Bypasses WebView audio entirely.
- **TTS: native audio on Android** — New `tauri-plugin-android-tts-audio` plugin writes PCM audio directly to Android `AudioTrack`. No more Web Audio API latency or autoplay restrictions.
- **TTS: increased chunk size** — First chunk 150 chars, subsequent chunks 500 chars (was 80/150). Reduces chunk boundaries by ~3-4×, eliminating audible fade-out dips between sentences.
- **TTS: removed Anti-Bite Detachment regex** — The phonemizer workaround is no longer needed; the `misaki-lean` bug fix appends a trailing `_` instead.
- **Sync/statistics buttons** — Now use `ui-icon-btn` class on desktop too, giving consistent visible `background: var(--color-surface)` with mobile.
- **Page-turn easing** — Changed from `cubic-bezier(0.22, 1, 0.36, 1)` (dual y=1.0 caused mid-turn plateau) to `cubic-bezier(0, 0, 0.58, 1)` (CSS ease-out, natural deceleration).
- **Reader toolbar** — Double-click on titlebar now toggles maximize/restore (standard desktop behavior).
- **Git ignore** — Explicit policy for generated Android project files, SDK files, build outputs.

### Fixed

- **TTS autoplay on word tap** — Removed the `.tts-word` click-to-play feature. Tapping any word no longer triggers `generate_speech` regardless of `ttsEnabled`.
- **TTS word doubling** — Removed `isContinuousMode` auto-play effect in ImmersionBar that raced with `handleTtsComplete`. Both called `generate_speech` for same text.
- **TTS continues after closing immersion bar** — `handleTtsComplete` now guards on `immersionMode`. Ref-based check prevents stale in-flight async calls.
- **TTS memory: audio buffers not freed on stop** — `desktop_audio::stop_audio()` changed from `player.stop()` (atomic flag, 1 chunk/5ms drain) to `player.clear()` (immediate queue drain + pause).
- **TTS memory: 3× IPC overhead per chunk** — Removed `audio_data` from `TtsChunk` IPC (48KB+ `Vec<f32>` serialized as JSON, never read by frontend). Added `duration_ms` on Rust side. Saves ~400KB per chunk.
- **TTS memory: stale closures in singleton** — `ImmersionPlayer.destroy()` now clears `this.callbacks`, preventing old React closures from being held indefinitely.
- **Immersion toggle causes page turn** — Removed `pb-16` padding transition on viewport container that resized the foliate paginator and triggered column recalculation.
- **3D page-flip animation broken CSS** — Restored missing closing brace on `#container` CSS rule (deleted when reverting the 3D flip). The unclosed rule merged `#container` with all subsequent selectors, causing broken layout that appeared as animation stutter.
- **Page-turn animation stutters mid-turn** — Settings sync (`applySettingsSync`) in `next()`/`prev()` called immediately after navigation, triggering renderer attribute changes (column count, flow) during the 0.3s CSS transition. Deferred via `setTimeout(350)` so it fires after the animation completes.
- **Broken column layout on multi-column desktop** — `next()`/`prev()` now call `applySettingsSync`/`Async` after navigation (deferred past transition) to ensure correct column count, inline-size, and flow mode.
- **Book stuck at "Loading..."** — Force new Blob reference in `loadBook` to trigger React re-render. Reset `loadedBookIdRef` on effect cleanup to prevent infinite loading.
- **TTS column layout misalignment** — Repeated layout sync and zoom application after navigation. Added chapter-boundary detection so re-renders only happen when needed.
- **Android: crash on Android 14** — `SystemForegroundService` missing `foregroundServiceType` in AndroidManifest. Crash when binding WorkManager notification.
- **Android: WorkManager JNI crash** — Fixed `Java_work_fundamentals_theorem_syncworker_SyncWorker_runBackgroundSync` native method naming.
- **Android: redundant companion object** — Merged duplicate `companion object` blocks in `SyncWorker.kt`.
- **Android: smart cast errors** — Fixed Kotlin smart cast on `networkCallback` in `NetworkCallback` registration/unregistration.
- **Android: WakeLock + notification permissions** — Added `WAKE_LOCK` and `POST_NOTIFICATIONS` permissions. Wrapped `acquireWakeLock` in try/catch.
- **Android: task removal kills sync** — Set `stopWithTask=false` and restart in `onTaskRemoved` to keep sync alive.
- **Android: notification importance** — Increased to `IMPORTANCE_LOW` for reliable display.
- **Sync: 503 race condition** — Prevents concurrent sync requests from causing HTTP 503 errors. Propagates RSS feed deletions as tombstones.
- **Sync: crashes on Android and desktop** — Eliminated multiple crash sources in sync orchestrator, crypto, and server.
- **RSS article reader back button** — Restored back navigation. Fixed stale article state hijacking book opens when switching between reader and feeds.
- **Rust compiler warnings** — All warnings eliminated for production builds.
- **3D page-flip shadow overlay** — Reverted `#flip-shadow` element, `perspective: 2000px` CSS, and Web Animations API 3-keyframe effect.

### Performance

- **Instant book opening** — Rust-native EPUB prefetch reads zip metadata in parallel with JS. Container.xml, OPF, nav, NCX, and ALL HTML section text are pre-decoded and cached. `loadText`/`getSize` calls skip `@zip.js/zip.js` entirely on the critical path. Book opening drops from ~1.5s to <50ms on desktop, <150ms on Android.
- **Eliminated barrel imports** — Every import now uses direct module paths instead of `src/core/index.ts`. Barrel re-exports prevented tree-shaking and bundled all stores/services together.
- **React.memo on heavy components** — Wrapped `BookCard`, `ReaderViewport`, `PDFJsEngine`, `Sidebar`, `BottomNav`, `AppTitlebar`.
- **Lazy-loaded heavy dependencies** — `soundtouchjs` (TTS), `pdfjs-dist`, `@mozilla/readability`, `fast-xml-parser`, `html-to-image` all use dynamic `import()`.
- **Zustand individual selectors** — All store consumers now use `useStore(s => s.x)` instead of destructuring `const { x } = useStore()`.
- **Layout reflow on same-section page turns** — Only triggers render when layout is genuinely broken (size === 0). Keybard navigation and page turns skip unnecessary columnization.

### Removed

- **Dead component** — Removed unused `ShareCard.tsx`.
- **Unused barrel files** — `article-reader/index.ts`, `components/index.ts`, `highlights/index.ts`, `progress/index.ts`.
- **Dead CSS classes** — `.epub-container`, `.epub-container iframe`, `.reader-screen`, `.theme-transition`, `.reader-container` from `index.css`.
- **Commented-out console.log** — 3 lines in `foliate-js-runtime/epub.js`.
- **Unused PDF.js vendor** — `foliate-js/vendor/pdfjs/` directory (~10.5MB, app uses `pdfjs-dist` npm package).
- **Vendored foliate-js** — Converted to git submodule pointing to `fundaments-work/foliate-js` fork.
  Fork stripped of `vendor/pdfjs/` (~10.5MB unused PDF.js build artifacts, app uses `pdfjs-dist` npm package).
  Nightly GitHub Action syncs upstream `johnfactotum/foliate-js` changes into the fork automatically.
  Clone with `git clone --recurse-submodules`.
- **TTS Anti-Bite Detachment regex** — Replaced by trailing `_` phonemizer workaround.

## [1.0.2] - 2026-07-01

### Added

- **Rust-native EPUB prefetch** — `prefetch_zip_metadata` Tauri command reads the epub zip in Rust (zip crate), returning pre-decoded text for container.xml, OPF, nav, NCX, encryption.xml, and ALL HTML/XHTML section files. Combined with the uncompressed-size map of every zip entry, JS loadText/getSize calls skip @zip.js/zip.js entirely on the critical path. Book opening drops from ~1.5s to <50ms on desktop and <150ms on Android.
- **CBZ/FBZ support** — Rust prefetch works for all zip-based formats (sizes map always returned; EPUB-specific paths gracefully degrade).
- **Smooth page-turn animation** — CSS `transition: transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)` applied on single-page transforms. Jump navigation (goTo, scrollToAnchor) stays instant.
- **Loading grace period** — Spinner only appears if the book takes >200ms to open (rare with Rust prefetch).
- **Search bar clear button** — × button clears the query and returns to unsearched state.
- **Shelf membership in context menu** — Right-clicking a book in Library shows which shelves it belongs to, with one-click removal.
- **TTS pause/resume** — Play/Pause now suspends/resumes the Web Audio timeline without restarting synthesis (was restarting the entire pipeline).

### Changed

- **Immersion bar redesigned** — Full-width on mobile with `justify-center`, larger touch targets (play 40×40px, aux 32×32px), generous spacing (`gap-2`, `py-3`, `px-4`), safe-area coverage. All via `sm:` responsive prefixes; desktop stays compact.
- **Theme switching** — `getCSS` statically imported (no `await import()` on every switch), making the first theme toggle instant.
- **Brightness filter** — `CSS filter: brightness(%)` applied to the full-bleed reader container (`inset-0`) instead of a separate rectangle.
- **TTS speed** — Speed is now correctly applied at play start. Changing speed during playback triggers a restart with the new speed.
- **Toolbar buttons** — Click propagation stopped so headphone/other toolbar clicks don't trigger page navigation.
- **Loading state** — Spinner has a 200ms grace period to avoid flashing on fast opens.

### Fixed

- **Android: selection highlight on multi-column pages** — #container uses `overflow: clip` (makes scrollLeft/scrollTop inert) combined with `transform: translateX/Y()` for page positioning. The previous JS guards (checkPointerSelection, focusin, touchmove) blocked JS-level causes, but the OS-level auto-scroll of scrollLeft during native text selection was only beaten by this structural change.
- **Zoom persists across books** — Global `readerSettings.zoom` reset to 100% on each new book open. Zoom re-applied after every chapter change (`goTo`/`goToFraction`).
- **Immersion bar overlaying content** — Reader container gets `pb-16` when immersion bar is active, with `transition-[padding] 300ms` for smooth resize.
- **Android TTS crash** — `ImmersionPlayer.init()` now merges callbacks instead of wholesale replacing, preventing callback loss when multiple consumers call init.
- **TTS speed dependency** — `handlePlay` no longer had stale closure over speed; now correctly reads from store.
- **ReaderViewport empty init removed** — Removed `immersionPlayer.init()` call that was overwriting ImmersionBar's callbacks with empty ones, causing onStateChange to never fire and the UI to permanently stick at 'loading'.
- **Share notification feedback** — Added error toasts for preview generation failures in both highlights and stats share modals. Added "Popup was blocked" toast in ShareMenu when X share popup is blocked.
- **Rust clippy warning** — `map_or(false, ...)` → `is_some_and()` in `epub_parser.rs` (new Rust 1.96 lint).

### Performance

- **Rust EPUB parser** (`src-tauri/src/epub_parser.rs`): Opens zip once, reads container/OPF/nav/NCX/section text, and returns a full sizes map. Runs in parallel with JS zip.js getEntries. No new Rust dependencies (uses existing `zip` and `regex` crates).
- **In-flight loadText dedup**: Map-based deduplicator wraps loadText so concurrent calls for the same href share one zip.js inflate.
- **Static getCSS import**: `foliate/reader.ts` module preloaded at app startup, eliminating the dynamic import delay on every theme switch.

### Note

- **TTS on Android/mobile**: Audio synthesis runs via ONNX Runtime CPU inference, which is significantly slower on mobile hardware than desktop. On Android, each sentence takes ~5-10 seconds to produce first audio. This is a backend limitation — the Rust Kokoro TTS engine runs full neural model inference on CPU. Android native TextToSpeech API integration or Web Speech API fallback would be needed for instant TTS on mobile. Desktop TTS (macOS/Linux/Windows) has near-real-time performance after model warmup. Speed control on mobile uses `playbackRate` (pitch-preserved via Web Audio) instead of SoundTouch offline stretching (blocking on mobile).

### Added

- **CBR comic support** — RAR archives are now supported. Transparently converted to CBZ at import time via Rust `unrar-ng` decompression. OS file association registered for `.cbr`.
- RAR magic byte detection in buffer-based format detection.

### Fixed

- **TTS on Android** — Fixed silent playback in production builds by properly awaiting AudioContext.resume() before scheduling audio.
- **Auto-navigation during text selection** — `checkPointerSelection` disabled (upstream Foliate navigates to adjacent page when selection crosses column boundary, problematic on mobile).

### Changed

- **TTS speed control removed** — Non-functional. Speed button removed from ImmersionBar and Settings dropdown removed.
- **Focusin handler guarded** — Prevents scroll to page 1 during mobile text selection. Added body/documentElement exclusion.
- **README overhaul** — Complete rewrite with all features documented (highlight sharing, PDF annotations, backup/restore, achievements, FBZ/CBR, more). 7 screenshots added. Web demo badge. MIT vs AGPL FAQ.
- **CHANGELOG corrected** — TTS status reflects current restored state, not the historical removal.

## [1.0.0] - 2026-06-28

First stable release. Subsequent fixes and additions in 1.0.1.

### Added

- **Reading achievements** — Unlock badges (First Book, Bookworm, On Fire, Highlighter) as you read.
- **Reading goals** — Configurable daily reading goal (minutes) and yearly book goal.
- **Activity heatmap** — 12-week reading activity grid in Statistics.
- **Reading speed tracking** — Words-per-minute average reading speed.
- **Highlight share as image** — ShareStudio generates polished share-card images (highlight cards, reading stats). Export as PNG, copy to clipboard, or share via Web Share API / X (Twitter). Square (1080×1080) and Story (1080×1920) formats with multiple visual themes.
- **Backup & restore** — Full backup bundle (books, annotations, dictionaries, vocabulary, RSS, settings, sync state) exportable as a single JSON file. Clear all application data option.
- **Onboarding flow** — First-run step-by-step walkthrough covering library, reader, annotations, and sync.
- **Open With file association** — Desktop users can open ebook files directly from their file manager ("Open With Theorem").
- **Android content URI support** — Full pipeline for materializing and reading files from Android content:// URIs.
- **FBZ / fb2.zip import** — Compressed FictionBook format support.
- **Dictionary download from repository** — Browse and download remote StarDict dictionaries with progress tracking.

### Fixed

- **TTS on Android** — Fixed silent playback in production builds by properly awaiting AudioContext.resume() before scheduling audio. Previously the Web Audio context stayed suspended and audio was silently dropped.
- **TTS speed control removed** — Playback speed control was non-functional (SoundTouch blocked on mobile, playbackRate shifted pitch without preservation). The UI controls have been removed to avoid confusion.
- **EPUB reader timeout regression** — Some books were stuck at "Loading book..." indefinitely. Added timeout and fallback safeguards.
- **Mobile reader back button** — Correctly exits to library instead of navigating elsewhere.
- **Redundant navigation** — Prevented duplicate navigation actions during routing.
- **Sync race conditions** — Resolved overlapping library updates during rapid data syncs.
- **Sync security** — Addressed tombstone propagation and encryption edge cases.
- **Storage timeout** — Increased read timeout for large books.
- **Text truncation on mobile** — Fixed reader title wrapping on small screens.

### Changed

- **TTS system overhauled** — Complete rewrite of the Kokoro neural TTS pipeline: streaming parallel synthesis, Web Audio API gapless playback, per-word highlighting, voice switching, next-page preloading. Replaced Rust `tts-rs` ONNX bindings with `kokoro-en` (pure Rust phonemizer via misaki-lean, no espeak-ng subprocess needed).
- **LAN sync re-architected** — Switched from blocking synchronous file payloads to async encrypted stream chunks. Reduced OOM risk on Android. Eliminated "Double JSON" serialization overhead.
- **Import system rewritten** — Concurrency-controlled batch import with SHA-256 content hash deduplication. Magic byte format detection. Filename metadata extraction.
- **Settings schema migrated** — Versioned Zustand migrations for all persisted stores (TTS, vault, sync, reading progress).
- **Cross-platform build pipeline** — GitHub Actions CI/CD produces Linux (.deb, .AppImage), macOS (Intel + Apple Silicon .dmg), Windows (.msi, .exe), and Android (.apk) from a single codebase.

### Removed

- Playwright e2e tests and related devDependencies (replaced by expanded Vitest coverage).

### Known Limitations

- iOS is not currently supported (Tauri does not target iOS)
- User is responsible for data backups (export bundle recommended for migration)
- No Cross-device network sync beyond local LAN

---

## [1.0.0-beta.5] - 2026-03-27

### Changed

- Overhauled LAN Sync performance — blocking synchronous file payloads → async encrypted stream chunks, reducing OOM on Android
- Re-architected data serialization — eliminated "Double JSON" stringification lags

### Fixed

- Sync race conditions during rapid data pushes
- SQLite-to-disk blocking timeout on tokio thread

## [1.0.0-beta.4] - 2026-03-24

### Fixed

- Reader title truncation on mobile
- Feeds page overlap with sync button
- Added spinning animation to sync button for active state feedback

## [1.0.0-beta.3] - 2026-03-23

### Added

- OS file association support ("Open With") via Tauri events
- Import failure alerts in library

### Fixed

- Storage read timeout for large books
- Mobile reader back button routing
- Redundant navigation prevention

## [1.0.0-beta.2] - 2026-03-09

### Added

- Encrypted LAN device sync with QR pairing
- Linux packaging scripts

### Fixed

- Sync security and tombstone propagation
- Linux local install fallback

## [1.0.0-beta.1] - 2026-02-27

### Added

- **Reader Engine** — EPUB, MOBI, AZW/AZW3, FB2, CBZ, PDF support. Foliate-based reflowable rendering. PDF.js with annotation support. RSS feed reader.
- **Library Management** — Import from local files, folder scanning, shelves/collections, favorites, ratings, tags, sorting, search.
- **Annotations** — Color-coded highlights (6 colors), notes, bookmarks, annotation panel. PDF: highlights, freehand drawing, text notes. Overlayer: highlight, underline, strikethrough, squiggly.
- **Vocabulary** — Built-in dictionary, StarDict support, vocabulary review.
- **Markdown Export** — Obsidian/Logseq vault sync, per-book pages, vocabulary export, customizable naming.
- **Neural TTS** — Kokoro ONNX engine, 6 voices, streaming playback, per-word highlighting.
- **Reading Statistics** — Daily activity, reading time, streaks, reading speed, heatmap.
- **Search** — Full-text in-book search, library search, RSS article search.
- **Cross-Platform** — Desktop (Linux, macOS, Windows) + Android + Web fallback.
- **Theming** — Light/dark/sepia reader themes. Custom fonts, margins, spacing, alignment, hyphenation.
- **Multi-format support** — EPUB, MOBI, AZW, AZW3, FB2, CBZ, CBR, PDF, TXT, RSS articles.
