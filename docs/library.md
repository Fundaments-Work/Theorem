# Library

## Why Virtual Scrolling

At 10,000 books, rendering a DOM node for every book would consume gigabytes of memory and freeze the main thread. The library uses `@tanstack/react-virtual` to render only the ~30 rows visible in the viewport. As the user scrolls, rows are recycled and repopulated.

The `BookCard` component is wrapped in `React.memo` with a custom comparator that checks only the fields rendered in the card (title, author, progress, cover, favorite, view mode). Unrelated state changes won't trigger re-renders.

## Import Pipeline

Library **Add Books** and folder imports submit a whole batch to the native
queue (`src-tauri/src/import_jobs/`). Rust advances the queue independently of
the Library view and WebView execution. The durable worker handles one file at a
time; the existing parallel batch entry point remains available for legacy callers.
`native-import-jobs.ts` submits requests
and consumes saved results; `importStore.ts` retains the current progress for the
application shell. Existing `ingest_books_native` and browser import entry points
remain available to callers that do not opt into durable jobs.

```
Add Books / folder scan
  → native_import_start (stable book IDs + source-folder options)
  → device-local checkpoint in SQLite
  → Rust worker: materialize → check → metadata / archive conversion → save
  → one transaction: book metadata + checkpoint acknowledgment
  → UI consumes saved results; opening a reader hides only the progress panel
```

The progress panel is outside the Library scrolling/containment surface.
It shows file counts, copying/checking bytes, per-file errors, and indeterminate
progress for stages without measurable totals. Copying 100% does not complete a
file: its metadata must be saved. Archive preparation and metadata extraction
are indeterminate. Native archive bytes never enter JSON IPC.

Android uses our `ACTION_OPEN_DOCUMENT` picker and retains read permissions for
recovery; the scanner's display filename determines format for opaque document
URIs. An explicit import or Resume starts a `dataSync` foreground service and
notification. Stop and Android's service timeout cancel native work; the service
is not restarted automatically. A temporary provider copy is moved into the
library cache, preserving the existing single-copy ingestion behavior. The queue
tracks that ownership explicitly; an external directory named `theorem_import`
is never enough to make its files disposable. The legacy bridge verifies the
canonical app-owned staging directory before moving a copy. Unknown
source sizes remain indeterminate; revoked permissions and provider failures are
reported per file. Force-stop does not promise continued execution.

The checkpoint is versioned (`native-import-job:v1`, device-local `kv_store` key)
and is never synced. Metadata and completion acknowledgment commit together;
a failure rolls both back. Resume skips saved/duplicate entries, retains errors,
and restarts the interrupted file under its original book ID. It never rewrites
already completed books, so their reading progress and manual edits survive.
Corrupt or unsupported recovery data is retained and reported instead of being
replaced. Checkpoint outcomes deliberately use empty struct variants. Locked
Serde 1.0.229's `InternallyTaggedUnitVisitor::visit_map` consumes remaining entries
as `IgnoredAny`, even with `deny_unknown_fields`; `serde_derive` routes struct
variants through its struct visitor instead. This preserves strict rejection of
unknown recovery fields without adding payload to the outcome variants. Discard pending import removes the valid pending job and its uncommitted
cache files while retaining saved books and source documents.

The locked Tauri 2.12.2 `PluginHandle::run_mobile_plugin` sends its command through
the native bridge and waits on a Rust channel (`rx.recv()`), without a JavaScript
continuation or built-in timeout. This is the rule the native Android worker
relies on. The locked dialog plugin still uses `ACTION_GET_CONTENT`, so it cannot
supply persistent recovery permissions; our picker owns that requirement.
Android's [foreground-service timeout rules](https://developer.android.com/develop/background-work/services/fgs/timeout)
require stopping after `Service.onTimeout`; the service handles that callback and
native conversion checks cancellation between archive writes.

The browser keeps its IndexedDB import fallback. Legacy Android content-URI
materialization and `import_book_path` also retain their real-result lifetime:
a JavaScript timeout would not cancel their native work.

**Dedup logic:**
- Books with the same `contentHash` (SHA-256 of file contents) are treated as duplicates
- The first import wins — subsequent imports are skipped
- Re-importing the same file path updates the file path but preserves annotations and progress

## Virtual Scrolling Architecture

```
LibraryPage
  └─ useVirtualizer (from @tanstack/react-virtual)
       ├─ scrollRef (scrollable container div)
       ├─ Virtual row → MemoizedBookCard (custom memo comparator)
       └─ Three view modes: grid / list / compact
            ├─ grid: 2-8 columns depending on container width
            ├─ list: 1 column with full metadata
            └─ compact: 3-6 columns, minimal metadata
```

The virtualizer calculates rows based on container width (column count) and estimated row height. After render, actual row heights are measured and the virtualizer adjusts. This means initial render might show a flash before heights stabilize, but it avoids measuring every item upfront.

## Search

Two-tier search:
1. **FTS5 + SIMD Fuzzy Ranking** (`two_tier_search_books` in Rust, or `theorem-core` WASM `wasm_fuzzy_rank` in web): SQLite `FTS5` prunes disk candidates in ~1 ms, then `nucleo-matcher` scores and yields character match highlights.
2. **Filter & Sort** (`filtering.ts`): Filters and sorts loaded books by status, favorites, unshelved state, folder, title, author, date added, or last read, backed by store caches invalidated on `books` changes.

## Format Support

| Format | Reader Engine | Import Notes |
|--------|---------------|--------------|
| EPUB | Foliate | Reflowable, preferred format |
| MOBI | Foliate | Legacy Kindle format |
| AZW / AZW3 | Foliate | Kindle Format 8 |
| FB2 | Foliate | FictionBook XML |
| CBZ | Foliate | Comic book ZIP |
| CBR | Foliate (converted) | Converted to CBZ via the Rust `rars` crate (no external `unrar`) |
| PDF | PDF.js | Fixed-layout, range-based reads |

## Folder Scanning

`scan_library_folder_desktop(path)` recursively walks a directory and collects all supported files. On Android, `scan_library_folder_mobile(uri)` uses the SAF (Storage Access Framework) via a custom Tauri plugin.

The scan returns file paths; importing them is a separate step (`importBooksIncremental`) to avoid blocking the UI during long scans on network drives.

## Continue reading and action toolbar

The most recently opened book carries a small play icon inside its existing card
in grid, compact, and list views. Opening that card follows the normal reader
handler and saved location, including on-demand downloads for synced books.
Successful document/PDF loads record the open without altering progress or
location, so the cue appears before a page turn. Selection mode hides the cue.
Library adds no separate resume row, weekly progress panel, or Statistics link.

The action toolbar retains its earlier layout: Add Books, view, sort, and filters.
View and filter/sort use the shared bare IconButton, with 16px glyphs inside
44px touch targets (40px on desktop). They have no border or background;
The view/filter controls form a compact group beside Add Books, with matching
heights and an 8px gap from the primary action. Hover and active state use the accent color. Sidebar and Library share the
16px glyph class and default Lucide stroke. List view uses a rows glyph;
filter/sort uses a funnel glyph.
Start selection from a book's context menu; the toolbar then offers Done.
The initial book request waits until selection mode and its filtered scope are
ready, so entering the mode cannot discard the requested book. Scope changes
cancel the pending request.
Folder connection and rescanning are in Settings → Data & Storage → Library
Folders. The empty-library folder import entry remains available.

## Daily Review persistence and viewport

Daily Review is a fullscreen overlay portaled to `document.body`, outside the
Library's `content-visibility: auto` scroll container. CSS layout/paint
containment makes descendants' fixed positioning relative to that container;
portaling prevents a constrained overlay and stray scrollbars. Horizontal
fling overflow is clipped while short viewports can scroll vertically.
The deck is visible only on the Library route, even while routes stay mounted.

Dismiss for today stores the local date in `localStorage` under
`theorem-dismiss-daily-deck`, so it survives restart. A session-only dismissal
from an older version is copied over on first read. Completion retains the
existing `theorem:daily-review-state` format and stores the reviewed card IDs.
Same-window review events, storage events, focus, and a minute timer refresh
status and local date. Completion closes the overlay and stays completed when
annotations update; a new local day can show a fresh deck without restarting.
A failed dismissal write is reported rather than silently claiming persistence.

## Cover from URL

Edit Info → From URL → Load previews an image; Save persists it through the
normal `applyBookEdits` path, including EPUB cover write-back. HTTP(S) image URLs
are validated by `url-safety.ts`. Tauri uses the offloaded `fetch_cover_image`
command to avoid WebView CORS restrictions. Rust caps downloads at 8 MB and
uses the existing bounded native cover decoder/downsampler to return a JPEG
data URL. Invalid images and HTTP failures leave the previous cover intact.
The browser build uses fetch and therefore requires the host to allow CORS.

Save is blocked while downloading. Closing the editor, changing books, or
choosing another image invalidates pending results. Blob preview URLs are
revoked on replacement/close/unmount. No new persisted book format is required.

## Returning from another page

Library owns the book-grid scroll container, so its scroll position, filters and
virtualizer state survive navigation. The shell's outer `main` is shared with
long pages such as Settings. `App.tsx` resets that outer container's scroll
coordinates synchronously in a layout effect on route changes. Otherwise a
Settings offset can survive the route swap and shift Library partly or entirely
above the visible viewport. Library's own scroller is left intact. This needs
no deferred layout measurement or animation-frame delay.

A hidden page reports zero width; Library's ResizeObserver ignores that value
rather than regrouping rows against the window width. The grid remembers its
scroll offset only while Library is active and restores it through TanStack
Virtual's `scrollToOffset` after measuring on return. TanStack Virtual's
`measure()` clears size caches; its offset API owns scroll reconciliation, so
restoration uses the real visible container without a custom frame delay.

`e2e/specs/library-navigation.test.mjs` scrolls the real Settings page and
compares Library's bounds before and after returning at desktop and phone
widths. It asserts the viewport position as well as the container size: a grid
can have the correct height while being positioned off-screen.

## Import regression checks

Native checkpoint, stable-identity ingestion and CBR cancellation tests run in
Linux validation and the selected Windows import job in CI. Android changes also
run Rust checks for both shipped architectures. The dedicated Android library
project runs `:folder:testDebugUnitTest` without app packaging or signing.
The real-app `native-import-jobs` suite covers panel containment and reader
navigation, abrupt process interruption, explicit resume, cancellation/discard,
saved reading position, and corrupt recovery data. Its file barrier holds the
real worker at a checkpoint boundary; the queue, database and file operations
remain real. Physical Android large-file/background acceptance must be recorded
separately from these checks.
