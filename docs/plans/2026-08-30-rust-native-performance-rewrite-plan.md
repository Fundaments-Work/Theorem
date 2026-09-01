# Native Rust Performance Roadmap (Remaining Items)

**Status**: Active Roadmap  
**Area**: Rust Backend / Core Engines / PDF Pre-Warming / Cover Deduplication  

---

## 1. Remaining Performance Subsystems

| Subsystem | Current State | Proposed Solution | Expected Impact | Priority |
| :--- | :--- | :--- | :--- | :--- |
| **1. PDF Background Worker Pre-Warming** | Next page text layers and canvas frames parsed on demand | Background offscreen rasterization worker in Rust/Wasm pre-warming $N+1$ | **0ms flip latency** | 🥇 Next |
| **2. Rust Native EPUB CFI Locator (`epubcfi.rs`)** | JS DOM tree traversal calculates CFI ranges on selection | Bitwise tree walker indexing element offsets ahead of time | **10x** | 🥈 |
| **3. Cover Image SQLite Deduplication** | Base64 strings stored in `covers.data_url` | Store content-addressed WebP files directly in app storage | **20–30 MB SQLite savings** | 🥉 |

---

## 2. Implementation Checklist

- [ ] Implement PDF background worker pre-warming for $N+1$ canvas frames.
- [ ] Implement Rust native EPUB CFI locator (`epubcfi.rs`).
- [ ] Implement cover image SQLite to disk deduplication migration.
