# Annotate PDFs with Highlights and a Pen

Highlight text, draw with a pen and add notes on PDFs in Theorem; this page shows which tools work on which platform and what reaches your Markdown export.

This page describes Theorem 1.6.0. PDFs open in their own reader with an annotation toolbar. You can highlight text, draw freehand, place text notes on a page, and erase marks. Everything is stored on your device.

## How do I highlight text in a PDF?

1. Open the PDF from your Library. If it is not there yet, see [library and import](library-and-import.md#add-books).
2. Click the tools button at the lower right of the page (its tooltip reads Open annotation tools). It appears when the reader controls are showing.
3. Choose the Highlight tool.
4. Pick a colour from the six swatches that appear under the tools: yellow, green, blue, red, orange or purple.
5. Select text with the mouse or your finger. The highlight is saved when you finish the selection.
6. Click the tools button again (Close annotation tools) to leave annotation mode.

Selecting text with no tool active shows a small pop-up with Copy and Define only. It does not highlight. To highlight, use the Highlight tool as above. Define looks the word up in your dictionaries; see [dictionary](dictionary.md).

Highlights need text the PDF contains. Theorem has no OCR, so on a scanned PDF without a text layer you cannot select text to highlight. The pen and text-note tools still work on such pages.

PDF highlights are kept per page and are not merged when they overlap, unlike highlights in EPUB and other reflowable books.

## How do I draw on a PDF with the pen?

1. Open the annotation tools and choose Pen (Freehand pen).
2. Drag on the page to draw. Release to finish the stroke.
3. Choose the tool again, or close the tools, to stop drawing.

The pen has a fixed width and draws in blue until you pick another colour. In pen mode the colour swatches set the pen colour; the Highlight tool keeps its own colour. A stroke is saved as soon as you lift the pointer. Strokes that are too short to be a line are discarded.

## How do I add a note to a PDF?

There are two kinds of note.

**A text note on the page.**

1. Open the annotation tools and choose Text (its tooltip reads Add note).
2. Click the place on the page where the note should go.
3. Type in the box that opens, then click Save or press `Ctrl+Enter`. Cancel or `Esc` closes the box without saving. A note saved with no text is removed.
4. To edit it later, choose the Text tool and click the note again.

**A note on a highlight.**

1. Press `Ctrl+A` to open Annotations & Notes, or choose it from the More options menu.
2. Switch to the Highlights list, open the three-dot menu on the highlight, and choose Edit note.

You can also edit notes in the Workbench. See [workbench](workbench.md).

## How do I erase a mark?

Choose the Eraser, then click a highlight, a pen stroke or a text note. Drag across marks to remove several. You can also delete a highlight from its three-dot menu in the Annotations panel.

## Which annotation tools work on which platform?

The four tools (Highlight, Pen, Text, Eraser) are in the desktop and Android apps. These PDF features are desktop only:

| Feature | Linux, macOS, Windows | Android |
| :--- | :--- | :--- |
| Highlight, Pen, Text and Eraser tools | Yes | Yes |
| Present (full-screen, one page at a time, `F5`) | Yes | No |
| Print (`Ctrl+P`) | Yes | No |
| Markdown export to a folder | Yes | No export folder; highlights reach your vault after a [sync](device-sync.md) to a desktop |

PDF highlights, strokes and notes sync between paired devices along with your other notes. See [device sync](device-sync.md).

Other PDF reader features, such as zoom from 25 to 500 percent, Continuous, Single and Facing layouts, Fit Page, Fit Width and rotation, are in [reading](reading.md#read-a-pdf).

## What is exported to Markdown?

Only highlights and notes are written to your Markdown folder, one file per book, in the style you choose (Obsidian, Logseq, Minimalist or a custom template). Bookmarks are not. Setup is in [Markdown export](vault-sync.md).

For PDFs, read this before you rely on the export:

- Highlights are exported as quoted text. No page number is written for each mark. With the default Highlight Grouping setting (By Chapter), marks are grouped under a heading taken from the PDF's contents entry, or "Page N" when the PDF has none (from the source).
- A text note is stored with the same text as both its quote and its note, so from the source it is written twice: once as the quoted line and once as the note.
- A pen stroke is stored as a note whose selected text is the placeholder "Freehand annotation" and which has no note text. From the source, the exporter writes every highlight and note, so a stroke is written as one quoted line reading "Freehand annotation" (`> ==Freehand annotation==` in the Obsidian style) with no drawing. Drawings are never exported as images.

Open your first export and check how your marks appear before you depend on it. If you want only highlights in Markdown, use the highlight tool for what you want to keep.

Theorem does not write marks into the PDF file. The original file is unchanged, and Export on a book saves the original. Your marks stay in Theorem and in the Markdown files. If you need a PDF that carries its annotations to another app, Theorem does not make one.

## Can I annotate EPUB and other books too?

Yes. EPUB, MOBI, AZW, AZW3, FB2 and RSS articles support highlights in six colours and notes, but not drawing. See [highlights and notes](highlights-and-notes.md). Format-by-format details are in [supported formats](supported-formats.md).
