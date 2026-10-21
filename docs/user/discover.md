# Discover Free Books

Browse and search public-domain books from Project Gutenberg and Standard Ebooks and add any title to your Theorem library; your own catalogs arrive in 1.6.0.

Discover works on desktop and on Android phones and tablets. It needs an internet connection, or a connection to your own network for a home server, to load catalogs and to download books.

## Open Discover

- **Desktop.** Click Discover in the sidebar, the compass icon near the bottom of the icon list, or press `Ctrl+6` (`⌘6` on a Mac).
- **Android.** Tap Discover in the bottom bar.

At the top is a row of sources: Discover, Project Gutenberg, Standard Ebooks, and any catalog you have added. Tap a source to open it. A plus button at the end of the row adds a catalog. The row scrolls sideways when there are many sources, and the plus button stays in place.

## The Discover storefront

The Discover source opens on a storefront. At the top is a featured book labeled Featured Classic, and below it are rows of books in sections:

- Timeless Essentials
- New & Restored Editions
- Philosophy & Essays
- Classic Fiction

Most sections come from Project Gutenberg. New & Restored Editions comes from Standard Ebooks. Scroll a row sideways to see more books.

Theorem remembers the last sections it loaded, so the page still shows them if your connection drops. Click the refresh button (Refresh Discover) to load them again. If nothing can be loaded and nothing is cached, the page says "Could not connect to online libraries" and offers a Try Again button.

### Search the storefront

1. Click the search box, which reads "Search classics, authors, subjects…".
2. Type at least two characters. Results appear after a short pause.
3. Scroll through the results grid.
4. Click Clear Search, or empty the box, to return to the storefront.

Search looks through the Project Gutenberg catalog. If it finds nothing, the page says so and suggests searching by author, title or topic.

## Add a book to your library

1. Tap a book, or tap View Book on the featured book. A window opens with the cover, title, author and description.
2. If the book comes in more than one format, each one is listed with its size. The best choice, usually EPUB, is outlined. Tap Add to Library, or tap the format you want.
3. Wait for the download. A message at the corner shows the progress and then confirms that the book is in your library.
4. Open the book from the Library page. Once a title is in your library, Read Now in the window opens it directly.

You can also tap Get on a book's cover without opening the window. A book already in your library shows In Library there instead.

Downloaded books go through the same import as Add Books, so their title, author and cover are read from the file. Books without a cover get a plain dark generated cover with the title and author.

### Books you cannot download

Some catalogs list books that Theorem cannot simply download. The book window says why instead of showing a button that would fail:

- **For sale.** It shows the price and, when the catalog has a web page for the book, an Open website button.
- **On loan.** Library loans are managed by the library's own site or app.
- **Locked with DRM.** Files protected by Adobe or Readium DRM cannot be opened in Theorem.
- **Sample only.** You can add the sample, which is a short excerpt, not the book.

## Add your own catalog

> **New in Theorem 1.6.0, not released yet.** Adding and browsing your own OPDS catalogs, including sign-in to private ones, is in version 1.6.0. In the latest release, 1.5.9, Discover shows the curated storefront, Project Gutenberg and Standard Ebooks only. This section and the sections below it describe 1.6.0.

Catalogs that follow the OPDS standard work in Theorem. This includes Calibre content servers, Calibre-Web, Kavita, Komga, COPS, many libraries, and public collections. Both OPDS 1.x and OPDS 2.0 are supported.

1. Tap the plus button at the end of the sources row.
2. Type or paste the catalog's address. You can leave out `https://`, and addresses such as `192.168.1.10:8080/opds` or `nas.local/opds` work. Links that start with `opds://` also work. Addresses on your own network use `http` unless you say otherwise.
3. Tap Check address. Theorem contacts the catalog and tells you what it found, for example "OPDS 2.0 · 4 sections · search", or explains the problem.
4. If the catalog asks for a sign-in, tap This catalog needs a sign-in, enter your username and password, and check again.
5. Edit the name if you like, then tap Add catalog.

If the catalog is on a server that is switched off right now, the dialog offers Add anyway after the check fails, so you can save it and open it later.

### Browse a catalog

A catalog opens in place with its own sections, such as Newest, Authors or Series. Tap a section to open it. A trail under the title shows where you are, for example Mock Library › Newest, and you can tap an earlier step to jump back. The back arrow goes one step back.

- **Shelves.** Some catalogs show rows of featured books. Tap See all to open the whole list.
- **Scrolling.** Long lists load more books as you reach the end. If a list stops loading, tap Load more, or Try again after an error.
- **Search.** If the catalog has its own search, type a word and press Enter to search the whole catalog. The trail then reads Search: and your word, and Back returns to where you were. If the catalog has no search, the box filters the books already on the page as you type.
- **Filters.** Catalogs can offer their own filters and sort orders, such as Format or Language. They appear as menus above the books. Language and format buttons, and a sort menu, narrow what is already loaded. The default sort, Catalog order, keeps the order the catalog chose, which is often by popularity or date. Tap Clear to remove the filters.

Tap the refresh button to load the catalog again, or the three dots for more options.

### Sign in to a private catalog

When a catalog needs a login, you see a sign-in form. Enter your username and password. Leave Remember on this device on to stay signed in. Your login is stored only on this device. It is not synced to your other devices, and it is saved only after the catalog accepts it, so a mistyped password never replaces a working one. A lock icon on the source shows that you are signed in. To forget a login, tap the three dots and choose Forget sign-in.

Some libraries sign in with a method Theorem cannot use yet. The sign-in form says so. You can still use that library's public pages in a web browser.

### Remove a catalog you added

Open the catalog, tap the three dots and choose Remove catalog. Books you already added stay in your library. Project Gutenberg and Standard Ebooks cannot be removed.

## Troubleshooting catalogs

See [Troubleshooting](troubleshooting.md#catalogs-in-discover) for what to do when a catalog will not open or a download fails.
