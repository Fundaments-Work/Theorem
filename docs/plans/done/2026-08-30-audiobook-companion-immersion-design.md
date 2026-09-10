# Technical Design: Companion Audiobook & Immersion Player Integration

**Document:** `docs/plans/done/2026-08-30-audiobook-companion-immersion-design.md`
**Status:** ✅ Implemented (shipped in v1.4.0 — see [audiobook.md](../../audiobook.md))
**Target Milestone:** v1.4.0

---

## 0. Neural TTS Engine (Supertonic 3) — Research & Plan

*Added 2026-09-03 from in-depth research. The immersion reader's current TTS
path is page-chunked platform TTS with completion **guessed by a timer** (no
real audio, no word boundaries). This section defines the replacement engine
and the "Save as Audiobook" generation pipeline; sections 1-5 below (companion
playback of user-supplied files) remain unchanged as Phase 2.*

### 0.1 Research summary

- **Supertonic 3** ([supertone-inc/supertonic](https://github.com/supertone-inc/supertonic),
  [HF weights](https://huggingface.co/Supertone/supertonic-3)): 99M-param
  on-device ONNX TTS, 44.1kHz mono float PCM out. Extremely fast on CPU
  (RTF ~0.3x on an e-reader, 1000+ chars/s on M1).
- **One shared multilingual model** — 31 languages live in the same weights, so
  language subsetting is impossible; per-file granularity is voices only
  (M1-M5 / F1-F5, ~292KB each).
- **fp32 assets (~400MB)**: duration_predictor 3.7MB, text_encoder 36.4MB,
  vector_estimator 257MB, vocoder 101MB, + `tts.json` / `unicode_indexer`.
- **Licensing**: code MIT, weights **OpenRAIL-M** — mirroring in our own repo is
  compliant; ship the license with the download and pass use restrictions through.
- **Upstream archived July 2026** — weights are frozen assets, so fork-hosting
  is permanently stable.
- **int8 quantization, WASM, and WebGPU were evaluated and rejected** after
  real-world testing (the browser demo lagged even on a laptop; quality and
  speed unacceptable). Native inference only.
- **fp32 on Android is proven**: the Play Store Supertonic app and
  [ouor/supertonic-android](https://github.com/ouor/supertonic-android) both
  ship the fp32 set and run it natively on phones (arm64-v8a, minSdk 28). The
  257MB vector estimator is memory-mapped by ONNX Runtime (weights paged on
  demand); denoise steps are tunable as a low-RAM fallback.
- **Reference implementation**: ouor/supertonic-android — bundled
  `onnxruntime-android`, models downloaded on first run (resumable,
  integrity-checked), 4-model pipeline → float PCM via AudioTrack.

### 0.2 Desktop engine (Phase 1)

- **Rust `ort` crate with `load-dynamic`**: the ONNX Runtime dylib itself is
  **downloaded at first use** from our releases (`ORT_DYLIB_PATH`) — nothing
  ships with the app.
- **Download layer** (`src-tauri/src/tts_model.rs`): clone of the dictionary
  download machinery (`download_and_extract_stardict` — streaming, progress
  events, cancel) **plus SHA-256 verification** against a manifest compiled
  into the app. Storage: `app_data_dir()/tts/{runtime,models,voices}`, KV
  manifest `theorem-tts:manifest`.
- **Synthesis pipeline** (`src-tauri/src/supertonic.rs`): text → duration
  predictor → text encoder → vector estimator (denoise steps) → vocoder →
  44.1kHz f32 PCM. Sentence chunker (<300 chars).
- **Cache + prefetch**: synthesized audio keyed by SHA-256(text+voice+speed)
  in the blob store (LRU cap ~1GB, configurable) → instant resume/replay;
  `tts_prefetch(next_page)` runs while the current page plays → zero-gap
  audiobook feel.
- **Full replacement on desktop**: once the voice is installed, the immersion
  reader uses it exclusively (platform TTS remains the not-yet-installed
  fallback prompt). `ImmersionPlayer.ts` plays real audio via
  `AudioContext.decodeAudioData` — the guessed-timer state machine is deleted;
  pause/resume/seek become real audio operations; word highlighting maps word
  positions over the actual buffer duration.

### 0.3 Android — own companion engine app (decided)

**Caveat, documented explicitly: on Android the user must install a separate
companion app** — "Theorem Neural Voice" — for neural TTS. This is unavoidable:
Android 10+ blocks loading native runtimes downloaded into app-writable
storage (so there is no runtime-download path), and we deliberately bundle no
ONNX Runtime to keep the ~38MB APK unchanged. Without the companion app,
Android keeps the current platform voice.

- Fork brahmadeo's FOSS Supertonic engine app (F-Droid,
  `com.brahmadeo.supertonic.tts`) as **"Theorem Neural Voice"** under
  `fundaments-work`, pointing its model downloads at our
  `supertonic-assets` repo. The engine app registers as a system Android TTS
  engine and manages its own model download.
- Theorem side: extend `tauri-plugin-android-tts-audio` —
  `tts_get_engines` (enumerate installed engine apps),
  `tts_set_engine(package)` (re-init `TextToSpeech(context, listener,
  enginePackage)`, persisted), `tts_get_voices` per selected engine. Settings
  recommends our engine with a direct install link when absent.
- **Known bug motivating this**: the current plugin binds the system-default
  engine once and caches the instance (`TtsAudioPlugin.kt`), so switching TTS
  engines silently fails today.
- Bonuses: `UtteranceProgressListener.onRangeStart` (API 26+) provides **real
  word boundaries** (true per-word highlighting), and `synthesizeToFile()`
  powers audiobook generation with any installed engine.

### 0.4 Save as Audiobook (Phase 3)

- Book menu action **"Generate Audiobook"**: batch-synthesize per chapter
  (desktop: Supertonic pipeline; Android: `synthesizeToFile` with the selected
  engine), then encode **Ogg Opus via native libopus** (~300KB dep —
  MediaRecorder was rejected because it encodes at 1× realtime; a 10-hour book
  would take 10 hours) at ~32-48kbps mono → ~15-20MB per finished hour.
- Output: `books/<id>/audiobook/ch-NNN.opus` + chapter marks stored in the
  `BookAudioTrack` schema (section 2) → immediately playable by the companion
  player. Background task with progress events, cancel, and pause/resume.

### 0.5 Hosting checklist — DONE

Published as [`fundaments-work/supertonic-assets`](https://github.com/fundaments-work/supertonic-assets)
release `v1` (21 assets): fp32 ONNX models + configs and voice styles
F1–M5 from `Supertone/supertonic-3`, per-OS ONNX Runtime 1.22.0 dylibs,
the OpenRAIL-M `LICENSE`, and a `SHA256SUMS` file. All SHA-256s are pinned
in `tts_model.rs`; release asset names are flat (GitHub limitation), mapped
to on-disk layout via each asset's `dest`. When bumping the bundle: upload
new assets under a new tag and update `ASSETS_TAG`, sizes and hashes in
`tts_model.rs` together (the ORT runtime version must stay compatible with
the `ort` crate).

### 0.6 Phase ordering — IMPLEMENTED

1. **Phase 1 — Engine (done)**: desktop download (`tts_model.rs`, SHA-256
   pinned manifest, progress events) + inference (`supertonic.rs`, ort
   load-dynamic, sentence chunking, 1GB WAV cache, prefetch); Android engine
   selection + `onRangeStart` + `synthesizeToFile` in the tts plugin;
   ImmersionPlayer on real audio via `AudioContext` (real pause/resume/seek,
   Android completion via `tts-utterance-done`, resume from last word
   boundary); voice picker + speed chips + neural-install prompt in the
   reader navbar; Neural Voice settings section (desktop) and TTS engine
   picker (Android).
2. **Phase 2 — Companion playback (done)**: `audiobook.rs` parses .m4b/.m4a/
   .mp3 duration, tags, cover and chapters (hand-rolled QuickTime chapter-
   track walker — no crate exposes them); books carry an optional synced
   `audioTrack`; attach/detach from the library context menu; the reader's
   immersion bar upgrades to a human-narrated player (scrubber, ±15s, speed,
   chapters, sleep timer, mediaSession, auto-save) — `AudiobookBar.tsx`
   replaced the unused ImmersionBar as the single player UI.
3. **Phase 3 — Generation (done, desktop)**: `audiobook_gen.rs` batch-
   synthesizes sections via the Supertonic engine and encodes one Ogg Opus
   per book (36kbps mono ≈ 16MB/hour) with chapter marks, then attaches it
   as the book's `audioTrack` (format `opus`). Hand-rolled Ogg muxer +
   audiopus/libopus (static vendored build, desktop-gated). Triggered from
   the reader's immersion bar for EPUBs; Android generation (via
   `synthesizeToFile`) deferred until the companion engine app ships —
   the app now exists (fundaments-work/supertonic-android, release
   v3.2.7-theorem.1), so this is the main open item (see
   2026-09-05-remaining-roadmap.md).

---

## 1. Overview & Vision

Instead of splitting audiobooks into a separate app, library tab, or complex server, Theorem treats **audiobooks as companion audio tracks attached directly to individual books**.

A user reading *Dune* or *The Hobbit* can attach a DRM-free `.m4b` or `.mp3` file to that book. When opening the book in Theorem, the existing **Immersion Reader (`ImmersionBar`)** automatically upgrades from synthetic Text-to-Speech (TTS) into a full-fidelity **Human Audiobook Player** with precision speed controls, chapter navigation, sleep timers, and cross-device sync via Iroh P2P.

```
                      ┌───────────────────────────────────────────────┐
                      │              HOW USERS ADD AUDIO              │
                      └───────────────────────┬───────────────────────┘
                                              │
                    ┌─────────────────────────┴─────────────────────────┐
                    │                                                   │
        ┌───────────▼───────────┐                           ┌───────────▼───────────┐
        │  Method A: Standalone │                           │  Method B: Companion  │
        │ Drag & drop an .m4b   │                           │ On existing EPUB card:│
        │ or .mp3 into Library. │                           │ "Attach Audiobook..." │
        │ Shows as a book with  │                           │ Links audio to text.  │
        │ a discreet 🎧 badge.  │                           │                       │
        └───────────────────────┘                           └───────────────────────┘
```

---

## 2. Data Schema & Persistence

### 2.1 Book Model Updates (`src/core/types/index.ts`)

```typescript
export interface AudioChapter {
    id: string;
    title: string;
    startSec: number;
    endSec: number;
}

export interface BookAudioTrack {
    filePath: string;           // Local path or storage key to .m4b / .mp3
    format: 'm4b' | 'mp3' | 'aac' | 'm4a';
    durationSec: number;
    currentPositionSec: number;
    playbackSpeed: number;       // e.g. 1.0, 1.25, 1.5, 2.0
    chapters: AudioChapter[];
    lastListenedAt?: string;     // ISO timestamp
}

export interface Book {
    // ... existing fields ...
    audioTrack?: BookAudioTrack;
}
```

### 2.2 SQLite Storage & P2P Sync
* `audioTrack` is serialized to SQLite column `audio_track JSON` in the `books` table.
* Synchronized across paired devices via `iroh-docs` so your listening timestamp is maintained whether on desktop or Android.

---

## 3. Rust Tauri Backend: Fast Metadata & Chapter Parser

### 3.1 Crate Dependencies (`src-tauri/Cargo.toml`)
* `mp4ameta` (for `.m4b` QuickTime atoms: chapters, duration, embedded cover art)
* `id3` (for `.mp3` ID3v2 chapter frames `CHAP`/`CTOC`)

### 3.2 Tauri Commands (`src-tauri/src/audiobook.rs`)
```rust
#[tauri::command]
pub fn extract_audiobook_metadata(path: String) -> Result<AudiobookMetadataPayload, String> {
    // 1. Extract duration, embedded cover image (if any), title, author
    // 2. Parse chapter markers (start_time_ms, end_time_ms, title) in <5ms
    // 3. Return payload to frontend
}
```

---

## 4. Frontend: The Unified Immersion Player

### 4.1 Player Engine (`src/features/reader/audio/ImmersionPlayer.ts`)
* Uses HTML5 `HTMLAudioElement` with local streaming.
* Exposes dual-mode playback:
  - **Mode A (Companion Audio)**: Direct HTML5 streaming from local file path or Tauri asset protocol (`asset://` / `stream`).
  - **Mode B (TTS)**: Existing platform-native TTS fallback.
* Integrates with `navigator.mediaSession` for system lock-screen and headphone controls (Play/Pause, Seek Backward 15s, Seek Forward 15s).

### 4.2 Immersion Bar UI (`src/features/reader/audio/ImmersionBar.tsx`)
```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 🎧 Chapter 3: A Short Rest              [ 12:45 / 38:20 ]    ( 1.25× ) ( ⏱ 30m ) [ ✕ ] │
│ ──────────────────────────────●─────────────────────────────────────────────────────── │
│          [ ⏮ 15s ]             [  ▶ PLAY / ⏸ PAUSE  ]             [ 15s ⏭ ]            │
└────────────────────────────────────────────────────────────────────────────────────────┘
```
* **Speed Chips**: `0.75×`, `1.0×`, `1.25×`, `1.5×`, `1.75×`, `2.0×`.
* **Sleep Timer**: `Off`, `15m`, `30m`, `45m`, `End of Chapter`.
* **Chapter Menu**: Quick dropdown to jump to any chapter in the audio track.
* **Auto-Save**: Saves playback position to SQLite on pause, section change, or unmount.

---

## 5. GitHub Issue Draft Template

```markdown
### Feature Request: Companion Audiobook Attachment & In-Reader Immersion Player

#### Problem Statement
Readers often switch between reading text and listening to audiobooks. Currently, users must manage separate audio apps and manually align chapters.

#### Proposed Solution
Allow users to attach `.m4b` or `.mp3` files directly to existing library books as a companion track. When reading, Theorem's Immersion Bar provides native playback with speed controls, chapter navigation, sleep timers, and cross-device sync.

#### Acceptance Criteria
- [x] "Attach Audiobook..." action on Book Card (Edit Metadata modal not needed).
- [x] Fast Rust metadata & chapter parser for M4B and MP3 files.
- [x] In-reader audio player (`AudiobookBar`) with speed controls (0.75x–2.0x), ±15s skip, scrubber, and sleep timer.
- [x] OS `MediaSession` lock screen & headphone controls.
- [x] Sync playback position across devices via Iroh P2P.

**Still open (tracked in 2026-09-05-remaining-roadmap.md):** Android
audiobook generation, standalone audiobook ingestion as a library book,
streaming gap handling when synthesis lags playback.
```
