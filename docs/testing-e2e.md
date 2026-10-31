# End-to-end tests

`pnpm e2e` drives the real desktop app (Rust backend + WebKitGTK webview) the
way a person does: it clicks buttons, types into fields, picks files and reads
what is on screen. The suite is also the behaviour spec for the 2.0 Svelte
interface: the same specs must pass against it unchanged.

## Running

Linux only (WebKitWebDriver exists for WebKitGTK; macOS has no WKWebView
driver, Windows would need msedgedriver and is not wired up).

Needs: `WebKitWebDriver` (Arch: part of `webkit2gtk-4.1`; Debian/Ubuntu:
`webkit2gtk-driver`), `tauri-driver` (`cargo install tauri-driver --locked`),
`dbus-daemon`, and `mutter` or `Xvfb` for a headless display.

```bash
pnpm e2e:build        # vite build + cargo build --features e2e, then run
pnpm e2e              # run against the existing build
pnpm e2e reader shelves   # only specs whose file name contains a word
```

Run heavy steps capped when other work shares the machine, e.g.
`resources/capped.sh 6G 600 env CARGO_BUILD_JOBS=4 cargo build --features e2e`.
The suite takes about 2.5 minutes for 8 specs (25 tests).

### Isolation

The suite never touches your library or your running Theorem:

- each spec gets a temporary `HOME` and `XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME`,
  so the app's data directory is new and empty;
- the app runs on a private D-Bus session bus (no service activation), so the
  single-instance plugin cannot find, or hand its arguments to, a Theorem you
  have open;
- it runs on a private headless display (`mutter --headless`, or `Xvfb` with
  `THEOREM_E2E_DISPLAY=xvfb`), never on your desktop.
- every helper runs in a process group of its own (bus, display, and per spec
  tauri-driver with WebKitWebDriver and the app under it); teardown stops each
  group and waits until it is empty, a restart waits for the old app to exit,
  and each run uses its own display name, so back-to-back runs never race a
  previous one that is still shutting down (`e2e/lib/procs.mjs`).

`THEOREM_E2E_KEEP=1` keeps each spec's temporary folder (app log at
`home/.local/share/work.fundamentals.theorem/logs/theorem.log`). When a wait
times out, the failure prints the screen's accessible outline and saves a
screenshot to `e2e/.artifacts/`.

### The e2e build

`cargo build --features e2e` is a debug build that embeds `dist/` and swaps
the dialog plugin for a stand-in (`src-tauri/src/e2e_hooks.rs`). WebDriver
cannot reach native GTK file pickers or message boxes, and
`__TAURI_INTERNALS__` is frozen, so the stand-in answers `open`/`save`/`message`
from files the test writes (`app.queueDialog("open", [paths])`); unqueued
confirmations press OK. A `quit` file there triggers the tray's graceful quit.
Everything after the dialog runs for real. Normal and release builds do not
contain it.

## Layout

| Path | What |
|---|---|
| `e2e/run.mjs` | Entry: private bus + display, runs `e2e/specs/*.test.mjs` with `node --test`, one at a time |
| `e2e/lib/webdriver.mjs` | Minimal W3C WebDriver client (no dependencies) |
| `e2e/lib/a11y-page.js` | In-page queries by ARIA role + accessible name, label or visible text |
| `e2e/lib/app.mjs` | `Sandbox` (temp HOME, tauri-driver, launch/quit/wipe) and `App` (find, click, fill, waitFor, dialogs) |
| `e2e/lib/flows.mjs` | User-level steps shared by specs: skip onboarding, import books, open a book, highlight, open a Settings tab |
| `e2e/lib/fixtures.mjs` | Generated EPUBs with known titles, authors and a marker sentence |
| `e2e/explore.mjs` | Dev helper: run steps and print the accessible outline after each (`node e2e/run.mjs --explore`) |

## Rules for writing specs (so they survive the Svelte rewrite)

1. **Find things the way a user or a screen reader does.** Use
   `{ role, name }`, `{ label }` or `{ text }`. Never CSS classes, test ids,
   component names, store state or `window` internals.
2. **Act through the interface.** Click, type, press keys, drag. The only
   test-side hooks are the dialog stand-in and reading the filesystem the app
   writes to (exports, backups). `app.invoke` exists for setup and inspection
   only, never for the action under test.
3. **Assert what the user sees or gets**: visible text, a button's pressed
   state, a field's value, a file on disk.
4. **Wait for outcomes, not time.** Use `find`/`waitFor`/`waitGone`; a fixed
   `sleep` only where the app itself debounces (and say so in a comment).
5. **Quit like a user.** `box.quit()` is the tray's Quit (the app's graceful
   quit: every window flushes its writes, then exits); `box.quit({ hard: true })`
   is a crash. Killing the process right after a change loses writes still in
   the 350 ms persistence debounce, which is expected, not a bug.
6. **One sandbox per spec file**, tests inside a file run in order and may
   build on each other; keep specs independent of each other.
7. When the interface changes a label, change it in `flows.mjs` once; if a
   spec needs a new hook into the app, it belongs in the e2e feature, never in
   shipped code.

## Covered

| # | Spec | Flow |
|---|---|---|
| 1 | `01-first-launch` | onboarding shown on first launch, Skip → empty library; not shown again after a restart |
| 2 | `02-library-import-search` | Import Books (file picker) → 3 books listed; re-import is not duplicated; search by title, author, no match; clear |
| 3 | `03-reader-position` | open → page 1; Next/Previous page; back and reopen → same page; same page after restart |
| 4 | `04-highlight-workbench-export` | double-click a word, pick a colour → highlight; Workbench shows the highlight, book and author in Highlights, excludes it from Notes, and restores it when returning to Highlights; Settings → Markdown Export → Pick folder → Export now writes a `.md` with the highlight, title and author |
| 5 | `05-shelves` | Shelves empty; select a book → Add to shelf → new shelf; the shelf lists only that book; survives restart |
| 6 | `06-folder-scan` | Settings → Data & Storage → Add Library Folder → choose folder → organization chooser; scan with nested books, a book already in the library, an identical copy, a broken `.epub` and a `.txt`: "2 imported, 1 already in your library, 1 could not be imported" naming the broken file; rescanning imports nothing |
| 7 | `07-backup-restore` | Create Backup File (save dialog, default name `theorem-YYYY-MM-DD.theorem-backup`) → wipe data dir → empty app → Restore from Backup → Replace Library → books and highlight back; a restored book opens |
| 8 | `08-settings-persist` | theme, daily reading goal and article retention survive a restart |

## Not covered (gaps)

- **Device sync (pairing two instances).** Two sandboxes can run side by side,
  but pairing goes through iroh (relay servers / local discovery) and a QR or
  pasted code plus an approval prompt; it needs network access and is slow and
  timing-dependent, so it is left to manual testing (`docs/sync.md`).
- **Android, macOS, Windows.** No WebDriver for WKWebView; Android needs the
  emulator. Linux WebKitGTK only.
- **Native dialogs themselves.** The stand-in replaces them; their filters and
  titles are only checked through the recorded arguments.
- **Neural voice / TTS, audiobooks, OPDS catalogs, RSS feeds**: need downloads
  or network.
- **The tray icon.** Not reachable; the e2e build watches for a `quit` file in
  the dialog directory and runs the same graceful quit the tray's Quit runs.

## Known failures

- Opening a book seconds after importing it: the first click on the book
  occasionally does nothing (seen in 2 of about 12 runs). `openBook` in
  `e2e/lib/flows.mjs` clicks a second time and prints
  `[e2e] first click on "…" did not open the reader`; worth a look in the
  library grid (the card may be re-rendered while its metadata and cover land).

## CI

`.github/workflows/ci.yml` has an `e2e` job on `ubuntu-22.04` (Xvfb,
`webkit2gtk-driver`, `tauri-driver`). It is `continue-on-error: true` until it
has been reliably green on hosted runners; screenshots of timeouts are
uploaded as the `e2e-artifacts` artifact.


The reading-rhythm scenario chooses a goal, imports and opens a book, checks the
continue-reading icon inside its existing card, read-only Statistics, and the
Settings dropdown goal after restart. The shelf flow starts selection through a
real right-click context menu, and the folder flow connects and rescans through
Settings. Neither requires added toolbar actions. Run E2E against a fixed copy
of the `e2e` feature binary when other Cargo checks could rebuild the default
binary at the same output path. Never run two gate scripts against that path.

The Workbench scenario asserts book title and author independently because the
current card presents them as separate labels. It returns to Highlights after
checking Notes; the current section tabs are Highlights, Notes, Words, and
Bookmarks. These checks preserve the original content/filtering coverage without
requiring the retired All tab or a particular separator character.

Uppercase Latin text and shifted punctuation use explicit Shift key actions in the WebKit driver helper:
the element send-keys path under the headless compositor was observed to turn
“Evening Reading” into lowercase. The shelf flow checks the textbox value before
creating the shelf and still requires the exact name after restart. Cover URL
checks also assert the exact typed URL: the driver’s direct send-keys path was
observed to turn colons into semicolons without an explicit Shift modifier.

Daily Review regressions cover persisted dismissal/completion across navigation
and restart, plus actual viewport and overflow geometry. The cover URL flow
serves an image from a loopback HTTP server with no CORS header and an
octet-stream content type; it checks native validation, save/restart persistence
without another download, and preservation of the cover after an invalid URL.
The reading setup flow verifies that completion survives restart and Settings
has no replay entry. Fresh profiles capture every setup and guide step at
desktop and phone widths; controls must fit the viewport with 44px touch targets.
The E2E feature alone lowers the desktop minimum window size for phone layouts.
