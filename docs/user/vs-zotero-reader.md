# Theorem vs the Zotero Reader

Theorem and the Zotero Reader both annotate PDFs and EPUBs on your device, but they differ on sync, annotation export and what each app is built for.

Zotero is a research tool for collecting, organising, annotating and citing sources. Its reader is one part of that, attached to items in your Zotero library. Theorem is a reader for ebooks, PDFs, comics and RSS articles that writes highlights as Markdown files. The two overlap on one task: reading and annotating a PDF or EPUB.

## Short answer

Choose Zotero if your reading is research: you need citations, a bibliography, tags and collections, and your annotations feed into notes and papers. Choose Theorem if you read books and long articles for pleasure or study, want comics and Kindle-format files supported, or want highlights to land as Markdown files in an Obsidian or Logseq folder. Zotero and Theorem can run side by side. See [using both](vs-zotero-reader.md#using-both).

## Comparison table

| Topic | Theorem | Zotero Reader |
| :--- | :--- | :--- |
| Platforms | Linux, macOS, Windows and Android ([install](install.md)) | Windows, macOS, Linux, iOS and Android (Zotero download page) |
| Formats read | EPUB, MOBI, AZW, AZW3, FB2, PDF, CBZ, CBR ([details](supported-formats.md)) | PDF, EPUB and web page snapshots. MOBI, FB2 and comic formats are not stated |
| DRM | DRM-free files only | Not stated |
| Annotation types | Highlights in six colours and notes on every text format; on PDFs also a pen, text notes and an eraser ([PDF guide](annotate-pdfs.md)) | Highlight and underline on PDFs, EPUBs and snapshots; sticky notes on EPUBs and snapshots; text, image and ink annotations in the PDF view |
| Where annotations live | In Theorem's own library on your device. PDF files are not modified | In the Zotero database, not in the PDF file |
| Export of annotations | Markdown files, one per book, in a folder you choose, with Obsidian, Logseq, Minimalist and custom-template styles. Desktop apps only ([how it works](vault-sync.md)) | A PDF with embedded annotations; annotations added to Zotero notes through HTML note templates; annotations included when exporting BibTeX or RIS with files. Markdown export is not stated, and Zotero says it plans other export methods |
| Dictionary | Offline StarDict and MDict dictionaries and an online English fallback ([dictionary](dictionary.md)) | Not stated |
| Read aloud | System voices on desktop and Android; an offline neural voice on desktop; not for PDFs ([listening](listening.md)) | Works on PDFs, EPUBs and snapshots. High-quality "Zotero Voices" need an internet connection and a Zotero account; offline it uses system voices at lower quality. Desktop first, iOS since October 2026, Android announced as coming |
| Sync | Direct device-to-device sync, no account ([device sync](device-sync.md)) | Needs a Zotero account. Data sync is free and unlimited; file sync is separate, with 300 MB of free storage and larger plans for purchase; WebDAV is an option for files |
| Account | None | Needed for syncing; whether the app works fully without one is not stated |
| Citations and bibliography | None | Core purpose of Zotero |
| RSS | Built-in feed reader ([feeds](feeds.md)) | Not stated for the reader |
| Licence | MIT | AGPL-3.0 |
| Cost | Free. See the [latest release](https://github.com/fundaments-work/theorem/releases/latest) | Free software with paid storage plans. See Zotero's storage page |

## Choose Theorem if

- You read books, not just papers: Kindle-format files (MOBI, AZW, AZW3), FictionBook and comics are supported alongside EPUB and PDF. See [supported formats](supported-formats.md).
- You want a highlight in a book to become a Markdown note in your vault without extra steps. In Theorem that happens in the desktop apps a couple of seconds after the change; on Android the phone's highlights reach your vault after a [sync](device-sync.md) to a desktop.
- You want to keep everything on your own devices with no account, including sync between them.
- You want offline dictionaries and a vocabulary list that exports to Markdown.
- You want listening that works offline with a neural voice on desktop.

## Choose the Zotero Reader if

- You manage sources for research and need annotations tied to library items, with citations, tags and collections.
- You want to insert annotations into notes or word-processor documents with citations. Zotero's note templates and word-processor plugins do this; Theorem does not.
- You want a PDF with the annotations embedded, to share with someone who does not use Zotero. Theorem does not write marks into the PDF.
- You want to annotate EPUBs and web page snapshots next to your references; Zotero's announcement covers desktop and iOS for this.
- You are happy to use a Zotero account for sync and cloud-generated reading voices.

## Using both

Keep papers and citable sources in Zotero and books in Theorem. They do not share annotations: each stores its marks in its own library. If you read a PDF in both, you will have two sets of highlights. Pick one reader per document.

## Can Theorem export annotations as a PDF?

No. Theorem keeps PDF highlights, pen strokes and text notes in its own library and writes only highlights and notes to Markdown. The original file is left as it was.

## Does Zotero export highlights to Markdown?

The Zotero pages checked do not describe a Markdown export. They describe PDF export with embedded annotations and notes built from HTML templates. Check Zotero's support pages for current options.

## Sources

Zotero facts come from zotero.org documentation and blog posts, plus the Zotero source repository. Theorem facts come from the Theorem app and the other pages in this guide.

- [PDF reader documentation](https://www.zotero.org/support/pdf_reader): highlight and underline modes, annotations in notes, annotations in the database.
- [Annotations in the database](https://www.zotero.org/support/kb/annotations_in_database): annotations are not stored in the PDF file; export to PDF with embedded annotations; BibTeX and RIS option; plans for other export methods.
- [Note templates](https://www.zotero.org/support/note_templates): HTML note templates for annotations.
- [Syncing](https://www.zotero.org/support/sync): account requirement, data sync versus file sync, 300 MB free storage, WebDAV.
- [Your data](https://www.zotero.org/support/zotero_data): local data directory and SQLite database; syncing described as optional.
- [Download page](https://www.zotero.org/download/): Windows, macOS, Linux, iOS and Android.
- [About Zotero](https://www.zotero.org/about/): free, open-source, nonprofit.
- [Zotero source repository licence](https://raw.githubusercontent.com/zotero/zotero/main/COPYING): AGPL version 3.
- [Zotero 9 announcement](https://www.zotero.org/blog/zotero-9/): Read Aloud on PDFs, EPUBs and snapshots; internet and account for high-quality voices; system-voice fallback; reading position sync; word-processor annotations.
- [Zotero 10 announcement](https://www.zotero.org/blog/zotero-10/): text, image and ink annotations appear only in the PDF view for now; Reading Mode.
- [EPUB and snapshot annotation on iOS](https://www.zotero.org/blog/ios-epub-snapshot-annotation-and-pdf-metadata-retrieval/): highlights, underlines and sticky notes for EPUBs and snapshots.
- [Read Aloud on iOS](https://www.zotero.org/blog/read-aloud-on-ios/): Read Aloud available on iOS, October 2026.

Not stated in these sources: dictionary lookup, Markdown export, DRM handling, MOBI, FB2 or comic support, and whether an account is required to use the app without sync. Prices are not given here; see Zotero's storage documentation.

Last checked: October 2026.
