# Theorem vs Readest

Theorem and Readest are both open-source readers for computers and Android, and they differ on highlight export, account-based sync, formats and platforms.

Readest is an open-source ebook reader built with Tauri and Next.js that runs on macOS, Windows, Linux, Android, iOS and in a browser. Theorem is also a Tauri app, for Linux, macOS, Windows and Android. The two overlap more than most readers do, so the useful question is which sync model, export route and format list fits how you read.

## Short answer

Choose Readest if you read on an iPhone or iPad or in a browser, want a library that syncs through a Readest account or your own cloud storage, want TXT or Markdown files, which Theorem does not open, or want translation, Readwise or Notion export built in. Choose Theorem if you want highlights written continuously into an Obsidian or Logseq folder, sync between your own devices with no account, CBR comics, or an offline neural voice on desktop. You can run both on one computer. See [using both](vs-readest.md#using-both).

## Comparison table

| Topic | Theorem | Readest |
| :--- | :--- | :--- |
| Platforms | Linux, macOS, Windows and Android ([install](install.md)) | macOS, Windows, Linux, Android, iOS and iPadOS, and a web app ([README](https://github.com/readest/readest), [getting started](https://readest.com/docs/getting-started)) |
| Formats opened | EPUB, MOBI, AZW, AZW3, FB2, PDF, CBZ, CBR ([details](supported-formats.md)) | EPUB, MOBI, AZW, AZW3, FB2, CBZ and ZIP, PDF, TXT and Markdown. CBR is not listed ([getting started](https://readest.com/docs/getting-started)). Its page says DRM-protected EPUBs must be converted first |
| Highlights | Six colours, notes, bookmarks; PDF pen, text notes and eraser ([guide](highlights-and-notes.md)) | Highlight, underline and squiggly styles, five default colours plus custom colours, notes in plain text or Markdown, excerpts, bookmarks, and finger, stylus or Apple Pencil drawing ([reading docs](https://readest.com/docs/reading)) |
| Export of highlights | Continuous Markdown export to a folder you choose, with Obsidian, Logseq, Minimalist and custom-template styles. Desktop apps only ([how it works](vault-sync.md)) | Per-book export from the Book Menu as Markdown, plain text or JSON, with an Obsidian-friendly layout and a custom template option. Continuous push to Readwise or Notion. A continuous write into a local folder is not described ([reading docs](https://readest.com/docs/reading), [sync docs](https://readest.com/docs/sync)) |
| Sync | Direct device-to-device sync of library, highlights, notes and progress, no account ([device sync](device-sync.md)) | Readest Cloud after you sign in to a Readest account, or your own WebDAV, Google Drive, OneDrive, iCloud Drive or S3-compatible storage, which the docs say needs a paid plan or a one-time unlock. Also KOReader and other reading-sync integrations ([sync docs](https://readest.com/docs/sync)) |
| Account | None | A Readest account is used for cloud sync. The download page says "without forced accounts". Nearby BookDrop moves books between devices on a network "with no account" ([download](https://readest.com/download), [library docs](https://readest.com/docs/library)) |
| Dictionary | Offline StarDict and MDict dictionaries, an English Wiktionary download, and an online English fallback ([dictionary](dictionary.md)) | Wiktionary and Wikipedia built in; imported StarDict, MDict, DICT, Slob, Babylon and Yomitan dictionaries; web search providers; an optional AI context dictionary ([translate docs](https://readest.com/docs/translate)) |
| Translation | Not offered | DeepL, Azure, Google and Yandex, custom OpenAI-compatible translators, and whole-book translation ([translate docs](https://readest.com/docs/translate)) |
| Text-to-speech | System voices on desktop and Android; an offline neural voice on desktop; not for PDFs ([listening](listening.md)) | Native system voices on Android and iOS; Edge TTS cloud voices, which send the current sentence to Microsoft; Readest Voice cloud voices for subscribers; custom OpenAI-compatible services. The docs say native desktop voices "aren't wired up yet" ([listen docs](https://readest.com/docs/listen)) |
| Audiobooks | Attach an `.m4b`, `.m4a` or `.mp3` file to a book | Pair an audiobook to an EPUB for read-along; stream from an Audiobookshelf server ([listen docs](https://readest.com/docs/listen), [sync docs](https://readest.com/docs/sync)) |
| RSS and catalogs | Built-in RSS, Atom and JSON Feed reader ([feeds](feeds.md)); Project Gutenberg, Standard Ebooks and OPDS catalogs ([discover](discover.md)) | OPDS catalogs, including OPDS-PSE streaming, and Calibre servers; web page clipping. A feed reader is not stated ([library docs](https://readest.com/docs/library)) |
| Usage statistics | No analytics or usage-statistics code is active in the released builds (error reporting is compiled in but, per the source, has no endpoint configured); the app fetches announcements when it starts | Anonymous, aggregated usage statistics are off on new installs, with a toggle in the Main Menu ([advanced docs](https://readest.com/docs/advanced)). See the quotes under [privacy](vs-readest.md#what-does-readests-privacy-page-say) |
| Self-hosting | Not needed for sync; devices pair directly | The sync docs say Readest is "open-source and self-hostable" and point to the repository for setup ([sync docs](https://readest.com/docs/sync)) |
| Licence | MIT | AGPL-3.0 ([LICENSE](https://github.com/readest/readest/blob/main/LICENSE)) |
| Cost | Free. See the [releases page](https://github.com/fundaments-work/theorem/releases) | Free plan plus paid plans and one-time purchases. See the [pricing page](https://readest.com/pricing) |

## Choose Theorem if

- You want highlights to appear in an Obsidian or Logseq folder as you make them. Theorem rewrites the Markdown files a couple of seconds after a change. This runs in the desktop apps; on Android you highlight on the phone and the notes reach your vault after a [sync](device-sync.md) to a desktop.
- You want sync between your own devices without registering an account anywhere, and without a cloud service in the middle.
- You read CBR comics. Readest's format list names CBZ and ZIP.
- You want a built-in offline neural voice on a computer. See [listening](listening.md).
- You want a feed reader in the same app as your books.

## Choose Readest if

- You read on an iPhone, an iPad or in a browser. Theorem has no iOS app.
- You want your library, progress, highlights and notes on every device through one sign-in, or you want to point sync at your own WebDAV, Google Drive, OneDrive, iCloud Drive or S3 storage.
- You want translation of a selection or a whole book, Wikipedia lookup, or more dictionary formats than StarDict and MDict.
- You send highlights to Readwise or Notion. Theorem has no integration for either.
- You open TXT or Markdown files, or want to read a folder of books in place without copying it.
- You use KOReader and want progress, and with Readest's plugin notes, to follow you between devices.
- You want to read two books side by side (its Parallel Read feature) or draw with a pen or stylus on reflowable books. Check Readest's docs for the current list.

## Using both

Both apps keep their own library, highlights and reading position, and neither reads the other's data. A workable split is Theorem on a computer where you want notes landing in a vault, and Readest on an iPhone. Readest exports a book's notes as Markdown on request, and Theorem writes to the folder you choose, but the two use different file layouts, so they do not merge into one note per book.

## Does Theorem need an account the way Readest cloud sync does?

No. Theorem has no sign-in anywhere, and device sync is peer to peer. Readest cloud sync uses a Readest account. Its docs describe Nearby BookDrop, which moves books between devices on a network with no account, and its download page says "without forced accounts". See [device sync](device-sync.md).

## Can Readest write highlights straight into an Obsidian vault?

Readest's docs describe a Markdown export that "drops straight into an Obsidian vault", built with a title, a highlights section, chapter headings and block quotes. They describe it as a per-book export from the Book Menu. The pages checked do not describe a setting that keeps a vault folder up to date by itself. For continuous sending the docs offer Readwise and Notion. Check the Readest docs for current behaviour.

## What does Readest's privacy page say?

Its privacy policy says "Readest is a local-first app, meaning your data remains on your device by default" and that ebooks, notes, highlights and bookmarks "are stored locally on your device" and are "never uploaded to our servers without your explicit action". It also says "You can opt out of usage analytics and telemetry through the app's settings". The advanced docs say new installs start with anonymous usage statistics off. The policy page is dated 2025-06-06, so read the current version before relying on it.

## Which one is more private?

The sources do not support a ranking. With Theorem, sync devices connect directly and there is no Theorem account; when two devices cannot reach each other, an encrypted relay passes data it cannot read. With Readest, local use keeps data on the device, and cloud sync stores it in Readest Cloud or in storage you connect. Some Readest features send text to other services: the docs say Edge TTS sends the current sentence to Microsoft, and translation providers receive the text being translated.

## Sources

Readest facts come from Readest's own repository, website and documentation, read in October 2026. Theorem facts come from the Theorem app and the other pages in this guide.

- [Readest README](https://github.com/readest/readest): "open-source ebook reader", Next.js and Tauri, platforms, feature list, AGPL statement, downloads.
- [LICENSE](https://github.com/readest/readest/blob/main/LICENSE): GNU Affero General Public License, version 3.
- [Getting started](https://readest.com/docs/getting-started): platforms, install methods, supported formats, DRM note, import routes.
- [Reading](https://readest.com/docs/reading): highlight styles and colours, notes, drawing, export to Markdown, plain text and JSON, Obsidian layout, custom templates.
- [Sync and backup](https://readest.com/docs/sync): Readest Cloud, what syncs, third-party storage, KOReader sync, Readwise, Notion, self-hosting statement, backups.
- [Library](https://readest.com/docs/library): OPDS, import options, read in place, Nearby BookDrop with no account.
- [Listen](https://readest.com/docs/listen): text-to-speech engines, Edge TTS network use, desktop voices, audiobook pairing.
- [Translate and lookup](https://readest.com/docs/translate): translation providers, dictionary formats, Wikipedia, context dictionary.
- [Advanced](https://readest.com/docs/advanced): the privacy and telemetry paragraph.
- [Privacy policy](https://readest.com/privacy-policy): local-first statement, optional analytics, opt-out.
- [Pricing](https://readest.com/pricing): plans exist; which features need a paid plan. Prices are not repeated here.
- [Download page](https://readest.com/download): "without forced accounts", platforms.
- [Terms of service](https://readest.com/terms-of-service): AGPL 3.0 statement.

Not stated in these sources: whether the app works fully with no account on every platform, a continuous export into a local folder, a feed reader, CBR support, what Readest Cloud stores beyond the categories the sync page lists, and any performance claim.

Last checked: October 2026.
