//! `theorem feeds` (RSS) and `theorem extract`.

use super::*;

#[derive(Subcommand)]
pub(super) enum FeedsCommand {
    /// List feeds with unread counts
    List,
    /// Subscribe to a new feed
    Add { url: String },
    /// Unsubscribe from a feed (by url or id)
    Remove { feed: String },
    /// Fetch every feed and merge new articles into the library
    Refresh,
}

// Feeds live in SQLite (`rss_feeds`, `rss_articles`, `rss_article_content`),
// as the 1.6.0 app keeps them; parsing is the app's `rss_parser`. A removed
// feed leaves a tombstone in the library store, as the app's `removeFeed`.

/// How the app compares feed and article addresses (`normalizeUrl` in
/// `rssStore.ts`): lower case, no trailing slashes.
fn normalize_feed_url(url: &str) -> String {
    url.trim().to_lowercase().trim_end_matches('/').to_string()
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// A feed's date (RFC 2822 for RSS, RFC 3339 for Atom) in milliseconds.
fn parse_feed_date(raw: &str) -> Option<i64> {
    let raw = raw.trim();
    chrono::DateTime::parse_from_rfc2822(raw)
        .or_else(|_| chrono::DateTime::parse_from_rfc3339(raw))
        .ok()
        .map(|date| date.timestamp_millis())
}

/// Fetch and parse a feed. Network failures are `Network` errors (exit code
/// 4), anything that is not a feed `InvalidInput` (exit code 1).
fn fetch_feed(url: &str) -> Result<crate::rss_parser::ParsedFeed, AppError> {
    let client = crate::shared_http_client().map_err(AppError::network)?;
    let response = client
        .get(url)
        .header(
            reqwest::header::ACCEPT,
            "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5",
        )
        .send()
        .map_err(|e| AppError::network(format!("cannot fetch {url}: {e}")))?;
    if !response.status().is_success() {
        return Err(AppError::network(format!(
            "HTTP {} for {url}",
            response.status()
        )));
    }
    let bytes = response
        .bytes()
        .map_err(|e| AppError::network(format!("cannot read {url}: {e}")))?;
    if !crate::rss_parser::is_feed_document(&bytes) {
        return Err(AppError::invalid_input(format!(
            "{url} is not an RSS or Atom feed"
        )));
    }
    crate::rss_parser::parse_feed_bytes(&bytes)
        .map_err(|e| AppError::invalid_input(format!("{url}: {e}")))
}

/// Save the articles whose address is not in `known` (normalized); returns
/// how many were new.
fn save_new_articles(
    conn: &rusqlite::Connection,
    feed_id: &str,
    parsed: &crate::rss_parser::ParsedFeed,
    known: &mut std::collections::HashSet<String>,
    fetched_at: i64,
) -> rusqlite::Result<u32> {
    let mut added = 0;
    for article in parsed.articles.iter() {
        if !known.insert(normalize_feed_url(&article.url)) {
            continue;
        }
        let row = crate::database::RssArticleDto {
            id: uuid::Uuid::new_v4().to_string().into(),
            feed_id: feed_id.into(),
            title: article.title.clone(),
            author: article.author.clone(),
            url: article.url.clone(),
            summary: article.summary.clone(),
            content_source: None,
            image_url: article.image_url.clone(),
            published_at: article.published_at.as_deref().and_then(parse_feed_date),
            fetched_at: Some(fetched_at),
            is_read: false,
            is_favorite: false,
            is_saved: false,
            progress: None,
        };
        crate::database::sqlite_save_rss_article_inner(conn, &row, Some(&article.content), None)?;
        added += 1;
    }
    Ok(added)
}

fn article_urls(
    conn: &rusqlite::Connection,
    feed_id: Option<&str>,
) -> rusqlite::Result<std::collections::HashSet<String>> {
    let mut stmt =
        conn.prepare("SELECT url FROM rss_articles WHERE (?1 IS NULL OR feed_id = ?1)")?;
    let rows = stmt.query_map(rusqlite::params![feed_id], |row| row.get::<_, String>(0))?;
    rows.map(|url| url.map(|u| normalize_feed_url(&u)))
        .collect()
}

fn unread_count(conn: &rusqlite::Connection, feed_id: &str) -> rusqlite::Result<u32> {
    conn.query_row(
        "SELECT COUNT(*) FROM rss_articles WHERE feed_id = ?1 AND is_read = 0",
        rusqlite::params![feed_id],
        |row| row.get(0),
    )
}

fn load_feeds(ctx: &Ctx) -> Result<Vec<crate::database::RssFeedDto>, AppError> {
    ctx.store
        .with_connection(crate::database::sqlite_get_rss_feeds_inner)
}

pub(super) fn run_feeds(output: &Output, ctx: &Ctx, command: FeedsCommand) -> i32 {
    match command {
        FeedsCommand::List => feeds_list(output, ctx),
        FeedsCommand::Add { url } => feeds_add(output, ctx, &url),
        FeedsCommand::Remove { feed } => feeds_remove(output, ctx, &feed),
        FeedsCommand::Refresh => feeds_refresh(output, ctx),
    }
}

fn feeds_list(output: &Output, ctx: &Ctx) -> i32 {
    let feeds = match load_feeds(ctx) {
        Ok(feeds) => feeds,
        Err(e) => return output.error(&e),
    };
    if output.json {
        return output.print_json(&feeds);
    }
    for feed in &feeds {
        let error = feed
            .error_message
            .as_deref()
            .map(|e| format!("  error: {e}"))
            .unwrap_or_default();
        println!(
            "{}  {}  {}{}",
            output.dim(&feed.id),
            output.bold(&feed.title),
            output.dim(&format!("({} unread) {}", feed.unread_count, feed.url)),
            output.red(&error)
        );
    }
    output.note(&format!("# {} feeds", feeds.len()));
    0
}

fn feeds_add(output: &Output, ctx: &Ctx, url: &str) -> i32 {
    let url = url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return output.usage("a feed address starts with http:// or https://");
    }
    match load_feeds(ctx) {
        Ok(feeds) => {
            let wanted = normalize_feed_url(url);
            if feeds.iter().any(|f| normalize_feed_url(&f.url) == wanted) {
                return output.error(&format!("feed already subscribed: {url}"));
            }
        }
        Err(e) => return output.error(&e),
    }
    let parsed = match fetch_feed(url) {
        Ok(parsed) => parsed,
        Err(e) => return output.error(e),
    };

    let id = uuid::Uuid::new_v4().to_string();
    let now = now_millis();
    let saved = ctx.store.with_connection(|conn| {
        let tx =
            rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
        // As the app: an article already stored under another feed is not
        // added twice.
        let mut feed = crate::database::RssFeedDto {
            id: id.as_str().into(),
            title: parsed.title.clone(),
            url: url.into(),
            site_url: parsed.site_url.clone(),
            description: parsed.description.clone(),
            icon_url: parsed.icon_url.clone(),
            last_fetched: Some(now),
            added_at: Some(now),
            error_message: None,
            unread_count: 0,
        };
        // The feed row first: articles refer to it.
        crate::database::sqlite_save_rss_feed_inner(&tx, &feed)?;
        let mut known = article_urls(&tx, None)?;
        let added = save_new_articles(&tx, &id, &parsed, &mut known, now)?;
        feed.unread_count = added;
        crate::database::sqlite_save_rss_feed_inner(&tx, &feed)?;
        tx.commit()?;
        Ok(added)
    });
    let added = match saved {
        Ok(added) => added,
        Err(e) => return output.error(&e),
    };

    if output.json {
        output.print_json(&serde_json::json!({
            "id": id,
            "url": url,
            "title": parsed.title,
            "articles": added,
        }))
    } else {
        println!(
            "{} {} {}",
            output.green("subscribed"),
            output.bold(&parsed.title),
            output.dim(&format!("({added} articles)"))
        );
        0
    }
}

fn feeds_remove(output: &Output, ctx: &Ctx, feed: &str) -> i32 {
    let feeds = match load_feeds(ctx) {
        Ok(feeds) => feeds,
        Err(e) => return output.error(&e),
    };
    let wanted = normalize_feed_url(feed);
    let Some(found) = feeds
        .iter()
        .find(|f| &*f.id == feed)
        .or_else(|| feeds.iter().find(|f| normalize_feed_url(&f.url) == wanted))
    else {
        return output.error(AppError::not_found(format!("feed '{feed}' not found")));
    };
    let feed_id = found.id.to_string();

    // As the app's `removeFeed`: the feed and its articles go, and a
    // tombstone tells sync to remove them on other devices.
    let removed = update_library_kv(ctx, |conn, envelope| {
        // `sqlite_delete_rss_feed_inner`'s statements, inside this transaction.
        for sql in [
            "DELETE FROM rss_article_content WHERE article_id IN \
             (SELECT id FROM rss_articles WHERE feed_id = ?1)",
            "DELETE FROM rss_articles WHERE feed_id = ?1",
            "DELETE FROM rss_feeds WHERE id = ?1",
        ] {
            conn.execute(sql, rusqlite::params![feed_id])
                .map_err(|e| e.to_string())?;
        }
        let state = envelope_state(envelope, LIBRARY_STORE)?;
        state_list(state, "deletionTombstones", LIBRARY_STORE)?.push(tombstone(&feed_id, "feed"));
        Ok(())
    });
    if let Err(e) = removed {
        return output.error(&e);
    }

    if output.json {
        output.print_json(&serde_json::json!({ "removed": feed_id, "title": found.title }))
    } else {
        println!("{} {}", output.green("unsubscribed"), found.title);
        0
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedRefresh {
    id: String,
    title: String,
    new_articles: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn feeds_refresh(output: &Output, ctx: &Ctx) -> i32 {
    let feeds = match load_feeds(ctx) {
        Ok(feeds) => feeds,
        Err(e) => return output.error(&e),
    };
    if feeds.is_empty() {
        output.note("no feeds subscribed");
        if output.json {
            return output.print_json(&Vec::<FeedRefresh>::new());
        }
        return 0;
    }

    let mut results = Vec::with_capacity(feeds.len());
    let mut code = 0;
    for feed in &feeds {
        let fetched = fetch_feed(&feed.url);
        let now = now_millis();
        let saved = ctx.store.with_connection(|conn| {
            let tx = rusqlite::Transaction::new_unchecked(
                conn,
                rusqlite::TransactionBehavior::Immediate,
            )?;
            let mut updated = feed.clone();
            let (added, error) = match &fetched {
                Ok(parsed) => {
                    let mut known = article_urls(&tx, Some(&feed.id))?;
                    let added = save_new_articles(&tx, &feed.id, parsed, &mut known, now)?;
                    if !parsed.title.is_empty() {
                        updated.title = parsed.title.clone();
                    }
                    updated.last_fetched = Some(now);
                    updated.error_message = None;
                    (added, None)
                }
                Err(e) => {
                    updated.error_message = Some(e.message().into());
                    (0, Some(e.message().to_string()))
                }
            };
            updated.unread_count = unread_count(&tx, &feed.id)?;
            crate::database::sqlite_save_rss_feed_inner(&tx, &updated)?;
            tx.commit()?;
            Ok((updated.title.to_string(), added, error))
        });
        match saved {
            Ok((title, new_articles, error)) => {
                if let Err(failure) = &fetched {
                    code = if code == 0 {
                        exit_code_for(failure.kind())
                    } else {
                        code
                    };
                }
                results.push(FeedRefresh {
                    id: feed.id.to_string(),
                    title,
                    new_articles,
                    error,
                });
            }
            Err(e) => return output.error(&e),
        }
    }

    if output.json {
        let printed = output.print_json(&results);
        return if printed != 0 { printed } else { code };
    }
    let mut total = 0;
    for result in &results {
        total += result.new_articles;
        match &result.error {
            None => println!(
                "{} {} {}",
                output.green("refreshed"),
                output.bold(&result.title),
                output.dim(&format!("({} new)", result.new_articles))
            ),
            Some(e) => eprintln!("{} {}: {e}", output.red("failed"), result.title),
        }
    }
    output.note(&format!(
        "# {total} new articles across {} feeds",
        results.len()
    ));
    code
}

pub(super) fn run_extract(output: &Output, url: &str) -> i32 {
    let article = match block_on(|| {
        crate::article_extractor::fetch_and_extract_article_native(url.to_string())
    }) {
        Ok(article) => article,
        Err(e) => return output.error(&e),
    };

    if output.json {
        output.print_json(&article)
    } else {
        println!("{}", output.bold(&article.title));
        if let Some(byline) = &article.byline {
            println!("{}", output.dim(&format!("by {byline}")));
        }
        println!();
        match &article.text_content {
            Some(text) => print!("{text}"),
            None => print!("{}", article.content),
        }
        0
    }
}
