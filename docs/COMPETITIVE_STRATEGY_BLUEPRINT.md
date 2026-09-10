# Theorem: Master Competitive & Strategic Blueprint
*A Unified Market, Technical, and Open-Source Ecosystem Analysis for Category Leadership*

---

## 1. Executive Summary & Market Landscape

The digital reading and knowledge landscape in 2026 is divided into three polarized categories:

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                           THE DIGITAL READING ECOSYSTEM                                 │
├───────────────────────────┬─────────────────────────────┬───────────────────────────────┤
│ 1. Commercial Gardens     │ 2. SaaS Power Readers       │ 3. Open-Source Ecosystem      │
├───────────────────────────┼─────────────────────────────┼───────────────────────────────┤
│ • Apple Books             │ • Readwise Reader           │ • Kavita & Komga (Manga/CBZ)  │
│ • Amazon Kindle           │   ($107/year subscription)  │ • Audiobookshelf (Audiobooks) │
│ • Kobo Desktop/App        │ • Matter / Pocket           │ • Omnivore / Readeck (Articles)│
│                           │                             │ • Sioyek & Zotero 7 (Academic)│
│                           │                             │ • Foliate & KOReader (E-Ink)  │
│                           │                             │ • Lute (Language / SRS)       │
├───────────────────────────┼─────────────────────────────┼───────────────────────────────┤
│ Strengths:                │ Strengths:                  │ Strengths:                    │
│ Consumer polish, smooth   │ Omnivorous ingestion, PKM   │ Format versatility, data      │
│ page turns, ecosystem sync│ highlight sync, AI features │ ownership, zero subscription  │
│                           │                             │                               │
│ Critical Flaws:           │ Critical Flaws:             │ Critical Flaws:               │
│ DRM wall, cloud lock-in,  │ Mandatory subscriptions,    │ Fragmented into 10 tools,     │
│ zero PKM/Obsidian export  │ cloud tracking, slow apps   │ complex self-hosting/2010s UI │
└───────────────────────────┴─────────────────────────────┴───────────────────────────────┘
```

### Theorem's Strategic Positioning
**Theorem bridges all three worlds**: an open-source, local-first, zero-subscription reading environment built on high-performance native technologies (**React 19 + Tauri 2 + Rust + SQLite**) that unifies **consumer aesthetic polish**, **power-reader workflows (PKM/Obsidian)**, and **the superpowers of the open-source ecosystem (manga, audiobooks, academic PDF portals, and StarDict)**.

---

## 2. Comprehensive Competitor Benchmark Matrix

| Feature Area | Theorem (Target) | Readwise Reader | Apple Books / Kindle | Kavita / Komga | Sioyek / Zotero | Audiobookshelf | Foliate / KOReader |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Business Model** | **100% Free & Open Source** | $107/year subscription | Store/Hardware lock-in | Free / Self-Hosted | Free & Open Source | Free / Self-Hosted | Free & Open Source |
| **Data Storage & Sync** | **Local-First + Iroh P2P Sync** | Centralized Cloud | iCloud / Whispersync | Self-Hosted Server | Local DB / Cloud Sync | Self-Hosted Server | Manual / WebDAV |
| **E-Book Reflow** | **EPUB, MOBI, AZW, FB2** | EPUB, PDF | EPUB, KFX/AZW | EPUB, PDF | Basic EPUB | None (Audio only) | EPUB, MOBI, FB2, DJVU |
| **Manga / Comic (CBZ)** | **LTR, RTL Manga & Webtoon** | Basic image scrolling | Basic fixed layout | **King of Manga & Webtoon** | None | None | Good CBZ support |
| **PDF & Academic Power** | **Peek Portals, Ink, Dual Mode** | Standard highlights | Basic highlights | Basic PDF | **Portals, Vim Keys, Citations** | None | K2pdfopt PDF reflow |
| **Web / Read-It-Later** | **Browser Clipper + RSS** | **Full web clipper & RSS** | Safari Reading List | OPDS only | Web Translators | None | RSS via plugins |
| **Audiobooks & TTS** | **Native TTS + M4B Player** | Cloud TTS (paywalled) | Audible companion | None | None | **King of Audiobooks** | System TTS |
| **PKM / Obsidian** | **Bi-directional Vault + Deep Links** | 1-way cloud sync plugin | None (Locked) | None | Zotero-Obsidian plugins | None | JSON/HTML export |
| **Dictionary & Vocab** | **StarDict + Free API + FSRS** | Online lookup | Built-in OS dicts | None | None | None | StarDict offline |
| **AI / Intelligence** | **Local LLM (Ollama / Llama.cpp)** | Ghostreader (Cloud AI) | None / Basic Siri | None | Community LLM plugins | None | None |
| **Active Recall (SRS)** | **Integrated FSRS-5 Flashcards** | Daily Review queue | None | None | Logseq flashcards | None | Anki export |

---

## 3. Best Innovations to Absorb from Every Platform

1. **The "Peek Portal" from Sioyek** *(Academic PDF & EPUB Footnotes)*: When reading complex technical books or academic papers, references like `[Figure 3]`, `[Theorem 2.1]`, or `[Footnote 14]` open a floating portal popover showing the destination content without losing your reading scroll position. (Implemented as **Theorem Lens**).
2. **The Manga & Webtoon Engine from Kavita & Komga**: Native handling of `.cbz`/`.cbr` archives with Right-to-Left (RTL) Japanese manga page navigation and continuous seamless vertical image stacking (Webtoon mode).
3. **Capturing the Omnivore Void (Web Clipper & Read-It-Later)**: When Omnivore shut down after its acquisition, thousands of power readers lost their open-source read-it-later app. Theorem plans a browser-extension web clipper to capture this user base (not yet shipped; in-app article extraction is available today).
4. **The Audiobook Companion from Audiobookshelf**: Plays DRM-free `.m4b` and `.mp3` audiobooks with embedded chapter navigation, variable speed playback, and sleep timers attached directly to books.
5. **Spaced Repetition Flashcards from Lute & Anki**: Converts looked-up vocabulary words and book highlights into an automated spaced repetition review queue using the **FSRS-5 algorithm**.
6. **Deep-Link URI Scheme (`theorem://`) & Split Workbench from Zotero 7**: Clicking a note or citation in Obsidian opens Theorem and jumps directly to the exact page/CFI (`theorem://open?bookId=...&cfi=...`).

---

## 4. The 3-Phase Actionable Roadmap

### Phase 1: UX Polish & Ergonomics (Immediate 10x Gains)
- [x] **Theorem Lens (Footnote & Reference Peek Portals)**: In-place popover balloon above links without jumping.
- [ ] **Manga RTL & Webtoon Vertical Modes (CBZ)**: Right-to-Left and seamless vertical image stacking.
- [ ] **Custom Font Sideloading & Typography Polish**: Drag-and-drop `.ttf`/`.otf` font files.
- [ ] **Theorem Deep-Link URI Scheme (`theorem://`)**: Open specific books/CFIs directly from Obsidian notes.
- [ ] **FSRS Spaced Repetition Vocabulary Engine**: 5-minute daily flashcard review queue.

### Phase 2: Category Parity (Power Tools)
- [x] **Companion Audiobook Player (M4B/MP3)**: Attached audio track with speed controls and chapter marks. See [audiobook.md](audiobook.md).
- [ ] **Browser Web Clipper (Send to Theorem)**: Save cleaned articles directly to SQLite.
- [ ] **Split-Screen Reading & Notes Workbench**: Read on the left while taking Markdown notes on the right.
- [ ] **Local LLM Ghostreader (Ollama & Llama.cpp)**: Zero-cloud AI reading assistant.

### Phase 3: Category Dominance (Unfair Moats)
- [ ] **On-Device Semantic Vector Search (`sqlite-vec`)**: Local semantic search across an entire 10,000-book library.
- [ ] **Whisper-Aligned Human Audiobooks (Local Whispersync)**: Auto-align EPUB text with human narration.
- [ ] **P2P Encrypted Book Clubs (Iroh Gossip)**: Decentralized reading circles.
