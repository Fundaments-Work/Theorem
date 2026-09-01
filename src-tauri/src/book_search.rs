use quick_xml::events::Event;
use quick_xml::Reader;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use zip::ZipArchive;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeSearchMatch {
    #[serde(rename = "sectionIndex")]
    pub section_index: usize,
    #[serde(rename = "sectionHref")]
    pub section_href: String,
    pub snippet: String,
    #[serde(rename = "matchText")]
    pub match_text: String,
    #[serde(rename = "charOffset")]
    pub char_offset: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookSearchResult {
    pub matches: Vec<NativeSearchMatch>,
    pub total: usize,
    #[serde(rename = "durationMs")]
    pub duration_ms: f64,
}

/// Strip XML/HTML tags and return clean text with mapped character positions
fn html_to_plain_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;

    for ch in html.chars() {
        if ch == '<' {
            in_tag = true;
            out.push(' ');
        } else if ch == '>' {
            in_tag = false;
        } else if in_tag {
            // inside tag, do not emit character
        } else {
            out.push(ch);
        }
    }

    out
}

/// Extract context snippet around match offset
fn extract_context_snippet(text: &str, start_char: usize, match_len: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    let total_chars = chars.len();

    let snippet_radius = 50;
    let snippet_start = start_char.saturating_sub(snippet_radius);
    let snippet_end = (start_char + match_len + snippet_radius).min(total_chars);

    let prefix = if snippet_start > 0 { "…" } else { "" };
    let suffix = if snippet_end < total_chars { "…" } else { "" };

    let body: String = chars[snippet_start..snippet_end].iter().collect();
    let clean_body = body.split_whitespace().collect::<Vec<_>>().join(" ");

    format!("{prefix}{clean_body}{suffix}")
}

/// Search across an EPUB's spine chapters in parallel
pub fn search_epub_spine(
    path: &Path,
    query: &str,
    match_case: bool,
) -> Result<Vec<NativeSearchMatch>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    let file = File::open(path).map_err(|e| format!("Cannot open EPUB: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid EPUB zip: {e}"))?;

    // 1. Locate container.xml -> OPF
    let mut opf_path = String::new();
    if let Ok(mut container) = archive.by_name("META-INF/container.xml") {
        let mut content = String::new();
        if container.read_to_string(&mut content).is_ok() {
            opf_path = extract_opf_path(&content);
        }
    }

    if opf_path.is_empty() {
        // Fallback: search for .opf in archive
        for i in 0..archive.len() {
            if let Ok(entry) = archive.by_index(i) {
                if entry.name().ends_with(".opf") {
                    opf_path = entry.name().to_string();
                    break;
                }
            }
        }
    }

    if opf_path.is_empty() {
        return Err("OPF rootfile not found".to_string());
    }

    let opf_dir = Path::new(&opf_path)
        .parent()
        .unwrap_or(Path::new(""))
        .to_string_lossy()
        .to_string();

    // 2. Read OPF and extract ordered spine items
    let opf_content = {
        let mut entry = archive
            .by_name(&opf_path)
            .map_err(|e| format!("Cannot read OPF: {e}"))?;
        let mut s = String::new();
        entry
            .read_to_string(&mut s)
            .map_err(|e| format!("Failed to read OPF string: {e}"))?;
        s
    };

    let spine_hrefs = parse_ordered_spine_hrefs(&opf_content);
    if spine_hrefs.is_empty() {
        return Ok(Vec::new());
    }

    // 3. Extract text for all spine sections
    let mut section_texts: Vec<(usize, String, String)> = Vec::with_capacity(spine_hrefs.len()); // (index, full_path, raw_text)

    for (idx, href) in spine_hrefs.iter().enumerate() {
        let full_path = if opf_dir.is_empty() {
            href.clone()
        } else {
            format!("{opf_dir}/{href}").replace('\\', "/")
        };

        if let Ok(mut entry) = archive.by_name(&full_path) {
            let mut text = String::new();
            if entry.read_to_string(&mut text).is_ok() {
                section_texts.push((idx, full_path, text));
            }
        }
    }

    // 4. Multi-threaded parallel search across sections using Rayon
    let target_query = if match_case {
        q.to_string()
    } else {
        q.to_lowercase()
    };

    let results: Vec<NativeSearchMatch> = section_texts
        .par_iter()
        .flat_map(|(sec_idx, sec_href, raw_html)| {
            let plain_text = html_to_plain_text(raw_html);
            let search_text = if match_case {
                plain_text.clone()
            } else {
                plain_text.to_lowercase()
            };

            let mut matches = Vec::new();
            let mut search_from = 0;

            while let Some(byte_pos) = search_text[search_from..].find(&target_query) {
                let actual_byte_pos = search_from + byte_pos;
                let char_offset = plain_text[..actual_byte_pos].chars().count();
                let match_len = q.chars().count();

                let snippet = extract_context_snippet(&plain_text, char_offset, match_len);

                matches.push(NativeSearchMatch {
                    section_index: *sec_idx,
                    section_href: sec_href.clone(),
                    snippet,
                    match_text: q.to_string(),
                    char_offset,
                });

                search_from = actual_byte_pos + target_query.len();
                if search_from >= search_text.len() {
                    break;
                }
            }

            matches
        })
        .collect();

    Ok(results)
}

fn extract_opf_path(xml: &str) -> String {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Empty(ref e)) | Ok(Event::Start(ref e)) => {
                if e.name().as_ref() == b"rootfile" {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"full-path" {
                            return String::from_utf8_lossy(&attr.value).to_string();
                        }
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    String::new()
}

fn parse_ordered_spine_hrefs(xml: &str) -> Vec<String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();

    let mut manifest: HashMap<String, String> = HashMap::new(); // id -> href
    let mut spine_idrefs: Vec<String> = Vec::new();
    let mut in_manifest = false;
    let mut in_spine = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let name = e.local_name();
                if name.as_ref() == b"manifest" {
                    in_manifest = true;
                } else if name.as_ref() == b"spine" {
                    in_spine = true;
                }
            }
            Ok(Event::Empty(ref e)) => {
                let name = e.local_name();
                if in_manifest && name.as_ref() == b"item" {
                    let mut id = String::new();
                    let mut href = String::new();
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"id" {
                            id = String::from_utf8_lossy(&attr.value).to_string();
                        } else if attr.key.as_ref() == b"href" {
                            href = String::from_utf8_lossy(&attr.value).to_string();
                        }
                    }
                    if !id.is_empty() && !href.is_empty() {
                        manifest.insert(id, href);
                    }
                } else if in_spine && name.as_ref() == b"itemref" {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"idref" {
                            spine_idrefs.push(String::from_utf8_lossy(&attr.value).to_string());
                        }
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                let name = e.local_name();
                if name.as_ref() == b"manifest" {
                    in_manifest = false;
                } else if name.as_ref() == b"spine" {
                    in_spine = false;
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    spine_idrefs
        .into_iter()
        .filter_map(|id| manifest.get(&id).cloned())
        .collect()
}

// ─────────────────────────────────────────────────────────────────────────────
// TAURI COMMANDS
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn search_book_content(
    path: String,
    query: String,
    match_case: Option<bool>,
) -> Result<BookSearchResult, String> {
    let start = std::time::Instant::now();
    let file_path = std::path::PathBuf::from(path);
    if !file_path.exists() {
        return Err(format!("File not found: {}", file_path.display()));
    }

    let is_match_case = match_case.unwrap_or(false);

    let matches =
        tokio::task::spawn_blocking(move || search_epub_spine(&file_path, &query, is_match_case))
            .await
            .map_err(|e| format!("Search task failed: {e}"))??;

    let duration_ms = start.elapsed().as_secs_f64() * 1000.0;
    let total = matches.len();

    Ok(BookSearchResult {
        matches,
        total,
        duration_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_html_to_plain_text() {
        let html = "<p>Hello <b>World</b>! Here is <a href=\"#\">a link</a>.</p>";
        let plain = html_to_plain_text(html);
        assert!(plain.contains("Hello"));
        assert!(plain.contains("World"));
        assert!(plain.contains("a link"));
        assert!(!plain.contains('<'));
        assert!(!plain.contains('>'));
    }

    #[test]
    fn test_extract_context_snippet() {
        let text = "Call me Ishmael. Some years ago - never mind how long precisely - having little or no money in my purse, and nothing particular to interest me on shore, I thought I would sail about a little and see the watery part of the world.";
        let snippet = extract_context_snippet(text, 8, 7); // "Ishmael"
        assert!(snippet.contains("Ishmael"));
        assert!(snippet.contains("Call me"));
    }
}
