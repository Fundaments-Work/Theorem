//! `theorem shelf`.

use super::*;

#[derive(Subcommand)]
pub(super) enum ShelfCommand {
    /// List shelves with book counts
    List,
    /// Create a new shelf
    Create { name: String },
    /// Delete a shelf (by name or id)
    Delete { shelf: String },
    /// Add a book to a shelf
    Add { shelf: String, book_id: String },
    /// Remove a book from a shelf
    Remove { shelf: String, book_id: String },
}

pub(super) fn run_shelf(output: &Output, ctx: &Ctx, command: ShelfCommand) -> i32 {
    match command {
        ShelfCommand::List => shelf_list(output, ctx),
        ShelfCommand::Create { name } => shelf_create(output, ctx, &name),
        ShelfCommand::Delete { shelf } => shelf_delete(output, ctx, &shelf),
        ShelfCommand::Add { shelf, book_id } => shelf_add(output, ctx, &shelf, &book_id, true),
        ShelfCommand::Remove { shelf, book_id } => shelf_add(output, ctx, &shelf, &book_id, false),
    }
}

fn shelf_list(output: &Output, ctx: &Ctx) -> i32 {
    let collections = match library_collections(ctx) {
        Ok(collections) => collections,
        Err(e) => return output.error(&e),
    };

    if output.json {
        output.print_json(&collections)
    } else {
        for collection in &collections {
            let name = book_str(collection, "name")
                .unwrap_or("(unnamed)")
                .to_string();
            let id = book_str(collection, "id").unwrap_or("?").to_string();
            let count = collection
                .get("bookIds")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            println!(
                "{}  {}  {}",
                output.dim(&id),
                output.bold(&name),
                output.dim(&format!("({count} books)"))
            );
        }
        output.note(&format!("# {} shelves", collections.len()));
        0
    }
}

fn find_collection_position(collections: &[serde_json::Value], shelf: &str) -> Option<usize> {
    collections
        .iter()
        .position(|c| book_str(c, "id") == Some(shelf))
        .or_else(|| {
            collections.iter().position(|c| {
                book_str(c, "name")
                    .map(|n| n.eq_ignore_ascii_case(shelf))
                    .unwrap_or(false)
            })
        })
}

fn shelf_create(output: &Output, ctx: &Ctx, name: &str) -> i32 {
    let name = name.trim();
    if name.is_empty() {
        return output.usage("a shelf needs a name");
    }
    let id = uuid::Uuid::new_v4().to_string();
    let created = update_library_kv(ctx, |_, envelope| {
        let state = envelope_state(envelope, LIBRARY_STORE)?;
        let collections = state_list(state, "collections", LIBRARY_STORE)?;
        if collections.iter().any(|c| {
            book_str(c, "name")
                .map(|n| n.eq_ignore_ascii_case(name))
                .unwrap_or(false)
        }) {
            return Err(format!("shelf '{name}' already exists"));
        }
        collections.push(serde_json::json!({
            "id": id,
            "name": name,
            "bookIds": [],
            "kind": "general",
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
        }));
        Ok(())
    });
    if let Err(e) = created {
        return output.error(&e);
    }

    if output.json {
        output.print_json(&serde_json::json!({ "id": id, "name": name }))
    } else {
        println!("{} {}", output.green("created"), output.bold(name));
        0
    }
}

fn shelf_delete(output: &Output, ctx: &Ctx, shelf: &str) -> i32 {
    let deleted = update_library_kv(ctx, |_, envelope| {
        let state = envelope_state(envelope, LIBRARY_STORE)?;
        let collections = state_list(state, "collections", LIBRARY_STORE)?;
        let position = find_collection_position(collections, shelf)
            .ok_or_else(|| format!("shelf '{shelf}' not found"))?;
        let removed = collections.remove(position);
        let removed_id = book_str(&removed, "id").unwrap_or("?").to_string();
        let removed_name = book_str(&removed, "name")
            .unwrap_or("(unnamed)")
            .to_string();
        state_list(state, "deletionTombstones", LIBRARY_STORE)?
            .push(tombstone(&removed_id, "collection"));
        Ok((removed_id, removed_name))
    });
    let (removed_id, removed_name) = match deleted {
        Ok(deleted) => deleted,
        Err(e) => return output.error(&e),
    };

    if output.json {
        output.print_json(&serde_json::json!({ "deleted": removed_id, "name": removed_name }))
    } else {
        println!("{} {removed_name}", output.green("deleted"));
        0
    }
}

fn book_exists(conn: &rusqlite::Connection, book_id: &str) -> Result<bool, String> {
    crate::database::sqlite_get_book_metadata_inner(conn, book_id)
        .map(|row| row.is_some())
        .map_err(|e| e.to_string())
}

fn shelf_add(output: &Output, ctx: &Ctx, shelf: &str, book_id: &str, add: bool) -> i32 {
    let changed = update_library_kv(ctx, |conn, envelope| {
        let state = envelope_state(envelope, LIBRARY_STORE)?;
        let collections = state_list(state, "collections", LIBRARY_STORE)?;
        let position = find_collection_position(collections, shelf)
            .ok_or_else(|| format!("shelf '{shelf}' not found"))?;
        if add && !book_exists(conn, book_id)? {
            return Err(book_not_found(book_id));
        }
        let collection = collections[position].as_object_mut().ok_or_else(|| {
            format!("{LIBRARY_STORE} is malformed: shelf '{shelf}' is not an object")
        })?;
        let collection_id = collection
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("?")
            .to_string();
        let book_ids = state_list(collection, "bookIds", LIBRARY_STORE)?;
        let already = book_ids.iter().any(|b| b.as_str() == Some(book_id));
        if add == already {
            return Ok(false);
        }
        if add {
            book_ids.push(serde_json::Value::String(book_id.to_string()));
        } else {
            book_ids.retain(|b| b.as_str() != Some(book_id));
        }
        collection.insert("updatedAt".into(), serde_json::json!(now_iso()));
        if !add {
            state_list(state, "deletionTombstones", LIBRARY_STORE)?.push(tombstone(
                &format!("{collection_id}:{book_id}"),
                "collection_book",
            ));
        }
        Ok(true)
    });
    match changed {
        Ok(true) => {}
        Ok(false) => {
            output.note(if add {
                "book already on shelf"
            } else {
                "book not on shelf"
            });
            if output.json {
                return output.print_json(&serde_json::json!({
                    "shelf": shelf,
                    "bookId": book_id,
                    "action": "none",
                }));
            }
            return 0;
        }
        Err(e) => return output.error(&e),
    }

    if output.json {
        output.print_json(&serde_json::json!({
            "shelf": shelf,
            "bookId": book_id,
            "action": if add { "added" } else { "removed" },
        }))
    } else {
        println!(
            "{} {} {} shelf {shelf}",
            output.green(if add { "added" } else { "removed" }),
            output.bold(book_id),
            if add { "to" } else { "from" }
        );
        0
    }
}
