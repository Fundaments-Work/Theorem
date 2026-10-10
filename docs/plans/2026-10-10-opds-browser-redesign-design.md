# OPDS Browser Redesign — Design

**Date**: 2026-10-10
**Status**: Approved — in progress
**Area**: Catalogs / OPDS
**Files touched**: `src/features/catalogs/OPDSBrowser.tsx`, `src/core/services/OpdsService.ts`, new shared catalog components

---

## 1. Goals & Non-Goals

### Goals

Make OPDS browsing feel like the rest of the app: fast on large catalogs, a search that
actually searches, filters and sorting, and chrome consistent with the Library.

1. **Performance** — virtualize the results grid.
2. **Search** — search-as-you-type that always works, with result count and empty state.
3. **Consistency** — reuse the Library's book card, covers and filter chips.
4. **Filtering/sorting** — sort by title/author/recent, plus language and format filters.

### Non-Goals (explicit)

- **No redesign of the detail modal or breadcrumbs.** The user reviewed these and did not
  flag them; they are explicitly out of scope for this pass.
- **No change to OPDS parsing semantics.** `OpdsService.parseOpdsFeed` keeps its current
  contract; this is a presentation and interaction change.
- **No offline caching of catalogs.** Out of scope; OPDS is a network feature.
- **No rewriting of the catalog preset list.**

---

## 2. Findings (traced, not assumed)

Each defect below was confirmed by reading the code, not inferred.

### 2.1 OPDS is the only un-virtualized list in the app

`@tanstack/react-virtual` is used by:

| View | File |
|---|---|
| Library | `src/features/library/Library.tsx` |
| Shelves | `src/features/library/Shelves.tsx` |
| Bookmarks | `src/features/library/Bookmarks.tsx` |
| Annotations | `src/features/library/Annotations.tsx` |
| Feeds | `src/features/feeds/FeedsPage.tsx` |
| Discover search | `src/features/catalogs/DiscoverPage.tsx` |
| Reader search / PDF page grid | `ReaderSearch.tsx`, `PdfPageGrid.tsx` |

`OPDSBrowser.tsx` renders every entry as a real DOM node. Covers already carry
`loading="lazy"`, but lazy images do not help when the elements themselves all exist: a
5,000-entry catalog mounts 5,000 cards. This is the "performance feels bad" report.

### 2.2 Search frequently does nothing at all

`handleSearch` is submit-only and gated on the feed advertising `searchUrlTemplate`:

```ts
if (feed?.searchUrlTemplate) { /* search */ }
```

Feeds without an OpenSearch template silently ignore typed input. There is no debounce, no
result count, no empty state for "no results for X", and the result **replaces the feed**,
so drilling into a category and searching loses the way back.

### 2.3 No filtering or sorting

There is no sort control, no language/format filter, and no client-side narrowing of an
already-loaded feed.

### 2.4 Chrome diverges from the Library

`OPDSBrowser` hand-rolls its own tiles, cards and filter styling. The Library now shares
`FILTER_CHIP_SELECTED` / `FILTER_CHIP_UNSELECTED` / `FILTER_CHIP_UNSELECTED_ON_SURFACE`
(`src/features/library/Library.tsx`) plus a responsive column observer and
`TheoremBookCover`. OPDS uses none of it, which is why it reads as a different app.

---

## 3. Design

### 3.1 Virtualized grid (phase 1)

Replace the flat `grid grid-cols-2 … xl:grid-cols-6` map with a virtualizer, following the
Discover search grid (`DiscoverPage.tsx:215`) as the closest analogue: it already virtualizes
a cover grid over a scroll container.

- Rows, not cells: `effectiveCols` from the existing responsive observer, one virtual row
  per line of covers (same shape as the Library's `rowVirtualizer`).
- `estimateSize` derived from the column width, mirroring the Library's non-list branch.
- Re-measure on column-count change.

### 3.2 Search that always works (phase 2)

- Debounce to 250 ms, search-as-you-type, no submit required (the form stays for Enter).
- **Dual path:** if the feed advertises `searchUrlTemplate`, use server search; otherwise
  filter the loaded entries locally on title + author. Search therefore never silently
  fails.
- Track `searchSource: "server" | "local"` and label results accordingly.
- Result count above the grid; explicit `No results for "X"` state with a clear button.
- Keep navigation context: remember the feed URL that was open before searching and offer
  a Back-to-browse affordance.

**Trade-off, stated plainly:** local filtering only covers what is already fetched. For a
50,000-title feed, only server search can search everything. That is exactly why both
paths remain.

### 3.3 Filtering and sorting (phase 3)

- Sort: Title, Author, Recently added.
- Filters: language, format.
- Applied client-side to the loaded set, rendered with the Library's `FILTER_CHIP_*`
  classes so hover/selected states match everywhere.
- Filters hide (not reset) when no entry matches, and show a "clear filters" chip.

### 3.4 Visual consistency (phase 4)

- Covers via `TheoremBookCover` (gives the deterministic clothbound fallback for entries
  with no `cover_url`, instead of a broken image).
- Reuse the Library's responsive column observation rather than a second breakpoint set.
- Match card padding, title clamping and metadata line to the Library book card.

---

## 4. Data & Error Handling

- **No new Rust work.** OPDS is fetched over HTTP from the frontend; parsing stays in
  `OpdsService`.
- **Download path unchanged** — `handleDownload` already reports progress and tolerates a
  cover fetch failure (ignores it). That behaviour is preserved.
- **Search failure** (server path) → toast plus a local-filter fallback, so a flaky or
  unsupported feed still lets the user narrow what is on screen.
- **Filter/sort failures** are impossible: both are pure client-side derivations of the
  loaded entries.

---

## 5. Testing

- **Virtualization**: results grid renders a bounded window of rows for a large synthetic
  feed (assert the mounted card count stays far below the entry count) — this is the actual
  regression guard for §2.1.
- **Search**: local fallback filters by title and author; debounce does not fire on
  keystroke; empty query restores the feed; server path is used when a template exists.
- **Sort/filter**: ordering and narrowing are stable; clearing filters restores the full set.
- **Consistency**: cards render `TheoremBookCover`, so an entry with no cover gets the
  fallback rather than a broken image.

Existing suites that must keep passing: `tests/opds.test.ts`, `tests/discover.test.ts`.

---

## 6. Sequencing

| Phase | Change | Risk |
|---|---|---|
| 1 | Virtualization + skeletons | Low — mechanical, biggest win |
| 2 | Search (debounce + local fallback) | Medium — interaction change |
| 3 | Sort + filters | Low |
| 4 | Visual consistency | Low |

Phases 1 and 3 are independently shippable. Phase 2 is the one that most changes behaviour
and is therefore last among the logic changes so it can be evaluated on its own.