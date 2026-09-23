# Reader

## Why Two Engines

Reflowable formats (EPUB, MOBI, FB2) are fundamentally different from PDF. PDF is a fixed-layout print format — pages are predefined canvases. Reflowable formats are documents where text and images flow into columns of whatever size the viewport provides. Comic archives (CBZ/CBR) are also fixed-layout. One engine cannot do both well.

- **Foliate-js** handles all reflowable formats. It's a mature library that knows how to parse EPUB spines, MOBI headers, and FB2 XML, then render them into an iframe with CSS column layout. Fixed-layout comics (CBZ/CBR) go through `fixed-layout.js`/`comic-book.js`.
- **PDF.js** handles PDF. It renders each page to a canvas, overlays a text layer for selection, and an annotation layer for highlights.

## Entry Points

| Component | File | Loaded |
|-----------|------|--------|
| `ReaderPage` | `src/features/reader/Reader.tsx` | Lazy (prewarmed in `App.tsx` after hydration) |
| `ReaderViewport` | `src/features/reader/components/ReaderViewport.tsx` | Eager |
| `PDFReader` | `src/features/reader/components/PDFReader.tsx` | Lazy (on first PDF) |
| `ReaderNavbar` (immersion row) | `src/features/reader/components/progress/ReaderNavbar.tsx` | Eager (reader chunk) |

> RSS articles are converted to a synthetic EPUB (`convertArticleToEpubBlob`) and rendered through the normal foliate engine. `ArticleViewer.tsx` is exported but unused.

## Non-PDF Rendering Path

```
Reader.tsx
  └─ useDocumentReader() hook
       └─ FoliateEngine (class)
            └─ foliate-js view.js (iframe-based rendering)
                 ├─ foliate-paginator (CSS grid column layout)
                 │    └─ #container (grid track-sized, NOT content-sized)
                 ├─ overlayer.js (highlight overlays in iframe)
                 └─ epub.js / mobi.js / fb2.js / comic-book.js
```

**Loading flow:**
1. `Reader.tsx` checks `book.syncedWithoutFile` — if true, triggers `downloadBookOnDemand(bookId)`
2. Download: Rust `download_book_file` streams from peer to `book-cache/{id}.book` (1MB chunks, no IPC)
3. Progress: `download-progress` Tauri events update the UI bar (throttled to percentage changes)
4. Once file is ready, `getBookBlob(id, storagePath)` reads the file
5. Passes buffer to FoliateEngine or PDFReader
6. EPUBS: `FoliateEngine.open()` → `makeBook(file, prefetchPromise)` where `prefetchPromise` resolves to metadata-only cache from Rust
7. `makeZipLoader()` creates a ZIP reader with two paths:
   - **Metadata** (container.xml, OPF, nav, NCX, encryption) → served from Rust pre-parser cache
   - **Sections** (chapter HTML, CSS, images, fonts) → loaded lazily via zip.js `getLazyZip()` → `getEntries()` → `entry.getData()`
8. `foliate-js view.js` creates a `FoliateView` web component in an iframe
9. The iframe is mounted inside the `foliate-view` element's shadow DOM
10. `paginator.js` measures `#container` (grid-determined, no layout settle needed) and columnizes

**Zoom:** Applied to the iframe document before column calculation. `applyZoomToDocument()` runs inside the `load` event handler, before `beforeRender()` and `columnize()`. After navigation, `applyZoomSync()` re-applies zoom as a safety net (harmless redundancy).

## Theorem Lens (Footnote & Citation Peek Portals)

When reading reflowable EPUBs or academic documents, tapping a footnote reference (e.g. `[1]`, `[Note 4]`, `<aside epub:type="footnote">`, `role="doc-noteref"`) activates **Theorem Lens** (`FootnotePopover.tsx`):
* **In-Place Popover**: Instead of jumping to the back of the book, a floating lens balloon anchors directly above or below the tapped reference.
* **Rich HTML & Media Rendering**: Displays formatted citation text, author commentary, and embedded diagram images.
* **Quick Actions**: Copy text, jump directly to the notes section (`[Jump ↗]`), or dismiss effortlessly by scrolling or tapping away.

## PDF Rendering & Memory Architecture

```
Reader.tsx
  └─ PDFReader (lazy)
       └─ PDFJsEngine (forwardRef + memo)
            └─ pdfjs-dist
                 ├─ Canvas rendering (on-demand viewport window)
                 ├─ Text layer (selectable text & search)
                 └─ Annotation layer (highlights, drawings)
```

PDF.js is prewarmed on app start via `prewarmPdfJsRuntime()`. To prevent memory bloat on large documents:
1. **Thread Worker Lifecycle**: `PDFDocumentLoadingTask` worker instance is retained and explicitly destroyed via `loadingTask.destroy()` on reader unmount and book change.
2. **On-Demand Page Streaming**: `disableAutoFetch: true` and `disableStream: true` ensure the worker only fetches byte ranges for visible pages.
3. **GPU Canvas Backing Store Reclamation**: When a page leaves the viewport window, `canvas.width = 0; canvas.height = 0;` runs after the inactive-release delay, freeing GPU framebuffer memory in Skia/Direct2D/Metal.
4. **Operator List Garbage Collection**: `page.cleanup()` is invoked on non-visible page proxies to release deserialized vector operators and image bitmaps.
5. **Presentation Modes**:
   - **Continuous (`scroll`)**: Virtualized DOM window with automatic layout measurement and smooth anchor restoration.
   - **Single Page (`paged`)**: Auto-fits page to screen (`page-fit`), centers using `m-auto` layout to prevent flex data-loss clipping, and keeps a ±2-page window pre-loaded for 0ms instant page turns.
6. **Settings Persistence**: Zoom level, zoom mode, and presentation mode are saved per-book in `PdfViewState` within SQLite.
7. **Canvas Theme Filters**: Dark mode (`.pdf-theme-dark` with CSS invert and hue rotation) and Sepia mode (`.pdf-theme-sepia` with warm tint) apply seamless eye-comfort filters to fixed-layout PDF canvases without re-rasterizing vector layers.
8. **Logical Page Labels**: PDF.js `getPageLabels()` extracts publisher-defined roman numerals or appendix numbering (e.g. `iv (4 / 120)`). Labels are displayed in floating pills, formatted in titlebars, and resolved directly in page jump inputs (`goTo(target)`).
9. **Rich Metadata**: Extracts PDF `creator`, `producer`, `pdfVersion`, and physical `pageSize` dimensions in the book info popover.

## Annotations & O(1) Indexing

Annotations sync between three layers:
1. **Engine** — The rendering engine handles visual placement (highlights in iframe/on canvas)
2. **Store** — `libraryStore.annotations` holds the canonical annotation data
3. **Panel** — `ReaderAnnotationsPanel` provides the UI for viewing/editing

The sync is bi-directional:
- User highlights in iframe → engine event → store mutation → panel re-render
- User deletes in panel → store mutation → engine re-renders (removes highlight)

Annotations are persisted both per-book in the `book_annotations` SQLite table and as part of the persisted Zustand state (`libraryStore.annotations`, which is included in the store's `partialize`). Inside `Reader.tsx`, annotations and bookmarks are indexed into constant-time $\mathcal{O}(1)$ Maps (`annotationsById`, `annotationsByLocation`, `annotationsBySelectedText`, `bookmarkByLocation`), eliminating linear $\mathcal{O}(N)$ scans during rapid user selections and bookmark checks.

## Full-Text Search

- **Non-PDF**: foliate-js's built-in search via `search.js` with whole-word and case-matching options.
- **PDF & Native Rust**: A multi-threaded streaming search engine (`src-tauri/src/book_search.rs`) scanning unpacked text chunks with word-boundary byte verification.
- **UX & Navigation**:
  - **Toggles**: Match Case (`Alt+C`) and Whole Word (`Alt+W`).
  - **Result Counter**: Displays "Result X of Y" with real-time progress indicators.
  - **Keyboard Cycling**: Cycle through matches seamlessly using `Enter` / `Shift+Enter` or `F3` / `Shift+F3`.
  - **Scroll Alignment**: Active matches automatically scroll smoothly into view.

## TTS / Immersion Reading

Platform-specific TTS commands in Rust:
- **Linux**: `spd-say` (speech-dispatcher)
- **macOS**: `say` command
- **Windows**: PowerShell `System.Speech`
- **Android**: Native TTS plugin

The Rust commands are synchronous shell commands, but the JS side (`ImmersionPlayer.ts`) manages playback state and, on Android, resumes from the last reported word boundary. Sentence/word highlighting synced to narration is not yet implemented. Companion audiobook tracks (`.m4b`/`.mp3`) upgrade this player into a human-narrated player with speed controls.

## Roadmap: v1.6.0 Bionic / Fast-Reading Mode

In **v1.6.0**, Theorem will add a native **Bionic / Speed-Reading Mode**:
- **Typographic Fixation**: Emphasizes the initial syllables of words to facilitate faster saccadic movement across sentences.
- **Engine-Native Rendering**: Injected via the reader overlayer and CSS styling pipelines across EPUB, MOBI, and PDF.js text layers with zero runtime JS allocation overhead.
- **Configurable Controls**: Accessible from Reader Settings with adjustable fixation intensity, saccade frequency, and per-book toggles.


