# Native Rust Performance Roadmap

**Status**: Partially implemented · remaining items are scoped below

## 1. EPUB CFI Locator (`epubcfi.rs`) — core implemented ✅

`src-tauri/src/epubcfi.rs` is a Rust-native CFI parser/resolver (spine path,
content steps, character offsets, ID assertions, range-to-start) with unit
tests. Consumed by the CLI (`theorem read <book-id> --cfi "..."`).

- [x] Parser + resolver + minimal XML tree walker (`epubcfi.rs`).
- [ ] GUI selection-side generation: the reader still computes CFI ranges via
      JS DOM traversal. Wiring selection -> `epubcfi.rs` requires streaming the
      spine HTML the pre-parser already fetches into an index — measure whether
      IPC overhead justifies it before building.

## 2. PDF Background Worker Pre-Warming — not started

- [ ] Offscreen rasterization of page N+1 (and N+2) while the reader is idle.
      `prewarmPdfJsRuntime` only warms the worker script, not page frames.
      Design: a Web Worker pool owning offscreen canvases, driven by the
      PDF engine's scroll direction. Expected: 0ms flip latency.

## 3. Cover Image SQLite -> Disk Deduplication — measured, deferred

Real-world measurement (234 covers): **14.3 MB** of `covers.data_url` in
SQLite — far below the plan's 20-30 MB estimate. Moving covers to disk would
break the sync invariant that `data:` cover paths propagate in sync payloads
(covers must stay self-contained in SQLite for cross-device merges).
**Recommendation: keep covers in SQLite.** Revisit only if cover-heavy
libraries (>1000 books) show real bloat.
