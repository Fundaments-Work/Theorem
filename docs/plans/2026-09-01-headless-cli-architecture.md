# Technical Design: Theorem Headless CLI & Local-First Universal Knowledge Base

**Date**: 2026-09-01  
**Status**: Proposal / Architecture Plan  
**Area**: Headless CLI / Linux Tooling / AI Agent Integration / Vault Export  

---

## 1. Executive Summary

Theorem contains high-performance Rust engines for EPUB/PDF reading, full-text in-book search, StarDict dictionary lookup, web article extraction, and SQLite library management. However, these engines currently execute exclusively through the GUI webview.

This blueprint defines **Theorem CLI (`theorem`)** — a native, zero-overhead command-line interface that turns Theorem into a **Universal Knowledge Base** accessible by terminal users, shell scripts, cron automation, and AI agents (Antigravity, Cursor, Claude Code, Aider) with **0 MB additional binary bloat**.

---

## 2. Architecture & Design

Theorem utilizes a high-performance native unified binary architecture:

1. **Multi-Call Binary (`src-tauri/src/main.rs`)**:
   - The single `theorem` executable inspects `std::env::args()` on startup.
   - If CLI subcommands are passed (e.g. `theorem search`, `theorem read`, `theorem dict`), it routes immediately to headless Rust dispatchers and exits in **< 2 ms** without initializing WebKit or GTK.
   - If invoked without arguments, it launches the standard GUI e-reader.

2. **Native Performance & Efficiency**:
   - Reuses the existing compiled engines (`stardict`, `book_search`, `epub_parser`, `mobi_parser`, `article_extractor`, `database`).
   - Binary footprint increase: **0 MB**.
   - Mobile APK is completely unaffected.

3. **1-Click Linux Setup in Settings**:
   - In Theorem Settings → Integrations / Developer, user clicks **"Enable CLI"**.
   - Rust command `setup_linux_cli_symlink` links `~/.local/bin/theorem -> /path/to/theorem`.
   - `theorem` is immediately on `$PATH` for all terminals and agent subprocesses without requiring `sudo`.

---

## 3. Command Surface

```bash
# 1. Search & In-Book Grep
theorem search "quantum gravity"               # Fast FTS5 + in-book grep across library
theorem search <book-id> "schrodinger"          # Streaming multi-threaded search in book

# 2. Reading & Passage Extraction
theorem read <book-id> --chapter <n>            # Stream chapter plain text to stdout
theorem read <book-id> --cfi "<cfi-string>"     # Read paragraph around exact CFI anchor

# 3. Highlights & Annotations
theorem highlights list [--book <id>]           # Output highlights and notes (JSON/Markdown)
theorem highlights add <book-id> --text "..."   # Add annotation or reading note

# 4. Instant StarDict Dictionary
theorem dict "epiphany"                         # 0.3ms native StarDict definition

# 5. Web Readability Cleaner
theorem extract "https://example.com/article"   # Extract clean article to Markdown

# 6. Library & Batch Ingestion
theorem library list [--format json]            # List library books, progress, and metadata
theorem library import <file-or-dir>            # Native parallel SIMD batch import

# 7. Vault & Data Export
theorem export vault --path ~/Obsidian/Reading  # Export per-book Markdown pages with YAML frontmatter
theorem export json --output ~/backup/data.json # Full JSON reading snapshot
```

---

## 4. Implementation Checklist

- [x] Add CLI argument parser in `src-tauri/src/cli.rs` (multi-call dispatch from `src-tauri/src/main.rs` via `theorem_lib::cli::maybe_dispatch`; unknown args fall through to the GUI).
- [x] Connect CLI commands directly to existing Rust backend modules:
  - `stardict::lookup_all_installed` (new CLI fast-path over `stardict::lookup_term`) — `theorem dict`
  - `book_search::search_epub_spine` — `theorem search <book-id> "query"`
  - `database::sqlite_search_books_inner` (FTS5) — `theorem search "query"`
  - `article_extractor::fetch_and_extract_article_native` — `theorem extract`
  - `database::with_connection` — `theorem library list`, `theorem highlights list`
  - EPUB spine text extraction via `epub_parser` inner helpers + OPF spine-order scan — `theorem read <book-id> [--chapter N]` (EPUB only; `--cfi` pending the epubcfi.rs roadmap item; MOBI read pending)
- [x] Implement `setup_linux_cli_symlink` Tauri command (also available headless as `theorem setup-cli`).
- [x] Add 1-click CLI enable toggle in Settings → Devices & Export ("Terminal CLI", Linux desktop only).
- [ ] `theorem export vault` / `theorem export json` (Vault export subsystem — not yet wired).
- [ ] `theorem library import` (batch ingestion needs a headless ingest entry point).
