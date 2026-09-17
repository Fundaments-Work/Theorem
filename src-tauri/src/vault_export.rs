//! Rayon-accelerated single-shot Obsidian Markdown & Lemma SRS flashcard exporter.
//!
//! Replaces dozens/hundreds of sequential webview IPC `writeTextFile` calls with
//! a single native Rust batch write using multi-threaded Rayon parallelism (<5ms total).

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

const DEFAULT_HIGHLIGHTS_FOLDER_NAME: &str = "Books";
const DEFAULT_VOCABULARY_FILE_NAME: &str = "Vocabulary.md";
const MAX_BOOK_PAGE_FILE_NAME_LENGTH: usize = 180;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultBook {
    pub id: String,
    pub title: String,
    pub author: Option<String>,
    pub format: Option<String>,
    pub file_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultAnnotation {
    pub id: String,
    pub book_id: String,
    pub r#type: String, // "highlight" | "note"
    pub selected_text: Option<String>,
    pub note_content: Option<String>,
    pub color: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultVocabularyMeaning {
    pub part_of_speech: Option<String>,
    pub definitions: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultVocabularyTerm {
    pub id: String,
    pub term: String,
    pub language: Option<String>,
    pub phonetic: Option<String>,
    pub meanings: Option<Vec<VaultVocabularyMeaning>>,
    pub contexts: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultRssArticle {
    pub id: String,
    pub title: String,
    pub author: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultExportPayload {
    pub vault_path: String,
    pub highlights_folder: Option<String>,
    pub vocabulary_file_name: Option<String>,
    pub books: Vec<VaultBook>,
    pub annotations: Vec<VaultAnnotation>,
    pub vocabulary_terms: Vec<VaultVocabularyTerm>,
    pub rss_articles: Option<Vec<VaultRssArticle>>,
    pub generated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultExportResult {
    pub status: String,
    pub message: String,
    pub files_written: usize,
    pub file_paths: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ExportSource {
    pub id: String,
    pub title: String,
    pub author: String,
    pub format: String,
    pub file_path: String,
}

fn to_yaml_string(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");
    format!("\"{escaped}\"")
}

fn normalize_file_segment(value: &str, fallback: &str) -> String {
    let single_line = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned: String = single_line
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() {
                '-'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim_end_matches('.').trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn to_short_hash(input: &str) -> String {
    let mut hash: u32 = 2166136261;
    for byte in input.bytes() {
        hash ^= byte as u32;
        hash = hash.wrapping_mul(16777619);
    }
    format!("{:x}", hash)
}

fn truncate_segment(value: &str, max_len: usize) -> &str {
    if value.len() <= max_len {
        value
    } else {
        let mut end = max_len;
        while end > 0 && !value.is_char_boundary(end) {
            end -= 1;
        }
        value[..end].trim()
    }
}

fn clamp_file_name_length(file_name: &str, max_len: usize) -> String {
    if file_name.len() <= max_len {
        return file_name.to_string();
    }
    let ext = ".md";
    let without_ext = file_name.strip_suffix(ext).unwrap_or(file_name);
    let allowed_base = max_len.saturating_sub(ext.len()).max(8);
    let mut end = allowed_base;
    while end > 0 && !without_ext.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{ext}", without_ext[..end].trim())
}

fn build_export_source(
    book_id: &str,
    books_by_id: &HashMap<String, &VaultBook>,
    rss_by_id: &HashMap<String, &VaultRssArticle>,
) -> ExportSource {
    let rss_article_id = if let Some(stripped) = book_id.strip_prefix("rss:") {
        stripped.trim()
    } else {
        ""
    };
    let rss_article = if !rss_article_id.is_empty() {
        rss_by_id.get(rss_article_id).copied()
    } else {
        None
    };

    if let Some(book) = books_by_id.get(book_id) {
        let default_title = if book.title.trim().is_empty() {
            "Untitled Source"
        } else {
            book.title.trim()
        };
        let fallback_title = rss_article.map_or(default_title, |a| a.title.trim());
        let is_synthetic =
            default_title == book_id || default_title.to_lowercase().starts_with("rss article");
        let title = if is_synthetic {
            fallback_title
        } else {
            default_title
        };

        let author = rss_article
            .and_then(|a| a.author.as_deref())
            .or(book.author.as_deref())
            .unwrap_or("Unknown Author")
            .trim();

        let file_path = rss_article
            .and_then(|a| a.url.as_deref())
            .or(book.file_path.as_deref())
            .unwrap_or("")
            .trim();

        return ExportSource {
            id: book.id.clone(),
            title: title.to_string(),
            author: author.to_string(),
            format: book.format.clone().unwrap_or_else(|| "epub".to_string()),
            file_path: file_path.to_string(),
        };
    }

    if let Some(art) = rss_article {
        return ExportSource {
            id: book_id.to_string(),
            title: if art.title.trim().is_empty() {
                "RSS Article".to_string()
            } else {
                art.title.trim().to_string()
            },
            author: art
                .author
                .as_deref()
                .unwrap_or("Unknown Author")
                .to_string(),
            format: "rss".to_string(),
            file_path: art.url.as_deref().unwrap_or("").to_string(),
        };
    }

    ExportSource {
        id: book_id.to_string(),
        title: "Untitled Document".to_string(),
        author: "Unknown Author".to_string(),
        format: "unknown".to_string(),
        file_path: String::new(),
    }
}

fn build_unique_file_name(source: &ExportSource, used_names: &mut HashSet<String>) -> String {
    let norm_title = normalize_file_segment(&source.title, "Untitled Source");
    let safe_title = truncate_segment(&norm_title, 80);
    let norm_author = normalize_file_segment(&source.author, "Unknown Author");
    let safe_author = truncate_segment(&norm_author, 48);
    let id_seed = normalize_file_segment(&source.id, "source");
    let short_id = to_short_hash(&format!("{id_seed}:{safe_title}:{safe_author}"));
    let base = format!("{safe_title} - {safe_author} ({short_id})");
    let mut candidate =
        clamp_file_name_length(&format!("{base}.md"), MAX_BOOK_PAGE_FILE_NAME_LENGTH);
    let mut idx = 2;

    while used_names.contains(&candidate.to_lowercase()) {
        candidate =
            clamp_file_name_length(&format!("{base} {idx}.md"), MAX_BOOK_PAGE_FILE_NAME_LENGTH);
        idx += 1;
    }

    used_names.insert(candidate.to_lowercase());
    candidate
}

pub fn build_book_page_markdown(
    source: &ExportSource,
    annotations: &[VaultAnnotation],
    generated_at: &str,
) -> String {
    let mut sorted = annotations.to_vec();
    sorted.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });

    let highlights_count = sorted.iter().filter(|a| a.r#type == "highlight").count();
    let notes_count = sorted.iter().filter(|a| a.r#type == "note").count();

    let mut lines = Vec::with_capacity(sorted.len() * 8 + 20);
    lines.push("---".to_string());
    lines.push(format!("title: {}", to_yaml_string(&source.title)));
    lines.push("type: \"theorem-book-highlights\"".to_string());
    lines.push(format!("author: {}", to_yaml_string(&source.author)));
    lines.push(format!("format: {}", to_yaml_string(&source.format)));
    lines.push(format!(
        "source_path: {}",
        to_yaml_string(&source.file_path)
    ));
    lines.push(format!("generated_at: {}", to_yaml_string(generated_at)));
    lines.push(format!("annotations_total: {}", sorted.len()));
    lines.push(format!("highlights_total: {highlights_count}"));
    lines.push(format!("notes_total: {notes_count}"));
    lines.push("tags:".to_string());
    lines.push("  - theorem".to_string());
    lines.push("  - highlights".to_string());
    lines.push("  - notes".to_string());
    lines.push("---".to_string());
    lines.push(String::new());
    lines.push(format!("# {}", source.title));

    if !source.author.is_empty() && source.author != "Unknown Author" {
        lines.push(format!("*{}*", source.author));
    }

    lines.push(String::new());
    lines.push(format!("- Format: {}", source.format));
    lines.push(format!("- Exported at: {generated_at}"));
    lines.push(String::new());
    lines.push("## Highlights and Notes".to_string());
    lines.push(String::new());

    if sorted.is_empty() {
        lines.push("_No highlights or notes yet._".to_string());
        lines.push(String::new());
        return lines.join("\n");
    }

    for (idx, anno) in sorted.iter().enumerate() {
        let kind = if anno.r#type == "note" {
            "Note"
        } else {
            "Highlight"
        };
        let color = anno.color.as_deref().unwrap_or("yellow");

        lines.push(format!("### {}. {kind}", idx + 1));
        lines.push(format!("- Created: {}", anno.created_at));
        if let Some(ref upd) = anno.updated_at {
            lines.push(format!("- Updated: {upd}"));
        }
        lines.push(format!("- Color: {color}"));
        lines.push(String::new());

        if let Some(ref quote) = anno.selected_text {
            let clean_quote = quote.trim();
            if !clean_quote.is_empty() {
                for qline in clean_quote.lines() {
                    if qline.trim().is_empty() {
                        lines.push(">".to_string());
                    } else {
                        lines.push(format!("> =={}==", qline.trim()));
                    }
                }
                lines.push(String::new());
            }
        }

        if let Some(ref note) = anno.note_content {
            let clean_note = note.trim();
            if !clean_note.is_empty() {
                lines.push(clean_note.to_string());
                lines.push(String::new());
            }
        }

        lines.push("---".to_string());
        lines.push(String::new());
    }

    lines.join("\n")
}

pub fn build_vocabulary_markdown(terms: &[VaultVocabularyTerm], generated_at: &str) -> String {
    let mut sorted = terms.to_vec();
    sorted.sort_by(|a, b| a.term.cmp(&b.term));

    let mut languages: Vec<String> = sorted
        .iter()
        .filter_map(|t| t.language.as_deref().map(|l| l.trim().to_string()))
        .filter(|l| !l.is_empty())
        .collect();
    languages.sort();
    languages.dedup();

    let mut lines = Vec::with_capacity(sorted.len() * 10 + 25);
    lines.push("---".to_string());
    lines.push("title: \"Theorem Vocabulary\"".to_string());
    lines.push("type: \"theorem-vocabulary\"".to_string());
    lines.push(format!("generated_at: {}", to_yaml_string(generated_at)));
    lines.push(format!("terms_total: {}", sorted.len()));
    lines.push("languages:".to_string());
    if languages.is_empty() {
        lines.push("  - \"unknown\"".to_string());
    } else {
        for lang in &languages {
            lines.push(format!("  - {}", to_yaml_string(lang)));
        }
    }
    lines.push("tags:".to_string());
    lines.push("  - flashcards".to_string());
    lines.push("  - theorem".to_string());
    lines.push("  - vocabulary".to_string());
    lines.push("---".to_string());
    lines.push(String::new());
    lines.push("# Theorem Vocabulary".to_string());
    lines.push(String::new());
    lines.push(format!("- Exported at: {generated_at}"));
    lines.push(format!("- Terms: {}", sorted.len()));
    lines.push(String::new());

    if sorted.is_empty() {
        lines.push("_No vocabulary terms available._".to_string());
        lines.push(String::new());
        return lines.join("\n");
    }

    for term in &sorted {
        let safe_id: String = term
            .id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect();
        let block_id = if safe_id.is_empty() {
            format!("^fsrs-vocab-{}", to_short_hash(&term.term))
        } else {
            format!("^fsrs-vocab-{safe_id}")
        };

        let phonetic_str = term
            .phonetic
            .as_deref()
            .map(|p| format!(" *[/{}/]*", p.trim()))
            .unwrap_or_default();
        let context_quote = term
            .contexts
            .as_ref()
            .and_then(|c| c.first())
            .map(|c| c.trim())
            .unwrap_or("");

        lines.push("---card---".to_string());
        lines.push(format!("### {}{phonetic_str} {block_id}", term.term));
        if !context_quote.is_empty() {
            lines.push(format!("> \"{context_quote}\""));
        }
        lines.push("---".to_string());

        let mut def_index = 1;
        if let Some(ref meanings) = term.meanings {
            for m in meanings {
                let pos_prefix = m
                    .part_of_speech
                    .as_deref()
                    .map(|p| format!("**{p}**: "))
                    .unwrap_or_default();
                for def in &m.definitions {
                    let clean_def = def.trim();
                    if !clean_def.is_empty() {
                        lines.push(format!("{def_index}. {pos_prefix}{clean_def}"));
                        def_index += 1;
                    }
                }
            }
        }
        lines.push(String::new());
    }

    lines.join("\n")
}

/// Single-shot Rayon multi-threaded export to local vault directory.
pub fn export_vault_snapshot_impl(
    payload: &VaultExportPayload,
) -> Result<VaultExportResult, String> {
    let vault_path = Path::new(&payload.vault_path);
    if !vault_path.exists() {
        fs::create_dir_all(vault_path)
            .map_err(|e| format!("Failed to create vault directory: {e}"))?;
    }

    let theorem_dir = vault_path.join("Theorem");
    let highlights_dir_name = payload
        .highlights_folder
        .as_deref()
        .unwrap_or(DEFAULT_HIGHLIGHTS_FOLDER_NAME);
    let pages_dir = theorem_dir.join(highlights_dir_name);
    let vocab_file_name = payload
        .vocabulary_file_name
        .as_deref()
        .unwrap_or(DEFAULT_VOCABULARY_FILE_NAME);
    let vocab_path = theorem_dir.join(vocab_file_name);

    fs::create_dir_all(&pages_dir).map_err(|e| format!("Failed to create pages directory: {e}"))?;

    let generated_at = payload
        .generated_at
        .clone()
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

    let books_by_id: HashMap<String, &VaultBook> =
        payload.books.iter().map(|b| (b.id.clone(), b)).collect();
    let rss_by_id: HashMap<String, &VaultRssArticle> = payload
        .rss_articles
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|a| (a.id.clone(), a))
        .collect();

    // Group annotations by book_id
    let mut grouped_annotations: HashMap<String, Vec<VaultAnnotation>> = HashMap::new();
    for anno in &payload.annotations {
        if anno.r#type == "highlight" || anno.r#type == "note" {
            grouped_annotations
                .entry(anno.book_id.clone())
                .or_default()
                .push(anno.clone());
        }
    }

    // Build unique file paths
    let mut used_names = HashSet::new();
    let mut files_to_write: Vec<(PathBuf, String)> =
        Vec::with_capacity(grouped_annotations.len() + 1);

    for (book_id, annos) in &grouped_annotations {
        let source = build_export_source(book_id, &books_by_id, &rss_by_id);
        let file_name = build_unique_file_name(&source, &mut used_names);
        let abs_path = pages_dir.join(file_name);
        let content = build_book_page_markdown(&source, annos, &generated_at);
        files_to_write.push((abs_path, content));
    }

    // Vocabulary file
    let vocab_content = build_vocabulary_markdown(&payload.vocabulary_terms, &generated_at);
    files_to_write.push((vocab_path, vocab_content));

    // Parallel multi-threaded write using Rayon
    let write_errors: Vec<String> = files_to_write
        .par_iter()
        .filter_map(|(path, content)| {
            if let Err(e) = fs::write(path, content) {
                Some(format!("Failed to write {}: {e}", path.display()))
            } else {
                None
            }
        })
        .collect();

    if let Some(first_err) = write_errors.first() {
        return Err(first_err.clone());
    }

    let file_paths: Vec<String> = files_to_write
        .into_iter()
        .map(|(p, _)| p.to_string_lossy().to_string())
        .collect();

    let count = file_paths.len();
    Ok(VaultExportResult {
        status: "synced".to_string(),
        message: format!("Successfully exported {count} files to Obsidian vault."),
        files_written: count,
        file_paths,
    })
}

#[tauri::command]
pub async fn vault_export_snapshot(
    payload: VaultExportPayload,
) -> Result<VaultExportResult, String> {
    tokio::task::spawn_blocking(move || export_vault_snapshot_impl(&payload))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_to_yaml_string() {
        assert_eq!(to_yaml_string("Hello \"World\""), "\"Hello \\\"World\\\"\"");
    }

    #[test]
    fn test_build_vocabulary_markdown() {
        let terms = vec![VaultVocabularyTerm {
            id: "vocab-1".to_string(),
            term: "ephemeral".to_string(),
            language: Some("en".to_string()),
            phonetic: Some("ɪˈfɛmərəl".to_string()),
            meanings: Some(vec![VaultVocabularyMeaning {
                part_of_speech: Some("adjective".to_string()),
                definitions: vec!["Lasting for a very short time.".to_string()],
            }]),
            contexts: Some(vec!["Fame is ephemeral in this modern age.".to_string()]),
        }];

        let md = build_vocabulary_markdown(&terms, "2026-09-13T12:00:00Z");
        assert!(md.contains("### ephemeral"));
        assert!(md.contains("^fsrs-vocab-vocab-1"));
        assert!(md.contains("**adjective**: Lasting for a very short time."));
    }
}
