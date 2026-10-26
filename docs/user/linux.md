# Theorem on Linux: an Offline EPUB and PDF Reader

Install Theorem on Linux from a .deb or AppImage, read EPUB, PDF and comics offline, and learn where your data lives and how to update, move or remove it.

This page describes release v1.5.9, the latest release at the time of writing. It was checked against the v1.5.9 source code, the files attached to the v1.5.9 release, and the v1.5.9 `.deb` package, which was unpacked and run. For the general install steps on every system, see [Install Theorem](install.md). This page covers what is specific to Linux.

## Which Linux packages does the release contain?

The v1.5.9 release has two Linux files, both for 64-bit x86 (amd64):

| File | Use it for |
| :--- | :--- |
| `Theorem_1.5.9_amd64.deb` | Debian, Ubuntu and derivatives |
| `Theorem_1.5.9_amd64.AppImage` | Any other distribution |

Each file also has a `.sig` signature file next to it, which the in-app updater uses. There is no `.rpm`, no Flatpak, no Snap and no ARM (arm64) Linux build. Fedora, openSUSE and RHEL users take the AppImage. The `docs/PKGBUILD` file in the source repository is a template for an Arch package, not a published package, so do not expect `theorem` to be available from the AUR or any distribution repository.

## What does Theorem need on Linux?

The `.deb` package declares three dependencies: `libayatana-appindicator3-1`, `libwebkit2gtk-4.1-0` and `libgtk-3-0`. The program is also linked against ALSA (`libasound.so.2`), which the neural voice and audiobook player use for sound. On other distributions, install the equivalents of WebKitGTK 4.1, GTK 3 and the Ayatana app-indicator library before you run the AppImage.

The v1.5.9 release is built on Ubuntu 24.04. The program in the `.deb` needs glibc 2.39 or newer. That matches Ubuntu 24.04 and recent Fedora and Arch, but it is newer than Ubuntu 22.04 (glibc 2.35) and Debian 12 (glibc 2.36), where the program is expected to refuse to start with a "GLIBC_2.39 not found" error. This was read from the symbols in the unpacked `.deb` binary. The AppImage was not unpacked, so check it on your system.

For read-aloud with your system voice you also need speech-dispatcher, which provides the `spd-say` command. See [What works offline](#what-works-offline).

## How do I install it with the script?

1. Open a terminal and run:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/fundaments-work/Theorem/main/scripts/install-linux.sh | bash -s -- --version 1.5.9
   ```

2. If the script reports `Missing required command`, install `curl` and `bsdtar`. The script always needs `bsdtar`, even for a `.deb`. On Debian and Ubuntu it comes from the `libarchive-tools` package. It also needs `jq` unless you pass `--version`.
3. Start Theorem from your application menu, or run `theorem`.

Pass `--version 1.5.9` as shown. Without it, the script installs the newest non-beta release. Every release from v1.5.1 to v1.5.9 is marked as a pre-release on GitHub, so the newest non-beta release is v1.5.0, and that is what the plain command installs. Use `--beta` to take the newest pre-release instead.

| Option | What it does |
| :--- | :--- |
| `--version VERSION` | Install that version |
| `--beta` (or `--prerelease`) | Use the newest pre-release |
| `--bundle deb` or `--bundle appimage` | Force a package format. The script also accepts `rpm`, but no `.rpm` is published, so that download fails |
| `--print-latest` | Print the latest version number and stop (needs `jq`) |
| `-h`, `--help` | Show the usage text |

The script picks `deb` when `apt` or `dpkg` exists and `appimage` otherwise. It stops any running `theorem` process first. For a `.deb` it runs `sudo apt install -y --reinstall` on the file. For an AppImage it needs no root access:

- the AppImage goes to `~/.local/lib/theorem/Theorem.AppImage`
- a `theorem` link goes to `~/.local/bin/theorem`
- a launcher goes to `~/.local/share/applications/theorem.desktop`
- the icon goes to `~/.local/share/icons/hicolor/128x128/apps/theorem.png`

The script maps `aarch64` to `arm64` and then downloads an `arm64` file that the release does not contain, so it fails with a download error on ARM machines.

## How do I install it by hand?

1. Download the file from the [v1.5.9 release page](https://github.com/Fundaments-Work/Theorem/releases/tag/v1.5.9).
2. For the `.deb`, run `sudo apt install ./Theorem_1.5.9_amd64.deb`. The package puts the program at `/usr/bin/theorem`, so the `theorem` command works at once.
3. For the AppImage, run `chmod +x Theorem_1.5.9_amd64.AppImage` and then start it. To get a menu entry and the `theorem` command, use the install script instead, or see [command-line.md](command-line.md#how-do-i-put-theorem-on-my-path).

The `.deb` and the AppImage installed by the script register Theorem as a viewer for EPUB, MOBI, AZW, AZW3, FB2, CBZ, CBR and PDF files, so your file manager can offer to open a book with it.

## Where does Theorem keep my data?

Everything lives in one folder:

```
~/.local/share/work.fundamentals.theorem/
```

If you set `XDG_DATA_HOME`, the folder is under that location instead. These items were seen when the v1.5.9 program imported a book:

| Item | What it holds |
| :--- | :--- |
| `theorem.db` (plus `-wal` and `-shm` files) | The library, shelves, highlights, notes, settings and reading statistics (a SQLite database) |
| `book-cache/` | The copies of your books that Theorem keeps |
| `iroh-key` | The identity key for [device sync](device-sync.md), created when sync starts |
| `dictionaries/` | Offline dictionaries you installed. See [Dictionary and vocabulary](dictionary.md) |
| `tts/` | The neural voice files, if you downloaded them. See [Listening](listening.md) |

Your original book files are not touched, and Theorem does not need them after import. The Markdown notes exported for Obsidian or Logseq go to the folder you chose, not to this one. See [Markdown export](vault-sync.md).

## What works offline?

Once a book is in your library, reading needs no network. Searching inside a book, highlights, notes, bookmarks, shelves and reading statistics all work without it. The program contains the PDF engine and its fonts, so PDFs open offline too.

- **Dictionaries.** The online fallback needs a connection. After you download or import an offline dictionary, lookups run from disk. Downloading the English Wiktionary dictionary is the step that needs the network.
- **Read-aloud with your system voice.** Theorem runs `spd-say` from speech-dispatcher. If the command is missing, nothing is spoken. Install speech-dispatcher and a speech engine, such as espeak-ng.
- **Neural voice.** The neural voice is supported on Linux x86-64. It needs a one-time download of about 400 MB from Settings, General, Neural Voice. After that it works offline. On Linux on ARM the neural voice is not available. See [Listening](listening.md).

These need a connection: Discover, feeds, catalogs, the online dictionary, downloads of dictionaries and the neural voice, and update checks. [Device sync](device-sync.md) works on the same network or through an encrypted relay.

## Does Theorem work on Wayland, and what about graphics?

The source has no Wayland-specific code. At start-up on Linux, Theorem sets two options for the WebKitGTK web view, unless you set them yourself: `WEBKIT_DISABLE_DMABUF_RENDERER=1` and `GDK_DEBUG=gl-no-fractional`. They avoid common rendering problems with some graphics drivers. Hardware compositing stays on. To turn both workarounds off, start Theorem with `THEOREM_WEBKIT_WORKAROUNDS=0`. If your setup needs compositing off, set `WEBKIT_DISABLE_COMPOSITING_MODE=1` before you start it; a comment in the source names that variable. These settings apply to the app window only, not to terminal commands.

## How do I update Theorem?

1. Open Settings, select About, and click Check for Updates.
2. Follow the prompts. A beta build that finds a newer beta shows a View Beta Release link instead of installing it. Open it and download the new package.
3. Alternatively, run the install script again with the version you want. It stops Theorem, replaces the files and keeps your data.

The in-app installer downloads a signed update. Whether it can replace a `.deb` that was installed as root was not tested. If the update fails, use `sudo apt install ./<new file>.deb` or the script.

## How do I move my library to another computer?

1. Close Theorem on both computers.
2. Install the same Theorem version on the new computer and start it once, then close it.
3. Copy the whole `work.fundamentals.theorem` folder from the old computer into `~/.local/share/` on the new one, replacing the new folder.
4. Start Theorem. Your books, highlights and settings should appear.

This was not tested end to end. The folder includes `iroh-key`, the sync identity, so if you use device sync, do not run the old and new copies side by side with the same key. For supported ways to share a library, pair the two computers with [device sync](device-sync.md), or create a backup file and restore it on the new computer. See [Settings and shortcuts](settings-and-shortcuts.md#back-up-your-library).

## How do I uninstall it?

1. Close Theorem.
2. For the `.deb`, run `sudo apt remove theorem`.
3. For the AppImage install, delete `~/.local/lib/theorem`, `~/.local/bin/theorem`, `~/.local/share/applications/theorem.desktop` and the icon `~/.local/share/icons/hicolor/128x128/apps/theorem.png`.
4. To delete your library as well, remove `~/.local/share/work.fundamentals.theorem`. This cannot be undone. Export anything you need first.

## Troubleshooting

- **The script fails at once with a missing command.** Install `curl`, `bsdtar` and `jq`.
- **The script cannot download a file.** The release has no `.rpm` and no ARM Linux file. Use `--bundle appimage` on an RPM-based system, and use an x86-64 computer.
- **The program stops with "GLIBC_2.39 not found".** Your distribution is older than the build. Upgrade it.
- **The window is blank or flickers.** The default workarounds above are already on. Try `WEBKIT_DISABLE_COMPOSITING_MODE=1 theorem`.
- **Nothing is spoken.** Install speech-dispatcher so that `spd-say` works. See [Troubleshooting](troubleshooting.md#speech-and-audiobooks).
- **The `theorem` command is not found.** For an AppImage install, add `~/.local/bin` to your `PATH`.
- **You want logs.** Start Theorem from a terminal. It writes messages to standard output and standard error.

## Sources

- GitHub release v1.5.9 and its file list: https://github.com/Fundaments-Work/Theorem/releases/tag/v1.5.9
- Install script: https://github.com/fundaments-work/Theorem/blob/main/scripts/install-linux.sh
- Theorem v1.5.9 source code and `.deb` package (dependencies, glibc symbols, data folder, start-up settings).

Last checked: October 2026.
