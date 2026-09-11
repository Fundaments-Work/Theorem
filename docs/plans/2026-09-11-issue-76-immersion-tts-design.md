# Design Document: Immersion Reading Enhancement (Issue #76)

**Date**: 2026-09-11  
**Target**: Fundaments-Work/Theorem #76  
**Status**: Approved & In Progress  

---

## 1. Overview & Goals

Immersion Reading synchronizes Text-to-Speech (TTS) narration with visible text on screen. 
Prior issues:
1. **No visual tracking**: Spoken text is not highlighted as it is read.
2. **Jerky page transitions**: Audio completely stops on page completion, advances the reader, and synthesizes the next page from scratch, causing an awkward 1.5–2s stall between pages.
3. **Prefetch dead-code**: `getNextPageTextForTts()` queried non-existent `.tts-word` elements, preventing background synthesis.

### Goals
- **Sentence-level karaoke highlighting**: Subtle translucent highlight background matching current reader theme (light/dark/sepia).
- **Auto page turning**: Page turns immediately when narration crosses to the next sentence on that page, keeping the view in sync with the spoken audio.
- **Continuous scroll support**: In scroll mode, automatically and smoothly scrolls the active sentence into view.
- **Gapless playback**: Audio streams continuously between pages with prefetching and queued continuation.

---

## 2. Architecture & Components

### 2.1 Backend / Rust (`src-tauri/src/audio_player.rs`)
- Expose the currently playing sentence chunk index in `tts_audio_status`:
  ```rust
  #[derive(Serialize)]
  pub struct AudioStatus {
      pub position: f64,
      pub duration: f64,
      pub chunk_index: usize,
      pub finished: bool,
  }
  ```
- Because `NativePlayer` tracks per-chunk durations (`durations: Vec<f64>`) and queue length (`player.len()`), `chunk_index` is computed directly as `durations.len().saturating_sub(player.len())`.

### 2.2 ImmersionPlayer (`src/features/reader/audio/ImmersionPlayer.ts`)
- Track sentence boundaries for the spoken text.
- Add `onSentenceChange?: (sentenceIndex: number, sentenceText: string, progressFraction: number) => void` callback to `PlaybackCallbacks`.
- **Desktop Supertonic**: Map the active `chunk_index` reported from `tts_audio_status` to the current sentence index.
- **Android Native TTS**: Listen to `tts-utterance-range` (`start`, `end`) character offsets and map to the current sentence index.
- **Gapless prefetch & transition**: Trigger next-page prefetch when approaching the end of current page audio, and smoothly continue audio into the next page.

### 2.3 Foliate Engine (`src/features/reader/engines/foliate-engine.ts`)
- Fix `getNextPageTextForTts()`:
  - Remove dead `.tts-word` query.
  - Traverse content nodes following `visibleRange.endContainer` to extract upcoming page text.
- Add `highlightSentence(sentenceText: string, sentenceIndex: number)`:
  - Find matching DOM range using text matching / `Intl.Segmenter`.
  - Draw highlight non-destructively using Foliate's `Overlayer` (`overlayer.add('tts-active-sentence', range, Overlayer.highlight, { color })`).
  - Check whether the sentence range extends onto the next page (`range.compareBoundaryPoints(Range.START_TO_END, visibleRange) > 0`). If so, invoke `next()` immediately.
  - In scroll mode, call `range.commonAncestorContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' })`.
- Add `clearSentenceHighlight()`:
  - Clears `'tts-active-sentence'` overlay on pause/stop or page leave.

### 2.4 Reader Viewport & Reader (`src/features/reader/Reader.tsx`)
- Register `onSentenceChange` in `immersionPlayer.init(...)`.
- Forward active sentence to `foliate-engine`.
- Smooth page transitions and state synchronization.

---

## 3. Verification Plan
- Unit/integration tests:
  - Verify sentence boundary mapping in `ImmersionPlayer`.
  - Verify `getNextPageTextForTts` on Foliate DOM mock.
  - Verify Rust `audio_player` status command.
- Quality gates:
  - `pnpm typecheck`
  - `pnpm test`
  - `cd src-tauri && cargo fmt --check && cargo clippy && cargo check`
