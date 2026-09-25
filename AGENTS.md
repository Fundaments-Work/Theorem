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

CI (`ci.yml`) runs typecheck, test, build, and rust-check (fmt, clippy, check) on push to main.

## Architecture

**Routing**: Zustand-driven via `useUIStore.currentRoute` and `AppRoute` union type (`src/core/types/index.ts:403`). No React Router. Additions require updating: `src/App.tsx` (route switch + lazy load), `src/core/types/index.ts` (type), `src/shell/layout/Sidebar.tsx`, `src/shell/AppTitlebar.tsx`.

**Stores**: One file per slice in `src/core/store/`, barrel-rexported from `src/core/store/index.ts`. Always import from the barrel (`"../../core/store"`), not individual slice files. Import stores with individual selectors (`useUIStore(s => s.x)`), never destructuring.

**Imports**: Never import from the top-level barrel `src/core/index.ts` — it prevents tree-shaking. Import directly: `"../../core/store"` (stores), `"../../core/types"` (types), `"../../core/lib/env"` (env utils), `"../../core/lib/utils"` (cn). No path aliases.

**App entry**: `src/App.tsx` lazy-loads all route components (`React.lazy`). The reader chunk is pre-warmed via `prewarmReaderChunk()` in `src/App.tsx` after store hydration (scheduled idle task). PDF.js is also pre-warmed.

**Reader**: Two rendering paths. Non-PDF: `ReaderViewport → useDocumentReader → FoliateEngine`. PDF: `PDFReader → PDFJsEngine`. `Reader.tsx` orchestrates both. **Theorem Lens** (`src/features/reader/components/FootnotePopover.tsx`): Anchored peek portal popover for footnotes and citations. **PDF Engine**: Uses strict on-demand range reading, worker destruction on unmount via `loadingTask.destroy()`, immediate canvas deallocation (`width = 0, height = 0`), and per-book `PdfViewState` persistence.

**EPUB pre-parser** (`src-tauri/src/epub_parser.rs`): Rust Tauri command `prefetch_zip_metadata` that pre-decodes EPUB ZIP text in parallel with zip.js. If the cache is populated, zip.js skips `getEntries()`. When changing the `ZipPrefetch` struct, update all 3 sides: Rust command, `src/core/lib/tauri-epub-bridge.ts` (TS interface), `src/features/reader/foliate-js-runtime/view.js` (consumer).

**EPUB metadata write-back** (`src-tauri/src/epub_rewriter.rs`): Rust Tauri command `rewrite_epub_metadata` that updates `<metadata>` dc:* fields in the OPF and optionally replaces/embeds the cover image, then overwrites the materialized `.book` file in place. Called from `src/core/lib/book-edit.ts` after metadata/cover edits; browser gets a best-effort fflate fallback in `src/core/lib/epub-write-browser.ts`. Encrypted EPUBs are rejected. Book export lives in `src/core/lib/book-export.ts` (desktop save dialog, Android `save_file_mobile` MediaStore download, browser `<a download>`).

**Runtime split**: Guard desktop-only code with `isTauri()` / `isTauriDesktop()` / `isTauriMobile()` / `isMobile()` from `src/core/lib/env.ts`. Provide browser fallbacks.

**Sync**: P2P via iroh stack (iroh + iroh-docs + iroh-blobs + iroh-gossip). 15 Tauri commands in `sync_commands.rs`. Iroh is always compiled (no feature gate). See `docs/sync.md`.

**TTS (Immersion Reading)**: two narration paths, orchestrated by `src/features/reader/audio/ImmersionPlayer.ts` (UI lives in the reader navbar's immersion row — there is no separate ImmersionBar component):
- **Platform TTS (fallback, always available)**: Android `TextToSpeech` (custom `tauri-plugin-android-tts-audio`), Linux `spd-say` (`src-tauri/src/tts_linux.rs`), macOS `say`, Windows PowerShell `System.Speech`. Android supports engine selection (`tts_get_engines`/`tts_set_engine`), real word boundaries (`tts-utterance-range` events), and `tts_synthesize_to_file`.
- **Neural Voice (desktop)**: Supertonic 3 fp32 ONNX pipeline — `src-tauri/src/tts_model.rs` (on-demand download of models/runtime/voices from `fundaments-work/supertonic-assets` releases with SHA-256 verification; nothing ships in the app) + `src-tauri/src/supertonic.rs` (ort `load-dynamic`, sentence chunking, 1GB WAV cache keyed by SHA-256(text+voice+speed), `tts_synthesize`/`tts_prefetch`/`tts_neural_status`). Playback runs natively in Rust via `src-tauri/src/audio_player.rs` (rodio/cpal — the webview audio stack proved unreliable) with real pause/resume/seek, and is **streamed**: the first sentence chunk plays while the rest synthesize into the queue (`tts_text_chunks` + `tts_audio_append`); `tts_engine_preload` warms the models when the reader opens. Settings → General → Neural Voice manages the install; on Android neural narration requires the Theorem Neural Voice companion TTS engine app (fork of DevGitPit/supertonic-android at fundaments-work/supertonic-android; Settings picks it via engine selection).
- Docs: `docs/tts.md`.

**Notifications**: Reading goal + sync completion notifications active:
- Rust: `tauri-plugin-notification` registered in `lib.rs:1177`; `sqlite_check_goal_reminder` reads daily stats from `kv_store`
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
- **Cover system**: `src/ui/TheoremBookCover.tsx` renders a deterministic clothbound fallback cover for books without bundled artwork.

## Tauri backend

**Companion Audiobooks**: attach human-narrated audio to any book. `src-tauri/src/audiobook.rs` (`extract_audiobook_metadata`) parses `.m4b/.m4a/.mp3` duration, tags, cover and chapters (M4B chapters via a hand-rolled QuickTime chapter-track walker — no crate exposes them). Optional `Book.audioTrack` (`BookAudioTrack` in types) lives in the library store and syncs; attach/detach via the library context menu. Playback: `src/features/reader/audio/AudiobookBar.tsx` (HTMLAudioElement via asset protocol, chapters, speed, sleep timer, mediaSession, position auto-save). Generation: `src-tauri/src/audiobook_gen.rs` (`generate_audiobook`, desktop only) narrates EPUB sections through Supertonic and encodes one Ogg Opus per book (36kbps mono, hand-rolled Ogg muxer + `audiopus`/libopus static) with chapter marks, then attaches it as the book's `audioTrack` (format `opus`). Docs: `docs/audiobook.md`.

126 `#[tauri::command]` attributes (111 distinct command names; some have desktop/mobile `cfg` variants) across `lib.rs` (file I/O, network, TTS, multi-window, misc), `database.rs` (31 SQLite commands), `sync_commands.rs` (15 sync commands), `epub_parser.rs` (pre-fetch ZIP metadata, pre-inflate initial spine chapters and CSS), `epub_rewriter.rs` (metadata/cover write-back), `file_transfer.rs`, `batch_ingest.rs` (parallel batch library ingestion and SIMD cover extraction), `mdict.rs` (native memory-mapped MDict .mdx parser, zlib block cache, entry:// link handling), `stardict.rs` (native memory-mapped StarDict lookup, DictZip auto-inflation, POS segmentation), `book_search.rs` (multi-threaded streaming in-book search), `mobi_parser.rs` (native PalmDOC LZ77 decompressor and PDB unpacker), `article_extractor.rs` (native web article fetch and readability extraction), `opds_parser.rs` (native streaming OPDS 1.2 catalog parsing), `epubcfi.rs` (EPUB CFI parser/resolver used by the CLI), `audiobook.rs` + `audiobook_gen.rs` (companion audiobook metadata parsing and Ogg Opus generation), `tts_model.rs` + `supertonic.rs` (neural voice download and fp32 inference), `audio_player.rs` (native rodio playback, desktop-only), and `cli.rs`/`cli_tui.rs` (headless CLI + ratatui TUI, desktop-only). To find all: `grep -r '#\[tauri::command\]' src-tauri/src/`. When signatures change, update both Rust and TS call sites.

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
   - Vitest: `pnpm test` — all 72 suites must pass
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

## CSS conventions

- `content-visibility: auto` + `overscroll-behavior: contain` on scroll containers
- Animate only with Tailwind utilities; guard `animate-fade-in` behind `prefers-reduced-motion: no-preference`
- Use `cn()` from `src/core/lib/utils.ts` for class composition
- Design tokens in `src/core/styles/design-tokens.css` + `@theme` block in `src/index.css`
