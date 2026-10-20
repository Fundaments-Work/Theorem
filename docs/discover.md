# Discover & OPDS Catalogs

## Overview

**Discover** (`src/features/catalogs/CatalogsPage.tsx`) is one page with a row of *sources*: the
curated public-domain storefront, the two built-in catalogs (Project Gutenberg, Standard Ebooks)
and every catalog the user adds. Choosing a source opens it in place. It works on desktop, phones
(it is a bottom-bar tab) and the web build.

```
┌────────────────────────────────────────────────────────────────┐
│ [Discover] [Project Gutenberg] [Standard Ebooks] [My Calibre 🔒] │ [+ Add]  ← sources
├────────────────────────────────────────────────────────────────┤
│  Discover home (DiscoverPage)   or   OpdsBrowser (one catalog)   │
│                                                                  │
│  ← Title            trail: Catalog › Newest › Search: dune   ⟳ ⋯ │
│  [ search ]  [Format ▾] [Catalog order ▾] [English] [EPUB] [Clear]│
│  section rows · shelves with "See all" · virtualized book grid    │
└────────────────────────────────────────────────────────────────┘
```

Why a row of sources and not a separate "Catalogs" page: a catalog is where you look for books, and
so is the storefront. Sources the user added used to be saved but never shown (the full browser was
unmounted); now the row is the single entry point.

## Layers

```
 UI            CatalogsPage → DiscoverPage | OpdsBrowser (useOpdsBrowser)
               CatalogBookCard · OpdsEntrySheet · AddCatalogModal · OpdsAuthPanel
 TS service    OpdsService      load / search / probe / loadDetail / download, typed OpdsError,
                                5-minute feed cache, URL normalisation
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

`opdsStore` (version 3): `catalogs` and `activeCatalogId` (`null` = the Discover home). The built-in
catalogs are always present and cannot be removed. Migration from version 2 keeps every
user-added catalog and starts on Discover.

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
- **Caching.** Feeds are cached 5 minutes in memory (cleared by Refresh); Discover's curated
  sections are cached for 24 hours and shown instantly when offline.

## Testing

| What | Where |
|------|-------|
| Parser on real Gutenberg, Standard Ebooks and OPDS 2.0 reference documents; Calibre, Komga/Kavita, Feedbooks-style, DRM, hostile and truncated input | `cargo test -p theorem-core opds` (fixtures in `src-tauri/crates/theorem-core/tests/fixtures/opds/`) |
| Network layer against a local mock server (auth, redirects, discovery loops, size caps, status mapping) | `cargo test --lib opds_net` |
| The same against live catalogs | `cargo test --lib live_ -- --ignored` |
| Web path with real documents through the WebAssembly parser | `tests/opds-service.test.ts` |
| Browser behaviour: trail, paging, search, filters, virtualization, sign-in | `tests/opds-browser.test.tsx`, `opds-pagination`, `opds-search`, `opds-catalog-facets-ui`, `opds-virtualization` |
| Book sheet, add-catalog dialog, source row, store migration, Gutenberg adapter | `tests/opds-entry-sheet`, `opds-add-catalog`, `catalogs-page`, `opds.test.ts`, `opds-quirks` |
