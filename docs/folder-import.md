# Importing folders

Choose **Scan Folder**, then select **Preserve folder structure** (the default) or **Import as a flat library** before choosing a directory. Both modes scan supported books recursively and leave original files in place.

Preserved imports appear in **Source folders** in the library. Select a source, open subfolders, and use the breadcrumbs to go back. A folder view includes its descendants and works with library search and filters. Select **All library books** to leave folder browsing. Only folders containing successfully imported books are represented; empty directories are not imported.

Source folders are independent of shelves. Rescanning an existing book with preservation enabled adds its folder membership through existing duplicate detection, retaining reading progress and shelf membership. A duplicate found under another source can appear in both places without adding a second book record. A flat rescan does not erase previously preserved memberships. To organize books imported before this feature, scan their original folder with preservation enabled.

## Implementation and verification

The native desktop and Android scanners now return `path`, `relativePath`, and `rootName` records. Android uses names encountered during directory traversal rather than interpreting document IDs. Rebuild the native application alongside the frontend because the scanner response contract changed.

Optional `Book.sourceFolders` entries are persisted with library schema version 7; legacy books receive an empty list during migration. The source metadata does not alter materialized storage paths. This change does not add peer synchronization of source folders.

Regression coverage: `folder-scanning.test.ts`, `source-folders.test.ts`, and `folder-import-ui.test.tsx`.
