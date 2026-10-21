# Theorem vs the Calibre E-book Viewer

Theorem and the Calibre E-book viewer both read DRM-free books on your own computer, but they differ on platforms, highlight export and library management.

The two tools are not direct substitutes. Calibre is an e-book manager that includes a viewer, a converter, an editor and a content server. Theorem is a reader first, with a library built around reading, highlighting and exporting notes. Many people already have Calibre for managing files, so the useful question is which one you want to read in.

## Short answer

Choose the Calibre viewer if you already manage your books in Calibre, need to convert formats, or read on a Windows, macOS or Linux computer only. Choose Theorem if you also read on Android, want highlights written to Markdown files for Obsidian or Logseq as you read, or want PDFs, comics and RSS articles in the same app as your books. You can use both: Calibre for the library and conversion, Theorem for reading. See [using both](vs-calibre-viewer.md#using-both).

## Comparison table

| Topic | Theorem | Calibre E-book viewer |
| :--- | :--- | :--- |
| Platforms | Linux, macOS, Windows and Android ([install](install.md)) | Linux, Windows and macOS. Calibre "does not run on phones/tablets"; on a phone you use its Content server in a browser |
| Formats opened | EPUB, MOBI, AZW, AZW3, FB2, PDF, CBZ, CBR ([details](supported-formats.md)) | "All the major e-book formats"; the viewer page gives no list. The converter accepts a long list, including CBZ, CBR, PDF, MOBI and DOCX |
| DRM | DRM-free files only | Does not open DRM-protected books |
| Highlights and notes | Six colours; notes; PDF pen, text notes and eraser ([guide](highlights-and-notes.md)) | Highlights in several styles with notes and colours; a Highlights panel; a library-wide "Browse annotations" tool |
| Export of highlights | Markdown files, one per book, in a folder you choose, with Obsidian, Logseq, Minimalist and custom-template styles. Desktop apps only ([how it works](vault-sync.md)) | The viewer page does not describe export. Calibre's release notes mention exporting from the annotations browser to Markdown and, since version 9.11, to an HTML page |
| Where highlights live | In Theorem's own library on your device; copied to Markdown by export | By default, in the book file for EPUB books and also in the Calibre library |
| Dictionary | Offline StarDict and MDict dictionaries, an English Wiktionary download, and an online English fallback ([dictionary](dictionary.md)) | Lookup through online sources such as Google dictionary and Wordnik, or a custom URL (a local server works). An offline built-in dictionary is not stated |
| Text-to-speech | System voices on desktop and Android; an offline neural voice on desktop; not for PDFs ([listening](listening.md)) | Piper neural engine or the operating system's voices, with the current word or sentence highlighted |
| Search inside a book | Exact text, match case, whole word | Contains, whole words, nearby words and regular expressions |
| Sync between devices | Direct device-to-device sync, no account ([device sync](device-sync.md)) | Highlights can sync with the Content server's browser viewer. Other cross-device sync is not stated |
| Account | None | Not described for the viewer |
| RSS | Built-in feed reader ([feeds](feeds.md)) | Not part of the viewer. Calibre can download news and convert it to e-books |
| Library management | Shelves, series, tags, search and filters | Full e-book management, conversion, metadata editing, device transfer |
| Licence | MIT | GPL-3.0 |
| Cost | Free. See the [releases page](https://github.com/fundaments-work/theorem/releases) | Described as free, with optional donations. See the Calibre site |

## Choose Theorem if

- You read on Android as well as on a computer. Calibre does not run on phones or tablets, and Theorem has an Android app.
- You want highlights to arrive as Markdown in an Obsidian or Logseq folder without a separate export step. Theorem rewrites the files a couple of seconds after you change a highlight. This runs in the desktop apps. On Android you highlight on the phone and the notes reach your vault after a [sync](device-sync.md) to a desktop.
- You mark up PDFs with a pen and text notes, or read comics (CBZ and CBR) next to your books. See [annotate PDFs](annotate-pdfs.md).
- You want offline dictionaries in StarDict or MDict format to be the first place a word is looked up.
- You want sync between your own devices without running a server.

## Choose the Calibre viewer if

- Your books already live in Calibre, and you want to open them without importing them anywhere else.
- You need to convert between formats, edit metadata in bulk, or send books to an e-reader. Theorem does none of these.
- You want regular-expression or nearby-word search inside a book.
- You want a reader that can also open the many other formats the Calibre converter handles. Check the Calibre manual for what the viewer itself opens.
- You want highlights stored inside the EPUB file itself (Calibre's default for EPUB books), so they travel with it.

## Using both

A common setup is to keep Calibre as the place where files are organised and converted, then add the finished DRM-free files to Theorem with Add Books or a folder scan ([library and import](library-and-import.md)). Theorem copies each book into its own storage, so the two libraries are independent: highlights made in one do not appear in the other.

## Do I need to move my Calibre library to use Theorem?

No. Theorem imports copies of files. Your Calibre library is not changed, and nothing links the two afterwards.

## Can both tools open the same Kindle books?

Only if the files are DRM-free. Neither tool opens DRM-protected files. Calibre explains on its DRM page that it does not support opening or viewing DRM files, and Theorem's [troubleshooting page](troubleshooting.md) says the same.

## Sources

Calibre facts below come from Calibre's own site and manual. Theorem facts come from the Theorem app and the other pages in this guide.

- [E-book viewer manual](https://manual.calibre-ebook.com/viewer.html): platforms, highlights, notes, dictionary sources, text-to-speech, search modes, bookmarks, Content server sync.
- [About calibre](https://calibre-ebook.com/about): what calibre is, "completely free and open source", news download. The download pages carry a request to contribute.
- [calibre on GitHub](https://github.com/kovidgoyal/calibre): GPL-3.0 licence (the README says "running on Linux, Windows and macOS"; the repository's COPYRIGHT file lists "License: GPL-3").
- [Download page](https://calibre-ebook.com/download): Windows, macOS, Linux and portable downloads; a separate link for phones and tablets.
- [Calibre on mobile](https://calibre-ebook.com/download_android): "calibre itself does not run on phones/tablets"; USB and Content server options.
- [FAQ](https://manual.calibre-ebook.com/faq.html): the conversion input formats list.
- [DRM page](https://manual.calibre-ebook.com/drm.html): "If calibre were to support opening or viewing DRM files" it could be used for DRM removal, so it does not support DRM files.
- [New in calibre 5.0](https://calibre-ebook.com/new-in/fourteen): highlights stored in the book file and in the library, highlight styles, notes, Browse annotations.
- [User interface manual](https://manual.calibre-ebook.com/gui.html): the Browse annotations action.
- [What's new](https://calibre-ebook.com/whats-new): a fix to "exporting highlights in markdown" from the annotations browser (Markdown export exists), and release 9.11, which added exporting annotations as HTML.

Not stated in these sources: a full list of formats the viewer opens, an offline built-in dictionary, and any account requirement for the viewer.

Last checked: October 2026.
