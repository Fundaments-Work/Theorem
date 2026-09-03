# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Neural Voice (Supertonic 3, desktop)** — Full offline fp32 neural TTS. The fp32 ONNX models, voice styles, and the ONNX Runtime dylib (~400MB) are downloaded on first use from the `supertonic-assets` GitHub releases with SHA-256 verification — nothing ships in the app. Rust inference via `ort` (`load-dynamic`) with sentence-aware chunking, a 1GB content-hash WAV cache, and next-chunk prefetch. Ten voices (F1–M5), 31 languages, speed control. Playback runs through Web Audio with real pause/resume/seek. Managed in Settings → General → Neural Voice.
- **Companion Audiobooks** — Attach a DRM-free `.m4b`/`.m4a`/`.mp3` to any book from its context menu; the reader's immersion mode upgrades into a human-narrated player (scrubber over the real duration, ±15s skips, speed chips, chapter menu, sleep timer, lock-screen media controls, synced playback position). Chapters, duration and cover are parsed natively in Rust (including a QuickTime chapter-track walker for M4B).
- **Save as Audiobook (desktop)** — Generate a complete audiobook from an open book with the neural voice: one click narrates every section and encodes a single Ogg Opus file (~16MB/hour at 36kbps mono) with chapter marks, then attaches it to the book. Background task with progress and cancel.
- **Headless CLI & TUI** — `theorem <command>` gives agents and terminals full app parity: library, shelves, search, read, dict, extract, annotations, bookmarks, RSS, OPDS, sync, storage, stats, export, and open. JSON output (`--json`) for scripting, TTY-aware colored output with the THEOREM logo, and an interactive ratatui TUI (`theorem tui`). Enable/disable from Settings → General with startup auto-heal.
- **Android TTS engine selection** — Enumerate and switch system TTS engines from Settings (fixing silent engine-switch failures), with real word-boundary events for the immersion reader and `synthesizeToFile` support. Neural narration on Android uses the installable Theorem Neural Voice companion engine app.

### Improved

- **P2P sync** — Remote doc entries are batched into single IPC events for faster sync; deletion tombstones older than 90 days are pruned at startup.
- **Android footprint** — Panic=abort, `opt-level=z`, cmap pruning, and locale filtering reduce APK size.
- **Reader immersion player** — Replaced the estimated completion timer with real audio playback (`AudioContext`) when the neural voice is installed; Android pause/resume now resumes from the engine's actual word position.

## [1.3.0] - 2026-08-30

### Added

- **Theorem Lens (In-Place Footnote & Citation Peek Portals)** — Tapping footnotes,
  citations, `<aside>` blocks, and bibliographic references now displays a dynamic,
  anchored popover balloon right above or below the link. Allows reading notes,
  inspecting formulas, and copying text without losing reading position or jumping
  to the back of the book.
- **Companion Audiobook & Immersion Integration Plan** — Added full architectural
  specification and GitHub issue template for attaching DRM-free `.m4b`/`.mp3` audio tracks
  to books with native variable-speed playback, sleep timers, and Iroh P2P sync.
- **Comprehensive Project Documentation & Strategy** — Added `docs/discover.md`,
  `docs/COMPETITIVE_STRATEGY_BLUEPRINT.md`, and synchronized all feature guides with
  the latest codebase implementation.

### Fixed & Performance

- **PDF Navigation Synchronization & Smooth Scroll** — Resolved previous-page
  navigation stalls in continuous scroll mode by deferring DOM scrolling until target
  page wrappers are mounted, and pre-loading adjacent pages (`page - 1`, `page + 1`)
  in single-page mode for instantaneous (0ms) page transitions.
- **PDF Single-Page Auto-Fit & Centering** — Switched to `m-auto` layout on page wrappers
  to prevent CSS flex clipping and automatically applied `page-fit` zoom when switching
  to single-page presentation mode.
- **PDF Engine Memory Reclamation & Disposal** — Ensured `loadingTask.destroy()` is
  invoked on document unmount, deallocated canvas pixel buffers (`width = 0; height = 0;`),
  cleared text layers, and triggered `sqliteShrinkMemory()` on reader close.
- **PDF Presentation Mode Persistence** — Added `presentationMode` (`scroll` vs `paged`)
  to `PdfViewState` in SQLite and Zod sync schemas, persisting per-book display settings.
- **Universal Route Error Boundary Layout** — Standardized error handling layout and
  typography across all app views.

## [1.2.1] - 2026-08-29

### Added

- **Discover Editorial Storefront & 75,000+ Global Catalog Search (#59)** —
  Browse and download books directly into your Theorem library with 1-click import.
  Features curated editorial sections (Timeless Essentials, Restored Editions via
  Standard Ebooks, Philosophy & Thought, Classic Fiction), live debounced global
  search across 75,000+ public domain classics, `@tanstack/react-virtual` DOM
  virtualization, and support for custom self-hosted OPDS 1.2 feeds (Calibre, Kavita,
  Komga).
- **Theorem Clothbound Cover Engine** — Deterministic typography and 7 refined
  clothbound bookcloth color palettes (`crimson`, `obsidian`, `navy`, `forest`,
  `ochre`, `slate`, `plum`) with double hairline rules for books missing bundled
  artwork.
- **In-Place Footnote & Citation Popovers** — Tapping footnotes, citations, and
  noteref links now reveals a non-disruptive, elegant popover overlay with rendered
  HTML, copy action, and an optional jump button, without losing your reading location.
- **Native Brand Splash Screen** — Instant 0ms first-frame splash screen featuring
  the Theorem Q.E.D. emblem directly rendered by the webview on boot, seamlessly
  fading out once storage hydration completes.

### Fixed & Performance

- **Adaptive SQLite Memory & Pool Optimization (#58)** — Configured platform-aware
  database pools and memory limits (2 connections and 32MB mmap on Android; 4 connections
  and 256MB mmap on Desktop) along with an automatic background `visibilitychange`
  listener executing `PRAGMA shrink_memory;` when Theorem is minimized or tabbed away.
- **Mobile Navigation & Hardware Back Button** — Resolved Android back button
  history stack desynchronization by removing synthetic sentinels, implementing
  clean LIFO state preservation in `src/App.tsx`, and adding automatic back-button
  dismissal to all modals and dialogs.
- **Reader Titlebar Status & Progress** — Placed a dedicated reading progress and
  chapter indicator centered in desktop titlebars, and ensured page/chapter status
  is always clearly visible on mobile screens.
- **PDF.js GPU Memory Deallocation** — Reset canvas dimensions (`width = 1, height = 1`)
  and released `ImageBitmap` references on page unmount to eliminate GPU backing store
  retention during rapid scrolling.
- **Mobile Performance & IPC Optimization** — Completely eliminated mobile lag and
  UI stutter on Android by configuring `tauri_plugin_log` to use `Stdout` only,
  preventing hundreds of background IPC log events from flooding the Android JNI
  bridge and starving the JavaScript thread.
- **Reader Re-render Elimination** — Memoized reader history callbacks and decoupled
  render hooks in `ReaderViewport` to prevent infinite re-render loops on page turns.

## [1.2.0] - 2026-08-29

### Added

- **Library "Unshelved" filter** — Added an "Unshelved" quick filter option to
  both desktop and mobile library filter menus to easily find books that are not
  assigned to any shelf or collection.
- **Google Play Books-style jump navigation** — Following links, citations,
  footnotes, TOC chapters, or bookmarks now features location undo/redo controls
  (`<Undo2 />` / `<Redo2 />`) directly in the top titlebar when controls are
  revealed, along with `Alt+Left` / `Alt+Right` keyboard shortcuts. The reading
  viewport remains 100% clean and distraction-free with zero floating badges.

### Fixed

- **Centralized back navigation & mobile gestures** — Fixed the Android hardware
  and gesture back button navigation via a centralized LIFO handler stack.
  Back actions cleanly dismiss open modals and overlays, step back through
  reading jumps, and exit back to the library or OS at the root.
- **Reader Titlebar Back Button** — Clicking the top-left back button in the
  reader titlebar now directly flushes progress and returns to the Library
  instead of stepping backward through previous page turns.
- **Desktop blank page on TOC / menu navigation** — Fixed an issue in the Foliate
  paginator runtime where navigating to a chapter from the Table of Contents or
  menu on desktop landed on a blank padding page (page 0), requiring a manual page
  turn before text rendered. Paged navigation now anchors directly to content
  page $\ge 1$.
- **Shelves responsive grid alignment** — Synchronized Shelves and Shelf Detail
  column calculations and CSS responsive grid breakpoints with the Library page
  (`2xl:grid-cols-8`, `xl:grid-cols-7`, `lg:grid-cols-5`, `md:grid-cols-4`,
  `sm:grid-cols-3`, `grid-cols-2`), unifying view mode preferences and fixing
  grid collapsing to 2 columns on search.
- **Startup diagnostics & logging** — Added explicit startup lifecycle
  breadcrumbs and structured file logging targets to aid troubleshooting early exits.
- **Yearly Book Goal undercounted** — The yearly goal showed far fewer books
  than were actually completed because the counter was only incremented on the
  reader's auto-completion path; books marked "Finish" manually (library
  context menu, batch bar, shelves) or completed earlier/synced-in were never
  counted. The yearly count is now derived from the library itself (books with
  a `completedAt` in the current year), so it is always accurate and can't
  drift. Applied to the Statistics "Yearly Book Goal" bar, the page subtext,
  and the Share Stats card.
- **Metadata edits did not sync** — After editing a book's info, the changes
  did not propagate to devices that already had the book. The peer merge kept
  its own (old) values for description, publisher, language, ISBN, published
  date, and category (`match.X || inc.X`), and title/author only adopted
  longer values. The merge now adopts the incoming metadata, so edits made
  after an initial sync reach other devices.
- **Cover edits did not sync** — Changing or removing a cover showed only on
  the editing device. `data:` cover paths were stripped from the sync payload
  (and `coverBlobHash` was never used to transfer the bytes), so peers kept
  the old cover. Covers (already downsampled to ≤200×300 webp) are now
  serialized into the book payload, and the merge adopts an incoming `data:`
  cover, so cover changes propagate.

### Changed

- **Settings "Current Progress" removed** — The Yearly Book Goal progress bar
  in Settings duplicated the Statistics page, so it was removed to avoid
  confusion.
- **Settings storage now shows only downloaded books** — The Books row in
  Data & Storage previously summed `fileSize` over the whole synced library
  (including books synced from another device whose files aren't stored
  locally) and showed the total book count. It now shows only the books
  actually downloaded to the device and their on-disk size, with a note for
  any sync-only books that aren't downloaded yet. The Library page continues
  to show the total library count.
- **Statistics "Books Completed" no longer shows a fake target** — The bar
  previously implied a goal by rendering `26 / 31` where the `/31` was just
  "completed + 5", not a real goal. It now renders as a plain count.

## [1.1.0] - 2026-08-18

### Added

- **Book export** — Right-click a book (or select several and use the batch
  Export action) to copy the original file out of the app:
  - Desktop: native save dialog via `@tauri-apps/plugin-dialog` + `writeFile`.
  - Android: a new `save_file_mobile` command writes to the system Downloads
    folder (``Download/Theorem``) through the mobile-folder-scan plugin's
    MediaStore `saveFile` method.
  - Browser/web: `<a download>` fallback when Tauri is unavailable.
  - Books synced from another device are fetched on demand from a paired peer
    first, with a clear message when none is available.
  - Results surface as a toast notification (`sonner`) instead of an alert.
- **Edit Book Info** — A full metadata editor that replaces the old
  title-only rename. Access it from the book's context menu ("Edit Info") or
  the new Edit button in Book Info. Editable fields: title, author,
  description, publisher, published date, language, ISBN, category, tags, and
  rating.
- **Cover editing** — Change or remove a book's cover from the same Edit modal
  via device image picker or a fetch-from-URL field, with an instant preview.
  Changes are written into EPUB files as well as the library (see below).
- **EPUB metadata/cover write-back** — New `rewrite_epub_metadata` Rust
  command updates the OPF `<metadata>` dc: fields and replaces or embeds the
  cover image (manifest + cover meta updated) directly in the stored `.book`
  file. Encrypted EPUBs are rejected; the browser gets a best-effort fflate
  fallback (`epub-write-browser.ts`) that keeps the `mimetype` entry stored
  uncompressed. Edits are saved in-app even when file write-back fails (e.g.
  a synced book not yet downloaded).
- **Back to previous reading location** — Clicking a citation or footnote and
  the mobile back gesture/hardware back now returns you to the page you were
  on before following the link:
  - Browser back gesture and Android hardware back step through foliate's
    built-in location history (panels/color picker are closed first).
  - Desktop shortcut `Alt+Left` / `Alt+Right` (previous/next location).
  - EPUB only; PDF has no location history and is unaffected.
- **Workbench remembers your last card** — The card view (and the active
  filter, sort, and list/cards toggle) is remembered per session in
  `sessionStorage` (`theorem-workbench:view-state`). Navigate away and back
  and you land on the exact card you were reading, resolved by annotation id
  so resorting or filtering doesn't lose your place.

### Fixed

- **Edit Book Info modal could not scroll** — The modal's `<form>` wrapper
  broke the flex layout, so the body never shrank and the footer (Save
  button) was clipped below the 90vh viewport limit on smaller screens. The
  form is now a flex column so `ModalBody` scrolls and Save stays visible.
- **Rust unit tests for EPUB parsing** — Two `epub_parser` fixtures used a
  truncated `<package xmlns="http:...">` namespace URI (introduced by an
  overly aggressive comment-strip pass), which made `test_locate_toc_sources`
  and `test_read_epub_metadata_full` fail. The fixture tag was repaired; the
  full Rust test suite is green again.

## [1.0.10] - 2026-08-07

### Added

- **Success icon for sync notifications** — A green-check notification icon is
  bundled as a Tauri resource and shown for "Sync Complete" OS notifications.
  Sync errors still use the default app icon, so a completed sync no longer
  looks like an alert.

### Fixed

- **Shelves page could not scroll to the last book** — The shelf detail grid
  used a hardcoded `calc(100vh - 12rem)` height plus `content-visibility: auto`
  inside a non-flex ancestor, so `flex-1 min-h-0` was inert and the final
  virtualized rows were unreachable. Replaced it with the Library page's flex
  height chain (`h-full flex flex-col` → `flex min-h-0 flex-1 flex-col`) and
  dropped the `content-visibility` class from the scroll container.
- **Reading time undercounted (≈half)** — Every visibility hide flushed with
  `Math.floor()` and discarded the sub-minute remainder, then the start clock
  reset on show, so a ~30 minute session could record ~15. The tracker now
  accumulates milliseconds and carries the remainder across hide/show/pause/
  resume/unmount; the unmount flush also writes to `stats` (total, daily
  activity, streak) instead of only the per-book time. Stats are read fresh
  from the store during flushes to avoid stale lost updates.
- **Weekly digest showed 60× too much time** — The Statistics "This Week" card
  rendered `formatReadingTime(weekMinutes * 60)`, turning minutes into hours.
- **Excessive sync notifications** — `docs-sync-finished` fires on every iroh
  round, so every auto-sync (2-min interval, startup, tab refocus, peer
  online, mutation flush, doc re-import) posted an OS notification. Sync
  notifications are now sent only for manually triggered syncs (Quick Sync in
  the titlebar, Sync Now in Settings). Auto-sync feedback stays in the
  in-app status pill.
- **Sync lifecycle hardening** — `docs_api` is cleared on engine stop and
  accept-loop exit, and a generation counter guards liveness checks so callers
  fail fast against a stale snapshot instead of blocking on a dead engine
  (`0535dc2`, `75be052`).
- **Sync engine startup races** — The accept loop now initializes the docs
  engine even with zero paired devices (fixing first-time pairing timeouts);
  old accept-loop shutdown is awaited before a fresh loop spawns; pairing
  spawn paths are serialized under a lock and endpoint TOCTOU removed; and
  snapshot polling uses `tokio::time::sleep` instead of blocking a worker
  thread (`6f1be37`, `cebcf6c`, `5ab1fc1`, `abc04dd`).
- **Sync 100MB wipe + deadlocks** — The docs size-cap wipe now stops and
  awaits the engine before deleting files; recovery paths release
  `paired_devices` before awaiting `docs_api` (lock-order inversion); and the
  pairing readiness poll requires the snapshot generation to match the current
  accept loop (`e22befc`, `574d4b4`).
- **Sync lost data on provision skip** — Manual "Sync Now" with auto-sync
  disabled skipped provisioning entirely (the gate relied on `_dataDirty`,
  which is never set when auto-sync is off), silently never pushing local
  changes. The gate now skips only for structural reasons; a per-key cache
  still avoids rewriting unchanged data (`a1bf94f`).
- **Sync write errors swallowed** — `docs_set_entry` returned success even
  when every per-doc write failed, silently dropping user data. It now returns
  the first failure and logs each one so the frontend can retry (`48d6899`).

### Changed

- **Sync provisioning trimmed** — Rounds now provision only books/domains
  whose serialized value actually changed (or after a forced re-provision),
  instead of rewriting the whole library (~1008 IPC writes per round for a
  1000-book library). Content polling in `docs_get_all_entries` no longer
  waits up to 400ms per missing blob (`cfd1364`, `b2a1088`).

## [1.0.9] - 2026-07-25

### Added

- **Reading Goal Notifications** — Three-tier notification system:
  - Real-time goal-met detection: OS notification + in-app toast when you hit your daily reading goal
  - Session-end reminder: notifies when you close a reading session short of your goal
  - Scheduled daily reminder: periodic Rust-side check at your configured reminder time
- **Sync Completion Notifications** — OS notification on sync finish or error (toggleable in Settings)
- **Notification Settings UI** — Goal Notifications toggle, Daily Reminder Time picker, Sync Notifications toggle
- **Rust command `sqlite_check_goal_reminder`** — Reads today's reading stats from SQLite for the reminder timer
- **Proactive notification permission request** — Calls `requestNotificationPermission()` on app startup so the OS prompt appears immediately instead of waiting for the first lazy notification call
- **QR scan cancel toast** — Shows a sonner toast when the native QR scanner is dismissed, instead of silently swallowing the cancel

### Fixed

- **Reader scroll mode blank screen on switch** — When switching from paged to scroll mode, the `overflow: hidden` from `columnize()` persisted on the iframe `<html>` element, clipping content to the viewport. `scrolled()` now sets `overflow: visible`. Additionally, the `transform: translateX/Y()` that `#setViewPosition()` applied during paginated mode was never cleared — the view element stayed positioned off-screen. `Paginator.render()` now resets the transform when entering scroll mode.
- **Notifications never triggered** — `notifyIfGranted()` callers existed in `useReadingTime.ts`, `useDailyGoalReminder.ts`, and `sync-orchestrator.ts`, but `requestNotificationPermission()` was never called, so the OS permission prompt never appeared on Android 13+ or desktop.

### Changed

- **`annotations.find()` → O(1) Map lookups** — Reader hot paths (highlight tap, note save, bookmark toggle) now use `useMemo`'d `Map<string, Annotation>` lookups instead of linear array scans. The foliate engine also gained a `annotationLocations` Map for O(1) highlight-click detection.
- **Onboarding flow text updated** — Steps 3-5 now mention TTS immersion reading, speed-reading, reading status filter, P2P LAN sync alongside markdown export. `docs/onboarding.md` rewritten to match the actual component.

## [1.0.8] - 2026-07-20

### Added

- **Tauri plugins (5)** — Logging (structured file+webview), native OS notifications,
  window state persistence, global shortcuts (Ctrl+Shift+F → Library,
  Ctrl+Shift+R → Feeds), in-app updater.
- **Check for Updates** — Settings → About tab has a "Check for Updates" button
  that queries GitHub releases. Shows version info, installs & prompts restart.
- **Issue templates** — Bug report and feature request forms at
  `.github/ISSUE_TEMPLATE/`.
- **Signing keys guide** — `docs/SIGNING-KEYS.md` documents Tauri Updater (Ed25519)
  and Android APK (JKS) key setup, GitHub Secrets integration, and release workflow.

### Fixed

- **Vocabulary sync broken by Zod enum** — `VocabularyTermSchema.providerHistory`
  only allowed `"stardict"`, but terms created via the free dictionary API had
  `"free-dictionary-api"`. Sync validation silently rejected the entire vocabulary
  domain when any term had the missing enum value. Added
  `"free-dictionary-api"` to the enum.
- **Repo URLs outdated** — All `sapienskid/theorem` and `sapienskid/wiktionary-stardict`
  references updated to `fundaments-work/Theorem` and
  `fundaments-work/wiktionary-stardict` across all source files.
- **Tests outdated** — Two release tests fixed: spinner CSS moved from inline
  HTML to `src/index.css`, and settle threshold changed from `>= 3` to `>= 2`.

### Changed

- **CI auto-publishes updater artifacts** — `release.yml` now passes
  `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to all
  `tauri-action` steps. `createUpdaterArtifacts: true` enables automatic
  `latest.json` generation.

## [1.0.7] - 2026-07-19

### Fixed

- **Production Tauri: book shows "1-2 lines and white"** — Two interrelated fixes:

  **1. Invalid iframe sandbox flag** — The reader iframe had `allow-clipboard-write` in the `sandbox` attribute, which is not a valid sandbox token (it's a Permissions-Policy directive). WebKitGTK (Tauri's production WebView on Linux) rejects the entire sandbox attribute when it encounters an invalid flag, dropping the iframe into maximum sandboxing. This broke foliate-js page-positioning logic that relies on `allow-same-origin` to read iframe content dimensions and set up CSS columns. Reverted to `allow-same-origin allow-scripts`.

  **2. CSP `'unsafe-inline'` ignored due to Tauri style nonce injection** — An inline `<style>` tag in `index.html` (loading spinner, added in v1.0.7) triggered Tauri's CSP processing pipeline: the build system injects `__TAURI_STYLE_NONCE__` into `<style>` elements, and at runtime replaces it with a real nonce + adds `'nonce-xxx'` to `style-src`. Per CSP spec, when a nonce source is present in a directive, `'unsafe-inline'` is ignored — so all dynamic inline styles (including foliate-js's `<style>` elements inside the reader iframe that set column-width, height, padding) were blocked. The loading spinner CSS is now in `src/index.css` (loaded via `<link>` from `'self'`), eliminating the inline `<style>` element and keeping `'unsafe-inline'` intact.

  **3. Tauri IPC blocked by CSP** — The CSP `connect-src` was missing `ipc:` and `http://ipc.localhost`, causing Tauri's custom IPC protocol to fail and fall back to postMessage. Added `ipc: http://ipc.localhost` to `connect-src`.

- **Production builds must not ship with devtools** — Removed `devtools` feature flag from `tauri` dependency in `Cargo.toml`.

### Added

- **On-demand download progress** — Reader shows a real progress bar with file size (e.g., `12.5 MB / 45.3 MB (28%)`) instead of an indeterminate spinner when downloading synced books. Progress events emitted from Rust in 1MB chunks, throttled to percentage changes.
- **Memorized reader state** — Reader now persists `downloadingBookId` and `downloadProgress` across renders. "Try Again" button on all error screens.

### Changed

- **File transfer: streaming writes with no IPC** — `download_book_file` writes received data directly to `book-cache/{id}.book` from Rust in 1MB chunks. Zero bytes pass through the Tauri IPC bridge. Previously, the entire file was returned via IPC as JSON `number[]`, causing 360MB+ allocations that crashed Android with OOM (heap limit 256MB).
- **File transfer: 120s timeouts** — All I/O operations (connect, open_bi, read_line, read_exact) now have 120s timeouts. Previously, `request_book_file` could hang indefinitely on unreachable peers.
- **File transfer: SQLite fallback** — `FileTransferHandler` falls back to reading from SQLite `books` table when the file is not in `book-cache`. Previously only served from `book-cache`, meaning locally-imported books (stored in SQLite) were unavailable to peers.
- **Sync: gossip-based bidirectional auto-sync** — `NeighborUp` events now properly trigger `runDeviceSync` on the peer via `docs-peer-online`. The `iroh_node_id` field was missing from `PairedDeviceInfo`, making the peer-matching `d.irohNodeId === nodeId` always fail. Auto-sync when a peer comes online was completely dead.
- **Sync: settle threshold fixed** — `signalSettle()` checks `>= 2` instead of `>= 3`. Only 2 events (`docs-pending-content-ready` + `docs-sync-finished`) ever call signalSettle, so the threshold of 3 was never reached — every sync round waited the full 30s timeout.
- **Sync: event subscription on doc recovery** — `subscribe_doc_events` is now called after re-importing a sync doc from ticket in `docs_sync_now`. Previously, doc subscriptions were lost during recovery, causing no live events to flow.
- **Sync: `_bridgePaused` guard for all stores** — Vocabulary, RSS, and settings store subscriptions now check `_bridgePaused` during provisioning, preventing writes during initial data sync.
- **Reader: shortcuts useEffect moved before early returns** — The keyboard shortcuts registration useEffect is now called before all early-return guards (downloading, error, syncedWithoutFile). Previously, the shortcuts useEffect was duplicated — one copy before and one after the early returns — causing "Rendered more hooks than during the previous render" errors when transitioning from the download screen to the reader.
- **Reader: polling loop timeout** — The `while (syncedWithoutFile)` polling loop now has a 120-second timeout. Previously it hung forever if the download failed.
- **Annotations page: fully responsive card view** — Touch swipe navigation, icon-based mobile toolbars, clipped dot indicators, `touch-manipulation` on all interactive elements.

### Performance

- **Memory: eliminate unnecessary Blob copy** — When the MIME type already matches, use the blob directly instead of `new Blob([blob], type)`, which duplicated the entire book in JS memory. Saves one full copy (50-100MB for large EPUBs).
- **Memory: call EPUB.destroy() on engine teardown** — `FoliateEngine.destroy()` now calls `EPUB.destroy()`, which revokes all blob URLs created for sections, CSS, images, and fonts. Previously, blob URLs accumulated until page refresh.
- **Memory: unload previous fixed-layout spreads** — `goToSpread()` now calls `unload()` on the previous spread's sections. Fixed-layout books (children's books, comics) were leaking all visited spreads' blob URLs.
- **Memory: cover extraction early-return before file re-read** — The `hasRealCover && coverExtractionDone` check now runs BEFORE `getBookData()`, avoiding a full re-read of the book from storage when cover is already extracted.
- **Memory: metadata-only EPUB prefetch** — Rust `prefetch_zip_metadata` no longer pre-decodes all EPUB section HTML files (up to 100 sections, ~3-6MB of JS strings). Only metadata files (container.xml, OPF, NAV, NCX, encryption) are prefetched. Sections load lazily via zip.js.
- **Binary size: removed unused Rust dependencies** — `read_zip_entry` wrapper removed after section prefetch elimination.

### Fixed (Android)

- **ndk_context restore** — Re-added JNI `initNdkContext` and `ndk-context` dependency. iroh's `netwatch` → `netdev` → `ndk_context::android_context()` panics if the Android JVM/context are not initialized before any iroh networking operations run. Without this, the app crashed on Android 15 at startup.
- **ndk_context init after super.onCreate** — `initNdkContext(applicationContext)` moved after `super.onCreate()` to ensure `applicationContext` is non-null when the JNI call fires.
- **CBR/RAR desktop-only** — `unrar-ng` (bundled UnRAR C++ source) uses `lutimes()` which was removed from Android's bionic libc in NDK 28. CBR conversion works on desktop; Android returns a clear "not supported" error to avoid compilation failure.
- **accept loop gate** — When no paired devices exist, the accept loop registers only pairing + file_transfer handlers, skipping gossip/docs creation. This prevents the `ndk_context::android_context()` panic on fresh Android installs with no paired devices.
- **Top-bar single-device sync** — Sync button now syncs only the first paired device instead of iterating all, preventing sequential timeouts on offline peers.
- **Mobile safe-area padding** — All pages (Settings, Statistics, Bookmarks, Annotations, Feeds, Vocabulary, Shelves) now use `pb-[calc(var(--spacing-2xl)+env(safe-area-inset-bottom))]` to clear the bottom navigation on notched devices.

### Fixed (Sync)

- **Duplicate pairing by iroh_node_id** — The dedup check only matched by `fingerprint`, which is empty on Android (and often empty on desktop). Added `iroh_node_id`-based dedup in both `handle_pair_req` and `submit_pairing_code`.
- **Frontend duplicate device list** — `DeviceSync.tsx` filtered by `deviceId` before appending, preventing duplicate entries in the local React state.

### Fixed (General)

- **Stuck "Downloading Book" screen** — Added 120s timeout, clears `downloadingBookId` on timeout, shows "Book download timed out" error with retry.
- **Broken reader state after download failure** — New guard renders "Book File Not Available" screen when `syncedWithoutFile` is true but not currently downloading, instead of showing a broken reader view.
- **"Rendered more hooks than during the previous render"** — Removed duplicate shortcuts useEffect that was left after the move. When transitioning from "Downloading" screen (early return fired, 1 shortcuts hook) to reader (no early return, 2 shortcuts hooks), React detected the mismatch and threw.

## [1.0.6] - 2026-07-06

### Added

- **Keyboard shortcuts** (global + reader-scoped) — `Ctrl+1`–`7` navigate between pages, `Ctrl+,` for Settings, `Ctrl+F` for search, `Ctrl+B` for sidebar toggle, `?` for shortcuts help. Reader shortcuts: `Ctrl+D` bookmark, `Ctrl+T` TOC, `Ctrl+S` settings, `Ctrl+A` annotations, `F11` fullscreen. Shortcuts reference available in Settings → Shortcuts tab.
- **Auto-advance immersion reading** — When TTS finishes reading a page in immersion mode, it automatically turns to the next page and starts speaking. Chains continuously until the book ends or the user stops playback.
- **Bookmarks page redesign** — Bookmarks now match the AnnotationCard design language with proper borders, MoreVertical dropdown menu, and serif blockquote styling.
- **PDF paged navigation mode** — Scroll-snap based paged mode for PDFs (engine support maintained, UI toggle deferred).

### Changed

- **TTS: removed Kokoro/ONNX neural engine** (~52 MB binary saved) — Replaced with native OS speech: `android.speech.tts.TextToSpeech` on Android, `say`/NSSpeechSynthesizer on macOS, `spd-say`/`espeak-ng` on Linux, PowerShell/SAPI on Windows. Zero Rust dependencies, zero model download. Audio now starts instantly — no model warmup delay.
- **TTS: real pause/resume** — Pause now stops at the estimated word position (158 wpm audiobook rate, self-calibrating). Resume continues from where speech was paused, not the beginning of the section.
- **TTS: disabled on web** — Web Speech API support was janky. TTS is now Tauri-only (Android + desktop). Settings show "Not available in web browser" on web.
- **Sync: event-driven, not timer-based** — Sync now uses dirty-tracking across all three layers (JS orchestrator, Rust background loop, sync daemon). Mutation-triggered sync fires within seconds; periodic syncs become no-ops when nothing changed. The Rust 5-minute loop checks a data version counter and only initiates sync when data actually changed.
- **Sync: autoSyncEnabled toggle respected** — The Rust background sync loop now stops when auto-sync is turned off. Previously it ran regardless of the toggle setting.
- **Sync: Android WorkManager data loss fixed** — The JNI standalone sync round (WorkManager) now persists incoming peer data to `sync-incoming-cache.json` before its ephemeral runtime exits. On next app boot, `get_incoming_sync_data` loads and merges this cache.
- **Bookmarks page** redesigned to match AnnotationCard design language.

### Fixed

- **RSS duplicate subscriptions** — `useRssStore.addFeed` and `refreshFeed` now normalize feed and article URLs (lowercase + trailing-slash strip) before comparison.
- **RSS remove feed UX** — Replaced dropdown action menu with direct hover-triggered trash button.
- **RSS duplicate images** — Article card summaries now hide inline `<img>` and `<figure>` elements to prevent duplicate image display.
- **Shelf search and context menus** — ShelfDetail uses shared `MemoizedBookCard`, `BookInfoModal`, and context menu. Bulk "Add to Shelf" fixed.
- **Android TTS crash** — `TextToSpeech` constructor must run on UI thread. All TTS operations now go through `Handler(Looper.getMainLooper()).post()`.
- **TTS reads wrong page** — `getVisibleTextForTts()` was returning entire section text instead of visible portion. Fixed to use `visibleRange.cloneContents()`.
- **Settings page re-render** — Extracted `StorageTab` as memo component, removed heavy subscriptions from parent.
- **Reader remount on navigation** — Removed `key={currentRoute}` from `RouteErrorBoundary` that forced full remount on every route change.

### Performance

- **Binary size: ~83 MB → ~28 MB** — Removed Kokoro/ONNX TTS stack (52 MB). Added `panic = "abort"`, `strip = "symbols"`. Removed 12 TTS crates, 3 Rust source files.
- **Event-driven sync** — All three sync layers use dirty-tracking. No more wasted manifest builds + SHA-256 hashing + HTTP round-trips when data unchanged. Mutation-triggered sync debounces to 5 seconds.
- **Virtual scrolling** (all list pages) — Library, Shelves, Annotations, Bookmarks, Vocabulary now use `@tanstack/react-virtual` with padding-based approach. DOM node count reduced by 85-98% for large collections. Overscan: 3 rows.
- **Background cover hydration** — `coversHydrated=true` set immediately on rehydrate. Covers hydrate incrementally in batches of 48, unblocking the UI.
- **WebP cover downsampling** — Covers resized to 200px, saved as WebP (quality 0.75), decoded asynchronously.
- **LRU-capped caches** — coverCache=100, thumbnailCache=200, materializedPathCache=500, blobCache=3. Persist storage skips values >500KB.
- **PDF zoom rescaling** — ImageBitmap cache for GPU-scaled instant zoom feedback. DOM window = canvas window + 4 pages. Search capped at 500 pages.
- **Barrel import elimination** — All imports now use direct module paths instead of `src/core/index.ts`, enabling tree-shaking.
- **Zustand selector anti-patterns** — Individual selectors instead of destructuring in ContextMenu, ReaderBookmarks, and other hot-path components.
- **Shared context menu portal** — Single global `ContextMenuRoot` replaces per-card portals.
- **Fuse index caching** — `WeakMap<Book[], Fuse>` caches search index. Debounced search (250ms).
- **Navigation fix** — Removed `key={currentRoute}` from RouteErrorBoundary (prevented full remount on route change).
- **DailyActivity pruning** — Capped to 365 days on rehydrate (was unbounded).
- **DeletionTombstone GC** — Garbage-collected on store rehydrate (was only during sync).

## [1.0.5] - 2026-07-03

### Added

- **RSS feed Markdown rendering** — Articles that include Markdown-formatted content (headings, bold, italic, links, lists, code blocks, etc.) are now converted to styled HTML at render time using `markdown-it` (v14). Both the article reader view and the feed card abstract render Markdown properly. Conversion also runs during initial feed import and article extraction for forward storage.
- **RSS article deletion** — Articles can now be deleted individually from the feed list. Deletions propagate as sync tombstones so the removal syncs to paired devices.
- **RSS article right-click context menu** — Feed article cards now have a context menu with: Read Article, Open Original, Copy Link, Mark Read/Unread, and Delete Article. The inline delete button has been removed in favor of the context menu.
- **Library multi-select** — A new "Select" button in the library toolbar toggles batch selection mode with checkboxes on every book card. Once selected, a bottom action bar appears with bulk operations: Mark Read, Mark Unread, Add to Shelf, and Delete. BookCard click behavior switches to toggle selection when in select mode.

### Changed

- **Feed card summary rendering** — Article abstracts on the feed page now render as rich HTML (links, bold, italic) instead of stripped plain text, giving a proper content preview.

### Fixed

- **Sync manifest rejected by peer (403 Forbidden) after pairing** — The sync-daemon grabbed the fixed port (43935) before the Tauri app, forcing it to a random fallback port. The daemon only loaded `paired_devices` at startup and never refreshed them, so devices paired by the Tauri app were unknown to the daemon's server. Two fixes:
  - `decrypt_request` now reloads `sync-paired-devices.json` from disk when a device lookup misses in the in-memory HashMap, so both the daemon and Tauri app servers pick up newly paired devices immediately.
  - The sync-daemon's auto-sync loop reloads paired devices from disk before each round (every 120s), ensuring periodic refresh even without an incoming request trigger.
- **Paired scanner IP not recorded** — `handle_pair` previously saved `last_ip: ""` and `last_port: 0` for the scanner, preventing the host from initiating sync back to the scanner. Now captures the client's real IP via `axum::ConnectInfo` so the host can reach the scanner without waiting for the scanner to initiate first.
- **Install script** — `curl | bash` install now handles `BASH_SOURCE` being unbound when piped via stdin.

## [1.0.4] - 2026-07-03

### Added

- **Sync-daemon bundled as Tauri sidecar** — The `sync-daemon` binary is now built and bundled inside deb/rpm/AppImage packages. On startup, the app launches it as a child process for 24/7 background sync.
- **One-command Linux install** — `curl -fsSL https://raw.githubusercontent.com/fundaments-work/Theorem/main/scripts/install-linux.sh | bash` auto-detects the distro, downloads the latest release, installs the app, **extracts the sync-daemon**, and creates a **systemd user service** (`theorem-daemon.service`) for persistent background sync.
- **Systemd user service** — `theorem-daemon.service` runs the sync-daemon as a user service, auto-starts on login, and survives app restart/quit/reboot. Enable manually: `systemctl --user enable --now theorem-daemon`.
- **Android notification permission request** — On Android 13+, `POST_NOTIFICATIONS` is now properly requested before the foreground service starts. The system dialog appears when enabling sync, making the persistent notification visible.
- **Android ProGuard/R8 keep rules** — `proguard-rules.pro` now keeps all `work.fundamentals.theorem.syncworker.*` classes so R8 doesn't strip reflectively-called plugin methods in release builds.

### Changed

- **Build scripts** — `makepackage-linux.sh` builds the sync-daemon before `pnpm tauri build` so it's included in the bundle. `release.yml` CI does the same.
- **Install script overhaul** — `install-linux.sh` now downloads from GitHub, detects the distro (deb/rpm/AppImage), installs the app + daemon + systemd service in one command.

### Fixed

- **Android foreground notification not showing** — `SyncWorkerPlugin.startWorker()` now calls `requestPermissionForAliases("notifications")` on Android 13+ before starting the service. Previously it only checked and logged.
- **Android R8 stripping** — `consumerProguardFiles` now points to the existing `proguard-rules.pro` instead of the missing `consumer-rules.pro`. Includes `-keep class work.fundamentals.theorem.syncworker.** { *; }`.

## [1.0.3] - 2026-07-02

### Added

- **Android background sync daemon** — `sync-daemon` sidecar binary with embedded HTTP server for LAN sync. Runs as a foreground service (`connectedDevice` type) with persistent notification. WorkManager periodic sync every 15 minutes + battery optimization exemption. Survives task removal.
- **Android sync foreground service** — `SyncForegroundService.kt` manages the persistent notification and lifecycle. Auto-starts on app launch. Updates notification with sync status messages.
- **Android device identity** — Stable per-device ID generated on first launch, stored in app preferences. Used for sync pairing and authentication.
- **Sync daemon status in settings** — UI shows daemon running/stopped status, last sync time. Control API via HTTP on loopback.
- **Back arrow in article reader** — Dedicated floating back arrow below the mobile status bar with `safe-area-inset-top` support. Prevents stale article state from hijacking book opens.
- **RSS feed deletion sync** — Tombstone propagation ensures deleted feeds are removed on paired devices.
- **Colored sync status indicator** — Replaced rotating `animate-spin` icon with status dot: idle (grey), syncing (amber+pulse), synced (green), error (red). Last synced label moved to left of icon.
- **Page-turn animation on all navigations** — `#setViewPosition` now always animates in paginated mode (not just same-chapter turns). Touch drag stays instant via `animate=false`.

### Changed

- **TTS: native audio on desktop** — Completely removed Web Audio API for TTS playback. Desktop now uses `rodio` (Rust audio library) for gapless native audio output. Android uses raw `AudioTrack` via a custom Tauri plugin. Bypasses WebView audio entirely.
- **TTS: native audio on Android** — New `tauri-plugin-android-tts-audio` plugin writes PCM audio directly to Android `AudioTrack`. No more Web Audio API latency or autoplay restrictions.
- **TTS: increased chunk size** — First chunk 150 chars, subsequent chunks 500 chars (was 80/150). Reduces chunk boundaries by ~3-4×, eliminating audible fade-out dips between sentences.
- **TTS: removed Anti-Bite Detachment regex** — The phonemizer workaround is no longer needed; the `misaki-lean` bug fix appends a trailing `_` instead.
- **Sync/statistics buttons** — Now use `ui-icon-btn` class on desktop too, giving consistent visible `background: var(--color-surface)` with mobile.
- **Page-turn easing** — Changed from `cubic-bezier(0.22, 1, 0.36, 1)` (dual y=1.0 caused mid-turn plateau) to `cubic-bezier(0, 0, 0.58, 1)` (CSS ease-out, natural deceleration).
- **Reader toolbar** — Double-click on titlebar now toggles maximize/restore (standard desktop behavior).
- **Git ignore** — Explicit policy for generated Android project files, SDK files, build outputs.

### Fixed

- **TTS autoplay on word tap** — Removed the `.tts-word` click-to-play feature. Tapping any word no longer triggers `generate_speech` regardless of `ttsEnabled`.
- **TTS word doubling** — Removed `isContinuousMode` auto-play effect in ImmersionBar that raced with `handleTtsComplete`. Both called `generate_speech` for same text.
- **TTS continues after closing immersion bar** — `handleTtsComplete` now guards on `immersionMode`. Ref-based check prevents stale in-flight async calls.
- **TTS memory: audio buffers not freed on stop** — `desktop_audio::stop_audio()` changed from `player.stop()` (atomic flag, 1 chunk/5ms drain) to `player.clear()` (immediate queue drain + pause).
- **TTS memory: 3× IPC overhead per chunk** — Removed `audio_data` from `TtsChunk` IPC (48KB+ `Vec<f32>` serialized as JSON, never read by frontend). Added `duration_ms` on Rust side. Saves ~400KB per chunk.
- **TTS memory: stale closures in singleton** — `ImmersionPlayer.destroy()` now clears `this.callbacks`, preventing old React closures from being held indefinitely.
- **Immersion toggle causes page turn** — Removed `pb-16` padding transition on viewport container that resized the foliate paginator and triggered column recalculation.
- **3D page-flip animation broken CSS** — Restored missing closing brace on `#container` CSS rule (deleted when reverting the 3D flip). The unclosed rule merged `#container` with all subsequent selectors, causing broken layout that appeared as animation stutter.
- **Page-turn animation stutters mid-turn** — Settings sync (`applySettingsSync`) in `next()`/`prev()` called immediately after navigation, triggering renderer attribute changes (column count, flow) during the 0.3s CSS transition. Deferred via `setTimeout(350)` so it fires after the animation completes.
- **Broken column layout on multi-column desktop** — `next()`/`prev()` now call `applySettingsSync`/`Async` after navigation (deferred past transition) to ensure correct column count, inline-size, and flow mode.
- **Book stuck at "Loading..."** — Force new Blob reference in `loadBook` to trigger React re-render. Reset `loadedBookIdRef` on effect cleanup to prevent infinite loading.
- **TTS column layout misalignment** — Repeated layout sync and zoom application after navigation. Added chapter-boundary detection so re-renders only happen when needed.
- **Android: crash on Android 14** — `SystemForegroundService` missing `foregroundServiceType` in AndroidManifest. Crash when binding WorkManager notification.
- **Android: WorkManager JNI crash** — Fixed `Java_work_fundamentals_theorem_syncworker_SyncWorker_runBackgroundSync` native method naming.
- **Android: redundant companion object** — Merged duplicate `companion object` blocks in `SyncWorker.kt`.
- **Android: smart cast errors** — Fixed Kotlin smart cast on `networkCallback` in `NetworkCallback` registration/unregistration.
- **Android: WakeLock + notification permissions** — Added `WAKE_LOCK` and `POST_NOTIFICATIONS` permissions. Wrapped `acquireWakeLock` in try/catch.
- **Android: task removal kills sync** — Set `stopWithTask=false` and restart in `onTaskRemoved` to keep sync alive.
- **Android: notification importance** — Increased to `IMPORTANCE_LOW` for reliable display.
- **Sync: 503 race condition** — Prevents concurrent sync requests from causing HTTP 503 errors. Propagates RSS feed deletions as tombstones.
- **Sync: crashes on Android and desktop** — Eliminated multiple crash sources in sync orchestrator, crypto, and server.
- **RSS article reader back button** — Restored back navigation. Fixed stale article state hijacking book opens when switching between reader and feeds.
- **Rust compiler warnings** — All warnings eliminated for production builds.
- **3D page-flip shadow overlay** — Reverted `#flip-shadow` element, `perspective: 2000px` CSS, and Web Animations API 3-keyframe effect.

### Performance

- **Instant book opening** — Rust-native EPUB prefetch reads zip metadata in parallel with JS. Container.xml, OPF, nav, NCX, and ALL HTML section text are pre-decoded and cached. `loadText`/`getSize` calls skip `@zip.js/zip.js` entirely on the critical path. Book opening drops from ~1.5s to <50ms on desktop, <150ms on Android.
- **Eliminated barrel imports** — Every import now uses direct module paths instead of `src/core/index.ts`. Barrel re-exports prevented tree-shaking and bundled all stores/services together.
- **React.memo on heavy components** — Wrapped `BookCard`, `ReaderViewport`, `PDFJsEngine`, `Sidebar`, `BottomNav`, `AppTitlebar`.
- **Lazy-loaded heavy dependencies** — `soundtouchjs` (TTS), `pdfjs-dist`, `@mozilla/readability`, `fast-xml-parser`, `html-to-image` all use dynamic `import()`.
- **Zustand individual selectors** — All store consumers now use `useStore(s => s.x)` instead of destructuring `const { x } = useStore()`.
- **Layout reflow on same-section page turns** — Only triggers render when layout is genuinely broken (size === 0). Keybard navigation and page turns skip unnecessary columnization.

### Removed

- **Dead component** — Removed unused `ShareCard.tsx`.
- **Unused barrel files** — `article-reader/index.ts`, `components/index.ts`, `highlights/index.ts`, `progress/index.ts`.
- **Dead CSS classes** — `.epub-container`, `.epub-container iframe`, `.reader-screen`, `.theme-transition`, `.reader-container` from `index.css`.
- **Commented-out console.log** — 3 lines in `foliate-js-runtime/epub.js`.
- **Unused PDF.js vendor** — `foliate-js/vendor/pdfjs/` directory (~10.5MB, app uses `pdfjs-dist` npm package).
- **Vendored foliate-js** — Converted to git submodule pointing to `fundaments-work/foliate-js` fork.
  Fork stripped of `vendor/pdfjs/` (~10.5MB unused PDF.js build artifacts, app uses `pdfjs-dist` npm package).
  Nightly GitHub Action syncs upstream `johnfactotum/foliate-js` changes into the fork automatically.
  Clone with `git clone --recurse-submodules`.
- **TTS Anti-Bite Detachment regex** — Replaced by trailing `_` phonemizer workaround.

## [1.0.2] - 2026-07-01

### Added

- **Rust-native EPUB prefetch** — `prefetch_zip_metadata` Tauri command reads the epub zip in Rust (zip crate), returning pre-decoded text for container.xml, OPF, nav, NCX, encryption.xml, and ALL HTML/XHTML section files. Combined with the uncompressed-size map of every zip entry, JS loadText/getSize calls skip @zip.js/zip.js entirely on the critical path. Book opening drops from ~1.5s to <50ms on desktop and <150ms on Android.
- **CBZ/FBZ support** — Rust prefetch works for all zip-based formats (sizes map always returned; EPUB-specific paths gracefully degrade).
- **Smooth page-turn animation** — CSS `transition: transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)` applied on single-page transforms. Jump navigation (goTo, scrollToAnchor) stays instant.
- **Loading grace period** — Spinner only appears if the book takes >200ms to open (rare with Rust prefetch).
- **Search bar clear button** — × button clears the query and returns to unsearched state.
- **Shelf membership in context menu** — Right-clicking a book in Library shows which shelves it belongs to, with one-click removal.
- **TTS pause/resume** — Play/Pause now suspends/resumes the Web Audio timeline without restarting synthesis (was restarting the entire pipeline).

### Changed

- **Immersion bar redesigned** — Full-width on mobile with `justify-center`, larger touch targets (play 40×40px, aux 32×32px), generous spacing (`gap-2`, `py-3`, `px-4`), safe-area coverage. All via `sm:` responsive prefixes; desktop stays compact.
- **Theme switching** — `getCSS` statically imported (no `await import()` on every switch), making the first theme toggle instant.
- **Brightness filter** — `CSS filter: brightness(%)` applied to the full-bleed reader container (`inset-0`) instead of a separate rectangle.
- **TTS speed** — Speed is now correctly applied at play start. Changing speed during playback triggers a restart with the new speed.
- **Toolbar buttons** — Click propagation stopped so headphone/other toolbar clicks don't trigger page navigation.
- **Loading state** — Spinner has a 200ms grace period to avoid flashing on fast opens.

### Fixed

- **Android: selection highlight on multi-column pages** — #container uses `overflow: clip` (makes scrollLeft/scrollTop inert) combined with `transform: translateX/Y()` for page positioning. The previous JS guards (checkPointerSelection, focusin, touchmove) blocked JS-level causes, but the OS-level auto-scroll of scrollLeft during native text selection was only beaten by this structural change.
- **Zoom persists across books** — Global `readerSettings.zoom` reset to 100% on each new book open. Zoom re-applied after every chapter change (`goTo`/`goToFraction`).
- **Immersion bar overlaying content** — Reader container gets `pb-16` when immersion bar is active, with `transition-[padding] 300ms` for smooth resize.
- **Android TTS crash** — `ImmersionPlayer.init()` now merges callbacks instead of wholesale replacing, preventing callback loss when multiple consumers call init.
- **TTS speed dependency** — `handlePlay` no longer had stale closure over speed; now correctly reads from store.
- **ReaderViewport empty init removed** — Removed `immersionPlayer.init()` call that was overwriting ImmersionBar's callbacks with empty ones, causing onStateChange to never fire and the UI to permanently stick at 'loading'.
- **Share notification feedback** — Added error toasts for preview generation failures in both highlights and stats share modals. Added "Popup was blocked" toast in ShareMenu when X share popup is blocked.
- **Rust clippy warning** — `map_or(false, ...)` → `is_some_and()` in `epub_parser.rs` (new Rust 1.96 lint).

### Performance

- **Rust EPUB parser** (`src-tauri/src/epub_parser.rs`): Opens zip once, reads container/OPF/nav/NCX/section text, and returns a full sizes map. Runs in parallel with JS zip.js getEntries. No new Rust dependencies (uses existing `zip` and `regex` crates).
- **In-flight loadText dedup**: Map-based deduplicator wraps loadText so concurrent calls for the same href share one zip.js inflate.
- **Static getCSS import**: `foliate/reader.ts` module preloaded at app startup, eliminating the dynamic import delay on every theme switch.

### Note

- **TTS on Android/mobile**: Audio synthesis runs via ONNX Runtime CPU inference, which is significantly slower on mobile hardware than desktop. On Android, each sentence takes ~5-10 seconds to produce first audio. This is a backend limitation — the Rust Kokoro TTS engine runs full neural model inference on CPU. Android native TextToSpeech API integration or Web Speech API fallback would be needed for instant TTS on mobile. Desktop TTS (macOS/Linux/Windows) has near-real-time performance after model warmup. Speed control on mobile uses `playbackRate` (pitch-preserved via Web Audio) instead of SoundTouch offline stretching (blocking on mobile).

### Added

- **CBR comic support** — RAR archives are now supported. Transparently converted to CBZ at import time via Rust `unrar-ng` decompression. OS file association registered for `.cbr`.
- RAR magic byte detection in buffer-based format detection.

### Fixed

- **TTS on Android** — Fixed silent playback in production builds by properly awaiting AudioContext.resume() before scheduling audio.
- **Auto-navigation during text selection** — `checkPointerSelection` disabled (upstream Foliate navigates to adjacent page when selection crosses column boundary, problematic on mobile).

### Changed

- **TTS speed control removed** — Non-functional. Speed button removed from ImmersionBar and Settings dropdown removed.
- **Focusin handler guarded** — Prevents scroll to page 1 during mobile text selection. Added body/documentElement exclusion.
- **README overhaul** — Complete rewrite with all features documented (highlight sharing, PDF annotations, backup/restore, achievements, FBZ/CBR, more). 7 screenshots added. Web demo badge. MIT vs AGPL FAQ.
- **CHANGELOG corrected** — TTS status reflects current restored state, not the historical removal.

## [1.0.0] - 2026-06-28

First stable release. Subsequent fixes and additions in 1.0.1.

### Added

- **Reading achievements** — Unlock badges (First Book, Bookworm, On Fire, Highlighter) as you read.
- **Reading goals** — Configurable daily reading goal (minutes) and yearly book goal.
- **Activity heatmap** — 12-week reading activity grid in Statistics.
- **Reading speed tracking** — Words-per-minute average reading speed.
- **Highlight share as image** — ShareStudio generates polished share-card images (highlight cards, reading stats). Export as PNG, copy to clipboard, or share via Web Share API / X (Twitter). Square (1080×1080) and Story (1080×1920) formats with multiple visual themes.
- **Backup & restore** — Full backup bundle (books, annotations, dictionaries, vocabulary, RSS, settings, sync state) exportable as a single JSON file. Clear all application data option.
- **Onboarding flow** — First-run step-by-step walkthrough covering library, reader, annotations, and sync.
- **Open With file association** — Desktop users can open ebook files directly from their file manager ("Open With Theorem").
- **Android content URI support** — Full pipeline for materializing and reading files from Android content:// URIs.
- **FBZ / fb2.zip import** — Compressed FictionBook format support.
- **Dictionary download from repository** — Browse and download remote StarDict dictionaries with progress tracking.

### Fixed

- **TTS on Android** — Fixed silent playback in production builds by properly awaiting AudioContext.resume() before scheduling audio. Previously the Web Audio context stayed suspended and audio was silently dropped.
- **TTS speed control removed** — Playback speed control was non-functional (SoundTouch blocked on mobile, playbackRate shifted pitch without preservation). The UI controls have been removed to avoid confusion.
- **EPUB reader timeout regression** — Some books were stuck at "Loading book..." indefinitely. Added timeout and fallback safeguards.
- **Mobile reader back button** — Correctly exits to library instead of navigating elsewhere.
- **Redundant navigation** — Prevented duplicate navigation actions during routing.
- **Sync race conditions** — Resolved overlapping library updates during rapid data syncs.
- **Sync security** — Addressed tombstone propagation and encryption edge cases.
- **Storage timeout** — Increased read timeout for large books.
- **Text truncation on mobile** — Fixed reader title wrapping on small screens.

### Changed

- **TTS system overhauled** — Complete rewrite of the Kokoro neural TTS pipeline: streaming parallel synthesis, Web Audio API gapless playback, per-word highlighting, voice switching, next-page preloading. Replaced Rust `tts-rs` ONNX bindings with `kokoro-en` (pure Rust phonemizer via misaki-lean, no espeak-ng subprocess needed).
- **LAN sync re-architected** — Switched from blocking synchronous file payloads to async encrypted stream chunks. Reduced OOM risk on Android. Eliminated "Double JSON" serialization overhead.
- **Import system rewritten** — Concurrency-controlled batch import with SHA-256 content hash deduplication. Magic byte format detection. Filename metadata extraction.
- **Settings schema migrated** — Versioned Zustand migrations for all persisted stores (TTS, vault, sync, reading progress).
- **Cross-platform build pipeline** — GitHub Actions CI/CD produces Linux (.deb, .AppImage), macOS (Intel + Apple Silicon .dmg), Windows (.msi, .exe), and Android (.apk) from a single codebase.

### Removed

- Playwright e2e tests and related devDependencies (replaced by expanded Vitest coverage).

### Known Limitations

- iOS is not currently supported (Tauri does not target iOS)
- User is responsible for data backups (export bundle recommended for migration)
- No Cross-device network sync beyond local LAN

---

## [1.0.0-beta.5] - 2026-03-27

### Changed

- Overhauled LAN Sync performance — blocking synchronous file payloads → async encrypted stream chunks, reducing OOM on Android
- Re-architected data serialization — eliminated "Double JSON" stringification lags

### Fixed

- Sync race conditions during rapid data pushes
- SQLite-to-disk blocking timeout on tokio thread

## [1.0.0-beta.4] - 2026-03-24

### Fixed

- Reader title truncation on mobile
- Feeds page overlap with sync button
- Added spinning animation to sync button for active state feedback

## [1.0.0-beta.3] - 2026-03-23

### Added

- OS file association support ("Open With") via Tauri events
- Import failure alerts in library

### Fixed

- Storage read timeout for large books
- Mobile reader back button routing
- Redundant navigation prevention

## [1.0.0-beta.2] - 2026-03-09

### Added

- Encrypted LAN device sync with QR pairing
- Linux packaging scripts

### Fixed

- Sync security and tombstone propagation
- Linux local install fallback

## [1.0.0-beta.1] - 2026-02-27

### Added

- **Reader Engine** — EPUB, MOBI, AZW/AZW3, FB2, CBZ, PDF support. Foliate-based reflowable rendering. PDF.js with annotation support. RSS feed reader.
- **Library Management** — Import from local files, folder scanning, shelves/collections, favorites, ratings, tags, sorting, search.
- **Annotations** — Color-coded highlights (6 colors), notes, bookmarks, annotation panel. PDF: highlights, freehand drawing, text notes. Overlayer: highlight, underline, strikethrough, squiggly.
- **Vocabulary** — Built-in dictionary, StarDict support, vocabulary review.
- **Markdown Export** — Obsidian/Logseq vault sync, per-book pages, vocabulary export, customizable naming.
- **Neural TTS** — Kokoro ONNX engine, 6 voices, streaming playback, per-word highlighting.
- **Reading Statistics** — Daily activity, reading time, streaks, reading speed, heatmap.
- **Search** — Full-text in-book search, library search, RSS article search.
- **Cross-Platform** — Desktop (Linux, macOS, Windows) + Android + Web fallback.
- **Theming** — Light/dark/sepia reader themes. Custom fonts, margins, spacing, alignment, hyphenation.
- **Multi-format support** — EPUB, MOBI, AZW, AZW3, FB2, CBZ, CBR, PDF, TXT, RSS articles.
