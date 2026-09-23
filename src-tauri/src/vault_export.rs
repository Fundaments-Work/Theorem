//! Rayon-accelerated single-shot Obsidian Markdown & Lemma SRS flashcard exporter.
//!
//! Replaces dozens/hundreds of sequential webview IPC `writeTextFile` calls with
//! a single native Rust batch write using multi-threaded Rayon parallelism (<5ms total).

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum VaultExportPreset {
    #[default]
    Obsidian,
    Logseq,
    Minimalist,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultExportPayload {
    pub vault_path: String,
    pub highlights_folder: Option<String>,
    pub vocabulary_file_name: Option<String>,
    pub export_preset: Option<String>,
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
    _generated_at: &str,
    preset: VaultExportPreset,
) -> String {
    let mut sorted = annotations.to_vec();
    sorted.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });

    let mut lines = Vec::with_capacity(sorted.len() * 4 + 16);
    lines.push("---".to_string());
    lines.push(format!("title: {}", to_yaml_string(&source.title)));
    lines.push("type: \"theorem-book-highlights\"".to_string());
    lines.push(format!("author: {}", to_yaml_string(&source.author)));
    lines.push(format!("total_highlights: {}", sorted.len()));
    lines.push("tags:".to_string());
    lines.push("  - theorem".to_string());
    lines.push("  - highlights".to_string());
    lines.push("---".to_string());
    lines.push(String::new());
    lines.push(format!("# {}", source.title));

    if !source.author.is_empty() && source.author != "Unknown Author" {
        lines.push(format!("*{}*", source.author));
    }

    lines.push(String::new());
    lines.push("## Highlights".to_string());
    lines.push(String::new());

    if sorted.is_empty() {
        lines.push("_No highlights yet._".to_string());
        lines.push(String::new());
        return lines.join("\n");
    }

    for anno in &sorted {
        let quote_opt = anno
            .selected_text
            .as_ref()
            .map(|q| q.trim())
            .filter(|q| !q.is_empty());
        let note_opt = anno
            .note_content
            .as_ref()
            .map(|n| n.trim())
            .filter(|n| !n.is_empty());

        match preset {
            VaultExportPreset::Obsidian => {
                if let Some(quote) = quote_opt {
                    for qline in quote.lines() {
                        let trimmed = qline.trim();
                        if trimmed.is_empty() {
                            lines.push(">".to_string());
                        } else {
                            lines.push(format!("> =={}==", trimmed));
                        }
                    }
                    lines.push(String::new());
                }
                if let Some(note) = note_opt {
                    lines.push(note.to_string());
                    lines.push(String::new());
                }
            }
            VaultExportPreset::Logseq => {
                if let Some(quote) = quote_opt {
                    let mut qlines = quote.lines();
                    if let Some(first) = qlines.next() {
                        let trimmed = first.trim();
                        if trimmed.is_empty() {
                            lines.push("- >".to_string());
                        } else {
                            lines.push(format!("- > =={}==", trimmed));
                        }
                        for qline in qlines {
                            let trimmed = qline.trim();
                            if trimmed.is_empty() {
                                lines.push("  >".to_string());
                            } else {
                                lines.push(format!("  > =={}==", trimmed));
                            }
                        }
                    }
                    if let Some(note) = note_opt {
                        lines.push(format!("  - **Note**: {}", note));
                    }
                    lines.push(String::new());
                } else if let Some(note) = note_opt {
                    lines.push(format!("- **Note**: {}", note));
                    lines.push(String::new());
                }
            }
            VaultExportPreset::Minimalist => {
                if let Some(quote) = quote_opt {
                    for qline in quote.lines() {
                        let trimmed = qline.trim();
                        if trimmed.is_empty() {
                            lines.push(">".to_string());
                        } else {
                            lines.push(format!("> {}", trimmed));
                        }
                    }
                    lines.push(String::new());
                }
                if let Some(note) = note_opt {
                    lines.push(note.to_string());
                    lines.push(String::new());
                }
            }
        }
    }

    lines.join("\n")
}

/// `_generated_at` is intentionally unused: a timestamp in the note made its
/// bytes differ on every export, so the file was rewritten (and re-synced by
/// Obsidian / Syncthing) even when no term changed.
pub fn build_vocabulary_markdown(terms: &[VaultVocabularyTerm], _generated_at: &str) -> String {
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

    // Group annotations by book_id. BTreeMap: a stable order keeps the
    // " 2" suffix of colliding file names on the same book every run.
    let mut grouped_annotations: BTreeMap<String, Vec<VaultAnnotation>> = BTreeMap::new();
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

    let preset = match payload.export_preset.as_deref() {
        Some("logseq") => VaultExportPreset::Logseq,
        Some("minimalist") => VaultExportPreset::Minimalist,
        _ => VaultExportPreset::Obsidian,
    };

    for (book_id, annos) in &grouped_annotations {
        let source = build_export_source(book_id, &books_by_id, &rss_by_id);
        let file_name = build_unique_file_name(&source, &mut used_names);
        let abs_path = pages_dir.join(file_name);
        let content = build_book_page_markdown(&source, annos, &generated_at, preset);
        files_to_write.push((abs_path, content));
    }

    // Vocabulary file
    let vocab_content = build_vocabulary_markdown(&payload.vocabulary_terms, &generated_at);
    files_to_write.push((vocab_path, vocab_content));

    // Only touch files whose bytes changed: rewriting every note on every
    // highlight made Obsidian re-index and file-sync tools re-upload the vault.
    let outcomes: Vec<Result<bool, String>> = files_to_write
        .par_iter()
        .map(|(path, content)| write_if_changed(path, content.as_bytes()))
        .collect();
    let mut files_written = 0usize;
    for outcome in &outcomes {
        match outcome {
            Ok(true) => files_written += 1,
            Ok(false) => {}
            Err(e) => return Err(e.clone()),
        }
    }

    // Remove notes Theorem wrote last time that no longer correspond to a
    // source (book renamed, last highlight deleted), but only if they are still
    // byte-identical to what Theorem wrote: a note the user edited is kept.
    let manifest_path = theorem_dir.join(EXPORT_MANIFEST_FILE_NAME);
    let previous = read_export_manifest(&manifest_path);
    let mut current: BTreeMap<String, String> = BTreeMap::new();
    for (path, content) in &files_to_write {
        if let Ok(rel) = path.strip_prefix(&theorem_dir) {
            current.insert(
                rel.to_string_lossy().into_owned(),
                sha256_hex(content.as_bytes()),
            );
        }
    }
    let mut files_removed = 0usize;
    for (rel, hash) in &previous {
        if current.contains_key(rel) || !is_safe_relative_path(rel) {
            continue;
        }
        let stale = theorem_dir.join(rel);
        match fs::read(&stale) {
            Ok(bytes) if sha256_hex(&bytes) == *hash && fs::remove_file(&stale).is_ok() => {
                files_removed += 1;
            }
            _ => {}
        }
    }
    if previous != current {
        let json = serde_json::to_vec_pretty(&ExportManifest { files: current })
            .map_err(|e| format!("Failed to encode export manifest: {e}"))?;
        write_if_changed(&manifest_path, &json)?;
    }

    let file_paths: Vec<String> = files_to_write
        .into_iter()
        .map(|(p, _)| p.to_string_lossy().to_string())
        .collect();

    let total = file_paths.len();
    Ok(VaultExportResult {
        status: "synced".to_string(),
        message: if files_removed > 0 {
            format!("Exported {total} notes ({files_written} updated, {files_removed} removed).")
        } else {
            format!("Exported {total} notes ({files_written} updated).")
        },
        files_written,
        file_paths,
    })
}

const EXPORT_MANIFEST_FILE_NAME: &str = ".theorem-export-manifest.json";

#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
struct ExportManifest {
    files: BTreeMap<String, String>,
}

fn read_export_manifest(path: &Path) -> BTreeMap<String, String> {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<ExportManifest>(&bytes).ok())
        .map(|m| m.files)
        .unwrap_or_default()
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Manifest paths must stay inside the export folder.
fn is_safe_relative_path(rel: &str) -> bool {
    let path = Path::new(rel);
    !rel.is_empty()
        && path.is_relative()
        && path
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
}

/// Write `content` unless the file already holds exactly these bytes.
/// Returns whether the file was written.
fn write_if_changed(path: &Path, content: &[u8]) -> Result<bool, String> {
    if let Ok(existing) = fs::read(path) {
        if existing == content {
            return Ok(false);
        }
    }
    fs::write(path, content).map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
    Ok(true)
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

    struct TempVault(PathBuf);
    impl TempVault {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "theorem-vault-{tag}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            TempVault(dir)
        }
        fn payload(
            &self,
            books: Vec<(&str, &str)>,
            annos: Vec<(&str, &str)>,
        ) -> VaultExportPayload {
            VaultExportPayload {
                vault_path: self.0.to_string_lossy().into_owned(),
                highlights_folder: None,
                vocabulary_file_name: None,
                export_preset: None,
                books: books
                    .into_iter()
                    .map(|(id, title)| VaultBook {
                        id: id.to_string(),
                        title: title.to_string(),
                        author: Some("Same Author".to_string()),
                        format: Some("epub".to_string()),
                        file_path: None,
                    })
                    .collect(),
                annotations: annos
                    .into_iter()
                    .enumerate()
                    .map(|(i, (book_id, text))| VaultAnnotation {
                        id: format!("a{i}"),
                        book_id: book_id.to_string(),
                        r#type: "highlight".to_string(),
                        selected_text: Some(text.to_string()),
                        note_content: None,
                        color: Some("yellow".to_string()),
                        created_at: "2026-09-01T10:00:00Z".to_string(),
                        updated_at: None,
                    })
                    .collect(),
                vocabulary_terms: vec![],
                rss_articles: None,
                generated_at: None,
            }
        }
        fn pages(&self) -> Vec<String> {
            let mut names: Vec<String> =
                fs::read_dir(self.0.join("Theorem").join(DEFAULT_HIGHLIGHTS_FOLDER_NAME))
                    .unwrap()
                    .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                    .collect();
            names.sort();
            names
        }
    }
    impl Drop for TempVault {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn re_export_of_unchanged_data_writes_nothing() {
        let vault = TempVault::new("unchanged");
        let payload = vault.payload(
            vec![("b1", "Dune")],
            vec![("b1", "Fear is the mind-killer.")],
        );
        let first = export_vault_snapshot_impl(&payload).unwrap();
        assert_eq!(first.files_written, 2); // book page + vocabulary
        let second = export_vault_snapshot_impl(&payload).unwrap();
        assert_eq!(
            second.files_written, 0,
            "identical export must not touch any file"
        );
    }

    #[test]
    fn a_new_highlight_rewrites_only_that_book() {
        let vault = TempVault::new("one-book");
        let base = vec![("b1", "Dune"), ("b2", "Emma")];
        export_vault_snapshot_impl(&vault.payload(base.clone(), vec![("b1", "x"), ("b2", "y")]))
            .unwrap();
        let result = export_vault_snapshot_impl(
            &vault.payload(base, vec![("b1", "x"), ("b2", "y"), ("b2", "z")]),
        )
        .unwrap();
        assert_eq!(result.files_written, 1);
    }

    #[test]
    fn renamed_book_removes_the_old_note() {
        let vault = TempVault::new("rename");
        export_vault_snapshot_impl(&vault.payload(vec![("b1", "Dune")], vec![("b1", "x")]))
            .unwrap();
        let before = vault.pages();
        export_vault_snapshot_impl(&vault.payload(vec![("b1", "Dune Messiah")], vec![("b1", "x")]))
            .unwrap();
        let after = vault.pages();
        assert_eq!(before.len(), 1);
        assert_eq!(after.len(), 1);
        assert_ne!(before, after);
        assert!(after[0].starts_with("Dune Messiah"));
    }

    #[test]
    fn deleting_the_last_highlight_removes_the_note() {
        let vault = TempVault::new("delete");
        export_vault_snapshot_impl(&vault.payload(vec![("b1", "Dune")], vec![("b1", "x")]))
            .unwrap();
        let result =
            export_vault_snapshot_impl(&vault.payload(vec![("b1", "Dune")], vec![])).unwrap();
        assert!(vault.pages().is_empty());
        assert!(result.message.contains("1 removed"), "{}", result.message);
    }

    #[test]
    fn a_note_the_user_edited_is_never_deleted() {
        let vault = TempVault::new("user-edit");
        export_vault_snapshot_impl(&vault.payload(vec![("b1", "Dune")], vec![("b1", "x")]))
            .unwrap();
        let page = vault
            .0
            .join("Theorem")
            .join(DEFAULT_HIGHLIGHTS_FOLDER_NAME)
            .join(&vault.pages()[0]);
        fs::write(&page, "my own notes").unwrap();
        export_vault_snapshot_impl(&vault.payload(vec![("b1", "Dune")], vec![])).unwrap();
        assert_eq!(fs::read_to_string(&page).unwrap(), "my own notes");
    }

    #[test]
    fn manifest_paths_outside_the_export_folder_are_ignored() {
        let vault = TempVault::new("escape");
        let outside = vault.0.join("keep.md");
        fs::write(&outside, "x").unwrap();
        let theorem = vault.0.join("Theorem");
        fs::create_dir_all(&theorem).unwrap();
        let manifest = ExportManifest {
            files: BTreeMap::from([("../keep.md".to_string(), sha256_hex(b"x"))]),
        };
        fs::write(
            theorem.join(EXPORT_MANIFEST_FILE_NAME),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        export_vault_snapshot_impl(&vault.payload(vec![], vec![])).unwrap();
        assert!(outside.exists());
        assert!(!is_safe_relative_path("../x"));
        assert!(!is_safe_relative_path("/etc/passwd"));
        assert!(!is_safe_relative_path(""));
        assert!(is_safe_relative_path("Highlights/a.md"));
    }

    #[test]
    fn colliding_file_names_are_stable_whatever_the_payload_order() {
        let a = TempVault::new("order-a");
        let b = TempVault::new("order-b");
        export_vault_snapshot_impl(&a.payload(
            vec![("b1", "Same"), ("b2", "Same")],
            vec![("b1", "x"), ("b2", "y")],
        ))
        .unwrap();
        export_vault_snapshot_impl(&b.payload(
            vec![("b2", "Same"), ("b1", "Same")],
            vec![("b2", "y"), ("b1", "x")],
        ))
        .unwrap();
        assert_eq!(a.pages(), b.pages());
    }

    #[test]
    fn vocabulary_note_has_no_timestamp() {
        let md = build_vocabulary_markdown(&[], "2026-09-13T12:00:00Z");
        assert!(!md.contains("2026-09-13"));
        assert_eq!(md, build_vocabulary_markdown(&[], "2030-01-01T00:00:00Z"));
    }

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

    #[test]
    fn test_build_book_page_markdown() {
        let source = ExportSource {
            id: "book-1".to_string(),
            title: "Dune".to_string(),
            author: "Frank Herbert".to_string(),
            format: "epub".to_string(),
            file_path: "/books/dune.epub".to_string(),
        };

        let annotations = vec![
            VaultAnnotation {
                id: "anno-1".to_string(),
                book_id: "book-1".to_string(),
                r#type: "highlight".to_string(),
                selected_text: Some("Fear is the mind-killer.".to_string()),
                note_content: None,
                color: Some("yellow".to_string()),
                created_at: "2026-09-01T12:00:00Z".to_string(),
                updated_at: None,
            },
            VaultAnnotation {
                id: "anno-2".to_string(),
                book_id: "book-1".to_string(),
                r#type: "note".to_string(),
                selected_text: Some("I must not fear.".to_string()),
                note_content: Some("The Litany Against Fear.".to_string()),
                color: Some("blue".to_string()),
                created_at: "2026-09-01T12:05:00Z".to_string(),
                updated_at: None,
            },
        ];

        let md = build_book_page_markdown(
            &source,
            &annotations,
            "2026-09-13T12:00:00Z",
            VaultExportPreset::Obsidian,
        );
        assert!(md.contains("title: \"Dune\""));
        assert!(md.contains("author: \"Frank Herbert\""));
        assert!(md.contains("total_highlights: 2"));
        assert!(!md.contains("annotations_total:"));
        assert!(!md.contains("highlights_total:"));
        assert!(!md.contains("format:"));
        assert!(!md.contains("source_path:"));
        assert!(!md.contains("Color:"));
        assert!(!md.contains("### 1. Highlight"));
        assert!(md.contains("> ==Fear is the mind-killer.=="));
        assert!(md.contains("> ==I must not fear.=="));
        assert!(md.contains("The Litany Against Fear."));

        let md_logseq = build_book_page_markdown(
            &source,
            &annotations,
            "2026-09-13T12:00:00Z",
            VaultExportPreset::Logseq,
        );
        assert!(md_logseq.contains("- > ==Fear is the mind-killer.=="));
        assert!(md_logseq.contains("- > ==I must not fear.=="));
        assert!(md_logseq.contains("  - **Note**: The Litany Against Fear."));

        let md_minimal = build_book_page_markdown(
            &source,
            &annotations,
            "2026-09-13T12:00:00Z",
            VaultExportPreset::Minimalist,
        );
        assert!(md_minimal.contains("> Fear is the mind-killer."));
        assert!(md_minimal.contains("> I must not fear."));
        assert!(!md_minimal.contains("=="));
        assert!(md_minimal.contains("The Litany Against Fear."));
    }
}
