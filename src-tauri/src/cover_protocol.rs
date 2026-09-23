//! `theorem-cover://` — serves book covers straight from SQLite.
//!
//! Covers used to be loaded into the webview as base64 `data:` URLs, one IPC
//! call per book at startup, and kept in the JS heap for every book in the
//! library (tens of MB for large libraries). With this scheme `coverPath` is a
//! short URL; the webview fetches and decodes only the covers it actually
//! shows, and can drop them again.
//!
//! URL shape (built by `coverDisplayUrl` in `src/core/lib/storage.ts`):
//! `theorem-cover://localhost/<book id>?v=<updated_at>` (Linux/macOS) or
//! `http://theorem-cover.localhost/<book id>?v=<updated_at>` (Windows/Android).
//! The version query makes each URL immutable, so it is cached for a year.

use crate::database::{sqlite_get_cover_bytes_inner, with_connection};
use base64::Engine;
use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::AppHandle;

pub const COVER_SCHEME: &str = "theorem-cover";

/// Split a `data:` URL into its MIME type and decoded bytes.
pub fn parse_data_url(data_url: &str) -> Option<(String, Vec<u8>)> {
    let rest = data_url.strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(',')?;
    let mut parts = meta.split(';');
    let mime = parts
        .next()
        .filter(|m| !m.is_empty())
        .unwrap_or("text/plain");
    let is_base64 = parts.any(|p| p.eq_ignore_ascii_case("base64"));
    let bytes = if is_base64 {
        base64::engine::general_purpose::STANDARD
            .decode(payload.trim())
            .ok()?
    } else {
        percent_decode_str(payload).collect::<Vec<u8>>()
    };
    Some((mime.to_ascii_lowercase(), bytes))
}

fn book_id_from_path(path: &str) -> Option<String> {
    let raw = path.trim_start_matches('/');
    let decoded = percent_decode_str(raw).decode_utf8().ok()?;
    let id = decoded.trim();
    (!id.is_empty() && !id.contains('/')).then(|| id.to_string())
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// Build the HTTP response for a cover request.
pub fn respond(app: &AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Some(book_id) = book_id_from_path(request.uri().path()) else {
        return empty(StatusCode::BAD_REQUEST);
    };
    // Raw bytes straight from SQLite (covers are no longer base64 data URLs).
    let (mime, bytes) =
        match with_connection(app, |conn| sqlite_get_cover_bytes_inner(conn, &book_id)) {
            Ok(Some(cover)) => cover,
            Ok(None) => return empty(StatusCode::NOT_FOUND),
            Err(_) => return empty(StatusCode::INTERNAL_SERVER_ERROR),
        };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(bytes)
        .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR))
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoverVersion {
    pub book_id: String,
    pub updated_at: i64,
    /// Generated SVG fallback cover (not extracted from the book).
    pub is_svg: bool,
    /// Length of the stored data URL; tiny ones (placeholder icons) stay inline.
    pub data_url_len: i64,
}

pub fn list_cover_versions_inner(
    conn: &rusqlite::Connection,
) -> rusqlite::Result<Vec<CoverVersion>> {
    let mut stmt = conn
        // Length of the equivalent data URL (base64 of the bytes), so the
        // inline threshold for tiny placeholder covers is unchanged.
        .prepare(
            "SELECT book_id, updated_at,
                    COALESCE(mime LIKE 'image/svg+xml%', data_url LIKE 'data:image/svg+xml%'),
                    CASE WHEN data IS NOT NULL
                         THEN length('data:' || COALESCE(mime, '') || ';base64,') + ((length(data) + 2) / 3) * 4
                         ELSE length(data_url) END
             FROM covers",
        )?;
    let rows = stmt.query_map([], |row| {
        Ok(CoverVersion {
            book_id: row.get(0)?,
            updated_at: row.get(1)?,
            is_svg: row.get::<_, i64>(2)? != 0,
            data_url_len: row.get(3)?,
        })
    })?;
    rows.collect()
}

/// Which books have a stored cover, and its version — one call at startup
/// instead of fetching every cover's bytes.
pub fn sqlite_list_cover_versions(app: AppHandle) -> Result<Vec<CoverVersion>, String> {
    with_connection(&app, list_cover_versions_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_base64_data_urls() {
        let (mime, bytes) = parse_data_url("data:image/webp;base64,UklGRg==").unwrap();
        assert_eq!(mime, "image/webp");
        assert_eq!(bytes, b"RIFF");
    }

    #[test]
    fn parses_percent_encoded_svg() {
        let (mime, bytes) =
            parse_data_url("data:image/svg+xml;charset=utf-8,%3Csvg%20x%3D%221%22%2F%3E").unwrap();
        assert_eq!(mime, "image/svg+xml");
        assert_eq!(bytes, br#"<svg x="1"/>"#);
    }

    #[test]
    fn rejects_non_data_urls_and_bad_base64() {
        assert!(parse_data_url("https://example.org/x.png").is_none());
        assert!(parse_data_url("data:image/png;base64").is_none());
        assert!(parse_data_url("data:image/png;base64,***").is_none());
    }

    #[test]
    fn extracts_book_ids_from_paths() {
        assert_eq!(book_id_from_path("/abc-123").as_deref(), Some("abc-123"));
        assert_eq!(book_id_from_path("/a%20b").as_deref(), Some("a b"));
        assert_eq!(book_id_from_path("/"), None);
        assert_eq!(book_id_from_path("/a/b"), None);
    }

    #[test]
    fn lists_versions_and_flags_svg_fallbacks() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE covers (book_id TEXT PRIMARY KEY, data_url TEXT, data BLOB, mime TEXT, updated_at INTEGER);
             INSERT INTO covers VALUES ('b1', 'data:image/webp;base64,AAAA', NULL, NULL, 100);
             INSERT INTO covers VALUES ('b2', 'data:image/svg+xml;utf8,<svg/>', NULL, NULL, 200);",
        )
        .unwrap();
        let mut versions = list_cover_versions_inner(&conn).unwrap();
        versions.sort_by(|a, b| a.book_id.cmp(&b.book_id));
        assert_eq!(
            versions,
            vec![
                CoverVersion {
                    book_id: "b1".into(),
                    updated_at: 100,
                    is_svg: false,
                    data_url_len: 27,
                },
                CoverVersion {
                    book_id: "b2".into(),
                    updated_at: 200,
                    is_svg: true,
                    data_url_len: 30,
                },
            ]
        );
    }

    #[test]
    fn byte_covers_report_the_same_data_url_length() {
        use crate::database::{
            migrate_cover_data_urls, sqlite_get_cover_image_inner, sqlite_save_cover_image_inner,
        };
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE covers (book_id TEXT PRIMARY KEY, data_url TEXT NOT NULL, data BLOB, mime TEXT, updated_at INTEGER);
             INSERT INTO covers VALUES ('legacy', 'data:image/webp;base64,UklGRg==', NULL, NULL, 7);",
        )
        .unwrap();
        let before = list_cover_versions_inner(&conn).unwrap()[0].data_url_len;
        migrate_cover_data_urls(&conn).unwrap();
        sqlite_save_cover_image_inner(&conn, "new", "data:image/jpeg;base64,/9j/4AAQSkZJRg==")
            .unwrap();
        for v in list_cover_versions_inner(&conn).unwrap() {
            let url = sqlite_get_cover_image_inner(&conn, &v.book_id)
                .unwrap()
                .unwrap();
            assert_eq!(v.data_url_len as usize, url.len(), "{}", v.book_id);
            if v.book_id == "legacy" {
                assert_eq!(v.data_url_len, before);
                assert_eq!(v.updated_at, 7);
            }
        }
    }
}
