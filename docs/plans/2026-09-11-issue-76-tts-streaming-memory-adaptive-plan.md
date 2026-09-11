# Implementation Plan: Fast Streaming TTS, Memory Lifecycle, Audiobook Normalization & Adaptive Reading Time

**Date**: 2026-09-11  
**Target Issue**: #76  
**Scope**: 
1. Memory Lifecycle & Fast Streaming TTS Engine (Zero pauses, ONNX unload, 150MB cache cap)
2. Audiobook Experience - Text Normalization (Numbers to words, years, ordinals, abbreviations)
3. Adaptive Reading Time Engine (Rolling EMA WPM, chapter + book remaining time, TTS speed lock)

---

## Phase 1: Memory Lifecycle & Fast Streaming TTS Engine

### 1.1 Rust Backend (`src-tauri/src/supertonic.rs` & `src-tauri/src/lib.rs`)
- **`tts_engine_unload` Command**:
  - Implements `desktop::unload_engine()` which acquires `ENGINE.lock()` and replaces it with `None`.
  - Drops the 4 ONNX sessions (`dp`, `text_encoder`, `vector_estimator`, `vocoder`), releasing 350–500MB of process memory back to the OS.
  - Registered in `lib.rs` `generate_handler!`.
- **Intra-chunk Silence Reduction**:
  - Reduce silence from 300ms (`0.3 * sample_rate`) to natural conversational cadence of 80ms (`0.08 * sample_rate`).
- **Disk Cache Cap & Async Trimming**:
  - Reduce `CACHE_LIMIT_BYTES` from 1GB to 150MB.
  - Perform `trim_cache` asynchronously in a detached task every N syntheses rather than synchronously on every sentence.

### 1.2 Frontend Pipelined Streaming (`src/features/reader/audio/ImmersionPlayer.ts` & `Reader.tsx`)
- **2-Chunk Lookahead Pipeline**:
  - In `streamChunks`, eagerly synthesize chunk 1 *and* chunk 2 before playing chunk 0, maintaining at least 1-2 pre-synthesized chunks in rodio's queue.
  - Prevents queue drainage (underrun pauses) even on short 1-word sentences.
- **Prefetch Optimization**:
  - In `prefetch()`, only synthesize the first sentence of upcoming text into cache instead of full 2,500 character blocks.
- **Auto-Unload on Idle/Close**:
  - After 90 seconds of pause/idle, or immediately when unmounting the reader, invoke `tts_engine_unload`.

---

## Phase 2: Audiobook Experience - Text Normalization

### 2.1 Normalization Engine (`src/features/reader/audio/text-normalization.ts`)
- **Numbers to Words**:
  - Cardinals: `1` -> "one", `12` -> "twelve", `1234` -> "one thousand two hundred thirty-four".
  - Large numbers up to trillions supported.
- **Years & Decades**:
  - Four-digit years: `1984` -> "nineteen eighty-four", `2024` -> "twenty twenty-four", `1800s` -> "eighteen hundreds".
- **Ordinals**:
  - `1st` -> "first", `2nd` -> "second", `3rd` -> "third", `21st` -> "twenty-first".
- **Roman Numerals in Headings**:
  - `Chapter IV` -> "Chapter four", `Act II` -> "Act two", `Henry VIII` -> "Henry the eighth".
- **Currencies & Percentages**:
  - `$50` -> "fifty dollars", `€12.50` -> "twelve euros fifty cents", `75%` -> "seventy-five percent".
- **Abbreviations & Common Shorthands**:
  - `Dr.` -> "Doctor", `Mr.` -> "Mister", `Mrs.` -> "Missus", `Ms.` -> "Miz", `e.g.` -> "for example", `i.e.` -> "that is", `etc.` -> "et cetera", `vs.` -> "versus".

---

## Phase 3: Adaptive Reading Time Engine

### 3.1 Speed Tracking (`src/features/reader/hooks/useReadingTime.ts`)
- Compute words displayed per page.
- On page turn (with dwell time > 5s and < 180s), calculate instant WPM.
- Update rolling exponential moving average: `WPM = 0.85 * prevWPM + 0.15 * pageWPM` (clamped to 100–700 WPM).
- Persist in `useSettingsStore` under `stats.readingSpeedWpm`.

### 3.2 Display & Immersion Sync (`src/features/reader/components/progress/ReaderNavbar.tsx`)
- Read remaining words in current chapter and remaining words in book.
- When immersion TTS is active:
  $$\text{Time} = \frac{\text{Words Remaining}}{160 \times \text{Speed}}$$
- Render adaptive remaining time with chapter scope: `"14 min left in chapter · 2 hr left in book"`.

---

## Verification & Quality Gates
1. Unit tests for text normalization (`tests/text-normalization.test.ts`).
2. Unit tests for adaptive reading time calculations (`tests/reading-time.test.ts`).
3. Quality gates: `pnpm typecheck`, `pnpm test`, `cargo fmt --check`, `cargo clippy`, `cargo check`.
