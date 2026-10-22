# Theorem vs Readwise Reader

Theorem keeps books and highlights on your device with no account, while Readwise Reader is a hosted reading service that signs in with a Readwise account.

Both apps collect long reading in one place: books, PDFs and feeds, with highlights you can export. They differ in where the data lives and how you pay. Theorem is a free app that stores everything on your own devices. Readwise Reader is part of Readwise, a hosted service for saving articles, newsletters, videos and documents, and it needs a Readwise account.

## Short answer

Choose Readwise Reader if you mostly read web articles and newsletters, want to save links from a browser or phone share sheet, and are happy to use a subscription service that syncs across the web, iOS, Android, Mac and Windows. Choose Theorem if you mostly read book files, PDFs and comics, want no account, and want highlights written as Markdown files on your own disk. They can be used together. See [using both](vs-readwise-reader.md#using-both).

## Comparison table

| Topic | Theorem | Readwise Reader |
| :--- | :--- | :--- |
| Platforms | Linux, macOS, Windows and Android ([install](install.md)) | Web app, iOS, Android (including e-ink Android devices), Mac and Windows desktop apps, and browser extensions. A Linux desktop app is not listed |
| Files you can add | EPUB, MOBI, AZW, AZW3, FB2, PDF, CBZ, CBR ([details](supported-formats.md)) | "A variety of different file types", including PDFs, EPUBs, Markdown and OPML files. MOBI, AZW, FB2 and comic formats are not mentioned |
| DRM | DRM-free files only | A purchased book can be imported only when the store offers a DRM-free EPUB |
| Web content | RSS, Atom and JSON Feed subscriptions with a saved-offline option ([feeds](feeds.md)) | Articles, newsletters, videos and tweets, saved with a browser extension or share sheet; RSS feeds; import from Pocket, Instapaper and Feedly |
| Highlights | Six colours, notes, bookmarks; PDF pen and text notes ([guide](highlights-and-notes.md)) | Highlights, tags and notes. Multiple highlight colours are not supported; the docs suggest tags instead |
| Export of highlights | Markdown files, one per book, written automatically to a folder you choose; Obsidian, Logseq, Minimalist and custom styles. Desktop apps only ([how it works](vault-sync.md)) | Markdown download per document or tag view with an editable template; automatic export to Obsidian through Readwise and its official Obsidian plugin, which appends rather than overwrites |
| Dictionary | Offline StarDict and MDict dictionaries, an online English fallback, and a vocabulary list ([dictionary](dictionary.md)) | Ghostreader can define words and summarise documents. An offline dictionary is not stated |
| Text-to-speech | System voices on desktop and Android; an offline neural voice on desktop; not for PDFs ([listening](listening.md)) | AI voices generated on request; documented as not working offline; PDFs only in text view |
| Offline use | Everything is local; reading, dictionaries and export work offline once set up | Works offline on web (if the page was already open), in the desktop app, and on mobile once the app has cached your documents |
| Sync | Direct device-to-device sync, no account ([device sync](device-sync.md)) | Through your Readwise account |
| Account | None | Readwise account required |
| Where data lives | On your devices | Not stated in the pages checked |
| Licence | MIT | Not stated in the pages checked |
| Cost | Free. See the [releases page](https://github.com/fundaments-work/theorem/releases) | Subscription. Reader is part of the full Readwise plan; see readwise.io/pricing for current plans and trial terms |

## Choose Theorem if

- You want no account and no subscription, and you want your library, highlights and notes to stay on your own devices.
- You read ebook files from several formats, including Kindle formats, FictionBook and comics. See [supported formats](supported-formats.md).
- You want highlights written straight to Markdown files in a folder, with no cloud service in between. This runs in the desktop apps; on Android, highlights reach your vault after a [sync](device-sync.md) to a desktop.
- You want offline dictionaries and an offline neural voice (desktop) rather than cloud voices.
- You want to mark up PDFs with a pen on your own device. See [annotate PDFs](annotate-pdfs.md).

## Choose Readwise Reader if

- You save a lot of web content: articles, newsletters, videos, tweets. Theorem reads RSS feeds but has no browser extension or share-sheet saving for web pages.
- You want one library available in a browser, on Mac, Windows, iOS and Android, kept in step by an account.
- You want your highlights to flow into Readwise and from there to Obsidian, Notion, Roam, Logseq or Evernote through Readwise's integrations.
- You want AI help such as Ghostreader on a document.
- You use highlights from other sources too, and want one place for them.

## Using both

Reader can hold web articles and Theorem can hold book files. Their highlights do not merge: Reader's go to Readwise, Theorem's go to the folder you choose. If both end up in one Obsidian vault, keep them in different folders so the files do not collide.

## Does Theorem need an internet connection?

No for reading, highlighting, searching and export. Network access is used for optional things: fetching RSS feeds and full articles, downloading dictionaries or the neural voice, the online dictionary fallback, and device sync relays when two devices cannot reach each other directly. See [device sync](device-sync.md#how-devices-connect).

## Can I move my Readwise highlights into Theorem?

Not directly. Theorem has no importer for Readwise highlights. Readwise can export highlights as Markdown, which you can keep in your vault beside Theorem's files.

## Sources

Readwise facts come from the Readwise documentation and pricing page. Theorem facts come from the Theorem app and the other pages in this guide.

- [What is Reader](https://docs.readwise.io/reader/docs): content types, RSS, highlights, text-to-speech, Ghostreader, import from other apps.
- [Reader FAQ basics](https://docs.readwise.io/reader/docs/faqs): platforms, offline use, Readwise account authentication ("Reader uses your Readwise account for authentication").
- [Mobile apps](https://docs.readwise.io/get-started/mobile-apps): iOS and Android apps, e-ink Android devices.
- [Desktop apps](https://docs.readwise.io/get-started/desktop-apps): a native macOS app and a native Windows app; no Linux app is listed.
- [Adding new content](https://docs.readwise.io/reader/docs/faqs/adding-new-content): file types, DRM-free EPUB requirement, upload limit.
- [Highlights, tags and notes](https://docs.readwise.io/reader/docs/faqs/highlights-tags-notes): no multiple highlight colours, keyboard highlighting, PDF behaviour.
- [Exporting](https://docs.readwise.io/reader/docs/faqs/exporting): Markdown download for a document or a tag view, editable Jinja2 template, export to note-taking apps through Readwise.
- [Readwise to Obsidian export](https://docs.readwise.io/readwise/docs/exporting-highlights/obsidian): the official plugin, Markdown with YAML front matter, Jinja2 templates, append-only behaviour.
- [Text-to-speech FAQ](https://docs.readwise.io/reader/docs/faqs/text-to-speech): voices generated on request, not available offline, PDF limits.
- [Pricing](https://readwise.io/pricing): the Reader row is ticked for the Full plan only; no prices are repeated here.

Not stated in these sources: where Reader stores your data, its licence, an offline dictionary, and support for MOBI, AZW, FB2 or comic files.

Last checked: October 2026.
