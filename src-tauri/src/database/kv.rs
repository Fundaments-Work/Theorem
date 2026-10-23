//! The key-value and blob stores, with prefix queries.

use super::*;

pub fn sqlite_get_kv_inner(connection: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    connection
        .query_row(
            "SELECT value FROM kv_store WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
}

pub fn sqlite_get_kv(app: AppHandle, key: String) -> Result<Option<String>, String> {
    with_connection(&app, |connection| sqlite_get_kv_inner(connection, &key))
}

pub fn sqlite_batch_get_kv_inner(
    connection: &Connection,
    keys: &[String],
) -> rusqlite::Result<Vec<(String, String)>> {
    if keys.is_empty() {
        return Ok(Vec::new());
    }

    let placeholders: Vec<String> = keys
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect();
    let sql = format!(
        "SELECT key, value FROM kv_store WHERE key IN ({})",
        placeholders.join(", ")
    );

    let mut stmt = connection.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(keys.iter()), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;

    rows.collect::<rusqlite::Result<Vec<(String, String)>>>()
}

pub fn sqlite_batch_get_kv(
    app: AppHandle,
    keys: Vec<String>,
) -> Result<Vec<(String, String)>, String> {
    with_connection(&app, |connection| {
        sqlite_batch_get_kv_inner(connection, &keys)
    })
}

pub fn sqlite_set_kv_inner(
    connection: &Connection,
    key: &str,
    value: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        r#"
        INSERT INTO kv_store (key, value, updated_at)
        VALUES (?1, ?2, unixepoch())
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = unixepoch()
        "#,
        params![key, value],
    )?;
    Ok(())
}

pub fn sqlite_set_kv(app: AppHandle, key: String, value: String) -> Result<(), String> {
    with_connection(&app, |connection| {
        sqlite_set_kv_inner(connection, &key, &value)
    })
}

pub fn sqlite_delete_kv_inner(connection: &Connection, key: &str) -> rusqlite::Result<()> {
    connection.execute("DELETE FROM kv_store WHERE key = ?1", params![key])?;
    Ok(())
}

pub fn sqlite_delete_kv(app: AppHandle, key: String) -> Result<(), String> {
    with_connection(&app, |connection| sqlite_delete_kv_inner(connection, &key))
}

// Key-prefix queries are a range on the primary key (`key >= ?1 AND key <
// ?2`), which SQLite answers from the index. `LIKE ?1 || '%'` scanned every
// row (LIKE is case-insensitive, so it cannot use the index), and it read `%`
// and `_` in the prefix as wildcards. Each statement has a twin without the
// upper bound for a prefix that has none (see `prefix_upper_bound`).
const KV_COUNT_BY_PREFIX_SQL: &str = "SELECT COUNT(*) FROM kv_store WHERE key >= ?1 AND key < ?2";
const KV_COUNT_FROM_SQL: &str = "SELECT COUNT(*) FROM kv_store WHERE key >= ?1";
const KV_DELETE_BY_PREFIX_SQL: &str = "DELETE FROM kv_store WHERE key >= ?1 AND key < ?2";
const KV_DELETE_FROM_SQL: &str = "DELETE FROM kv_store WHERE key >= ?1";
const BLOB_DELETE_BY_PREFIX_SQL: &str = "DELETE FROM blob_store WHERE key >= ?1 AND key < ?2";
const BLOB_DELETE_FROM_SQL: &str = "DELETE FROM blob_store WHERE key >= ?1";
const BLOB_STATS_BY_PREFIX_SQL: &str =
    "SELECT COUNT(*), COALESCE(SUM(length(data)), 0) FROM blob_store WHERE key >= ?1 AND key < ?2";
const BLOB_STATS_FROM_SQL: &str =
    "SELECT COUNT(*), COALESCE(SUM(length(data)), 0) FROM blob_store WHERE key >= ?1";

/// The smallest string greater than every string that starts with `prefix`,
/// or `None` when there is none (an empty prefix, or one made only of
/// U+10FFFF): the exclusive upper bound of a prefix range scan.
///
/// SQLite compares TEXT keys bytewise (BINARY collation) and UTF-8 byte order
/// is code point order, so the bound is the prefix with its last character
/// replaced by the next code point (skipping the surrogate gap). A last
/// character with no successor is dropped and the one before it advanced.
fn prefix_upper_bound(prefix: &str) -> Option<String> {
    let mut chars: Vec<char> = prefix.chars().collect();
    while let Some(last) = chars.pop() {
        let next = match last {
            '\u{D7FF}' => Some('\u{E000}'),
            c => char::from_u32(c as u32 + 1),
        };
        if let Some(next) = next {
            chars.push(next);
            return Some(chars.into_iter().collect());
        }
    }
    None
}

/// Runs `bounded` with `(prefix, upper bound)`, or `open_ended` with
/// `(prefix)` when the prefix has no upper bound.
fn with_prefix_range<T>(
    prefix: &str,
    bounded: impl FnOnce(&str, &str) -> rusqlite::Result<T>,
    open_ended: impl FnOnce(&str) -> rusqlite::Result<T>,
) -> rusqlite::Result<T> {
    match prefix_upper_bound(prefix) {
        Some(upper) => bounded(prefix, &upper),
        None => open_ended(prefix),
    }
}

pub fn sqlite_count_kv_by_prefix_inner(
    connection: &Connection,
    prefix: &str,
) -> rusqlite::Result<u64> {
    with_prefix_range(
        prefix,
        |from, to| connection.query_row(KV_COUNT_BY_PREFIX_SQL, params![from, to], |r| r.get(0)),
        |from| connection.query_row(KV_COUNT_FROM_SQL, params![from], |r| r.get(0)),
    )
}

pub fn sqlite_count_kv_by_prefix(app: AppHandle, prefix: String) -> Result<u64, String> {
    with_connection(&app, |connection| {
        sqlite_count_kv_by_prefix_inner(connection, &prefix)
    })
}

pub fn sqlite_delete_kv_by_prefix_inner(
    connection: &Connection,
    prefix: &str,
) -> rusqlite::Result<u64> {
    let affected = with_prefix_range(
        prefix,
        |from, to| connection.execute(KV_DELETE_BY_PREFIX_SQL, params![from, to]),
        |from| connection.execute(KV_DELETE_FROM_SQL, params![from]),
    )?;
    Ok(affected as u64)
}

pub fn sqlite_delete_kv_by_prefix(app: AppHandle, prefix: String) -> Result<u64, String> {
    with_connection(&app, |connection| {
        sqlite_delete_kv_by_prefix_inner(connection, &prefix)
    })
}

pub fn sqlite_set_blob_inner(
    connection: &Connection,
    key: &str,
    data: &[u8],
) -> rusqlite::Result<()> {
    connection.execute(
        r#"
        INSERT INTO blob_store (key, data, updated_at)
        VALUES (?1, ?2, unixepoch())
        ON CONFLICT(key) DO UPDATE SET
            data = excluded.data,
            updated_at = unixepoch()
        "#,
        params![key, data],
    )?;
    Ok(())
}

pub fn sqlite_set_blob(app: AppHandle, key: String, data: Vec<u8>) -> Result<(), String> {
    with_connection(&app, |connection| {
        sqlite_set_blob_inner(connection, &key, &data)
    })
}

pub fn sqlite_get_blob_inner(
    connection: &Connection,
    key: &str,
) -> rusqlite::Result<Option<Vec<u8>>> {
    connection
        .query_row(
            "SELECT data FROM blob_store WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
}

pub fn sqlite_get_blob(app: AppHandle, key: String) -> Result<Option<Vec<u8>>, String> {
    with_connection(&app, |connection| sqlite_get_blob_inner(connection, &key))
}

pub fn sqlite_delete_blob_inner(connection: &Connection, key: &str) -> rusqlite::Result<()> {
    connection.execute("DELETE FROM blob_store WHERE key = ?1", params![key])?;
    Ok(())
}

pub fn sqlite_delete_blob(app: AppHandle, key: String) -> Result<(), String> {
    with_connection(&app, |connection| {
        sqlite_delete_blob_inner(connection, &key)
    })
}

pub fn sqlite_delete_blobs_by_prefix_inner(
    connection: &Connection,
    prefix: &str,
) -> rusqlite::Result<u64> {
    let affected = with_prefix_range(
        prefix,
        |from, to| connection.execute(BLOB_DELETE_BY_PREFIX_SQL, params![from, to]),
        |from| connection.execute(BLOB_DELETE_FROM_SQL, params![from]),
    )?;
    Ok(affected as u64)
}

pub fn sqlite_delete_blobs_by_prefix(app: AppHandle, prefix: String) -> Result<u64, String> {
    with_connection(&app, |connection| {
        sqlite_delete_blobs_by_prefix_inner(connection, &prefix)
    })
}

pub fn sqlite_get_blob_stats_inner(
    connection: &Connection,
    prefix: Option<String>,
) -> rusqlite::Result<SqliteBlobStats> {
    let (count, total_size): (u64, u64) = if let Some(prefix) = prefix {
        let stats = |row: &rusqlite::Row| Ok((row.get(0)?, row.get(1)?));
        with_prefix_range(
            &prefix,
            |from, to| connection.query_row(BLOB_STATS_BY_PREFIX_SQL, params![from, to], stats),
            |from| connection.query_row(BLOB_STATS_FROM_SQL, params![from], stats),
        )?
    } else {
        connection.query_row(
            "SELECT COUNT(*), COALESCE(SUM(length(data)), 0) FROM blob_store",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?
    };

    Ok(SqliteBlobStats { count, total_size })
}

pub fn sqlite_get_blob_stats(
    app: AppHandle,
    prefix: Option<String>,
) -> Result<SqliteBlobStats, String> {
    with_connection(&app, |connection| {
        sqlite_get_blob_stats_inner(connection, prefix)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_support::*;

    #[test]
    fn test_kv_roundtrip() {
        let conn = setup_db();
        sqlite_set_kv_inner(&conn, "key1", "value1").unwrap();
        let result = sqlite_get_kv_inner(&conn, "key1").unwrap();
        assert_eq!(result, Some("value1".to_string()));
    }

    #[test]
    fn test_kv_get_nonexistent() {
        let conn = setup_db();
        let result = sqlite_get_kv_inner(&conn, "nonexistent").unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn test_kv_overwrite() {
        let conn = setup_db();
        sqlite_set_kv_inner(&conn, "key1", "value1").unwrap();
        sqlite_set_kv_inner(&conn, "key1", "value2").unwrap();
        let result = sqlite_get_kv_inner(&conn, "key1").unwrap();
        assert_eq!(result, Some("value2".to_string()));
    }

    #[test]
    fn test_kv_delete() {
        let conn = setup_db();
        sqlite_set_kv_inner(&conn, "key1", "value1").unwrap();
        sqlite_delete_kv_inner(&conn, "key1").unwrap();
        let result = sqlite_get_kv_inner(&conn, "key1").unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn test_batch_get_kv() {
        let conn = setup_db();
        sqlite_set_kv_inner(&conn, "a", "1").unwrap();
        sqlite_set_kv_inner(&conn, "b", "2").unwrap();
        sqlite_set_kv_inner(&conn, "c", "3").unwrap();
        let results =
            sqlite_batch_get_kv_inner(&conn, &["a".to_string(), "c".to_string()]).unwrap();
        assert_eq!(results.len(), 2);
        assert!(results.contains(&("a".to_string(), "1".to_string())));
        assert!(results.contains(&("c".to_string(), "3".to_string())));
    }

    #[test]
    fn test_batch_get_kv_empty() {
        let conn = setup_db();
        let results = sqlite_batch_get_kv_inner(&conn, &[]).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_kv_prefix_count() {
        let conn = setup_db();
        sqlite_set_kv_inner(&conn, "prefix:a", "1").unwrap();
        sqlite_set_kv_inner(&conn, "prefix:b", "2").unwrap();
        sqlite_set_kv_inner(&conn, "other:c", "3").unwrap();
        let count = sqlite_count_kv_by_prefix_inner(&conn, "prefix:").unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn test_kv_prefix_delete() {
        let conn = setup_db();
        sqlite_set_kv_inner(&conn, "prefix:a", "1").unwrap();
        sqlite_set_kv_inner(&conn, "prefix:b", "2").unwrap();
        sqlite_set_kv_inner(&conn, "other:c", "3").unwrap();
        let deleted = sqlite_delete_kv_by_prefix_inner(&conn, "prefix:").unwrap();
        assert_eq!(deleted, 2);
        assert_eq!(sqlite_get_kv_inner(&conn, "prefix:a").unwrap(), None);
        assert_eq!(
            sqlite_get_kv_inner(&conn, "other:c").unwrap(),
            Some("3".to_string())
        );
    }

    #[test]
    fn test_blob_roundtrip() {
        let conn = setup_db();
        let data = vec![1, 2, 3, 4, 5];
        sqlite_set_blob_inner(&conn, "blob1", &data).unwrap();
        let result = sqlite_get_blob_inner(&conn, "blob1").unwrap();
        assert_eq!(result, Some(data));
    }

    #[test]
    fn test_blob_get_nonexistent() {
        let conn = setup_db();
        let result = sqlite_get_blob_inner(&conn, "nonexistent").unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn test_blob_delete() {
        let conn = setup_db();
        sqlite_set_blob_inner(&conn, "blob1", &[1, 2, 3]).unwrap();
        sqlite_delete_blob_inner(&conn, "blob1").unwrap();
        let result = sqlite_get_blob_inner(&conn, "blob1").unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn test_blob_prefix_delete() {
        let conn = setup_db();
        sqlite_set_blob_inner(&conn, "pfx:a", &[1]).unwrap();
        sqlite_set_blob_inner(&conn, "pfx:b", &[2]).unwrap();
        sqlite_set_blob_inner(&conn, "other:c", &[3]).unwrap();
        let deleted = sqlite_delete_blobs_by_prefix_inner(&conn, "pfx:").unwrap();
        assert_eq!(deleted, 2);
        assert_eq!(sqlite_get_blob_inner(&conn, "pfx:a").unwrap(), None);
        assert_eq!(
            sqlite_get_blob_inner(&conn, "other:c").unwrap(),
            Some(vec![3])
        );
    }

    #[test]
    fn test_blob_stats() {
        let conn = setup_db();
        let stats = sqlite_get_blob_stats_inner(&conn, None::<String>).unwrap();
        assert_eq!(stats.count, 0);
        assert_eq!(stats.total_size, 0);

        sqlite_set_blob_inner(&conn, "a", &[1, 2, 3]).unwrap();
        sqlite_set_blob_inner(&conn, "b", &[4, 5]).unwrap();
        let stats = sqlite_get_blob_stats_inner(&conn, None::<String>).unwrap();
        assert_eq!(stats.count, 2);
        assert_eq!(stats.total_size, 5);
    }

    #[test]
    fn test_blob_stats_with_prefix() {
        let conn = setup_db();
        sqlite_set_blob_inner(&conn, "pfx:a", &[1, 2, 3]).unwrap();
        sqlite_set_blob_inner(&conn, "pfx:b", &[4, 5]).unwrap();
        sqlite_set_blob_inner(&conn, "other:c", &[6]).unwrap();
        let stats = sqlite_get_blob_stats_inner(&conn, Some("pfx:".to_string())).unwrap();
        assert_eq!(stats.count, 2);
        assert_eq!(stats.total_size, 5);
    }

    #[test]
    fn prefix_upper_bound_is_the_next_string_after_every_prefixed_key() {
        assert_eq!(prefix_upper_bound(""), None);
        assert_eq!(prefix_upper_bound("abc").as_deref(), Some("abd"));
        assert_eq!(prefix_upper_bound("a%").as_deref(), Some("a&"));
        assert_eq!(prefix_upper_bound("a_").as_deref(), Some("a`"));
        assert_eq!(prefix_upper_bound("é").as_deref(), Some("ê"));
        // The successor skips the surrogate gap.
        assert_eq!(
            prefix_upper_bound("x\u{D7FF}").as_deref(),
            Some("x\u{E000}")
        );
        // The last code point has no successor: carry into the one before.
        assert_eq!(prefix_upper_bound("ab\u{10FFFF}").as_deref(), Some("ac"));
        assert_eq!(prefix_upper_bound("\u{10FFFF}\u{10FFFF}"), None);
    }

    /// A prefix is matched exactly: `%` and `_` are not wildcards, case
    /// matters, and non-ASCII prefixes work.
    #[test]
    fn kv_and_blob_prefix_operations_match_the_prefix_exactly() {
        let (_dir, store) = migrated_store();
        let keys = [
            "theorem-stardict:a:ifo",
            "theorem-stardict:b:idx",
            "theorem-stardict",
            "THEOREM-STARDICT:c",
            "theorem-stardict;next",
            "100%:a",
            "100x:a",
            "a_b:1",
            "axb:1",
            "日本:1",
            "日本語:2",
            "日本\u{10FFFF}",
            "日朝:3",
            "\u{10FFFF}\u{10FFFF}z",
        ];
        store
            .with_connection(|c| {
                for key in keys {
                    sqlite_set_kv_inner(c, key, "v")?;
                    sqlite_set_blob_inner(c, key, b"1234")?;
                }
                Ok(())
            })
            .unwrap();
        let count = |prefix: &str| {
            store
                .with_connection(|c| sqlite_count_kv_by_prefix_inner(c, prefix))
                .unwrap()
        };
        assert_eq!(count("theorem-stardict:"), 2);
        assert_eq!(count("100%"), 1);
        assert_eq!(count("a_b"), 1);
        assert_eq!(count("日本"), 3);
        assert_eq!(count("日本語"), 1);
        assert_eq!(count("\u{10FFFF}"), 1);
        // An empty prefix is every key (migrations add some of their own).
        let all: u64 = store
            .with_connection(|c| c.query_row("SELECT COUNT(*) FROM kv_store", [], |r| r.get(0)))
            .unwrap();
        assert!(all >= keys.len() as u64);
        assert_eq!(count(""), all);

        let stats = store
            .with_connection(|c| sqlite_get_blob_stats_inner(c, Some("日本".into())))
            .unwrap();
        assert_eq!((stats.count, stats.total_size), (3, 12));

        assert_eq!(
            store
                .with_connection(|c| sqlite_delete_blobs_by_prefix_inner(c, "a_"))
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .with_connection(|c| sqlite_delete_kv_by_prefix_inner(c, "theorem-stardict:"))
                .unwrap(),
            2
        );
        assert_eq!(count("THEOREM-STARDICT"), 1, "other case is kept");
        assert_eq!(count("theorem-stardict"), 2, "neighbours are kept");
        assert!(store
            .with_connection(|c| sqlite_get_blob_inner(c, "axb:1"))
            .unwrap()
            .is_some());
    }

    fn query_plan(c: &Connection, sql: &str) -> String {
        let mut stmt = c.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(3))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        rows.join("\n")
    }

    #[test]
    fn prefix_queries_and_annotation_reads_use_indexes() {
        let (_dir, store) = migrated_store();
        store
            .with_connection(|c| {
                for (sql, table) in [
                    (KV_COUNT_BY_PREFIX_SQL, "kv_store"),
                    (KV_DELETE_BY_PREFIX_SQL, "kv_store"),
                    (BLOB_DELETE_BY_PREFIX_SQL, "blob_store"),
                    (BLOB_STATS_BY_PREFIX_SQL, "blob_store"),
                ] {
                    let sql = sql.replace("?1", "'a'").replace("?2", "'b'");
                    let plan = query_plan(c, &sql);
                    assert!(
                        plan.contains(&format!("SEARCH {table}")) && plan.contains("key>? AND key<?"),
                        "{sql}: {plan}"
                    );
                }
                let plan = query_plan(
                    c,
                    "SELECT annotation_json FROM book_annotations WHERE book_id = 'b' ORDER BY updated_at",
                );
                assert!(!plan.contains("TEMP B-TREE"), "{plan}");
                Ok(())
            })
            .unwrap();
    }
}
