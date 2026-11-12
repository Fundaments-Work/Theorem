//! SIMD-accelerated fuzzy matcher engine powered by nucleo-matcher (Helix editor).
//!
//! Provides:
//! - Tier 2 SIMD Smith-Waterman fuzzy scoring and exact character match index extraction.
//! - In-memory typeahead (<0.05ms) for command palette, tags, shelves, and table-of-contents.
//! - Integrated Two-Tier hybrid search combining SQLite FTS5 disk retrieval with nucleo fuzzy ranking.

use nucleo_matcher::pattern::{Atom, AtomKind, CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FuzzyCandidateInput {
    pub id: Box<str>,
    pub title: Box<str>,
    pub author: Option<Box<str>>,
    pub tags: Option<Box<str>>,
    pub format: Option<Box<str>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FuzzyMatchResult {
    pub id: Box<str>,
    pub score: u32,
    pub title_indices: Box<[u32]>,
    pub author_indices: Box<[u32]>,
}

/// Reusable scratch buffers to eliminate per-candidate `Vec<char>` allocations.
#[derive(Default)]
pub struct FuzzyScratch {
    utf32_buf: Vec<char>,
    author_buf: Vec<char>,
    found_indices: Vec<u32>,
}

/// Matches a single string against a query pattern, returning score and matched UTF-32 char indices.
pub fn match_string(
    matcher: &mut Matcher,
    pattern: &Pattern,
    haystack: &str,
    indices: &mut Vec<u32>,
) -> Option<u32> {
    thread_local! {
        static SCRATCH: std::cell::RefCell<FuzzyScratch> =
            std::cell::RefCell::new(FuzzyScratch::default());
    }
    SCRATCH.with(|cell| {
        let mut scratch = cell.borrow_mut();
        match_string_with_scratch(matcher, pattern, haystack, indices, &mut scratch)
    })
}

/// Matches a single string using a caller-supplied [`FuzzyScratch`] buffer.
pub fn match_string_with_scratch(
    matcher: &mut Matcher,
    pattern: &Pattern,
    haystack: &str,
    indices: &mut Vec<u32>,
    scratch: &mut FuzzyScratch,
) -> Option<u32> {
    indices.clear();
    scratch.utf32_buf.clear();
    let utf32 = Utf32Str::new(haystack, &mut scratch.utf32_buf);
    pattern.score(utf32, matcher).inspect(|_| {
        scratch.found_indices.clear();
        pattern.indices(utf32, matcher, &mut scratch.found_indices);
        indices.extend_from_slice(&scratch.found_indices);
    })
}

/// A fuzzy match may spread over at most this many times the word's length...
const MAX_SPAN_RATIO: f32 = 1.5;

/// ...unless every matched character starts a word ("lotr" in "The Lord of the
/// Rings"). Letters picked out of the middle of unrelated words ("character"
/// scattered across a long title) are not a match: they looked random.
fn is_meaningful_match(haystack: &[char], indices: &[u32], needle_len: usize) -> bool {
    let (Some(&first), Some(&last)) = (indices.first(), indices.last()) else {
        return false;
    };
    let span = (last - first + 1) as f32;
    if span <= needle_len.max(1) as f32 * MAX_SPAN_RATIO {
        return true;
    }
    // Split into runs of consecutive characters; each run must begin a word
    // ("Lo"rd "t"he "R"ings for "lotr").
    let word_start = |i: u32| {
        let i = i as usize;
        i == 0 || !haystack.get(i - 1).is_some_and(|c| c.is_alphanumeric())
    };
    indices
        .iter()
        .enumerate()
        .all(|(k, &i)| (k > 0 && indices[k - 1] + 1 == i) || word_start(i))
}

/// One atom per query word; case-insensitive, accent-insensitive fuzzy.
fn query_atoms(query: &str) -> Vec<(Atom, usize)> {
    query
        .split_whitespace()
        .map(|word| {
            (
                Atom::new(
                    word,
                    CaseMatching::Ignore,
                    Normalization::Smart,
                    AtomKind::Fuzzy,
                    false,
                ),
                word.chars().count(),
            )
        })
        .collect()
}

/// Score of one field for one word, pushing its match indices; `None` if the
/// word does not match the field meaningfully.
fn score_word(
    atom: &Atom,
    needle_len: usize,
    field: &[char],
    matcher: &mut Matcher,
    indices: &mut Vec<u32>,
    found: &mut Vec<u32>,
) -> Option<u32> {
    found.clear();
    let score = atom.indices(Utf32Str::Unicode(field), matcher, found)?;
    found.sort_unstable();
    if !is_meaningful_match(field, found, needle_len) {
        return None;
    }
    indices.extend(found.iter().copied());
    Some(u32::from(score))
}

struct BookScore {
    score: u32,
    title_indices: Box<[u32]>,
    author_indices: Box<[u32]>,
}

/// Every query word must match the title or the author meaningfully. Returns
/// the total score and the (sorted, deduplicated) title and author indices.
fn score_book(
    atoms: &[(Atom, usize)],
    title: &str,
    author: Option<&str>,
    matcher: &mut Matcher,
    scratch: &mut FuzzyScratch,
) -> Option<BookScore> {
    scratch.utf32_buf.clear();
    scratch.utf32_buf.extend(title.chars());
    scratch.author_buf.clear();
    if let Some(a) = author {
        scratch.author_buf.extend(a.chars());
    }
    let mut title_indices = Vec::new();
    let mut author_indices = Vec::new();
    let mut total = 0u32;
    for (atom, len) in atoms {
        let t = score_word(
            atom,
            *len,
            &scratch.utf32_buf,
            matcher,
            &mut title_indices,
            &mut scratch.found_indices,
        );
        let a = score_word(
            atom,
            *len,
            &scratch.author_buf,
            matcher,
            &mut author_indices,
            &mut scratch.found_indices,
        );
        total += match (t, a) {
            (Some(t), Some(a)) => t.max(a) + t.min(a) / 4,
            (Some(s), None) | (None, Some(s)) => s,
            (None, None) => return None,
        };
    }
    for indices in [&mut title_indices, &mut author_indices] {
        indices.sort_unstable();
        indices.dedup();
    }
    (total > 0).then(|| BookScore {
        score: total,
        title_indices: title_indices.into_boxed_slice(),
        author_indices: author_indices.into_boxed_slice(),
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
                title_indices: Box::new([]),
                author_indices: Box::new([]),
            })
            .collect();
    }

    let atoms = query_atoms(trimmed);
    let mut matcher = Matcher::new(Config::DEFAULT);
    let mut scratch = FuzzyScratch::default();
    let mut results: Vec<FuzzyMatchResult> = candidates
        .iter()
        .filter_map(|c| {
            let hit = score_book(
                &atoms,
                &c.title,
                c.author.as_deref(),
                &mut matcher,
                &mut scratch,
            )?;
            Some(FuzzyMatchResult {
                id: c.id.clone(),
                score: hit.score,
                title_indices: hit.title_indices,
                author_indices: hit.author_indices,
            })
        })
        .collect();

    results.sort_by_key(|r| std::cmp::Reverse(r.score));
    results.truncate(limit);
    results
}

use tauri::AppHandle;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TwoTierSearchResult {
    pub book_id: Box<str>,
    pub title: Box<str>,
    pub author: Option<Box<str>>,
    pub score: u32,
    pub title_indices: Box<[u32]>,
    pub author_indices: Box<[u32]>,
}

#[tauri::command]
pub async fn fuzzy_rank_candidates(
    candidates: Vec<FuzzyCandidateInput>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<FuzzyMatchResult>, crate::error::AppError> {
    tokio::task::spawn_blocking(move || {
        Ok(rank_candidates(&candidates, &query, limit.unwrap_or(50)))
    })
    .await
    .map_err(|e| crate::error::AppError::internal(format!("Join error: {e}")))?
}

#[tauri::command]
pub async fn two_tier_search_books(
    app: AppHandle,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<TwoTierSearchResult>, crate::error::AppError> {
    tokio::task::spawn_blocking(move || {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }

        // Tier 1: FTS5 Candidate Retrieval from SQLite Disk
        let candidates = crate::database::with_connection(&app, |conn| {
            type FtsCandidate = (Box<str>, Box<str>, Option<Box<str>>);
            let terms: Vec<&str> = trimmed.split_whitespace().collect();
            let mut candidates: Vec<FtsCandidate> = Vec::new();

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
                            row.get::<_, String>(0)?.into_boxed_str(),
                            row.get::<_, String>(1)?.into_boxed_str(),
                            row.get::<_, Option<String>>(2)?.map(String::into_boxed_str),
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
                            row.get::<_, String>(0)?.into_boxed_str(),
                            row.get::<_, String>(1)?.into_boxed_str(),
                            row.get::<_, Option<String>>(2)?.map(String::into_boxed_str),
                        ))
                    }) {
                        let existing: std::collections::HashSet<Box<str>> =
                            candidates.iter().map(|c| c.0.clone()).collect();
                        for r in rows.flatten() {
                            if !existing.contains(r.0.as_ref()) {
                                candidates.push(r);
                            }
                        }
                    }
                }
            }

            Ok(candidates)
        })?;

        // Tier 2: nucleo ranking. Typo-recovery candidates (the fallback scan
        // above) only survive a meaningful match; see `is_meaningful_match`.
        let atoms = query_atoms(trimmed);
        let mut matcher = Matcher::new(Config::DEFAULT);
        let mut scratch = FuzzyScratch::default();
        let mut results: Vec<TwoTierSearchResult> = candidates
            .into_iter()
            .filter_map(|(book_id, title, author)| {
                let hit = score_book(
                    &atoms,
                    &title,
                    author.as_deref(),
                    &mut matcher,
                    &mut scratch,
                )?;
                Some(TwoTierSearchResult {
                    book_id,
                    title,
                    author,
                    score: hit.score,
                    title_indices: hit.title_indices,
                    author_indices: hit.author_indices,
                })
            })
            .collect();

        results.sort_by_key(|r| std::cmp::Reverse(r.score));
        results.truncate(limit.unwrap_or(50));
        Ok(results)
    })
    .await
    .map_err(|e| crate::error::AppError::internal(format!("Search task error: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_nucleo_fuzzy_ranking() {
        let candidates = vec![
            FuzzyCandidateInput {
                id: "1".into(),
                title: "Dune".into(),
                author: Some("Frank Herbert".into()),
                tags: None,
                format: None,
            },
            FuzzyCandidateInput {
                id: "2".into(),
                title: "Dune Messiah".into(),
                author: Some("Frank Herbert".into()),
                tags: None,
                format: None,
            },
            FuzzyCandidateInput {
                id: "3".into(),
                title: "The Hobbit".into(),
                author: Some("J.R.R. Tolkien".into()),
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
            id: "1".into(),
            title: "The Lord of the Rings".into(),
            author: Some("J.R.R. Tolkien".into()),
            tags: None,
            format: None,
        }];

        let results = rank_candidates(&candidates, "lotr", 10);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title_indices.len(), 4); // L, o, t, R
    }

    fn book(id: &str, title: &str, author: &str) -> FuzzyCandidateInput {
        FuzzyCandidateInput {
            id: id.into(),
            title: title.into(),
            author: Some(author.into()),
            tags: None,
            format: None,
        }
    }

    #[test]
    fn scattered_letters_are_not_a_match() {
        // Every letter of "character" occurs in order in these titles, spread
        // over unrelated words: the old ranking listed them as results.
        let candidates = vec![
            book(
                "1",
                "Clash of the Hackers: A Rational Account of Cybercrime Techniques",
                "Anon",
            ),
            book(
                "2",
                "The Complete Home Garden Reader: Actual Care Techniques",
                "Various",
            ),
            book("3", "Character and Culture", "Ann Smith"),
            book("4", "Characters in Fiction", "Jane Roe"),
        ];
        let results = rank_candidates(&candidates, "character", 10);
        let ids: Vec<&str> = results.iter().map(|r| &*r.id).collect();
        assert_eq!(ids.len(), 2, "{ids:?}");
        assert!(ids.contains(&"3") && ids.contains(&"4"), "{ids:?}");

        // A query with a missing letter still finds the compact match.
        let typo = rank_candidates(&candidates, "charcter", 10);
        let ids: Vec<&str> = typo.iter().map(|r| &*r.id).collect();
        assert!(ids.contains(&"3") && ids.contains(&"4"), "{ids:?}");
        assert!(!ids.contains(&"1") && !ids.contains(&"2"), "{ids:?}");
    }

    #[test]
    fn every_word_must_match_title_or_author() {
        let candidates = vec![
            book("1", "The Hobbit", "J.R.R. Tolkien"),
            book("2", "The Hobbit Companion", "David Day"),
        ];
        let results = rank_candidates(&candidates, "hobbit tolkien", 10);
        assert_eq!(results.len(), 1);
        assert_eq!(&*results[0].id, "1");
        assert!(!results[0].title_indices.is_empty());
        assert!(!results[0].author_indices.is_empty());
        assert!(rank_candidates(&candidates, "zzz", 10).is_empty());
        assert!(rank_candidates(&[], "hobbit", 10).is_empty());
    }

    #[test]
    fn meaningful_match_rules() {
        let chars: Vec<char> = "The Lord of the Rings".chars().collect();
        assert!(is_meaningful_match(&chars, &[4, 5, 6, 7], 4)); // "Lord" compact
        assert!(is_meaningful_match(&chars, &[4, 9, 12, 16], 4)); // l-o-t-r word starts
        assert!(is_meaningful_match(&chars, &[4, 5, 12, 16], 4)); // "Lo"rd-t-R runs
        assert!(!is_meaningful_match(&chars, &[1, 9, 13, 17], 4)); // mid-word scatter
        assert!(!is_meaningful_match(&chars, &[], 4));
    }
}
