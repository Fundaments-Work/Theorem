//! SIMD-accelerated fuzzy matching and candidate ranking powered by nucleo-matcher.

use nucleo_matcher::pattern::{AtomKind, CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FuzzyCandidate {
    pub id: String,
    pub title: String,
    pub author: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FuzzyMatchResult {
    pub id: String,
    pub score: u32,
    pub title_indices: Vec<u32>,
    pub author_indices: Vec<u32>,
}

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
        let mut char_indices = Vec::new();
        pattern.indices(utf32, matcher, &mut char_indices);
        *indices = char_indices;
    })
}

const MAX_SPAN_RATIO: f32 = 1.5;

fn is_meaningful_match(haystack: &[char], indices: &[u32], needle_len: usize) -> bool {
    let (Some(&first), Some(&last)) = (indices.first(), indices.last()) else {
        return false;
    };
    let span = (last - first + 1) as f32;
    if span <= needle_len.max(1) as f32 * MAX_SPAN_RATIO {
        return true;
    }
    let word_start = |i: u32| {
        let i = i as usize;
        i == 0 || !haystack.get(i - 1).is_some_and(|c| c.is_alphanumeric())
    };
    indices
        .iter()
        .copied()
        .zip(indices.iter().copied().skip(1))
        .all(|(curr, next)| next == curr + 1 || word_start(next))
        && word_start(first)
}

pub fn score_field(
    matcher: &mut Matcher,
    pattern: &Pattern,
    field: &str,
    needle_len: usize,
    indices_out: &mut Vec<u32>,
) -> Option<u32> {
    let score = match_string(matcher, pattern, field, indices_out)?;
    if !indices_out.is_empty() {
        let chars: Vec<char> = field.chars().collect();
        if !is_meaningful_match(&chars, indices_out, needle_len) {
            indices_out.clear();
            return None;
        }
    }
    Some(score)
}

pub fn rank_candidates(candidates: &[FuzzyCandidate], query: &str) -> Vec<FuzzyMatchResult> {
    let q = query.trim();
    if q.is_empty() {
        return Vec::new();
    }

    let mut matcher = Matcher::new(Config::DEFAULT);
    let words: Vec<&str> = q.split_whitespace().collect();
    if words.is_empty() {
        return Vec::new();
    }

    let patterns: Vec<Pattern> = words
        .iter()
        .map(|w| {
            Pattern::new(
                w,
                CaseMatching::Ignore,
                Normalization::Smart,
                AtomKind::Fuzzy,
            )
        })
        .collect();

    let mut results = Vec::new();
    let mut title_indices_buf = Vec::new();
    let mut author_indices_buf = Vec::new();
    let mut word_indices = Vec::new();

    for candidate in candidates {
        let mut total_score = 0u32;
        let mut all_words_matched = true;
        title_indices_buf.clear();
        author_indices_buf.clear();

        for (pattern, &word) in patterns.iter().zip(words.iter()) {
            let needle_len = word.chars().count();
            let mut word_matched = false;
            let mut best_word_score = 0u32;

            if let Some(s) = score_field(
                &mut matcher,
                pattern,
                &candidate.title,
                needle_len,
                &mut word_indices,
            ) {
                best_word_score = best_word_score.max(s * 2);
                title_indices_buf.extend_from_slice(&word_indices);
                word_matched = true;
            }

            if let Some(author) = &candidate.author {
                if let Some(s) =
                    score_field(&mut matcher, pattern, author, needle_len, &mut word_indices)
                {
                    best_word_score = best_word_score.max(s);
                    author_indices_buf.extend_from_slice(&word_indices);
                    word_matched = true;
                }
            }

            if !word_matched {
                all_words_matched = false;
                break;
            }

            total_score += best_word_score;
        }

        if all_words_matched {
            title_indices_buf.sort_unstable();
            title_indices_buf.dedup();
            author_indices_buf.sort_unstable();
            author_indices_buf.dedup();

            results.push(FuzzyMatchResult {
                id: candidate.id.clone(),
                score: total_score,
                title_indices: title_indices_buf.clone(),
                author_indices: author_indices_buf.clone(),
            });
        }
    }

    results.sort_by(|a, b| b.score.cmp(&a.score));
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fuzzy_matching_and_ranking() {
        let candidates = vec![
            FuzzyCandidate {
                id: "1".into(),
                title: "The Lord of the Rings".into(),
                author: Some("J.R.R. Tolkien".into()),
            },
            FuzzyCandidate {
                id: "2".into(),
                title: "Dune".into(),
                author: Some("Frank Herbert".into()),
            },
        ];

        let res = rank_candidates(&candidates, "lotr");
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].id, "1");

        let res_dune = rank_candidates(&candidates, "dune");
        assert_eq!(res_dune.len(), 1);
        assert_eq!(res_dune[0].id, "2");
    }
}
