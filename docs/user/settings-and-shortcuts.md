# Settings and Shortcuts

Find every Theorem setting by tab, learn the keyboard shortcuts for the app and the reader, back up your data, clear it, and use the command line on desktop.

Open Settings from the gear icon at the bottom of the sidebar, from the gear icon in the top bar on Android, or with `Ctrl+,`. Settings has six tabs: General, Dictionary, Devices & Export, Data & Storage, Shortcuts and About. Theorem remembers the tab you used last during a session.

## General

### Reading Goals

- **Daily Reading Goal.** Minutes per day, 1 to 180. Default 30.
- **Yearly Book Goal.** Books per year, 1 to 100. Default 24.
- **Goal Notifications.** On by default.
- **Daily Reminder Time.** Default 20:00.
- **Sync Notifications.** On by default.

See [Reading statistics and goals](statistics.md).

### Customization

- **Theme.** System, Light or Dark. The default is Dark.
- **Accent Color.** Choose one of the swatches, or type a six-digit hex color. The default is a lime green, `c6f135`.
- **Daily Highlight.** Shows a random past highlight on the Library page. Off by default.
- **Speed Read.** Adds the Speed Read button to the reader. Off by default. See [Reading books, PDFs and comics](reading.md#speed-read).
- **Text-to-Speech.** Turns text-to-speech on or off. On by default, and not available in the browser demo. See [Listening with text-to-speech and audiobooks](listening.md).
- **Vocabulary Lookup.** Lets you save words you look up. On by default. See [Dictionary and vocabulary](dictionary.md).

### RSS & Articles Retention

- **Article Retention Period.** Keep Forever, 15, 30 (default), 60 or 90 days.
- **Keep Unread Articles.** On by default.

See [Feeds and articles](feeds.md#choose-how-long-articles-are-kept).

### Neural Voice and Text-to-Speech Engine

On desktop, a Neural Voice section lets you download, check and remove the offline neural voice. On a computer the neural voice cannot run on, such as an Intel Mac, the section says it is not available on this platform and does not offer a download. On Android, a Text-to-Speech Engine section lets you pick the speech engine. Both appear only while Text-to-Speech is on.

### Reset to Defaults

Click Reset to Defaults at the bottom of the tab and confirm to restore settings to their defaults.

## Dictionary

Show Pronunciation, Import Files, Download Dictionary, and the list of installed dictionaries with Remove buttons. See [Dictionary and vocabulary](dictionary.md#install-an-offline-dictionary).

## Devices & Export

- **Device Sync.** Pair devices and sync. See [Sync between devices](device-sync.md).
- **Terminal CLI.** Shown on Linux desktop only. See [Use the command line](#use-the-command-line).
- **Markdown Export.** See [Markdown export for Obsidian and Logseq](vault-sync.md).

## Data & Storage

### Storage Usage

Shows four rows:

- **Books.** How many books have their files on this device, and their total size. Books that arrived by sync and have not been downloaded are counted separately as sync-only.
- **Highlights & Notes.** How many annotations you have.
- **RSS Articles.** How many articles are cached and how much space they use.
- **Offline Dictionaries.** How many are installed and their size.

### Create a backup file

1. Open Settings, Data & Storage.
2. Under Data Management, click Create Backup File.
3. Choose where to save it. The default name is `theorem-sync-` followed by today's date, with a `.json` ending.

The backup is one JSON file. It holds your book list and details, shelves, highlights, notes and bookmarks, settings, reading statistics, vocabulary and RSS feeds. It does not contain the book files themselves or your dictionaries, and Theorem has no button to restore from it. To move your books to a new device, use [device sync](device-sync.md) or import the original files again. For a readable copy of your notes, use [Markdown export](vault-sync.md).

### Clear All Data

Clear All Data deletes all your books, highlights, vocabulary and settings from Theorem, and it cannot be undone. Theorem asks you to confirm and then reloads. Your original book files outside Theorem are not touched.

## Shortcuts tab

This tab lists the app's keyboard shortcuts in read-only groups. Press `Shift+?` anywhere to show a shortcuts window.

## About

Shows the version, the build stamp (source commit and date), the license and the author. The Links section has the GitHub repository, Support Theorem (Buy Me Momo), Check for Updates, Download Latest Release and Report an Issue. See [Install Theorem](install.md#update-theorem) for updates.

## Keyboard shortcuts

This guide writes `Ctrl` for the main shortcut key. On Windows and Linux that is the Control key. On a Mac it is the Command key (`⌘`), so `Ctrl+1` is `⌘1`, and the keys in the shortcuts window and in this tab show `⌘`, `⇧` (Shift) and `⌥` (Option). Plain Control on a Mac does not trigger them. Shortcuts do not work while the cursor is in a text box.

### Anywhere in the app

| Shortcut | Action |
| :--- | :--- |
| `Ctrl+1` | Library |
| `Ctrl+2` | Shelves |
| `Ctrl+3` | Discover |
| `Ctrl+4` | Feeds |
| `Ctrl+5` | Workbench |
| `Ctrl+6` | Statistics |
| `Ctrl+7` | Bookmarks |
| `Ctrl+,` | Settings |
| `Ctrl+F` | Focus the search box (outside the reader) |
| `Ctrl+A` | Turn selection mode on or off in the Library or Shelves |
| `Shift+?` | Show or hide the shortcuts window |

### In the reader

| Shortcut | Action |
| :--- | :--- |
| `Right`, `Down`, `Page Down`, `Space` | Next page |
| `Left`, `Up`, `Page Up` | Previous page |
| `Home` / `End` | Start or end of the book |
| `Ctrl+F` | Search in the book |
| `Enter`, `F3` / `Shift+Enter`, `Shift+F3` | Next or previous search result |
| `Alt+C` / `Alt+W` | Match case or whole word in search |
| `Ctrl+D` | Add or remove a bookmark |
| `Ctrl+T` | Table of contents |
| `Ctrl+S` | Reading Settings (View panel for PDFs) |
| `Ctrl+A` | Annotations panel |
| `Alt+Left` / `Alt+Right` | Back or forward in your jump history |
| `F11` | Full screen |
| `F5` | Present a PDF, one page at a time |
| `Ctrl+P` | Print a PDF (desktop) |
| `Ctrl` with `+`, `-` or `0` | Zoom a PDF in, out, or to fit the page |
| `1` to `6` | Choose a highlight color in the selection pop-up |
| `Esc` | Close the pop-up or panel |

In a PDF, `j` and `k` also go to the next and previous page, and `Shift+Space` goes back a page.

## Use the command line

The desktop apps include a `theorem` command for the terminal.

1. On Linux, open Settings, Devices & Export, and turn on Enable CLI in the Terminal CLI section. Theorem links the command into `~/.local/bin`, which must be on your `PATH`. If the link goes missing, click Repair now. Theorem also re-checks it each time it starts.
2. Open a terminal and run `theorem --help` to see the commands.

Commands include `search`, `read`, `dict`, `extract`, `library`, `shelf`, `highlights`, `bookmarks`, `feeds`, `opds`, `sync`, `storage`, `stats`, `export` and `open`. Add `--json` for machine-readable output. `theorem tui` opens a read-only text interface for browsing the library and reading chapters. For example, `theorem export --out backup.json` writes a JSON snapshot of the library to a file.

The command line is not part of the Android app. The Enable CLI switch appears only on Linux. This guide does not cover setting up the command on macOS or Windows.
