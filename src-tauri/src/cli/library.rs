//! `theorem library`: list, info, remove, favorite, export and edit books.

use super::*;

#[derive(Subcommand)]
pub(super) enum LibraryCommand {
    /// List library books with metadata
    List {
        /// Output format
        #[arg(long, default_value = "table")]
        format: String,
    },
    /// Show detailed info for one book
    Info { book_id: String },
    /// Import book files into the library (EPUB, MOBI, AZW3, FB2, PDF, CBZ)
    Add {
        /// Book files to import
        paths: Vec<String>,
    },
    /// Import every supported book file under a directory (recursive)
    Import { dir: String },
    /// Remove a book from the library (file, covers, annotations, metadata)
    Remove { book_id: String },
    /// Toggle or set a book's favorite flag
    Favorite {
        book_id: String,
        /// on | off | toggle (default: toggle)
        state: Option<String>,
    },
    /// Export the original book file to disk
    Export {
        book_id: String,
        /// Output path (default: ./<title>.<ext>)
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Rewrite title/author metadata inside an EPUB and the library index
    EditMeta {
        book_id: String,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        author: Option<String>,
    },
}

pub(super) fn run_library(output: &Output, ctx: &Ctx, command: LibraryCommand) -> i32 {
    match command {
        LibraryCommand::List { format } => library_list(output, ctx, &format),
        LibraryCommand::Info { book_id } => library_info(output, ctx, &book_id),
        LibraryCommand::Add { paths } => library_add(output, ctx, &paths),
        LibraryCommand::Import { dir } => library_import(output, ctx, &dir),
        LibraryCommand::Remove { book_id } => library_remove(output, ctx, &book_id),
        LibraryCommand::Favorite { book_id, state } => {
            library_favorite(output, ctx, &book_id, state.as_deref())
        }
        LibraryCommand::Export { book_id, out } => library_export(output, ctx, &book_id, out),
        LibraryCommand::EditMeta {
            book_id,
            title,
            author,
        } => library_edit_meta(output, ctx, &book_id, title, author),
    }
}

fn library_list(output: &Output, ctx: &Ctx, format: &str) -> i32 {
    let books = match load_books(ctx) {
        Ok(books) => books,
        Err(e) => return output.error(&e),
    };

    if output.json || format == "json" {
        return output.print_json(&books);
    }
    for book in &books {
        let title = book_title(book);
        let author = book_author(book);
        let progress = book.get("progress").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let favorite = if book
            .get("isFavorite")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            " *"
        } else {
            ""
        };
        println!(
            "{}  {}  {}{}",
            output.dim(book_str(book, "id").unwrap_or("?")),
            output.bold(&title),
            output.dim(&format!("{:.0}% {}", progress * 100.0, author)),
            favorite
        );
    }
    output.note(&format!("# {} books", books.len()));
    0
}

fn library_info(output: &Output, ctx: &Ctx, book_id: &str) -> i32 {
    let book = match load_book(ctx, book_id) {
        Ok(Some(book)) => book,
        Ok(None) => return output.error(&book_not_found(book_id)),
        Err(e) => return output.error(&e),
    };

    let annotation_count: i64 = ctx
        .store
        .with_connection(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM book_annotations WHERE book_id = ?1",
                rusqlite::params![book_id],
                |row| row.get(0),
            )
        })
        .unwrap_or(0);

    let materialized = crate::database::get_materialized_book_path_in(&ctx.store, book_id)
        .ok()
        .flatten();

    let info = serde_json::json!({
        "id": book_id,
        "title": book_title(&book),
        "author": book_author(&book),
        "format": book.get("format"),
        "fileSize": book.get("fileSize"),
        "progress": book.get("progress"),
        "isFavorite": book.get("isFavorite"),
        "addedAt": book.get("addedAt"),
        "lastReadAt": book.get("lastReadAt"),
        "tags": book.get("tags"),
        "series": book.get("series"),
        "seriesIndex": book.get("seriesIndex"),
        "annotationCount": annotation_count,
        "materializedPath": materialized,
        "filePath": book.get("filePath"),
    });

    if output.json {
        output.print_json(&info)
    } else {
        println!("{}", output.bold(&book_title(&book)));
        println!("  {}: {}", output.dim("id"), book_id);
        println!("  {}: {}", output.dim("author"), book_author(&book));
        println!(
            "  {}: {}",
            output.dim("format"),
            book_str(&book, "format").unwrap_or("?")
        );
        if let Some(series) = book_str(&book, "series") {
            match book.get("seriesIndex").and_then(|v| v.as_f64()) {
                Some(index) => println!("  {}: {series} #{index}", output.dim("series")),
                None => println!("  {}: {series}", output.dim("series")),
            }
        }
        println!(
            "  {}: {}",
            output.dim("progress"),
            book.get("progress").and_then(|v| v.as_f64()).unwrap_or(0.0)
        );
        println!(
            "  {}: {}",
            output.dim("favorite"),
            book.get("isFavorite")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        );
        println!("  {}: {}", output.dim("annotations"), annotation_count);
        if let Some(path) = materialized {
            println!("  {}: {}", output.dim("file"), path);
        }
        0
    }
}

fn library_remove(output: &Output, ctx: &Ctx, book_id: &str) -> i32 {
    let book = match load_book(ctx, book_id) {
        Ok(Some(book)) => book,
        Ok(None) => return output.error(&book_not_found(book_id)),
        Err(e) => return output.error(&e),
    };
    let title = book_title(&book);

    // Collect annotation ids first for tombstones (the rows are about to go).
    let annotation_ids: Vec<String> = match ctx.store.with_connection(|conn| {
        let mut stmt = conn.prepare("SELECT id FROM book_annotations WHERE book_id = ?1")?;
        let rows = stmt.query_map(rusqlite::params![book_id], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    }) {
        Ok(ids) => ids,
        Err(e) => return output.error(&e),
    };

    // Same path as the app: removes the cached file and, in one transaction,
    // the book's covers, metadata, highlights and search row.
    if let Err(e) = crate::database::delete_book_data_in(&ctx.store, book_id) {
        return output.error(&e);
    }

    // As the app's `removeBooks`: leave every shelf, and tombstones so sync
    // removes the book and its highlights on other devices too.
    let kv = update_library_kv(ctx, |_, envelope| {
        let state = envelope_state(envelope, LIBRARY_STORE)?;
        for collection in state_list(state, "collections", LIBRARY_STORE)?.iter_mut() {
            if let Some(ids) = collection.get_mut("bookIds").and_then(|v| v.as_array_mut()) {
                ids.retain(|id| id.as_str() != Some(book_id));
            }
        }
        let tombstones = state_list(state, "deletionTombstones", LIBRARY_STORE)?;
        tombstones.push(tombstone(book_id, "book"));
        for annotation_id in &annotation_ids {
            tombstones.push(tombstone(annotation_id, "annotation"));
        }
        Ok(())
    });
    if let Err(e) = kv {
        return output.error(&e);
    }

    if output.json {
        output.print_json(&serde_json::json!({ "removed": book_id, "title": title }))
    } else {
        println!("{} {title}", output.green("removed"));
        0
    }
}

fn library_favorite(output: &Output, ctx: &Ctx, book_id: &str, state: Option<&str>) -> i32 {
    let wanted = match state.unwrap_or("toggle") {
        "on" | "true" | "yes" => Some(true),
        "off" | "false" | "no" => Some(false),
        "toggle" => None,
        other => {
            return output.usage(&format!(
                "invalid state '{other}' (expected on, off or toggle)"
            ));
        }
    };
    let result = update_book(ctx, book_id, |book| {
        let current = book
            .get("isFavorite")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let next = wanted.unwrap_or(!current);
        book["isFavorite"] = serde_json::Value::Bool(next);
        Ok((next, book_title(book)))
    });
    let (next, title) = match result {
        Ok(result) => result,
        Err(e) => return output.error(&e),
    };

    if output.json {
        output.print_json(&serde_json::json!({ "id": book_id, "isFavorite": next }))
    } else {
        let label = if next { "favorited" } else { "unfavorited" };
        println!("{} {title}", output.green(label));
        0
    }
}

fn library_export(output: &Output, ctx: &Ctx, book_id: &str, out: Option<PathBuf>) -> i32 {
    let book = match load_book(ctx, book_id) {
        Ok(Some(book)) => book,
        Ok(None) => return output.error(&book_not_found(book_id)),
        Err(e) => return output.error(&e),
    };

    let format = book_str(&book, "format").unwrap_or("epub").to_string();
    let source = match crate::database::get_materialized_book_path_in(&ctx.store, book_id) {
        Ok(Some(path)) => PathBuf::from(path),
        Ok(None) => return output.error("book file not found on disk or in storage"),
        Err(e) => return output.error(&e),
    };

    let target = out.unwrap_or_else(|| {
        let title = book_title(&book)
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' {
                    c
                } else {
                    ' '
                }
            })
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join("_");
        let title = if title.is_empty() {
            book_id.to_string()
        } else {
            title
        };
        PathBuf::from(format!("{title}.{format}"))
    });
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return output.error(&format!("Cannot create {}: {e}", parent.display()));
            }
        }
    }
    let bytes = match std::fs::copy(&source, &target) {
        Ok(bytes) => bytes,
        Err(e) => return output.error(&format!("Failed to write {}: {e}", target.display())),
    };

    if output.json {
        output.print_json(&serde_json::json!({
            "id": book_id,
            "path": target.display().to_string(),
            "bytes": bytes,
        }))
    } else {
        println!(
            "{} {} ({} bytes)",
            output.green("exported"),
            output.bold(&target.display().to_string()),
            bytes
        );
        0
    }
}

fn library_edit_meta(
    output: &Output,
    ctx: &Ctx,
    book_id: &str,
    title: Option<String>,
    author: Option<String>,
) -> i32 {
    if title.is_none() && author.is_none() {
        return output
            .usage("usage: theorem library edit-meta <book-id> --title <title> --author <author>");
    }

    let book = match load_book(ctx, book_id) {
        Ok(Some(book)) => book,
        Ok(None) => return output.error(&book_not_found(book_id)),
        Err(e) => return output.error(&e),
    };
    let is_epub = book_str(&book, "format")
        .map(|f| f.eq_ignore_ascii_case("epub"))
        .unwrap_or(false);

    let mut file_rewritten = false;
    if is_epub {
        match crate::database::get_materialized_book_path_in(&ctx.store, book_id) {
            Ok(Some(path)) => {
                let edit = crate::epub_rewriter::EpubMetadataEdit {
                    title: title.clone(),
                    author: author.clone(),
                    ..Default::default()
                };
                if let Err(e) = crate::epub_rewriter::rewrite_epub_metadata_at(
                    std::path::Path::new(&path),
                    book_id,
                    Some(edit),
                    None,
                ) {
                    return output.error(&e);
                }
                file_rewritten = true;
            }
            Ok(None) => {
                output.note("the book's file is not on this device — updating the library only")
            }
            Err(e) => return output.error(&e),
        }
    } else {
        output.note("file is not an EPUB — updating the library index only");
    }

    // The metadata save also refreshes the search entry.
    let updated = update_book(ctx, book_id, |book| {
        if let Some(t) = &title {
            book["title"] = serde_json::Value::String(t.clone());
        }
        if let Some(a) = &author {
            book["author"] = serde_json::Value::String(a.clone());
        }
        Ok((book_title(book), book_author(book)))
    });
    let (new_title, new_author) = match updated {
        Ok(updated) => updated,
        Err(e) => return output.error(&e),
    };

    if output.json {
        output.print_json(&serde_json::json!({
            "id": book_id,
            "title": new_title,
            "author": new_author,
            "fileRewritten": file_rewritten,
        }))
    } else {
        println!("{} {}", output.green("updated"), output.bold(&new_title));
        0
    }
}
