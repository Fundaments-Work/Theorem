//! One-time reclaim of data older releases kept in SQLite or in old folders.

use super::*;

pub(crate) fn reclaim_legacy_stardict_blobs(
    connection: &Connection,
    app_data_dir: &Path,
) -> Result<usize, String> {
    let ifo_keys: Vec<String> = {
        let mut statement = connection
            .prepare("SELECT key FROM blob_store WHERE key LIKE 'theorem-stardict:%:ifo'")
            .map_err(|e| format!("Failed to prepare stardict query: {e}"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| format!("Failed to query stardict keys: {e}"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| format!("Failed to read stardict keys: {e}"))?
    };

    let mut reclaimed = 0;
    for ifo_key in ifo_keys {
        let parts: Vec<&str> = ifo_key.split(':').collect();
        if parts.len() != 3 {
            continue;
        }
        let dict_id = parts[1];
        let dict_dir = app_data_dir.join("dictionaries").join(dict_id);

        if !crate::stardict::is_valid_stardict_dir(&dict_dir) {
            let idx_key = format!("theorem-stardict:{dict_id}:idx");
            let dict_key = format!("theorem-stardict:{dict_id}:dict");
            let syn_key = format!("theorem-stardict:{dict_id}:syn");

            let ifo_blob: Option<Vec<u8>> = connection
                .query_row(
                    "SELECT data FROM blob_store WHERE key = ?1",
                    params![&ifo_key],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("Failed to read ifo blob: {e}"))?;
            let idx_blob: Option<Vec<u8>> = connection
                .query_row(
                    "SELECT data FROM blob_store WHERE key = ?1",
                    params![&idx_key],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("Failed to read idx blob: {e}"))?;
            let dict_blob: Option<Vec<u8>> = connection
                .query_row(
                    "SELECT data FROM blob_store WHERE key = ?1",
                    params![&dict_key],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("Failed to read dict blob: {e}"))?;
            let syn_blob: Option<Vec<u8>> = connection
                .query_row(
                    "SELECT data FROM blob_store WHERE key = ?1",
                    params![&syn_key],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("Failed to read syn blob: {e}"))?;

            let (Some(ifo), Some(idx), Some(dict)) = (ifo_blob, idx_blob, dict_blob) else {
                log::warn!("[database] StarDict dictionary {dict_id} has incomplete blobs, skipping reclaim");
                continue;
            };

            if let Err(e) = fs::create_dir_all(&dict_dir) {
                log::warn!("[database] Failed to create dictionary dir for {dict_id}: {e}");
                continue;
            }

            // Lookups may run meanwhile: each file appears whole (written
            // aside, then renamed), and `dict.ifo` last, so the directory
            // only counts as a dictionary once every part is in place.
            if let Some(syn) = syn_blob {
                let _ = replace_file_atomically(&dict_dir.join("dict.syn"), &syn);
            }
            if let Err(e) = replace_file_atomically(&dict_dir.join("dict.dict.dz"), &dict) {
                log::warn!("[database] Failed to write dict.dict.dz for {dict_id}: {e}");
                continue;
            }
            if let Err(e) = replace_file_atomically(&dict_dir.join("dict.idx"), &idx) {
                log::warn!("[database] Failed to write dict.idx for {dict_id}: {e}");
                continue;
            }
            if let Err(e) = replace_file_atomically(&dict_dir.join("dict.ifo"), &ifo) {
                log::warn!("[database] Failed to write dict.ifo for {dict_id}: {e}");
                continue;
            }
        }

        if crate::stardict::is_valid_stardict_dir(&dict_dir) {
            let deleted = connection
                .execute(
                    "DELETE FROM blob_store WHERE key LIKE ?1",
                    params![format!("theorem-stardict:{dict_id}:%")],
                )
                .map_err(|e| format!("Failed to delete blobs for {dict_id}: {e}"))?;
            reclaimed += deleted;
        }
    }

    Ok(reclaimed)
}

pub(crate) fn reclaim_legacy_book_blobs(
    connection: &Connection,
    app_data_dir: &Path,
) -> Result<usize, String> {
    // Collect only ids first so the BLOBs are read one at a time below; reading
    // every legacy book into memory at once could OOM large libraries.
    let legacy_ids: Vec<String> = {
        let mut statement = connection
            .prepare("SELECT id FROM books WHERE length(data) > 0")
            .map_err(|e| format!("Failed to prepare legacy blob query: {e}"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| format!("Failed to query legacy book blobs: {e}"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| format!("Failed to read legacy book ids: {e}"))?
    };

    let mut reclaimed = 0;
    for id in legacy_ids {
        let blob_data: Vec<u8> = connection
            .query_row("SELECT data FROM books WHERE id = ?1", params![id], |row| {
                row.get(0)
            })
            .map_err(|e| format!("Failed to read legacy blob for {id}: {e}"))?;
        if blob_data.is_empty() {
            continue;
        }
        let cache_path = materialized_book_path_in_dir(app_data_dir, &id);
        if !cache_path.exists() {
            let cache_dir = cache_path.parent().unwrap_or(app_data_dir);
            if let Err(e) = fs::create_dir_all(cache_dir) {
                log::warn!("[database] Failed to create cache dir for {id}: {e}");
                continue;
            }
            // Never replaces a file the app wrote meanwhile (re-import,
            // opening the book), and a reader never sees a half-written one.
            if let Err(e) = create_file_if_absent(&cache_path, &blob_data) {
                log::warn!("[database] Failed to re-materialize cache file for {id}: {e}");
                continue;
            }
        }
        connection
            .execute(
                "UPDATE books SET data = X'' WHERE id = ?1 AND length(data) > 0",
                params![id],
            )
            .map_err(|e| format!("Failed to zero legacy blob for {id}: {e}"))?;
        reclaimed += 1;
    }

    Ok(reclaimed)
}

pub(crate) fn cleanup_legacy_directories(app_data_dir: &Path) {
    if let Some(parent) = app_data_dir.parent() {
        let legacy_lion_dir = parent.join("com.lionreader.app");
        if legacy_lion_dir.exists() {
            let _ = std::fs::remove_dir_all(&legacy_lion_dir);
            log::info!(
                "[database] Cleaned up legacy directory {:?}",
                legacy_lion_dir
            );
        }
    }

    let legacy_books_dir = app_data_dir.join("books");
    if legacy_books_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&legacy_books_dir) {
            if entries.count() == 0 {
                let _ = std::fs::remove_dir(&legacy_books_dir);
                log::info!("[database] Cleaned up empty legacy books directory");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_support::*;

    fn temp_test_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "theorem-test-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn test_reclaim_legacy_book_blobs_materializes_missing_file() {
        let conn = setup_db();
        conn.execute(
            "INSERT INTO books (id, data) VALUES ('book1', X'deadbeef')",
            [],
        )
        .unwrap();

        let dir = temp_test_dir("reclaim");
        let reclaimed = reclaim_legacy_book_blobs(&conn, &dir).unwrap();
        assert_eq!(reclaimed, 1);

        assert_eq!(book_data_len(&conn, "book1"), 0);
        let cache_path = materialized_book_path_in_dir(&dir, "book1");
        assert_eq!(
            std::fs::read(&cache_path).unwrap(),
            vec![0xde, 0xad, 0xbe, 0xef]
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_reclaim_legacy_book_blobs_keeps_existing_file() {
        let conn = setup_db();
        conn.execute(
            "INSERT INTO books (id, data) VALUES ('book1', X'deadbeef')",
            [],
        )
        .unwrap();

        let dir = temp_test_dir("reclaim-existing");
        let cache_path = materialized_book_path_in_dir(&dir, "book1");
        std::fs::create_dir_all(cache_path.parent().unwrap()).unwrap();
        std::fs::write(&cache_path, b"already-materialized").unwrap();

        let reclaimed = reclaim_legacy_book_blobs(&conn, &dir).unwrap();
        assert_eq!(reclaimed, 1);

        assert_eq!(book_data_len(&conn, "book1"), 0);
        assert_eq!(std::fs::read(&cache_path).unwrap(), b"already-materialized");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_reclaim_legacy_book_blobs_noop_when_empty() {
        let conn = setup_db();
        conn.execute("INSERT INTO books (id, data) VALUES ('book1', X'')", [])
            .unwrap();

        let dir = temp_test_dir("reclaim-noop");
        let reclaimed = reclaim_legacy_book_blobs(&conn, &dir).unwrap();
        assert_eq!(reclaimed, 0);
        assert_eq!(book_data_len(&conn, "book1"), 0);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
