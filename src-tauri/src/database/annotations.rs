//! Highlights and notes.

use super::*;

pub fn sqlite_save_book_annotations_inner(
    connection: &Connection,
    book_id: &str,
    annotations_json: &[String],
) -> rusqlite::Result<()> {
    // Replace the book's annotations atomically: a failing insert must not
    // leave the book with its old highlights deleted and the new ones missing.
    let tx = connection.unchecked_transaction()?;
    // An empty save clears a removed book's highlights: no row for it then.
    if !annotations_json.is_empty() {
        ensure_book_row(&tx, book_id)?;
    }
    tx.execute(
        "DELETE FROM book_annotations WHERE book_id = ?1",
        params![book_id],
    )?;
    for (i, ann_json) in annotations_json.iter().enumerate() {
        let id: String = serde_json::from_str::<serde_json::Value>(ann_json)
            .ok()
            .and_then(|v| {
                v.get("id")
                    .and_then(|id_val| id_val.as_str())
                    .map(String::from)
            })
            .unwrap_or_else(|| format!("auto:{}:{}", book_id, i));
        // Ids are unique across books. A repeated id (in this list, or one
        // still stored under another book) is an update: the last one wins.
        tx.execute(
            "INSERT INTO book_annotations(id, book_id, annotation_json, updated_at) VALUES(?1, ?2, ?3, unixepoch())
             ON CONFLICT(id) DO UPDATE SET
                book_id = excluded.book_id,
                annotation_json = excluded.annotation_json,
                updated_at = excluded.updated_at",
            params![id, book_id, ann_json],
        )?;
    }
    tx.commit()
}

pub fn sqlite_save_book_annotations(
    app: AppHandle,
    book_id: String,
    annotations_json: Vec<String>,
) -> Result<(), AppError> {
    with_connection(&app, |connection| {
        sqlite_save_book_annotations_inner(connection, &book_id, &annotations_json)
    })
}

pub fn sqlite_get_book_annotations_inner(
    connection: &Connection,
    book_id: &str,
) -> rusqlite::Result<Vec<String>> {
    let mut stmt = connection.prepare(
        "SELECT annotation_json FROM book_annotations WHERE book_id = ?1 ORDER BY updated_at",
    )?;
    let rows = stmt.query_map(params![book_id], |row| row.get::<_, String>(0))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

pub fn sqlite_get_book_annotations(
    app: AppHandle,
    book_id: String,
) -> Result<Vec<String>, AppError> {
    with_connection(&app, |connection| {
        sqlite_get_book_annotations_inner(connection, &book_id)
    })
}

#[cfg(test)]
pub fn sqlite_get_all_annotations_inner(connection: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt =
        connection.prepare("SELECT annotation_json FROM book_annotations ORDER BY updated_at")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

/// Every stored annotation in one IPC payload. `annotations` is a JSON array
/// built from the stored rows without re-encoding them, so the webview parses
/// it once with the rest of the response instead of `JSON.parse` per row.
/// Rows that are not a JSON object with a non-empty string `id` are left out
/// and their row ids listed in `corrupt_ids` (never their content).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationsLoad {
    pub annotations: Box<serde_json::value::RawValue>,
    pub corrupt_ids: Vec<String>,
}

/// Only what validation needs: syntax is checked in full while the rest of the
/// object is skipped, without building a `Value` tree per row.
#[derive(Deserialize)]
struct AnnotationIdProbe<'a> {
    #[serde(borrow)]
    id: Option<std::borrow::Cow<'a, str>>,
}

fn is_valid_annotation_json(json: &str) -> bool {
    matches!(
        serde_json::from_str::<AnnotationIdProbe<'_>>(json),
        Ok(AnnotationIdProbe { id: Some(id) }) if !id.is_empty()
    )
}

pub fn sqlite_load_all_annotations_inner(
    connection: &Connection,
) -> rusqlite::Result<AnnotationsLoad> {
    let mut stmt = connection
        .prepare("SELECT id, annotation_json FROM book_annotations ORDER BY updated_at")?;
    let mut rows = stmt.query([])?;
    let mut array = String::from("[");
    let mut corrupt_ids = Vec::new();
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        // A NULL or non-text value is corrupt too, not a reason to fail the load.
        let json = match row.get_ref(1)? {
            rusqlite::types::ValueRef::Text(bytes) => std::str::from_utf8(bytes).ok(),
            _ => None,
        };
        match json {
            Some(json) if is_valid_annotation_json(json) => {
                if array.len() > 1 {
                    array.push(',');
                }
                array.push_str(json.trim());
            }
            _ => corrupt_ids.push(id),
        }
    }
    array.push(']');
    if !corrupt_ids.is_empty() {
        log::warn!(
            "[database] skipped {} unreadable annotation row(s): {}",
            corrupt_ids.len(),
            corrupt_ids.join(", ")
        );
    }
    let annotations = serde_json::value::RawValue::from_string(array)
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    Ok(AnnotationsLoad {
        annotations,
        corrupt_ids,
    })
}

pub fn sqlite_load_all_annotations(app: AppHandle) -> Result<AnnotationsLoad, AppError> {
    with_connection(&app, sqlite_load_all_annotations_inner)
}

pub fn sqlite_upsert_annotation_inner(
    connection: &Connection,
    id: &str,
    book_id: &str,
    annotation_json: &str,
) -> rusqlite::Result<()> {
    ensure_book_row(connection, book_id)?;
    connection.execute(
        "INSERT INTO book_annotations(id, book_id, annotation_json, updated_at) VALUES(?1, ?2, ?3, unixepoch()) \
         ON CONFLICT(id) DO UPDATE SET annotation_json = excluded.annotation_json, updated_at = unixepoch()",
        params![id, book_id, annotation_json],
    )?;
    Ok(())
}

pub fn sqlite_upsert_annotation(
    app: AppHandle,
    id: String,
    book_id: String,
    annotation_json: String,
) -> Result<(), AppError> {
    with_connection(&app, |connection| {
        sqlite_upsert_annotation_inner(connection, &id, &book_id, &annotation_json)
    })
}

pub fn sqlite_delete_annotation_inner(connection: &Connection, id: &str) -> rusqlite::Result<()> {
    connection.execute("DELETE FROM book_annotations WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn sqlite_delete_annotation(app: AppHandle, id: String) -> Result<(), AppError> {
    with_connection(&app, |connection| {
        sqlite_delete_annotation_inner(connection, &id)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_support::*;

    #[test]
    fn test_book_annotations_roundtrip() {
        let conn = setup_db();
        let anns = vec![
            r#"{"id":"ann1","type":"highlight","text":"hello"}"#.to_string(),
            r#"{"id":"ann2","type":"note","text":"world"}"#.to_string(),
        ];
        sqlite_save_book_annotations_inner(&conn, "book1", &anns).unwrap();
        let result = sqlite_get_book_annotations_inner(&conn, "book1").unwrap();
        assert_eq!(result.len(), 2);
        assert!(result[0].contains("ann1") || result[1].contains("ann1"));
    }

    #[test]
    fn test_book_annotations_replace() {
        let conn = setup_db();
        let anns1 = vec![r#"{"id":"ann1","text":"first"}"#.to_string()];
        let anns2 = vec![r#"{"id":"ann2","text":"second"}"#.to_string()];
        sqlite_save_book_annotations_inner(&conn, "book1", &anns1).unwrap();
        sqlite_save_book_annotations_inner(&conn, "book1", &anns2).unwrap();
        let result = sqlite_get_book_annotations_inner(&conn, "book1").unwrap();
        assert_eq!(result.len(), 1);
        assert!(result[0].contains("ann2"));
    }

    fn annotation_texts(conn: &Connection, book_id: &str) -> Vec<String> {
        let mut texts: Vec<String> = sqlite_get_book_annotations_inner(conn, book_id)
            .unwrap()
            .iter()
            .map(|json| {
                serde_json::from_str::<serde_json::Value>(json).unwrap()["text"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        texts.sort();
        texts
    }

    /// A duplicate id in the list made the second INSERT fail after the
    /// DELETE had already run, leaving the book with no highlights at all.
    #[test]
    fn save_book_annotations_with_duplicate_ids_keeps_the_last() {
        let conn = setup_db();
        sqlite_save_book_annotations_inner(
            &conn,
            "book1",
            &[r#"{"id":"keep","text":"existing"}"#.to_string()],
        )
        .unwrap();
        let anns = vec![
            r#"{"id":"dup","text":"first"}"#.to_string(),
            r#"{"id":"other","text":"other"}"#.to_string(),
            r#"{"id":"dup","text":"second"}"#.to_string(),
        ];
        sqlite_save_book_annotations_inner(&conn, "book1", &anns).unwrap();
        assert_eq!(annotation_texts(&conn, "book1"), ["other", "second"]);
    }

    /// An id already stored under another book is taken over by this save
    /// instead of failing it.
    #[test]
    fn save_book_annotations_takes_over_an_id_from_another_book() {
        let conn = setup_db();
        sqlite_upsert_annotation_inner(&conn, "x", "book2", r#"{"id":"x","text":"old"}"#).unwrap();
        sqlite_save_book_annotations_inner(
            &conn,
            "book1",
            &[r#"{"id":"x","text":"moved"}"#.to_string()],
        )
        .unwrap();
        assert_eq!(annotation_texts(&conn, "book1"), ["moved"]);
        assert!(annotation_texts(&conn, "book2").is_empty());
    }

    /// Any failing insert rolls the whole save back: the previous highlights stay.
    #[test]
    fn save_book_annotations_failure_keeps_previous_highlights() {
        let conn = setup_db();
        sqlite_save_book_annotations_inner(
            &conn,
            "book1",
            &[
                r#"{"id":"a","text":"one"}"#.to_string(),
                r#"{"id":"b","text":"two"}"#.to_string(),
            ],
        )
        .unwrap();
        conn.execute_batch(
            "CREATE TRIGGER fail_insert BEFORE INSERT ON book_annotations
             WHEN NEW.annotation_json LIKE '%boom%'
             BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        )
        .unwrap();
        let result = sqlite_save_book_annotations_inner(
            &conn,
            "book1",
            &[
                r#"{"id":"c","text":"three"}"#.to_string(),
                r#"{"id":"d","text":"boom"}"#.to_string(),
            ],
        );
        assert!(result.is_err());
        assert_eq!(annotation_texts(&conn, "book1"), ["one", "two"]);
    }

    #[test]
    fn test_book_annotations_upsert_delete_get_all() {
        let conn = setup_db();
        sqlite_upsert_annotation_inner(&conn, "a1", "b1", r#"{"id":"a1","text":"one"}"#).unwrap();
        sqlite_upsert_annotation_inner(&conn, "a2", "b2", r#"{"id":"a2","text":"two"}"#).unwrap();

        let all = sqlite_get_all_annotations_inner(&conn).unwrap();
        assert_eq!(all.len(), 2);

        // Upsert update
        sqlite_upsert_annotation_inner(&conn, "a1", "b1", r#"{"id":"a1","text":"updated"}"#)
            .unwrap();
        let b1_anns = sqlite_get_book_annotations_inner(&conn, "b1").unwrap();
        assert_eq!(b1_anns.len(), 1);
        assert!(b1_anns[0].contains("updated"));

        // Delete
        sqlite_delete_annotation_inner(&conn, "a1").unwrap();
        let remaining = sqlite_get_all_annotations_inner(&conn).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0], r#"{"id":"a2","text":"two"}"#);
    }

    #[test]
    fn load_all_annotations_returns_one_array_and_reports_corrupt_rows() {
        let conn = setup_db();
        sqlite_upsert_annotation_inner(&conn, "a1", "b1", r#"{"id":"a1","text":"one \"q\""}"#)
            .unwrap();
        sqlite_upsert_annotation_inner(&conn, "bad", "b1", r#"{"id":"bad","text":"secret"#)
            .unwrap();
        sqlite_upsert_annotation_inner(&conn, "noid", "b1", r#"{"text":"x"}"#).unwrap();
        sqlite_upsert_annotation_inner(&conn, "emptyid", "b1", r#"{"id":""}"#).unwrap();
        sqlite_upsert_annotation_inner(&conn, "arr", "b1", r#"[1,2]"#).unwrap();
        sqlite_upsert_annotation_inner(&conn, "a2", "b2", " {\"id\":\"a2\",\"n\":[1,{}]}\n")
            .unwrap();
        conn.execute(
            "INSERT INTO book_annotations (id, book_id, annotation_json) VALUES ('blob', 'b1', x'00ff')",
            [],
        )
        .unwrap();

        let load = sqlite_load_all_annotations_inner(&conn).unwrap();
        let parsed: Vec<serde_json::Value> = serde_json::from_str(load.annotations.get()).unwrap();
        let ids: Vec<&str> = parsed.iter().map(|a| a["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["a1", "a2"]);
        assert_eq!(parsed[0]["text"], "one \"q\"");
        let mut corrupt = load.corrupt_ids.clone();
        corrupt.sort();
        assert_eq!(corrupt, ["arr", "bad", "blob", "emptyid", "noid"]);

        // The IPC payload embeds the rows as JSON, not as strings, and never
        // carries a corrupt row's content.
        let wire = serde_json::to_string(&load).unwrap();
        assert!(wire.starts_with(r#"{"annotations":[{"id":"a1""#), "{wire}");
        assert!(wire.contains(r#""corruptIds":["#));
        assert!(!wire.contains("secret"));
    }

    #[test]
    fn load_all_annotations_handles_an_empty_table() {
        let conn = setup_db();
        let load = sqlite_load_all_annotations_inner(&conn).unwrap();
        assert_eq!(load.annotations.get(), "[]");
        assert!(load.corrupt_ids.is_empty());
    }

    /// `cargo test --lib annotations_50k -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn annotations_50k_load_timing() {
        let conn = setup_db();
        conn.execute_batch("BEGIN").unwrap();
        for i in 0..50_000 {
            let json = format!(
                r#"{{"id":"ann-{i}","bookId":"b{}","type":"highlight","cfi":"epubcfi(/6/4!/4/2/{i})","text":"{}","color":"yellow","createdAt":"2026-01-01T00:00:00Z"}}"#,
                i % 200,
                "lorem ipsum dolor sit amet ".repeat(8)
            );
            sqlite_upsert_annotation_inner(&conn, &format!("ann-{i}"), "b1", &json).unwrap();
        }
        conn.execute_batch("COMMIT").unwrap();
        let start = std::time::Instant::now();
        let old = sqlite_get_all_annotations_inner(&conn).unwrap();
        let old_wire = serde_json::to_string(&old).unwrap();
        let old_ms = start.elapsed().as_secs_f64() * 1000.0;
        let start = std::time::Instant::now();
        let new = sqlite_load_all_annotations_inner(&conn).unwrap();
        let new_wire = serde_json::to_string(&new).unwrap();
        let new_ms = start.elapsed().as_secs_f64() * 1000.0;
        // Set THEOREM_ANN_BENCH_DIR to keep both payloads for timing the
        // webview side (one JSON.parse per row before, one per payload now).
        if let Some(dir) = std::env::var_os("THEOREM_ANN_BENCH_DIR") {
            let dir = std::path::PathBuf::from(dir);
            std::fs::write(dir.join("theorem-ann-old.json"), &old_wire).unwrap();
            std::fs::write(dir.join("theorem-ann-new.json"), &new_wire).unwrap();
        }
        println!(
            "50k annotations: old Vec<String> {old_ms:.1} ms ({} bytes), new validated array {new_ms:.1} ms ({} bytes)",
            old_wire.len(),
            new_wire.len()
        );
    }
}
