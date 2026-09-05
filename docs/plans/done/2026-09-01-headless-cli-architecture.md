# Technical Design: Theorem Headless CLI & Local-First Universal Knowledge Base

**Date**: 2026-09-01  
**Status**: ✅ Implemented — `src-tauri/src/cli.rs` + `cli_tui.rs` (see commit history; Settings → General → CLI Setup)  
**Area**: Headless CLI / Linux Tooling / AI Agent Integration / Vault Export  

---

## 1. Executive Summary

Theorem contains high-performance Rust engines for EPUB/PDF reading, full-text in-book search, StarDict dictionary lookup, web article extraction, and SQLite library management. These engines previously executed exclusively through the GUI webview; the CLI now exposes them natively (implemented as described below — commands, flags and JSON output match the parity matrix in §6).

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

## 4. Agent Contract (how scripts and AI agents use the CLI)

- **One-shot commands only** — the interactive TUI is human sugar; every
  capability is also a deterministic subcommand.
- **`--json` (global)** — machine-readable output on stdout for every command,
  including flag-first invocations (`theorem --json library list`).
- **TTY detection** — ANSI colors auto-disable when stdout is piped; `--no-color`
  forces it.
- **Stable exit codes** — `0` ok, `1` runtime error, `2` usage error; failures
  print `error: …` on stderr and nothing on stdout.
- **Fail fast, never hang** — sync commands are timeout-bounded; nothing
  prompts on stdin.

## 5. Command Surface (implemented)

```
theorem search "query"                      # FTS5 library search
theorem search <book-id> "query"            # in-book streaming search
theorem read <book-id> [--chapter N]        # EPUB spine text / PalmDOC MOBI text
theorem dict "term" [--online]              # StarDict + MDict (.mdx), optional Free Dictionary API
theorem extract <url>                       # clean article text (readability)
theorem library list|info|add|import|remove|favorite|export|edit-meta
theorem shelf list|create|delete|add|remove
theorem highlights list|add|delete          # tombstoned, GUI-consistent
theorem bookmarks list
theorem feeds list|add|remove|refresh       # RSS 2.0 / Atom, merges into the GUI store
theorem opds browse|download                # OPDS 1.2; download ingests into the library
theorem sync status|pair|unpair|now         # headless iroh pairing + sync rounds (timeout-bounded)
theorem storage stats|cleanup
theorem stats                               # reading streaks / goals snapshot
theorem export [--out PATH]                 # full JSON snapshot
theorem open <book-id>                      # bridge to the GUI (rendering, TTS, page-flip reading)
theorem tui                                 # interactive terminal UI (see §6)
theorem setup-cli | help | version
```

## 6. Interactive TUI (`theorem tui`)

ratatui + crossterm (desktop-gated). Library table with fuzzy filter `/`,
`enter` opens a read-only plain-text reader (EPUB spine chapters, PalmDOC
MOBI) with `[`/`]` chapter navigation, `o` bridges to the GUI via
`--open-book`. The ASCII THEOREM logo heads the app and `help` output.
The TUI never writes reading progress.

## 7. Settings integration

Settings → Devices & Export → Terminal CLI (Linux desktop):
- Persisted `cli.enabled` flag (settingsStore v11 migration).
- Toggle ON/OFF installs/removes the `~/.local/bin/theorem` symlink via
  `setup_linux_cli_symlink` / `remove_linux_cli_symlink`.
- `cli_setup_status` surfaces live symlink validity + AppImage mode.
- Startup auto-heal: when enabled and the symlink is missing (fresh
  AppImage mount, new install), the GUI recreates it silently.

## 8. Parity matrix

| GUI capability | CLI | Notes |
| :--- | :--- | :--- |
| Library mgmt, ingest, metadata, export | `library`/`shelf` | full parity |
| Search (library + in-book) | `search` | full parity |
| Text reading (EPUB/MOBI) | `read`, `tui` | plain text; no pagination state |
| PDF/CBZ rendering, page-flip UI | `open` (bridge) | webview-bound by nature |
| Dictionaries | `dict` | StarDict + MDX + online |
| Annotations / bookmarks | `highlights`/`bookmarks` | CRUD + tombstones |
| RSS feeds | `feeds` | fetch/refresh/merge |
| OPDS catalogs | `opds` | browse/download/ingest |
| Device sync | `sync` | pairing by code, sync rounds |
| TTS / immersion audio | `open` (bridge) | platform TTS is desktop shell — GUI-only UX |
| Vault markdown export | — (GUI-only) | agents use `theorem export`; Rust duplication not warranted |
| Statistics dashboards | `stats` | snapshot data |

## 9. Implementation Checklist

- [x] clap 4 derive parser (`maybe_dispatch` fall-through keeps GUI file-open paths working).
- [x] THEOREM logo, TTY-aware colors, global `--json`, consistent exit codes.
- [x] Library management incl. native parallel ingest (`batch_ingest`) and EPUB metadata rewrite.
- [x] Shelves/collections on the GUI's `zustand:theorem-library` kv row with deletion tombstones.
- [x] Highlights add/delete, bookmarks, RSS feeds, OPDS browse/download.
- [x] Unified dictionary lookup: StarDict + MDict + `--online`.
- [x] Headless sync (`init_sync` state in the CLI app context, iroh on demand).
- [x] Storage stats/cleanup, reading stats, full JSON snapshot export.
- [x] `theorem open` GUI bridge (`--open-book=` in startup args + single-instance callback).
- [x] MOBI text extraction (`mobi_parser::extract_mobi_text`, PalmDOC; HUFF/CDIC rejected).
- [x] Interactive TUI (`theorem tui`).
- [x] Settings toggle with persistence + startup auto-heal + AppImage-aware symlink.
- [x] `--cfi` reading anchor (`epubcfi.rs` parser + `theorem read --cfi`).
- [ ] HUFF/CDIC MOBI decompression (PalmDOC works; Huffman-compressed MOBIs
      need the `mobi` crate's decoder — at least one library book hits this).

## 10. Known limitations

- The headless app context initializes GTK (Tauri builds the event loop
  eagerly), so CLI data commands need a desktop session — cron/SSH without a
  display will abort with a GTK error. A path-based refactor of
  `database::with_connection` + stardict/mobi paths would remove this.
- CLI mutations of GUI store rows (books, feeds, collections) are picked up by
  the GUI on its next launch; a running GUI instance owns its in-memory copy.
- `book_metadata` SQL table only updates on metadata edits; the kv books array
  is authoritative (library list uses it).
