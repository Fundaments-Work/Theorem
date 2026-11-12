# RSS Feeds

## Why Custom Feed Parsing

On desktop and Android, RSS/Atom parsing and web article readability run natively in Rust (`src-tauri/src/rss_parser.rs` via `parse_rss_feed_native` and `src-tauri/src/article_extractor.rs` via `fetch_and_extract_article_native` / `extract_article_from_html_native`). Browser/web builds keep lightweight fallbacks (`fast-xml-parser` + JSON Feed in `RssService.ts`, and `DOMParser` `<article>`/`<main>`/`<body>` extraction + `DOMPurify` sanitization in `ArticleExtractorService.ts`).

## Architecture

```
FeedsPage
  │
  ├─ Feed list (left panel, virtualized)
  │    ├─ Add feed dialog
  │    └─ Feed actions (refresh, delete)
  │
  └─ Article list (right panel)
       ├─ Paginated list (virtualized)
       └─ Open in Reader → synthetic EPUB → Reader.tsx (synthetic book ID: rss:<articleId>)

Data flow:
  addFeed(url)
    │
    ▼
  RssService.fetchAndParseFeed(url)
    ├─ Primary (Tauri): fetch_rss_feed + parse_rss_feed_native in Rust
    └─ Fallback (web): browser fetch + JSON Feed / fast-xml-parser
    │
    ├─ Parse feed XML/JSON → RssFeed + RssArticle[]
    ├─ materializeFeed(url, parsed)
    └─ Store in rssStore (persisted)

  On article open (lazy):
    ├─ fetchFullArticle → ArticleExtractorService
    │   ├─ Tauri: fetch_and_extract_article_native / extract_article_from_html_native
    │   └─ Browser fallback: DOMParser + DOMPurify
    └─ Store fullContent in rssStore
```

## RSS Service (`RssService.ts`)

The service handles:

- **Feed resolution**: Given a URL, determines if it's already a feed or an HTML page with auto-discovery links. If the latter, fetches the HTML and looks for `<link type="application/rss+xml">` or `<link type="application/atom+xml">` in the `<head>`.
- **Parsing**: Detects format (RSS 2.0, Atom, RDF, JSON Feed) and parses accordingly.
- **Content extraction**: For each article, tries to extract full content by fetching the article URL and running Readability. Falls back to the feed's summary if extraction fails.
- **Rate limiting**: A token bucket rate limiter (2 requests/second) prevents hammering servers.
- **Error reporting**: Descriptive error messages for CORS, timeouts, invalid XML, and HTTP errors.

## Content Extraction & Readability Engine

Theorem uses a high-performance native extraction pipeline:

1. **Native Rust Extractor (`article_extractor.rs` + `fetch_and_extract_article_native`)**:
   - Fetches web articles with a single desktop User-Agent and a 6-second connection timeout.
   - Parses OpenGraph and Twitter Card metadata (lead images, authors, titles).
   - Strips ads, tracking pixels, scripts, cookie banners, and CSS styles in native code.
   - Normalizes relative image and hyperlink URLs to absolute URLs against the origin domain.
   - Returns clean, sanitized article HTML directly over IPC with zero webview memory bloat.

2. **Browser Fallback (`ArticleExtractorService.ts`)**:
   - In browser environments without Tauri, extracts `<article>` / `<main>` / `[role="main"]` / `<body>` using `DOMParser` + `DOMPurify` (resolving relative URLs against `url-safety.ts` allowlists).
   - Stores extracted clean content in `RssArticle.fullContent` for instant offline reading.

## Article Reader

Opened articles are converted to a synthetic EPUB (`convertArticleToEpubBlob`) and rendered through the standard foliate engine in `Reader.tsx`, not a separate HTML reader:

- **Synthetic book ID**: `rss:<articleId>` — allows annotations to use the same data model
- **Per-article annotations**: Highlights and notes work the same way as in books

## Store Constraints

The `rssStore` (Zustand, version 1, persisted) indexes feeds/articles by ID for $\mathcal{O}(1)$ lookups and enforces:
- **Articles**: Maximum 500 articles per pruning pass (`ARTICLE_RETENTION_DAYS` configurable in Settings: Keep Forever, 15, 30, 60, or 90 days; default 30 days). Unread articles (when **Keep Unread Articles** is enabled), favorites, and offline-saved (`isSaved`) articles are protected.
- **Content size**: Maximum 50KB per article body. Longer content is truncated.

These caps prevent the store from growing unbounded and degrading sync performance.
