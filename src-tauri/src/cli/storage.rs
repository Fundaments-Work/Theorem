//! `theorem storage`, `theorem stats` and `theorem export-snapshot`.

use super::*;

#[derive(Subcommand)]
pub(super) enum StorageCommand {
    /// Show SQLite storage usage
    Stats,
    /// Remove orphaned covers, blobs, and cache files
    Cleanup,
}

pub(super) fn run_storage(output: &Output, ctx: &Ctx, command: StorageCommand) -> i32 {
    match command {
        StorageCommand::Stats => match crate::database::get_storage_stats_in(&ctx.store) {
            Ok(stats) => {
                if output.json {
                    output.print_json(&stats)
                } else {
                    println!("  {}: {}", output.dim("total books"), stats.total_books);
                    println!(
                        "  {}: {} MB",
                        output.dim("binaries"),
                        stats.binaries_size / (1024 * 1024)
                    );
                    println!(
                        "  {}: {} MB",
                        output.dim("covers"),
                        stats.covers_size / (1024 * 1024)
                    );
                    println!(
                        "  {}: {} ({} MB)",
                        output.dim("blob entries"),
                        stats.blob_entries,
                        stats.blob_size / (1024 * 1024)
                    );
                    0
                }
            }
            Err(e) => output.error(&e),
        },
        StorageCommand::Cleanup => {
            // The library is `book_metadata`, as the app's store sees it.
            // `books` rows only exist for files on this device, so using
            // them deleted the covers of books synced from other devices.
            let existing_ids: Vec<String> = match ctx.store.with_connection(|conn| {
                let mut stmt = conn.prepare("SELECT book_id FROM book_metadata")?;
                let rows = stmt
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            }) {
                Ok(ids) => ids,
                // Never clean up against an empty list: that deletes everything.
                Err(e) => return output.error(&e),
            };
            match crate::database::cleanup_orphaned_storage_in(&ctx.store, existing_ids) {
                Ok(result) => {
                    if output.json {
                        output.print_json(&result)
                    } else {
                        println!(
                            "{} removed {} books, {} covers, {} metadata rows",
                            output.green("cleanup"),
                            result.removed_books,
                            result.removed_covers,
                            result.removed_metadata
                        );
                        0
                    }
                }
                Err(e) => output.error(&e),
            }
        }
    }
}

/// Minutes as "2 h 05 min" / "45 min".
fn format_minutes(minutes: f64) -> String {
    let total = if minutes.is_finite() && minutes > 0.0 {
        minutes.round() as u64
    } else {
        0
    };
    if total >= 60 {
        format!("{} h {:02} min", total / 60, total % 60)
    } else {
        format!("{total} min")
    }
}

fn plural(count: i64, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

pub(super) fn run_stats(output: &Output, ctx: &Ctx) -> i32 {
    let raw = match ctx.kv_get("zustand:theorem-settings") {
        Ok(raw) => raw,
        Err(e) => return output.error(&e),
    };
    let stats = match raw
        .as_deref()
        .map(serde_json::from_str::<serde_json::Value>)
    {
        None => None,
        Some(Ok(envelope)) => envelope.get("state").and_then(|s| s.get("stats")).cloned(),
        Some(Err(e)) => return output.error(&format!("Settings store is malformed: {e}")),
    };
    // Nothing read yet is not an error: the app starts from zero too.
    let stats = match stats {
        Some(stats) if stats.is_object() => stats,
        None | Some(serde_json::Value::Null) => serde_json::json!({}),
        Some(_) => return output.error("Settings store is malformed: \"stats\" is not an object"),
    };
    if output.json {
        return output.print_json(&stats);
    }
    let number = |key: &str| stats.get(key).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let count = |key: &str| number(key).max(0.0).round() as i64;
    // The app counts reading time and the daily goal in minutes.
    println!(
        "  {}: {}",
        output.dim("total reading time"),
        format_minutes(number("totalReadingTime"))
    );
    println!(
        "  {}: {}",
        output.dim("current streak"),
        plural(count("currentStreak"), "day", "days")
    );
    println!(
        "  {}: {}",
        output.dim("longest streak"),
        plural(count("longestStreak"), "day", "days")
    );
    println!(
        "  {}: {}",
        output.dim("books completed"),
        count("booksCompleted")
    );
    println!(
        "  {}: {} a day",
        output.dim("daily goal"),
        format_minutes(number("dailyGoal"))
    );
    0
}

pub(super) fn run_export_snapshot(output: &Output, ctx: &Ctx, out: Option<PathBuf>) -> i32 {
    let books = match load_books(ctx) {
        Ok(books) => books,
        Err(e) => return output.error(&e),
    };
    let annotations = match load_annotations(ctx, None) {
        Ok(annotations) => annotations,
        Err(e) => return output.error(&e),
    };
    let mut library =
        match read_kv_envelope(ctx, LIBRARY_KV_KEY, LIBRARY_STORE, empty_library_envelope) {
            Ok(envelope) => envelope,
            Err(e) => return output.error(&e),
        };
    let (collections, tombstones) =
        match envelope_state(&mut library, LIBRARY_STORE).and_then(|state| {
            Ok((
                state_list(state, "collections", LIBRARY_STORE)?.clone(),
                state_list(state, "deletionTombstones", LIBRARY_STORE)?.clone(),
            ))
        }) {
            Ok(lists) => lists,
            Err(e) => return output.error(&e),
        };

    let rss = ctx.store.with_connection(|conn| {
        Ok((
            crate::database::sqlite_get_rss_feeds_inner(conn)?,
            crate::database::sqlite_get_rss_articles_inner(conn, None, Some(u32::MAX), None)?,
        ))
    });
    let (feeds, articles) = match rss {
        Ok(rss) => rss,
        Err(e) => return output.error(&e),
    };

    let snapshot = serde_json::json!({
        "exportedAt": now_iso(),
        "version": env!("CARGO_PKG_VERSION"),
        "books": books,
        "collections": collections,
        "tombstones": tombstones,
        "annotations": annotations,
        "feeds": feeds,
        "rssArticles": articles,
    });

    let text = match serde_json::to_string_pretty(&snapshot) {
        Ok(text) => text,
        Err(e) => return output.error(&e.to_string()),
    };
    match out {
        Some(path) => {
            if let Some(parent) = path.parent() {
                if !parent.as_os_str().is_empty() {
                    let _ = std::fs::create_dir_all(parent);
                }
            }
            if let Err(e) = std::fs::write(&path, &text) {
                return output.error(&format!("Failed to write {}: {e}", path.display()));
            }
            if output.json {
                output.print_json(&serde_json::json!({
                    "path": path.display().to_string(),
                    "bytes": text.len(),
                }))
            } else {
                println!(
                    "{} {} ({} bytes)",
                    output.green("exported"),
                    output.bold(&path.display().to_string()),
                    text.len()
                );
                0
            }
        }
        None => {
            println!("{text}");
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_time_is_shown_in_hours_and_minutes() {
        // The app stores minutes.
        assert_eq!(format_minutes(0.0), "0 min");
        assert_eq!(format_minutes(45.4), "45 min");
        assert_eq!(format_minutes(60.0), "1 h 00 min");
        assert_eq!(format_minutes(725.0), "12 h 05 min");
        assert_eq!(format_minutes(-3.0), "0 min");
        assert_eq!(format_minutes(f64::NAN), "0 min");
        assert_eq!(plural(1, "day", "days"), "1 day");
        assert_eq!(plural(0, "day", "days"), "0 days");
    }
}
