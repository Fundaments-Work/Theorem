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
generated_at: "2025-03-20T10:00:00.000Z"
annotations_total: 2
highlights_total: 2
notes_total: 0
tags:
  - theorem
  - highlights
  - notes
---

# Book Title

- Author: Author Name
- Format: epub
- Exported at: 2025-03-20T10:00:00.000Z

## Highlights and Notes

### 1. Highlight
- Created: 2025-01-15T00:00:00.000Z
- Color: yellow

**Quote**

> This is a highlighted passage.

---

### 2. Highlight
- Created: 2025-03-20T00:00:00.000Z
- Color: green

**Quote**

> Another highlight from a different location.

---
```

### Vocabulary File

A single vocabulary file aggregates all saved terms:

```markdown
---
title: Theorem Vocabulary
type: theorem-vocabulary
generated_at: "2025-03-20T10:00:00.000Z"
terms_total: 2
languages:
  - "en"
tags:
  - theorem
  - vocabulary
---

# Theorem Vocabulary

- Exported at: 2025-03-20T10:00:00.000Z
- Terms: 2

## 1. epiphany
- Term ID: `...`
- Language: en
- Phonetic: /e-piph-a-ny/
- Created: 2025-01-15T00:00:00.000Z
- Providers: stardict

### Definitions

1. a moment of sudden revelation or insight

---

## 2. serendipity
- Term ID: `...`
- Language: en
- Phonetic: /ser-en-dip-i-tee/
- Created: 2025-01-15T00:00:00.000Z

### Definitions

1. the occurrence and development of events by chance in a happy or beneficial way

---
```

## Configuration

Vault sync is configured in Settings → Devices & Export → Markdown Export:

| Setting | Purpose |
|---------|---------|
| Vault path | Root directory of your Obsidian vault |
| Auto-export highlights | Export on every annotation change (default: on) |
| Highlights filename | Prefix for per-book files (default: `theorem-highlights`) |
| Vocabulary filename | Filename for vocabulary export (default: `theorem-vocabulary.md`) |

## When Export Happens

- **Auto**: After every annotation mutation (add/delete/edit highlight or note). Debounced to avoid excessive writes during bulk operations.
- **Manual**: From Settings → Devices & Export → Markdown Export → "Export now" button.

The export function (`syncVaultMarkdownSnapshot`) writes all files atomically: it generates all content in memory, then writes files one by one. If any write fails, the error is reported but previously written files are not rolled back (partial export is recoverable).

## Implementation & Headless CLI

The core function is `syncVaultMarkdownSnapshot()` in `src/core/lib/vault-sync.ts`:

1. Reads all books with annotations from `libraryStore`
2. Groups annotations by book
3. For each book: generates Markdown with YAML frontmatter
4. Generates vocabulary file with all terms from `vocabularyStore`
5. Writes files to `{vaultPath}/{highlightsFileName}-books/{book-slug}.md`
6. Writes vocabulary to `{vaultPath}/{vocabularyFileName}`
7. Removes the legacy highlights index file, if present

File writes use Tauri's `writeTextFile` via `@tauri-apps/plugin-fs`. On web, the export is not available (no filesystem access).

In the **Headless CLI**, a JSON snapshot can be exported headlessly:
```bash
theorem export --out ~/backup/reading_data.json
```
Markdown/vault export is GUI-only — there is no headless `vault` subcommand.
