//! SIMD-accelerated fuzzy matcher engine powered by nucleo-matcher (Helix editor).
//!
//! Provides:
//! - Tier 2 SIMD Smith-Waterman fuzzy scoring and exact character match index extraction.
//! - In-memory typeahead (<0.05ms) for command palette, tags, shelves, and table-of-contents.
//! - Integrated Two-Tier hybrid search combining SQLite FTS5 disk retrieval with nucleo fuzzy ranking.

use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FuzzyCandidateInput {
    pub id: String,
    pub title: String,
    pub author: Option<String>,
    pub tags: Option<String>,
    pub format: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FuzzyMatchResult {
    pub id: String,
    pub score: u32,
    pub title_indices: Vec<u32>,
    pub author_indices: Vec<u32>,
}

/// Matches a single string against a query pattern, returning score and matched UTF-32 char indices.
pub fn match_string(
    matcher: &mut Matcher,
    pattern: &Pattern,
    haystack: &str,
    indices: &mut Vec<u32>,
) -> Option<u32> {
    indices.clear();
    let mut buf: Vec<char> = Vec::new();
    let utf32 = Utf32Str::new(haystack, &mut buf);
    pattern.score(utf32, matcher).inspect(|_| {
        // Collect indices of matched characters
        let mut char_indices = Vec::new();
        pattern.indices(utf32, matcher, &mut char_indices);
        *indices = char_indices;
    })
}

/// Ranks a batch of candidate items using nucleo-matcher SIMD scoring and extracts exact match indices.
pub fn rank_candidates(
    candidates: &[FuzzyCandidateInput],
    query: &str,
    limit: usize,
) -> Vec<FuzzyMatchResult> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return candidates
            .iter()
            .take(limit)
            .map(|c| FuzzyMatchResult {
                id: c.id.clone(),
                score: 0,
                title_indices: Vec::new(),
                author_indices: Vec::new(),
            })
            .collect();
    }

    let pattern = Pattern::parse(trimmed, CaseMatching::Ignore, Normalization::Smart);
    let mut matcher = Matcher::new(Config::DEFAULT);

    let mut results: Vec<FuzzyMatchResult> = Vec::with_capacity(candidates.len());
    let mut title_buf: Vec<char> = Vec::new();
    let mut author_buf: Vec<char> = Vec::new();

    for candidate in candidates {
        let mut title_indices = Vec::new();
        let mut author_indices = Vec::new();

        title_buf.clear();
        let title_utf32 = Utf32Str::new(&candidate.title, &mut title_buf);
        let title_score = pattern.score(title_utf32, &mut matcher);
        if title_score.is_some() {
            pattern.indices(title_utf32, &mut matcher, &mut title_indices);
        }

        let mut author_score = None;
        if let Some(ref author) = candidate.author {
            author_buf.clear();
            let author_utf32 = Utf32Str::new(author, &mut author_buf);
            author_score = pattern.score(author_utf32, &mut matcher);
            if author_score.is_some() {
                pattern.indices(author_utf32, &mut matcher, &mut author_indices);
            }
        }

        let total_score = match (title_score, author_score) {
            (Some(t), Some(a)) => t.max(a) + (t.min(a) / 4),
            (Some(t), None) => t,
            (None, Some(a)) => a,
            (None, None) => 0,
        };

        if total_score > 0 {
            results.push(FuzzyMatchResult {
                id: candidate.id.clone(),
                score: total_score,
                title_indices,
                author_indices,
            });
        }
    }

    results.sort_by_key(|r| std::cmp::Reverse(r.score));
    results.truncate(limit);
    results
}

use tauri::AppHandle;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TwoTierSearchResult {
    pub book_id: String,
    pub title: String,
    pub author: Option<String>,
    pub score: u32,
    pub title_indices: Vec<u32>,
    pub author_indices: Vec<u32>,
}

#[tauri::command]
pub async fn fuzzy_rank_candidates(
    candidates: Vec<FuzzyCandidateInput>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<FuzzyMatchResult>, String> {
    tokio::task::spawn_blocking(move || {
        Ok(rank_candidates(&candidates, &query, limit.unwrap_or(50)))
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?
}

#[tauri::command]
pub async fn two_tier_search_books(
    app: AppHandle,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<TwoTierSearchResult>, String> {
    tokio::task::spawn_blocking(move || {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }

        // Tier 1: FTS5 Candidate Retrieval from SQLite Disk
        let candidates = crate::database::with_connection(&app, |conn| {
            let terms: Vec<&str> = trimmed.split_whitespace().collect();
            let mut candidates: Vec<(String, String, Option<String>)> = Vec::new();

            // Construct prefix-matched FTS5 query terms
            let fts_match: String = terms
                .iter()
                .map(|t| {
                    let cleaned: String = t
                        .chars()
                        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
                        .collect();
                    if cleaned.is_empty() {
                        String::new()
                    } else {
                        format!("\"{}\"*", cleaned)
                    }
                })
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ");

            if !fts_match.is_empty() {
                if let Ok(mut stmt) = conn.prepare(
                    "SELECT id, title, author FROM books_fts WHERE books_fts MATCH ?1 LIMIT 250",
                ) {
                    if let Ok(rows) = stmt.query_map(rusqlite::params![&fts_match], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    }) {
                        for r in rows.flatten() {
                            candidates.push(r);
                        }
                    }
                }
            }

            // If FTS retrieved fewer candidates (e.g. typos, short prefix),
            // retrieve up to 300 candidates from books_fts so nucleo-matcher
            // can execute Tier 2 fuzzy typo recovery
            if candidates.len() < 30 {
                if let Ok(mut stmt) =
                    conn.prepare("SELECT id, title, author FROM books_fts LIMIT 300")
                {
                    if let Ok(rows) = stmt.query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    }) {
                        let existing: std::collections::HashSet<String> =
                            candidates.iter().map(|c| c.0.clone()).collect();
                        for r in rows.flatten() {
                            if !existing.contains(&r.0) {
                                candidates.push(r);
                            }
                        }
                    }
                }
            }

            Ok(candidates)
        })?;

        // Tier 2: SIMD nucleo-matcher ranking and UTF-32 character index extraction
        let pattern = Pattern::parse(trimmed, CaseMatching::Ignore, Normalization::Smart);
        let mut matcher = Matcher::new(Config::DEFAULT);

        let mut results = Vec::with_capacity(candidates.len());
        let mut title_buf: Vec<char> = Vec::new();
        let mut author_buf: Vec<char> = Vec::new();

        for (book_id, title, author) in candidates {
            let mut title_indices = Vec::new();
            let mut author_indices = Vec::new();

            title_buf.clear();
            let title_utf32 = Utf32Str::new(&title, &mut title_buf);
            let title_score = pattern.score(title_utf32, &mut matcher);
            if title_score.is_some() {
                pattern.indices(title_utf32, &mut matcher, &mut title_indices);
            }

            let mut author_score = None;
            if let Some(ref auth) = author {
                author_buf.clear();
                let author_utf32 = Utf32Str::new(auth, &mut author_buf);
                author_score = pattern.score(author_utf32, &mut matcher);
                if author_score.is_some() {
                    pattern.indices(author_utf32, &mut matcher, &mut author_indices);
                }
            }

            let total_score = match (title_score, author_score) {
                (Some(t), Some(a)) => t.max(a) + (t.min(a) / 4),
                (Some(t), None) => t,
                (None, Some(a)) => a,
                (None, None) => 0,
            };

            if total_score > 0 {
                results.push(TwoTierSearchResult {
                    book_id,
                    title,
                    author,
                    score: total_score,
                    title_indices,
                    author_indices,
                });
            }
        }

        results.sort_by_key(|r| std::cmp::Reverse(r.score));
        results.truncate(limit.unwrap_or(50));
        Ok(results)
    })
    .await
    .map_err(|e| format!("Search task error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_nucleo_fuzzy_ranking() {
        let candidates = vec![
            FuzzyCandidateInput {
                id: "1".to_string(),
                title: "Dune".to_string(),
                author: Some("Frank Herbert".to_string()),
                tags: None,
                format: None,
            },
            FuzzyCandidateInput {
                id: "2".to_string(),
                title: "Dune Messiah".to_string(),
                author: Some("Frank Herbert".to_string()),
                tags: None,
                format: None,
            },
            FuzzyCandidateInput {
                id: "3".to_string(),
                title: "The Hobbit".to_string(),
                author: Some("J.R.R. Tolkien".to_string()),
                tags: None,
                format: None,
            },
        ];

        let results = rank_candidates(&candidates, "dune", 10);
        assert_eq!(results.len(), 2);
        assert!(results[0].score > 0);
        assert!(!results[0].title_indices.is_empty());
    }

    #[test]
    fn test_nucleo_acronym_matching() {
        let candidates = vec![FuzzyCandidateInput {
            id: "1".to_string(),
            title: "The Lord of the Rings".to_string(),
            author: Some("J.R.R. Tolkien".to_string()),
            tags: None,
            format: None,
        }];

        let results = rank_candidates(&candidates, "lotr", 10);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title_indices.len(), 4); // L, o, t, R
    }
}
