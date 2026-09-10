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

## Reader Annotation Flow

### Creating a Highlight (Non-PDF)

1. User selects text in the iframe
2. `foliate-view web component` fires a selection event
3. `FoliateEngine` receives the event, creates the annotation object with location CFI
4. Calls `libraryStore.addAnnotation()`
5. Store mutation triggers `queueVaultSync()` (for Markdown export)
6. If sync is active, `scheduleMutationSync()` propagates to paired devices

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
