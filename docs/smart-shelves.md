# Smart shelves

In the desktop or Android app, open Shelves, create or edit a shelf, and enable **Smart shelf**. Choose **All rules** (AND) or **Any rule** (OR), then add rules for author, series, tag, category, format, reading status, or favorite. Text rules match without case sensitivity; author matching checks each author. Equals matches the whole value; Contains matches a substring. A shelf requires 1–32 nonempty rules.

Membership updates when books are imported, edited, deleted, marked read/unread, or reading progress changes. A manually marked read/unread state takes precedence over inferred completion, matching normal library filters. RSS articles are excluded. Series grouping and normal library filtering work with the derived book list.

Smart shelves cannot have books manually assigned or removed. Edit the rules or book metadata instead. Changing an existing manual shelf to smart uses the rules for membership. Turning smart mode off retains the currently matching books as a manual shelf. Deleting the shelf keeps its books in the library.

Only rule definitions are persisted and synchronized. Each device derives results from its own available library; devices need this fork's smart-shelf implementation to display them. Evaluation runs in the shared Rust core on a background pool; the UI handles form state and IDs. Rapid updates cancel stale UI results and selection is disabled when the active view depends on pending membership. The browser demo does not currently evaluate smart shelves and displays an explicit availability message.

Validation includes Rust rule tests and UI tests for stale results, errors, editing/creation, and sync definitions. No external metadata requests or book uploads are needed.

Format rules use the library's stored format. Upstream converts successfully imported CBR archives to CBZ, so use a CBZ rule to include those converted comics.
