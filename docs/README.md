# Theorem — Documentation

## Quick Start

```bash
git clone --recurse-submodules <repo>
pnpm install
pnpm dev          # web (limited — some features need Tauri)
pnpm dev:tauri    # desktop (full experience)
```

## User Guide

Task-oriented guides for readers (install, import, reading, highlights, Discover, sync, troubleshooting) live in [user/](user/index.md).

## Architecture

| Document | What it covers |
|----------|----------------|
| [context.md](../context.md) | Project context, stack choices, design rationale |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System architecture, data flow, module relationships |

## Features

| Document | Feature |
|----------|---------|
| [reader.md](reader.md) | EPUB/MOBI/PDF/CBR reading, Theorem Lens, search |
| [library.md](library.md) | Book import, organization, search, virtual scrolling |
| [folder-import.md](folder-import.md) | Importing folders & preserving source-folder structure |
| [bulk-selection.md](bulk-selection.md) | Bulk selection across filtered results, bulk actions & Undo |
| [smart-shelves.md](smart-shelves.md) | Rule-based smart shelves that auto-populate from native filters |
| [sub-shelves.md](sub-shelves.md) | One level of nested sub-shelves |
| [comic-scrolling.md](comic-scrolling.md) | Continuous vertical strip reading for CBZ/CBR |
| [cbr-android-fix.md](cbr-android-fix.md) | Native CBR/RAR→CBZ path on Android |
| [discover.md](discover.md) | Discover: public-domain storefront and a browser for any OPDS catalog (Atom/OPDS 1.x and OPDS 2.0), sign-in, downloads |
| [sync.md](sync.md) | P2P device sync via iroh |
| [annotations.md](annotations.md) | Highlights, notes, bookmarks |
| [vocabulary.md](vocabulary.md) | Dictionary lookups, StarDict + MDict |
| [feeds.md](feeds.md) | RSS/Atom feed subscriptions |
| [vault-sync.md](vault-sync.md) | Markdown export to Obsidian/Logseq |
| [settings.md](settings.md) | App configuration, storage management |
| [statistics.md](statistics.md) | Reading stats and goals |
| [tts.md](tts.md) | Text-to-speech: platform voices + Supertonic neural voice (immersion reading) |
| [audiobook.md](audiobook.md) | Companion audiobooks: attach .m4b/.mp3, in-reader player, Save-as-Audiobook |
| [persistence.md](persistence.md) | SQLite schema, Zustand stores, data lifecycle |

## Reference & Strategy

| Document | What it covers |
|----------|----------------|
| [COMPETITIVE_STRATEGY_BLUEPRINT.md](COMPETITIVE_STRATEGY_BLUEPRINT.md) | Master market & open-source competitive strategy |
| [epub-preparser.md](epub-preparser.md) | Rust EPUB ZIP pre-parser |
| [keyboard-shortcuts.md](keyboard-shortcuts.md) | All keyboard shortcuts |
| [accessibility.md](accessibility.md) | Accessibility and responsive-layout audit: findings, fixes and the rules that keep them |
| [onboarding.md](onboarding.md) | First-run flow |
| [android-build.md](android-build.md) | Android build, signing, and CI |
| [DISTRIBUTION.md](DISTRIBUTION.md) | Packaging and distribution |
| [SIGNING-KEYS.md](SIGNING-KEYS.md) | Updater and Android signing keys |
| [PKGBUILD](PKGBUILD) | Arch Linux PKGBUILD (unofficial) |

## Design Plans & Research

| Folder | What it covers |
|--------|----------------|
| [plans/](plans/) | Technical design plans & roadmaps (`plans/done/` holds shipped plans) |
| [plans/2026-08-30-plugin-extensibility-architecture.md](plans/2026-08-30-plugin-extensibility-architecture.md) | Plugin extensibility architecture (designed, not implemented) |
| [research/](research/) | Long-form research: Rust rewrite candidates, memory/SQLite tuning, announcements architecture |
