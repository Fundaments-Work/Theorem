# Native Rust Performance Roadmap

**Status**: ✅ Mostly done — one item deliberately deferred (PDF pre-warming,
pending a latency measurement). Closed items are listed at the bottom so
they are not re-proposed without new evidence.

## 1. EPUB CFI Locator (`epubcfi.rs`) — ✅ done

`src-tauri/src/epubcfi.rs` (parser/resolver + unit tests) is consumed by the
CLI (`theorem read <book-id> --cfi "..."`). Closed.

## 2. PDF Background Worker Pre-Warming — the one remaining item

`prewarmPdfJsRuntime` only warms the worker script; pages still render on
demand. Implement offscreen rasterization of page N+1 (and N+2) in a Web
Worker pool driven by scroll direction. Only worth doing if measured flip
latency on large PDFs exceeds ~100ms — instrument first.

- [ ] Measure current page-flip latency on a large PDF (bench page in dev).
- [ ] If warranted: worker pool with offscreen canvases, N+1/N+2 pre-render.

## Closed (decided against — do not re-add without new evidence)

- **Cover SQLite -> disk dedup**: measured 14.3 MB real data (plan claimed
  20-30 MB); moving covers to disk breaks the sync invariant that `data:`
  cover URLs propagate to peers. Keep covers in SQLite.
- **GUI selection -> Rust CFI generation**: CFI is computed once per human
  selection; JS DOM traversal is adequate. Rust-side generation gains nothing
  user-perceivable.
