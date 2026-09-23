# Vault Sync (Markdown Export)

## Why Markdown Export

Theorem exports highlights, notes, and vocabulary to Markdown files compatible with popular PKM (Personal Knowledge Management) systems like **Obsidian**, **Logseq**, and minimalist plain-text vaults:

- **No lock-in**: Your reading notes are plain Markdown files, readable by any text editor or note-taking tool.
- **Searchable**: Full-text search works natively across all exported highlights in your PKM application.
- **Linkable**: Each book gets its own page; terms link back via backlinks or wikilinks.
- **High Performance**: Native multi-threaded Rust batch export engine (`vault_export.rs`) using Rayon writes hundreds of notes in <50ms with zero-overhead change detection (only modified files are rewritten).

## Output Presets

Theorem provides 3 built-in output presets configured in **Settings → Markdown Export → Export Preset**:

### 1. Obsidian (Default)

Formats book notes with YAML frontmatter, clean typography, and Obsidian highlight syntax (`> ==quote==`):

```markdown
---
title: "Dune"
type: "theorem-book-highlights"
author: "Frank Herbert"
total_highlights: 2
tags:
  - theorem
  - highlights
---

# Dune
*Frank Herbert*

## Highlights

> ==Fear is the mind-killer.==

> ==I must not fear.==

The Litany Against Fear, repeated when facing terror.
```

### 2. Logseq

Formats book notes as an outline hierarchy using bullet blocks (`- > ==quote==`) and nested note items (`  - **Note**: ...`):

```markdown
---
title: "Dune"
type: "theorem-book-highlights"
author: "Frank Herbert"
total_highlights: 2
tags:
  - theorem
  - highlights
---

# Dune
*Frank Herbert*

## Highlights

- > ==Fear is the mind-killer.==

- > ==I must not fear.==
  - **Note**: The Litany Against Fear, repeated when facing terror.
```

### 3. Minimalist

Formats book notes using clean standard Markdown blockquotes (`> quote`) without any highlight markup:

```markdown
---
title: "Dune"
type: "theorem-book-highlights"
author: "Frank Herbert"
total_highlights: 2
tags:
  - theorem
  - highlights
---

# Dune
*Frank Herbert*

## Highlights

> Fear is the mind-killer.

> I must not fear.

The Litany Against Fear, repeated when facing terror.
```

## Vocabulary & Flashcards Export

A single `Vocabulary.md` file aggregates saved terms in a format directly parseable by **Lemma FSRS** or Anki/Obsidian flashcard plugins:

```markdown
---
title: "Theorem Vocabulary"
type: "theorem-vocabulary"
generated_at: "2026-09-11T12:00:00.000Z"
terms_total: 1
languages:
  - "en"
tags:
  - flashcards
  - theorem
  - vocabulary
---

# Theorem Vocabulary

- Exported at: 2026-09-11T12:00:00.000Z
- Terms: 1

---card---
### ephemeral *[/ɪˈfɛm(ə)rəl/]* ^fsrs-vocab-vocab-1
> "The beauty of the cherry blossoms was ephemeral."
---
1. **adjective**: Lasting for a very short time.
2. **noun**: An ephemeral plant or insect.
```

## Configuration

Vault sync is configured in **Settings → Markdown Export**:

| Setting | Purpose | Default |
|---------|---------|---------|
| **Export Folder** | Root directory of your PKM vault | `""` |
| **Export Preset** | Output style: `Obsidian`, `Logseq`, or `Minimalist` | `Obsidian` |
| **Auto-export highlights** | Auto-write on annotation changes | `true` |
| **Highlights folder** | Subfolder for per-book files | `Books` |
| **Vocabulary file** | Filename for vocabulary export | `Vocabulary.md` |

## When Export Happens

- **Auto**: Triggered on annotation mutations (add/delete/edit highlight or note) after a short debounce to avoid excessive disk I/O.
- **Manual**: Via the **Export now** button in Settings → Markdown Export.
- **Diff Detection**: Theorem compares byte hashes and only writes files that have actually changed, avoiding re-indexing cycles in Obsidian, Syncthing, or Git.

## Implementation Architecture

1. **Rust Native Path (`src-tauri/src/vault_export.rs`)**: On desktop, the Tauri command `vault_export_snapshot` processes all books and annotations in parallel using Rayon threads.
2. **TypeScript Web Fallback (`src/core/lib/vault-sync.ts`)**: In non-Tauri / test environments, a modular builder formats the markdown and outputs preset-specific structures.
3. **Headless CLI**:
   ```bash
   theorem export --out ~/backup/reading_data.json
   ```

