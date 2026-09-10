# RSS Feeds

## Why Custom Feed Parsing

The RSS system uses `fast-xml-parser` for XML parsing and custom logic for parsing RSS 2.0, Atom, RDF, and JSON Feed formats. There is no full-featured RSS library.

Why custom: RSS parsing is straightforward (it's just XML with a few field conventions), and the only complex part is content extraction from linked articles, which uses a separate pipeline (`fetch_and_extract_article_native` → `@mozilla/readability` browser fallback).

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
    ├─ Fast path: Tauri fetch (desktop) — bypasses CORS
    └─ Fallback: browser fetch (web) — may hit CORS issues
    │
    ├─ Parse feed XML/JSON → RssFeed + RssArticle[]
    ├─ materializeFeed(url, parsed)
    └─ Store in rssStore (persisted)

  On article open (lazy):
    ├─ fetchFullArticle → ArticleExtractorService
    │   ├─ fetch_and_extract_article_native (Tauri)
    │   └─ @mozilla/readability (browser fallback)
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
   - In browser environments, uses `fetch()` + `@mozilla/readability` + `DOMPurify`.
   - Stores extracted clean content in `RssArticle.fullContent` for instant offline reading.

## Article Reader

Opened articles are converted to a synthetic EPUB (`convertArticleToEpubBlob`) and rendered through the standard foliate engine in `Reader.tsx`, not a separate HTML reader:

- **Synthetic book ID**: `rss:<articleId>` — allows annotations to use the same data model
- **Per-article annotations**: Highlights and notes work the same way as in books

> `ArticleViewer.tsx`, `ArticleReaderContent.tsx`, and `ArticleReaderInfoPanel.tsx` exist but are currently unused.

## Store Constraints

The `rssStore` (Zustand, version 1, persisted) caps data for performance:
- **Articles**: Maximum 500. Oldest articles are pruned when new ones arrive.
- **Article age**: Maximum 30 days from publication. Older articles are dropped on refresh even if under the count cap.
- **Content size**: Maximum 50KB per article body. Longer content is truncated.

These caps prevent the store from growing unbounded and degrading sync performance.
