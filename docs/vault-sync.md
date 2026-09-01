# Vault Sync (Markdown Export)

## Why Markdown Export

Theorem exports highlights and vocabulary to Markdown files that are compatible with **Obsidian** and **Logseq**. This provides:

- **No lock-in**: Your reading notes are plain Markdown files, readable by any text editor
- **Searchable**: Obsidian's full-text search works across all exported highlights
- **Linkable**: Each book gets its own page; terms link back via backlinks
- **Portable**: Copy your vault folder to any device — notes follow

## Output Format

### Per-Book Highlights File

Each book has a Markdown file in a subdirectory `{highlightsFileName}-books/`:

```markdown
---
title: "Book Title"
type: theorem-book-highlights
author: "Author Name"
format: epub
source_path: "/path/to/book.epub"
source_added: "2025-01-15"
source_last_read: "2025-03-20"
tags: [reading]
---

> This is a highlighted passage — it appears as a block quote.

- **Page**: 42
- **Color**: yellow

This is a note attached to the highlight above.

---

> Another highlight from a different location.
```

### Vocabulary File

A single vocabulary file aggregates all saved terms:

```markdown
---
title: Theorem Vocabulary
type: theorem-vocabulary
source_last_updated: "2025-03-20"
---

## serendipity
*/ser-en-dip-i-tee/*
the occurrence and development of events by chance in a happy or beneficial way

> "She discovered the book by serendipity"

---

## epiphany
*/e-piph-a-ny/*
a moment of sudden revelation or insight
```

## Configuration

Vault sync is configured in Settings → Integrations:

| Setting | Purpose |
|---------|---------|
| Vault path | Root directory of your Obsidian vault |
| Auto-export highlights | Export on every annotation change (default: on) |
| Highlights filename | Prefix for per-book files (default: "Highlights") |
| Vocabulary filename | Filename for vocabulary export (default: "Vocabulary") |

## When Export Happens

- **Auto**: After every annotation mutation (add/delete/edit highlight or note). Debounced to avoid excessive writes during bulk operations.
- **Manual**: From Settings → Integrations → "Export now" button.

The export function (`syncVaultMarkdownSnapshot`) writes all files atomically: it generates all content in memory, then writes files one by one. If any write fails, the error is reported but previously written files are not rolled back (partial export is recoverable).

## Implementation & Headless CLI

The core function is `syncVaultMarkdownSnapshot()` in `src/core/lib/vault-sync.ts`:

1. Reads all books with annotations from `libraryStore`
2. Groups annotations by book
3. For each book: generates Markdown with YAML frontmatter
4. Generates vocabulary file with all terms from `vocabularyStore`
5. Writes files to `{vaultPath}/{highlightsFileName}-books/{book-slug}.md`
6. Writes vocabulary to `{vaultPath}/{vocabularyFileName}.md`
7. Removes book files for deleted books (stale cleanup)

File writes use Tauri's `writeTextFile` via `@tauri-apps/plugin-fs`. On web, the export is not available (no filesystem access).

In the **Headless CLI**, vault exports and JSON dumps can be triggered headlessly by shell scripts and AI agents:
```bash
theorem export vault --path ~/Obsidian/Reading
theorem export json --output ~/backup/reading_data.json
```
