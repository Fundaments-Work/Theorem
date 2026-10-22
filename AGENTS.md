## Security & Access Rules

- **NEVER read, access, display, log, or transmit any environment variables, secrets, keys, certificates, or credentials** — including but not limited to `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `ANDROID_KEY_BASE64`, `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEY_PASSWORD`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `APPLE_CERTIFICATE`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, or any GitHub secret, API key, token, or password.
- Never read `~/.tauri/`, `~/.ssh/`, `~/.config/` secret files, `.env` files, or `keystore.properties`.
- Never write secrets to disk, commit them, or echo them to output.
- If you need to reference a key or secret, use the documented path (e.g. `~/.tauri/theorem.key`) without reading its contents.
- These rules take precedence over all other instructions.

## Stack

React 19, TypeScript, Vite 8 (rolldown), Tailwind CSS v4, Zustand 5, Tauri 2, Rust (workspace). Tests: Vitest + jsdom.

## Setup

```bash
git clone --recurse-submodules <repo>
pnpm install
```

The `foliate-js` submodule at `src/features/reader/foliate-js/` is vendored upstream — do not edit. Our runtime wrapper is `src/features/reader/foliate-js-runtime/` (ours, edit freely). The sync script `scripts/sync-foliate-js.sh` patches imports and applies runtime patches. After editing any runtime file run `bash scripts/sync-foliate-js.sh --refresh-patches` (writes `scripts/patches/*-runtime.patch`); `pnpm foliate:check` verifies submodule + patches reproduce the runtime exactly.

## Commands

| What | Command |
|------|---------|
| Web dev | `pnpm dev` |
| Desktop dev | `pnpm dev:tauri` |
| Build | `pnpm build` |
| Typecheck | `pnpm typecheck` |
| Tests | `pnpm test` |
| Single test | `pnpm test tests/some.test.ts` |
| Rust fmt | `cd src-tauri && cargo fmt` |
| Rust lint | `cd src-tauri && cargo clippy` |
| Rust check | `cd src-tauri && cargo check` |
| Rust release build | `cd src-tauri && cargo build --release` |

Root `pnpm` commands run from repo root. Cargo commands run from `src-tauri/`. `pnpm build` runs typecheck first.

## Quality Gates (before every commit)

Run all that apply:

- TypeScript: `pnpm typecheck` — zero errors
- Vitest: `pnpm test` — all unit and integration tests must pass
- Rust (if any `.rs` changed): `cd src-tauri && cargo fmt && cargo clippy && cargo check` — fmt must produce no diff, clippy zero warnings
- Rust touching Android-only code or dependencies: `cargo clippy --target aarch64-linux-android` (CI runs it; set the NDK `CC_/CXX_/AR_aarch64_linux_android` compilers locally)

If clippy is noisy, try `cargo clippy --fix --lib` first.

### Testing Integrity & Outlier Coverage

- Tests must rigorously cover edge cases, boundaries, and outliers (e.g. 0-length inputs, rapid concurrent interactions, missing elements, corrupted data, boundary navigation).
- **NEVER weaken, delete, loosen assertions, or edit tests simply to make them pass.** If a test or outlier fails, investigate and fix the underlying implementation code. The test exists to defend correctness.

CI (`ci.yml`) runs typecheck, test, build, and rust-check (fmt, clippy, check, `cargo test --workspace --lib --tests`) on push to main.

### Known-flaky tests

- `tests/release-1.0.7-store-scale.test.ts` asserts a wall-clock budget (`expect(elapsed).toBeLessThan(25)`) and can exceed it under full-suite parallel load while passing in isolation. Treat a lone failure here as a perf-measurement flake: re-run the file alone (`pnpm test tests/release-1.0.7-store-scale.test.ts`) to confirm, but still verify no genuine O(n) scan was introduced.
- `tests/library-virtualization.test.ts` ("Row height estimation") asserts `elapsed < 1` ms for a pure size calculation and can exceed it under full-suite load. Same rule: re-run the file alone to confirm.

## Architecture

**Routing**: Zustand-driven via `useUIStore.currentRoute` and `AppRoute` union type (`src/core/types/index.ts:445`). No React Router. Additions require updating: `src/App.tsx` (route switch + lazy load), `src/core/types/index.ts` (type), `src/shell/layout/Sidebar.tsx` (desktop rail), `src/shell/layout/BottomNav.tsx` (phones: five tabs only, so a new page usually belongs *inside* an existing tab, as Bookmarks does in Workbench), `src/shell/AppTitlebar.tsx`.

**Stores**: One file per slice in `src/core/store/`, barrel-rexported from `src/core/store/index.ts`. Always import from the barrel (`"../../core/store"`), not individual slice files. Import stores with individual selectors (`useUIStore(s => s.x)`), never destructuring.

**Imports**: Never import from the top-level barrel `src/core/index.ts` — it prevents tree-shaking. Import directly: `"../../core/store"` (stores), `"../../core/types"` (types), `"../../core/lib/env"` (env utils), `"../../core/lib/utils"` (cn). No path aliases.

**App entry**: `src/App.tsx` lazy-loads all route components (`React.lazy`). The reader chunk is pre-warmed via `prewarmReaderChunk()` in `src/App.tsx` after store hydration (scheduled idle task). PDF.js and Foliate are *not* pre-warmed: each engine loads on demand when a book of that format opens.

**Startup bundle budget**: the JS listed in `dist/index.html` (the app shell) is about 630 kB and `scripts/check-startup-bundle.mjs` (run by `pnpm build` and CI) fails above 700 kB or if PDF.js, knap, i18next, Sentry, Radix overlays or the reader become startup dependencies. Rules that keep it there: `main.tsx`/`App.tsx` import specific `ui/*` modules, not the `src/ui` barrel; closed-at-startup dialogs are `React.lazy`; heavy engines (`knap`) are dynamically imported and the light constants they need live in their own file (`knap-default-template.ts`); and `manualChunks` in `vite.config.ts` must not group a library that shares a helper with the app shell (a group once absorbed Vite's preload helper, `isTauri` and React's jsx-runtime, turning PDF.js and Radix into startup dependencies). After touching `vite.config.ts`, read the preload list in `dist/index.html`.

**URL safety**: every URL that originates off-device (feed links, extracted article markup, book covers, catalog entries) goes through the scheme allowlists in `src/core/lib/url-safety.ts` before reaching `href`/`src`; HTML goes through `sanitizeHtml` (DOMPurify). Never hand-roll a scheme check or regex sanitizer.

**Reader**: Two rendering paths. Non-PDF: `ReaderViewport → useDocumentReader → FoliateEngine`. PDF: `PDFReader → PDFJsEngine`. `Reader.tsx` orchestrates both. **Theorem Lens** (`src/features/reader/components/FootnotePopover.tsx`): Anchored peek portal popover for footnotes and citations. **PDF Engine**: Uses strict on-demand range reading, worker destruction on unmount via `loadingTask.destroy()`, immediate canvas deallocation (`width = 0, height = 0`), and per-book `PdfViewState` persistence.

**EPUB pre-parser** (`src-tauri/src/epub_parser.rs`): Rust Tauri command `prefetch_zip_metadata` that pre-decodes EPUB ZIP text in parallel with zip.js. If the cache is populated, zip.js skips `getEntries()`. When changing the `ZipPrefetch` struct, update all 3 sides: Rust command, `src/core/lib/tauri-epub-bridge.ts` (TS interface), `src/features/reader/foliate-js-runtime/view.js` (consumer).

**EPUB metadata write-back** (`src-tauri/src/epub_rewriter.rs`): Rust Tauri command `rewrite_epub_metadata` that updates `<metadata>` dc:* fields in the OPF and optionally replaces/embeds the cover image, then overwrites the materialized `.book` file in place. Called from `src/core/lib/book-edit.ts` after metadata/cover edits; browser gets a best-effort fflate fallback in `src/core/lib/epub-write-browser.ts`. Encrypted EPUBs are rejected. Book export lives in `src/core/lib/book-export.ts` (desktop save dialog, Android `save_file_mobile` MediaStore download, browser `<a download>`).

**Runtime split**: Guard desktop-only code with `isTauri()` / `isTauriDesktop()` / `isTauriMobile()` / `isMobile()` from `src/core/lib/env.ts`. Provide browser fallbacks.

**Sync**: P2P via iroh stack (iroh + iroh-docs + iroh-blobs + iroh-gossip). 23 Tauri commands in `sync_commands.rs`. Iroh is always compiled (no feature gate). See `docs/sync.md`. Security lives in `src-tauri/src/sync_access.rs`: every sync protocol except pairing is closed to devices that are not paired (`PeerGate`, an endpoint hook, so new protocols are covered automatically); pairing needs the QR code's one-time secret plus the user's approval; book requests are IDs, never paths, and only book files are served. Every change to `paired_devices` goes through `SyncTransportState::persist_paired` (it also updates the allowlist). Never take file paths from synced data, and never write a `kv_store` key from sync that is not in `is_syncable_kv_key`. Doc entries are one per item (`book:`, `anno:`, `collection:`, `vocab:`, `rss_feed:`, `rss_article:`, `tomb:`); whole lists go only to devices on sync protocol < 2. Never rewrite an unchanged doc entry (`write_own_entries` skips them): a rewrite dates it now and undoes other devices' deletions, which live in the docs as empty entries and are read back as `deleted`. Book and annotation edits carry a base stamp (`metadataBaseAt`, `baseUpdatedAt`) for conflict detection in the native merge.

**TTS (Immersion Reading)**: two narration paths, orchestrated by `src/features/reader/audio/ImmersionPlayer.ts` (UI lives in the reader navbar's immersion row — there is no separate ImmersionBar component):
- **Platform TTS (fallback, always available)**: Android `TextToSpeech` (custom `tauri-plugin-android-tts-audio`), Linux `spd-say` (`src-tauri/src/tts_linux.rs`), macOS `say`, Windows PowerShell `System.Speech`. Android supports engine selection (`tts_get_engines`/`tts_set_engine`), real word boundaries (`tts-utterance-range` events), and `tts_synthesize_to_file`.
- **Neural Voice (desktop)**: Supertonic 3 fp32 ONNX pipeline — `src-tauri/src/tts_model.rs` (on-demand download of models/runtime/voices from `fundaments-work/supertonic-assets` releases with SHA-256 verification; nothing ships in the app) + `src-tauri/src/supertonic.rs` (ort `load-dynamic`, sentence chunking, 1GB WAV cache keyed by SHA-256(text+voice+speed), `tts_synthesize`/`tts_prefetch`/`tts_neural_status`). Playback runs natively in Rust via `src-tauri/src/audio_player.rs` (rodio/cpal — the webview audio stack proved unreliable) with real pause/resume/seek, and is **streamed**: the first sentence chunk plays while the rest synthesize into the queue (`tts_text_chunks` + `tts_audio_append`); `tts_engine_preload` warms the models when the reader opens. Settings → General → Neural Voice manages the install; on Android neural narration requires the Theorem Neural Voice companion TTS engine app (fork of DevGitPit/supertonic-android at fundaments-work/supertonic-android; Settings picks it via engine selection).
- Docs: `docs/tts.md`.

**Notifications**: Reading goal + sync completion notifications active:
- Rust: `tauri-plugin-notification` registered in `lib.rs:1638`; `sqlite_check_goal_reminder` reads daily stats from `kv_store`
- Frontend: `src/core/lib/notifications.ts` exports `notify()`, `notifyIfGranted()`, `requestNotificationPermission()`
- Goal met detection: `src/features/reader/hooks/useReadingTime.ts` after each flush
- Scheduled reminder: `src/features/reader/hooks/useDailyGoalReminder.ts`. **Phones**: never a webview timer (Android pauses it in the background). The reminder is native: `ReadingReminder.kt` in the `mobile-folder-scan` plugin keeps only the next one in AlarmManager, posts it (own channel `reading-reminders`, icon `ic_stat_theorem`), schedules the next day, and re-arms on boot, app update, clock/time-zone change and exact-alarm grant. A reminder that was due in the last 2 h but never shown (phone off, or a clock correction rescheduled it inside Android's delivery window) is shown at once rather than skipped. The app only sends settings via `configure_reading_reminder` (`src/core/lib/daily-reminder.ts`: on/off, time, text, `skipDate` once today's goal is met); `startMobileReminderPlanner` sends them on start, settings/goal change and return to the app. Don't use tauri-plugin-notification's `schedule` on Android: 2.6.0 stores scheduled notifications as "null", so they are lost on reboot and `pending()` throws. Exact timing needs "Alarms & reminders" (`SCHEDULE_EXACT_ALARM`); without it Android 12+ may deliver up to an hour late (measured: 20:00 arrived 21:00). `reminder_status` / `open_exact_alarm_settings` / `open_notification_settings` back the Settings notice. **Desktop**: the in-app check every 60 s (the plugin shows a scheduled notification at once on desktop)
- Sync notifications: `src/core/lib/sync-orchestrator.ts` after sync completion/error
- UI: `<Toaster />` from `sonner` renders sonner toasts alongside OS notifications
- Settings: Goal Notifications toggle, Daily Reminder Time picker, Sync Notifications toggle in Settings → Reading Goals
- Android: `POST_NOTIFICATIONS` permission added to `AndroidManifest.xml

**Dictionary & Vocabulary**: High-performance two-tier lookup system:
- **Offline (Fast-path)**: Native Rust memory-mapped MDict `.mdx` (`src-tauri/src/mdict.rs` + `mdx_lookup` command) and StarDict binary search engine (`src-tauri/src/stardict.rs` + `stardict_lookup` command). Reads keyword indices in memory via `memmap2`, decompresses single 64KB zlib record chunks on-demand with an LRU cache, handles `entry://` cross-references and morphological redirects in < 0.5ms.
- **Online (Fallback)**: Native `fetch_online_definition` command via `reqwest` / Free Dictionary API (`api.dictionaryapi.dev`).
- **Storage**: Dictionaries stored directly on disk at `~/.local/share/work.fundamentals.theorem/dictionaries/` (zero SQLite overhead; legacy blobs auto-reclaimed on startup).
- **Frontend**: `src/core/services/DictionaryService.ts` executes instant offline fast-path (< 0.5ms) without blocking on remote HTTP timeouts.
- **UI**: `src/features/settings/DictionaryDownloadModal.tsx` — download/install UI with 1.35M-word MDX and StarDict releases; vocabulary workspace in Workbench.

**Discover & Catalogs**:
- **Page**: `src/features/catalogs/CatalogsPage.tsx` is Discover. Its home is the built-in catalog (`https://catalog.fundaments.work/opds`) laid out by `DiscoverHome.tsx` through `OpdsBrowser`'s `renderHome` (hero cards, shelves, subject tiles, recent searches, "Bring your library"); it is the page itself, never a tab. Tabs (`Discover` + catalogs) appear only once the user adds a catalog. The built-in catalog is curated on the server (private `fundaments-catalog` repo: Cloudflare Worker + D1/KV, refreshed by a sync job on the macroSapiens VM), so its shelves change without an app release; never add client-side curation, and never ship Gutenberg or Standard Ebooks as built-in sources. Its home feed is kept for offline use; user catalogs never are. It is a bottom-bar tab on phones. `OpdsBrowser` (`src/features/catalogs/opds/`) browses one catalog: sections, shelves, facets, search, trail/Back, load-as-you-scroll, a virtualized grid, `OpdsEntrySheet` (purchase/loan/DRM are explained, never faked), HTTP Basic sign-in, and an add-catalog dialog that checks the address first. State lives in `useOpdsBrowser`, not the store.
- **One Rust parser**: `src-tauri/crates/theorem-core/src/opds/` parses Atom/OPDS 1.x, OPDS 2.0 JSON, OpenSearch descriptions, HTML autodiscovery and authentication documents into one model (`src/core/types/opds.ts` mirrors it field for field). Desktop/mobile call it natively; the web build calls it through WebAssembly (`wasm_opds_parse`, regenerate the glue per `docs/discover.md`). Do not add a second parser in TypeScript.
- **Network**: `src-tauri/src/opds_net.rs` (`opds_load`, `opds_search`, `opds_download`, `opds_cleanup_download`): negotiated fetch, Basic auth, typed errors, size caps, streamed downloads that refuse web pages posing as books. `src/core/services/OpdsService.ts` is the TS facade (web fetch path, 5-minute cache, `OpdsError`); `opds-quirks.ts` holds per-catalog adapters (Gutenberg).
- **Downloads** go through the Library's own import pipeline (`importBooksIncremental` / `importBooksFromFilesIncremental`), so metadata, covers and duplicate handling match "Add Books".
- **Security**: catalog credentials stay on the catalog record in `theorem-opds`, are never synced, and are saved only after the server accepts them; catalog HTML always goes through `sanitizeHtml`.
- **Tests**: parser fixtures are real documents in `theorem-core/tests/fixtures/opds/`; `cargo test --lib live_ -- --ignored` hits live catalogs. See `docs/discover.md`.
- **Cover system**: `src/ui/TheoremBookCover.tsx` renders a deterministic clothbound fallback cover for books without bundled artwork.

**Comics (CBR/CBZ)**: Comic books are first-class library items. `src-tauri/src/cbr.rs` parses CBR (RAR) archives natively in Rust using the `rars` crate, streaming entries into an in-memory ZIP (stored, no recompression) so CBRs open on every shipped platform including Android — no external `unrar` binary. Metadata comes from `ComicInfo.xml` (series name, volume index) with a filename-parse fallback. Wired through batch ingest, folder scanning (`FolderScanPlugin.kt` on Android), and the reader for full parity with other formats. CBZ metadata is handled in `batch_ingest.rs`.

**Book series**: Books may carry `series` (name) and `seriesIndex` (volume position, fractional allowed — e.g. `2.5`). Read from EPUB metadata on ingest and from `ComicInfo.xml` for comics; editable via the book edit modal and `AssignSeriesModal.tsx`. `series` is a library sort option, shelves can group by series with combined progress, and finishing a book in a series surfaces a "next unread volume" toast with a **Read Next** action.

**RSS articles**: Article bodies live in SQLite (not a serialized JSON blob) with dedicated tables and indices. Retention is configurable in Settings (Keep Forever / 15 / 30 / 60 / 90 days, default 30) and prunes read, non-favorited articles plus cached content; unread articles are protected by the **Keep Unread Articles** toggle and articles saved offline (`isSaved`) are always preserved.

**Vault highlight grouping**: Obsidian/Markdown export groups highlights **By Chapter (Hierarchical)** by default, or flat/chronological. Chapter title and index ride along on each annotation; reader backfills them for legacy annotations on book open.

## Tauri backend

**Companion Audiobooks**: attach human-narrated audio to any book. `src-tauri/src/audiobook.rs` (`extract_audiobook_metadata`) parses `.m4b/.m4a/.mp3` duration, tags, cover and chapters (M4B chapters via a hand-rolled QuickTime chapter-track walker — no crate exposes them). Optional `Book.audioTrack` (`BookAudioTrack` in types) lives in the library store and syncs; attach/detach via the library context menu. Playback: `src/features/reader/audio/AudiobookBar.tsx` (HTMLAudioElement via asset protocol, chapters, speed, sleep timer, mediaSession, position auto-save). Generation: `src-tauri/src/audiobook_gen.rs` (`generate_audiobook`, desktop only) narrates EPUB sections through Supertonic and encodes one Ogg Opus per book (36kbps mono, hand-rolled Ogg muxer + `audiopus`/libopus static) with chapter marks, then attaches it as the book's `audioTrack` (format `opus`). Docs: `docs/audiobook.md`.

187 `#[tauri::command]` attributes (167 distinct command names registered in `generate_handler!`; some have desktop/mobile `cfg` variants, and `offload_commands.rs` re-exposes blocking commands as async wrappers) across `lib.rs` (file I/O, network, TTS, multi-window, misc), `database.rs` (SQLite persistence, surfaced through `offload_commands.rs`), `sync_commands.rs` (15 sync commands), `epub_parser.rs` (pre-fetch ZIP metadata, pre-inflate initial spine chapters and CSS), `epub_rewriter.rs` (metadata/cover write-back), `file_transfer.rs`, `batch_ingest.rs` (parallel batch library ingestion, SIMD cover extraction, series metadata), `cbr.rs` (native CBR/RAR→CBZ comic archive parsing via `rars`), `mdict.rs` (native memory-mapped MDict .mdx parser, zlib block cache, entry:// link handling), `stardict.rs` (native memory-mapped StarDict lookup, DictZip auto-inflation, POS segmentation), `book_search.rs` (multi-threaded streaming in-book search), `mobi_parser.rs` (native PalmDOC LZ77 decompressor and PDB unpacker), `article_extractor.rs` (native web article fetch and readability extraction), `opds_net.rs` (native OPDS catalog fetch with Basic auth, search and streamed downloads; parsing is in `theorem-core::opds`), `epubcfi.rs` (EPUB CFI parser/resolver used by the CLI), `audiobook.rs` + `audiobook_gen.rs` (companion audiobook metadata parsing and Ogg Opus generation; `delete_generated_audiobook` only deletes inside the app's `audiobooks` folder), `tts_desktop.rs` (hardened macOS/Windows/Linux OS-voice spawning: text never reaches a shell, tracked process), `tts_model.rs` + `supertonic.rs` (neural voice download and fp32 inference), `audio_player.rs` (native rodio playback, desktop-only), `smart_shelves.rs` + `vault_export.rs` (rule evaluation and Rayon vault export), `fuzzy_search.rs` + `stemmer.rs` (SIMD ranking and lemmatization), and `cli.rs`/`cli_tui.rs` (headless CLI + ratatui TUI, desktop-only). To find all: `grep -r '#\[tauri::command\]' src-tauri/src/`. When signatures change, update both Rust and TS call sites.

## Persistence

SQLite via `rusqlite` + `r2d2` pool. All connections use `with_connection()` — never open raw `Connection::open()`. Covers are stored as raw bytes + MIME (`covers.data`, `covers.mime`) and served by `theorem-cover://`; the cover commands and sync still exchange data URLs. `books_fts` is reconciled with the library at startup (`reconcile_books_fts`). Migrations are versioned per store (Zustand persist middleware). When changing persisted schemas: bump version, update defaults, add/adjust `migrate`.

## Rust-First Engineering, Memory & Search Architecture

- **Search for Rust alternatives first**: Whenever implementing any feature that processes text, files, collections, search, hashing, parsing, or caching, **always search for and prioritize a native Rust implementation** instead of TypeScript. Rust is the single source of truth for heavy computation, file I/O, and data storage. JavaScript/React should only handle UI presentation and lightweight interaction state.
- **Memory & Allocation Optimization (Cloudflare Data Layouts)**:
  - **1. Eliminate Capacity Overhead (`Box<str>` & `Box<[T]>`)**: For all immutable DTOs, cached data models, and serialized responses (e.g. RSS articles, OPDS entries, book search results, TOC items), replace `String` and `Vec<T>` with `Box<str>` and `Box<[T]>`. Standard `String` and `Vec` carry 3 words `(ptr, len, cap)` (24 bytes on 64-bit). `Box<str>` and `Box<[T]>` drop the unused 8-byte capacity field down to 2 words `(ptr, len)` (16 bytes), saving 8 bytes per field (20–30% of DTO heap footprint) and preventing allocator slack.
  - **2. Contiguous Flattening & Bitflags (Fewer Lists & Pointer Indirection)**: Avoid fragmented pointer webs (e.g. structs containing multiple nested `Vec`s or `Box`es). Flatten multiple variable-length elements into a single flat buffer indexed by compact integer offsets (`u16` / `u32`). Pack boolean states and feature flags into bitflags (e.g. `bitflags!` or bitmasks) rather than multiple 1-byte `bool` fields (which incur struct padding alignment penalties up to 8 bytes).
  - **3. Context-Inferred Keys (Dropping the Owner)**: In collections or child records scoped to a known parent context (e.g. articles belonging to a specific feed, annotations for an open book, search results for an active query), omit repeating redundant parent foreign keys (e.g. `feed_id`, `book_id`) inside each child struct in memory. Let the parent container or caller context maintain the identifier once.
  - **4. Enum Variant Sizing & Boxing (`clippy::large_enum_variant`)**: In Rust, an enum's memory footprint equals the size of its largest variant plus discriminator tag and alignment. Box oversized or rare variant payloads (`Box<LargeVariant>`) to ensure high-frequency enums remain compact ($\le 24$ bytes), keeping CPU L1/L2 cache lines hot and preventing stack/heap bloat.
  - **5. Zero-Allocation Slices Over Intermediate Collections**: Use byte-index slicing (`str::char_indices`, `&[u8]`, `&str`) rather than collecting intermediate vectors (`Vec<char>`, `Vec<u8>`, `String`). For streaming parsers and serialization, use thread-local reusable scratchpad buffers and pack exact serialized bytes into `Box<[u8]>` with zero transient reallocations.
- **Hybrid Two-Tier Search Engine (`SQLite FTS5` + `nucleo`)**:
  - **Tier 1 (Disk / OS Page Cache)**: SQLite `FTS5` retrieves coarse candidates (pruning 50,000+ books down to top ~200) in ~1ms without allocating memory.
  - **Tier 2 (SIMD Fuzzy Ranking & Highlighting)**: `nucleo-matcher` (Helix's SIMD-accelerated Smith-Waterman matcher) ranks those candidates, scores typos/word-boundaries, and yields exact matching character indices (`indices`) for UI text highlighting in ~0.1ms.
  - **In-Memory Typeahead**: Command palette, tags, shelves, and table of contents run directly through `nucleo-matcher` in <0.05ms.
  - **No JS matchers**: Never use `fuse.js` or in-memory JavaScript string scanning over large collections.

## Anti-patterns (violations = bugs)

- No React Router — use `useUIStore.currentRoute`
- No `transition-all` — specify the exact property
- No `snap-x snap-mandatory` on scroll containers
- No barrel imports from `src/core/index.ts`
- No Zustand destructuring (`const { x } = useStore()`)
- No `awaitSettledLayout()` / double-RAF delays after navigation (paginator container is grid-sized, measurements are immediate)
- No `Array.find()` on books array — use the store's `getBook(bookId)`
- No `console.log` in production code — use `import.meta.env.DEV` guards
- No heavy computation, text parsing, fuzzy searching, or bulk image processing in JavaScript — search for and use a native Rust alternative (e.g. `nucleo` + SQLite FTS5 instead of `fuse.js`, `image` crate WebP instead of DOM `<canvas>`)

## Release

### Versioning & Stability Convention

- **Stable Releases**: Only `X.Y.0` versions (e.g. `1.0.0`, `1.1.0`, `1.2.0`, `1.3.0`, `1.4.0`, `1.5.0`) are designated as **stable** production releases.
- **Beta / Pre-releases**: All minor/patch versions (`X.Y.Z` where `Z > 0`, e.g. `1.5.1`, `1.5.2`, `1.5.3`, etc.) are designated as **beta / pre-release** versions.
- Whenever releasing or editing any `X.Y.Z` (`Z > 0`) tag on GitHub, always ensure it is marked as a pre-release:
  ```bash
  gh release edit v<version> --prerelease
  ```

### Before tagging a release

1. **Merge branches into `main` first**:
   Always merge feature/fix branches into `main` before tagging. Releases and documentation builds depend on commits being present on the `main` branch.

2. **Run full local quality gates**:
   - TypeScript: `pnpm typecheck` — zero errors
   - Vitest: `pnpm test` — all suites must pass (currently 132 files / 1329 tests)
   - Production bundle: `pnpm build` — verifies bundle, WebAssembly modules, and PDF.js assets
   - Rust: `cd src-tauri && cargo fmt --check && cargo clippy && cargo check` — zero warnings/errors
   - Foliate runtime: `pnpm foliate:check` — clean pass

3. **Bump version in all 5 files**:
   - `package.json` — `version` field
   - `src-tauri/Cargo.toml` — `version` field
   - `src-tauri/tauri.conf.json` — `version` field
   - `src-tauri/crates/theorem-sync-core/Cargo.toml` — `version` field
   - `src-tauri/crates/theorem-core/Cargo.toml` — `version` field

4. **Update `CHANGELOG.md`** with the new version, release date, and detailed change entries.

5. **Regenerate icons** from `public/favicon.svg` (the source used by CI):
   ```bash
   pnpm tauri icon public/favicon.svg
   ```

6. **Landing page automated rebuild hook**:
   - Theorem landing page (`theorem-landing`) auto-rebuilds via `.github/workflows/notify-landing.yml` upon release publication using repository secret `CLOUDFLARE_DEPLOY_HOOK_URL`.
   - The Hugo build parses `CHANGELOG.md` directly from `main` and updates `https://theorem.fundaments.work/changelog/`.

7. **Tag and push**:
   ```bash
   git tag v<version>
   git push origin v<version>
   ```
   CI (`release.yml`) triggers on tags matching `v[0-9]+.*`, builds all targets (Linux, macOS Intel & Apple Silicon, Windows, Android), signs artifacts, and publishes to GitHub Releases.
   If the release is a minor/patch version (`X.Y.Z` where `Z > 0`), mark it as a pre-release in GitHub:
   ```bash
   gh release edit v<version> --prerelease
   ```

### Release CI troubleshooting

The release workflow publishes a **draft** release first, then flips it public only if every platform job succeeds. So a failed job leaves assets uploaded but the release unpublished — fix and re-run rather than rebuilding from scratch.

**Android builds fail intermittently with a Maven Central `403`** (seen on 1.5.9):
```
Could not GET 'https://repo.maven.apache.org/maven2/org/jetbrains/kotlin/kotlin-stdlib/...'
Received status code 403 from server: Forbidden
> A problem occurred configuring project ':buildSrc'
```
This is Gradle failing to download the Kotlin plugin — a network/upstream issue, **not** a code defect. Re-run the failed job and it will pass:
```bash
gh run rerun <run-id> --failed
```
Do not "fix" this in the Rust code. To confirm the Rust side is genuinely healthy for Android before re-running:
```bash
cd src-tauri && cargo clippy --target aarch64-linux-android
```
Notes for debugging: Android logs are only downloadable **after** the whole run completes (`gh run view --job <id> --log-failed`), and the real Gradle cause sits *above* the verbose `Io(...)` wrapper error — search the log for `What went wrong`. Job IDs via `gh run view <run-id> --json jobs --jq '.jobs[].databaseId'`. Android takes ~20 min; Windows is usually the long pole.

### Android adaptive icon

The Android icon files in `src-tauri/gen/android/` are normally
auto-generated by `tauri android init` with Tauri defaults and then
ignored by `.gitignore`. Our customizations to these files must be
committed via the gitignore exceptions at `.gitignore:46-57`.

After running `tauri android init --ci`, CI regenerates these files
from the template. The `pnpm tauri icon public/favicon.svg` command
regenerates platform PNGs but does NOT regenerate the vector drawables
in `drawable-v24/`. These XML files are our permanent customization.

## Project Management

### GitHub Project Board

The [Theorem Roadmap](https://github.com/orgs/fundaments-work/projects/2) board tracks all active work.

**Custom fields**:
- `Status` — Todo / In Progress / Done
- `Priority` — Critical / High / Medium / Low
- `Area` — Reader / Sync / Mobile / Library / RSS / TTS / Vocabulary / Settings / UI/UX / Infrastructure / Documentation
- `Effort` — Story points (number)

**Workflow**: Issues enter the board at Todo → move to In Progress when work starts → Done when merged to `main`.

### Issue Labels

| Label | Purpose |
|-------|---------|
| `bug` | Confirmed defect |
| `enhancement` | Feature request |
| `sync` | P2P sync related |
| `reader` | EPUB/PDF rendering |
| `mobile` | Android-specific |
| `rss` | RSS feeds |
| `tts` | Text-to-speech |
| `library` | Library management |
| `vocabulary` | Dictionary/words |
| `settings` | App settings |
| `ui/ux` | UI/UX improvements |
| `infrastructure` | CI, build, plugins |
| `documentation` | Docs, README |
| `android` | Android platform |
| `performance` | Performance |
| `good first issue` | New contributor friendly |

New issues should be labeled by `Area` + type (`bug`/`enhancement`).

### Issue Templates

GitHub issue forms are configured at `.github/ISSUE_TEMPLATE/`:
- `bug_report.yml` — structured form with version, platform, logs fields
- `feature_request.yml` — structured form with scope dropdown
- `config.yml` — directs questions to Discussions

### PR Lifecycle

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full PR process. TL;DR:
1. Branch from `main` using `feature/` or `fix/` prefix
2. Atomic conventional commits (`feat:`, `fix:`, `chore:`, etc.)
3. Run quality gates before opening
4. CI runs typecheck, tests, build, Rust checks automatically
5. Maintainer reviews within a few days
6. Approved PRs are merged to `main`

### Release Workflow

See the [Release](#release) section above. CI (`release.yml`) auto-builds and publishes on tag push.

## Cross-repo contracts

Facts this repo shares with other repos. The design system is **read-only**
from here: change it in its own repo, never here.

### Buy Me Momo URL

The URL is written out in this repo as literals, on purpose: a compiled bundle
cannot depend on another repo at build time without real fragility in the
release pipeline.

- Code and config: `src/core/lib/support-prompt.ts` (the support nudge) and
  `.github/FUNDING.yml` (the Sponsor button).
- Docs: `docs/settings.md` and `docs/ARCHITECTURE.md`.
- There is no automated drift check (the `check:content` script and its CI job
  were removed in 1.6.0). The same URL is used by Lemma and the landing sites;
  every place it appears is listed in the handbook note `Brand/Support
  channels`. Change them all together.

### `Fundaments-Work/design-system` — visual language

The studio-wide system: `tokens.md`, `guidelines.md`, `brand/`, `canvas.html`.

- **The shipped code wins.** `tokens.md` states it directly: where the document
  and a shipped codebase disagree, the codebase is authoritative and the
  document is the bug. This repo's `src/core/styles/design-tokens.css` and
  `src/core/lib/design-tokens.ts` are the reference implementation.
- Nothing imports `design-system/` programmatically. Adoption is by hand, and
  that is the drift risk: when a token changes in a product, check whether
  `tokens.md` now disagrees and fix the document.
- Non-negotiable rules, per `tokens.md`: one dark base (`#141416`), corner radius
  `0` on every element, DM Sans/DM Mono at 300/400 only, hierarchy from size and
  colour rather than extra weights, and one accent for the whole lab: acid lime
  `#c6f135`. Theorem has no design system of its own. The only thing it keeps
  from the old one is the reader's serif for book content, which is content
  typography, not interface.
- Hover on an icon button is the accent colour, never a background. The sidebar is
  a fixed 48px rail with no collapse control; the open item is lime with a lime edge.

## CSS conventions

- `content-visibility: auto` + `overscroll-behavior: contain` on scroll containers
- Animate only with Tailwind utilities; guard `animate-fade-in` behind `prefers-reduced-motion: no-preference`
- Use `cn()` from `src/core/lib/utils.ts` for class composition
- Safe areas: use `var(--safe-area-top|right|bottom|left)`, never `env(safe-area-inset-*)` (a test enforces it). Android's WebView reports only the camera cutout through `env()`, so with edge-to-edge (always on from Android 15) pages drew under the status and gesture bars; `src/core/lib/system-insets.ts` feeds Android's real insets (`system_insets` command) into the tokens
- Design tokens in `src/core/styles/design-tokens.css` + `@theme` block in `src/index.css`
