# Get Ebook Highlights into Obsidian

Theorem is a standalone reader that writes your EPUB and PDF highlights and notes as Markdown files into your Obsidian vault folder or Logseq graph folder.

Theorem is not an Obsidian plugin. It is a separate reader app. You read and highlight in Theorem, and Theorem writes ordinary `.md` files into a folder you choose. Obsidian or Logseq then reads those files like any other note. Nothing needs to be installed inside Obsidian or Logseq.

## Can I do this on Android?

Not directly. The Android app cannot choose an export folder, so it does not write Markdown files. Highlights you make on a phone reach Markdown in two steps:

1. Pair the phone with a computer that runs Theorem. See [Sync between devices](device-sync.md).
2. Let the highlights sync to the computer, then export from the desktop app. The desktop app includes synced highlights in its exports. After a sync, click Export now on the computer if you want the files updated at once.

Everything else on this page describes the desktop apps for Linux, macOS and Windows.

## How do I export highlights to my Obsidian vault?

1. Open Settings and select the Devices & Export tab.
2. Find the Markdown Export section.
3. Next to Export Folder, click Pick folder and choose your Obsidian vault folder. You can also type or paste a path into the box.
4. Under Export Preset, choose Obsidian.
5. Under Highlight Grouping, choose By Chapter (Hierarchical) or Flat (Chronological).

Picking a folder turns export on and starts the first export right away. Clear removes the folder and turns export off. The export folder can be any folder. An Obsidian vault is a folder on your computer that holds Markdown files, so the folder you pick can be your whole vault or a subfolder of it.

## How do I highlight in an EPUB or PDF?

1. Open an EPUB or PDF from your library.
2. Select some text.
3. In the pop-up, click one of the six color swatches, or press `1` to `6`.
4. To attach a comment, click Add Note, type it and click Save.

Theorem saves the highlight. Within a couple of seconds it writes the Markdown file. Details and the PDF drawing tools are in [Highlights and notes](highlights-and-notes.md). You can review everything in one place in [Workbench and bookmarks](workbench.md).

## What does the exported Markdown file look like?

The example below comes from the export code, using a book titled Dune by Frank Herbert with two highlights in Chapter 1. The first highlight has a note. This is the Obsidian preset with By Chapter grouping:

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

### Chapter 1

> ==I must not fear. Fear is the mind-killer.==

The classic litany against fear.

> ==A beginning is the time for taking the most delicate care that the balances are correct.==
```

How it is built:

- The front matter block holds the title, author, a highlight count and two tags, `theorem` and `highlights`.
- The author line appears under the title unless the author is unknown.
- With By Chapter grouping, highlights sit under a `###` heading for their chapter, in chapter order. Highlights with no chapter go under General Highlights. If none of a book's highlights has chapter information, the list is not grouped.
- With Flat grouping, all highlights appear in one list in the order you made them.
- Each highlight is a quote with the text wrapped in `==` marks. Your note follows as a plain paragraph.

### Presets compared

| Preset | Highlight | Note |
| :--- | :--- | :--- |
| Obsidian | `> ==text==` | Plain paragraph under the quote |
| Logseq | `- > ==text==` | Nested bullet, `  - **Note**: text` |
| Minimalist | `> text` | Plain paragraph under the quote |
| Custom (Knap) | Your own template | Your own template |

With the Logseq preset, the same two highlights are written as an outline:

```markdown
- > ==I must not fear. Fear is the mind-killer.==
  - **Note**: The classic litany against fear.

- > ==A beginning is the time for taking the most delicate care that the balances are correct.==
```

The Logseq and Minimalist presets use the same front matter, title and headings as the Obsidian preset. Only the highlight and note lines change.

## Where do the files land, and when are they written?

Inside your export folder, Theorem creates a `Theorem` folder:

| Path | Contents |
| :--- | :--- |
| `Theorem/Books/<title> - <author> (<id>).md` | One file per book or RSS article source that has highlights |
| `Theorem/Vocabulary.md` | Your saved words |
| `Theorem/.theorem-export-manifest.json` | A hidden list Theorem uses to remember which files it wrote |

For the example above the file is named like `Dune - Frank Herbert (b3efa55d).md`. The short code in brackets is a hash that Theorem derives from the book, so two books with the same title and author get different file names. If a name still collides, a number is added. Long names are shortened to fit.

You can rename the `Books` folder and `Vocabulary.md` under File names in the Markdown Export section (Highlights folder and Vocabulary file). The `Theorem` folder name is fixed.

Only highlights and notes are exported. Bookmarks are not. Books with no highlights get no file.

### When does export happen?

- Automatically, about two seconds after you add, edit or delete a highlight or note, or save or remove a vocabulary word.
- Right after you pick an export folder.
- On demand, when you click Export now next to Export Markdown Now.

### How do I re-export everything?

1. Open Settings, Devices & Export, Markdown Export.
2. Click Export now.
3. Read the Export Status line. It shows Export complete with a message such as how many notes were updated, or Export error with the reason.

Theorem rewrites only files whose content changed, so notes that are already up to date are left alone, and Obsidian or a file-sync tool is not disturbed by needless writes. A re-export never merges your edits into a file: if you change a highlight in Theorem, the file is rewritten from Theorem's data. Do not rely on editing the exported files by hand. Put your own writing in a separate note that links to the exported one.

## Can I change the template?

Yes, in two ways.

1. Switch Export Preset to Minimalist or Logseq for a different built-in style.
2. Switch it to Custom (Knap) and write your own template. The Custom Note Template editor appears.

To write a custom template:

1. Set Export Preset to Custom (Knap).
2. Edit the template. Click a chip such as Title, Author Wikilink, Format, Count, Quote, Note, Chapter or Callout to insert that field at the cursor.
3. Check the Live Preview below the editor. A message reads Render warnings present if the template has a problem, and a syntax error list appears if it does not parse.
4. Click Reset to return to the default template.

The default custom template produces this for the Dune example. It differs slightly from the Obsidian preset, as it has a `format` property, different tags and a wikilink on the author:

```markdown
---
title: "Dune"
author: "Frank Herbert"
format: "epub"
total_highlights: 2
tags:
  - reading/highlights
  - theorem
---

# Dune
*By [[Frank Herbert]]*

## Highlights

> ==I must not fear. Fear is the mind-killer.==

**Note**: The classic litany against fear.

> ==A beginning is the time for taking the most delicate care that the balances are correct.==
```

What a custom template can use:

- Book variables: `id`, `title`, `author`, `format`, `filePath`, `totalHighlights`, `syncDate` and `tags`.
- `highlights`, a list you loop over with `{% for item in highlights %}`. Each item has `text`, `note`, `color`, `chapterTitle`, `chapterIndex`, `createdAt` and `updatedAt`.
- Filters from the Knap template language, such as `highlight`, `wikilink`, `callout` and `yaml`.

Things to know about custom templates:

- A custom template applies to the book files only. `Vocabulary.md` keeps its fixed format.
- The Highlight Grouping setting does not apply to a custom template. Group by chapter in the template itself, using `chapterTitle`.
- In a custom template the highlight text is joined into a single line.
- If a template renders no output for a book, Theorem writes that book with the Obsidian preset instead.

## How do I use this with Logseq?

1. In Settings, Devices & Export, Markdown Export, click Pick folder and choose your Logseq graph folder. A file-based Logseq graph folder normally contains `pages`, `journals`, `assets` and `logseq` folders.
2. Set Export Preset to Logseq.
3. Highlight in Theorem. The files appear in `Theorem/Books` inside the graph folder.

Each highlight becomes a top-level bullet, and its note is nested under it as a `**Note**` bullet, as in the example above. Theorem does not write into the graph's `pages` folder. If Logseq does not show the new files, re-index the graph from within Logseq.

Logseq's newer database graphs store data in a database file and no longer use the file layout described here, so this export targets file-based graphs. Check which kind you have before you rely on it.

## Troubleshooting

- **Nothing was exported.** Open Settings, Devices & Export, Markdown Export. Make sure Export Folder is set, then click Export now. If Export Status says "Set an export folder first.", pick a folder. Also check that the book has at least one highlight or note, since books without them get no file.
- **No files on Android.** The Android app has no export folder setting. Sync to a desktop app and export there, as described at the top of this page.
- **A highlight made on my phone is missing.** Sync the devices first (see [Sync between devices](device-sync.md)), then click Export now on the computer.
- **A book's bookmarks are missing.** Bookmarks are not exported. Only highlights and notes are.
- **There are two files for one book.** The file name includes a code derived from the book's id, title and author. If you rename the book or change its author, the file name changes. Theorem deletes the old file on the next export only if you have not edited it, so an edited old file stays. Delete it yourself. If you imported the same book twice, Theorem treats them as two books with separate files.
- **The notes look different from what I expect.** Change the Export Preset or Highlight Grouping, or write a Custom (Knap) template.
- **My custom template shows an error.** Read the syntax error list under the editor, or click Reset to return to the default template.

For other export problems see [Troubleshooting](troubleshooting.md#markdown-export). The full settings reference is in [Markdown export for Obsidian and Logseq](vault-sync.md).

## Sources

- [Obsidian Help: How Obsidian stores data](https://obsidian.md/help/data-storage). Supports: a vault is a folder on your file system including subfolders, and notes are Markdown-formatted plain text files.
- [Obsidian Help: Manage vaults](https://obsidian.md/help/manage-vaults). Supports: a vault is a folder, and an existing folder can be opened as a vault.
- [Obsidian Help: Properties](https://obsidian.md/help/properties). Supports: properties are stored as YAML at the top of the file, and tags are a list with one tag per line.
- [Obsidian Help: Basic formatting syntax](https://obsidian.md/help/syntax). Supports: `==text==` highlight syntax and `[[wikilink]]` internal links.
- [Obsidian Help: Import from Logseq](https://obsidian.md/help/import/logseq). Supports: a file-based Logseq graph root normally contains `pages`, `journals`, `assets` and `logseq` folders.
- [Logseq documentation: DB version changes](https://github.com/logseq/docs/blob/master/db-version-changes.md). Supports: Logseq database graphs store data in a database file, and the `logseq/` folder no longer exists in them.
- [Knap template language](https://knap.md). Supports: the template syntax (variables, filters, `if` and `for` tags) used by the Custom (Knap) preset.

Statements about Theorem's settings, file names and output were checked against the Theorem source code and its export output. Whether Logseq picks up files placed in a subfolder of the graph, and when it needs a re-index, is not covered by Logseq's official documentation that was checked here.

Last checked: October 2026.
