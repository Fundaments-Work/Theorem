# Theorem vs KOReader

Theorem and KOReader are both open-source readers that keep your books on your device, but they differ on target hardware, formats and where highlights go.

KOReader is a document viewer written mainly for E Ink devices such as Kindle, Kobo and PocketBook, and it also runs on Android and desktop Linux. Theorem is an app for computers and Android phones and tablets. If your main reading device is an e-ink reader, KOReader is the one that runs there. If you read on a computer or phone, the comparison is closer.

## Short answer

Choose KOReader if you read on an e-ink device, want a longer format list (DjVu, XPS, CBT, DOC, RTF and more), or want to tune typesetting and run plugins. Choose Theorem if you read on Windows, macOS, Linux or Android, want a graphical library with shelves and statistics, or want highlights written continuously into an Obsidian or Logseq folder. Many people use KOReader on an e-ink device and Theorem on a computer or phone. See [using both](vs-koreader.md#using-both).

## Comparison table

| Topic | Theorem | KOReader |
| :--- | :--- | :--- |
| Platforms | Linux, macOS, Windows and Android ([install](install.md)) | Kindle, Kobo, PocketBook, reMarkable and Cervantes devices, Android and desktop Linux. On macOS, the wiki says there are no binary downloads on the release page yet and builds are unsigned; native Windows install is not stated |
| Formats opened | EPUB, MOBI, AZW, AZW3, FB2, PDF, CBZ, CBR ([details](supported-formats.md)) | EPUB, PDF, DjVu, XPS, CBT, CBZ, FB2, PDB, TXT, HTML, RTF, CHM, DOC, MOBI and ZIP. DRM handling is not stated |
| Highlights | Six colours, notes, bookmarks; PDF pen, text notes and eraser ([guide](highlights-and-notes.md)) | Four styles (lighten, underline, strikeout, invert), colour on colour screens, notes, editable highlight text. Highlights can be saved into PDF files |
| Export of highlights | Continuous Markdown export to a folder you choose, with Obsidian, Logseq, Minimalist and custom-template styles. Desktop apps only ([how it works](vault-sync.md)) | Export Highlights plugin: text, HTML, Markdown, Kindle Clippings and JSON files, plus services such as Joplin and Readwise. Obsidian is not mentioned in the sources checked |
| Dictionary | Offline StarDict and MDict dictionaries, an English Wiktionary download, and an online English fallback ([dictionary](dictionary.md)) | StarDict dictionaries, which can be downloaded inside KOReader, plus Wikipedia lookup. Offline use is not stated explicitly |
| Text-to-speech | System voices on desktop and Android; an offline neural voice on desktop; not for PDFs ([listening](listening.md)) | Not stated in the guides checked |
| Sync | Direct device-to-device sync of library, highlights, notes and progress, no account ([device sync](device-sync.md)) | A progress-sync plugin keeps reading position in step between KOReader devices and needs an account on the KOReader sync server. What else it syncs is not stated |
| RSS and catalogs | Built-in RSS, Atom and JSON Feed reader ([feeds](feeds.md)) | A News downloader plugin saves RSS and Atom entries as HTML files; an OPDS catalog plugin; a Wallabag plugin |
| Account | None | Only for the progress-sync plugin |
| Licence | MIT | AGPL-3.0 |
| Cost | Free. See the [latest release](https://github.com/fundaments-work/theorem/releases/latest) | Not stated on the pages checked; the project accepts donations. See the KOReader site |

## Choose Theorem if

- You read on a computer or an Android phone and want a conventional graphical app with a library, shelves, filters and reading statistics.
- You want highlights to appear in an Obsidian or Logseq folder as you make them. Theorem rewrites the Markdown files a couple of seconds after a change. This runs in the desktop apps; on Android you highlight on the phone and the notes reach your vault after a [sync](device-sync.md) to a desktop.
- You want sync between your own devices without registering an account anywhere.
- You want a built-in offline neural voice on desktop, or the system voice on Android. See [listening](listening.md).
- You want a feed reader in the same app as your books.

## Choose KOReader if

- Your reading device is an e-ink reader. Theorem does not run on Kindle, Kobo or PocketBook devices.
- You need formats Theorem does not open, such as DjVu, XPS, CBT, RTF or DOC.
- You want fine control over typesetting, hyphenation dictionaries and device-specific settings, or you want to extend the app with plugins.
- You read scanned PDFs and want reflow, cropping or OCR tools. KOReader's guide lists these; Theorem has no OCR and shows PDF pages as the file draws them.
- You want highlights saved into the PDF file itself. Theorem keeps PDF marks in its own library and does not modify the PDF.

## Using both

A practical split is KOReader on an e-ink device and Theorem on a computer or phone. Each keeps its own library, highlights and reading position, because KOReader's progress sync is between KOReader devices. If you want both sets of highlights in one vault, KOReader's Export Highlights plugin can write Markdown and Theorem writes to the folder you choose, but the two use different file layouts, so they do not merge into one note per book.

## Does Theorem run on e-ink readers?

Theorem has an Android app, but this guide does not cover e-ink devices and the app has no e-ink mode. See [install](install.md) for the Android version it needs.

## Can KOReader write Markdown for Obsidian?

KOReader's Export Highlights plugin can write Markdown files. Its documentation does not mention Obsidian or say which folder the files go to, so check the KOReader wiki for the current behaviour.

## Sources

KOReader facts come from KOReader's own site, GitHub repository and wiki. Theorem facts come from the Theorem app and the other pages in this guide.

- [koreader.rocks](https://koreader.rocks/): "a document viewer for E Ink devices", devices, the format list.
- [KOReader on GitHub](https://github.com/koreader/koreader): AGPL-3.0 licence, platforms, reflowable and fixed formats, plugins and integrations, donations.
- [User guide](https://koreader.rocks/user_guide/): highlight styles, notes, saving highlights into PDFs, dictionary lookup, Wikipedia lookup, exporting highlights, the News downloader, OPDS and Wallabag plugins. Text-to-speech does not appear in the guide.
- [Highlight export wiki page](https://github.com/koreader/koreader/wiki/Highlight-export): export targets and formats; Obsidian and save location not mentioned.
- [Dictionary support wiki page](https://github.com/koreader/koreader/wiki/Dictionary-support): StarDict dictionaries and where to get them.
- [Progress sync wiki page](https://github.com/koreader/koreader/wiki/Progress-sync): account requirement, what is sent, matching by file.
- [Features list wiki page](https://github.com/koreader/koreader/wiki/Features-list): OPDS support including the Calibre Content Server catalog.
- [Installation on Android](https://github.com/koreader/koreader/wiki/Installation-on-Android-devices): not on Google Play; F-Droid or APK.
- [Installation on desktop Linux](https://github.com/koreader/koreader/wiki/Installation-on-desktop-Linux): deb, Flatpak and AppImage.
- [Installation on macOS](https://github.com/koreader/koreader/wiki/Installation-on-MacOS): no release-page binaries yet; unsigned builds.
- [KOReader wiki home](https://github.com/koreader/koreader/wiki): device installation guides, including a Windows-with-WSL entry.

Not stated in these sources: text-to-speech, DRM handling, cost, offline dictionary behaviour, a save location for exported files, and what the progress-sync plugin covers beyond reading progress.

Last checked: October 2026.
