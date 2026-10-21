# Discover Free Books and Browse Online Catalogs

Browse and search free public-domain books, add your school, university or library catalog, or your own Calibre or Komga server, and add any title to your Theorem library with one tap.

Discover works on desktop and on Android phones and tablets. It needs an internet connection, or a connection to your own network for a home server, to load catalogs and to download books.

## Open Discover

- **Desktop.** Click Discover in the sidebar, the compass icon near the bottom of the icon list, or press `Ctrl+6` (`⌘6` on a Mac).
- **Android.** Tap Discover in the bottom bar.

Once you add a catalog, a row of tabs appears at the top: Discover, then each catalog you added, then a plus button that adds another. Tap a tab to open it. The row scrolls sideways when there are many catalogs, and the plus button stays in place. Until you add one, there are no tabs: Discover is the whole page.

## The Discover page

Discover opens on free books chosen by hand:

- **Search.** The large box at the top searches about 78,000 free books by title, author or subject. Press Enter to search. Books in your device's language come first, and you can type part of the last word, so "pride prej" finds Pride and Prejudice.
- **Recent searches.** Your last few searches appear under the box. Tap one to search again, tap × to remove it, or tap Clear all. They are kept only on this device.
- **Newest editions.** Two large cards show the newest releases, with Add to Library and About. More new editions follow in a row.
- **Shelves.** Rows of books such as Timeless essentials, Philosophy & essays, Poetry & drama and Adventure & mystery. Scroll a row sideways, or tap See all for the whole shelf.
- **Browse by subject.** Tiles such as Novels or Poetry, each with its number of books. Tap one to open it, or tap All subjects for the full list.
- **Bring your library.** A card at the bottom adds your school, university or library catalog.

Shelves, subjects and search results open in place. The trail at the top, for example Discover › Poetry, shows where you are, and the back arrow returns to the Discover page.

The shelves are chosen on our side, so they can change and grow without an app update. Theorem keeps the last copy of the Discover page it loaded, so it still shows if your connection drops. Tap the refresh button to load it again.

### Where the books come from

The books are free public-domain books from Project Gutenberg and Standard Ebooks. When you add one, Theorem downloads it straight from their websites. The Discover page has no accounts and keeps no logs of what you browse or search, and what you read stays on your device.

## Add a book to your library

1. Tap a book. A window opens with the cover, title, author and description.
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

Catalogs that follow the OPDS standard work in Theorem. This includes many school, university and public library catalogs, Calibre content servers, Calibre-Web, Kavita, Komga, COPS, and public collections. Both OPDS 1.x and OPDS 2.0 are supported.

1. Tap Add a catalog at the top of Discover, or in the Bring your library card. Once you have catalogs, it is the plus button at the end of the tabs.
2. Type or paste the catalog's address. You can leave out `https://`, and addresses such as `192.168.1.10:8080/opds` or `nas.local/opds` work. Links that start with `opds://` also work. Addresses on your own network use `http` unless you say otherwise.
3. Tap Check address. Theorem contacts the catalog and tells you what it found, for example "OPDS 2.0 · 4 sections · search", or explains the problem.
4. If the catalog asks for a sign-in, the username and password fields appear by themselves, with the catalog's own wording. Fill them in and check again. If the catalog opens without a sign-in but you have an account there (some libraries show more books to members), tap Have an account? Add sign-in details, then check again.
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

When a catalog needs a login, you see a sign-in form. Enter your username and password. Leave Remember on this device on to stay signed in. Your login is stored only on this device. It is not synced to your other devices, and it is saved only after the catalog accepts it, so a mistyped password never replaces a working one. A lock icon on the catalog's tab shows that you are signed in. To forget a login, tap the three dots and choose Forget sign-in.

Some libraries sign in with a method Theorem cannot use yet. The sign-in form says so. You can still use that library's public pages in a web browser.

### Remove a catalog you added

Open the catalog, tap the three dots and choose Remove catalog. Books you already added stay in your library. When you remove the last one, the tabs disappear and Discover is the whole page again.

Before version 1.6.0, Project Gutenberg and Standard Ebooks were tabs of their own. Their books are now on the Discover page, so those tabs are gone, except one you had signed in to. You can still add either by its address.

## Troubleshooting catalogs

See [Troubleshooting](troubleshooting.md#catalogs-in-discover) for what to do when a catalog will not open or a download fails.
