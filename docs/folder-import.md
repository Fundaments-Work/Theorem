# Importing folders

Choose **Scan Folder**, then select **Preserve folder structure** (the default) or **Import as a flat library** before choosing a directory. Both modes scan supported books recursively and leave original files in place.

Preserved imports appear in **Source folders** in the library. Select a source, open subfolders, and use the breadcrumbs to go back. A folder view includes its descendants and works with library search and filters. Select **All library books** to leave folder browsing. Only folders containing successfully imported books are represented; empty directories are not imported.

Source folders are independent of shelves. Rescanning an existing book with preservation enabled adds its folder membership through existing duplicate detection, retaining reading progress and shelf membership. A duplicate found under another source can appear in both places without adding a second book record. A flat rescan does not erase previously preserved memberships. To organize books imported before this feature, scan their original folder with preservation enabled.

## What a scan does

- **Every file is accounted for.** Each supported book is imported, recognised as already in the library, or listed at the end with the reason it could not be used (empty, damaged, unreadable, removed during the import, permission denied). Folders that cannot be opened and links that loop back up the tree are listed too.
- **Hidden entries are skipped** (`.Trash`, `.caltrash`, macOS `._name` resource forks), and folders nested deeper than 64 levels are reported once and not walked.
- **Rescans are cheap.** A file already imported from the same path with the same size is skipped without being read. A file whose bytes are already in the library (moved, renamed, a second copy) is recognised before it is copied; a moved file's path is followed so the next rescan skips it unread. Two copies of one book in the same scan are imported once, and the second copy's folder is added to the book when folders are preserved.
- **Progress and Stop.** The library shows how many files are done, and **Stop** ends the scan or import at once. Books finished before that stay; the next scan picks up the rest. No partial file is left in the book cache.
- **No render storms.** Imported books reach the store in batches (at most every 250 ms or 200 books), progress is throttled to 10 updates a second, and folder changes to books already in the library are applied in one `updateBooks` call.

## Implementation and verification

- **Desktop:** `scan_library_folder_desktop` walks with `src-tauri/src/folder_walk.rs` (walkdir, follows links with loop detection) and returns `{ files, issues, cancelled }`; files carry `size` and `modifiedMs`. `ingest_books_native` (`batch_ingest.rs`) imports in parallel with rayon, hashes only files whose size matches another book, copies with the kernel (`copy_file_range`/reflink), and streams results over a Tauri `Channel` in batches. `cancel_import_job` stops either by job id. Cover thumbnails (most of an import's CPU) use an integer box filter and `jpeg-encoder`, with the image codecs built at `opt-level = 3` even in the size-optimised release profile.
- **Android:** `FolderScanPlugin.scanFolder` lists a tree URI with one `DocumentsContract` query per folder (returning sizes and modification times), skips hidden entries, stops at 64 levels and reports unreadable folders. Each book is copied once into a unique temporary file, which `import_book_path` moves into the book cache.
- **Orchestration:** `importFolder` in `src/core/lib/folder-import.ts` (diffing the scan against the library, batching, progress, Stop) is shared by both platforms; `Library.tsx` only wires it to the store and the status line (`FolderImportStatus.tsx`).

Measured on a 12-thread desktop with a 2,006-file corpus (1,902 distinct books, 100 duplicates, 2 files of 150 MB, junk, a link loop, unreadable entries, 8 levels deep): walk 9-20 ms, unchanged rescan (walk + diff) about 30 ms, cold import about 5 s (11 s before the cover work), peak memory about 125 MB.

Optional `Book.sourceFolders` entries are persisted with library schema version 7; legacy books receive an empty list during migration. The source metadata does not alter materialized storage paths. This change does not add peer synchronization of source folders.

Regression coverage: `src-tauri/tests/folder_import.rs` (walker + ingest end to end), `folder_walk.rs` and `batch_ingest.rs` unit tests, `folder-import.test.ts`, `native-import.test.ts`, `library-add-books-duplicates.test.ts`, `source-folders.test.ts`, `folder-scanning.test.ts` and `folder-import-ui.test.tsx`.
