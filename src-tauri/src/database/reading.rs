//! Reading sessions and the daily goal reminder.

use super::*;

#[derive(Serialize)]
pub struct GoalReminderData {
    pub today_minutes: u64,
    pub daily_goal: u64,
}

/// "YYYY-MM-DD" for the given local time.
pub fn local_date_key<Tz: chrono::TimeZone>(now: chrono::DateTime<Tz>) -> String
where
    Tz::Offset: std::fmt::Display,
{
    now.format("%Y-%m-%d").to_string()
}

pub fn check_goal_reminder_inner(
    connection: &Connection,
) -> rusqlite::Result<Option<GoalReminderData>> {
    fn parse_error(msg: impl std::fmt::Display) -> rusqlite::Error {
        rusqlite::Error::InvalidParameterName(msg.to_string())
    }

    let json_str = match sqlite_get_kv_inner(connection, "zustand:theorem-settings")? {
        Some(s) => s,
        None => return Ok(None),
    };

    let parsed: serde_json::Value = serde_json::from_str(&json_str)
        .map_err(|e| parse_error(format!("Failed to parse settings JSON: {e}")))?;

    let stats = &parsed["state"]["stats"];
    let daily_goal = stats["dailyGoal"].as_u64().unwrap_or(30);

    // The reader's local calendar day, matching the keys the frontend writes
    // (src/core/lib/date-keys.ts). A UTC day made goals reset at the wrong hour.
    let today = local_date_key(chrono::Local::now());

    let today_session_minutes: Option<f64> = connection
        .query_row(
            "SELECT SUM(minutes) FROM reading_sessions WHERE session_date = ?1",
            params![today],
            |row| row.get::<_, Option<f64>>(0),
        )
        .optional()
        .unwrap_or(None)
        .flatten();

    let today_minutes = if let Some(min) = today_session_minutes {
        min as u64
    } else {
        stats["dailyActivity"]
            .as_array()
            .and_then(|arr| arr.iter().find(|a| a["date"].as_str() == Some(&today)))
            .map(|a| a["minutes"].as_u64().unwrap_or(0))
            .unwrap_or(0)
    };

    Ok(Some(GoalReminderData {
        today_minutes,
        daily_goal,
    }))
}

pub fn sqlite_check_goal_reminder(app: AppHandle) -> Result<Option<GoalReminderData>, AppError> {
    with_connection(&app, check_goal_reminder_inner)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingSessionDto {
    pub id: Box<str>,
    pub book_id: Option<Box<str>>,
    pub session_date: Box<str>,
    pub minutes: f64,
    pub books_read_json: Option<Box<str>>,
    pub created_at: i64,
}

pub fn sqlite_record_reading_session_inner(
    connection: &Connection,
    session_id: &str,
    date: &str,
    minutes: f64,
    book_id: Option<&str>,
    books_read_json: Option<&str>,
) -> rusqlite::Result<()> {
    connection.execute(
        r#"
        INSERT INTO reading_sessions (id, book_id, session_date, minutes, books_read_json, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, unixepoch())
        ON CONFLICT(id) DO UPDATE SET
            minutes = reading_sessions.minutes + excluded.minutes,
            book_id = COALESCE(excluded.book_id, reading_sessions.book_id),
            books_read_json = COALESCE(excluded.books_read_json, reading_sessions.books_read_json)
        "#,
        params![session_id, book_id, date, minutes, books_read_json],
    )?;
    Ok(())
}

/// Records an immutable reading chunk. Replaying a chunk must not add its time twice.
pub fn sqlite_record_reading_chunk_inner(
    connection: &Connection,
    chunk_id: &str,
    date: &str,
    minutes: f64,
    book_id: &str,
) -> rusqlite::Result<()> {
    let parsed = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").ok();
    if !chunk_id.starts_with("chunk:")
        || chunk_id.len() > 128
        || book_id.is_empty()
        || !minutes.is_finite()
        || minutes <= 0.0
        || minutes > 1440.0
        || parsed.is_none_or(|day| day.format("%Y-%m-%d").to_string() != date)
    {
        return Err(rusqlite::Error::InvalidParameterName(
            "Invalid reading chunk".into(),
        ));
    }
    connection.execute(
        "INSERT INTO reading_sessions (id, book_id, session_date, minutes, created_at)
         VALUES (?1, ?2, ?3, ?4, unixepoch()) ON CONFLICT(id) DO NOTHING",
        params![chunk_id, book_id, date, minutes],
    )?;
    let matches: bool = connection.query_row(
        "SELECT book_id = ?2 AND session_date = ?3 AND minutes = ?4 FROM reading_sessions WHERE id = ?1",
        params![chunk_id, book_id, date, minutes], |row| row.get(0),
    )?;
    if !matches {
        return Err(rusqlite::Error::InvalidParameterName(
            "Reading chunk identity conflict".into(),
        ));
    }
    Ok(())
}

pub fn sqlite_record_reading_chunk(
    app: AppHandle,
    chunk_id: String,
    date: String,
    minutes: f64,
    book_id: String,
) -> Result<(), AppError> {
    with_connection(&app, |connection| {
        sqlite_record_reading_chunk_inner(connection, &chunk_id, &date, minutes, &book_id)
    })
}

pub fn sqlite_record_reading_session(
    app: AppHandle,
    session_id: String,
    date: String,
    minutes: f64,
    book_id: Option<String>,
    books_read_json: Option<String>,
) -> Result<(), AppError> {
    with_connection(&app, |conn| {
        sqlite_record_reading_session_inner(
            conn,
            &session_id,
            &date,
            minutes,
            book_id.as_deref(),
            books_read_json.as_deref(),
        )
    })
}

fn map_reading_session_row(row: &rusqlite::Row) -> rusqlite::Result<ReadingSessionDto> {
    Ok(ReadingSessionDto {
        id: row.get::<_, String>(0)?.into_boxed_str(),
        book_id: row.get::<_, Option<String>>(1)?.map(|s| s.into_boxed_str()),
        session_date: row.get::<_, String>(2)?.into_boxed_str(),
        minutes: row.get(3)?,
        books_read_json: row.get::<_, Option<String>>(4)?.map(|s| s.into_boxed_str()),
        created_at: row.get(5)?,
    })
}

pub fn sqlite_get_reading_sessions_inner(
    connection: &Connection,
    start_date: Option<&str>,
    end_date: Option<&str>,
) -> rusqlite::Result<Vec<ReadingSessionDto>> {
    let mut query = String::from(
        "SELECT id, book_id, session_date, minutes, books_read_json, created_at FROM reading_sessions",
    );
    let mut clauses = Vec::new();
    if start_date.is_some() {
        clauses.push("session_date >= ?1");
    }
    if end_date.is_some() {
        if start_date.is_some() {
            clauses.push("session_date <= ?2");
        } else {
            clauses.push("session_date <= ?1");
        }
    }
    if !clauses.is_empty() {
        query.push_str(" WHERE ");
        query.push_str(&clauses.join(" AND "));
    }
    query.push_str(" ORDER BY session_date DESC, created_at DESC");

    let mut stmt = connection.prepare(&query)?;
    let rows = match (start_date, end_date) {
        (Some(start), Some(end)) => stmt.query_map(params![start, end], map_reading_session_row)?,
        (Some(start), None) => stmt.query_map(params![start], map_reading_session_row)?,
        (None, Some(end)) => stmt.query_map(params![end], map_reading_session_row)?,
        (None, None) => stmt.query_map([], map_reading_session_row)?,
    };

    rows.collect()
}

pub fn sqlite_get_reading_sessions(
    app: AppHandle,
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<Vec<ReadingSessionDto>, AppError> {
    with_connection(&app, |conn| {
        sqlite_get_reading_sessions_inner(conn, start_date.as_deref(), end_date.as_deref())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_chunk_replay_does_not_add_minutes() {
        let conn = crate::database::test_support::setup_db();
        for _ in 0..3 {
            sqlite_record_reading_chunk_inner(&conn, "chunk:one", "2026-10-31", 5.0, "book")
                .unwrap();
        }
        let sessions = sqlite_get_reading_sessions_inner(&conn, None, None).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].minutes, 5.0);
    }

    #[test]
    fn conflicting_and_invalid_chunks_leave_recorded_time_unchanged() {
        let conn = crate::database::test_support::setup_db();
        sqlite_record_reading_chunk_inner(&conn, "chunk:a", "2026-10-31", 5.0, "book").unwrap();
        for (id, day, minutes, book) in [
            ("chunk:a", "2026-10-31", 6.0, "book"),
            ("chunk:a", "2026-11-01", 5.0, "book"),
            ("chunk:a", "2026-10-31", 5.0, "other"),
            ("session:legacy", "2026-10-31", 5.0, "book"),
            ("chunk:b", "2026-02-30", 5.0, "book"),
            ("chunk:b", "2026-10-31", 0.0, "book"),
            ("chunk:b", "2026-10-31", -1.0, "book"),
            ("chunk:b", "2026-10-31", f64::NAN, "book"),
            ("chunk:b", "2026-10-31", f64::INFINITY, "book"),
            ("chunk:b", "2026-10-31", 1441.0, "book"),
            ("chunk:b", "2026-10-31", 1.0, ""),
        ] {
            assert!(sqlite_record_reading_chunk_inner(&conn, id, day, minutes, book).is_err());
        }
        let sessions = sqlite_get_reading_sessions_inner(&conn, None, None).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].minutes, 5.0);
    }

    #[test]
    fn local_date_key_uses_the_local_offset_not_utc() {
        use chrono::{FixedOffset, TimeZone};
        // 2026-09-23 22:30 in UTC-7 is already the 24th in UTC.
        let pacific = FixedOffset::west_opt(7 * 3600).unwrap();
        let evening = pacific.with_ymd_and_hms(2026, 9, 23, 22, 30, 0).unwrap();
        assert_eq!(local_date_key(evening), "2026-09-23");
        // 2026-09-24 03:00 in UTC+5:45 is still the 23rd in UTC.
        let nepal = FixedOffset::east_opt(5 * 3600 + 45 * 60).unwrap();
        let morning = nepal.with_ymd_and_hms(2026, 9, 24, 3, 0, 0).unwrap();
        assert_eq!(local_date_key(morning), "2026-09-24");
    }
}
