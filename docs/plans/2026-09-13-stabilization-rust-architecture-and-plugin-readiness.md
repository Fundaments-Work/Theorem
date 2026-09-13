# Architecture & Stabilization Roadmap: Rust Core Expansion, Memory Optimization & Plugin Readiness

**Date**: 2026-09-13  
**Status**: Active Architecture Specification & Master Roadmap  
**Target Milestones**:  
- **v1.5.2**: Precision Highlighting, Zero-Allocation Search & Targeted Rust Performance Upgrades  
- **v1.5.3**: Database Virtualization, Relational RSS, FTS5 & Zero-Copy Storage Scalability  
- **v1.6.0**: WebAssembly & Isolated Runtime Plugin Ecosystem  
**Authors**: Theorem Core Team  

---

## 1. Executive Context & Architectural Vision

Theorem’s strategic roadmap targets becoming the **"Obsidian of Reading Apps"** in **v1.6.0**—a high-performance, local-first reading hub featuring a modular, hot-reloadable plugin ecosystem. Community plugins will extend Theorem with Bionic reading, interlinear translation glosses, Zotero/BibTeX integration, Anki card synchronization, and custom document format loaders without bloating the core application.

However, an extensible plugin ecosystem cannot be safely mounted on an unstable or memory-bloated foundation. Prior to introducing third-party runtimes, declarative reader slots, and plugin APIs in v1.6.0, the core platform must resolve several architectural bottlenecks present up to v1.5.1:

1. **Reader Layout Fragility**: Cross-page and cross-column selection in Foliate CSS multi-column paginated views must be mathematically robust so third-party overlays or highlight scripts do not trigger pagination oscillation or erratic page turns.
2. **The Monolithic Persist Bottleneck**: Storing the entire library, RSS feed articles (up to 25MB of HTML), vocabulary, and reading stats in JavaScript Zustand memory and serializing giant monolithic JSON strings to SQLite `kv_store` on every mutation creates severe V8 heap bloat (~150MB+) and 100–300ms GC stalls.
3. **Monolithic Sync Payloads**: Peer-to-peer (Iroh) sync serializes arrays monolithically, making concurrent offline edits vulnerable to Last-Write-Wins (LWW) overwrites and requiring expensive double-hop IPC serialization (`Rust -> TS -> Rust`).
4. **Main-Thread JavaScript CPU Churn**: Operations like in-book search snippet collection, image downsampling, RSS XML parsing, and Obsidian vault exports currently churn allocations on the single JavaScript thread.

This master plan synthesizes all findings from:
- [`docs/research/cross-page-highlighting.md`](file:///run/media/sapiens/Development/Fundaments/Theorem/docs/research/cross-page-highlighting.md) (Geometric client rects & anchor stabilization)
- [`docs/research/rust-performance-rewrite-candidates.md`](file:///run/media/sapiens/Development/Fundaments/Theorem/docs/research/rust-performance-rewrite-candidates.md) (Targeted Rust modules)
- [`docs/research/database-performance-and-memory-optimization.md`](file:///run/media/sapiens/Development/Fundaments/Theorem/docs/research/database-performance-and-memory-optimization.md) (Database virtualization & scale)
- [`docs/research/latest-rust-memory-techniques-and-rss-architecture.md`](file:///run/media/sapiens/Development/Fundaments/Theorem/docs/research/latest-rust-memory-techniques-and-rss-architecture.md) (Cloudflare DNS memory layout lessons & RSS overhaul)
- [`docs/research/whole-app-rust-capabilities-and-roadmap.md`](file:///run/media/sapiens/Development/Fundaments/Theorem/docs/research/whole-app-rust-capabilities-and-roadmap.md) (Whole-app feature audit)

---

## 2. Stability & Performance Deficits Audit (v1.5.1 Baseline)

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                               CURRENT SUBSYSTEM BOTTLENECK AUDIT                                │
├──────────────────────────┬──────────────────────────────────────────────────────────────────────┤
│ SUBSYSTEM                │ ROOT CAUSE & PERFORMANCE DEFICIT                                     │
├──────────────────────────┼──────────────────────────────────────────────────────────────────────┤
│ 1. Cross-Page Selection  │ getBoundingClientRect() spans column gutters. Navigation oscillates  │
│                          │ between Page N and N+1 on cross-boundary selections.                 │
│ 2. Monolithic Persist    │ Zustand serializes 10MB-25MB JSON strings to kv_store on EVERY       │
│                          │ mutation (library, RSS, vocabulary). Blocks JS thread for 150ms.     │
│ 3. RSS Ingestion         │ fast-xml-parser & markdown-it in JS bundle (~175KB); 500 HTML        │
│                          │ articles held in V8 heap; SQLite has ZERO relational tables for RSS. │
│ 4. In-Book Search        │ book_search.rs collects Vec<char> of entire chapter on every single  │
│                          │ match hit, generating tens of megabytes of transient garbage.        │
│ 5. Cover Processing      │ HTML5 Canvas in cover-extractor.ts freezes UI on bulk import.        │
│ 6. Full-Text Library     │ fuse.js in JS heap builds in-memory search index on every query.     │
│ 7. P2P Iroh Sync         │ Monolithic array keys ("annotations") cause LWW data loss on offline │
│                          │ edits; double-hop IPC serialization (Rust -> TS -> Rust).            │
│ 8. Vault & SRS Sync      │ vault-sync.ts fires 60+ individual IPC file writes from JS.          │
│ 9. Reading Analytics     │ dailyActivity accumulated as unbounded JSON array in settingsStore.   │
│ 10. PDF.js Memory        │ Canvas bitmaps retained during rapid scroll in large technical PDFs. │
└──────────────────────────┴──────────────────────────────────────────────────────────────────────┘
```

---

## 3. Core Architectural Upgrades by Subsystem

### 3.1 Reader Engine: Cross-Page Highlights & Zero-Allocation Search

#### A. Geometric Fragment Rendering in Overlayer (`foliate-js-runtime/overlayer.js`)
- **Problem**: `getBoundingClientRect()` encompasses column gaps and unrelated text lines when a selection spans across two columns or page breaks.
- **Solution**:
  - Overlayer SVG rendering strictly iterates over `range.getClientRects()`, creating individual `<rect>` elements for each physical text line fragment.
  - Rectangles falling within column gap zones (`x` within gutter coordinates) are discarded.
  - Visual padding is applied strictly along the inline axis, preventing vertical overflow collisions between lines.

#### B. Anchor Stabilization in Paginator (`foliate-js-runtime/paginator.js`)
- **Problem**: `goToAnnotation()` evaluates the center of the bounding box of a cross-boundary range. If the end of the range is on Page $N+1$, the paginator snaps forward, but the viewport layout re-anchors to Page $N$, causing rapid visual oscillation.
- **Solution**:
  - `goToAnnotation(range)` is refactored to resolve target scroll position **strictly using `range.startContainer` and `range.startOffset`**.
  - A 150ms navigation barrier prevents redundant layout re-evaluations while paginator scroll transitions are animating.

#### C. Zero-Allocation In-Book Search Snippets (`src-tauri/src/book_search.rs`)
- **Problem**: Line 55 of `book_search.rs` executes `let chars: Vec<char> = text.chars().collect()` on **every match**, allocating millions of 4-byte UTF-32 characters into memory.
- **Solution**:
  - Eliminate `Vec<char>` completely.
  - Use `text.char_indices()` to identify UTF-8 byte slices directly:
    ```rust
    fn extract_context_snippet(text: &str, byte_start: usize, byte_len: usize) -> &str
    ```
  - Search runs **10× faster** with **0 bytes of transient heap allocation**.

---

### 3.2 Cloudflare-Inspired Rust Data Layouts

Adopting the 5 techniques from Cloudflare’s 1.1.1.1 DNS cache optimization (August 2026):

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                           CLOUDFLARE RUST DATA LAYOUT PRINCIPLES                                │
├──────────────────────────┬──────────────────────────────────────────────────────────────────────┤
│ TECHNIQUE                │ APPLICATION IN THEOREM                                               │
├──────────────────────────┼──────────────────────────────────────────────────────────────────────┤
│ 1. Box<[T]> & Box<str>   │ Used for all immutable DTOs (RSS articles, OPDS entries, book        │
│    (Cost of Capacity)    │ search results). Drops 8B capacity per field; zero heap slack.       │
│ 2. Contiguous Flattening │ Replace multiple heap vectors with flat buffers indexed by u16       │
│    (Fewer Lists/Pointers)│ offsets. Pack boolean flags into bitflags structs.                   │
│ 3. Context-Inferred Keys │ Child records (e.g. RSS articles, highlights) omit redundant parent  │
│    (Dropping the Owner)  │ IDs (feed_id, book_id) in memory if known by the query context.      │
│ 4. Enum Variant Boxing   │ Box large/rare enum variants (clippy::large_enum_variant) to shrink  │
│    (Enum Sizing)         │ the entire enum to ≤24 bytes.                                        │
│ 5. Scratchpad Buffers    │ Thread-local reusable serialization scratchpads with exact memcpy    │
│    (Wire Format Packing) │ into Box<[u8]>. Zero-copy IPC transfer.                              │
└──────────────────────────┴──────────────────────────────────────────────────────────────────────┘
```

---

### 3.3 Modern RSS Feed Subsystem Overhaul

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                               MODERN RUST NATIVE RSS ARCHITECTURE                               │
├─────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                 │
│   [ HTTP Stream ]                                                                               │
│          │                                                                                      │
│          ▼                                                                                      │
│   [ Native Streaming Parser: rss_parser.rs ]                                                    │
│          │ • Zero-copy SAX parsing over byte stream (quick-xml)                                 │
│          │ • Memory layout: Box<str> & Box<[T]> (Cloudflare Technique 1)                        │
│          │ • Context-inferred feed_id (Cloudflare Technique 3)                                  │
│          ▼                                                                                      │
│   [ Relational SQLite Tables in database.rs ]                                                   │
│          │ • rss_feeds (id, title, url, site_url, icon_url, last_fetched)                       │
│          │ • rss_articles (id, feed_id, title, url, author, published_at, is_read, summary)     │
│          │ • rss_article_content (article_id, content, full_content)                            │
│          │   (Separated! Lightweight metadata vs heavy HTML content)                             │
│          ▼                                                                                      │
│   [ Virtualized Window IPC ]                                                                    │
│          │ • sqlite_get_rss_articles_window(feed_id, limit: 50, offset: 0)                      │
│          │ • IPC payload is tiny (~10KB vs 25MB)                                                │
│          ▼                                                                                      │
│   [ React Virtual Viewport (FeedsPage.tsx) ]                                                    │
│          │ • Renders 50 lightweight cards instantly                                             │
│          │ • Zero V8 heap pressure (<200KB JS memory)                                           │
│          ▼                                                                                      │
│   [ On Article Open ]                                                                           │
│          │ • Rust load_article_content(article_id) on-demand                                    │
│          │ • Rust article_to_epub_native using native zip crate                                 │
│                                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

#### A. Native Streaming Parser (`src-tauri/src/rss_parser.rs`)
- Parses RSS 2.0, Atom 1.0, and RDF feeds via `quick-xml` directly from bytes.
- Execution time: **2ms – 5ms** (vs. 150ms – 400ms in JavaScript).
- Trims **~175 KB** of minified JavaScript from the frontend bundle (`fast-xml-parser`, `markdown-it`).

#### B. Relational SQLite Schema & Content Decoupling (`src-tauri/src/database.rs`)
- Store lightweight metadata in `rss_articles` (~200 bytes/row).
- Store full HTML content in `rss_article_content`, fetched **only when an article is opened**.
- Eliminates the 25MB monolithic persist loop from `rssStore.ts`.

#### C. Wire Native Readability (`article_extractor.rs`)
- Direct frontend calls to `fetch_and_extract_article_native` in Rust.
- Deprecate JavaScript `@mozilla/readability` and `DOMPurify` (-120 KB JS bundle).

---

### 3.4 Library Scalability: Two-Tier Hybrid Search (`SQLite FTS5` + `nucleo`) & Virtualization

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                     HYBRID TWO-TIER SEARCH ENGINE: FTS5 + NUCLEO                                │
├─────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                 │
│   User Types Search Query: "dune messiah"                                                       │
│                            │                                                                    │
│                            ▼                                                                    │
│   [ TIER 1: SQLite FTS5 (Disk / OS Page Cache) ]                                                │
│   • Runs: `SELECT id, title, author, description, rank                                          │
│            FROM books_fts WHERE books_fts MATCH 'dune*' LIMIT 200`                              │
│   • Scans 50,000+ books in ~1.2ms without loading records into memory.                          │
│   • Fast coarse candidate retrieval (prunes 50,000 items down to top ~200).                    │
│                            │                                                                    │
│                            ▼ Candidate records (200 items, ~40 KB in Rust)                      │
│                                                                                                 │
│   [ TIER 2: nucleo-matcher (SIMD In-Memory Scoring & Highlighting) ]                            │
│   • Runs Helix's SIMD-accelerated Smith-Waterman matcher over candidate records.                │
│   • Applies fine-grained fuzzy scoring: word boundaries, camelCase, typos, transpositions.      │
│   • Extracts exact matched character indices: `Vec<u32>` for UI bolding/underlining.            │
│   • Sorts candidates and takes top N (e.g. 50) in ~0.1ms.                                       │
│                            │                                                                    │
│                            ▼                                                                    │
│   [ Frontend Virtualizer (IPC Payload: 50 items with matched character indices) ]               │
│   • Renders search results with highlighted matching letters at 60fps.                          │
│   • 0 JS heap bloat, 0 GC pauses, sub-2ms total response time (replaces fuse.js).               │
│                                                                                                 │
│   *In-Memory Entities (Command Palette, Tags, Shelves, TOC)*                                    │
│   • Queries bypass SQLite and run directly through `nucleo-matcher` in < 0.05ms!                │
│                                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Why Combine SQLite FTS5 and `nucleo`?**:
   - **FTS5 alone** provides ultra-fast B-Tree inverted index retrieval across 50,000 books without memory overhead, but lacks typo-tolerant fuzzy ranking and character-level match indices for UI highlighting.
   - **`nucleo` alone** is the fastest in-memory fuzzy matcher in the Rust ecosystem (built by Helix with AVX2/NEON SIMD acceleration), but holding 50,000 book descriptions in RAM would waste ~30MB of memory.
   - **The Combination**: FTS5 filters 50,000 items on disk down to 200 candidates in **1ms**, then `nucleo` SIMD-scores them and computes highlight indices in **0.1ms**. Total time: **~1.3ms**, using **<50 KB** of memory!
2. **Windowed Library Pagination**:
   - `sqlite_query_books_window(filter, sort, limit, offset)` streams small typed slices to the frontend virtualizer.
   - V8 heap drops by **90%+** (from 150MB+ to <5MB).
3. **Dedicated Time-Series Table for Reading Analytics**:
   - Move `dailyActivity` array out of `settingsStore.ts` into a relational `reading_sessions` table with date indexes. Instant SQL aggregations (`SUM(minutes)`, streaks, velocity) with zero JSON parsing.

---

### 3.5 Targeted Rust Native Performance Modules

1. **Vault & Lemma SRS Exporter (`src-tauri/src/vault_export.rs`)**:
   - Multi-threaded Rayon export of Obsidian book notes and Lemma flashcard decks.
   - Replaces 60+ individual IPC `writeTextFile` operations with one native batch write (<5ms).
2. **Speech Text Normalizer (`src-tauri/src/text_normalizer.rs`)**:
   - Deterministic rule-based expansion of numbers, dates, Roman numerals, abbreviations, and currency.
   - Shared between live Supertonic neural voice, desktop platform TTS, and companion audiobook generation (`audiobook_gen.rs`).
3. **Off-Thread Cover Downsampling (`src-tauri/src/image_ops.rs`)**:
   - Offloads image decoding and WebP compression to a Rayon thread pool using the `image` crate.
   - Guarantees 60fps UI responsiveness during bulk book import.
4. **Dominant Color Quantization**:
   - Native SIMD / K-Means palette extraction directly on raw pixel buffers (<0.5ms vs 30ms with DOM canvas).

---

### 3.6 P2P Sync Hardening (`theorem-sync-core`)

1. **Granular Item-Level Sync Keys**:
   - Transition from monolithic sync keys (`annotations`) to atomic keys (`anno:<bookId>:<annotationId>`).
   - Completely eliminates Last-Write-Wins (LWW) array overwrite collisions during concurrent offline editing.
2. **Native SQLite Sync Merging in Rust**:
   - Apply incoming Iroh-gossip updates directly to SQLite inside a single `with_connection` transaction.
   - Notify the frontend via lightweight Tauri events (`sync-updated`), refreshing only visible viewport components.

---

### 3.7 The v1.6.0 Plugin Sandbox Runtime

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                  v1.6 PLUGIN RUNTIME CONTRACT                                   │
├─────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                 │
│  1. WebAssembly Component Sandbox (Wasmtime / Extism in Rust)                                   │
│     • Plugins compile to .wasm (from TS/AssemblyScript, Rust, Go).                              │
│     • True capability security: zero filesystem or network access unless declared in manifest.  │
│     • 10× faster compute than JavaScript workers; zero DOM corruption risk.                     │
│                                                                                                 │
│  2. Declarative Viewport Slot Isolation (Foliate Overlayer SVG)                                 │
│     • Plugins NEVER touch chapter <iframe> DOM directly.                                        │
│     • Reader provides dedicated React / SVG overlay slot:                                       │
│       registerReaderOverlay({ id, render: (viewport) => ReactNode })                            │
│     • Guarantees Foliate's multi-column pagination never crashes.                               │
│                                                                                                 │
│  3. Namespaced Isolated Storage                                                                 │
│     • Plugins receive isolated SQLite tables: plugin_<id>_kv.                                   │
│     • Strict capability manifest: permissions: ["annotations:read"].                            │
│                                                                                                 │
│  4. Strongly-Typed Event Bus & Native Hooks                                                     │
│     • app.on("before:page-turn", (event) => ...) (cancellable)                                  │
│     • app.on("highlight:create", (highlight) => ...)                                           │
│     • registerFormatLoader({ ext, loader }) / registerVaultExporter({ id, handler })            │
│                                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Phased Master Roadmap

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   PHASED MASTER ROADMAP                                         │
├─────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                 │
│  ════════════════════════════════════════════════════════════════════════════════════════════   │
│  MILESTONE 1: THEOREM v1.5.2 — Precision Reader & Targeted Rust Modules                         │
│  ════════════════════════════════════════════════════════════════════════════════════════════   │
│  • Cross-Page Highlighting Engine:                                                              │
│    - foliate-js-runtime/overlayer.js line fragment rendering (Range.getClientRects)             │
│    - foliate-js-runtime/paginator.js anchor lock to startContainer                              │
│    - src-tauri/src/epubcfi.rs CFI range splitting & comparison                                  │
│  • Targeted Rust Modules:                                                                       │
│    - src-tauri/src/vault_export.rs: Single-shot Rayon Obsidian & Lemma SRS exporter             │
│    - src-tauri/src/text_normalizer.rs: Speech normalizer for TTS & companion audiobooks         │
│    - src-tauri/src/image_ops.rs: Off-thread cover downsampling & WebP encoding                  │
│    - src-tauri/src/rss_parser.rs: quick-xml SAX parser with Box<str> layout                     │
│    - src-tauri/src/book_search.rs: Zero-allocation char_indices snippet search                 │
│  • Mobile & Touch Disambiguation:                                                               │
│    - 120ms tap-suppression barrier; strict touch gesture hierarchy                              │
│                                                                                                 │
│  ════════════════════════════════════════════════════════════════════════════════════════════   │
│  MILESTONE 2: THEOREM v1.5.3 — Database Virtualization & Sync Hardening                         │
│  ════════════════════════════════════════════════════════════════════════════════════════════   │
│    - Hybrid Two-Tier Search: SQLite FTS5 candidate retrieval + nucleo-matcher SIMD fuzzy ranking (replacing fuse.js) │
│    - Exact match character indices (highlighting matching query letters in UI)                   │
│    - sqlite_query_books_window with limit/offset cursor pagination for 50,000+ books            │
│    - Relational RSS schema in database.rs (rss_feeds, rss_articles, rss_article_content)        │
│    - Relational reading_sessions table for instant analytics aggregations                       │
│    - Elimination of monolithic Zustand persist JSON strings in kv_store                         │
│  • P2P Sync Hardening:                                                                          │
│    - Granular atomic sync keys in Iroh docs (anno:<id>)                                         │
│    - Native SQLite sync conflict resolution in Rust                                             │
│  • Reader Ecosystem:                                                                            │
│    - Offline morphological lemmatizer / stemmer in Rust (100% dictionary hit rate)              │
│    - Wire native article_extractor.rs, removing @mozilla/readability from JS                    │
│                                                                                                 │
│  ════════════════════════════════════════════════════════════════════════════════════════════   │
│  MILESTONE 3: THEOREM v1.6.0 — Sandboxed Extensibility (The Plugin Ecosystem)                   │
│  ════════════════════════════════════════════════════════════════════════════════════════════   │
│  • WebAssembly Sandbox Runtime (Wasmtime / Extism in Rust)                                      │
│  • Declarative Reader Overlay Slot Architecture (Foliate & PDF.js)                              │
│  • Namespaced SQLite Storage & Capability-Based Permission System                               │
│  • Published @theorem/plugin-sdk with Event Bus & Settings Tab APIs                             │
│  • In-App Community Plugin Browser with 1-Click Installation                                    │
│                                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Verification & Quality Gates

Each milestone must strictly satisfy Theorem's quality gates:
1. **Zero Lint / Compiler Errors**:
   - Frontend: `pnpm typecheck` must produce zero errors.
   - Rust: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo check` must pass cleanly.
2. **Automated Test Coverage**:
   - Unit tests for all Rust modules (`vault_export`, `text_normalizer`, `rss_parser`, `book_search`).
   - Vitest suite (`pnpm test`) passing 100%.
3. **Zero Secrets / Credentials Rule**:
   - Full compliance with [`AGENTS.md`](file:///run/media/sapiens/Development/Fundaments/Theorem/AGENTS.md).
