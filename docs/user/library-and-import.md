# Library and Import

Add books and whole folders to Theorem, find them with search and filters, edit their details, and act on many books at once with bulk selection.

## Add books

1. Open the Library page.
2. Click Add Books (Add on a narrow screen).
3. Select one or more files in the file picker and confirm.

Theorem imports these formats:

| Format | File extensions |
| :--- | :--- |
| EPUB | `.epub` |
| Kindle | `.mobi`, `.azw`, `.azw3` |
| FictionBook | `.fb2`, `.fbz`, `.fb2.zip` |
| Comics | `.cbz`, `.cbr` |
| PDF | `.pdf` |

Only DRM-free files open. Theorem copies each imported book into its own storage, reads the title, author and cover from the file, and adds it to the library. Files with the same contents are treated as duplicates, and only the first import is kept. If some files fail to import, a dialog titled Import Errors lists the first three with the reason.

CBR comics are handled inside Theorem. You do not need to install a separate RAR tool.

## Import a folder

> **New in Theorem 1.6.0, not released yet.** The Preserve folder structure option and the Source folders strip described here are in version 1.6.0. The latest release, 1.5.9, does not have them.

Use folder import to bring in a whole collection, including its subfolders. The Scan button appears in the desktop and Android apps, not in the browser demo.

1. On the Library page, click Scan.
2. In the Import a folder dialog, choose how to organize the books:
   - **Preserve folder structure** (the default) lets you browse books by their original folders. Shelves stay separate.
   - **Import as a flat library** adds all books together with no folder organization.
3. Click Choose folder and select the folder to scan.

Both options search subfolders and leave your original files where they are. If no supported books are found, Theorem shows No Books Found.

### Browse by source folder

After a folder import with Preserve folder structure, a Source folders strip appears above the books.

1. Click a folder to show its books. The view includes everything in its subfolders.
2. Click a subfolder, or use the breadcrumbs, to move up and down the tree.
3. Click All library books to leave folder browsing.

Folder views work together with search and filters. Only folders that contain successfully imported books are listed. Source folders are separate from shelves, and changing one does not change the other.

If you scan a folder again, books you already have are not duplicated. With Preserve folder structure on, the existing book gains that folder, and its reading progress and shelves are kept. Importing again as a flat library does not remove folder information added earlier. To organize books you imported before this feature existed, scan their original folder again with Preserve folder structure.

## Open and manage a book

- Click a cover to open the book.
- Double-click a cover to add it to or remove it from your favorites.
- Right-click a book (or long-press it on a touch screen) to open its menu.

The book menu offers:

| Menu item | What it does |
| :--- | :--- |
| Open Book | Opens the book in the reader |
| Add to Favorites / Remove from Favorites | Toggles the favorite flag |
| Mark Read / Mark Unread | Sets the read state by hand |
| Add to Shelf... or Shelves... | Opens a dialog to add the book to shelves or remove it from them |
| Book Info | Shows details such as series, publisher, language, format, size, progress and tags |
| Delete from Library | Removes the book after you confirm. This cannot be undone |
| More... | Opens the items below |

Under More... you find:

- **Edit Info** opens Edit Book Info, where you can change the title, series name, volume number, author, publisher, published date, language, ISBN, category, tags, description, rating and cover.
- **Export** saves the book file out of the library.
- **Open in New Window** opens the book in its own window. Desktop only.
- **Attach Audiobook...** links an audio file to the book. See [Listening with text-to-speech and audiobooks](listening.md#attach-an-audiobook).
- **Download File** appears only for a book that arrived through [device sync](device-sync.md) without its file.

A book whose file is not on this device shows a warning badge and the label No file.

## Search, sort and filter

1. Type in the search box at the top. On the Library page it searches titles, authors and tags, and results update as you type.
2. Click Filter to open the filter panel.
3. Under Sort, choose Title, Author, Added or Read (last read). Under Order, choose ASC or DESC.
4. Under Status, choose All, New, Reading or Done.
5. Under Quick, choose Favorites or Unshelved to narrow the list, or Recent to sort by last read.

When a shelf, Favorites or Unshelved filter is active, the page title changes and a Clear filter button appears.

Click the view button next to Select to cycle through grid, list and compact layouts. Theorem remembers your choice.

## Select many books

> **New in Theorem 1.6.0, not released yet.** The selection bar and the Select all behaviour described here are the redesigned version in 1.6.0. The latest release, 1.5.9, selects differently.

1. Click Select in the toolbar. A selection bar appears.
2. Click books to select them. Clicking a selected book clears it.
3. Click Select all to select every book in the current result, including books outside the visible part of the list. Select all respects your search, shelf, source folder, status, favorites and unshelved filters.
4. Choose an action in the bar:
   - **Mark Read** or **Mark Unread.** The button shows Mark Unread when every selected book is already read. A message with an Undo button appears afterward.
   - **Add to Shelf** adds the books to shelves.
   - **Series** opens the series dialog. See [Shelves, smart shelves and series](shelves.md#organize-books-into-series).
   - **Export** saves the book files.
   - **Delete** removes the books after you confirm.
5. Click Done, or press `Esc`, to leave selection mode. Clear removes the selection but keeps selection mode on.

Changing a filter clears the selection so you cannot act on books you can no longer see. Changing the sort order keeps it. Actions stay disabled until the search results finish updating. You can also press `Ctrl+A` to turn selection mode on and off.

## Daily highlight

Settings has a Daily Highlight switch (off by default). When it is on, the Library page shows a random highlight from your past reading. See [Settings and shortcuts](settings-and-shortcuts.md#general).
