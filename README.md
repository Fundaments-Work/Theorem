
<p align="center">
  <img src="./theorem.svg" alt="Theorem" width="128">
</p>

<h1 align="center">Theorem</h1>

<p align="center">
  <strong>Own your reading data. Forever.</strong>
</p>

<p align="center">
  <a href="https://app.theorem.fundaments.work"><img src="https://img.shields.io/badge/try%20the%20web%20demo-app.theorem.fundaments.work-8A2BE2?style=for-the-badge" alt="Web Demo"></a>
  <a href="https://github.com/fundaments-work/theorem/releases/latest"><img src="https://img.shields.io/github/v/release/fundaments-work/theorem?label=latest&style=flat-square" alt="Latest Release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
  <a href="https://github.com/fundaments-work/theorem/releases/latest"><img src="https://img.shields.io/badge/platform-linux%20%7C%20macos%20%7C%20windows%20%7C%20android-8A2BE2?style=flat-square" alt="Platform"></a>
  <a href="https://github.com/fundaments-work/theorem/actions"><img src="https://img.shields.io/github/actions/workflow/status/fundaments-work/theorem/ci.yml?branch=main&label=ci&style=flat-square" alt="CI"></a>
  <a href="./CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs Welcome"></a>
</p>

A **free, open-source, local-first** reading app that runs on **Linux, macOS, Windows, and Android** from a shared codebase. Read PDFs, EPUBs, MOBI, FB2, CBZ, CBR, and RSS feeds — all in one workspace. Highlight and annotate with six colors. Look up words with offline dictionaries. Listen with neural text-to-speech. Share highlights as beautiful images. Sync everything to Markdown files in your Obsidian or Logseq vault.

**No cloud account. No subscription wall. No vendor lock-in.**

---

## Quick Install

### Linux (one command)

```bash
curl -fsSL https://raw.githubusercontent.com/fundaments-work/Theorem/main/scripts/install-linux.sh | bash
```

### Manual Download

| Platform | Format |
|----------|--------|
| Linux | `.deb` or `.AppImage` |
| macOS (Intel) | `.dmg` |
| macOS (Apple Silicon) | `.dmg` |
| Windows | `.msi` or `.exe` |
| Android | `.apk` |

All builds on the [Releases page](https://github.com/fundaments-work/theorem/releases/latest). Website and docs at [theorem.fundaments.work](https://theorem.fundaments.work). Try the [web demo](https://app.theorem.fundaments.work) without installing.

---

## Quick Start (Development)

```bash
git clone --recurse-submodules https://github.com/fundaments-work/theorem.git
cd theorem
pnpm install

pnpm dev          # Web dev server (http://localhost:1420)
pnpm dev:tauri    # Desktop app in dev mode
```

**Prerequisites**: Node.js 22+, pnpm 10+, Rust (via [rustup](https://rustup.rs)), and [Tauri system deps](https://tauri.app/start/prerequisites/).

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start Vite dev server |
| `pnpm dev:tauri` | Start Tauri desktop app |
| `pnpm build` | Typecheck + production build |
| `pnpm typecheck` | TypeScript type checking |
| `pnpm test` | Run Vitest unit tests |
| `pnpm package:linux` | Build Linux release package |

See [AGENTS.md](./AGENTS.md) for the full repository map, conventions, and architecture.

---

## Features

### Multi-Format Reader & Instant Opening
EPUB, MOBI, AZW, AZW3, FB2, CBZ, CBR, PDF, TXT, and RSS articles. Native Rust pre-parser pre-inflates stylesheets and initial spine chapters in parallel threads, delivering **instant book opening (< 50ms)** even on 100MB+ titles. Multi-threaded streaming in-book search crawls 1,000+ page books in ~10–30ms with zero UI lag. Foliate-based reflowable rendering with paged and scroll modes. PDF.js engine with zoom (50–200%), page-fit/width-fit modes, and outline navigation. **Theorem Lens** (in-place footnote, citation, and figure peek portals without losing your reading place). Full table of contents with section progress. Estimated reading time per page and chapter. Reading progress saved per-book across sessions (page-accurate + CFI). File association — open ebooks directly from your file manager.

<p align="center">
  <img src="./Screenshots/reader_screen.png" alt="Theorem reader with highlights and annotations in dark theme" width="700">
</p>

### Discover & OPDS Catalogs
Browse curated storefronts and search over 75,000+ public domain classics from Project Gutenberg and Standard Ebooks with 1-click EPUB downloads. Connect custom OPDS 1.2 feeds from your personal Calibre, Kavita, or Komga server. Clean, deterministic clothbound covers for books without bundled artwork.

### Reading Customization
Three reader themes: Light, Sepia, Dark. Font family (original, serif, sans-serif, monospace). Font size (12–36), line height (1.0–2.5), margins (0–35%). Letter spacing, word spacing, paragraph spacing. Text alignment, hyphenation toggle. Page animation styles (slide, fade, instant). Page layout (single, double, auto). Reading flow (paged, scroll, auto). Brightness slider. Zoom for fixed-layout formats. Full-screen mode. Auto-hide toolbar with configurable delay. Prefetch distance, animations toggle, virtual scrolling. Per-word highlighting during TTS immersion reading.

### Highlights & Annotations
Six color-coded highlight colors: yellow, green, blue, red, orange, purple. Notes on any highlight. Bookmarks. Overlayer drawing styles: highlight, underline, strikethrough, squiggly, outline. Annotation panel with quick navigation, editing, and deletion. Works across all formats including PDF and RSS articles.

<p align="center">
  <img src="./Screenshots/highlights_page.png" alt="Annotation panel with color-coded highlights" width="700">
</p>

### PDF Annotations
Freehand drawing with configurable stroke width. Text notes placed anywhere on the page. Multi-line rectangular highlights. Per-page annotation rendering. PDF view state persistence (page, zoom, mode per-session).

### Highlight Sharing
Generate polished share-card images from any highlight. Multiple formats: Square (1080×1080) and Story (1080×1920). Multiple visual themes: match, dark, tinted, sepia. Download as PNG, copy to clipboard, native share via Web Share API, share to X (Twitter). Android: saves to MediaStore gallery.

### Text-to-Speech (Immersion Reading)
Uses your platform's native TTS engine — no external models or cloud APIs. Android: Android TextToSpeech. Linux: speech-dispatcher (spd-say). macOS: `say`. Windows: PowerShell System.Speech. Per-word highlighting synchronized with audio. Voice selection depends on system-installed voices.

### Vocabulary Builder & Native StarDict Engine
Look up words while reading with instant sub-millisecond definitions. Native memory-mapped (`memmap2`) StarDict engine queries 800,000+ word dictionaries in **< 1ms** directly from disk with DictZip auto-inflation and part-of-speech structuring. Download English Wiktionary with 1-click from settings or import custom `.ifo`/`.idx`/`.dict.dz` files. Online API fallback with audio pronunciations. Dedicated vocabulary capture and review workspace.

### RSS Reader & Native Web Extractor
Subscribe to feeds with full annotation tools. Native Rust article fetcher and readability cleaner extracts clean text, OpenGraph metadata, and images while stripping ads, scripts, and clutter with zero IPC bloat. Feed discovery from web pages. Offline article storage with caching. Per-feed unread count. Favoriting.

<p align="center">
  <img src="./Screenshots/rss_page.png" alt="RSS feed reader with article list" width="700">
</p>

### Markdown Export (Obsidian / Logseq)
Export highlights and annotations to local Markdown files. Designed for vault-based PKM workflows. Per-book Markdown pages with YAML frontmatter. Vocabulary export with definitions and phonetics. Customizable file naming. One-click export.

### Library Management & Parallel Batch Ingestion
Multi-threaded Rust batch ingestion pipeline (`rayon` + `quick-xml` + `image` SIMD) imports hundreds of books in seconds with hardware-accelerated SHA-256 deduplication and native cover extraction. Custom collections / shelves. Favorites toggle with dedicated section. Book ratings (1–5 stars). Tags and categories. Multiple view modes: grid, list, compact. Sort by title, author, date added, last read, progress, rating. Library search by title, author, or tags.

<p align="center">
  <img src="./Screenshots/shelves_page.png" alt="Library with custom shelves" width="700">
</p>

### Reading Statistics
Reading time tracking (total and per-book). Books finished. Reading streaks: current + longest. Reading speed: average WPM. Daily activity log with 12-week heatmap. Reading goals: daily minutes and yearly books. Achievement badges. Book completion tracking.

### LAN Device Sync
Encrypted peer-to-peer sync between Theorem installs on local network. Syncs books, reading progress, annotations, collections, settings, and vocabulary. QR-based device pairing. Device identity management with public-key encryption. Auto-sync on peer discovery. Periodic background sync. No cloud relay — fully local and private.

### Backup & Data Management
Full backup bundle export: books (with binary data), annotations, collections, settings, statistics, vocabulary, dictionaries, RSS feeds. Storage usage breakdown. Cache size configuration.

<p align="center">
  <img src="./Screenshots/settings_page.png" alt="Settings and data management" width="700">
</p>

### Cross-Platform
Desktop: Linux (.deb, .AppImage), macOS Intel + Apple Silicon (.dmg), Windows (.msi, .exe). Mobile: Android (.apk). Web: browser fallback for development. All from a single TypeScript + Rust codebase.

<p align="center">
  <img src="./Screenshots/phone-screens.png" alt="Theorem mobile" width="700">
</p>

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, TypeScript, Vite 8 |
| State | Zustand 5 (persisted + versioned migrations) |
| Styling | Tailwind CSS v4, CSS design tokens |
| Desktop | Tauri 2 (Rust) |
| Mobile | Tauri 2 Android |
| PDF | PDF.js 6 |
| Ebook | Foliate.js (vendored) |
| TTS | Platform native (Android TTS, spd-say, say, System.Speech) |
| Dictionary | StarDict |
| RSS | Mozilla Readability |
| Archive | zip.js, unrar-ng (Rust, bundled C source) |
| Testing | Vitest + jsdom |

---

## Why Theorem?

Built for **knowledge workers** who want to own their reading data:

- **Your data stays local** — everything on your device. No cloud, no tracking, no data mining.
- **Portable by design** — exports are plain Markdown files. Move to any tool anytime.
- **True offline-first** — works completely without internet. Sync when you choose.
- **No subscriptions** — free and open-source. Always.

### Is Theorem a Readwise alternative?

Yes. Local-first reading, annotation, and Markdown export without a paid subscription. Plus: ebook reader, RSS reader, vocabulary builder, neural TTS, LAN sync, and highlight sharing — all in one app.

---

## FAQ

**Is my data safe?** — Yes. Everything is stored locally. No cloud account required.

**Can I migrate away?** — Yes. Exports are plain Markdown files, portable to any tool.

**Does it work with Obsidian and Logseq?** — Yes. Markdown sync is designed for vault-based workflows.

**Is there device sync?** — Yes. Encrypted LAN pairing between Theorem installs, no cloud relay.

**Does TTS work offline?** — Yes. It uses your system's built-in TTS engine. No downloads needed.

**What formats are supported?** — EPUB, MOBI, AZW, AZW3, FB2, FBZ, CBZ, CBR, PDF, TXT, and RSS feeds.

**Can I try it without installing?** — Yes. The [web demo](https://app.theorem.fundaments.work) runs in your browser.

**Why MIT instead of AGPL?** — MIT lets anyone use, modify, and integrate the code without forcing them to open-source their changes. For a local-first reading app that stores all data as plain Markdown, the protection AGPL offers is unnecessary — your data is already portable.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines, code conventions, and the pull request process.

---

## License

MIT License — see [LICENSE](./LICENSE) for details.
