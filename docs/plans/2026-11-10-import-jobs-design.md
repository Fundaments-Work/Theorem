# Native import jobs (#180)

The import lifetime belongs to Rust. The WebView submits requests and displays
snapshots; opening a reader hides the panel without cancelling the worker.
Android document-provider copying remains in the Android plugin, with byte
updates and a foreground data-sync service started by an explicit import or
resume action. The service stops on completion, cancellation, error, or Android's
service timeout. Force-stop is never treated as a supported execution mode.

A versioned, device-local checkpoint records stable job and book identities,
pending source requests, source-folder preservation options, completed results,
and per-file errors. SQLite transactions commit each book's metadata and its
checkpoint acknowledgment together. Resume skips acknowledged results and does
not write their metadata again, preserving reading progress and manual edits.
Interrupted files restart from the beginning using their stable identity.
Unknown or corrupt checkpoint versions remain intact and produce a visible error.

The existing native ingestion contract remains available. A shared progress
snapshot reports file counts and the current per-file stage: copying, checking,
preparing an archive, extracting metadata, and saving. Only stages with real
measurements have percentages and byte totals; other stages are indeterminate.
Copy completion is separate from successful metadata persistence. The panel
sits outside the library scrolling/containment surface and exposes cancellation,
errors, and explicit resume. Browser imports retain their existing fallback.

Verification covers transaction rollback, interrupted work, mixed success,
corrupt checkpoints, stable identities, duplicate avoidance, cancellation,
source-folder preservation, unknown sizes, and values above the 32-bit (`u32::MAX`) boundary (`src-tauri/src/import_jobs/`).
Settings folder imports (`LibraryFoldersSection.tsx`) and Android document/folder imports opt into durable native jobs (`durable: true`), Android materialization runs on its own `importExecutor` with `SecurityException`-safe persistent permissions and `EXTRA_GENERATION` service tokens, and unit tests cover snapshot counts, panel visibility, Android provider failures/permissions (`FolderScanPluginTest.kt`), and generation-scoped cancellation (`ImportServiceTest.kt`).
Real-app tests (`e2e/specs/`) cover navigation during an import, library return, resume, and viewport containment;
physical Android large-file/background/recovery acceptance remains a separate manual verification requirement before release.
