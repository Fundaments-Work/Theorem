//! RSS feeds and articles, with retention.

use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RssFeedDto {
    pub id: Box<str>,
    pub title: Box<str>,
    pub url: Box<str>,
    pub site_url: Option<Box<str>>,
    pub description: Option<Box<str>>,
    pub icon_url: Option<Box<str>>,
    pub last_fetched: Option<i64>,
    pub added_at: Option<i64>,
    pub error_message: Option<Box<str>>,
    pub unread_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RssArticleDto {
    pub id: Box<str>,
    pub feed_id: Box<str>,
    pub title: Box<str>,
    pub author: Option<Box<str>>,
    pub url: Box<str>,
    pub summary: Option<Box<str>>,
    pub content_source: Option<Box<str>>,
    pub image_url: Option<Box<str>>,
    pub published_at: Option<i64>,
    pub fetched_at: Option<i64>,
    pub is_read: bool,
    pub is_favorite: bool,
    pub is_saved: bool,
    pub progress: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RssArticleContentDto {
    pub article_id: Box<str>,
    pub content: Box<str>,
    pub full_content: Option<Box<str>>,
}

pub fn sqlite_get_rss_feeds_inner(connection: &Connection) -> rusqlite::Result<Vec<RssFeedDto>> {
    let mut stmt = connection.prepare(
        "SELECT id, title, url, site_url, description, icon_url, last_fetched, added_at, error_message, unread_count
         FROM rss_feeds ORDER BY added_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(RssFeedDto {
            id: row.get::<_, String>(0)?.into_boxed_str(),
            title: row.get::<_, String>(1)?.into_boxed_str(),
            url: row.get::<_, String>(2)?.into_boxed_str(),
            site_url: row.get::<_, Option<String>>(3)?.map(|s| s.into_boxed_str()),
            description: row.get::<_, Option<String>>(4)?.map(|s| s.into_boxed_str()),
            icon_url: row.get::<_, Option<String>>(5)?.map(|s| s.into_boxed_str()),
            last_fetched: row.get(6)?,
            added_at: row.get(7)?,
            error_message: row.get::<_, Option<String>>(8)?.map(|s| s.into_boxed_str()),
            unread_count: row.get(9)?,
        })
    })?;
    rows.collect()
}

pub fn sqlite_get_rss_feeds(app: AppHandle) -> Result<Vec<RssFeedDto>, AppError> {
    with_connection(&app, sqlite_get_rss_feeds_inner)
}

pub fn sqlite_save_rss_feed_inner(
    connection: &Connection,
    feed: &RssFeedDto,
) -> rusqlite::Result<()> {
    connection.execute(
        r#"
        INSERT INTO rss_feeds (
            id, title, url, site_url, description, icon_url,
            last_fetched, added_at, error_message, unread_count, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE(?8, unixepoch() * 1000), ?9, ?10, unixepoch())
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            url = excluded.url,
            site_url = excluded.site_url,
            description = excluded.description,
            icon_url = excluded.icon_url,
            last_fetched = excluded.last_fetched,
            error_message = excluded.error_message,
            unread_count = excluded.unread_count,
            updated_at = unixepoch()
        "#,
        params![
            &feed.id,
            &feed.title,
            &feed.url,
            &feed.site_url,
            &feed.description,
            &feed.icon_url,
            feed.last_fetched,
            feed.added_at,
            &feed.error_message,
            feed.unread_count,
        ],
    )?;
    Ok(())
}

pub fn sqlite_save_rss_feed(app: AppHandle, feed: RssFeedDto) -> Result<(), AppError> {
    with_connection(&app, |conn| sqlite_save_rss_feed_inner(conn, &feed))
}

pub fn sqlite_delete_rss_feed_inner(
    connection: &Connection,
    feed_id: &str,
) -> rusqlite::Result<()> {
    let tx = connection.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM rss_article_content WHERE article_id IN (SELECT id FROM rss_articles WHERE feed_id = ?1)",
        params![feed_id],
    )?;
    tx.execute(
        "DELETE FROM rss_articles WHERE feed_id = ?1",
        params![feed_id],
    )?;
    tx.execute("DELETE FROM rss_feeds WHERE id = ?1", params![feed_id])?;
    tx.commit()
}

pub fn sqlite_delete_rss_feed(app: AppHandle, feed_id: String) -> Result<(), AppError> {
    with_connection(&app, |conn| sqlite_delete_rss_feed_inner(conn, &feed_id))
}

fn map_rss_article_row(row: &rusqlite::Row) -> rusqlite::Result<RssArticleDto> {
    let is_read_int: i32 = row.get(10)?;
    let is_fav_int: i32 = row.get(11)?;
    let is_saved_int: i32 = row.get(12)?;
    Ok(RssArticleDto {
        id: row.get::<_, String>(0)?.into_boxed_str(),
        feed_id: row.get::<_, String>(1)?.into_boxed_str(),
        title: row.get::<_, String>(2)?.into_boxed_str(),
        author: row.get::<_, Option<String>>(3)?.map(|s| s.into_boxed_str()),
        url: row.get::<_, String>(4)?.into_boxed_str(),
        summary: row.get::<_, Option<String>>(5)?.map(|s| s.into_boxed_str()),
        content_source: row.get::<_, Option<String>>(6)?.map(|s| s.into_boxed_str()),
        image_url: row.get::<_, Option<String>>(7)?.map(|s| s.into_boxed_str()),
        published_at: row.get(8)?,
        fetched_at: row.get(9)?,
        is_read: is_read_int != 0,
        is_favorite: is_fav_int != 0,
        is_saved: is_saved_int != 0,
        progress: row.get(13)?,
    })
}

pub fn sqlite_get_rss_articles_inner(
    connection: &Connection,
    feed_id: Option<&str>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> rusqlite::Result<Vec<RssArticleDto>> {
    let limit_val = limit.unwrap_or(100);
    let offset_val = offset.unwrap_or(0);

    let sql = if feed_id.is_some() {
        "SELECT id, feed_id, title, author, url, summary, content_source, image_url,
                published_at, fetched_at, is_read, is_favorite, is_saved, progress
         FROM rss_articles
         WHERE feed_id = ?1
         ORDER BY fetched_at DESC LIMIT ?2 OFFSET ?3"
    } else {
        "SELECT id, feed_id, title, author, url, summary, content_source, image_url,
                published_at, fetched_at, is_read, is_favorite, is_saved, progress
         FROM rss_articles
         ORDER BY fetched_at DESC LIMIT ?1 OFFSET ?2"
    };

    let mut stmt = connection.prepare(sql)?;
    let rows = if let Some(fid) = feed_id {
        stmt.query_map(params![fid, limit_val, offset_val], map_rss_article_row)?
    } else {
        stmt.query_map(params![limit_val, offset_val], map_rss_article_row)?
    };

    rows.collect()
}

pub fn sqlite_get_rss_articles(
    app: AppHandle,
    feed_id: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<RssArticleDto>, AppError> {
    with_connection(&app, |conn| {
        sqlite_get_rss_articles_inner(conn, feed_id.as_deref(), limit, offset)
    })
}

pub fn sqlite_get_rss_article_inner(
    connection: &Connection,
    article_id: &str,
) -> rusqlite::Result<Option<RssArticleDto>> {
    let sql = "SELECT id, feed_id, title, author, url, summary, content_source, image_url,
                      published_at, fetched_at, is_read, is_favorite, is_saved, progress
               FROM rss_articles
               WHERE id = ?1";
    let mut stmt = connection.prepare(sql)?;
    let mut rows = stmt.query_map(params![article_id], map_rss_article_row)?;
    match rows.next() {
        Some(Ok(dto)) => Ok(Some(dto)),
        Some(Err(e)) => Err(e),
        None => Ok(None),
    }
}

pub fn sqlite_get_rss_article(
    app: AppHandle,
    article_id: String,
) -> Result<Option<RssArticleDto>, AppError> {
    with_connection(&app, |conn| sqlite_get_rss_article_inner(conn, &article_id))
}

pub fn sqlite_get_rss_article_content_inner(
    connection: &Connection,
    article_id: &str,
) -> rusqlite::Result<Option<RssArticleContentDto>> {
    let mut stmt = connection.prepare(
        "SELECT article_id, content, full_content FROM rss_article_content WHERE article_id = ?1",
    )?;
    stmt.query_row(params![article_id], |row| {
        Ok(RssArticleContentDto {
            article_id: row.get::<_, String>(0)?.into_boxed_str(),
            content: row.get::<_, String>(1)?.into_boxed_str(),
            full_content: row.get::<_, Option<String>>(2)?.map(|s| s.into_boxed_str()),
        })
    })
    .optional()
}

pub fn sqlite_get_rss_article_content(
    app: AppHandle,
    article_id: String,
) -> Result<Option<RssArticleContentDto>, AppError> {
    with_connection(&app, |conn| {
        sqlite_get_rss_article_content_inner(conn, &article_id)
    })
}

pub fn sqlite_save_rss_article_inner(
    connection: &Connection,
    article: &RssArticleDto,
    content: Option<&str>,
    full_content: Option<&str>,
) -> rusqlite::Result<()> {
    connection.execute(
        r#"
        INSERT INTO rss_articles (
            id, feed_id, title, author, url, summary,
            content_source, image_url, published_at, fetched_at,
            is_read, is_favorite, is_saved, progress, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, COALESCE(?10, unixepoch() * 1000), ?11, ?12, ?13, ?14, unixepoch())
        ON CONFLICT(id) DO UPDATE SET
            feed_id = excluded.feed_id,
            title = excluded.title,
            author = excluded.author,
            url = excluded.url,
            summary = excluded.summary,
            content_source = excluded.content_source,
            image_url = excluded.image_url,
            published_at = excluded.published_at,
            fetched_at = excluded.fetched_at,
            is_read = excluded.is_read,
            is_favorite = excluded.is_favorite,
            is_saved = excluded.is_saved,
            progress = excluded.progress,
            updated_at = unixepoch()
        "#,
        params![
            &article.id,
            &article.feed_id,
            &article.title,
            &article.author,
            &article.url,
            &article.summary,
            &article.content_source,
            &article.image_url,
            article.published_at,
            article.fetched_at,
            if article.is_read { 1 } else { 0 },
            if article.is_favorite { 1 } else { 0 },
            if article.is_saved { 1 } else { 0 },
            article.progress,
        ],
    )?;

    if let Some(c) = content {
        connection.execute(
            r#"
            INSERT INTO rss_article_content (article_id, content, full_content, updated_at)
            VALUES (?1, ?2, ?3, unixepoch())
            ON CONFLICT(article_id) DO UPDATE SET
                content = excluded.content,
                full_content = excluded.full_content,
                updated_at = unixepoch()
            "#,
            params![&article.id, c, full_content],
        )?;
    }

    Ok(())
}

pub fn sqlite_save_rss_article(
    app: AppHandle,
    article: RssArticleDto,
    content: Option<String>,
    full_content: Option<String>,
) -> Result<(), AppError> {
    with_connection(&app, |conn| {
        sqlite_save_rss_article_inner(conn, &article, content.as_deref(), full_content.as_deref())
    })
}

pub fn sqlite_mark_article_read_inner(
    connection: &Connection,
    article_id: &str,
    is_read: bool,
) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE rss_articles SET is_read = ?1, updated_at = unixepoch() WHERE id = ?2",
        params![if is_read { 1 } else { 0 }, article_id],
    )?;
    Ok(())
}

pub fn sqlite_mark_article_read(
    app: AppHandle,
    article_id: String,
    is_read: bool,
) -> Result<(), AppError> {
    with_connection(&app, |conn| {
        sqlite_mark_article_read_inner(conn, &article_id, is_read)
    })
}

pub fn sqlite_mark_article_favorite_inner(
    connection: &Connection,
    article_id: &str,
    is_favorite: bool,
) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE rss_articles SET is_favorite = ?1, updated_at = unixepoch() WHERE id = ?2",
        params![if is_favorite { 1 } else { 0 }, article_id],
    )?;
    Ok(())
}

pub fn sqlite_mark_article_favorite(
    app: AppHandle,
    article_id: String,
    is_favorite: bool,
) -> Result<(), AppError> {
    with_connection(&app, |conn| {
        sqlite_mark_article_favorite_inner(conn, &article_id, is_favorite)
    })
}

pub fn sqlite_delete_rss_article_inner(
    connection: &Connection,
    article_id: &str,
) -> rusqlite::Result<()> {
    // Content goes explicitly, children first, as `delete_book_rows` does.
    let tx = connection.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM rss_article_content WHERE article_id = ?1",
        params![article_id],
    )?;
    tx.execute(
        "DELETE FROM rss_articles WHERE id = ?1",
        params![article_id],
    )?;
    tx.commit()
}

pub fn sqlite_delete_rss_article(app: AppHandle, article_id: String) -> Result<(), AppError> {
    with_connection(&app, |conn| {
        sqlite_delete_rss_article_inner(conn, &article_id)
    })
}

pub fn sqlite_mark_article_saved_inner(
    connection: &Connection,
    article_id: &str,
    is_saved: bool,
) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE rss_articles SET is_saved = ?1, updated_at = unixepoch() WHERE id = ?2",
        params![if is_saved { 1 } else { 0 }, article_id],
    )?;
    Ok(())
}

pub fn sqlite_mark_article_saved(
    app: AppHandle,
    article_id: String,
    is_saved: bool,
) -> Result<(), AppError> {
    with_connection(&app, |conn| {
        sqlite_mark_article_saved_inner(conn, &article_id, is_saved)
    })
}

/// Delete read articles (not saved, not favorite) older than `retention_days`
/// days, and unread ones too unless `keep_unread`. Articles with annotations
/// are kept. If `retention_days` is 0, nothing is deleted. Returns the number
/// of articles deleted.
pub fn sqlite_cleanup_old_rss_articles(
    app: AppHandle,
    retention_days: u32,
    keep_unread: bool,
) -> Result<u32, AppError> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    with_connection(&app, |conn| {
        sqlite_cleanup_old_rss_articles_inner(conn, retention_days, keep_unread, now_ms)
    })
}

/// Below this, an RSS timestamp is in seconds, not milliseconds: 1e11 ms is
/// March 1973, 1e11 s is the year 5138.
const RSS_SECONDS_THRESHOLD: i64 = 100_000_000_000;

/// RSS times (`fetched_at`, `published_at`, `last_fetched`, `added_at`) are
/// milliseconds, as the frontend writes them. Older fallbacks stored
/// `unixepoch()` seconds instead (and peers on older versions still sync
/// them); scale those up. Idempotent. Returns the number of rows changed.
pub(crate) fn normalize_rss_timestamp_units(conn: &Connection) -> rusqlite::Result<usize> {
    let tx = conn.unchecked_transaction()?;
    let mut changed = 0;
    for (table, column) in [
        ("rss_articles", "fetched_at"),
        ("rss_articles", "published_at"),
        ("rss_feeds", "last_fetched"),
        ("rss_feeds", "added_at"),
    ] {
        changed += tx.execute(
            &format!(
                "UPDATE {table} SET {column} = {column} * 1000 \
                 WHERE {column} > 0 AND {column} < ?1"
            ),
            params![RSS_SECONDS_THRESHOLD],
        )?;
    }
    tx.commit()?;
    Ok(changed)
}

pub fn sqlite_cleanup_old_rss_articles_inner(
    conn: &Connection,
    retention_days: u32,
    keep_unread: bool,
    now_ms: i64,
) -> rusqlite::Result<u32> {
    if retention_days == 0 {
        return Ok(0);
    }
    // `fetched_at` is milliseconds; compare against a cutoff computed here so
    // the `fetched_at` index can serve the range.
    let cutoff_ms = now_ms.saturating_sub(i64::from(retention_days) * 86_400_000);
    const EXPIRED: &str = r#"
        SELECT id FROM rss_articles
        WHERE fetched_at < ?1
          AND is_saved = 0
          AND is_favorite = 0
          AND (is_read = 1 OR ?2 = 0)
          AND id NOT IN (
              SELECT substr(book_id, 5) FROM book_annotations WHERE book_id LIKE 'rss:%'
          )
    "#;
    let keep_unread = i64::from(keep_unread);
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        &format!("DELETE FROM rss_article_content WHERE article_id IN ({EXPIRED})"),
        params![cutoff_ms, keep_unread],
    )?;
    let deleted = tx.execute(
        &format!("DELETE FROM rss_articles WHERE id IN ({EXPIRED})"),
        params![cutoff_ms, keep_unread],
    )?;
    tx.commit()?;
    Ok(deleted as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::test_support::*;

    #[test]
    fn delete_rss_feed_is_atomic() {
        let conn = setup_db();
        // The feed first: its articles reference it (foreign keys are on).
        conn.execute_batch(
            "CREATE TRIGGER fail_feed_delete BEFORE DELETE ON rss_feeds
             BEGIN SELECT RAISE(ABORT, 'boom'); END;
             INSERT INTO rss_feeds (id, title, url, added_at) VALUES ('f1', 'F', 'u', 1);",
        )
        .unwrap();
        sqlite_save_rss_article_inner(&conn, &rss_article("a1", Some(1), true), Some("x"), None)
            .unwrap();
        assert!(sqlite_delete_rss_feed_inner(&conn, "f1").is_err());
        assert_eq!(rss_ids(&conn), ["a1"]);
        assert!(sqlite_get_rss_article_content_inner(&conn, "a1")
            .unwrap()
            .is_some());
    }

    #[test]
    fn test_relational_crud_operations() {
        let conn = setup_db();

        // 1. Test RSS Feed CRUD
        let feed = RssFeedDto {
            id: "f1".into(),
            title: "Tech News".into(),
            url: "https://example.com/feed.xml".into(),
            site_url: Some("https://example.com".into()),
            description: Some("Tech news feed".into()),
            icon_url: None,
            last_fetched: Some(1000),
            added_at: Some(900),
            error_message: None,
            unread_count: 5,
        };
        sqlite_save_rss_feed_inner(&conn, &feed).unwrap();

        let feeds = sqlite_get_rss_feeds_inner(&conn).unwrap();
        assert_eq!(feeds.len(), 1);
        assert_eq!(&*feeds[0].title, "Tech News");
        assert_eq!(feeds[0].unread_count, 5);

        // 2. Test RSS Article & Content CRUD
        let article = RssArticleDto {
            id: "a1".into(),
            feed_id: "f1".into(),
            title: "Article 1".into(),
            author: Some("Author 1".into()),
            url: "https://example.com/a1".into(),
            summary: Some("Summary 1".into()),
            content_source: Some("feed".into()),
            image_url: None,
            published_at: Some(1050),
            fetched_at: Some(1060),
            is_read: false,
            is_favorite: false,
            is_saved: false,
            progress: Some(0.25),
        };
        sqlite_save_rss_article_inner(
            &conn,
            &article,
            Some("<p>Body 1</p>"),
            Some("<p>Full body 1</p>"),
        )
        .unwrap();

        let articles = sqlite_get_rss_articles_inner(&conn, Some("f1"), None, None).unwrap();
        assert_eq!(articles.len(), 1);
        assert_eq!(&*articles[0].title, "Article 1");
        assert!(!articles[0].is_read);
        assert!(!articles[0].is_saved);

        let content = sqlite_get_rss_article_content_inner(&conn, "a1")
            .unwrap()
            .unwrap();
        assert_eq!(&*content.content, "<p>Body 1</p>");
        assert_eq!(content.full_content.as_deref(), Some("<p>Full body 1</p>"));

        // 3. Mark read, favorite, and saved
        sqlite_mark_article_read_inner(&conn, "a1", true).unwrap();
        sqlite_mark_article_favorite_inner(&conn, "a1", true).unwrap();
        sqlite_mark_article_saved_inner(&conn, "a1", true).unwrap();
        let updated_articles = sqlite_get_rss_articles_inner(&conn, None, None, None).unwrap();
        assert!(updated_articles[0].is_read);
        assert!(updated_articles[0].is_favorite);
        assert!(updated_articles[0].is_saved);

        // 4. Test Reading Sessions
        sqlite_record_reading_session_inner(
            &conn,
            "session:2026-09-13",
            "2026-09-13",
            25.0,
            Some("book1"),
            Some("[\"book1\"]"),
        )
        .unwrap();

        // Increment session
        sqlite_record_reading_session_inner(
            &conn,
            "session:2026-09-13",
            "2026-09-13",
            15.0,
            Some("book1"),
            None,
        )
        .unwrap();

        let sessions = sqlite_get_reading_sessions_inner(&conn, Some("2026-09-01"), None).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].minutes, 40.0);

        // 5. Test Delete Article & Feed Cascade
        sqlite_delete_rss_article_inner(&conn, "a1").unwrap();
        assert!(sqlite_get_rss_articles_inner(&conn, None, None, None)
            .unwrap()
            .is_empty());
        assert!(sqlite_get_rss_article_content_inner(&conn, "a1")
            .unwrap()
            .is_none());

        sqlite_delete_rss_feed_inner(&conn, "f1").unwrap();
        assert!(sqlite_get_rss_feeds_inner(&conn).unwrap().is_empty());
    }

    fn rss_article(id: &str, fetched_at: Option<i64>, read: bool) -> RssArticleDto {
        RssArticleDto {
            id: id.into(),
            feed_id: "f1".into(),
            title: id.into(),
            author: None,
            url: format!("https://example.com/{id}").into(),
            summary: None,
            content_source: None,
            image_url: None,
            published_at: None,
            fetched_at,
            is_read: read,
            is_favorite: false,
            is_saved: false,
            progress: None,
        }
    }

    fn rss_ids(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT id FROM rss_articles ORDER BY id")
            .unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    /// `fetched_at` is stored in milliseconds (the frontend writes
    /// `Date.getTime()`); retention compared it with `unixepoch()` seconds,
    /// so nothing was ever old enough to delete.
    #[test]
    fn rss_retention_deletes_old_articles_stored_in_milliseconds() {
        let conn = setup_db();
        seed_feed(&conn, "f1");
        const DAY_MS: i64 = 86_400_000;
        let now_ms: i64 = 1_790_000_000_000; // 2026-09
        let save = |id: &str, age_days: i64, read: bool| {
            sqlite_save_rss_article_inner(
                &conn,
                &rss_article(id, Some(now_ms - age_days * DAY_MS), read),
                Some("<p>body</p>"),
                None,
            )
            .unwrap();
        };
        save("old-read", 40, true);
        save("new-read", 2, true);
        save("old-unread", 40, false);
        save("edge-read", 30, true); // exactly at the cutoff: kept
        save("old-saved", 40, true);
        sqlite_mark_article_saved_inner(&conn, "old-saved", true).unwrap();
        save("old-fav", 40, true);
        sqlite_mark_article_favorite_inner(&conn, "old-fav", true).unwrap();
        save("old-annotated", 40, true);
        sqlite_upsert_annotation_inner(&conn, "n1", "rss:old-annotated", "{}").unwrap();

        // Retention 0 means "keep forever".
        assert_eq!(
            sqlite_cleanup_old_rss_articles_inner(&conn, 0, true, now_ms).unwrap(),
            0
        );

        assert_eq!(
            sqlite_cleanup_old_rss_articles_inner(&conn, 30, true, now_ms).unwrap(),
            1
        );
        assert_eq!(
            rss_ids(&conn),
            [
                "edge-read",
                "new-read",
                "old-annotated",
                "old-fav",
                "old-saved",
                "old-unread"
            ]
        );
        assert!(sqlite_get_rss_article_content_inner(&conn, "old-read")
            .unwrap()
            .is_none());

        assert_eq!(
            sqlite_cleanup_old_rss_articles_inner(&conn, 30, false, now_ms).unwrap(),
            1
        );
        assert!(!rss_ids(&conn).contains(&"old-unread".to_string()));
        assert!(sqlite_get_rss_article_content_inner(&conn, "old-unread")
            .unwrap()
            .is_none());
    }

    /// Rows that fell back to `unixepoch()` (seconds) when no fetch time was
    /// given must be stored in milliseconds like every other row, and rows
    /// already written in seconds are converted on startup.
    #[test]
    fn rss_fetched_at_fallback_and_repair_use_milliseconds() {
        let conn = setup_db();
        // The feed first: its articles reference it (foreign keys are on).
        sqlite_save_rss_feed_inner(
            &conn,
            &RssFeedDto {
                id: "f1".into(),
                title: "Feed".into(),
                url: "https://example.com/feed".into(),
                site_url: None,
                description: None,
                icon_url: None,
                last_fetched: Some(1_780_000_000),
                added_at: Some(1_770_000_000),
                error_message: None,
                unread_count: 0,
            },
        )
        .unwrap();
        let before_ms = chrono::Utc::now().timestamp_millis();
        sqlite_save_rss_article_inner(&conn, &rss_article("no-time", None, true), None, None)
            .unwrap();
        let stored: i64 = conn
            .query_row(
                "SELECT fetched_at FROM rss_articles WHERE id = 'no-time'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(stored >= before_ms - 1_000, "stored {stored} is not ms");

        // A freshly fetched article without a time is not pruned at once.
        assert_eq!(
            sqlite_cleanup_old_rss_articles_inner(&conn, 15, true, before_ms + 1_000).unwrap(),
            0
        );

        // Legacy seconds rows are repaired; ms rows are left alone.
        sqlite_save_rss_article_inner(
            &conn,
            &rss_article("legacy", Some(1_780_000_000), true),
            None,
            None,
        )
        .unwrap();
        normalize_rss_timestamp_units(&conn).unwrap();
        let legacy: i64 = conn
            .query_row(
                "SELECT fetched_at FROM rss_articles WHERE id = 'legacy'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(legacy, 1_780_000_000_000);
        let (last_fetched, added_at): (i64, i64) = conn
            .query_row(
                "SELECT last_fetched, added_at FROM rss_feeds WHERE id = 'f1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            (last_fetched, added_at),
            (1_780_000_000_000, 1_770_000_000_000)
        );
        let again: i64 = conn
            .query_row(
                "SELECT fetched_at FROM rss_articles WHERE id = 'no-time'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(again, stored, "ms rows must not be scaled again");
        normalize_rss_timestamp_units(&conn).unwrap();
        let legacy_again: i64 = conn
            .query_row(
                "SELECT fetched_at FROM rss_articles WHERE id = 'legacy'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(legacy_again, 1_780_000_000_000, "repair is idempotent");
    }
}
