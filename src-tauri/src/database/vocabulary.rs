//! Vocabulary terms.

use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteVocabularyTerm {
    pub id: Box<str>,
    pub term: Box<str>,
    pub normalized_term: Box<str>,
    pub language: Box<str>,
    pub phonetic: Option<Box<str>>,
    pub audio_url: Option<Box<str>>,
    pub meanings_json: Box<str>,
    pub provider_history_json: Box<str>,
    pub source_book_id: Option<Box<str>>,
    pub context_sentence: Option<Box<str>>,
    pub created_at: i64,
    pub updated_at: Option<i64>,
}

fn map_vocabulary_row(row: &rusqlite::Row) -> rusqlite::Result<SqliteVocabularyTerm> {
    Ok(SqliteVocabularyTerm {
        id: row.get::<_, String>(0)?.into_boxed_str(),
        term: row.get::<_, String>(1)?.into_boxed_str(),
        normalized_term: row.get::<_, String>(2)?.into_boxed_str(),
        language: row.get::<_, String>(3)?.into_boxed_str(),
        phonetic: row.get::<_, Option<String>>(4)?.map(|s| s.into_boxed_str()),
        audio_url: row.get::<_, Option<String>>(5)?.map(|s| s.into_boxed_str()),
        meanings_json: row.get::<_, String>(6)?.into_boxed_str(),
        provider_history_json: row.get::<_, String>(7)?.into_boxed_str(),
        source_book_id: row.get::<_, Option<String>>(8)?.map(|s| s.into_boxed_str()),
        context_sentence: row.get::<_, Option<String>>(9)?.map(|s| s.into_boxed_str()),
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

pub fn sqlite_get_vocabulary_terms_inner(
    connection: &Connection,
) -> rusqlite::Result<Vec<SqliteVocabularyTerm>> {
    let mut stmt = connection.prepare(
        r#"
        SELECT id, term, normalized_term, language, phonetic, audio_url,
               meanings_json, provider_history_json, source_book_id,
               context_sentence, created_at, updated_at
        FROM vocabulary
        ORDER BY created_at DESC
        "#,
    )?;

    let rows = stmt.query_map([], map_vocabulary_row)?;
    let mut terms = Vec::new();
    for row in rows {
        terms.push(row?);
    }
    Ok(terms)
}

pub fn sqlite_save_vocabulary_term_inner(
    connection: &Connection,
    term: &SqliteVocabularyTerm,
) -> rusqlite::Result<()> {
    connection.execute(
        r#"
        INSERT INTO vocabulary (
            id, term, normalized_term, language, phonetic, audio_url,
            meanings_json, provider_history_json, source_book_id,
            context_sentence, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        ON CONFLICT(id) DO UPDATE SET
            term = excluded.term,
            normalized_term = excluded.normalized_term,
            language = excluded.language,
            phonetic = excluded.phonetic,
            audio_url = excluded.audio_url,
            meanings_json = excluded.meanings_json,
            provider_history_json = excluded.provider_history_json,
            source_book_id = excluded.source_book_id,
            context_sentence = excluded.context_sentence,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at
        "#,
        params![
            &term.id[..],
            &term.term[..],
            &term.normalized_term[..],
            &term.language[..],
            term.phonetic.as_deref(),
            term.audio_url.as_deref(),
            &term.meanings_json[..],
            &term.provider_history_json[..],
            term.source_book_id.as_deref(),
            term.context_sentence.as_deref(),
            term.created_at,
            term.updated_at
        ],
    )?;
    Ok(())
}

pub fn sqlite_delete_vocabulary_term_inner(
    connection: &Connection,
    term_id: &str,
) -> rusqlite::Result<()> {
    connection.execute("DELETE FROM vocabulary WHERE id = ?1", params![term_id])?;
    Ok(())
}

pub fn sqlite_get_vocabulary_terms(app: AppHandle) -> Result<Vec<SqliteVocabularyTerm>, String> {
    with_connection(&app, sqlite_get_vocabulary_terms_inner)
}

pub fn sqlite_save_vocabulary_term(
    app: AppHandle,
    term: SqliteVocabularyTerm,
) -> Result<(), String> {
    with_connection(&app, |conn| sqlite_save_vocabulary_term_inner(conn, &term))
}

pub fn sqlite_delete_vocabulary_term(app: AppHandle, term_id: String) -> Result<(), String> {
    with_connection(&app, |conn| {
        sqlite_delete_vocabulary_term_inner(conn, &term_id)
    })
}
