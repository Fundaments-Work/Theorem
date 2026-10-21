# Markdown Export for Obsidian and Logseq

Choose an export folder, pick a note style, and let Theorem keep one Markdown file per book with your highlights and notes, plus a vocabulary file.

Markdown export writes plain text files, so any notes app can read them. It is built for Obsidian and Logseq vaults, but any folder works. Export runs in the desktop apps. The Android app cannot choose an export folder.

## Set up the export

1. Open Settings and select the Devices & Export tab.
2. Find the Markdown Export section.
3. Next to Export Folder, click Pick folder and choose the folder to write to. For Obsidian or Logseq, choose your vault folder. You can also type or paste a path into the box.
4. Under Export Preset, choose Obsidian, Logseq, Minimalist or Custom (Knap). See the next section.
5. Under Highlight Grouping, choose By Chapter (Hierarchical) or Flat (Chronological).

Picking a folder turns automatic export on and starts the first export right away. Clear removes the folder and turns export off.

## What gets written

Inside your export folder, Theorem creates a `Theorem` folder:

| Path | Contents |
| :--- | :--- |
| `Theorem/Books/<title> - <author> (<id>).md` | One file per book (or RSS article source) that has highlights. The short id keeps two books with the same title apart |
| `Theorem/Vocabulary.md` | Your saved words |

Each book file starts with front matter (title, author, number of highlights and tags), followed by your highlighted passages. Notes appear with their highlight. If two books would still get the same file name, Theorem adds a number to keep them apart. Theorem also keeps a hidden `.theorem-export-manifest.json` file in the `Theorem` folder to remember what it wrote; leave it in place.

Things to know:

- Only highlights and notes are exported. Bookmarks are not.
- Books with no highlights get no file.
- Highlights from RSS articles are included.
- Theorem rewrites only files whose content changed, so your notes app and any sync tool are not disturbed by needless writes.
- Files for books you remove from the library are deleted, unless you have edited them.

## Choose a note style

| Preset | Style |
| :--- | :--- |
| Obsidian | Quotes written as `> ==highlighted text==`, with notes as plain paragraphs below |
| Logseq | An outline of bullet blocks, such as `- > ==highlighted text==`, with notes nested under each highlight as `**Note**` items |
| Minimalist | Standard Markdown quotes, `> highlighted text`, with no highlight markup |
| Custom (Knap) | A template you write yourself |

With By Chapter (Hierarchical), highlights are grouped under headings for the chapters they came from. With Flat (Chronological), they appear in one list in the order you made them. Highlights made before chapter information was stored get it filled in the next time you open the book.

### Write a custom template

1. Set Export Preset to Custom (Knap). A Custom Note Template editor appears.
2. Edit the template. Click a chip such as Title, Author Wikilink, Format, Count, Quote, Note, Chapter or Callout to insert that field at the cursor.
3. Watch the Live Preview below the editor, which renders a sample book. Click Hide preview to collapse it. A message reads Render warnings present if the template has a problem.
4. Click Reset to return to the default template.

Templates use placeholders such as `{{ title }}`, filters such as `{{ author | wikilink }}` and loops such as `{% for item in highlights %}`.

## Rename the folder and vocabulary file

1. In the Markdown Export section, open File names.
2. Change Highlights folder to rename `Books`.
3. Change Vocabulary file to rename `Vocabulary.md`.

## When the export runs

- **Automatically,** a couple of seconds after you add, edit or delete a highlight or note, or save or remove a word.
- **On demand.** Click Export now next to Export Markdown Now. The Export Status line shows Ready, Exporting..., Export complete or Export error, with a message and the time. If no folder is set, it says "Set an export folder first."

## Vocabulary file

`Vocabulary.md` lists each saved word with its phonetic spelling, the sentence where you found it and its definitions grouped by part of speech. Each word sits in a card block that spaced-repetition tools can read.

## Highlights from your phone

Android has no export folder setting. If you use [device sync](device-sync.md), highlights made on the phone sync to your computer, and the desktop app includes them in its exports. After a sync, click Export now on the computer if you want the files updated immediately.
