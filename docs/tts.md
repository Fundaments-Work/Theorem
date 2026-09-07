# Text-to-Speech (Immersion Reading)

Theorem has two narration paths: **platform TTS** (always available, zero
download) and the **Neural Voice** engine (Supertonic 3, fp32, downloaded on
demand on desktop). A third path — attached human-narrated audiobooks — is
covered in [audiobook.md](audiobook.md).

## Platform-Specific Backends (fallback path)

Platform TTS requires native OS speech synthesis; there is no cross-platform
Rust library with consistent quality. Each platform has its own backend:

| Platform | Backend | Why |
|----------|---------|-----|
| Linux | `spd-say` (speech-dispatcher) | Standard Linux speech interface |
| macOS | `say` command | Built-in, high-quality voices |
| Windows | PowerShell `System.Speech` | .NET speech synthesis |
| Android | Native TTS plugin | Android's TextToSpeech API |

Backend wiring: `tts_speak` / `tts_stop` in `src-tauri/src/lib.rs` dispatch to
the platform implementation (`src-tauri/src/tts_linux.rs` on Linux, the
`tauri-plugin-android-tts-audio` plugin on Android). Desktop OS voices report
no completion signal, so completion falls back to a duration estimate; Android
reports real completion.

**Android engine selection**: the plugin supports `tts_get_engines` /
`tts_set_engine` (re-initializes `TextToSpeech` with the chosen engine
package and persists the choice). Settings → General → Text-to-Speech Engine
lists installed engines and recommends **Theorem Neural Voice**, the
companion TTS engine app used for neural narration on Android. Android also
reports real word boundaries (`UtteranceProgressListener.onRangeStart`,
API 26+) forwarded as `tts-utterance-range` events, and supports
`tts_synthesize_to_file` for offline audio export.

## Neural Voice (Supertonic 3, desktop)

A full offline neural TTS engine using the Supertonic 3 multilingual model
(31 languages, one shared model). **Nothing ships in the app** — the fp32
ONNX models, voice style files, and the ONNX Runtime dylib are downloaded at
first use (~400MB total) from the `fundaments-work/supertonic-assets` GitHub
releases and verified against a SHA-256 manifest compiled into the app.

- **Download layer** (`src-tauri/src/tts_model.rs`): streaming downloads to
  `.part` files, SHA-256 verification (pinned per asset), throttled
  `tts-download-progress` events, status/remove commands. Storage:
  `app_data_dir()/tts/{runtime,models,voices}`.
- **Inference** (`src-tauri/src/supertonic.rs`): the `ort` crate with
  `load-dynamic` runs the pipeline — preprocess (NFKD, symbol expansion,
  `<lang>` wrap) → unicode indexing → duration predictor → text encoder →
  8-step vector-estimator denoising → vocoder → 44.1kHz mono PCM.
  Sentence-aware chunking (<300 chars) with abbreviation-aware splitting and
  0.3s silence joins.
- **Cache + prefetch**: synthesized audio is cached as WAV keyed by
  SHA-256(text + voice + speed) with a 1GB LRU cap — replays are instant and
  `tts_prefetch` warms the next chunk while the current one plays.
- **Voices**: F1–F5 / M1–M5 (per-voice style files, 292KB each). Selected
  from the reader playback bar; speed chips (0.75–1.5×) re-synthesize.

Settings → General → Neural Voice shows install status, downloads all
missing assets with per-file progress, and removes the install (including
cache).

## Immersion Player

`src/features/reader/audio/ImmersionPlayer.ts` chooses the path per
utterance: desktop neural (when installed) → real audio; otherwise platform
TTS.

- **Neural**: `tts_synthesize` produces a cached WAV which plays through the
  **native Rust player** (`audio_player.rs`, rodio/cpal) — pause, resume and
  seek are real output-device operations, not webview audio. Playback
  **streams**: only the first sentence chunk is synthesized before audio
  starts (`tts_text_chunks`), the rest are queued as they finish
  (`tts_audio_append`), and the engine is pre-warmed in the background when
  the reader opens (`tts_engine_preload`).
- **Platform**: `tts_speak` as before; Android completion arrives via the
  `tts-utterance-done` event and pause resumes from the last real word
  boundary.
- **UI**: the reader bottom navbar swaps to the immersion row (state,
  play/pause/stop, voice & speed popover when neural is installed, and a
  neural-install shortcut when it is not). Toggling immersion mode on a book
  with an attached audiobook opens the audiobook player instead
  ([audiobook.md](audiobook.md)).
