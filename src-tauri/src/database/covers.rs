//! Book covers, stored as raw bytes plus MIME type.

use super::*;

/// Store a cover given as a data URL. Covers are kept as raw bytes + MIME
/// type (a third smaller than base64, served without decoding); the command
/// API and sync still speak data URLs. An unparsable URL is kept verbatim.
pub fn sqlite_save_cover_image_inner(
    connection: &Connection,
    book_id: &str,
    data_url: &str,
) -> rusqlite::Result<()> {
    let (stored_url, mime, bytes) = match crate::cover_protocol::parse_data_url(data_url) {
        Some((mime, bytes)) => ("", Some(mime), Some(bytes)),
        None => (data_url, None, None),
    };
    ensure_book_row(connection, book_id)?;
    connection.execute(
        r#"
        INSERT INTO covers (book_id, data_url, data, mime, updated_at)
        VALUES (?1, ?2, ?3, ?4, unixepoch())
        ON CONFLICT(book_id) DO UPDATE SET
            data_url = excluded.data_url,
            data = excluded.data,
            mime = excluded.mime,
            updated_at = unixepoch()
        "#,
        params![book_id, stored_url, bytes, mime],
    )?;
    Ok(())
}

/// Convert covers still stored as data URLs to bytes + MIME. Keeps
/// `updated_at` (cover cache versions). Returns the number converted.
///
/// Runs in the background while the app uses the database, so it works in
/// short transactions of a few covers (never holding the write lock long,
/// never loading every cover into memory) and only converts a row still
/// holding the URL it read.
pub(crate) fn migrate_cover_data_urls(connection: &Connection) -> rusqlite::Result<usize> {
    const CHUNK: i64 = 64;
    let mut converted = 0;
    let mut after_rowid = i64::MIN;
    loop {
        let pending: Vec<(i64, String, String)> = {
            let mut stmt = connection.prepare(
                "SELECT rowid, book_id, data_url FROM covers
                 WHERE data IS NULL AND data_url != '' AND rowid > ?1
                 ORDER BY rowid LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![after_rowid, CHUNK], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let Some((last_rowid, _, _)) = pending.last() else {
            return Ok(converted);
        };
        after_rowid = *last_rowid;
        let tx = connection.unchecked_transaction()?;
        for (_, book_id, data_url) in &pending {
            if convert_cover_data_url(&tx, book_id, data_url)? {
                converted += 1;
            }
        }
        tx.commit()?;
    }
}

/// Store one cover's data URL as bytes + MIME, unless the row changed since
/// `data_url` was read (a cover saved meanwhile) or the URL is unparsable.
pub(crate) fn convert_cover_data_url(
    connection: &Connection,
    book_id: &str,
    data_url: &str,
) -> rusqlite::Result<bool> {
    let Some((mime, bytes)) = crate::cover_protocol::parse_data_url(data_url) else {
        return Ok(false);
    };
    let changed = connection.execute(
        "UPDATE covers SET data = ?2, mime = ?3, data_url = ''
         WHERE book_id = ?1 AND data IS NULL AND data_url = ?4",
        params![book_id, bytes, mime, data_url],
    )?;
    Ok(changed > 0)
}

/// Cover bytes and MIME type, for the cover protocol (no base64 round trip).
pub fn sqlite_get_cover_bytes_inner(
    connection: &Connection,
    book_id: &str,
) -> rusqlite::Result<Option<(String, Vec<u8>)>> {
    let row = connection
        .query_row(
            "SELECT data_url, data, mime FROM covers WHERE book_id = ?1",
            params![book_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<Vec<u8>>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()?;
    Ok(match row {
        Some((_, Some(bytes), mime)) => Some((
            mime.unwrap_or_else(|| "application/octet-stream".to_string()),
            bytes,
        )),
        Some((data_url, None, _)) => crate::cover_protocol::parse_data_url(&data_url),
        None => None,
    })
}

pub fn sqlite_save_cover_image(
    app: AppHandle,
    book_id: String,
    data_url: String,
) -> Result<(), AppError> {
    with_connection(&app, |connection| {
        sqlite_save_cover_image_inner(connection, &book_id, &data_url)
    })
}

/// The cover as a data URL (command API and sync).
pub fn sqlite_get_cover_image_inner(
    connection: &Connection,
    book_id: &str,
) -> rusqlite::Result<Option<String>> {
    use base64::Engine;
    let row = connection
        .query_row(
            "SELECT data_url, data, mime FROM covers WHERE book_id = ?1",
            params![book_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<Vec<u8>>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()?;
    Ok(row.map(|(data_url, data, mime)| match data {
        Some(bytes) => format!(
            "data:{};base64,{}",
            mime.as_deref().unwrap_or("application/octet-stream"),
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ),
        None => data_url,
    }))
}

pub fn sqlite_get_cover_image(app: AppHandle, book_id: String) -> Result<Option<String>, AppError> {
    with_connection(&app, |connection| {
        sqlite_get_cover_image_inner(connection, &book_id)
    })
}

pub fn sqlite_delete_cover_image_inner(
    connection: &Connection,
    book_id: &str,
) -> rusqlite::Result<()> {
    connection.execute("DELETE FROM covers WHERE book_id = ?1", params![book_id])?;
    Ok(())
}

pub fn sqlite_delete_cover_image(app: AppHandle, book_id: String) -> Result<(), AppError> {
    with_connection(&app, |connection| {
        sqlite_delete_cover_image_inner(connection, &book_id)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_support::*;

    #[test]
    fn test_cover_image_roundtrip() {
        let conn = setup_db();
        sqlite_save_cover_image_inner(&conn, "book1", "data:image/png;base64,abc").unwrap();
        let result = sqlite_get_cover_image_inner(&conn, "book1").unwrap();
        assert_eq!(result, Some("data:image/png;base64,abc".to_string()));
    }

    #[test]
    fn test_cover_image_delete() {
        let conn = setup_db();
        sqlite_save_cover_image_inner(&conn, "book1", "data:image/png;base64,abc").unwrap();
        sqlite_delete_cover_image_inner(&conn, "book1").unwrap();
        let result = sqlite_get_cover_image_inner(&conn, "book1").unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn test_cover_stored_as_bytes_and_returned_as_data_url() {
        let conn = setup_db();
        sqlite_save_cover_image_inner(&conn, "book1", "data:image/png;base64,aGVsbG8=").unwrap();
        let (url, data, mime): (String, Option<Vec<u8>>, Option<String>) = conn
            .query_row(
                "SELECT data_url, data, mime FROM covers WHERE book_id = ?1",
                params!["book1"],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(url, "");
        assert_eq!(data.as_deref(), Some(&b"hello"[..]));
        assert_eq!(mime.as_deref(), Some("image/png"));
        assert_eq!(
            sqlite_get_cover_image_inner(&conn, "book1")
                .unwrap()
                .as_deref(),
            Some("data:image/png;base64,aGVsbG8=")
        );
        assert_eq!(
            sqlite_get_cover_bytes_inner(&conn, "book1").unwrap(),
            Some(("image/png".to_string(), b"hello".to_vec()))
        );

        // Unparsable input is kept verbatim, still readable both ways.
        sqlite_save_cover_image_inner(&conn, "odd", "not a data url").unwrap();
        assert_eq!(
            sqlite_get_cover_image_inner(&conn, "odd")
                .unwrap()
                .as_deref(),
            Some("not a data url")
        );
        assert_eq!(sqlite_get_cover_bytes_inner(&conn, "odd").unwrap(), None);
        assert_eq!(
            sqlite_get_cover_bytes_inner(&conn, "missing").unwrap(),
            None
        );
    }

    #[test]
    fn test_migrate_cover_data_urls_keeps_versions() {
        let conn = setup_db();
        // Covers always belong to a `books` row (foreign keys are on).
        for id in ["old", "svg", "bad"] {
            ensure_book_row(&conn, id).unwrap();
        }
        conn.execute_batch(
            "INSERT INTO covers (book_id, data_url, data, updated_at) VALUES
                ('old', 'data:image/webp;base64,UklGRg==', NULL, 42),
                ('svg', 'data:image/svg+xml;utf8,%3Csvg%2F%3E', NULL, 43),
                ('bad', 'garbage', NULL, 44);",
        )
        .unwrap();
        assert_eq!(migrate_cover_data_urls(&conn).unwrap(), 2);
        assert_eq!(migrate_cover_data_urls(&conn).unwrap(), 0); // idempotent
        assert_eq!(
            sqlite_get_cover_bytes_inner(&conn, "old").unwrap(),
            Some(("image/webp".to_string(), b"RIFF".to_vec()))
        );
        assert_eq!(
            sqlite_get_cover_bytes_inner(&conn, "svg").unwrap(),
            Some(("image/svg+xml".to_string(), b"<svg/>".to_vec()))
        );
        let versions: Vec<i64> = conn
            .prepare("SELECT updated_at FROM covers ORDER BY book_id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(versions, [44, 42, 43]); // bad, old, svg: untouched
        assert_eq!(
            sqlite_get_cover_image_inner(&conn, "bad")
                .unwrap()
                .as_deref(),
            Some("garbage")
        );
    }
}
