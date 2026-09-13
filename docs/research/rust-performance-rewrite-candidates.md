# Rust Performance Rewrite Candidates for Theorem v1.5.2

## Executive Summary

Theorem utilizes a hybrid architecture: a React 19 / TypeScript frontend running inside a WebKit/Blink webview, backed by a multi-threaded Rust backend powered by Tauri 2. 

Over progressive releases, heavy subsystems—such as SQLite persistence, memory-mapped MDict/StarDict dictionaries, Supertonic ONNX neural voice inference, rodio audio playback, batch library ingestion, and in-book streaming search—have moved to native Rust. However, several compute-, string-, and I/O-intensive operations remain in TypeScript. Many of these execute synchronously on the JavaScript main thread or incur excessive inter-process communication (IPC) round-trips across the Tauri serialization boundary.

This research analyzes **small, targeted, high-leverage** candidates that can be ported from TypeScript to Rust in **v1.5.2** alongside cross-page highlighting. The goal is to maximize UI smoothness, eliminate main-thread stalls, reduce JavaScript bundle size, and reuse existing Rust dependencies (`image`, `quick-xml`, `rayon`, `regex`, `rusqlite`).

---

## Candidate Analysis

### 1. Vault Markdown & Lemma Flashcard Export Engine

- **Current TS Location**: [`src/core/lib/vault-sync.ts:388-677`](file:///run/media/sapiens/Development/Fundaments/Theorem/src/core/lib/vault-sync.ts#L388-L677)
- **Current Architecture & Bottlenecks**:
  - The frontend formats book notes (`buildBookPageMarkdown`) and Lemma flashcards (`buildVocabularyMarkdown`) via JavaScript string concatenation.
  - It writes individual `.md` files to the filesystem using `@tauri-apps/plugin-fs` in batches of 16 (`syncVaultMarkdownSnapshot`).
  - **IPC Overhead**: For a library with 60 books and 500 annotations, the webview serializes 60+ full markdown payloads into JSON, transmits them over the Tauri IPC channel (`plugin:fs|writeTextFile`), and deserializes them in Rust before writing to disk.
  - **Main Thread Contention**: With reactive auto-sync running on a 2-second debounce, heavy string formatting and IPC dispatch can cause micro-stutters while the user is actively reading and highlighting.
- **Proposed Rust Implementation**:
  - New command: `export_vault_markdown(options: VaultExportPayload) -> Result<VaultExportStats, String>`.
  - Alternatively, Rust reads annotations, books, and vocabulary directly from SQLite (`database.rs`) without needing the frontend to serialize the entire library state over IPC.
  - Rust formats markdown into pre-allocated string buffers (`String::with_capacity` / `write!`) and writes files concurrently using `rayon::prelude::*` and `std::fs::write`.
- **Expected Impact**:
  - File generation and I/O drops from ~250ms to <5ms.
  - Reduces IPC traffic from $N$ file write calls to a single fire-and-forget command.
  - Completely frees the JavaScript UI thread from markdown formatting overhead.
- **Implementation Scope**: Small (~200 lines of idiomatic Rust).

---

### 2. Audio Text Normalization for TTS & Audiobook Generation

- **Current TS Location**: [`src/features/reader/audio/text-normalization.ts:1-297`](file:///run/media/sapiens/Development/Fundaments/Theorem/src/features/reader/audio/text-normalization.ts#L1-L297)
- **Current Architecture & Bottlenecks**:
  - Normalizes text before feeding it to Text-to-Speech (Immersion Reading).
  - Handles number-to-words (`1984` $\rightarrow$ "nineteen eighty-four"), ordinals (`1st` $\rightarrow$ "first"), Roman numerals (`Chapter IV`), currency (`$12.50`), abbreviations (`Dr.`, `etc.`), and special symbols using chained regular expressions.
  - **Duplication Bug Risk**: The companion audiobook generator (`src-tauri/src/audiobook_gen.rs:1-505`) runs entirely in Rust background threads. Because the normalizer currently lives in TypeScript, offline companion audiobook generation either bypasses text normalization or requires the frontend to pre-normalize every section before initiating the job.
  - **Garbage Collection**: Normalizing multi-thousand-word chapters generates dozens of intermediate string allocations per sentence on the V8 heap.
- **Proposed Rust Implementation**:
  - Implement `src-tauri/src/text_normalizer.rs` using native Rust pattern matching and the compiled `regex` crate.
  - Expose a single command `tts_normalize_text(text: String) -> String` for the webview player, and invoke the function directly within `audiobook_gen.rs` and `supertonic.rs`.
- **Expected Impact**:
  - $20\times$ faster string processing with zero V8 GC pressure.
  - Guarantees 100% normalization consistency between live Immersion Reading and background companion audiobook encoding.
- **Implementation Scope**: Small (~250 lines of Rust, with existing test vectors ported from `tests/text-normalization.test.ts`).

---

### 3. Book Cover Resizing & WebP Transcoding

- **Current TS Location**: [`src/core/lib/storage.ts:365-419`](file:///run/media/sapiens/Development/Fundaments/Theorem/src/core/lib/storage.ts#L365-L419)
- **Current Architecture & Bottlenecks**:
  - `downsampleCoverImage` uses the browser DOM: creates an off-screen `HTMLCanvasElement`, loads image bytes via `URL.createObjectURL`, draws the image, and encodes to WebP via `canvas.toBlob('image/webp', 0.75)`.
  - Decoding large book covers (e.g., 8–15 MB high-resolution cover art from EPUBs or PDFs) and drawing them onto a canvas blocks the main JavaScript thread, resulting in noticeable UI freezes during book import or cover editing.
- **Proposed Rust Implementation**:
  - Theorem already depends on the `image` crate in `src-tauri/Cargo.toml` (utilized in `batch_ingest.rs`).
  - Command: `downsample_cover_image(image_bytes: Vec<u8>, max_width: u32, max_height: u32) -> Result<Vec<u8>, String>`.
  - Performs decoding, thumbnail scaling (via fast SIMD filtering), and WebP/JPEG encoding entirely on a background thread pool without touching the DOM.
- **Expected Impact**:
  - Eliminates main-thread canvas locking during book additions and cover editing.
  - Reduces memory overhead by deallocating large uncompressed bitmap buffers immediately after transcoding.
- **Implementation Scope**: Very Small (~60 lines of Rust).

---

### 4. RSS / Atom XML Feed Parsing & Sanitization

- **Current TS Location**: [`src/core/services/RssService.ts:1-868`](file:///run/media/sapiens/Development/Fundaments/Theorem/src/core/services/RssService.ts#L1-L868)
- **Current Architecture & Bottlenecks**:
  - The TypeScript service imports `fast-xml-parser` (73.36 KB bundled) and `markdown-it` (102.38 KB bundled) into the frontend chunk (`dist/assets/fxp-vPGIDiwM.js` and `dist/assets/markdown-it-BVcQdzKk.js`).
  - Parsing large, multi-megabyte XML feeds with deeply nested CDATA, HTML entities, and author structures causes noticeable GC spikes in V8.
  - Meanwhile, Rust already contains `quick-xml` (used in `opds_parser.rs:1-559` and `epub_parser.rs`) and `reqwest`.
- **Proposed Rust Implementation**:
  - Create `src-tauri/src/rss_parser.rs` leveraging the existing `quick-xml` parser to extract RSS 2.0 and Atom feeds into typed DTOs.
  - Add Tauri command: `fetch_and_parse_rss_feed(url: String) -> Result<ParsedRssFeedDto, String>`.
- **Expected Impact**:
  - Shaves **~175 KB of minified JS** from the frontend bundle by eliminating `fast-xml-parser` and `markdown-it`.
  - $15\times$ faster XML parsing and feed traversal.
  - Prevents UI freezing when auto-refreshing dozens of subscribed feeds on startup.
- **Implementation Scope**: Medium (~350 lines of Rust, following the pattern of `opds_parser.rs`).

---

### 5. Multi-Entity CRDT / LWW Sync Payload Merger

- **Current TS Location**: [`src/core/lib/sync-import.ts:1-549`](file:///run/media/sapiens/Development/Fundaments/Theorem/src/core/lib/sync-import.ts#L1-L549)
- **Current Architecture & Bottlenecks**:
  - All peer-to-peer sync data arrives natively in Rust via Iroh (`src-tauri/src/iroh_sync.rs` and `src-tauri/src/sync_commands.rs`).
  - **Current Roundtrip**: Rust receives Iroh document entries $\rightarrow$ serializes them as raw JSON strings $\rightarrow$ sends them over IPC to TypeScript $\rightarrow$ TypeScript parses the JSON into thousands of JS objects $\rightarrow$ TypeScript executes Last-Write-Wins (LWW) date comparisons and tombstone filtering across 8 entity types $\rightarrow$ TypeScript calls `sqlite_save_...` Tauri commands to write the merged entities *back* to SQLite.
- **Proposed Rust Implementation**:
  - Move the CRDT/LWW merge algorithms into Rust (`src-tauri/crates/theorem-sync-core` or `src-tauri/src/sync_merge.rs`).
  - When an Iroh sync document update fires, Rust performs the merge directly in native memory and executes atomic SQLite batch upserts in a single database transaction.
  - Only a lightweight notification event (e.g. `sync-applied { updated_books: 3, updated_annotations: 12 }`) is emitted to update the Zustand UI store.
- **Expected Impact**:
  - Completely eliminates the double IPC roundtrip (`Rust -> TS -> Rust`).
  - Drastically reduces memory usage during large initial device pairings (e.g. syncing 500+ books and thousands of annotations).
- **Implementation Scope**: Medium (~400 lines of Rust in `theorem-sync-core`).

---

### 6. EPUB CFI Range Splitting for Cross-Page Highlighting

- **Current TS Location**: `src/features/reader/foliate-js-runtime/epubcfi.js`
- **Rust Backend**: [`src-tauri/src/epubcfi.rs:1-360`](file:///run/media/sapiens/Development/Fundaments/Theorem/src-tauri/src/epubcfi.rs#L1-L360)
- **Relevance to v1.5.2 Cross-Page Highlighting**:
  - Cross-page highlighting requires splitting a single logical annotation that spans from spine section $A$ (or page $N$) into spine section $B$ (or page $N+1$) into two sub-ranges, or computing the common parent anchor.
  - The Rust backend already implements an EPUB CFI parser (`epubcfi.rs`). Expanding `epubcfi.rs` with CFI range comparison (`compare(cfi1, cfi2)`) and CFI range division allows instant validation and sorting of cross-boundary CFI ranges.
- **Expected Impact**:
  - Guarantees mathematically correct CFI sorting and range validation for cross-page annotations without brittle client-side regex manipulation.
- **Implementation Scope**: Small (~100 lines added to `epubcfi.rs`).

---

## Comparison & Feasibility Matrix

| Candidate | Effort | Performance / Latency Gain | Bundle Reduction | Risk | Recommended for v1.5.2 |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **1. Vault Markdown Export** | Low (1-2 days) | High ($50\times$ faster, eliminates $N$ IPC writes) | Low | Very Low | **Yes (High Priority)** |
| **2. Audio Text Normalization** | Low (1 day) | High ($20\times$ faster, unifies live TTS & audiobooks) | Minor | Very Low | **Yes (High Priority)** |
| **3. Cover Downsample & WebP** | Very Low (<1 day) | High (Zero main-thread canvas locking) | Minor | Very Low | **Yes (High Priority)** |
| **4. RSS Feed XML Parser** | Medium (2-3 days) | High ($15\times$ faster, eliminates GC spikes) | **High (~175 KB)** | Low | **Yes (Recommended)** |
| **5. Native CRDT Sync Merger**| Medium (3-4 days) | Very High (Eliminates double IPC hop) | Moderate | Medium | Defer to v1.5.3 (Keep v1.5.2 focused) |
| **6. CFI Range Splitting** | Low (1-2 days) | Medium (Mathematical robustness) | Minor | Very Low | **Yes (Core part of v1.5.2)** |

---

## Proposed Roadmap for Theorem v1.5.2

For **v1.5.2**, we recommend bundling the following focused Rust optimizations together with Cross-Page Highlighting:

1. **Cross-Page & Cross-Column Highlighting Engine**:
   - Implement disjoint line-box drawing via `Range.getClientRects()` in `foliate-js-runtime/overlayer.js`.
   - Add auto-paging coordination for Immersion Reading (TTS) when sentences cross page breaks.
   - Enhance `src-tauri/src/epubcfi.rs` with CFI range comparison and sub-range partitioning.
2. **Native Vault Export Command (`vault_export.rs`)**:
   - Move markdown generation and disk writes from `vault-sync.ts` into a single parallel Rust command.
3. **Native Audio Text Normalizer (`text_normalizer.rs`)**:
   - Move regex/number expansion to Rust to unify Immersion Reading and companion audiobook generation.
4. **Native Cover Downsampler (`image_ops.rs`)**:
   - Replace off-screen HTML canvas resizing with native Rust `image` decoding and WebP encoding.
5. **Native RSS Parser (`rss_parser.rs`)**:
   - Replace `fast-xml-parser` and `markdown-it` in `RssService.ts` with Rust `quick-xml`, trimming ~175 KB from the frontend bundle.
