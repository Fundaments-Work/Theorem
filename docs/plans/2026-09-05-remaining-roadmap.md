# Remaining Roadmap — What's Left & Next Required Plans

**Date**: 2026-09-05 · **Status**: Active roadmap (supersedes scattered open items)

---

## 1. State of existing plans

| Plan | Status |
| :--- | :--- |
| Android size optimization | ✅ Done — two device/CI verification items left below |
| Companion audiobook & immersion | ✅ Phases 1–3 done — Android generation + 2 polish items left |
| Headless CLI & TUI | ✅ Done — HUFF/CDIC MOBI decompression left |
| Unbreakable P2P sync | ✅ Done (hardened; rejected items documented) |
| Rust native perf rewrite | ✅ Done except PDF pre-warming (measure-first) |
| Plugin extensibility | ⏸️ Parked blueprint — intentionally unimplemented |

## 2. Carried-over items (small, from old plans)

- [ ] **PDF page-flip pre-warming** — instrument flip latency on a large PDF first; only build the worker pool if it exceeds ~100ms (`rust-native-performance-rewrite-plan.md`).
- [ ] **HUFF/CDIC MOBI decompression** — at least one real library book fails to extract text (`headless-cli-architecture.md` §9).
- [ ] **Android CI size benchmark** — record before/after APK byte sizes on `aarch64-linux-android` (`android-size-optimization-plan.md`).

## 3. New plan A — Android neural & audiobook parity (utmost required)

Everything is built but unverified end-to-end on a real device, and
generation is desktop-only. Goal: neural narration + audiobooks work on
Android exactly as on desktop.

- [ ] **On-device validation**: sideload Theorem + Theorem Neural Voice
  (v3.2.7-theorem.1), verify engine discovery/selection via Settings,
  narration quality, word-boundary events, and engine persistence across
  restarts. Fix whatever surfaces in `TtsAudioPlugin.kt`.
- [ ] **Android audiobook generation**: batch `synthesizeToFile` per chapter
  with the selected engine (already exposed by the plugin), then reuse the
  existing Opus/`BookAudioTrack` pipeline; replace the desktop-only error
  stubs in `audiobook_gen.rs` for the synthesis source (Opus encode can run
  on Android — audiopus targets it).
- [ ] **Companion app release signing**: debug-signed APK today; add a
  self-managed release keystore + `assembleRelease` before wide
  distribution (workspace signing secrets are off-limits per security
  rules — keep keys local). F-Droid metadata (fastlane) refresh for the
  rebranded fork.
- [ ] **Slow-phone guardrails**: 8-step denoising may be too heavy on
  low-end devices — expose a quality/step setting or auto-detect.

## 4. New plan B — Immersion streaming robustness

The desktop streaming player (first chunk plays immediately, rest queues)
needs polish for long pages and slow synthesis:

- [ ] **Underrun guard**: if the queue empties while chunks are still
  synthesizing, insert a short silence and resume instead of risking a
  stall; consider synthesizing one chunk ahead of playback.
- [ ] **Cross-chunk progress/seek**: rodio's `get_pos()` resets per queued
  source — map position/seek across the chunk list so the scrubber and
  word timing stay linear.
- [ ] **Next-page prefetch wiring**: `tts_prefetch` exists end-to-end but is
  not called by the reader yet; prefetch the next section's first chunks
  while the current page plays.

## 5. New plan C — Release freshness guard

The desktop icon launches a release binary with the UI embedded; code
changes make it silently stale (this caused the "localhost refused"
confusion and the missing streaming fix in the installed app).

- [ ] Show the build date/git hash in Settings → About (baked via
  `env!("VERGEN")`-style build script or a compile-time env) so a stale
  binary is visible.
- [ ] Document/automate the refresh flow: `pnpm build && (cd src-tauri &&
  cargo build --release)` re-embeds the UI; CI release artifacts remain the
  canonical install.

## 6. Parked (do not start without a decision)

- Plugin extensibility blueprint (`2026-08-30-plugin-extensibility-architecture.md`).
- GUI selection → Rust CFI generation, cover dedup, and other closed items
  in their respective plans.
