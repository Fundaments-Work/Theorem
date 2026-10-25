//! Reading and updating the library store the app persists (books, collections).

use super::*;

//
// Books live in SQLite, as the 1.6.0 app keeps them: one `book_metadata` row
// per book (the book record as JSON), a `books` row, the file in
// `book-cache/{id}.book`, the cover in `covers` and title/author in
// `books_fts`. Annotations are `book_annotations` rows. Only shelves
// (collections) and deletion tombstones are still in the app's persisted KV
// copy of the library store, `zustand:theorem-library`; its `books` and
// `annotations` lists are left alone (the app only keeps records there that
// are still waiting to move into SQLite).

pub(super) const LIBRARY_KV_KEY: &str = "zustand:theorem-library";
/// The persisted library store's version in 1.6.0 (`libraryStore.ts`).
const LIBRARY_KV_VERSION: u64 = 11;
pub(super) const LIBRARY_STORE: &str = "Library store";

pub(super) fn empty_library_envelope() -> serde_json::Value {
    serde_json::json!({
        "state": {
            "books": [],
            "annotations": [],
            "collections": [],
            "deletionTombstones": [],
        },
        "version": LIBRARY_KV_VERSION,
    })
}

/// The `state` object of a persisted zustand envelope. A missing `state` is
/// created; anything that is not an object is an error, never a panic.
pub(super) fn envelope_state<'a>(
    envelope: &'a mut serde_json::Value,
    store: &str,
) -> Result<&'a mut serde_json::Map<String, serde_json::Value>, String> {
    let root = envelope
        .as_object_mut()
        .ok_or_else(|| format!("{store} is malformed: it is not a JSON object"))?;
    let state = root.entry("state").or_insert_with(|| serde_json::json!({}));
    if state.is_null() {
        *state = serde_json::json!({});
    }
    state
        .as_object_mut()
        .ok_or_else(|| format!("{store} is malformed: \"state\" is not an object"))
}

/// A list field of a store's state, created when missing or null.
pub(super) fn state_list<'a>(
    state: &'a mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    store: &str,
) -> Result<&'a mut Vec<serde_json::Value>, String> {
    let value = state.entry(key).or_insert_with(|| serde_json::json!([]));
    if value.is_null() {
        *value = serde_json::json!([]);
    }
    value
        .as_array_mut()
        .ok_or_else(|| format!("{store} is malformed: \"{key}\" is not a list"))
}

/// Read a KV envelope for a read-only command.
pub(super) fn read_kv_envelope(
    ctx: &Ctx,
    key: &str,
    store: &str,
    empty: fn() -> serde_json::Value,
) -> Result<serde_json::Value, String> {
    match ctx.kv_get(key)? {
        Some(text) => serde_json::from_str(&text).map_err(|e| format!("{store} is malformed: {e}")),
        None => Ok(empty()),
    }
}

/// Read-modify-write a KV envelope inside one `BEGIN IMMEDIATE` transaction:
/// concurrent CLI writers queue on SQLite's write lock instead of reading the
/// same old copy and overwriting each other's changes. `f` also gets the
/// transaction's connection for checks that must see the same snapshot. When
/// `f` fails nothing is written.
fn update_kv_envelope<T>(
    ctx: &Ctx,
    key: &str,
    store: &str,
    empty: fn() -> serde_json::Value,
    f: impl FnOnce(&rusqlite::Connection, &mut serde_json::Value) -> Result<T, String>,
) -> Result<T, String> {
    ctx.store.with_connection(|conn| {
        let tx =
            rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
        let mut envelope = match crate::database::sqlite_get_kv_inner(&tx, key)? {
            Some(text) => match serde_json::from_str::<serde_json::Value>(&text) {
                Ok(value) => value,
                Err(e) => return Ok(Err(format!("{store} is malformed: {e}"))),
            },
            None => empty(),
        };
        let value = match f(&tx, &mut envelope) {
            Ok(value) => value,
            Err(e) => return Ok(Err(e)),
        };
        let text = match serde_json::to_string(&envelope) {
            Ok(text) => text,
            Err(e) => return Ok(Err(format!("Failed to serialize {store}: {e}"))),
        };
        crate::database::sqlite_set_kv_inner(&tx, key, &text)?;
        tx.commit()?;
        Ok(Ok(value))
    })?
}

pub(super) fn update_library_kv<T>(
    ctx: &Ctx,
    f: impl FnOnce(&rusqlite::Connection, &mut serde_json::Value) -> Result<T, String>,
) -> Result<T, String> {
    update_kv_envelope(
        ctx,
        LIBRARY_KV_KEY,
        LIBRARY_STORE,
        empty_library_envelope,
        f,
    )
}

pub(super) fn library_collections(ctx: &Ctx) -> Result<Vec<serde_json::Value>, String> {
    let mut envelope =
        read_kv_envelope(ctx, LIBRARY_KV_KEY, LIBRARY_STORE, empty_library_envelope)?;
    let state = envelope_state(&mut envelope, LIBRARY_STORE)?;
    Ok(state_list(state, "collections", LIBRARY_STORE)?.clone())
}

pub(super) fn tombstone(entity_id: &str, entity_type: &str) -> serde_json::Value {
    serde_json::json!({
        "entityId": entity_id,
        "entityType": entity_type,
        "deletedAt": now_iso(),
    })
}

pub(crate) fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub(crate) fn book_str<'a>(book: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    book.get(key).and_then(|v| v.as_str())
}

pub(crate) fn book_title(book: &serde_json::Value) -> String {
    book_str(book, "title").unwrap_or("(untitled)").to_string()
}

pub(crate) fn book_author(book: &serde_json::Value) -> String {
    book_str(book, "author").unwrap_or("").to_string()
}

/// Every book in the library (`book_metadata`), sorted by title. Rows that
/// are not valid JSON objects are skipped.
pub(crate) fn load_books(ctx: &Ctx) -> Result<Vec<serde_json::Value>, String> {
    let rows = ctx
        .store
        .with_connection(crate::database::sqlite_load_all_books_inner)?;
    let mut books: Vec<serde_json::Value> = rows
        .iter()
        .filter_map(|json| serde_json::from_str::<serde_json::Value>(json).ok())
        .filter(|book| book.is_object() && book_str(book, "id").is_some())
        .collect();
    books.sort_by_cached_key(|book| book_title(book).to_lowercase());
    Ok(books)
}

/// One book's record, or `None` when the library has no such book.
pub(super) fn load_book(ctx: &Ctx, book_id: &str) -> Result<Option<serde_json::Value>, String> {
    let raw = ctx
        .store
        .with_connection(|conn| crate::database::sqlite_get_book_metadata_inner(conn, book_id))?;
    match raw {
        None => Ok(None),
        Some(text) => serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .filter(|book| book.is_object())
            .map(Some)
            .ok_or_else(|| format!("book '{book_id}' has a malformed record")),
    }
}

pub(super) fn book_not_found(book_id: &str) -> String {
    format!("book '{book_id}' not found in library")
}

/// The details a user edits; sync treats them as one unit
/// (`BOOK_EDITABLE_FIELDS` in `book-edit-stamp.ts`).
const BOOK_EDITABLE_FIELDS: &[&str] = &[
    "title",
    "author",
    "description",
    "publisher",
    "language",
    "isbn",
    "publishedDate",
    "category",
    "isFavorite",
    "tags",
    "rating",
    "completedAt",
    "manualCompletionState",
    "series",
    "seriesIndex",
];

/// Stamp an edit the way the app's `withMetadataStamp` does, so sync can tell
/// it from a concurrent edit on another device.
fn stamp_metadata_edit(before: &serde_json::Value, after: &mut serde_json::Value) {
    let edited = BOOK_EDITABLE_FIELDS
        .iter()
        .any(|field| before.get(*field) != after.get(*field));
    let Some(object) = after.as_object_mut() else {
        return;
    };
    if !edited {
        return;
    }
    object.remove("metadataBaseAt");
    object.insert("metadataUpdatedAt".into(), serde_json::json!(now_iso()));
    if let Some(previous) = before.get("metadataUpdatedAt").filter(|v| !v.is_null()) {
        object.insert("metadataBaseAt".into(), previous.clone());
    }
}

/// Edit one book's record inside a write transaction (no lost updates when
/// commands run in parallel). `f` returns the edited record, or an error.
pub(super) fn update_book<T>(
    ctx: &Ctx,
    book_id: &str,
    f: impl FnOnce(&mut serde_json::Value) -> Result<T, String>,
) -> Result<T, String> {
    ctx.store.with_connection(|conn| {
        let tx =
            rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
        let Some(text) = crate::database::sqlite_get_book_metadata_inner(&tx, book_id)? else {
            return Ok(Err(book_not_found(book_id)));
        };
        let Some(before) = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .filter(|b| b.is_object())
        else {
            return Ok(Err(format!("book '{book_id}' has a malformed record")));
        };
        let mut after = before.clone();
        let value = match f(&mut after) {
            Ok(value) => value,
            Err(e) => return Ok(Err(e)),
        };
        stamp_metadata_edit(&before, &mut after);
        let json = match serde_json::to_string(&after) {
            Ok(json) => json,
            Err(e) => return Ok(Err(e.to_string())),
        };
        crate::database::sqlite_save_book_metadata_inner(&tx, book_id, &json)?;
        tx.commit()?;
        Ok(Ok(value))
    })?
}
