# Theorem — Context

## What This Is

Theorem is a **local-first reading app** for desktops (Linux, macOS, Windows) and mobile (Android). It reads EPUB, MOBI, PDF, CBR, CBZ, FB2, and RSS feeds. It also exports highlights and vocabulary to Markdown for Obsidian/Logseq.

It runs as a Tauri 2 app on all platforms. The web build works for basic browsing but Tauri is the primary target.

## Why Local-First

Your library, highlights, annotations, reading position, and vocabulary are stored **on your machine** in SQLite. There is no cloud account, no subscription, no vendor lock-in. Sync between devices uses direct P2P connections over LAN/Internet via the iroh protocol stack — no server in the middle.

## Stack

| Layer | Choice | Why |
|-------|--------|-----|
| UI framework | React 19 | Component model, lazy loading, Suspense |
| State | Zustand 5 | Minimal boilerplate, `persist` middleware, selector-based subscriptions (no full-store re-renders) |
| Bundling | Vite 8 (rolldown) | Fast builds, rust-based bundler in prod |
| CSS | Tailwind CSS v4 | Utility-first, `@theme` design tokens, `cn()` for composition |
| Desktop shell | Tauri 2 | Smaller binaries than Electron, Rust for perf-critical paths |
| Persistence | SQLite (rusqlite + r2d2) | Reliable, well-understood, FTS5 for search |
| P2P sync | iroh stack | CRDT-based doc sync (structured data) + blob transfer (files) |
| Ebook reflow | foliate-js (vendored) | Mature EPUB/MOBI/FB2/CBZ rendering, patched at build time |
| PDF | PDF.js | Industry standard, range-based streaming reads |
| TTS | Platform native + optional neural | Platform TTS needs no downloads or cloud (Android TTS, spd-say, say, System.Speech). Optional desktop neural voice (Supertonic 3, ONNX) downloads models on demand. |
| Tests | Vitest + jsdom | Familiar, fast, React Testing Library compatible |
| Linting | TypeScript strict mode | No linter — typecheck catches issues |

## Key Architectural Decisions

**No React Router.** Navigation uses `useUIStore.currentRoute` and `window.history.pushState`. This avoids a heavy dependency for what amounts to a page switch with 10 routes. All route components are `React.lazy()` loaded.

**Two reader engines.** Foliate-js handles reflowable formats (EPUB, MOBI, FB2, comic archives). PDF.js handles PDF. They share annotation and bookmark state through a common store interface via `Reader.tsx`.

**Reader chunk prewarming.** The reader chunk is the largest feature by far. `App.tsx` calls `prewarmReaderChunk()` after store hydration (scheduled idle task) so the JS is already loaded by the time the user opens a book.

**EPUB pre-parser in Rust.** Opening an EPUB normally requires JS-side ZIP traversal (zip.js). The Rust `prefetch_zip_metadata` command pre-decodes all text entries in parallel before zip.js starts. If the cache is populated, zip.js skips `getEntries()` entirely.

**P2P sync always compiled.** The iroh stack (iroh + iroh-docs + iroh-blobs + iroh-gossip) is always built into the binary. There is no feature gate for sync — it's a core product feature, not optional infrastructure.

**Book locations in SQLite, not Zustand.** Foliate-js position snapshots (the `locations` field) can reach 50-100MB across 1000 opened books. Storing that in persisted Zustand state would serialize and deserialize megabytes on every persist cycle. Instead, it lives in a SQLite BLOB column, read on book open, written on book close.

**TTS with an optional neural voice.** Platform TTS needs no external models or cloud APIs: Linux uses `spd-say` (speech-dispatcher), macOS uses `say`, Windows uses PowerShell `System.Speech`, Android uses Android's built-in `TextToSpeech`. Desktop additionally offers an optional Supertonic 3 fp32 ONNX neural voice, downloaded on demand and played natively in Rust (`audio_player.rs`, rodio/cpal). The frontend `ImmersionPlayer.ts` orchestrates both paths; sentence/word highlighting synced to narration is not yet implemented. Voice availability depends on the user's system TTS configuration.

**Markdown export without a library.** The vault sync module generates Markdown files directly with a YAML frontmatter template matching Obsidian's expected format. No external Markdown generation library — the output is tightly coupled to Obsidian's filename conventions.

## Sync Architecture

Sync uses the iroh P2P stack over QUIC:
1. **iroh-endpoint** — QUIC transport, NAT traversal, relay fallback
2. **iroh-docs** — CRDT document store for structured data (books metadata, annotations, settings, vocabulary, RSS)
3. **iroh-blobs** — Blob transfer for book files and cover images
4. **iroh-gossip** — Peer discovery and live event propagation

15 Tauri commands in `sync_commands.rs` handle: device identity, pairing (QR code), doc CRUD, sync trigger, file transfer.

Data flow: Zustand → `provisionToIrohDocs()` → iroh-docs entries → `docs_sync_now()` → peer's `hydrateFromIrohDocs()` → `mergeIncomingData()` → Zustand.

Merged data types: books, annotations, collections, deletion tombstones, vocabulary, RSS feeds + articles, settings, reading stats.

Reading progress is synced as part of per-book metadata entries (`book:{id}`), not as a separate type.

## Tauri Plugin Inventory

| Plugin | Purpose | Wired? |
|--------|---------|--------|
| `opener` | Open URLs in browser | Yes — FeedsPage, ArticleReader |
| `single-instance` | Prevent duplicate windows (desktop) | Yes — Rust-only |
| `fs` | Read/write files | Yes — vault, import, share |
| `dialog` | File open/save, confirm dialogs | Yes — all 5 variants |
| `barcode-scanner` | QR code pairing (mobile) | Yes — DeviceSync |
| `log` | Structured logging | Yes — debug.ts |
| `notification` | Native notifications | Reading goal + sync completion notifications active, `notifications.ts` called from 3 sites |
| `window-state` | Save/restore window geometry (desktop) | Yes — Rust-only |
| `global-shortcut` | Ctrl+Shift+F/R hotkeys (desktop) | Yes — App.tsx |
| `updater` | Self-update (desktop) | Yes — Settings.tsx |
| `mobile-folder-scan` (custom) | Pick/scan folders on Android | Yes |
| `android-tts-audio` (custom) | TTS on Android | Yes |

Removed in v1.0.8: `os`, `app` (alpha), `http` — all had zero frontend usage.

## CI/CD Pipeline

Two GitHub Actions workflows:

**`ci.yml`** — on push to `main` or PR:
- TypeScript typecheck
- Vitest tests (265 tests)
- Vite production build
- Rust fmt + clippy + check

**`release.yml`** — on tag push matching `v[0-9]+.*`:
- Creates/updates a draft GitHub Release
- Builds Linux (AppImage, deb), macOS (Intel + ARM, dmg), Windows (NSIS exe)
- Builds Android (APK + AAB, split-per-abi, signed)
- Regenerates platform icons from `public/favicon.svg`
- Signs artifacts (macOS, Android)
- Publishes release when all builds succeed

## Scale Targets

The schema and query paths are designed for **10,000 books**. WAL mode, a connection pool (4 on desktop, 2 on Android), FTS5 indexing, and per-book annotation tables support this without degradation. The Zustand store holds only metadata (~1MB at 10K), with binary payloads materialized to the filesystem.

## Filesystem Layout

```
~/.local/share/work.fundamentals.theorem/
├── theorem.db               # SQLite (books, covers, kv, blobs, FTS)
├── book-cache/              # Materialized book files (on-demand from DB)
│   ├── {bookId}.book
│   └── ...
├── iroh-docs/docs.redb      # iroh CRDT document store
├── iroh-blobs/              # iroh blob store
├── sync-identity.json       # Device identity keypair
├── sync-paired-devices.json # Paired device list
└── logs/Theorem.log         # Tauri log output (TRACE/DEBUG level)
```

The `book-cache/` directory is the canonical book store: the file lives only in `book-cache/{id}.book`, while the `books.data` BLOB column is a registration stub (legacy full BLOBs are reclaimed on startup).

## Glossary

| Term | Definition |
|------|------------|
| **i-roh** | P2P networking stack: QUIC transport + CRDT docs + blob transfer + gossip. Used for sync. |
| **CRDT** | Conflict-free Replicated Data Type. iroh-docs uses CRDTs to merge concurrent edits without conflicts. |
| **Foliate-js** | Vendored JavaScript library for reflowable ebook rendering (EPUB, MOBI, FB2, CBZ). |
| **CFI** | Canonical Fragment Identifier — EPUB path format for pinpointing locations within a book (e.g., `epubcfi(/6/4[chap01]!/4/2/1:0)`). |
| **StarDict** | Open dictionary file format (.ifo metadata, .idx index, .dict.dz compressed data). |
| **Tombstone** | Deletion marker that propagates via sync so deleted items stay deleted across devices. |
| **FTS5** | SQLite Full-Text Search extension — used for book title/author search. |
| **WAL mode** | SQLite Write-Ahead Logging — allows concurrent reads during writes. |
| **QUIC** | UDP-based transport protocol used by iroh for P2P connections with NAT traversal. |
| **ONNX** | Open Neural Network Exchange format — used by the optional Supertonic 3 neural voice engine. |
