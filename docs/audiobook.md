# Companion Audiobooks

Theorem attaches **human-narrated audiobook audio directly to books** — no
separate app, library tab, or server. A DRM-free `.m4b`, `.m4a`, or `.mp3`
file can be linked to any book, and the reader's immersion mode upgrades from
synthetic TTS into a full audiobook player. Audiobooks can also be
**generated** from an open book with the neural voice
([tts.md](tts.md)).

## Attaching Audio

Book context menu (library) → **Attach Audiobook...** → pick an
`.m4b`/`.m4a`/`.mp3` file. The Rust command `extract_audiobook_metadata`
(`src-tauri/src/audiobook.rs`) parses duration, title, author, cover art and
chapter markers in milliseconds:

- **M4B/M4A**: tags and artwork via `mp4ameta`; chapters come from a
  hand-rolled QuickTime chapter-track walker (the `udta.chap` reference →
  stts/stsc/stsz/stco sample-table expansion → 2-byte-length-prefixed text
  samples) because no crate exposes them.
- **MP3**: ID3v2 `CHAP`/`CTOC` frames via `id3`; duration falls back to the
  last chapter end and is corrected by the player after decode.

The result is stored on the book as an optional `audioTrack: BookAudioTrack`
(`filePath`, `format`, `durationSec`, `currentPositionSec`, `playbackSpeed`,
`chapters[]`) in the library store — so it **syncs to paired devices via
iroh** alongside the rest of the book record. **Detach Audiobook** removes
it.

## The Player

Opening a book with an attached track and toggling immersion mode swaps the
reader's TTS row for `src/features/reader/audio/AudiobookBar.tsx`:

- Streaming playback from the local file via `HTMLAudioElement` through the
  Tauri asset protocol; container duration is replaced by the real decoded
  duration once known.
- Scrubber over the actual duration, ±15s skip buttons, speed chips
  (0.75–2×), chapter menu with jump-to-chapter, sleep timer (15/30/45 min or
  end of chapter).
- Position auto-save throttled to 5s plus pause/unmount, persisted into
  `audioTrack.currentPositionSec` (synced).
- `navigator.mediaSession` metadata and action handlers for lock-screen and
  headphone controls (play/pause, seek backward/forward).
- Platform/neural TTS narration is stopped automatically while the audiobook
  player is active.

## Save as Audiobook (desktop)

With the Neural Voice installed, the immersion bar offers **Generate
Audiobook**: the foliate engine extracts the full text of every EPUB section
(`getAllSectionsForAudio`), and `generate_audiobook`
(`src-tauri/src/audiobook_gen.rs`) narrates the whole book in a detached task:

- Reuses the Supertonic sentence chunker and WAV cache; joins chunks with
  0.3s gaps.
- Resamples 44.1kHz → 48kHz and encodes **Ogg Opus** at 36kbps mono
  (~16MB per finished hour) via libopus (`audiopus`, static vendored build,
  desktop-gated) with a hand-rolled Ogg page muxer (Ogg CRC, covered by unit
  tests).
- Output: `app_data_dir()/audiobooks/<book-id>.ogg` with chapter marks
  returned as `AudioChapter[]`; emitted via
  `audiobook-gen-progress` / `audiobook-gen-done` events and cancellable per
  book (`generate_audiobook_cancel`).
- On completion the generated file is attached as the book's `audioTrack`
  (format `opus`) and immediately playable by the companion player.

Android generation (batch `synthesizeToFile` through the selected engine) is
deferred until Theorem Neural Voice ships; generation commands return a
desktop-only error there.
