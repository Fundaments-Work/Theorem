# Supported Ebook, PDF and Comic Formats

Theorem opens DRM-free EPUB, MOBI, AZW, AZW3, FB2, PDF, CBZ and CBR files plus RSS feeds; this page shows what works in each format and on each platform.

This page describes Theorem 1.6.0. It lists exactly which files Theorem imports, what you can do in each format, and where the desktop and Android apps differ.

## Which file types does Theorem open?

Theorem imports files by extension. These are the supported types:

| Format | Extensions | Notes |
| :--- | :--- | :--- |
| EPUB | `.epub` | Reflowable text |
| Kindle | `.mobi`, `.azw`, `.azw3` | DRM-free files only |
| FictionBook | `.fb2`, `.fbz`, `.fb2.zip` | Reflowable text |
| Comic archives | `.cbz`, `.cbr` | Page images. A CBR (RAR) archive is converted to CBZ when imported, and Theorem does this itself; you do not need a separate RAR tool |
| PDF | `.pdf` | Opens in its own PDF reader |
| RSS, Atom and JSON Feed | Feed addresses, not files | Articles open in the same reader as books. See [feeds and articles](feeds.md) |

Not supported: DjVu, TXT, HTML, DOCX, RTF, CHM, XPS and other formats that are not in the table. You can also attach an `.m4b`, `.m4a` or `.mp3` audiobook to a book, but that is a companion file, not a book format. See [listening](listening.md#attach-an-audiobook).

To add files, use Add Books or scan a folder. Steps are in [library and import](library-and-import.md#add-books). Theorem copies each file into its own storage, so the original stays where it was.

## Does Theorem open DRM-protected books?

No. Only DRM-free files open. Theorem has no code that removes DRM, so books from a store that locks them to an app or device (for example a protected Kindle or Adobe file) are not supported and may fail to import or open. If a store offers a DRM-free download, use that. See [troubleshooting](troubleshooting.md) if a file will not open.

## What can I do in each format?

All five reflowable formats (EPUB, MOBI, AZW, AZW3 and FB2) open in the same reader, so they behave alike. Comics and PDFs use fixed pages, and PDFs have their own reader. Articles from feeds open in the reflowable reader too.

| Feature | EPUB, MOBI, AZW, AZW3, FB2 | CBZ, CBR | PDF | RSS articles |
| :--- | :--- | :--- | :--- | :--- |
| Highlights | Yes, six colours, merged when they overlap in a chapter | Not applicable: pages are images with no text to select | Yes, with the Highlight tool; per page and not merged | Yes |
| Notes | Yes, on any highlight | Not applicable | Text notes placed on the page, and notes on a highlight from the Annotations panel | Yes |
| Pen and eraser | No | No | Yes | No |
| Bookmarks | Yes | Yes | Yes | Yes |
| Search inside the book | Yes: exact text, match case, whole word | Not applicable | Yes, on text the PDF contains | Yes |
| Dictionary lookup (Define) | Yes | Not applicable | Yes, from the Copy and Define pop-up | Yes |
| Read aloud (text-to-speech) | Yes | No text to read | No | Yes |
| Text size, font and spacing | Yes (Type tab) | No: a Zoom tab replaces it | No: zoom, fit page, fit width, rotate | Yes |
| Light, Sepia and Dark themes | Yes | Yes | No: pages are drawn as the file draws them | Yes |
| Written to the Markdown export | Highlights and notes | Nothing | Highlights and notes; see the caution below | Highlights and notes |
| Reading position remembered | Yes | Yes | Yes, with zoom and layout | Yes |

Settings and shortcuts for the reader are in [reading](reading.md). Highlights and notes are in [highlights and notes](highlights-and-notes.md). PDF tools are in [annotate PDFs](annotate-pdfs.md).

### PDF notes

- PDF text tools (search, highlight, Define) need text the PDF actually contains. Theorem has no OCR, so on a scanned PDF without a text layer those tools find nothing. The pen and text-note tools still work.
- PDF zoom runs from 25 to 500 percent. Layouts are Continuous, Single and Facing.
- Page labels, such as roman numerals, are shown and accepted when you jump to a page.
- Files embedded inside a PDF are listed in Book Info with a Save button.
- Theorem stores PDF highlights, pen strokes and notes in its own library. It does not write them into the PDF file.

### Other reader notes

- Speed Read, an opt-in setting, works in reflowable books and is not available for PDFs.
- In EPUB and similar books, footnote and citation markers open in a small pop-up. In PDFs, hovering over an internal link previews its target.

### Comic notes

- Comics open page by page, with a zoom control. If the archive contains `ComicInfo.xml`, Theorem reads the title, series and issue number (the Title, Series and Number fields) from it.
- Because a CBR is converted at import, the copy in your library is a CBZ.
- Read aloud, search and Define have no text to work on in comics.

## What is different on each platform?

The formats are the same on Linux, macOS, Windows and Android. The differences are in the tools around them.

| Platform | Open all formats above | PDF Present and Print | System voice for read aloud | Offline neural voice | Generate an audiobook (needs the neural voice) | Markdown export folder |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Linux | Yes | Yes | Yes, through speech-dispatcher | Yes, 64-bit x86 | Yes | Yes |
| macOS | Yes | Yes | Yes, built-in voices | Yes, Apple Silicon only | Yes | Yes |
| Windows | Yes | Yes | Yes, installed Windows voices | Yes, 64-bit | Yes | Yes |
| Android | Yes | No | Yes, the speech engine you choose in Settings | Through the free Theorem Neural Voice companion app | No | No export folder; highlights reach your vault after a [sync](device-sync.md) to a desktop |

- Neural voice on desktop needs a one-time download of about 400 MB. Intel Macs and ARM Windows or Linux computers are not supported for it. Details are in [listening](listening.md#install-the-neural-voice-desktop).
- The Android app is installed from an APK file and needs Android 7.0 or newer. See [install](install.md).
- Open a book in a separate window is desktop only.
- The browser demo at read.fundaments.work is limited: it has no Markdown export, device sync or text-to-speech, and CBR comics need the desktop or Android app.

## What reaches the Markdown export?

Only highlights and notes are written to your Markdown folder, one file per book. Bookmarks are not. The export runs in the desktop apps. See [Markdown export](vault-sync.md).

Caution for PDFs: a pen stroke is stored as a note whose selected text is the placeholder "Freehand annotation" and which has no note text. The exporter writes every highlight and note, so a stroke is written as one quoted line with that text and no drawing. A PDF text note has its text stored as both the quoted text and the note, so it is written twice. Check your first export if you use the pen and text tools. Details are in [annotate PDFs](annotate-pdfs.md#what-is-exported-to-markdown).

## Is there anything else I should know about importing?

- Files with identical contents count as duplicates, and only the first import is kept.
- Importing a folder with Scan reads supported files in subfolders and leaves the originals in place.
- If some files fail to import, a dialog lists the first three with the reason.
