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
| Rust lint | `cd src-tauri && cargo clippy --all-features --all-targets -- -D warnings` |
| Rust tests | `cd src-tauri && cargo test --workspace --lib --tests` |
| One Rust test | `cd src-tauri && cargo test --lib <name>` |
| Sync scenarios | `cd src-tauri && cargo test --lib scenarios::` (large library: `cargo test --release --lib scenarios::a_large_library -- --ignored --nocapture`) |
| End-to-end (real app) | `pnpm e2e:build` once, then `pnpm e2e [spec-word]` (Linux; see `docs/testing-e2e.md`) |
| Foliate runtime | `pnpm foliate:check` |
| Rust release build | `cd src-tauri && cargo build --release` |

Root `pnpm` commands run from repo root. Cargo commands run from `src-tauri/`. `pnpm build` runs typecheck first. Clippy with `--all-features` builds the `e2e` feature, which embeds `dist/`: run `pnpm build` once first in a fresh checkout.

## Quality Gates (before every commit)

All of these, in this order; each must be clean (this is what CI runs, plus the build):

1. `cd src-tauri && cargo fmt --check` — no diff
2. `cargo clippy --all-features --all-targets -- -D warnings` — zero warnings, tests included
3. `cargo test --workspace --lib --tests`
4. `pnpm install --frozen-lockfile` — CI installs frozen; a dependency change must update `pnpm-lock.yaml`
5. `pnpm typecheck`
6. `pnpm test` — the whole suite, not only the files you touched
7. `pnpm build` — also enforces the startup bundle budget
8. When relevant: `pnpm foliate:check` (reader runtime), `cargo clippy --target aarch64-linux-android -- -D warnings` (Android-only code or dependencies; set the NDK `CC_/CXX_/AR_aarch64_linux_android` compilers), `pnpm e2e` (user-visible flows)

If clippy is noisy, try `cargo clippy --fix --lib` first, then read what it changed.

### Testing Integrity & Outlier Coverage

- Tests must rigorously cover edge cases, boundaries, and outliers (e.g. 0-length inputs, rapid concurrent interactions, missing elements, corrupted data, boundary navigation).
- **NEVER weaken, delete, loosen assertions, or edit tests simply to make them pass.** If a test or outlier fails, investigate and fix the underlying implementation code. The test exists to defend correctness.
- Pick the layer that can actually see the bug: Vitest (`tests/`) for TS logic; Rust unit tests next to the code; `src-tauri/src/sync_scenarios.rs` for anything about sync between devices (real iroh nodes, own data folders, loopback and a local relay); `e2e/specs/` for what a person does in the real app. The e2e specs are also the behaviour spec for the 2.0 Svelte UI, so they assert on what is on screen, never on React internals.
- Source-reading tests (tests that read a `.rs`/`.ts` file and assert on its text) follow the code when it moves: point them at the new file with the same assertions.

CI (`ci.yml`) runs typecheck, test, build, and rust-check (fmt, clippy, check, `cargo test --workspace --lib --tests`) on push to main.

### Known-flaky tests

- `tests/release-1.0.7-store-scale.test.ts` asserts a wall-clock budget (`expect(elapsed).toBeLessThan(25)`) and can exceed it under full-suite parallel load while passing in isolation. Treat a lone failure here as a perf-measurement flake: re-run the file alone (`pnpm test tests/release-1.0.7-store-scale.test.ts`) to confirm, but still verify no genuine O(n) scan was introduced.
- `tests/library-virtualization.test.ts` ("Row height estimation") asserts `elapsed < 1` ms for a pure size calculation and can exceed it under full-suite load. Same rule: re-run the file alone to confirm.

Do not add to this list casually. A new intermittent failure is a bug until shown otherwise: find what the test waits for versus what it should wait for, and wait on that condition (never a longer sleep or a looser assertion). If the flake shows a product bug, fix the product. Prove the fix with repeated runs and report the count (e.g. 20/20).

## How we work

The standard every change is held to, whether a person or an agent writes it.

**Bugs**
- Reproduce first, with a test that fails for the reason you think. Then fix, and keep the test.
- For timing-dependent bugs, run the test repeatedly before and after the fix and report both counts (e.g. "fails 5/5 without, passes 10/10 with").
- Find the root cause, not the symptom. When the behaviour depends on a dependency (iroh-docs, foliate-js, rusqlite …), read its source (`~/.cargo/registry`, the submodule) and write the exact rule you relied on into the relevant `docs/*.md`. Don't design around a guess.

**Changes**
- Make the smallest change that is safe. Moving code (splitting a module, renaming) is its own commit with no behaviour change.
- Never change a persisted or synced format without a compatibility path:
  - bump the version (`SYNC_PROTOCOL`, store `version` + `migrate`);
  - keep reading the old form;
  - keep writing it for peers that still need it;
  - prove that mixed old/new data neither loses nor resurrects anything.
- Back performance claims with numbers: release build, the same machine, before and after, with the size of the data.
- Errors are typed (see Errors). Never branch on message text.

**Docs travel with the code**
- Every behaviour change updates its `docs/<area>.md`, the `CHANGELOG.md` entry of the unreleased version, and this file when a rule, module layout or command changes.
- Don't hard-code counts that drift (test totals, line numbers). When you state one, check it.

**Commits**
- Atomic conventional commits (`feat:`, `fix:`, `perf:`, `test:`, `docs:`, `refactor:`, `chore:`), one concern each.
- Signed off (`git commit -s`). AI-assisted commits end with a `Co-Authored-By:` line naming the model.
- Commit only your own changes. Never sweep in unrelated files from the working tree.

**Never without the maintainer's approval:** merge to `main`, tag, publish a release, deploy, or close an issue.

**Reporting back**
- Say what was verified and how (commands, run counts, measurements), what was not verified, and what risk remains.
- A fix that was not tested end to end is reported as such, not as done.

**Parallel and agent work**
- One git worktree per agent or task, each with its own `CARGO_TARGET_DIR`. A shared target dir has linked stale crates into another checkout's build.
- Cap heavy builds and tests so several can run at once without exhausting memory.
- Never `pkill -f` by pattern: stop only the PIDs you started.
- Never use bare `git stash` / `git stash pop`: the stash is shared across worktrees. Use a WIP commit instead.
- On the maintainer's machine the tools for this live in the private `fundaments-agent-harness` repo, documented in the Fundaments handbook (`Engineering/Agent harness.md`):
  - `resources/capped.sh <mem> <cpu%> cmd` runs a command inside the shared memory slice;
  - `theorem/gates.sh <worktree> [--android]` runs every gate above;
  - `theorem/land-worktree.sh <branch>` merges into the release branch, runs the gates, pushes and removes the worktree.

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

**Sync**: P2P via iroh stack (iroh + iroh-docs + iroh-blobs + iroh-gossip). 23 Tauri commands in `sync_commands.rs`. Iroh is always compiled (no feature gate). See `docs/sync.md`. Security lives in `src-tauri/src/sync_access.rs`: every sync protocol except pairing is closed to devices that are not paired (`PeerGate`, an endpoint hook, so new protocols are covered automatically); pairing needs the QR code's one-time secret plus the user's approval; book requests are IDs, never paths, and only book files are served. Every change to `paired_devices` goes through `SyncTransportState::persist_paired` (it also updates the allowlist). Never take file paths from synced data, and never write a `kv_store` key from sync that is not in `is_syncable_kv_key`. Doc entries are one per item (`book:`, `collection:`, `vocab:`, `rss_feed:`, `rss_article:`, `tomb:`), except annotations: one entry per book and device, `annos:{bookId}:` (records by ID plus deletion markers, `src-tauri/src/sync_annotations.rs`, sync protocol 3), built in Rust from the app's `anno:{bookId}:{id}` entries and expanded back into them on read, merged per annotation by stamps across every copy. The trailing `:` matters: writing an iroh-docs key removes that author's older entries under it. Per-annotation `anno:` entries are still read, and written only for devices on protocol < 3; whole lists go only to devices on protocol < 2. Never empty or prefix-delete annotation entries to clean up: empty entries read as deletions, and iroh-docs puts older entries back under a deletion. Never rewrite an unchanged doc entry (`write_own_entries` skips them): a rewrite dates it now and undoes other devices' deletions, which live in the docs as empty entries and are read back as `deleted`. iroh-docs lets an older non-empty copy of this device's own entry replace its emptied one, so each device records the deletions it writes (`sync_deletions.rs`, `iroh-docs/own-deletions.jsonl`); an own entry older than a recorded deletion is read as the deletion and the deletion is put back with its original timestamp. Never "re-delete" through the docs API instead: it stamps the current time and would beat later edits made elsewhere. Book and annotation edits carry a base stamp (`metadataBaseAt`, `baseUpdatedAt`) for conflict detection in the native merge. Every sync change gets a scenario in `sync_scenarios.rs` (three devices, a device that was away, both exchange orders); `docs/sync.md` holds the rules and measurements.

**TTS (Immersion Reading)**: two narration paths, orchestrated by `src/features/reader/audio/ImmersionPlayer.ts` (UI lives in the reader navbar's immersion row — there is no separate ImmersionBar component):
- **Platform TTS (fallback, always available)**: Android `TextToSpeech` (custom `tauri-plugin-android-tts-audio`), Linux `spd-say` (`src-tauri/src/tts_linux.rs`), macOS `say`, Windows PowerShell `System.Speech`. Android supports engine selection (`tts_get_engines`/`tts_set_engine`), real word boundaries (`tts-utterance-range` events), and `tts_synthesize_to_file`.
- **Neural Voice (desktop)**: Supertonic 3 fp32 ONNX pipeline — `src-tauri/src/tts_model.rs` (on-demand download of models/runtime/voices from `fundaments-work/supertonic-assets` releases with SHA-256 verification; nothing ships in the app) + `src-tauri/src/supertonic.rs` (ort `load-dynamic`, sentence chunking, 150 MB least-recently-used WAV cache keyed by SHA-256(cache version+model release+lang+voice+speed+text), written atomically, one synthesis per key at a time; the reader always synthesizes at 1× and the native player applies the speed, `tts_synthesize`/`tts_prefetch`/`tts_neural_status`). Playback runs natively in Rust via `src-tauri/src/audio_player.rs` (rodio/cpal — the webview audio stack proved unreliable) with real pause/resume/seek, and is **streamed**: the first sentence chunk plays while the rest synthesize into the queue (`tts_text_chunks` + `tts_audio_append`); `tts_engine_preload` warms the models when the reader opens. Settings → General → Neural Voice manages the install; on Android neural narration requires the Theorem Neural Voice companion TTS engine app (fork of DevGitPit/supertonic-android at fundaments-work/supertonic-android; Settings picks it via engine selection).
- Docs: `docs/tts.md`.

**Notifications**: Reading goal + sync completion notifications active:
- Rust: `tauri-plugin-notification` registered in `run()` in `lib.rs`; `sqlite_check_goal_reminder` reads daily stats from `kv_store`
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

210 `#[tauri::command]` attributes (190 distinct command names registered in `generate_handler!`; some have desktop/mobile `cfg` variants, and `offload_commands.rs` re-exposes blocking commands as async wrappers) across `lib.rs` (`run()`: plugins, window events and the one `generate_handler!` list; the `setup()` hook is `setup.rs`, the tray `tray.rs`) and its domain modules: `pdf.rs` (PDF structure parser, metadata, range reads), `reader_files.rs`, `web_fetch.rs` (feed/article/binary fetches), `open_files.rs` (OS open-file arguments and `file://` URIs), `library_folder.rs`, `tts_platform.rs` (OS-voice TTS commands), `window.rs` (reader windows, print, hide to tray), `lifecycle.rs` (graceful quit, build info, memory trim), `cli_install.rs` (Linux CLI symlink), `dictionary_net.rs` (StarDict download/extract, online definitions) and `android.rs` (MediaStore saves, content URIs, insets, reading reminder, fingerprint, NDK context); `database.rs` + `database/` (SQLite persistence, surfaced through `offload_commands.rs`: `database.rs` holds the pool, PRAGMAs, `with_connection` and `DataStore`; one module per domain: `schema`, `books`, `covers`, `kv`, `annotations`, `sync_merge`, `sync_conflicts`, `rss`, `reading`, `vocabulary`, `storage`, `legacy`, `files`; all re-exported as `crate::database::*`), `db_backup.rs` (streaming `.theorem-backup` archives, restore, rolling DB snapshots and the startup integrity guard), `sync_commands.rs` (23 sync commands), `epub_parser.rs` (pre-fetch ZIP metadata, pre-inflate initial spine chapters and CSS), `epub_rewriter.rs` (metadata/cover write-back), `file_transfer.rs`, `batch_ingest.rs` (parallel batch library ingestion, SIMD cover extraction, series metadata), `cbr.rs` (native CBR/RAR→CBZ comic archive parsing via `rars`), `mdict.rs` (native memory-mapped MDict .mdx parser, zlib block cache, entry:// link handling), `stardict.rs` (native memory-mapped StarDict lookup, DictZip auto-inflation, POS segmentation), `book_search.rs` (multi-threaded streaming in-book search), `mobi_parser.rs` (native PalmDOC LZ77 decompressor and PDB unpacker), `article_extractor.rs` (native web article fetch and readability extraction), `opds_net.rs` (native OPDS catalog fetch with Basic auth, search and streamed downloads; parsing is in `theorem-core::opds`), `epubcfi.rs` (EPUB CFI parser/resolver used by the CLI), `audiobook.rs` + `audiobook_gen.rs` (companion audiobook metadata parsing and Ogg Opus generation; `delete_generated_audiobook` only deletes inside the app's `audiobooks` folder), `tts_desktop.rs` (hardened macOS/Windows/Linux OS-voice spawning: text never reaches a shell, tracked process), `tts_model.rs` + `supertonic.rs` (neural voice download and fp32 inference), `audio_player.rs` (native rodio playback, desktop-only), `smart_shelves.rs` + `vault_export.rs` (rule evaluation and Rayon vault export), `fuzzy_search.rs` + `stemmer.rs` (SIMD ranking and lemmatization), and `cli.rs` + `cli/` (headless CLI, desktop-only: `cli.rs` holds the arguments, dispatch and exit codes, `cli/` one module per subcommand plus `output.rs` and `store.rs`) with `cli_tui.rs` (ratatui TUI). To find all: `grep -r '#\[tauri::command\]' src-tauri/src/`. When signatures change, update both Rust and TS call sites.

## Persistence

SQLite via `rusqlite` + `r2d2` pool. All connections use `with_connection()` — never open raw `Connection::open()`. The one exception is `db_backup.rs`, whose online-backup copies need connections of their own (as `run_schema_migrations` does). Startup runs `db_backup::run_startup_guard`: `PRAGMA quick_check` once a day and on every version change, before migrations, plus a snapshot into `db-snapshots/` (two kept): before migrations on a version change (the rollback point), and from `db_maintenance` after the window on a same-version daily check; a damaged database or failed migration becomes `db_health_status`, which `main.tsx` reads before rendering. Before the window, `setup()` runs only that guard and `database::run_startup_migrations` (schema + versioned migrations the UI reads); the slow repairs (cover data-URL conversion, legacy book/StarDict BLOB reclaim, the `syncedWithoutFile` heal, legacy dir cleanup, `reconcile_books_fts`, and `VACUUM` once the DB has been idle 20 s) run in `db_maintenance.rs` on a background thread, only on a healthy database, with writes guarded so they never overwrite a change the app made meanwhile. Healed books reach the UI via `library-books-healed` (`src/core/lib/healed-books.ts`). The CLI and restore still run everything inline (`run_schema_migrations`). Backups strip the device's sync identity and catalog credentials; restore keeps the restoring device's own. Covers are stored as raw bytes + MIME (`covers.data`, `covers.mime`) and served by `theorem-cover://`; the cover commands and sync still exchange data URLs. `books_fts` is reconciled with the library after startup (`reconcile_books_fts`, in `db_maintenance`). Migrations are versioned per store (Zustand persist middleware). When changing persisted schemas: bump version, update defaults, add/adjust `migrate`.

## Errors

`crate::error::AppError` is a kind (`Busy`, `Corrupt`, `Constraint`, `NotFound`, `InvalidInput`, `Io`, `Network`, `Internal`) plus the human message. `with_connection` returns it, classifying rusqlite errors by SQLite result code while keeping the old "SQLite operation failed: …" text; the database layer, the `offload_commands.rs` wrappers and `web_fetch.rs` (Network) return it.

- **Wire format is the plain message string** (custom `Serialize`), so every TS call site that does `String(e)`, `typeof e === "string"` or `.includes(...)` sees the same text as before. The TS side reads the kind with `errorKind(e)` (`src/core/lib/error-kind.ts`): from `{ kind, message }` when given one, else from the message (SQLite's own result-code texts, pinned by tests in `error.rs`). `AppError::to_structured()` gives `{ kind, message }` for consumers that want it (the 2.0 plugin API).
- **New commands**: return `Result<T, AppError>`; construct with `AppError::not_found(..)`, `::invalid_input(..)`, `::network(..)`, `::io(..)`, or `?` a rusqlite error through `with_connection`. A `String` error converts to `Internal`; an `AppError` converts to `String` (`?` works in either direction), so old `Result<_, String>` code needs no change. Never match on message text to decide behaviour: match on `kind()`.
- **CLI**: `Output::error` takes anything `Into<AppError>` and picks the exit code from the kind (`exit_code_for`: NotFound 3, Network 4, else 1); `--json` errors carry `"kind"`. A not-found error must be built as `AppError::not_found`, or it exits 1.

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

2. **Run full local quality gates**: every step of [Quality Gates](#quality-gates-before-every-commit), including `pnpm foliate:check`, Android clippy and `pnpm e2e`.

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
