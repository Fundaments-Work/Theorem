# Architecture & Stabilization Roadmap: Rust Core Expansion & Plugin Ecosystem Readiness

**Date**: 2026-09-13  
**Status**: Architecture Roadmap & Specification  
**Target Milestone**: v1.5.2 (Stabilization & Targeted Rust Modules) $\rightarrow$ v1.5.3 (Data Layer & Sync Hardening) $\rightarrow$ v1.6.0 (Plugin Ecosystem)  
**Authors**: Theorem Core Team  

---

## 1. Executive Context & Vision

Theorem's strategic roadmap targets becoming the **"Obsidian of Reading Apps"** in **v1.6.0**—a high-performance, local-first reading hub featuring a modular, hot-reloadable plugin ecosystem. Community plugins will extend Theorem with Bionic reading, interlinear translation glosses, Zotero/BibTeX integration, Anki card synchronization, and custom document format loaders without bloating the core application.

However, an extensible plugin ecosystem cannot be safely mounted on an unstable foundation. Prior to introducing third-party JavaScript runtimes, declarative reader slots, and plugin APIs in v1.6.0, the core platform must resolve three architectural vulnerabilities present up to v1.5.1:

1. **Reader Layout Fragility**: Cross-page and cross-column selection in paginated views must be mathematically robust so third-party overlays or highlight scripts do not trigger pagination oscillation or erratic page turns.
2. **Dual-State Split-Brain**: Storing the entire library in JavaScript Zustand memory while simultaneously mirroring to SQLite creates memory bloat at scale (1,000+ books) and lacks a clean, transactional single source of truth for plugins.
3. **Monolithic Sync Payloads**: Peer-to-peer (Iroh) sync serializes arrays monolithically, making concurrent offline edits vulnerable to Last-Write-Wins (LWW) overwrites and requiring expensive double-hop IPC serialization (`Rust -> TS -> Rust`).

This document outlines the **complete architectural stabilization audit**, evaluates all candidates across the application for **selective Rust migration**, and defines the structural bridge to the **v1.6.0 Plugin Engine**.

---

## 2. Stability Audit: Current Edge-Cases & Fragilities (v1.5.1)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          CURRENT STABILITY DEFICITS                             │
├──────────────────────────┬──────────────────────────────────────────────────────┤
│ SUBSYSTEM                │ ROOT CAUSE & BEHAVIORAL RISK                         │
├──────────────────────────┼──────────────────────────────────────────────────────┤
│ 1. Cross-Page Selection  │ getBoundingClientRect() spans column gutters.        │
│                          │ Navigation oscillates between Page N and N+1.        │
│ 2. Dual-State Storage    │ Zustand serializes unbounded JSON to disk on every   │
│                          │ mutation; SQLite mirrors via redundant IPC writes.   │
│ 3. P2P Iroh Sync         │ Monolithic array keys ("annotations") cause LWW data │
│                          │ loss during concurrent offline multi-device editing. │
│ 4. Mobile / Stylus Input │ Touch event bubbling triggers both page turn and     │
│                          │ footnote peek popover on tap near links.             │
│ 5. PDF.js Engine Memory  │ Offscreen canvas textures retained during rapid      │
│                          │ scroll across large 500+ page technical documents.  │
│ 6. Dictionary Inflections│ Offline MDX/StarDict misses unindexed inflections    │
│                          │ ("running" fails if "run" redirect is missing).      │
└──────────────────────────┴──────────────────────────────────────────────────────┘
```

### 2.1 Cross-Page & Cross-Column Highlighting

- **Primary Source**: [`src/features/reader/foliate-js-runtime/paginator.js:336-444`](file:///run/media/sapiens/Development/Fundaments/Theorem/src/features/reader/foliate-js-runtime/paginator.js#L336-L444), [`overlayer.js:4-174`](file:///run/media/sapiens/Development/Fundaments/Theorem/src/features/reader/foliate-js-runtime/overlayer.js#L4-L174)
- **The Defect**:
  Reflowable chapters in Foliate use CSS Multi-column layout (`column-width`, `column-gap`). When a sentence starts at the bottom of Column $N$ (Page $N$) and ends at the top of Column $N+1$ (Page $N+1$):
  1. `Range.prototype.getClientRects()` returns disjoint line boxes for each column, but standard bounding boxes (`getBoundingClientRect()`) span horizontally across the column gap and vertically across unrelated lines.
  2. If an annotation range spans across a spine item boundary or page edge, calling `goToAnnotation()` can cause the paginator to resolve the target to Page $N+1$, uncollapse the anchor, re-evaluate the scroll position to Page $N$, and oscillate infinitely, causing rapid page flickering.
- **Stabilization Required (v1.5.2)**:
  - Overlayer SVG rendering must strictly iterate over `range.getClientRects()` and draw individual `<rect>` fragments.
  - Paginator anchor uncollapsing must anchor strictly to the start node of the range.
  - Implement native Rust CFI range division in [`src-tauri/src/epubcfi.rs`](file:///run/media/sapiens/Development/Fundaments/Theorem/src-tauri/src/epubcfi.rs) to partition cross-boundary CFI ranges into deterministic sub-ranges.

### 2.2 Dual-State Storage & Synchronization (Zustand vs. SQLite)

- **Primary Source**: [`src/core/store/libraryStore.ts:475-725`](file:///run/media/sapiens/Development/Fundaments/Theorem/src/core/store/libraryStore.ts#L475-L725), [`src/core/lib/sqlite-storage.ts:1-250`](file:///run/media/sapiens/Development/Fundaments/Theorem/src/core/lib/sqlite-storage.ts#L1-L250)
- **The Defect**:
  - The entire library state (`books`, `annotations`, `collections`, `tombstones`) is kept in JavaScript memory via Zustand `persist` middleware (`theoremPersistStorage`).
  - On every mutation (e.g. adding a highlight), Zustand serializes the **entire** state into JSON on the webview storage, and simultaneously invokes individual Tauri IPC commands (`sqliteSaveBookMetadata`, `sqliteSaveBookAnnotations`).
  - **Memory & Latency**: A user with 1,500 books and 10,000 highlights maintains a ~25MB active object tree in V8. Parsing and stringifying this on every store mutation induces main-thread garbage collection (GC) stalls.
  - **Split-Brain Risk for Plugins**: When plugins in v1.6 modify book metadata or tags, writing to Zustand does not guarantee transactional integrity in SQLite, and writing to SQLite bypasses Zustand reactivity.
- **Stabilization Required (v1.5.3)**:
  - Transition SQLite in Rust to the **canonical single source of truth**.
  - Zustand becomes a lightweight, virtualized view-cache holding only active collections, current book data, and paginated library slices.

### 2.3 Monolithic P2P Sync Payloads & LWW Collisions

- **Primary Source**: [`docs/sync.md:65-105`](file:///run/media/sapiens/Development/Fundaments/Theorem/docs/sync.md#L65-L105), [`src/core/lib/sync-orchestrator.ts:1-350`](file:///run/media/sapiens/Development/Fundaments/Theorem/src/core/lib/sync-orchestrator.ts#L1-L350)
- **The Defect**:
  - `provisionToIrohDocs()` serializes all annotations into a single Iroh doc entry under the monolithic key `annotations`.
  - If Device A creates a highlight in Chapter 1 while Device B creates a highlight in Chapter 5, the two devices experience a Last-Write-Wins conflict on the entire `annotations` array. The device whose sync timestamp is older has its highlights discarded.
  - Sync processing requires a double IPC hop: Rust receives Iroh bytes $\rightarrow$ sends to TypeScript $\rightarrow$ TypeScript deserializes and loops through JS objects $\rightarrow$ TypeScript invokes Tauri IPC commands to write records back into SQLite.
- **Stabilization Required (v1.5.3)**:
  - Migrate Iroh doc entries to atomic keys: `anno:<bookId>:<annotationId>`.
  - Move CRDT/LWW reconciliation into Rust (`theorem-sync-core`), directly applying updates to SQLite in a single transaction.

### 2.4 Touch & Stylus Gesture Disambiguation on Android

- **Primary Source**: [`src/features/reader/foliate-js-runtime/paginator.js:820-950`](file:///run/media/sapiens/Development/Fundaments/Theorem/src/features/reader/foliate-js-runtime/paginator.js#L820-L950)
- **The Defect**:
  On touchscreens, tap gestures near links, footnotes, or image figures can trigger conflicting event handlers simultaneously (e.g., page navigation triggers while the footnote popover attempts to open).
- **Stabilization Required (v1.5.2)**:
  Establish strict gesture hierarchy: `Active Selection (Drag/Stylus) > Interactive Element (Footnote/Link) > Viewport Navigation (Page Turn)`. Add an explicit 120ms tap-suppression barrier following touch release.

### 2.5 PDF.js Canvas Resource Management

- **Primary Source**: [`src/features/reader/engines/pdfjs-engine.tsx:1-450`](file:///run/media/sapiens/Development/Fundaments/Theorem/src/features/reader/engines/pdfjs-engine.tsx#L1-L450)
- **The Defect**:
  In large PDFs (800+ page technical manuals), rapid continuous scrolling can retain rendered `<canvas>` bitmaps in the browser rendering pipeline before garbage collection cycles run, driving memory consumption past 1GB on low-RAM devices.
- **Stabilization Required (v1.5.2)**:
  Enforce explicit canvas destruction (`canvas.width = 0; canvas.height = 0; ctx = null`) for all rendered pages outside a strict $\pm 2$ page buffer.

---

## 3. Comprehensive Whole-App Rust Rewrite Evaluation

We evaluated all computational, string-processing, and file I/O operations across Theorem to determine which components yield significant performance and architectural gains when moved to Rust.

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 RUST REWRITE CANDIDATES MATRIX                               │
├──────────────────────────┬──────────────┬──────────────┬───────────────┬─────────────────────┤
│ CANDIDATE MODULE         │ EFFORT       │ PERF GAIN    │ BUNDLE CUT    │ TARGET RELEASE      │
├──────────────────────────┼──────────────┼──────────────┼───────────────┼─────────────────────┤
│ 1. Vault Markdown Export │ Low (2 days) │ 50x (I/O)    │ Minor         │ v1.5.2 (Immediate)  │
│ 2. Audio Text Normalizer │ Low (1 day)  │ 20x (CPU)    │ Minor         │ v1.5.2 (Immediate)  │
│ 3. Cover Image Transcode │ Low (1 day)  │ Zero UI lag  │ Minor         │ v1.5.2 (Immediate)  │
│ 4. RSS Feed XML Parser   │ Med (2 days) │ 15x (CPU)    │ ~175 KB       │ v1.5.2 (Immediate)  │
│ 5. CFI Range Partitioning│ Low (1 day)  │ Critical Fix │ Minor         │ v1.5.2 (Immediate)  │
│ 6. Dictionary Lemmatizer │ Med (2 days) │ Instant      │ Minor         │ v1.5.3 (Data Layer) │
│ 7. Atomic CRDT Merger    │ Med (3 days) │ 10x (Sync)   │ Moderate      │ v1.5.3 (Data Layer) │
│ 8. SQLite Virtual Query  │ High (4 days)│ Inf Scale    │ High          │ v1.5.3 (Data Layer) │
└──────────────────────────┴──────────────┴──────────────┴───────────────┴─────────────────────┘
```

### 3.1 Vault Markdown & Lemma Deck Exporter (`src-tauri/src/vault_export.rs`)

- **Current Implementation**: [`src/core/lib/vault-sync.ts`](file:///run/media/sapiens/Development/Fundaments/Theorem/src/core/lib/vault-sync.ts)
- **Bottleneck**: Generates markdown strings in JavaScript and invokes `@tauri-apps/plugin-fs` `writeTextFile` in batches of 16. In a library of 100 books, this produces over 100 IPC roundtrips, serializing megabytes of string data across the webview boundary.
- **Rust Architecture**:
  ```rust
  #[tauri::command]
  pub async fn vault_export_snapshot(
      app: AppHandle,
      vault_path: String,
      highlights_folder: String,
      vocab_filename: String,
  ) -> Result<VaultExportStats, String> {
      // 1. Query SQLite connection directly in Rust (zero IPC serialization from frontend)
      // 2. Format Obsidian book notes with '> ==quote==' and Lemma flashcards with '---card---'
      // 3. Concurrently write files via rayon::prelude::* and std::fs::write
  }
  ```
- **Benefit**: Export duration drops from ~300ms to <5ms. Eliminates all IPC file writing overhead and prevents any UI micro-stutters during reactive auto-sync.

### 3.2 Audio Text Normalization Engine (`src-tauri/src/text_normalizer.rs`)

- **Current Implementation**: [`src/features/reader/audio/text-normalization.ts`](file:///run/media/sapiens/Development/Fundaments/Theorem/src/features/reader/audio/text-normalization.ts)
- **Bottleneck**: 297 lines of regexes and number-to-words algorithms running in V8. Critically, background companion audiobook generation ([`audiobook_gen.rs`](file:///run/media/sapiens/Development/Fundaments/Theorem/src-tauri/src/audiobook_gen.rs)) runs in Rust and cannot access this TypeScript code, causing generated audiobooks to read raw numbers and symbols unnaturally.
- **Rust Architecture**:
  ```rust
  pub fn normalize_for_speech(text: &str) -> String {
      // 1. Regex expansion: currency ($12.50 -> twelve dollars and fifty cents)
      // 2. Ordinal & Year expansion (1984 -> nineteen eighty-four)
      // 3. Roman numerals in headings (Chapter IV -> Chapter four)
      // 4. Abbreviations (Dr. -> Doctor, etc. -> et cetera)
  }
  ```
- **Benefit**: Shared single-binary implementation between live Immersion TTS and companion audiobook generation. $20\times$ faster string processing with zero V8 heap allocation.

### 3.3 Cover Resizing & WebP Transcoder (`src-tauri/src/image_ops.rs`)

- **Current Implementation**: [`src/core/lib/storage.ts:365-419`](file:///run/media/sapiens/Development/Fundaments/Theorem/src/core/lib/storage.ts#L365-L419)
- **Bottleneck**: Uses DOM `<canvas>` elements to decode and resize large cover images (5–15 MB), causing frame drops and main-thread locking during book import.
- **Rust Architecture**:
  Utilize the existing `image` crate in `src-tauri/Cargo.toml`.
  ```rust
  #[tauri::command]
  pub async fn downsample_cover_image(
      image_bytes: Vec<u8>,
      max_width: u32,
      max_height: u32,
  ) -> Result<Vec<u8>, String> {
      tokio::task::spawn_blocking(move || {
          let img = image::load_from_memory(&image_bytes).map_err(|e| e.to_string())?;
          let thumbnail = img.thumbnail(max_width, max_height);
          let mut buffer = Vec::new();
          thumbnail.write_to(&mut std::io::Cursor::new(&mut buffer), image::ImageFormat::WebP)
              .map_err(|e| e.to_string())?;
          Ok(buffer)
      }).await.map_err(|e| e.to_string())?
  }
  ```
- **Benefit**: Completely offloads image decoding from the UI thread; SIMD-accelerated thumbnail generation in <5ms.

### 3.4 RSS & Atom Feed Engine (`src-tauri/src/rss_parser.rs`)

- **Current Implementation**: [`src/core/services/RssService.ts`](file:///run/media/sapiens/Development/Fundaments/Theorem/src/core/services/RssService.ts)
- **Bottleneck**: Bundles `fast-xml-parser` (73 KB) and `markdown-it` (102 KB) into the webview bundle. Parsing feeds in JavaScript causes high memory churn and UI pauses on app launch.
- **Rust Architecture**:
  Stream-parse feeds using `quick-xml` (already compiled into Theorem for OPDS and EPUB parsing) and fetch via `reqwest`.
  ```rust
  #[tauri::command]
  pub async fn fetch_and_parse_rss_feed(url: String) -> Result<ParsedRssFeedDto, String>;
  ```
- **Benefit**: Trims **~175 KB of minified JS** from the webview bundle. Parses feeds $15\times$ faster with zero GC overhead.

### 3.5 Offline Morphological Stemmer & Lemmatizer (`src-tauri/src/lemmatizer.rs`)

- **Current Implementation**: [`src/core/services/StarDictService.ts`](file:///run/media/sapiens/Development/Fundaments/Theorem/src/core/services/StarDictService.ts), [`src-tauri/src/mdict.rs`](file:///run/media/sapiens/Development/Fundaments/Theorem/src-tauri/src/mdict.rs)
- **Bottleneck**: Looking up inflected words (e.g. "unearthed", "spoke", "criteria") fails if the offline dictionary lacks exact synonym redirects.
- **Rust Architecture**:
  Embed a fast morphological lemmatizer or Porter/Snowball stemmer in Rust. If `mdx_lookup` or `stardict_lookup` yields 0 results, the engine instantly stems the word and retries in <0.2ms before falling back to remote network APIs.
- **Benefit**: Offline dictionary hit-rate improves by ~35% on classic literature.

---

## 4. The v1.6 Plugin Architecture Foundation

To ensure that plugins in v1.6 cannot corrupt the database or crash the reader viewport, Theorem establishes strict architectural contracts:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           v1.6 PLUGIN RUNTIME CONTRACT                          │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  1. Declarative Viewport Slot Isolation (Foliate Overlayer SVG)                 │
│     • Plugins NEVER touch chapter <iframe> DOM directly.                        │
│     • Reader provides dedicated React / SVG overlay slot:                       │
│       `registerReaderOverlay({ id, render: (viewport) => ReactNode })`          │
│     • Guarantees Foliate's multi-column pagination never crashes.               │
│                                                                                 │
│  2. Sandboxed Namespaced Storage                                                │
│     • Plugins receive isolated SQLite tables: `plugin_<id>_kv`.                 │
│     • Strict capability manifest: `permissions: ["annotations:read"]`.         │
│                                                                                 │
│  3. Strongly-Typed Event Bus                                                    │
│     • `app.on("before:page-turn", (event) => ...)` (cancellable)                │
│     • `app.on("highlight:create", (highlight) => ...)`                          │
│     • `app.on("book:open", (book) => ...)`                                      │
│                                                                                 │
│  4. Native Rust Extensibility Hooks                                             │
│     • Custom Format Loaders (`registerFormatLoader({ ext, loader })`)           │
│     • Custom Exporters (`registerVaultExporter({ id, handler })`)               │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Phased Implementation Roadmap

### Milestone 1: Theorem v1.5.2 — Reader Stabilization & Core Rust Modules
*Goal: Bulletproof cross-page highlighting, eliminate IPC export lag, and unify speech normalization.*

1. **Cross-Page & Cross-Column Highlighting Engine**:
   - Implement disjoint line-box rendering in [`foliate-js-runtime/overlayer.js`](file:///run/media/sapiens/Development/Fundaments/Theorem/src/features/reader/foliate-js-runtime/overlayer.js) using `Range.getClientRects()`.
   - Prevent navigation oscillation in `goToAnnotation()` by anchoring to the start CFI node.
   - Enhance [`src-tauri/src/epubcfi.rs`](file:///run/media/sapiens/Development/Fundaments/Theorem/src-tauri/src/epubcfi.rs) with CFI range splitting and comparison.
2. **Native Vault & Lemma Deck Exporter (`vault_export.rs`)**:
   - Move markdown generation and disk writes from `vault-sync.ts` into a single parallel Rust command.
3. **Native Audio Text Normalizer (`text_normalizer.rs`)**:
   - Port number/abbreviation expansion to Rust; unify live Supertonic TTS and companion audiobook generation.
4. **Native Cover Downsampler (`image_ops.rs`)**:
   - Replace off-screen HTML canvas resizing with native Rust `image` decoding and WebP encoding.
5. **Native RSS XML Parser (`rss_parser.rs`)**:
   - Replace `fast-xml-parser` and `markdown-it` in `RssService.ts` with Rust `quick-xml`, trimming ~175 KB from frontend bundle.

---

### Milestone 2: Theorem v1.5.3 — Data Layer Hardening & P2P Sync Architecture
*Goal: Transition SQLite to single source of truth and eliminate sync LWW collisions.*

1. **Atomic Item-Level Iroh Sync**:
   - Break monolithic `annotations` and `collections` sync keys into `anno:<id>` and `coll:<id>`.
2. **Native CRDT Sync Merger**:
   - Move three-way merging from `sync-import.ts` into `theorem-sync-core`. Rust applies updates directly into SQLite.
3. **SQLite Query Virtualization**:
   - Make SQLite the single source of truth; Zustand maintains only active window slices, enabling infinite library scaling.
4. **Offline Dictionary Lemmatizer (`lemmatizer.rs`)**:
   - Embed native morphological stemmer in Rust for StarDict and MDict lookups.

---

### Milestone 3: Theorem v1.6.0 — The Extensibility Release (Plugin Ecosystem)
*Goal: Launch the Theorem Plugin Engine and Community Ecosystem.*

1. **Plugin Runtime Loader**:
   - Create `PluginManager.ts` to scan, load, and hot-reload `$APPDATA/plugins/<plugin-id>/`.
2. **SDK & API Surface**:
   - Publish `@theorem/plugin-sdk` with `TheoremPlugin` base class, Event Bus, and Settings Tab abstractions.
3. **Declarative Reader Slots**:
   - Expose isolated overlay rendering in `FoliateEngine` and `PDFJsEngine` (enabling Bionic reading, translation, commentary).
4. **Community Plugin Directory**:
   - In-app plugin browser in Theorem Settings with 1-click install.
