//! Edits two devices made without seeing each other: detection and the list the user reviews.

use super::*;

/// Two devices changed the same item without either seeing the other's
/// change: the newer change is kept (the merge rules decide that, as always);
/// this is the record of the one that was replaced.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct ConcurrentEdit {
    /// True when this device's change was kept and the other device's replaced.
    local_kept: bool,
    /// The fields that differ: the values kept, and the values replaced.
    kept: serde_json::Map<String, serde_json::Value>,
    discarded: serde_json::Map<String, serde_json::Value>,
    kept_at: i64,
    discarded_at: i64,
}

/// Compares this device's copy of an item with a peer's, both stamped with
/// when they were last edited (`stamp`) and which edit that one was made on
/// top of (`base`). The newer edit replaces the older one; that is a conflict
/// only if the newer edit was made without knowing the older one (its base
/// is older than the older edit), and only for the fields where they differ.
/// Items edited one after the other, after syncing, never conflict.
pub(super) fn concurrent_edit(
    local: &serde_json::Value,
    incoming: &serde_json::Value,
    stamp: &str,
    base: &str,
    fields: &[&str],
) -> Option<ConcurrentEdit> {
    let local_at = parse_sync_date(local.get(stamp))?;
    let incoming_at = parse_sync_date(incoming.get(stamp))?;
    if local_at == incoming_at {
        return None;
    }
    let local_kept = local_at > incoming_at;
    let (winner, loser, kept_at, discarded_at) = if local_kept {
        (local, incoming, local_at, incoming_at)
    } else {
        (incoming, local, incoming_at, local_at)
    };
    if parse_sync_date(winner.get(base)).is_some_and(|known| known >= discarded_at) {
        return None;
    }
    let mut kept = serde_json::Map::new();
    let mut discarded = serde_json::Map::new();
    for field in fields {
        if *field == stamp || *field == base {
            continue;
        }
        let w = winner.get(*field).unwrap_or(&serde_json::Value::Null);
        let l = loser.get(*field).unwrap_or(&serde_json::Value::Null);
        if w != l {
            kept.insert(field.to_string(), w.clone());
            discarded.insert(field.to_string(), l.clone());
        }
    }
    if kept.is_empty() {
        return None;
    }
    Some(ConcurrentEdit {
        local_kept,
        kept,
        discarded,
        kept_at,
        discarded_at,
    })
}

/// Stores a conflict for the user to review. The same conflict seen again
/// (the full reads repeat every entry) is stored once. Returns whether it is
/// new. Never fails the merge: a conflict that cannot be stored is logged.
pub(super) fn record_sync_conflict(
    connection: &Connection,
    entity_type: &str,
    entity_id: &str,
    label: &str,
    found: &ConcurrentEdit,
) -> bool {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(
        format!(
            "{entity_type}|{entity_id}|{}|{}",
            found.kept_at, found.discarded_at
        )
        .as_bytes(),
    );
    let id: String = hasher.finalize()[..12]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let now = chrono::Utc::now().timestamp_millis();
    match connection.execute(
        "INSERT OR IGNORE INTO sync_conflicts(id, entity_type, entity_id, label, winner, kept_json, discarded_json, kept_at, discarded_at, detected_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            id,
            entity_type,
            entity_id,
            label,
            if found.local_kept { "local" } else { "remote" },
            serde_json::Value::Object(found.kept.clone()).to_string(),
            serde_json::Value::Object(found.discarded.clone()).to_string(),
            found.kept_at,
            found.discarded_at,
            now,
        ],
    ) {
        Ok(n) => n > 0,
        Err(e) => {
            log::warn!("[sync] could not record a sync conflict: {e}");
            false
        }
    }
}

/// How long a conflict stays listed.
const SYNC_CONFLICT_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncConflictRecord {
    pub id: String,
    /// "book" or "annotation".
    pub entity_type: String,
    pub entity_id: String,
    /// The book's title, or the highlighted text.
    pub label: String,
    /// "local": this device's change was kept; "remote": the other device's.
    pub winner: String,
    /// The fields that differ: the values in use now…
    pub kept: serde_json::Value,
    /// …and the values that were replaced.
    pub discarded: serde_json::Value,
    pub kept_at: i64,
    pub discarded_at: i64,
    pub detected_at: i64,
}

/// The conflicts not yet dismissed, newest first (older than 30 days are
/// removed).
pub fn sqlite_list_sync_conflicts_inner(
    connection: &Connection,
) -> rusqlite::Result<Vec<SyncConflictRecord>> {
    let cutoff = chrono::Utc::now().timestamp_millis() - SYNC_CONFLICT_TTL_MS;
    connection.execute(
        "DELETE FROM sync_conflicts WHERE detected_at < ?1",
        params![cutoff],
    )?;
    let mut stmt = connection.prepare(
        "SELECT id, entity_type, entity_id, label, winner, kept_json, discarded_json, kept_at, discarded_at, detected_at FROM sync_conflicts WHERE dismissed = 0 ORDER BY detected_at DESC, id LIMIT 200",
    )?;
    let rows = stmt.query_map([], |row| {
        let json = |s: String| serde_json::from_str(&s).unwrap_or(serde_json::Value::Null);
        Ok(SyncConflictRecord {
            id: row.get(0)?,
            entity_type: row.get(1)?,
            entity_id: row.get(2)?,
            label: row.get(3)?,
            winner: row.get(4)?,
            kept: json(row.get(5)?),
            discarded: json(row.get(6)?),
            kept_at: row.get(7)?,
            discarded_at: row.get(8)?,
            detected_at: row.get(9)?,
        })
    })?;
    rows.collect()
}

pub fn sqlite_list_sync_conflicts(app: AppHandle) -> Result<Vec<SyncConflictRecord>, AppError> {
    with_connection(&app, sqlite_list_sync_conflicts_inner)
}

/// Hides conflicts from the list (all of them when `ids` is empty). They are
/// kept as dismissed, so the same conflict read again is not listed again.
pub fn sqlite_dismiss_sync_conflicts_inner(
    connection: &Connection,
    ids: &[String],
) -> rusqlite::Result<usize> {
    if ids.is_empty() {
        return connection.execute("UPDATE sync_conflicts SET dismissed = 1", []);
    }
    let mut n = 0;
    for id in ids {
        n += connection.execute(
            "UPDATE sync_conflicts SET dismissed = 1 WHERE id = ?1",
            params![id],
        )?;
    }
    Ok(n)
}

pub fn sqlite_dismiss_sync_conflicts(app: AppHandle, ids: Vec<String>) -> Result<usize, AppError> {
    with_connection(&app, |c| sqlite_dismiss_sync_conflicts_inner(c, &ids))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_support::*;

    #[test]
    fn edits_made_one_after_the_other_are_not_conflicts() {
        let local = serde_json::json!({"title":"Dune","metadataUpdatedAt":"2026-05-01T00:00:00Z"});
        // The other device saw this device's edit, then edited on top of it.
        let after = serde_json::json!({"title":"Dune Messiah","metadataUpdatedAt":"2026-05-02T00:00:00Z","metadataBaseAt":"2026-05-01T00:00:00Z"});
        assert_eq!(
            concurrent_edit(
                &local,
                &after,
                "metadataUpdatedAt",
                "metadataBaseAt",
                BOOK_EDITABLE_FIELDS
            ),
            None
        );
        // Reversed: this device's newer edit was made on top of the incoming one.
        assert_eq!(
            concurrent_edit(
                &after,
                &local,
                "metadataUpdatedAt",
                "metadataBaseAt",
                BOOK_EDITABLE_FIELDS
            ),
            None
        );
        // Same stamp, unstamped copies, or the same change on both: no conflict.
        assert_eq!(
            concurrent_edit(
                &local,
                &local,
                "metadataUpdatedAt",
                "metadataBaseAt",
                BOOK_EDITABLE_FIELDS
            ),
            None
        );
        let unstamped = serde_json::json!({"title":"Other"});
        assert_eq!(
            concurrent_edit(
                &local,
                &unstamped,
                "metadataUpdatedAt",
                "metadataBaseAt",
                BOOK_EDITABLE_FIELDS
            ),
            None
        );
        let same_change =
            serde_json::json!({"title":"Dune","metadataUpdatedAt":"2026-05-03T00:00:00Z"});
        assert_eq!(
            concurrent_edit(
                &local,
                &same_change,
                "metadataUpdatedAt",
                "metadataBaseAt",
                BOOK_EDITABLE_FIELDS
            ),
            None
        );
    }

    #[test]
    fn edits_made_without_seeing_each_other_are_a_conflict_on_the_differing_fields() {
        let local = serde_json::json!({
            "title":"Dune","isFavorite":true,"tags":["sf"],
            "metadataUpdatedAt":"2026-05-02T00:00:00Z","metadataBaseAt":"2026-04-01T00:00:00Z"
        });
        let incoming = serde_json::json!({
            "title":"Dune","isFavorite":false,"tags":["sf","classic"],"rating":4,
            "metadataUpdatedAt":"2026-05-03T00:00:00Z","metadataBaseAt":"2026-04-01T00:00:00Z"
        });
        let found = concurrent_edit(
            &local,
            &incoming,
            "metadataUpdatedAt",
            "metadataBaseAt",
            BOOK_EDITABLE_FIELDS,
        )
        .expect("a conflict");
        assert!(!found.local_kept);
        assert_eq!(
            serde_json::Value::Object(found.kept),
            serde_json::json!({"isFavorite":false,"tags":["sf","classic"],"rating":4})
        );
        assert_eq!(
            serde_json::Value::Object(found.discarded),
            serde_json::json!({"isFavorite":true,"tags":["sf"],"rating":null})
        );
        // The first edit ever made on either side has no base: still concurrent.
        let first = serde_json::json!({"title":"A","metadataUpdatedAt":"2026-05-01T00:00:00Z"});
        let other_first =
            serde_json::json!({"title":"B","metadataUpdatedAt":"2026-05-02T00:00:00Z"});
        let found = concurrent_edit(
            &first,
            &other_first,
            "metadataUpdatedAt",
            "metadataBaseAt",
            BOOK_EDITABLE_FIELDS,
        )
        .expect("a conflict");
        assert_eq!(found.kept["title"], "B");
        assert_eq!(found.discarded["title"], "A");
    }

    #[test]
    fn a_conflict_is_recorded_once_listed_and_dismissed() {
        let conn = setup_db();
        merge_one(
            &conn,
            "book:b1",
            r#"{"id":"b1","title":"Dune","tags":["sf"],"metadataUpdatedAt":"2026-05-02T00:00:00Z"}"#,
        );
        let concurrent = r#"{"id":"b1","title":"Dune","tags":["classic"],"metadataUpdatedAt":"2026-05-03T00:00:00Z"}"#;
        assert_eq!(merge_one(&conn, "book:b1", concurrent).conflicts, 1);
        // The full read repeats entries: the same conflict is not added twice.
        conn.execute(
            "UPDATE book_metadata SET metadata_json = json_set(metadata_json, '$.tags', json('[\"sf\"]'), '$.metadataUpdatedAt', '2026-05-02T00:00:00Z') WHERE book_id = 'b1'",
            [],
        )
        .unwrap();
        assert_eq!(merge_one(&conn, "book:b1", concurrent).conflicts, 0);

        let listed = sqlite_list_sync_conflicts_inner(&conn).unwrap();
        assert_eq!(listed.len(), 1);
        let c = &listed[0];
        assert_eq!(
            (c.entity_type.as_str(), c.entity_id.as_str()),
            ("book", "b1")
        );
        assert_eq!(c.label, "Dune");
        assert_eq!(c.winner, "remote");
        assert_eq!(c.kept, serde_json::json!({"tags":["classic"]}));
        assert_eq!(c.discarded, serde_json::json!({"tags":["sf"]}));
        // The merge still kept the newer edit.
        assert_eq!(
            stored_book(&conn, "b1")["tags"],
            serde_json::json!(["classic"])
        );

        assert_eq!(
            sqlite_dismiss_sync_conflicts_inner(&conn, std::slice::from_ref(&c.id)).unwrap(),
            1
        );
        assert!(sqlite_list_sync_conflicts_inner(&conn).unwrap().is_empty());
        // Seen again after dismissal: stays dismissed.
        conn.execute(
            "UPDATE book_metadata SET metadata_json = json_set(metadata_json, '$.tags', json('[\"sf\"]'), '$.metadataUpdatedAt', '2026-05-02T00:00:00Z') WHERE book_id = 'b1'",
            [],
        )
        .unwrap();
        merge_one(&conn, "book:b1", concurrent);
        assert!(sqlite_list_sync_conflicts_inner(&conn).unwrap().is_empty());
    }

    #[test]
    fn a_kept_local_edit_is_listed_as_the_other_devices_loss() {
        let conn = setup_db();
        merge_one(
            &conn,
            "book:b1",
            r#"{"id":"b1","title":"Mine","metadataUpdatedAt":"2026-05-09T00:00:00Z"}"#,
        );
        let older = merge_one(
            &conn,
            "book:b1",
            r#"{"id":"b1","title":"Theirs","metadataUpdatedAt":"2026-05-08T00:00:00Z"}"#,
        );
        assert_eq!(older.conflicts, 1);
        assert_eq!(stored_book(&conn, "b1")["title"], "Mine");
        let c = &sqlite_list_sync_conflicts_inner(&conn).unwrap()[0];
        assert_eq!(c.winner, "local");
        assert_eq!(c.kept["title"], "Mine");
        assert_eq!(c.discarded["title"], "Theirs");
    }

    #[test]
    fn concurrent_note_edits_on_an_annotation_are_a_conflict() {
        let conn = setup_db();
        merge_one(
            &conn,
            "anno:b1:a1",
            r#"{"id":"a1","bookId":"b1","selectedText":"Fear is the mind-killer","noteContent":"mine","color":"yellow","updatedAt":"2026-05-02T00:00:00Z","baseUpdatedAt":"2026-05-01T00:00:00Z"}"#,
        );
        let result = merge_one(
            &conn,
            "anno:b1:a1",
            r#"{"id":"a1","bookId":"b1","selectedText":"Fear is the mind-killer","noteContent":"theirs","color":"yellow","updatedAt":"2026-05-03T00:00:00Z","baseUpdatedAt":"2026-05-01T00:00:00Z"}"#,
        );
        assert_eq!(result.conflicts, 1);
        let c = &sqlite_list_sync_conflicts_inner(&conn).unwrap()[0];
        assert_eq!(c.entity_type, "annotation");
        assert_eq!(c.label, "Fear is the mind-killer");
        assert_eq!(c.kept, serde_json::json!({"noteContent":"theirs"}));
        assert_eq!(c.discarded, serde_json::json!({"noteContent":"mine"}));
        // Then an edit made after seeing that one: no new conflict.
        let after = merge_one(
            &conn,
            "anno:b1:a1",
            r#"{"id":"a1","bookId":"b1","noteContent":"agreed","updatedAt":"2026-05-04T00:00:00Z","baseUpdatedAt":"2026-05-03T00:00:00Z"}"#,
        );
        assert_eq!(after.conflicts, 0);
    }

    #[test]
    fn old_conflicts_leave_the_list() {
        let conn = setup_db();
        let old = chrono::Utc::now().timestamp_millis() - SYNC_CONFLICT_TTL_MS - 1;
        conn.execute(
            "INSERT INTO sync_conflicts(id, entity_type, entity_id, label, winner, kept_json, discarded_json, kept_at, discarded_at, detected_at) VALUES('x','book','b','t','local','{}','{}',1,0,?1)",
            params![old],
        )
        .unwrap();
        assert!(sqlite_list_sync_conflicts_inner(&conn).unwrap().is_empty());
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_conflicts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }
}
