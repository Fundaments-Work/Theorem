# OPDS Browser Redesign — Design

**Date**: 2026-10-10
**Status**: Completed — all four phases plus pagination delivered
**Area**: Catalogs / OPDS
**Files touched**: `src/features/catalogs/OPDSBrowser.tsx`, `src/features/catalogs/catalog-facets.ts`, `src/features/catalogs/components/OpdsBookCard.tsx`, `src/ui/filter-chips.ts`

| Phase | Commit |
|---|---|
| Design note | `b7587d9` |
| 1 — Virtualization + skeletons | `7a65e8d` |
| 2 — Search that always works | `eebe493` |
| 3 — Sort + filters | `a1a27bc` |
| 4 — Visual consistency | `93f70e0` |
| 5 — Feed pagination | _(this commit)_ |

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

**Delivered as:** rows sized from the *grid's* own width, not the scroll container's — the
content column is capped at `max-w-7xl`, so a wide window would over-estimate and grow a
scrollbar of empty space. `measureElement` was dropped rather than kept: the cover is
`aspect-[2/3]` and title/author are clamped to a fixed number of lines with explicit
leading, so the row height is exact and no measure pass is needed per scrolled row.

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

### 3.5 Feed pagination (phase 5)

The parser always extracted `next`/`previous` links; the browser never offered them, so
everything past page one of a paginated catalog was unreachable.

- A Prev/Next pager under the grid, rendered only when the on-screen feed links at
  least one direction. OPDS carries no page numbers, so nothing is displayed between the
  buttons — no "Page 2 of ?" guessing.
- Page turns are soft: the old grid stays mounted with the pager spinning, rather than
  flashing a skeleton. `loadFeed` takes a `soft` flag for this; initial loads and category
  changes keep the skeleton.
- A category's page turns go through a new `goToPage` store action that moves the URL
  without pushing navigation history — a page turn is not a navigation, so Back returns
  to the parent category instead of stepping through pages. The target-URL effect skips
  URLs the pager already loaded (`loadedUrlRef`), so there is no double fetch.
- Server-search result pages turn inside the result set, leaving the browsed category
  untouched. Sort, filters and the search query survive page turns.
- The scroll container returns to the top on every turn.

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
- **Consistency**: cards render `TheoremBookCover`, so an entry with no cover — or a cover
  URL that 404s — gets the fallback rather than a broken image.

Existing suites that must keep passing: `tests/opds.test.ts`, `tests/discover.test.ts`.

Delivered as `tests/opds-virtualization.test.tsx`, `tests/opds-search.test.tsx`,
`tests/opds-catalog-facets-ui.test.tsx`, `tests/opds-catalog-facets.test.ts`,
`tests/opds-book-card.test.tsx` and `tests/opds-pagination.test.tsx`, over the shared
harness in `tests/helpers/opds-browser-harness.ts`.

### 5.1 A note for anyone touching the harness

jsdom gives two things this feature depends on, and the harness supplies both:

- `getRect` in `@tanstack/virtual-core` reads `offsetWidth`/`offsetHeight`, not
  `clientWidth`/`getBoundingClientRect`. Both are hard 0 in jsdom, and `outerSize === 0`
  sets the range to `null` — **zero** rows mount, overscan does not rescue it.
- `ResizeObserver` does not exist at all; `tests/setup.ts` stubs it no-op.

The same zero-size window occurs in production: routes stay mounted inside a
`display:none` wrapper until first visited, so a grid's scroll element really does measure
0×0 until the route becomes visible.

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