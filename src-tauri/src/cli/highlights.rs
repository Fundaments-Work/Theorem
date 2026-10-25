//! `theorem highlights` and `theorem bookmarks`.

use super::*;

#[derive(Subcommand)]
pub(super) enum HighlightsCommand {
    /// List annotations, optionally for one book
    List {
        #[arg(long)]
        book: Option<String>,
    },
    /// Add a note or highlight annotation
    Add {
        book_id: String,
        /// Highlighted text (or the note itself for --type note)
        #[arg(long)]
        text: String,
        /// Note content attached to the annotation
        #[arg(long)]
        note: Option<String>,
        /// highlight | note
        #[arg(long, default_value = "highlight")]
        r#type: String,
        /// Highlight color
        #[arg(long, default_value = "yellow")]
        color: String,
    },
    /// Delete an annotation by id
    Delete { annotation_id: String },
}

#[derive(Subcommand)]
pub(super) enum BookmarksCommand {
    /// List bookmarks, optionally for one book
    List {
        #[arg(long)]
        book: Option<String>,
    },
}

pub(super) fn run_highlights(output: &Output, ctx: &Ctx, command: HighlightsCommand) -> i32 {
    match command {
        HighlightsCommand::List { book } => highlights_list(output, ctx, book.as_deref(), false),
        HighlightsCommand::Add {
            book_id,
            text,
            note,
            r#type,
            color,
        } => highlights_add(
            output,
            ctx,
            &book_id,
            &text,
            note.as_deref(),
            &r#type,
            &color,
        ),
        HighlightsCommand::Delete { annotation_id } => {
            highlights_delete(output, ctx, &annotation_id)
        }
    }
}

/// Annotations from `book_annotations`, each with its `bookId`.
pub(super) fn load_annotations(
    ctx: &Ctx,
    book: Option<&str>,
) -> Result<Vec<serde_json::Value>, String> {
    let rows: Vec<(String, String)> = ctx.store.with_connection(|conn| {
        let mut stmt = conn.prepare(
            "SELECT book_id, annotation_json FROM book_annotations \
             WHERE (?1 IS NULL OR book_id = ?1) ORDER BY book_id, updated_at",
        )?;
        let mapped = stmt.query_map(rusqlite::params![book], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        mapped.collect::<rusqlite::Result<Vec<_>>>()
    })?;
    Ok(rows
        .into_iter()
        .filter_map(|(book_id, json)| {
            let mut value = serde_json::from_str::<serde_json::Value>(&json).ok()?;
            value
                .as_object_mut()?
                .insert("bookId".into(), serde_json::Value::String(book_id));
            Some(value)
        })
        .collect())
}

fn highlights_list(output: &Output, ctx: &Ctx, book: Option<&str>, bookmarks: bool) -> i32 {
    match load_annotations(ctx, book) {
        Ok(items) => {
            let items: Vec<serde_json::Value> = items
                .into_iter()
                .filter(|a| !bookmarks || book_str(a, "type") == Some("bookmark"))
                .collect();
            output.print_json(&items)
        }
        Err(e) => output.error(&e),
    }
}

fn highlights_add(
    output: &Output,
    ctx: &Ctx,
    book_id: &str,
    text: &str,
    note: Option<&str>,
    annotation_type: &str,
    color: &str,
) -> i32 {
    let annotation_type = match annotation_type {
        "highlight" | "note" => annotation_type.to_string(),
        other => {
            return output.usage(&format!("invalid --type '{other}' (highlight or note)"));
        }
    };

    let id = uuid::Uuid::new_v4().to_string();
    let mut annotation = serde_json::json!({
        "id": id,
        "bookId": book_id,
        "type": annotation_type,
        "location": "",
        "selectedText": text,
        "color": color,
        "createdAt": now_iso(),
    });
    if let Some(note) = note {
        annotation["noteContent"] = serde_json::Value::String(note.to_string());
    }
    let json = annotation.to_string();

    // As the app's `addAnnotation`: one `book_annotations` row.
    let added = ctx.store.with_connection(|conn| {
        if crate::database::sqlite_get_book_metadata_inner(conn, book_id)?.is_none() {
            return Ok(false);
        }
        crate::database::sqlite_upsert_annotation_inner(conn, &id, book_id, &json)?;
        Ok(true)
    });
    match added {
        Ok(true) => {}
        Ok(false) => return output.error(&book_not_found(book_id)),
        Err(e) => return output.error(&e),
    }

    if output.json {
        output.print_json(&serde_json::json!({ "id": id, "bookId": book_id }))
    } else {
        println!("{} annotation {id}", output.green("added"));
        0
    }
}

fn highlights_delete(output: &Output, ctx: &Ctx, annotation_id: &str) -> i32 {
    // As the app's `removeAnnotation`: delete the row and leave a tombstone.
    let deleted = update_library_kv(ctx, |conn, envelope| {
        let exists = conn
            .query_row(
                "SELECT 1 FROM book_annotations WHERE id = ?1",
                rusqlite::params![annotation_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .is_some();
        if !exists {
            return Err(format!("annotation '{annotation_id}' not found"));
        }
        crate::database::sqlite_delete_annotation_inner(conn, annotation_id)
            .map_err(|e| e.to_string())?;
        let state = envelope_state(envelope, LIBRARY_STORE)?;
        state_list(state, "deletionTombstones", LIBRARY_STORE)?
            .push(tombstone(annotation_id, "annotation"));
        Ok(())
    });
    if let Err(e) = deleted {
        return output.error(&e);
    }

    if output.json {
        output.print_json(&serde_json::json!({ "deleted": annotation_id }))
    } else {
        println!("{} {annotation_id}", output.green("deleted"));
        0
    }
}

pub(super) fn run_bookmarks(output: &Output, ctx: &Ctx, command: BookmarksCommand) -> i32 {
    let BookmarksCommand::List { book } = command;
    highlights_list(output, ctx, book.as_deref(), true)
}
