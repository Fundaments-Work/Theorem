# Troubleshooting

Fix common problems with importing and opening books, search, sync, dictionaries, speech, Markdown export and updates, and find out how to report a bug.

## Importing and opening books

### A book will not import

1. Check the file extension. Theorem imports `.epub`, `.mobi`, `.azw`, `.azw3`, `.fb2`, `.fbz`, `.fb2.zip`, `.cbz`, `.cbr` and `.pdf` files.
2. Make sure the file is DRM-free. Theorem does not open files protected by DRM.
3. After an import, look for a dialog titled Import Errors. It lists the first few files that failed and the reason for each.
4. Try the file again on its own, in case one file in a large batch is damaged.

A file whose contents are the same as a book already in your library is skipped as a duplicate. That is not an error.

### A folder scan finds nothing

If Theorem shows No Books Found, the folder has no supported files in it or its subfolders. If the scan stops with a message about names that cannot be preserved, run the scan again with Import as a flat library.

### A book shows No file

A book that arrived from another device through [device sync](device-sync.md) does not have its file yet.

1. Make sure the device that has the file is on and running Theorem.
2. Open the book, or right-click it and choose More..., then Download File.
3. If you see Book download timed out, click Try Again.

### Search in a book finds nothing

Search finds the exact letters you type. Check the spelling and turn off Match Case and Match Whole Word. Text that is part of an image, such as a scanned page, cannot be searched.

## Reader controls that are missing

- **Speed Read button.** Turn on Speed Read in Settings, General. It is not available for PDFs.
- **Headphones button (Immersion Reading).** It is not shown for PDFs.
- **Present and Print.** These exist only for PDFs on desktop, not on Android.
- **Full screen.** Not shown on Android.
- **Keyboard shortcuts do nothing.** They are ignored while the cursor is in a text box. Click outside the box first.

## Dictionary and vocabulary

- **No definition found.** Install an offline dictionary, as described in [Dictionary and vocabulary](dictionary.md#install-an-offline-dictionary). Without one, Theorem asks an online service, which needs an internet connection and does not know every word.
- **Save to Vocabulary is not available.** Turn on Vocabulary Lookup in Settings, General.
- **Dictionary files will not import.** Select all the files of one StarDict dictionary at once. For an MDict dictionary, use Download Dictionary.

## Speech and audiobooks

- **Nothing is spoken on Linux.** Theorem calls the `spd-say` command from speech-dispatcher. Install speech-dispatcher and a speech engine, then try again.
- **The neural voice will not download.** Check your internet connection and free disk space, and try again. The neural voice is supported on Linux x86-64, Windows x64 and Apple Silicon Macs. Intel Macs, Windows and Linux on ARM, and Android do not use it, and on those computers Settings says it is not available instead of offering a download.
- **I do not see Neural Voice in Settings.** It appears on desktop only while Text-to-Speech is turned on.
- **On Android the engine list is empty.** The Voice engine menu says No engines found when no speech engine is installed. Install one, such as the Theorem Neural Voice app.
- **The audiobook will not play.** Theorem links to the audio file where it was when you attached it. If you moved, renamed or deleted it, detach the audiobook and attach the file again.

## Device sync

- **The other device does not appear or does not sync.** Both devices must be running Theorem and be paired. Open Settings, Devices & Export, check the Paired Devices list and click Sync Now. If the This Device card says Pair a device to enable incoming sync, you have not paired yet.
- **Pairing fails.** Make sure the pairing code is complete when you paste it, and try Show Pairing QR again to get a fresh code.
- **QR scanning does not work.** Scanning works only in the Android app, and only after you allow camera access. On desktop, paste the pairing code instead.
- **A sync is stuck.** Click Cancel next to the device and try Sync Now again.

## Discover and feeds

- **Discover says Could not connect to online libraries.** Check your internet connection and click Try Again.
- **A feed will not add.** Check that the address is correct. If you gave a normal web page, the page may not advertise a feed, so look for the feed address on the site. The browser demo can be blocked by websites that do not allow it to fetch feeds, so use the desktop or Android app for feeds.
- **New articles do not appear.** Feeds refresh when you click Refresh, not automatically.
- **Articles disappeared.** Check Article Retention Period in Settings, General. Read articles you have not favorited or saved are removed once they are older than the period.

## Catalogs in Discover

> **New in Theorem 1.6.0, not released yet.** Your own catalogs are in version 1.6.0. The latest release, 1.5.9, does not have them, so this section applies to 1.6.0.

- **A catalog will not open.** Read the message on the page. "Could not reach the catalog" means the address or your connection is wrong. For a server on your network, check that the computer running it is on and that your phone or computer is on the same network. "Not found (404)" means the address is wrong, and "Access denied" means the catalog refused your request.
- **Check address says the address is a web page.** The address you gave is the library's website, not its catalog. Look for an OPDS or catalog link on the site, or ask the library for the OPDS address.
- **The catalog asks for a sign-in again and again.** The username or password is not accepted. Tap Forget sign-in in the three-dot menu and sign in again. Some libraries sign in with a method Theorem cannot use yet, and the form says so.
- **A book shows View instead of Get.** The catalog lists it for sale, as a loan, or locked with DRM. Open it to see which, and use the website button if there is one. See [Discover free books](discover.md#books-you-cannot-download).
- **A download says the server returned a web page instead of a book.** The link led to a login, loan or purchase page. Sign in to the catalog, or use the library's own site for that book.
- **A catalog works in the desktop app but not in the browser demo.** Websites can stop a browser from reading a catalog. Use the desktop or Android app.
- **A list stopped loading.** Tap Load more, or the refresh button to start the list again.

## Markdown export

- **No files appear in the vault.** Open Settings, Devices & Export, Markdown Export. Make sure Export Folder is set, then click Export now. The Export Status line shows whether the export worked. If it says Set an export folder first, pick a folder.
- **A book has no file.** Only books with highlights get a note. Bookmarks are not exported.
- **I cannot choose a folder on Android.** The export folder setting is not available on Android. See [Markdown export for Obsidian and Logseq](vault-sync.md).
- **The notes look different from what I expect.** Change the Export Preset or Highlight Grouping, or write a Custom (Knap) template.

## Installing and updating

- **macOS says the app is from an unidentified developer.** Allow it in System Settings, Privacy and Security, then open it again. See [Install Theorem](install.md#install-on-macos).
- **Android will not install the APK.** Allow installs from your browser or file manager when Android asks. Use the 64-bit `arm64` file on most phones.
- **Check for Updates says Not Available on Android.** The in-app updater is for desktop only. Install a newer APK by hand.
- **The Linux install script cannot find a package.** Only `.deb` and `.AppImage` files are published. On Fedora and other RPM-based systems, the script installs the AppImage.

## Where your data is and how to see logs

Theorem keeps its library database and book copies in its app data folder. On Linux that folder is `~/.local/share/work.fundamentals.theorem/`. Theorem writes log messages to standard output, so on Linux you can start it from a terminal to see them.

## Report a problem

Open Settings, select the About tab, and click Report an Issue under Links. This opens the issue tracker on GitHub. Include your Theorem version, which the About tab shows, your operating system, and the steps that cause the problem.
