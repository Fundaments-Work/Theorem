# Annotations

## Types

Three annotation types share a single data model:

| Type | Purpose |
|------|---------|
| `highlight` | Selected text with a color. Optionally attached to a note. |
| `note` | A standalone note (or attached to a highlight). |
| `bookmark` | A saved position with a label. No text selection. |

## Data Model

Annotations are stored in two places simultaneously:

- **Per-book** in SQLite `book_annotations` table. Keyed by `book_id`, indexed for fast queries. This is the durable store.
- **Global index** in `libraryStore.annotations` (Zustand array). Loaded on app start, kept in memory for cross-book operations (e.g., "all annotations across all books") and sync.

The global index is the single source of truth for the UI. On app start, it's populated by loading all annotations from SQLite. On mutation, both stores are updated together.

Startup hydration (`reconcileHydratedAnnotations` in `libraryStore.ts`) only drops rows covered by a deletion tombstone (the annotation's or its book's). Books load concurrently, so an annotation whose book is not in memory yet is **never** treated as orphaned. Deleting an annotation removes it from state and SQLite and records a tombstone, which keeps sync from re-inserting it.

## Workbench & Bookmarks lists

Both pages render `components/AnnotationListCard.tsx`. Cards fit their content, but their height is **computed from the text**, never measured per row (`annotation-card-layout.ts`): `useCardTextMeasurer` reads the list width (one `ResizeObserver` on the container) and the serif font, `countWrappedLines` word-wraps with canvas text widths, and `computeCardLayout` gives the line counts. The same layout sizes the virtual row and the card, which renders at exactly that height with text line-clamped to it, so gaps stay uniform even if a count is off by a line. Quotes longer than 8 lines (notes 6) collapse behind **Show more**. The row with an open menu raises its `z-index` (each transformed virtual row is its own stacking context); menus close on outside press or Escape. Bookmarks show a position line from `bookmarkPositionLabel` (PDF page, article percentage) and can be filtered by book.

## Reader Annotation Flow

### Creating a Highlight (Non-PDF)

1. User selects text in the iframe
2. `foliate-view web component` fires a selection event
3. `FoliateEngine` receives the event, creates the annotation object with location CFI
4. Calls `libraryStore.addAnnotation()`
5. Store mutation triggers `queueVaultSync()` (for Markdown export)
6. If sync is active, `scheduleMutationSync()` propagates to paired devices

### Cross-page highlights (EPUB)

A highlight is one CFI range; the overlayer draws it as per-line rects, so a sentence split across a page or column break is already a single highlight. To keep it that way, a new selection that **overlaps or exactly touches** existing highlights in the same section is merged (`mergeSelectionIntoHighlights` in `Reader.tsx`, logic in `foliate/selection-anchor.ts`): the oldest highlight keeps its id and notes, its CFI becomes the union, and the others are removed with tombstones. A selection fully inside a highlight edits that highlight instead. Highlights never span spine sections. PDF highlights are per page and are not merged.

### Selecting on touch devices (EPUB)

- **Toolbar anchor.** The highlight toolbar hangs from a rect that is actually on screen
  (`pickVisibleAnchorRect`). For a selection that runs onto the next page the last text rect is on
  the other page, so the nearest visible one is used (clamped into the viewport if none is).
- **Handle drags settle.** Native selection handles move without any DOM touch events, so on
  coarse-pointer devices a burst of `selectionchange` is a drag in progress. The toolbar is
  re-anchored 260 ms after the selection stops moving instead of on every frame.
- **No page travel on touch.** The paginator's auto-turn while dragging a selection applies to
  mouse and pen only (`pointerType !== 'touch'`); touch selections never carry the reader to
  another page.
- **Matching.** A selection "is" an existing highlight only when it lies *inside* it
  (`findAnnotationForSelection`, CFI containment, with an identical-text fallback in the same
  section for legacy CFIs that no longer resolve). Matching on text across the whole book made a
  repeated phrase edit a different highlight; that is gone.

### Creating a Highlight (PDF)

1. User selects text in PDF canvas view
2. Text layer provides the selected string + bounding rects
3. `PDFAnnotationLayer` renders the highlight on the canvas
4. Annotation data is saved via the same `libraryStore.addAnnotation()` path
5. PDF-specific: rect data is stored for re-rendering highlights on reload

### Syncing Annotations Between Engine and Panel

Bidirectional sync:
- **Engine → Panel**: `ReaderAnnotationsPanel` subscribes to `useLibraryStore(s => s.getBookAnnotations(bookId))` using `useShallow` to avoid re-renders when unrelated annotations change.
- **Panel → Engine**: When user deletes/edits an annotation in the panel, the store mutation triggers a callback that tells the engine to update the visual. For foliate, this means removing/updating the highlight overlay in the iframe. For PDF, this means re-rendering the annotation layer.

## Cross-Book Annotations

The `AnnotationsPage` (`src/features/library/Annotations.tsx`) aggregates all annotations across all books. It groups by book and filters by type (highlights / notes / vocabulary), with sort options newest / oldest / book.

## Markdown Export

Annotations are exported to Markdown via `vault-sync.ts`:
- Each book gets a `.md` file with YAML frontmatter
- Highlights are rendered as `<mark>` elements with the highlight color mapped to a CSS variable
- Block quotes contain the highlighted text
- Notes are attached below their parent highlight

Only highlights and notes are exported; bookmarks are not written to the Markdown pages.

## Storage Details

```sql
-- Per-book annotation table
CREATE TABLE book_annotations (
    id TEXT PRIMARY KEY,           -- UUID
    book_id TEXT NOT NULL,         -- FK to books
    annotation_json TEXT NOT NULL, -- Full annotation object as JSON
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE
);
CREATE INDEX idx_book_annotations_book_id ON book_annotations(book_id);
```

The `annotation_json` column stores the full annotation object because the annotation schema varies by type (highlights have `selectedText` and `color`, notes have `noteContent`, PDF annotations have `rect` arrays and `drawingData`). A fixed schema would require nullable columns for every variant.

## Rendering Differences Between Engines

| Aspect | Foliate (non-PDF) | PDF.js (PDF) |
|--------|-------------------|--------------|
| Highlight placement | SVG rects in an overlay layer above the iframe | Absolutely-positioned HTML `<div>` overlay |
| Location format | EPUB CFI | Page number + rect coordinates |
| Drawing/underline | Not supported | Pen drawing supported (SVG); underline not supported |
| Text selection | Provided by browser in iframe | Custom text layer overlay |
| Re-rendering on reload | Foliate auto-renders from CFI data | Rect data deserialized and re-drawn |
