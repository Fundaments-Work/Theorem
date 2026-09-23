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
    pub section_href: Box<str>,
    pub snippet: Box<str>,
    #[serde(rename = "matchText")]
    pub match_text: Box<str>,
    #[serde(rename = "charOffset")]
    pub char_offset: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookSearchResult {
    pub matches: Box<[NativeSearchMatch]>,
    pub total: usize,
    #[serde(rename = "durationMs")]
    pub duration_ms: f64,
}

/// Strip XML/HTML tags and return clean text with mapped character positions
pub(crate) fn html_to_plain_text(html: &str) -> String {
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

/// Extract context snippet around match byte offset using zero-allocation byte slicing
fn extract_context_snippet(text: &str, match_byte_start: usize, match_byte_len: usize) -> String {
    let snippet_char_radius = 50;

    // Scan backwards at most snippet_char_radius UTF-8 characters from match start
    let prefix_slice = &text[..match_byte_start];
    let mut chars_before = 0;
    let mut snippet_byte_start = 0;
    let mut has_prefix_ellipsis = false;

    for (byte_idx, _) in prefix_slice.char_indices().rev() {
        chars_before += 1;
        if chars_before >= snippet_char_radius {
            snippet_byte_start = byte_idx;
            has_prefix_ellipsis = true;
            break;
        }
    }

    // Scan forwards at most snippet_char_radius UTF-8 characters from match end
    let match_byte_end = (match_byte_start + match_byte_len).min(text.len());
    let suffix_slice = &text[match_byte_end..];
    let mut chars_after = 0;
    let mut snippet_byte_end = text.len();
    let mut has_suffix_ellipsis = false;

    for (rel_byte_idx, ch) in suffix_slice.char_indices() {
        chars_after += 1;
        if chars_after >= snippet_char_radius {
            snippet_byte_end = match_byte_end + rel_byte_idx + ch.len_utf8();
            has_suffix_ellipsis = true;
            break;
        }
    }

    let raw_snippet = &text[snippet_byte_start..snippet_byte_end];
    let clean_body: String = raw_snippet.split_whitespace().collect::<Vec<_>>().join(" ");

    let prefix = if has_prefix_ellipsis { "…" } else { "" };
    let suffix = if has_suffix_ellipsis { "…" } else { "" };

    format!("{prefix}{clean_body}{suffix}")
}

fn is_word_boundary(text: &str, start: usize, end: usize) -> bool {
    let before_ok = if start == 0 {
        true
    } else {
        text[..start]
            .chars()
            .last()
            .map(|c| !c.is_alphanumeric() && c != '_')
            .unwrap_or(true)
    };
    let after_ok = if end >= text.len() {
        true
    } else {
        text[end..]
            .chars()
            .next()
            .map(|c| !c.is_alphanumeric() && c != '_')
            .unwrap_or(true)
    };
    before_ok && after_ok
}

/// Search across an EPUB's spine chapters in parallel
pub fn search_epub_spine(
    path: &Path,
    query: &str,
    match_case: bool,
    whole_word: bool,
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

    // 4. Multi-threaded parallel search across sections using Rayon.
    // Case-insensitive matching runs on the original text (regex `(?i)`), not on
    // a lowercased copy: lowercasing can change byte lengths ("İ" is 2 bytes,
    // "i̇" is 3), which shifted offsets and could slice mid-character.
    let pattern = regex::RegexBuilder::new(&regex::escape(q))
        .case_insensitive(!match_case)
        .build()
        .map_err(|e| format!("Invalid search pattern: {e}"))?;

    let results: Vec<NativeSearchMatch> = section_texts
        .par_iter()
        .flat_map(|(sec_idx, sec_href, raw_html)| {
            let plain_text = html_to_plain_text(raw_html);
            let mut matches = Vec::new();
            let mut last_byte_pos = 0;
            let mut running_char_offset = 0;

            for found in pattern.find_iter(&plain_text) {
                let (start, end) = (found.start(), found.end());
                if whole_word && !is_word_boundary(&plain_text, start, end) {
                    continue;
                }
                running_char_offset += plain_text[last_byte_pos..start].chars().count();
                last_byte_pos = start;
                matches.push(NativeSearchMatch {
                    section_index: *sec_idx,
                    section_href: sec_href.clone().into_boxed_str(),
                    snippet: extract_context_snippet(&plain_text, start, end - start)
                        .into_boxed_str(),
                    match_text: found.as_str().into(),
                    char_offset: running_char_offset,
                });
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
    whole_word: Option<bool>,
) -> Result<BookSearchResult, String> {
    let start = std::time::Instant::now();
    let file_path = std::path::PathBuf::from(path);
    if !file_path.exists() {
        return Err(format!("File not found: {}", file_path.display()));
    }

    let is_match_case = match_case.unwrap_or(false);
    let is_whole_word = whole_word.unwrap_or(false);

    // EPUB only. PDF search runs in the reader on pdf.js text, which decodes
    // fonts and knows the page order; a raw content-stream scan did neither.
    let matches = tokio::task::spawn_blocking(move || {
        search_epub_spine(&file_path, &query, is_match_case, is_whole_word)
    })
    .await
    .map_err(|e| format!("Search task failed: {e}"))??;

    let duration_ms = start.elapsed().as_secs_f64() * 1000.0;
    let total = matches.len();

    Ok(BookSearchResult {
        matches: matches.into_boxed_slice(),
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

    fn write_epub(dir: &Path, chapter_body: &str) -> std::path::PathBuf {
        use std::io::Write;
        let path = dir.join("book.epub");
        let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
        let opts = zip::write::SimpleFileOptions::default();
        let mut add = |name: &str, body: &str| {
            zip.start_file(name, opts).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        };
        add("mimetype", "application/epub+zip");
        add(
            "META-INF/container.xml",
            r#"<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#,
        );
        add(
            "OEBPS/content.opf",
            r#"<package><manifest><item id="c1" href="c1.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>"#,
        );
        add(
            "OEBPS/c1.xhtml",
            &format!("<html><body><p>{chapter_body}</p></body></html>"),
        );
        zip.finish().unwrap();
        path
    }

    #[test]
    fn case_insensitive_offsets_survive_length_changing_lowercase() {
        // "İ" lowercases to "i̇" (2 -> 3 bytes); searching a lowercased copy
        // shifted every later offset and could panic slicing mid-character.
        let dir = tempfile::tempdir().unwrap();
        let body = "İİİİ Istanbul and the Sea. THE end, then theory.";
        let path = write_epub(dir.path(), body);

        let matches = search_epub_spine(&path, "the", false, false).unwrap();
        let texts: Vec<&str> = matches.iter().map(|m| &*m.match_text).collect();
        assert_eq!(texts, ["the", "THE", "the", "the"]);
        let plain = html_to_plain_text(&format!("<html><body><p>{body}</p></body></html>"));
        for m in &matches {
            let at: String = plain.chars().skip(m.char_offset).take(3).collect();
            assert!(
                at.eq_ignore_ascii_case("the"),
                "offset {} -> {at:?}",
                m.char_offset
            );
            assert!(m.snippet.contains(&*m.match_text));
        }

        let whole = search_epub_spine(&path, "the", false, true).unwrap();
        assert_eq!(whole.len(), 2);
        let exact = search_epub_spine(&path, "THE", true, false).unwrap();
        assert_eq!(exact.len(), 1);
    }

    #[test]
    fn empty_and_regex_metacharacter_queries() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_epub(dir.path(), "Price (in $) is 3.5 + tax [sic].");
        assert!(search_epub_spine(&path, "   ", false, false)
            .unwrap()
            .is_empty());
        assert_eq!(
            search_epub_spine(&path, "(in $)", false, false)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            search_epub_spine(&path, "3.5 +", false, false)
                .unwrap()
                .len(),
            1
        );
        assert!(search_epub_spine(&path, "3x5", false, false)
            .unwrap()
            .is_empty());
        assert_eq!(
            search_epub_spine(&path, "[sic]", false, true)
                .unwrap()
                .len(),
            1
        );
    }
}
