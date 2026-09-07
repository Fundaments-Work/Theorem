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

The `foliate-js` submodule at `src/features/reader/foliate-js/` is vendored upstream — do not edit. Our runtime wrapper is `src/features/reader/foliate-js-runtime/` (ours, edit freely). The sync script `scripts/sync-foliate-js.sh` patches imports and applies runtime patches.

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
- Rust (if any `.rs` changed): `cd src-tauri && cargo fmt && cargo clippy && cargo check` — fmt must produce no diff, clippy zero warnings

If clippy is noisy, try `cargo clippy --fix --lib` first.

CI (`ci.yml`) runs typecheck, test, build, and rust-check (fmt, clippy, check) on push to main.

## Architecture

**Routing**: Zustand-driven via `useUIStore.currentRoute` and `AppRoute` union type (`src/core/types/index.ts:366`). No React Router. Additions require updating: `src/App.tsx` (route switch + lazy load), `src/core/types/index.ts` (type), `src/shell/layout/Sidebar.tsx`, `src/shell/AppTitlebar.tsx`.

**Stores**: One file per slice in `src/core/store/`, barrel-rexported from `src/core/store/index.ts`. Always import from the barrel (`"../../core/store"`), not individual slice files. Import stores with individual selectors (`useUIStore(s => s.x)`), never destructuring.

**Imports**: Never import from the top-level barrel `src/core/index.ts` — it prevents tree-shaking. Import directly: `"../../core/store"` (stores), `"../../core/types"` (types), `"../../core/lib/env"` (env utils), `"../../core/lib/utils"` (cn). No path aliases.

**App entry**: `src/App.tsx` lazy-loads all route components (`React.lazy`). The reader chunk is pre-warmed via `prewarmReaderChunk()` on library mount. PDF.js is also pre-warmed.

**Reader**: Two rendering paths. Non-PDF: `ReaderViewport → useDocumentReader → FoliateEngine`. PDF: `PDFReader → PDFJsEngine`. `Reader.tsx` orchestrates both. **Theorem Lens** (`src/features/reader/components/FootnotePopover.tsx`): Anchored peek portal popover for footnotes and citations. **PDF Engine**: Uses strict on-demand range reading, worker destruction on unmount via `loadingTask.destroy()`, immediate canvas deallocation (`width = 0, height = 0`), and per-book `PdfViewState` persistence.

**EPUB pre-parser** (`src-tauri/src/epub_parser.rs`): Rust Tauri command `prefetch_zip_metadata` that pre-decodes EPUB ZIP text in parallel with zip.js. If the cache is populated, zip.js skips `getEntries()`. When changing the `ZipPrefetch` struct, update all 3 sides: Rust command, `src/core/lib/tauri-epub-bridge.ts` (TS interface), `src/features/reader/foliate-js-runtime/view.js` (consumer).

**EPUB metadata write-back** (`src-tauri/src/epub_rewriter.rs`): Rust Tauri command `rewrite_epub_metadata` that updates `<metadata>` dc:* fields in the OPF and optionally replaces/embeds the cover image, then overwrites the materialized `.book` file in place. Called from `src/core/lib/book-edit.ts` after metadata/cover edits; browser gets a best-effort fflate fallback in `src/core/lib/epub-write-browser.ts`. Encrypted EPUBs are rejected. Book export lives in `src/core/lib/book-export.ts` (desktop save dialog, Android `save_file_mobile` MediaStore download, browser `<a download>`).

**Runtime split**: Guard desktop-only code with `isTauri()` / `isTauriDesktop()` / `isTauriMobile()` / `isMobile()` from `src/core/lib/env.ts`. Provide browser fallbacks.

**Sync**: P2P via iroh stack (iroh + iroh-docs + iroh-blobs + iroh-gossip). 18 Tauri commands in `sync_commands.rs`. Iroh is always compiled (no feature gate). See `docs/PERFORMANCE_SYNC_AUDIT.md`.

**TTS (Immersion Reading)**: two narration paths, orchestrated by `src/features/reader/audio/ImmersionPlayer.ts` (UI lives in the reader navbar's immersion row — there is no separate ImmersionBar component):
- **Platform TTS (fallback, always available)**: Android `TextToSpeech` (custom `tauri-plugin-android-tts-audio`), Linux `spd-say` (`src-tauri/src/tts_linux.rs`), macOS `say`, Windows PowerShell `System.Speech`. Android supports engine selection (`tts_get_engines`/`tts_set_engine`), real word boundaries (`tts-utterance-range` events), and `tts_synthesize_to_file`.
- **Neural Voice (desktop)**: Supertonic 3 fp32 ONNX pipeline — `src-tauri/src/tts_model.rs` (on-demand download of models/runtime/voices from `fundaments-work/supertonic-assets` releases with SHA-256 verification; nothing ships in the app) + `src-tauri/src/supertonic.rs` (ort `load-dynamic`, sentence chunking, 1GB WAV cache keyed by SHA-256(text+voice+speed), `tts_synthesize`/`tts_prefetch`/`tts_neural_status`). Playback runs natively in Rust via `src-tauri/src/audio_player.rs` (rodio/cpal — the webview audio stack proved unreliable) with real pause/resume/seek, and is **streamed**: the first sentence chunk plays while the rest synthesize into the queue (`tts_text_chunks` + `tts_audio_append`); `tts_engine_preload` warms the models when the reader opens. Settings → General → Neural Voice manages the install; on Android neural narration requires the Theorem Neural Voice companion TTS engine app (fork of DevGitPit/supertonic-android at fundaments-work/supertonic-android; Settings picks it via engine selection).
- Docs: `docs/tts.md`.

**Notifications**: Reading goal + sync completion notifications active:
- Rust: `tauri-plugin-notification` registered in `lib.rs:851`; `sqlite_check_goal_reminder` reads daily stats from `kv_store`
- Frontend: `src/core/lib/notifications.ts` exports `notify()`, `notifyIfGranted()`, `requestNotificationPermission()`
- Goal met detection: `src/features/reader/hooks/useReadingTime.ts` after each flush
- Scheduled reminder: `src/features/reader/hooks/useDailyGoalReminder.ts` — 5-min interval calling Rust command
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
- **Storefront**: `src/features/catalogs/DiscoverPage.tsx` provides an editorial discovery experience with curated sections (Gutenberg, Standard Ebooks) and custom OPDS 1.2 feeds.
- **Service**: `src/core/services/DiscoverService.ts` queries OPDS 1.2 XML / Atom feeds with Dublin Core metadata and EPUB acquisition links.
- **Virtualization**: Search results use `@tanstack/react-virtual` for fast rendering across 75,000+ public domain titles.
- **Cover system**: `src/ui/TheoremBookCover.tsx` renders deterministic clothbound covers across 7 palettes for books without bundled artwork.

## Tauri backend

**Companion Audiobooks**: attach human-narrated audio to any book. `src-tauri/src/audiobook.rs` (`extract_audiobook_metadata`) parses `.m4b/.m4a/.mp3` duration, tags, cover and chapters (M4B chapters via a hand-rolled QuickTime chapter-track walker — no crate exposes them). Optional `Book.audioTrack` (`BookAudioTrack` in types) lives in the library store and syncs; attach/detach via the library context menu. Playback: `src/features/reader/audio/AudiobookBar.tsx` (HTMLAudioElement via asset protocol, chapters, speed, sleep timer, mediaSession, position auto-save). Generation: `src-tauri/src/audiobook_gen.rs` (`generate_audiobook`, desktop only) narrates EPUB sections through Supertonic and encodes one Ogg Opus per book (36kbps mono, hand-rolled Ogg muxer + `audiopus`/libopus static) with chapter marks, then attaches it as the book's `audioTrack` (format `opus`). Docs: `docs/audiobook.md`.

125 commands across `lib.rs` (file I/O, network, TTS, multi-window, misc), `database.rs` (31 SQLite commands), `sync_commands.rs` (15 sync commands), `epub_parser.rs` (pre-fetch ZIP metadata, pre-inflate initial spine chapters and CSS), `epub_rewriter.rs` (metadata/cover write-back), `file_transfer.rs`, `batch_ingest.rs` (parallel batch library ingestion and SIMD cover extraction), `mdict.rs` (native memory-mapped MDict .mdx parser, zlib block cache, entry:// link handling), `stardict.rs` (native memory-mapped StarDict lookup, DictZip auto-inflation, POS segmentation), `book_search.rs` (multi-threaded streaming in-book search), `mobi_parser.rs` (native PalmDOC LZ77 decompressor and PDB unpacker), `article_extractor.rs` (native web article fetch and readability extraction), `opds_parser.rs` (native streaming OPDS 1.2 catalog parsing), `epubcfi.rs` (EPUB CFI parser/resolver used by the CLI), `audiobook.rs` + `audiobook_gen.rs` (companion audiobook metadata parsing and Ogg Opus generation), `tts_model.rs` + `supertonic.rs` (neural voice download and fp32 inference), `audio_player.rs` (native rodio playback, desktop-only), and `cli.rs`/`cli_tui.rs` (headless CLI + ratatui TUI, desktop-only). To find all: `grep -r '#\[tauri::command\]' src-tauri/src/`. When signatures change, update both Rust and TS call sites.

## Persistence

SQLite via `rusqlite` + `r2d2` pool. All connections use `with_connection()` — never open raw `Connection::open()`. Migrations are versioned per store (Zustand persist middleware). When changing persisted schemas: bump version, update defaults, add/adjust `migrate`.

Key constraints: `book.locations` (foliate-js positions) must NOT be stored in Zustand — use SQLite BLOB. `data:` cover paths ARE serialized into sync payloads (covers are downsampled to ≤200×300 webp ~tens of KB) so that cover edits propagate to peers; keep them small.

## Anti-patterns (violations = bugs)

- No React Router — use `useUIStore.currentRoute`
- No `transition-all` — specify the exact property
- No `snap-x snap-mandatory` on scroll containers
- No barrel imports from `src/core/index.ts`
- No Zustand destructuring (`const { x } = useStore()`)
- No `awaitSettledLayout()` / double-RAF delays after navigation (paginator container is grid-sized, measurements are immediate)
- No `Array.find()` on books array — use `getBook(bookId)` or `getBookLookup().get(bookId)`
- No `console.log` in production code — use `import.meta.env.DEV` guards

## Release

### Before tagging a release

1. **Bump version** in all 4 files:
   - `package.json` — `version` field
   - `src-tauri/Cargo.toml` — `version` field
   - `src-tauri/tauri.conf.json` — `version` field
   - `src-tauri/crates/theorem-sync-core/Cargo.toml` — `version` field

2. **Update `CHANGELOG.md`** with the new version and date.

3. **Regenerate icons** from `theorem.svg` (the official logo):
   ```bash
   pnpm tauri icon theorem.svg
   watch -n10 'ls -la src-tauri/gen/android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml'
   ```

4. **Tag and push**:
   ```bash
   git tag v<version>
   git push origin v<version>
   ```
   CI (`release.yml`) triggers on tags matching `v[0-9]+.*`, builds all
   targets, signs artifacts, and publishes to GitHub Releases.

### Android adaptive icon

The Android icon files in `src-tauri/gen/android/` are normally
auto-generated by `tauri android init` with Tauri defaults and then
ignored by `.gitignore`. Our customizations to these files must be
committed via the gitignore exceptions at `.gitignore:46-52`.

After running `tauri android init --ci`, CI regenerates these files
from the template. The `pnpm tauri icon theorem.svg` command
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

## CSS conventions

- `content-visibility: auto` + `overscroll-behavior: contain` on scroll containers
- Animate only with Tailwind utilities; guard `animate-fade-in` behind `prefers-reduced-motion: no-preference`
- Use `cn()` from `src/core/lib/utils.ts` for class composition
- Design tokens in `src/core/styles/design-tokens.css` + `@theme` block in `src/index.css`
