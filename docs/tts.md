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

Desktop OS voices are hardened in `src-tauri/src/tts_desktop.rs`. Book text is
untrusted, so it never reaches a shell or script string: `say` and `spd-say`
receive it as one argument after `--` (a page that starts with `-` is spoken,
not parsed as an option) and Windows reads it from **stdin** into a constant
PowerShell script (voice and rate travel in environment variables). The
narration process is tracked, so Stop kills only Theorem's own `say` /
`powershell` — not every one on the machine. `tts_speak` takes an optional
`speed`, mapped to `say -r`, `spd-say -r` and `SpeechSynthesizer.Rate`.

Backend wiring: `tts_speak` / `tts_stop` in `src-tauri/src/tts_platform.rs` dispatch to
the platform implementation (`src-tauri/src/tts_linux.rs` on Linux, the
`tauri-plugin-android-tts-audio` plugin on Android). Every platform reports
the real end of speech. On desktop the narration process lives exactly as long
as the speech (`say` and the PowerShell script return when done; Linux runs
`spd-say -w`, which waits for speech-dispatcher, and passes the book's language
with `-l` when it is a valid language tag), so when the tracked process exits
by itself a watcher emits `tts-utterance-done` (exit status 0) or
`tts-utterance-error`, carrying the `utteranceId`, the same events Android
sends. A stopped or replaced process reports nothing; on Linux, Stop drops our
`spd-say -w` before `spd-say --cancel`. `tts_speak` answers
`completionEvents: true` on desktop; the reader then ends the page on the
event and keeps its duration estimate only for the sentence highlight and as
a late fallback (twice the estimate plus 5 s) in case no event arrives.

**Android engine selection**: the plugin supports `tts_get_engines` /
`tts_set_engine` (re-initializes `TextToSpeech` with the chosen engine
package and persists the choice). Settings → General → Text-to-Speech Engine
lists installed engines and recommends **Theorem Neural Voice**, the
companion TTS engine app used for neural narration on Android. Android also
reports real word boundaries (`UtteranceProgressListener.onRangeStart`,
API 26+) forwarded as `tts-utterance-range` events, and supports
`tts_synthesize_to_file` for offline audio export.

**Android speak** (`TtsAudioPlugin.speak`): every call applies the reader's
speed (`setSpeechRate`) and the book's language (`setLanguage`, after
`isLanguageAvailable`; when the engine has no voice for it the device
language is used and the call resolves with a `languageWarning` the reader
shows once). A chosen engine voice is kept only when it speaks the book's
language. Text longer than `TextToSpeech.getMaxSpeechInputLength()` is split
at sentence boundaries (`SpeechTextSplitter.kt`) and queued with
`QUEUE_ADD`. The app passes an `utteranceId` with each speak; every event
carries it (`utteranceId`, plus the piece `id`), ranges are page offsets, and
`tts-utterance-done` fires once, after the last piece. Events from a stopped
or replaced utterance are dropped both in the plugin and in
`ImmersionPlayer`. Kotlin unit tests: `./gradlew
:tauri-plugin-android-tts-audio:testDebugUnitTest`.

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
  Sentence-aware chunking (`chunk_text`, at most 300 characters, 120 for
  Japanese and Korean): paragraph breaks and headings end a chunk; a sentence
  keeps its closing quotes and brackets; `...`/`…` is one terminator and a
  chunk is never punctuation only; abbreviations (Mr., Gen., Lt., p.m.,
  Jan., U.S., e.g. …) and initials do not end a sentence, nor does a stop
  followed by a lowercase word; `。！？` always do. A sentence over the limit is
  packed greedily at commas, semicolons and colons, then wrapped at words
  (characters for unspaced CJK). Chunks are joined with short silences.
- **Cache + prefetch**: synthesized audio is cached as WAV in `tts/cache`,
  keyed by SHA-256 of a cache-format version, the model release
  (`tts_model::ASSETS_TAG`), language, voice, speed and text (old entries
  simply miss and age out). It is capped at 150 MB and trimmed
  least-recently-used first (a cache hit refreshes the file's modification
  time, which is what the trim sorts by) — replays are instant and
  `tts_prefetch` warms the next chunk while the current one plays. Entries are
  written to a `.part` file and renamed into place, so the player never reads
  a half-written WAV; the trim never deletes a `.part` in progress (only
  leftovers older than an hour). Synthesis is serialized by the engine lock
  and the cache is checked again once it is held, so a prefetch and a speak
  racing for the same chunk synthesize it once.
- **Voices**: F1–F5 / M1–M5 (per-voice style files, 292KB each). Selected
  from the reader playback bar. Speed chips (0.75–1.5×) only change the
  native player's pitch-preserving time-stretch (WSOLA): the reader always
  synthesizes at 1× and sets the player's speed before each page, so a speed
  change is instant, needs no new synthesis, and is applied exactly once.

Settings → General → Neural Voice shows install status, downloads all
missing assets with per-file progress, and removes the install (including
cache).

**Supported platforms.** A runtime asset is published for Linux x86_64, macOS
aarch64 (Apple Silicon) and Windows x86_64 only. `tts_model::is_supported(os, arch)`
encodes that table; `tts_neural_status` reports it as `supported`, the Settings
section shows "not available on this platform" when it is false, the reader's
install offer stays hidden, and `tts_model_download_asset` refuses to run (so an
Intel Mac, or Windows/Linux on ARM, is never offered a download that cannot
work). A test asserts the flag agrees with the compiled asset table.

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
- **Platform**: `tts_speak` as before; completion arrives via the
  `tts-utterance-done` event on every platform, and on Android pause resumes
  from the last real word boundary.
- **UI**: the reader bottom navbar swaps to the immersion row (state,
  play/pause/stop, voice & speed popover when neural is installed, and a
  neural-install shortcut when it is not). Toggling immersion mode on a book
  with an attached audiobook opens the audiobook player instead
  ([audiobook.md](audiobook.md)).
