//! `theorem highlights` and `theorem bookmarks`.

use super::*;

#[derive(Subcommand)]
pub(super) enum HighlightsCommand {
    /// List annotations, optionally for one book
    List {
        #[arg(long)]
        book: Option<String>,
    },
    /// Export highlights and notes to Markdown, JSON, or CSV
    Export {
        /// Export format: md | json | csv
        #[arg(long, default_value = "md")]
        format: String,

        /// Filter by book id
        #[arg(long)]
        book: Option<String>,

        /// Filter by minimum ISO-8601 created/updated date (e.g. 2026-01-01)
        #[arg(long)]
        since: Option<String>,

        /// Write output to a file instead of stdout
        #[arg(long)]
        out: Option<PathBuf>,
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
        HighlightsCommand::Export {
            format,
            book,
            since,
            out,
        } => highlights_export(output, ctx, &format, book.as_deref(), since.as_deref(), out),
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
        Ok(false) => return output.error(book_not_found(book_id)),
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
            return Err(AppError::not_found(format!(
                "annotation '{annotation_id}' not found"
            )));
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

fn highlights_export(
    output: &Output,
    ctx: &Ctx,
    format: &str,
    book: Option<&str>,
    since: Option<&str>,
    out: Option<PathBuf>,
) -> i32 {
    let fmt = match format.to_ascii_lowercase().as_str() {
        "md" | "markdown" => "md",
        "json" => "json",
        "csv" => "csv",
        other => return output.usage(&format!("invalid --format '{other}' (md, json, or csv)")),
    };

    if let Some(book_id) = book {
        let exists = ctx.store.with_connection(|conn| {
            Ok(crate::database::sqlite_get_book_metadata_inner(conn, book_id)?.is_some())
        });
        match exists {
            Ok(false) => return output.error(book_not_found(book_id)),
            Err(e) => return output.error(&e),
            Ok(true) => {}
        }
    }

    let all_annos = match load_annotations(ctx, book) {
        Ok(items) => items,
        Err(e) => return output.error(&e),
    };

    let since_trimmed = since.map(str::trim).filter(|s| !s.is_empty());

    let filtered: Vec<serde_json::Value> = all_annos
        .into_iter()
        .filter(|a| {
            if book_str(a, "type") == Some("bookmark") {
                return false;
            }
            if let Some(since_str) = since_trimmed {
                let created = book_str(a, "createdAt").unwrap_or("");
                let updated = book_str(a, "updatedAt").unwrap_or("");
                if created < since_str && updated < since_str {
                    return false;
                }
            }
            true
        })
        .collect();

    let books = match load_books(ctx) {
        Ok(books) => books,
        Err(e) => return output.error(&e),
    };
    let book_map: HashMap<String, &serde_json::Value> = books
        .iter()
        .filter_map(|b| Some((book_str(b, "id")?.to_string(), b)))
        .collect();

    let count = filtered.len();
    let text = match fmt {
        "json" => {
            let enriched: Vec<serde_json::Value> = filtered
                .into_iter()
                .map(|mut a| {
                    if let Some(book_id) = book_str(&a, "bookId") {
                        if let Some(b) = book_map.get(book_id) {
                            if let Some(title) = book_str(b, "title") {
                                if let Some(obj) = a.as_object_mut() {
                                    obj.insert(
                                        "bookTitle".into(),
                                        serde_json::Value::String(title.to_string()),
                                    );
                                }
                            }
                            if let Some(author) = book_str(b, "author") {
                                if let Some(obj) = a.as_object_mut() {
                                    obj.insert(
                                        "bookAuthor".into(),
                                        serde_json::Value::String(author.to_string()),
                                    );
                                }
                            }
                        }
                    }
                    a
                })
                .collect();
            match serde_json::to_string_pretty(&enriched) {
                Ok(s) => s,
                Err(e) => return output.error(e.to_string()),
            }
        }
        "csv" => {
            let mut csv = String::from("id,book_id,book_title,book_author,type,color,created_at,chapter_title,selected_text,note_content\n");
            for a in &filtered {
                let id = book_str(a, "id").unwrap_or("");
                let b_id = book_str(a, "bookId").unwrap_or("");
                let b = book_map.get(b_id);
                let title = b.and_then(|b| book_str(b, "title")).unwrap_or("");
                let author = b.and_then(|b| book_str(b, "author")).unwrap_or("");
                let r#type = book_str(a, "type").unwrap_or("highlight");
                let color = book_str(a, "color").unwrap_or("yellow");
                let created = book_str(a, "createdAt").unwrap_or("");
                let chapter = book_str(a, "chapterTitle").unwrap_or("");
                let text = book_str(a, "selectedText").unwrap_or("");
                let note = book_str(a, "noteContent").unwrap_or("");

                csv.push_str(&format!(
                    "{},{},{},{},{},{},{},{},{},{}\n",
                    escape_csv(id),
                    escape_csv(b_id),
                    escape_csv(title),
                    escape_csv(author),
                    escape_csv(r#type),
                    escape_csv(color),
                    escape_csv(created),
                    escape_csv(chapter),
                    escape_csv(text),
                    escape_csv(note),
                ));
            }
            csv
        }
        "md" => {
            let mut book_groups: Vec<(String, Vec<&serde_json::Value>)> = Vec::new();
            for a in &filtered {
                let b_id = book_str(a, "bookId").unwrap_or("").to_string();
                if let Some(group) = book_groups.iter_mut().find(|(id, _)| *id == b_id) {
                    group.1.push(a);
                } else {
                    book_groups.push((b_id, vec![a]));
                }
            }

            let mut pages = Vec::new();
            for (b_id, annos) in book_groups {
                let b = book_map.get(&b_id);
                let title = b
                    .and_then(|b| book_str(b, "title"))
                    .unwrap_or("Unknown Book");
                let author = b.and_then(|b| book_str(b, "author")).unwrap_or("");
                let format = b.and_then(|b| book_str(b, "format")).unwrap_or("");
                let file_path = b.and_then(|b| book_str(b, "filePath")).unwrap_or("");

                let source = crate::vault_export::ExportSource {
                    id: b_id.clone(),
                    title: title.to_string(),
                    author: author.to_string(),
                    format: format.to_string(),
                    file_path: file_path.to_string(),
                };

                let vault_annos: Vec<crate::vault_export::VaultAnnotation> = annos
                    .iter()
                    .map(|a| crate::vault_export::VaultAnnotation {
                        id: book_str(a, "id").unwrap_or("").to_string(),
                        book_id: b_id.clone(),
                        r#type: book_str(a, "type").unwrap_or("highlight").to_string(),
                        selected_text: book_str(a, "selectedText").map(str::to_string),
                        note_content: book_str(a, "noteContent").map(str::to_string),
                        color: book_str(a, "color").map(str::to_string),
                        created_at: book_str(a, "createdAt").unwrap_or("").to_string(),
                        updated_at: book_str(a, "updatedAt").map(str::to_string),
                        chapter_title: book_str(a, "chapterTitle").map(str::to_string),
                        chapter_index: a
                            .get("chapterIndex")
                            .and_then(|v| v.as_u64())
                            .map(|v| v as usize),
                    })
                    .collect();

                let md = crate::vault_export::build_book_page_markdown(
                    &source,
                    &vault_annos,
                    &now_iso(),
                    crate::vault_export::VaultExportPreset::Obsidian,
                    crate::vault_export::VaultHighlightGrouping::ByChapter,
                );
                pages.push(md);
            }
            if pages.is_empty() {
                "_No highlights match the criteria._\n".to_string()
            } else {
                pages.join("\n\n---\n\n") + "\n"
            }
        }
        _ => unreachable!(),
    };

    match out {
        Some(path) => {
            if let Some(parent) = path.parent() {
                if !parent.as_os_str().is_empty() {
                    let _ = std::fs::create_dir_all(parent);
                }
            }
            if let Err(e) = std::fs::write(&path, text.as_bytes()) {
                return output.error(format!("Failed to write {}: {e}", path.display()));
            }
            if output.json {
                output.print_json(&serde_json::json!({
                    "path": path.display().to_string(),
                    "exported": count,
                    "format": fmt,
                }))
            } else {
                println!(
                    "{} {} annotations to {}",
                    output.green("exported"),
                    count,
                    output.bold(&path.display().to_string())
                );
                0
            }
        }
        None => {
            print!("{text}");
            0
        }
    }
}

fn escape_csv(val: &str) -> String {
    if val.contains(',') || val.contains('"') || val.contains('\n') || val.contains('\r') {
        format!("\"{}\"", val.replace('"', "\"\""))
    } else {
        val.to_string()
    }
}
