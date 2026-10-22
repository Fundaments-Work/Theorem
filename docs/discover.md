# Discover & OPDS Catalogs

## Overview

**Discover** (`src/features/catalogs/CatalogsPage.tsx`) is a front page for free books, plus the
catalogs the reader adds. It works on desktop, phones (it is a bottom-bar tab) and the web build.

```
 no catalogs added                         catalogs added
┌──────────────────────────────────┐      ┌──────────────────────────────────────────┐
│ Discover                 ⟳  + Add │      │ [◎ Discover] [Patan Library] [Calibre 🔒] [+]│ ← tabs
│ [ Search free books…            ] │      ├──────────────────────────────────────────┤
│ recent: (tolstoy ×) (poetry ×)    │      │ Discover home, or the selected catalog   │
│ ┌ hero ─────────┐ ┌ hero ───────┐ │      │ in OpdsBrowser                           │
│ └───────────────┘ └─────────────┘ │      └──────────────────────────────────────────┘
│ shelves (carousels, See all)      │
│ Browse by subject  [Novels 24k]…  │
│ Bring your library   [Add a catalog]
└──────────────────────────────────┘
```

- **The home is Fundaments' own catalog**, laid out by `DiscoverHome.tsx`. It is the page itself,
  never a tab and never named in the UI (the trail says "Discover").
- **Tabs exist only for catalogs the reader adds** (a school, a university, their own Calibre):
  `Discover` + those catalogs + Add. With none added there is no tab row, and Add sits in the
  home's header and in the "Bring your library" card.
- **Drilling down is the regular browser.** `OpdsBrowser` takes a `renderHome` prop: at the
  catalog's root it renders `DiscoverHome`; shelves (*See all*), subjects and search results are
  the normal browser with trail, Back, grid, filters and downloads.

## The Discover home

`DiscoverHome` turns the server's OPDS 2.0 home feed into a front page:

| Feed | Shown as |
|---|---|
| `metadata.subtitle` | Line under the "Discover" title |
| search template | Large search box (`Search free books…`); submitting runs the catalog search |
| first group with books | Its first two books as **hero cards** (large cover beside the text on a tonal step, no image behind text, summary as plain text, Add to Library / About), the rest as a "More new editions" carousel |
| other groups with books | Carousels with *See all* |
| first group with only navigation | **Browse by subject** tiles (title + compact count, e.g. "24k books"), *All subjects* opens the full list |

- **Recent searches** are kept on this device only (`localStorage`,
  `theorem-discover-recent-searches`, newest first, case-insensitive duplicates removed, at most
  8). Chips run a search again or can be removed one by one; *Clear all* empties the list. Missing
  or corrupt storage just means no chips.
- **Design:** the Fundaments design system (dark base, one lime accent, square corners, DM Sans
  300/400; hierarchy from size). Hover on tiles and hero cards is a lime edge, never a fill.
- **Covers** in hero cards are
  `TheoremBookCover`, so a missing or unsafe image gets the drawn fallback.

## The built-in catalog

Until 1.6.0 Discover opened on a storefront assembled *inside the app* (`DiscoverPage` and
`DiscoverService` fetched Gutenberg and Standard Ebooks feeds and built the shelves), next to two
built-in catalogs, Project Gutenberg and Standard Ebooks. In 1.6.0 all of that became one built-in
source: **Fundaments' own OPDS 2.0 catalog**, whose home file the app loads directly at
`https://catalog.fundaments.work/opds/index.json` (`/opds` redirects there for people and other
readers, but a static redirect carries no CORS header, so browsers must skip it)
(`DEFAULT_OPDS_PRESETS` in `OpdsService.ts`), shown as the Discover home.

- **Curated on the server.** Shelves, the spotlight, search and categories are decided by the
  private `fundaments-catalog` service (a Cloudflare Worker reading D1 and KV, refreshed by a sync
  job). Changing them needs no app release, and later the same address carries the free eLibrary,
  sign-in and a store section (store links never appear in the free shelves).
- **Its home has its own layout** (`DiscoverHome`, above); everything below the home is the normal
  catalog browser, so shelves, subjects and search behave exactly as in any catalog.
- **Content.** Today it serves curated Project Gutenberg books (from Gutenberg's public catalog
  data, with full-text search over all ~78,000 texts and 72 categories) and Standard Ebooks' new
  releases. Book files and covers still download straight from gutenberg.org and
  standardebooks.org.
- **Gutenberg and Standard Ebooks themselves** are no longer in the app at all: their books reach
  readers through the home. Anyone can still add either by address, like any catalog. On upgrade
  the old built-in tabs are removed, except one the reader had signed in to (see Persistence).
- **Offline copy.** The last good home feed of a built-in catalog is kept in `localStorage`
  (`theorem-opds-offline:<url>`) and shown when the server cannot be reached (network, timeout,
  HTTP error, rate limit). Only built-in catalogs, never with credentials: a private catalog's
  data is never written to storage. A corrupt or non-feed copy is ignored.
- **The server must be live before a release that points at it.** Its contract (paths, link
  meanings) only grows; see the service's `AGENTS.md`.

## Layers

```
 UI            CatalogsPage → OpdsBrowser (useOpdsBrowser), renderHome → DiscoverHome
               CatalogBookCard · DiscoverCarousel · OpdsEntrySheet · AddCatalogModal · OpdsAuthPanel
 TS service    OpdsService      load / search / probe / loadDetail / download, typed OpdsError,
                                5-minute feed cache, offline copy of built-in catalogs,
                                URL normalisation, the built-in preset
               opds-quirks      per-catalog adapters (Gutenberg) + edition merging
 Transport     desktop/mobile:  Tauri commands in src-tauri/src/opds_net.rs
               web:             fetch() + the same Rust parser compiled to WebAssembly
 Parsing       theorem-core::opds   (pure Rust, no I/O, shared by every runtime)
```

**One parser.** `src-tauri/crates/theorem-core/src/opds/` parses every document. The desktop and
mobile apps call it natively; the web build calls it through `wasm_opds_parse`. Both produce the
same JSON (`Outcome`), which `src/core/types/opds.ts` mirrors field for field, so the UI never
maps between shapes and never knows which dialect it is browsing.

### What the parser understands

| Format | Notes |
|--------|-------|
| Atom / OPDS 1.0 – 1.2 | Navigation vs acquisition entries, `subsection`/`related` links, `xml:base`, facets (`opds:facetGroup`, `opds:activeFacet`, `thr:count`), sort links (`…/sort/new`, `…/popular`), `opensearch:*` totals, `media:thumbnail` covers, Calibre `calibre:series`, stanza cover rels |
| OPDS 2.0 (JSON) | `metadata`, `navigation`, `publications`, `groups` (shelves), `facets`, templated search (`{?query}`), localised titles, author/subject/series in every legal shape, `images` (smallest = thumbnail) |
| OpenSearch description | Picks the OPDS/Atom `Url` template, ignores HTML and suggestion URLs |
| HTML page | Follows an advertised `<link rel="alternate" type="…opds…">` (up to 3 hops, loops stop) |
| OPDS Authentication Document | Recognised on a 401 so the sign-in panel can use the server's own wording |
| Acquisition detail | `opds:price`, nested `opds:indirectAcquisition`, acquisition kinds (open-access, borrow, buy, sample, subscribe), DRM media types (Adobe ADEPT, Readium LCP, …) |

Each entry gets `acquisitions[]` with `format` (`epub`, `pdf`, `cbz`, `cbr`, `mobi`, `fb2`),
`downloadable` (a direct, DRM-free, importable file) and `drm`, plus a ranked `primary` index: EPUB
before PDF before comics before MOBI, open-access before generic, never a sample, the illustrated
edition over "no images", plain EPUB over Kobo/"advanced" variants. Only a `primary` gives a
one-tap "Get"; purchases, loans, subscriptions and DRM files are shown for what they are.

Relative links are resolved against the **final** URL after redirects, not the one requested.

### What it does not do (yet)

- Authentication beyond HTTP Basic: OAuth/SAML flows from an Authentication Document are reported
  as unsupported rather than guessed at.
- DRM (Adobe ADEPT, Readium LCP) and loan/purchase flows. They are detected and explained; the
  catalog's website is offered when it has one.
- Following OPDS 2.0 `self`-linked publication documents for partial publications (OPDS 1 partial
  entries *are* followed through `detailHref`).

## Network (`opds_net.rs`)

| Command | Purpose |
|---------|---------|
| `opds_load(url, auth)` | Negotiated GET → parse → follow HTML discovery. Returns `{ finalUrl, outcome }` |
| `opds_search(searchRef, query, auth)` | Resolves an OpenSearch description if needed, expands the template, loads the results |
| `opds_download(id, url, auth)` | Streams a book to a temp file, emits `opds-download-progress`, returns `{ path, filename, mime, size }` |
| `opds_cleanup_download(path)` | Deletes a finished download's temp folder (refuses paths outside it) |

- `Accept: application/opds+json, application/atom+xml;profile=opds-catalog, …`
- Only `http`/`https`; 25 MB cap on catalog documents, 1 GB on books; 30 s catalog timeout.
- Errors are a typed enum (`authRequired` with realm and any authentication document, `forbidden`,
  `notFound`, `rateLimited` with `Retry-After`, `http`, `timeout`, `tooLarge`, `invalidUrl`,
  `network`, `unsupported`, `io`), serialised as `{ kind, … }` and rebuilt into `OpdsError`.
- Downloads reject a web page that answers 200 OK where a book should be (a login, loan or
  purchase page), by content type and by sniffing the first bytes; the web build has the same
  guard (`looksLikeHtml`).
- Filenames come from `Content-Disposition` (RFC 5987 first) or the URL, sanitised, with an
  extension the importer recognises.

The CLI (`theorem opds browse|download`) uses the same loader; it does not sign in yet.

## Web build

The browser has no native fetch, so `OpdsService` does `fetch()` itself and hands the bytes to
`wasm_opds_parse`. Gutenberg goes through the same-origin `/api/gutenberg` Pages Function
(`browserCatalogUrl`) because its downloads send no CORS headers. A catalog that does not allow
cross-origin reads is reported as `cors` with a message that points to the desktop/mobile app;
nothing is proxied through a third party.

Regenerate the WebAssembly glue after changing the parser:

```bash
cargo build -p theorem-core --target wasm32-unknown-unknown --release   # from src-tauri/
wasm-bindgen --target web --out-dir ../src/core/wasm --out-name theorem_core \
  target/wasm32-unknown-unknown/release/theorem_core.wasm
```

(`wasm-bindgen-cli` must match the `wasm-bindgen` version in `Cargo.lock`.)

## Browsing behaviour

State lives in `useOpdsBrowser`, one instance per catalog (keyed by id):

- **Trail and Back.** Opening a section pushes a step; Back and the trail pop. Facet changes
  replace the current step. Where you were in each catalog is remembered for the session.
- **Pages append.** `next` links are followed as you scroll (or with *Load more*); a page turn is
  not navigation. A `next` that points back at a page already fetched, or a page that adds
  nothing new, ends the list instead of looping.
- **Race safety.** Every load carries a request id; a slow answer for a step you have left is
  dropped.
- **Search.** The catalog's own search runs on submit (OpenSearch and OPDS 2.0 templates). If the
  catalog has none, or its search fails, the loaded list is filtered locally with the shared fuzzy
  matcher (`rankByFuzzyQuery`). Searching from search results replaces them.
- **Filters.** Server facets (OPDS facet groups) are followed as links. Sorting, language and
  format act on the books already loaded; the default *Catalog order* leaves the server's ranking
  alone.
- **A list that is a single book** (the page a book row leads to) opens that book directly.

### Catalog adapters (`opds-quirks.ts`)

Public catalogs that bend the spec are corrected in one place. Project Gutenberg lists each book
in search results as a "subsection" link, indistinguishable from a category except by its address;
the adapter turns those into partial books (real cover addresses, downloads resolved on open) and
`mergeEditions` presents Gutenberg's separate "images"/"no images" entries as one book.

## Sign-in and security

- HTTP Basic only. The sign-in panel uses the server's own labels and realm.
- Credentials live on the catalog record in the local store (`theorem-opds`), **never synced**, and
  are saved only after the server accepts them, so a mistyped password cannot replace a working one.
  *Forget sign-in* is in the catalog's ⋯ menu.
- Catalog HTML (summaries) is passed through DOMPurify before it is rendered; covers go through
  `isSafeImageUrl`.
- The address is checked when a catalog is added (`AddCatalogModal` calls `OpdsService.probe`): a
  typo, a web page, or a non-OPDS server is explained instead of becoming a source that never loads.
  `opds://`, `host:port`, bare hostnames and stray whitespace are accepted; LAN addresses default to
  `http`.

## Persistence

`opdsStore` (version 5): `catalogs` and `activeCatalogId` (`null` = the built-in catalog). The
built-in catalog is always present, always first and cannot be removed; a remembered catalog that
no longer exists falls back to it.

- **v3 → v4 (and v4 → v5):** Project Gutenberg and Standard Ebooks stop being presets and are removed: they were
  the app's defaults, not the reader's choice. One the reader signed in to (a Standard Ebooks
  patron) stays as an ordinary catalog with its sign-in. The open catalog is kept if it still
  exists; the retired storefront caches (`theorem_discover_cache*`) are deleted. v5 repeats this for stores that an early 1.6.0 development build had
  migrated to v4 by keeping the two as ordinary tabs.
- **Older versions** keep every user-added catalog; malformed entries are dropped.

## Ingestion

```
CatalogBookCard / OpdsEntrySheet ("Add to Library")
  │  useCatalogDownload  (toast with progress, success action "Open Library")
  ▼
OpdsService.loadDetail (partial entries) → OpdsService.download(acquisition)
  │  desktop/mobile: opds_download → importBooksIncremental([path]) → addBook
  │  web:            fetch → HTML guard → File → importBooksFromFilesIncremental → addBook
  ▼
Library  (same import pipeline as "Add Books": metadata, cover extraction, duplicates)
```

## Covers, virtualization, offline

- **Fallback cover.** `TheoremBookCover` draws a deterministic clothbound cover when an entry has
  no image, the image fails to load, or its scheme is unsafe.
- **Virtualization.** `OpdsGrid` mounts only the rows near the viewport (`@tanstack/react-virtual`,
  fixed row height, `ResizeObserver` for the column count); 3,000 books cost the same DOM as 30.
- **Caching.** Feeds are cached 5 minutes in memory (cleared by Refresh). The built-in catalog's
  home feed is also kept on disk and shown when offline (see The built-in catalog).

## Testing

| What | Where |
|------|-------|
| Parser on real Gutenberg, Standard Ebooks and OPDS 2.0 reference documents; Calibre, Komga/Kavita, Feedbooks-style, DRM, hostile and truncated input | `cargo test -p theorem-core opds` (fixtures in `src-tauri/crates/theorem-core/tests/fixtures/opds/`) |
| Network layer against a local mock server (auth, redirects, discovery loops, size caps, status mapping) | `cargo test --lib opds_net` |
| The same against live catalogs | `cargo test --lib live_ -- --ignored` |
| Web path with real documents through the WebAssembly parser | `tests/opds-service.test.ts` |
| Browser behaviour: trail, paging, search, filters, virtualization, sign-in | `tests/opds-browser.test.tsx`, `opds-pagination`, `opds-search`, `opds-catalog-facets-ui`, `opds-virtualization` |
| Book sheet, add-catalog dialog, source row, store migration, Gutenberg adapter | `tests/opds-entry-sheet`, `opds-add-catalog`, `catalogs-page`, `opds.test.ts`, `opds-quirks` |
