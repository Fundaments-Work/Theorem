# Use Theorem from the Command Line and with AI Agents

The theorem command finds books, prints chapters as text, searches inside EPUB files, lists highlights and returns JSON for scripts and AI agents.

This page is checked against the source of v1.6.0. Most outputs shown here were first captured from the v1.5.9 program against a throwaway library with one small test EPUB, and are updated where 1.6.0 changed them. Output shown for `highlights` is derived from the source instead, and says so. Long file paths in the examples are shortened.

The command line is part of the desktop apps for Linux, macOS and Windows. It is not in the Android app. The one-click setup that puts `theorem` on your `PATH` exists on Linux only.

## What can the theorem command do?

Every subcommand and its options, as printed by `theorem --help` and the help of each subcommand:

| Command | What it does |
| :--- | :--- |
| `theorem search <query> [book_id] [--limit N]` | Without a book id: finds books whose title or author contains every word of the query (a word also matches the start of a longer one, so `dun` finds Dune). With a book id: searches the text of that book. `--limit` caps the results (default 50) |
| `theorem read <book_id> [--chapter N] [--cfi <cfi>]` | Prints one chapter as plain text. `--chapter` is 1-based and defaults to 1. `--cfi` prints the text at an EPUB location |
| `theorem dict <term> [--online]` | Looks the term up in your installed StarDict and MDict dictionaries. `--online` also asks the online dictionary service |
| `theorem extract <url>` | Fetches a web page and prints the article text |
| `theorem library list [--format table\|json]` | Lists your books |
| `theorem library info <book_id>` | Shows details for one book |
| `theorem library add <files...>` | Imports book files. Every file is reported as added, skipped (its content is already in the library) or failed, with the reason. The exit code is 1 when a file failed |
| `theorem library import <dir>` | Imports every supported file under a folder, including subfolders |
| `theorem library remove <book_id>` | Removes a book, its covers and its annotations |
| `theorem library favorite <book_id> [on\|off\|toggle]` | Sets or toggles the favorite flag |
| `theorem library export <book_id> [--out <path>]` | Writes the original book file to disk |
| `theorem library edit-meta <book_id> [--title T] [--author A]` | Changes the title or author. For an EPUB it rewrites the file |
| `theorem shelf list`, `create <name>`, `delete <shelf>`, `add <shelf> <book_id>`, `remove <shelf> <book_id>` | Manages shelves. A shelf can be named by its name or its id |
| `theorem highlights list [--book <id>]` | Prints annotations as JSON |
| `theorem highlights add <book_id> --text <t> [--note <n>] [--type highlight\|note] [--color <c>]` | Adds an annotation. The color defaults to `yellow` |
| `theorem highlights delete <annotation_id>` | Deletes an annotation |
| `theorem highlights export [--format md\|json\|csv] [--book <id>] [--since <date>] [--out <path>]` | Exports highlights and notes to Markdown (Obsidian format), JSON, or CSV, optionally writing to disk |
| `theorem highlights card [<id>] [--book <id>] [--theme dark\|sepia\|tinted\|light] [--format square\|story] [--out <path>] [--out-dir <dir>] [--no-note]` | Exports highlight share cards as PNG or SVG images for single annotations or batch across a book |
| `theorem bookmarks list [--book <id>]` | Lists bookmarks |
| `theorem feeds list`, `add <url>`, `remove <feed>`, `refresh` | Manages RSS and Atom feeds, the same ones the app shows. `add` refuses an address that is not a feed. A feed can be named by its id or its address |
| `theorem feeds import <file.opml>` | Imports feeds from an OPML file |
| `theorem feeds export [--out <file.opml>]` | Exports subscribed feeds to OPML format |
| `theorem opds browse <url>` | Lists the entries of an OPDS catalog |
| `theorem opds download <url> <entry>` | Downloads an entry, by title or by the number `browse` shows, into your library |
| `theorem sync status`, `pair <code>`, `unpair <device_id>`, `now [--device <id>]` | Controls [device sync](device-sync.md) |
| `theorem storage stats`, `storage cleanup` | Shows storage use, or removes book files and covers that no book in the library uses |
| `theorem stats` | Prints reading statistics |
| `theorem export [--out <file>]` | Prints or writes a JSON snapshot of the library |
| `theorem open <book_id>` | Opens the book in the Theorem window |
| `theorem tui` | Starts the text interface |
| `theorem setup-cli` | Creates the `theorem` link in `~/.local/bin` (Linux only) |
| `theorem version` | Prints the version |

Global options work with every command: `--json` prints machine-readable output, `--no-color` turns off color, `--force` lets a command change the library while the app is running, and `--data-dir <path>` (or the `THEOREM_DATA_DIR` environment variable) points the command at an alternative library folder (such as a NAS, another profile, or a test directory). Color is also off by default whenever the output is not a terminal. `-h` and `-V` print help and the version, and `theorem help <command>` prints the help of one command. A command line that is not a command (a typo, an option on its own, a file that does not exist) prints a usage error and exits with code 2. Only `theorem` alone, or files and links to open, start the app window.

## How do I put theorem on my PATH?

- **Linux, `.deb` package.** Nothing to do. The package installs `/usr/bin/theorem`.
- **Linux, AppImage from the install script.** The script already links `~/.local/bin/theorem` to the AppImage. Make sure `~/.local/bin` is on your `PATH`. See [Theorem on Linux](linux.md).
- **Linux, AppImage you downloaded yourself.** Open Settings, Devices & Export, find Terminal CLI and turn on Enable CLI. Theorem links the command into `~/.local/bin` and checks the link every time it starts. If the link goes missing, Settings shows a Repair now button. Running `theorem setup-cli` does the same from a terminal. Inside an AppImage the link points at the AppImage file, so it survives a reboot.
- **macOS and Windows.** The desktop programs contain the same commands, but there is no one-click setup, and `theorem setup-cli` there answers that it is only supported on Linux. This page does not cover putting the command on your `PATH` on those systems.

The commands run without opening a window and without a display, so they work over SSH, on a server or in a container. The CLI uses the same data folder as the app (on Linux `~/.local/share/work.fundamentals.theorem`, on macOS `~/Library/Application Support/work.fundamentals.theorem`, on Windows `%APPDATA%\work.fundamentals.theorem`), so it sees your real library. The `sync` commands are the exception: they start the app's sync engine, which needs a graphical session, and without one they stop with an error that says so.

## What does the JSON output look like?

With `--json`, results go to standard output as pretty-printed JSON. Short notes such as `# 2 matches` and all error messages go to standard error, so a pipe such as `theorem --json library list | jq` stays clean. Errors print `error: <message>` on standard error. With `--json` they are printed as one JSON object instead, `{"error": "<message>", "exitCode": <code>}`, still on standard error. The exit codes are:

| Code | Meaning |
| :--- | :--- |
| 0 | Success |
| 1 | The command failed (for an import: at least one file failed) |
| 2 | The command line does not make sense: an unknown command or option, a missing argument, an invalid value |
| 3 | The book, shelf, highlight, feed or catalog entry does not exist |
| 4 | The network failed: a feed, a catalog or a download could not be fetched |
| 5 | The command would change the library while the Theorem app is running |

Colors are off when the output is not a terminal, with `--no-color`, and when the `NO_COLOR` environment variable is set.

Note that `theorem highlights list` and `theorem bookmarks list` always print JSON, with or without `--json`.

These are real outputs from the v1.5.9 program (paths shortened).

Find a book by title or author. The result has only two keys, `book_id` and `title`:

```
$ theorem search Sample --json
[
  {
    "book_id": "654e1eea-1ef6-4e3c-9ad1-4f1b5911c253",
    "title": "Sample Field Guide"
  }
]
```

Search inside a book. `sectionIndex` counts from 0, and `charOffset` is the position in the chapter's plain text:

```
$ theorem search lighthouse 654e1eea-1ef6-4e3c-9ad1-4f1b5911c253 --json
[
  {
    "sectionIndex": 0,
    "sectionHref": "OEBPS/c1.xhtml",
    "snippet": "Chapter One The lighthouse keeper counted the ships at dusk.",
    "matchText": "lighthouse",
    "charOffset": 20
  },
  {
    "sectionIndex": 1,
    "sectionHref": "OEBPS/c2.xhtml",
    "snippet": "…Two Morning came, and the keeper wrote down the lighthouse log.",
    "matchText": "lighthouse",
    "charOffset": 60
  }
]
```

Read a chapter. `chapter` counts from 1, so `sectionIndex` 1 above is chapter 2. The text has a blank line between headings and paragraphs, and leaves out style sheets and scripts:

```
$ theorem read 654e1eea-1ef6-4e3c-9ad1-4f1b5911c253 --chapter 2 --json
{
  "bookId": "654e1eea-1ef6-4e3c-9ad1-4f1b5911c253",
  "chapter": 2,
  "text": "Chapter Two\n\nMorning came, and the keeper wrote down the lighthouse log."
}
```

Asking for a chapter that does not exist fails with `error: Chapter 9 out of range (book has 2 chapters)` and exit code 1. That message is the only way the CLI reports a chapter count.

Show one book:

```
$ theorem library info 654e1eea-1ef6-4e3c-9ad1-4f1b5911c253 --json
{
  "addedAt": "2026-10-21T04:26:29.895Z",
  "annotationCount": 0,
  "author": "Ada Example",
  "filePath": "/home/you/books/sample.epub",
  "fileSize": 2027,
  "format": "epub",
  "id": "654e1eea-1ef6-4e3c-9ad1-4f1b5911c253",
  "isFavorite": false,
  "lastReadAt": null,
  "materializedPath": "/home/you/.local/share/work.fundamentals.theorem/book-cache/654e1eea-1ef6-4e3c-9ad1-4f1b5911c253.book",
  "progress": 0,
  "tags": [],
  "title": "Sample Field Guide"
}
```

`theorem library list --json` prints the book records the app stores, sorted by title. A book imported from the command line has `id`, `title`, `author`, `format`, `filePath`, `storagePath`, `contentHash`, `fileSize`, `addedAt`, `progress`, `isFavorite`, `tags`, `readingTime` and `coverExtractionDone`, plus `description`, `publisher`, `publishedDate`, `language`, `isbn`, `series`, `seriesIndex` and `coverPath` when the file has them. Books added or read in the app carry more keys. Without `--json` it prints one line per book: the id, the title, the progress and the author, with `*` after favorites.

Other results seen in the test: `theorem shelf list --json` returns objects with `bookIds`, `createdAt`, `id`, `kind`, `name` and `updatedAt`. `theorem sync status --json` returns `identity` (with `deviceId`, `deviceName`, `fingerprint`, `publicKeyHex`) and `pairedDevices`. `theorem extract <url> --json` returns `title`, `content` (HTML) and `textContent`, and adds `byline`, `excerpt`, `siteName`, `leadImageUrl` and `publishedTime` when the page has them. `theorem storage stats --json` returns `total_books`, `total_size`, `covers_size`, `binaries_size`, `blob_entries`, `blob_size`, `idb_books` and `tauri_books`. `theorem dict <term> --json` returns `term`, `stardict`, `mdx`, `online` and `elapsedMs`.

Derived from the source, not captured: a highlight added with `theorem highlights add` is stored with the keys `id`, `bookId`, `type`, `location` (always empty), `selectedText`, `noteContent`, `color` and `createdAt`. `highlights list` prints the stored records and adds `bookId` to each. Records made in the reader are listed in the same way, and may carry more keys than this.

## How can an AI coding agent use it?

An agent that can run shell commands, such as Claude Code, can read your books through these commands. Only the commands below are supported by the code. This is a typical read-only sequence:

1. Find the book id: `theorem --json library list`, or `theorem --json search "field guide"`. A search without a book id looks only at titles and authors. It does not search the text of your library.
2. Look inside one book: `theorem --json search "lighthouse" <book_id>`. This is a case-insensitive text match, and it works on EPUB files.
3. Read the matching chapter: `theorem --json read <book_id> --chapter <sectionIndex + 1>`. `read` accepts EPUB and MOBI files. For other formats it fails with `read supports EPUB and MOBI files only`.
4. List what you marked: `theorem highlights list --book <book_id>`.
5. Look up a word: `theorem --json dict <term>`. Dictionaries you have not installed give empty lists.

To give an agent standing instructions, put a short note in its project file, for example in `CLAUDE.md`: use `theorem --json` for all commands, read with `search` then `read`, and never run commands that change the library unless asked. Chapters can be long, so ask the agent to search first and read only the chapters it needs.

Commands that change data are: `library add`, `import`, `remove`, `favorite`, `edit-meta`, `shelf` create, delete, add and remove, `highlights add` and `delete`, `feeds add`, `remove` and `refresh`, `opds download`, `storage cleanup`, and `sync pair`, `unpair` and `now`. `library edit-meta` rewrites the EPUB file itself. If you let an agent run commands with an allow list, allow the read commands only. While the Theorem app is running (a window or the tray icon), these commands stop with `error: Theorem is running` and exit code 5, because the app would write its own copy of the library over the change. Quit the app first. `--force` writes anyway, at that risk. Reading commands work while the app runs.

## What does the text interface do?

`theorem tui` opens a read-only interface in the terminal, with the first book selected. It needs a real terminal. Run without one, it exits with `failed to enter terminal UI mode`. It never writes your reading progress.

| Where | Keys |
| :--- | :--- |
| Library list | `j` or Down, `k` or Up to move; Enter to read; `o` to open the book in the Theorem window; `/` to filter by title or author (Esc clears); `q` to quit; `?` for help |
| Reader | `j`/`k` or the arrow keys to scroll; Page Up and Page Down to scroll by 20 lines; `g` or Home for the top; `]`, `l` or Right for the next chapter; `[`, `h` or Left for the previous chapter; Esc or Backspace back to the list; `?` for help |

## What can the command line not do?

- It cannot read the text of PDF, FB2 or comic files, and in-book search works on EPUB files only. `read` handles EPUB and MOBI.
- It cannot render pages, play text-to-speech, or generate audiobooks. `theorem open` hands a book to the app window for that.
- It cannot download dictionaries or the neural voice, or trigger Markdown export. See [Markdown export](vault-sync.md).
- It has no command to list feed articles. `feeds refresh` only fetches them.
- `theorem sync pair` takes a pairing code that you create in the app on the other device. See [Sync between devices](device-sync.md).
- It does not run as a server. Each command opens the library, does its work and exits.
- It is not in the Android app, and it is not available in the browser demo.

For a full copy of your data as one file, `theorem export --out library.json` writes the books, shelves, annotations and feeds as JSON. It contains no book files.

## Sources

- Theorem v1.6.0 source: `src-tauri/src/cli.rs`, `src-tauri/src/cli_tui.rs`, `src-tauri/src/cli_text.rs` and `src-tauri/src/app_lock.rs`, and its end-to-end tests in `src-tauri/tests/cli.rs`
- The `theorem` program from the v1.5.9 `.deb` package at https://github.com/Fundaments-Work/Theorem/releases/tag/v1.5.9, for the outputs first captured there

Last checked: October 2026.
