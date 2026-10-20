# Reading Books, PDFs and Comics

Open a book, turn pages, change the theme and text size, search inside it, jump with the table of contents, and use the extra tools for PDFs and comics.

![An EPUB open in a two-page spread in the dark theme, with colored highlights, the reader toolbar at the top and the progress bar at the bottom](../screenshots/reader-dark-highlights.png)

## Open a book

Click a cover in the Library, or open a file from your file manager. Theorem saves your position for each book and takes you back to it the next time you open that book. Click the arrow at the top left of the reader to return to the Library.

Theorem uses one reader for EPUB, MOBI, AZW, AZW3, FB2 and comics, and a separate PDF reader. Most controls are the same in both.

## Turn pages and move around

| Action | Keys |
| :--- | :--- |
| Next page | `Right`, `Down`, `Page Down`, `Space` |
| Previous page | `Left`, `Up`, `Page Up` |
| Start of the book | `Home` |
| End of the book | `End` |
| Go back to the previous reading location | `Alt+Left` |
| Go forward again | `Alt+Right` |

You can also drag or click the progress bar at the bottom of the reader. Hovering over it shows the percentage and the chapter at that point. The bar also shows the current chapter, the time left in the chapter and in the book, and your overall progress.

Click the list icon at the bottom left, or press `Ctrl+T`, to open the table of contents. Click an entry to jump to it.

## The reader toolbar

The toolbar at the top shows the book title and your page. Its buttons are:

| Button | What it does |
| :--- | :--- |
| Back arrow | Returns to the Library |
| Search | Opens search inside the book (`Ctrl+F`) |
| Bookmark | Adds or removes a bookmark at the current page (`Ctrl+D`) |
| Headphones | Starts Immersion Reading. Not shown for PDFs. See [Listening with text-to-speech and audiobooks](listening.md) |
| Lightning bolt | Starts Speed Read. Shown only when you turn on Speed Read in Settings, and not for PDFs |
| T | Opens Reading Settings (`Ctrl+S`). For PDFs it opens the View panel instead |
| More options (three dots) | Opens Annotations & Notes (`Ctrl+A`), Book Info, Fullscreen, and for PDFs, Present and Print |

On a narrow screen, the Search, Bookmark and Reading Settings buttons move into the More options menu.

Press `F11` to switch full screen on or off on desktop. Press `Esc` to close open panels.

## Change how a book looks

Click the T button, or press `Ctrl+S`, to open Reading Settings. It has three tabs. Click Reset in the panel header to restore the defaults.

### Theme

- Choose Light, Sepia or Dark.
- Drag the Brightness slider (20 to 100) to dim the page.

### Type

This tab appears for reflowable books (EPUB, MOBI, AZW, AZW3, FB2).

- **Font:** Original (the book's own font), Serif, Sans or Mono.
- **Size:** 12 to 32.
- Click More options to show **Line spacing** (1.0 to 2.2) and **Alignment** (Left, Justify or Center).

### Layout

- **Mode:** Paged turns pages. Scroll shows the book as one continuous column.
- **Zoom:** 100 to 200 percent in paged mode, and 50 to 200 percent in scroll mode.

For fixed-layout files such as comics, the Type tab is replaced by a Zoom tab. The text says "This document has a fixed layout. Zoom controls replace text-size options." It offers a Zoom level slider and presets of 100, 125, 150 and 200 percent.

## Search inside a book

1. Click Search, or press `Ctrl+F`.
2. Type a word, a name or a phrase in the Search in document box.
3. Press `Enter` or `F3` to go to the next match. Press `Shift+Enter` or `Shift+F3` for the previous one.
4. Turn on Match Case (`Alt+C`) or Match Whole Word (`Alt+W`) to narrow the results.
5. Click a result to jump to it.

Search finds the exact text you type. It does not guess at similar words.

## Footnotes and citations

In EPUB and similar books, tap or click a footnote or citation marker to open it in a small pop-up next to the text, instead of jumping to the end notes. This pop-up is called Theorem Lens. From it you can copy the text or jump to the notes section. Scroll or click elsewhere to dismiss it, and you keep your place in the book.

## Read a PDF

PDFs open in their own reader. Pages always appear as the file draws them, so the Light, Sepia and Dark themes do not recolor PDF pages.

1. Click the T button in the toolbar to open the View panel. Choose a layout: Continuous (scrolling), Single (one page at a time) or Facing (two pages).
2. Zoom with the minus and plus buttons, click the percentage to reset to 100 percent, or choose Fit Page or Fit Width. You can also press `Ctrl` with `+`, `-` or `0`.
3. Click Rotate Clockwise to turn the page view.
4. Open the table of contents and choose the Outline tab for the document outline or the Pages tab for page thumbnails.

Theorem remembers the page, zoom and layout for each PDF.

More PDF features:

- **Links.** Links, citations and table of contents entries are clickable. Hover over an internal link to preview its destination without leaving the page. Use `Alt+Left` and `Alt+Right`, or the back and forward buttons, to move through your jump history.
- **Page labels.** If the PDF numbers its pages with labels such as roman numerals, Theorem shows them and accepts them when you jump to a page.
- **Search options.** Search also supports match case, whole word and `F3` cycling.
- **Present.** Press `F5` or choose Present to show one page at a time in full screen. Desktop only.
- **Print.** Press `Ctrl+P` or choose Print to open the print dialog. Desktop only.
- **Book Info.** Shows PDF properties such as producer, PDF version and page size. If the PDF has embedded attachments, they are listed with a Save button.

To mark up a PDF, see [Highlights and notes](highlights-and-notes.md#mark-up-a-pdf).

## Read a comic

CBZ and CBR comics open in the same reader.

1. Open the comic from the Library. Pages are shown one at a time by default.
2. To read a webtoon or other long comic without page turns, open Reading Settings, choose the Layout tab, and set Mode to Scroll.

Scroll mode shows the comic as one continuous vertical strip. Images fit the reading width and touch edge to edge. Switching back to Paged keeps your place. Theorem reads series and volume information from a `ComicInfo.xml` file when the comic contains one.

## Speed Read

Speed Read shows one word at a time at a speed you choose. It is off by default and not available for PDFs.

1. Open Settings, select the General tab, and turn on Speed Read.
2. Open a book and click the lightning bolt in the reader toolbar. Speed Read starts from the text currently on screen.
3. Press `Space` to play or pause. Press `Up` and `Down` to change the speed in steps of 25 words per minute. The default is 350.
4. Press `Left` and `Right` to skip back or ahead by 10 words.
5. Press `C` to show or hide the surrounding paragraph and `F` to switch full screen.
6. Press `Esc` to close Speed Read.

## Open a book in a separate window

On desktop, right-click a book in the Library, choose More..., then Open in New Window. Each window reads its own book.
