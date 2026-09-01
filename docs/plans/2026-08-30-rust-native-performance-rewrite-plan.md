# Native Rust Performance Roadmap (Remaining Items)

**Status**: Active Roadmap  
**Area**: Rust Backend / Core Engines / OPDS / PDF Text Streaming  

---

## 1. Remaining Performance Subsystems

| Subsystem | Current JS Bottleneck | Proposed Rust Solution | Expected Speedup | Priority |
| :--- | :--- | :--- | :--- | :--- |
| **1. Streaming OPDS 1.2 Catalog Ingestion** | JS `XMLParser` parses 60,000+ item feeds in webview heap | Streaming `quick-xml` parser in Rust directly writing to SQLite cache | **15x** | 🥇 Next |
| **2. PDF Background Worker Pre-Warming** | Next page text layers and canvas frames parsed on demand | Background offscreen rasterization worker in Rust/Wasm pre-warming $N+1$ | **0ms flip latency** | 🥈 |
| **3. Rust Native EPUB CFI Locator (`epubcfi.rs`)** | JS DOM tree traversal calculates CFI ranges on selection | Bitwise tree walker indexing element offsets ahead of time | **10x** | 🥉 |

---

## 2. Technical Architecture for Remaining Work

### Subsystem 1: Streaming OPDS 1.2 Catalog Parser
- **Module**: `src-tauri/src/opds_parser.rs`
- **Command**: `fetch_and_parse_opds(url: String) -> Result<OpdsFeedDto, String>`
- **Workflow**:
  1. Stream OPDS XML directly from remote catalog into `quick-xml` event reader.
  2. Populate SQLite cache directly or return structured, paginated DTOs over IPC.
- **Expected Impact**: Ingestion speedup of **15x**; eliminates all UI stutter when browsing Project Gutenberg and Standard Ebooks feeds.

### Subsystem 2: Cover Image SQLite Deduplication
- **Workflow**: Convert base64 `covers.data_url` entries into content-addressed WebP files on disk in the application storage directory.
- **Expected Impact**: Reduces SQLite database storage footprint by another 20–30 MB.

---

## 3. Implementation Checklist

- [ ] Implement `src-tauri/src/opds_parser.rs` (`quick-xml` streaming catalog parser).
- [ ] Connect `DiscoverService.ts` to `fetch_and_parse_opds`.
- [ ] Implement cover image SQLite to disk deduplication migration.
