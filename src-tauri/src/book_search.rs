use flate2::read::{DeflateDecoder, ZlibDecoder};
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
            let mut last_byte_pos = 0;
            let mut running_char_offset = 0;

            while let Some(byte_pos) = search_text[search_from..].find(&target_query) {
                let actual_byte_pos = search_from + byte_pos;
                let end_byte_pos = actual_byte_pos + target_query.len();
                running_char_offset += plain_text[last_byte_pos..actual_byte_pos].chars().count();
                last_byte_pos = actual_byte_pos;

                if !whole_word || is_word_boundary(&plain_text, actual_byte_pos, end_byte_pos) {
                    let snippet =
                        extract_context_snippet(&plain_text, actual_byte_pos, target_query.len());

                    matches.push(NativeSearchMatch {
                        section_index: *sec_idx,
                        section_href: sec_href.clone().into_boxed_str(),
                        snippet: snippet.into_boxed_str(),
                        match_text: q.to_string().into_boxed_str(),
                        char_offset: running_char_offset,
                    });
                }

                search_from = end_byte_pos;
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
// PDF SEARCH ENGINE
// ─────────────────────────────────────────────────────────────────────────────

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn parse_obj_header(pre: &[u8]) -> Option<(usize, usize)> {
    let mut i = pre.len();
    while i > 0 && pre[i - 1].is_ascii_whitespace() {
        i -= 1;
    }
    let gen_end = i;
    while i > 0 && pre[i - 1].is_ascii_digit() {
        i -= 1;
    }
    let gen_start = i;
    if gen_start == gen_end {
        return None;
    }

    while i > 0 && pre[i - 1].is_ascii_whitespace() {
        i -= 1;
    }
    let id_end = i;
    while i > 0 && pre[i - 1].is_ascii_digit() {
        i -= 1;
    }
    let id_start = i;
    if id_start == id_end {
        return None;
    }

    let id_str = std::str::from_utf8(&pre[id_start..id_end]).ok()?;
    let gen_str = std::str::from_utf8(&pre[gen_start..gen_end]).ok()?;

    let id = id_str.parse::<usize>().ok()?;
    let gen = gen_str.parse::<usize>().ok()?;
    Some((id, gen))
}

struct PdfObjectSlice<'a> {
    dict: &'a [u8],
    stream: Option<&'a [u8]>,
}

fn parse_pdf_objects(bytes: &[u8]) -> HashMap<usize, PdfObjectSlice<'_>> {
    let mut objects = HashMap::new();
    let mut pos = 0;

    while pos < bytes.len() {
        let slice = &bytes[pos..];
        let Some(obj_idx) = find_subslice(slice, b" obj") else {
            break;
        };

        let obj_start = pos + obj_idx;
        let pre_obj = &bytes[pos..obj_start];
        if let Some((id, _gen)) = parse_obj_header(pre_obj) {
            let body_start = obj_start + 4;
            let end_obj_pos = find_subslice(&bytes[body_start..], b"endobj")
                .map(|p| body_start + p)
                .unwrap_or(bytes.len());

            let obj_body = &bytes[body_start..end_obj_pos];

            let mut dict = obj_body;
            let mut stream_data = None;

            if let Some(stream_kw_idx) = find_subslice(obj_body, b"stream") {
                dict = &obj_body[..stream_kw_idx];
                let mut stream_start = stream_kw_idx + 6;
                if stream_start < obj_body.len() && obj_body[stream_start] == b'\r' {
                    stream_start += 1;
                }
                if stream_start < obj_body.len() && obj_body[stream_start] == b'\n' {
                    stream_start += 1;
                }

                if let Some(endstream_kw_idx) =
                    find_subslice(&obj_body[stream_start..], b"endstream")
                {
                    let mut stream_end = stream_start + endstream_kw_idx;
                    if stream_end > stream_start && obj_body[stream_end - 1] == b'\n' {
                        stream_end -= 1;
                    }
                    if stream_end > stream_start && obj_body[stream_end - 1] == b'\r' {
                        stream_end -= 1;
                    }
                    stream_data = Some(&obj_body[stream_start..stream_end]);
                }
            }

            objects.insert(
                id,
                PdfObjectSlice {
                    dict,
                    stream: stream_data,
                },
            );

            pos = end_obj_pos + 6;
        } else {
            pos = obj_start + 4;
        }
    }

    objects
}

fn is_page_object(dict: &[u8]) -> bool {
    if let Some(pos) = find_subslice(dict, b"/Type /Page") {
        let after = pos + 11;
        return after >= dict.len() || (dict[after] != b's' && dict[after] != b'S');
    }
    if let Some(pos) = find_subslice(dict, b"/Type/Page") {
        let after = pos + 10;
        return after >= dict.len() || (dict[after] != b's' && dict[after] != b'S');
    }
    false
}

fn extract_content_ids(dict: &[u8]) -> Vec<usize> {
    let mut ids = Vec::new();
    let Some(contents_pos) = find_subslice(dict, b"/Contents") else {
        return ids;
    };
    let rest = &dict[contents_pos + 9..];
    let mut in_bracket = false;
    let mut i = 0;
    while i < rest.len() {
        let b = rest[i];
        if b == b'[' {
            in_bracket = true;
            i += 1;
            continue;
        } else if b == b']' {
            break;
        } else if b == b'/' {
            if !in_bracket {
                break;
            }
        } else if b == b'>' {
            break;
        } else if b.is_ascii_digit() {
            let start = i;
            while i < rest.len() && rest[i].is_ascii_digit() {
                i += 1;
            }
            if let Ok(s) = std::str::from_utf8(&rest[start..i]) {
                if let Ok(id) = s.parse::<usize>() {
                    let lookahead = &rest[i..];
                    if let Some(r_pos) = find_subslice(&lookahead[..lookahead.len().min(12)], b" R")
                    {
                        ids.push(id);
                        i += r_pos + 2;
                        if !in_bracket {
                            break;
                        }
                        continue;
                    }
                }
            }
        }
        i += 1;
    }
    ids
}

fn decompress_pdf_stream(dict: &[u8], stream_bytes: &[u8]) -> Vec<u8> {
    let is_flate = find_subslice(dict, b"FlateDecode").is_some();
    if is_flate {
        let mut decoder = ZlibDecoder::new(stream_bytes);
        let mut out = Vec::new();
        if decoder.read_to_end(&mut out).is_ok() && !out.is_empty() {
            return out;
        }
        let mut def_decoder = DeflateDecoder::new(stream_bytes);
        out.clear();
        if def_decoder.read_to_end(&mut out).is_ok() && !out.is_empty() {
            return out;
        }
    }
    stream_bytes.to_vec()
}

fn decode_hex_string(hex: &[u8]) -> Option<String> {
    let mut clean_hex = Vec::with_capacity(hex.len());
    for &b in hex {
        if b.is_ascii_hexdigit() {
            clean_hex.push(b);
        }
    }
    if clean_hex.is_empty() {
        return None;
    }
    if clean_hex.len() % 2 != 0 {
        clean_hex.push(b'0');
    }

    let mut bytes = Vec::with_capacity(clean_hex.len() / 2);
    for chunk in clean_hex.chunks_exact(2) {
        let h = std::str::from_utf8(chunk).ok()?;
        let val = u8::from_str_radix(h, 16).ok()?;
        bytes.push(val);
    }

    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let u16_chars: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16(&u16_chars).ok()
    } else {
        Some(String::from_utf8_lossy(&bytes).to_string())
    }
}

fn extract_text_from_pdf_stream(stream: &[u8]) -> String {
    let mut out = String::with_capacity(stream.len() / 2);
    let mut i = 0;

    while i < stream.len() {
        let b = stream[i];
        if b == b'(' {
            i += 1;
            let mut depth = 1;
            let mut s = String::new();
            while i < stream.len() && depth > 0 {
                if stream[i] == b'\\' && i + 1 < stream.len() {
                    i += 1;
                    match stream[i] {
                        b'n' => s.push('\n'),
                        b'r' => s.push('\n'),
                        b't' => s.push(' '),
                        b'(' => s.push('('),
                        b')' => s.push(')'),
                        b'\\' => s.push('\\'),
                        other => s.push(other as char),
                    }
                } else if stream[i] == b'(' {
                    depth += 1;
                    s.push('(');
                } else if stream[i] == b')' {
                    depth -= 1;
                    if depth > 0 {
                        s.push(')');
                    }
                } else {
                    s.push(stream[i] as char);
                }
                i += 1;
            }
            out.push_str(&s);
        } else if b == b'[' {
            i += 1;
            while i < stream.len() && stream[i] != b']' {
                if stream[i] == b'(' {
                    i += 1;
                    let mut depth = 1;
                    let mut s = String::new();
                    while i < stream.len() && depth > 0 {
                        if stream[i] == b'\\' && i + 1 < stream.len() {
                            i += 1;
                            match stream[i] {
                                b'n' => s.push('\n'),
                                b'r' => s.push('\n'),
                                b't' => s.push(' '),
                                b'(' => s.push('('),
                                b')' => s.push(')'),
                                b'\\' => s.push('\\'),
                                other => s.push(other as char),
                            }
                        } else if stream[i] == b'(' {
                            depth += 1;
                            s.push('(');
                        } else if stream[i] == b')' {
                            depth -= 1;
                            if depth > 0 {
                                s.push(')');
                            }
                        } else {
                            s.push(stream[i] as char);
                        }
                        i += 1;
                    }
                    out.push_str(&s);
                } else if stream[i] == b'<' {
                    i += 1;
                    let hex_start = i;
                    while i < stream.len() && stream[i] != b'>' {
                        i += 1;
                    }
                    let hex_bytes = &stream[hex_start..i];
                    if let Some(decoded) = decode_hex_string(hex_bytes) {
                        out.push_str(&decoded);
                    }
                    if i < stream.len() {
                        i += 1;
                    }
                } else if stream[i] == b'-' {
                    let num_start = i;
                    i += 1;
                    while i < stream.len() && (stream[i].is_ascii_digit() || stream[i] == b'.') {
                        i += 1;
                    }
                    if let Ok(num_str) = std::str::from_utf8(&stream[num_start..i]) {
                        if let Ok(spacing) = num_str.parse::<f32>() {
                            if spacing <= -100.0 && !out.ends_with(' ') {
                                out.push(' ');
                            }
                        }
                    }
                } else {
                    i += 1;
                }
            }
            if i < stream.len() {
                i += 1;
            }
        } else if b == b'<' && i + 1 < stream.len() && stream[i + 1] != b'<' {
            i += 1;
            let hex_start = i;
            while i < stream.len() && stream[i] != b'>' {
                i += 1;
            }
            let hex_bytes = &stream[hex_start..i];
            if let Some(decoded) = decode_hex_string(hex_bytes) {
                out.push_str(&decoded);
            }
            if i < stream.len() {
                i += 1;
            }
        } else {
            i += 1;
        }
    }

    out
}

pub fn extract_pdf_page_texts(bytes: &[u8]) -> Vec<String> {
    let objects = parse_pdf_objects(bytes);
    if objects.is_empty() {
        return Vec::new();
    }

    let mut page_objects: Vec<(usize, &PdfObjectSlice<'_>)> = objects
        .iter()
        .filter(|(_, obj)| is_page_object(obj.dict))
        .map(|(id, obj)| (*id, obj))
        .collect();

    page_objects.sort_by_key(|(id, _)| *id);

    if !page_objects.is_empty() {
        let mut pages = Vec::with_capacity(page_objects.len());
        for (_page_id, page_obj) in page_objects {
            let mut page_text = String::new();
            let content_ids = extract_content_ids(page_obj.dict);

            if !content_ids.is_empty() {
                for cid in content_ids {
                    if let Some(c_obj) = objects.get(&cid) {
                        if let Some(stream_bytes) = c_obj.stream {
                            let decompressed = decompress_pdf_stream(c_obj.dict, stream_bytes);
                            let text = extract_text_from_pdf_stream(&decompressed);
                            if !text.is_empty() {
                                if !page_text.is_empty() {
                                    page_text.push(' ');
                                }
                                page_text.push_str(&text);
                            }
                        }
                    }
                }
            } else if let Some(stream_bytes) = page_obj.stream {
                let decompressed = decompress_pdf_stream(page_obj.dict, stream_bytes);
                page_text = extract_text_from_pdf_stream(&decompressed);
            }

            let clean: String = page_text.split_whitespace().collect::<Vec<_>>().join(" ");
            pages.push(clean);
        }
        pages
    } else {
        let mut stream_objects: Vec<(usize, &PdfObjectSlice<'_>)> = objects
            .iter()
            .filter(|(_, obj)| obj.stream.is_some())
            .map(|(id, obj)| (*id, obj))
            .collect();

        stream_objects.sort_by_key(|(id, _)| *id);

        let mut pages = Vec::new();
        for (_id, obj) in stream_objects {
            if let Some(stream_bytes) = obj.stream {
                let decompressed = decompress_pdf_stream(obj.dict, stream_bytes);
                let text = extract_text_from_pdf_stream(&decompressed);
                let clean: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
                if !clean.is_empty() {
                    pages.push(clean);
                }
            }
        }
        pages
    }
}

pub fn search_pdf_content(
    path: &Path,
    query: &str,
    match_case: bool,
    whole_word: bool,
) -> Result<Vec<NativeSearchMatch>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    let bytes = std::fs::read(path).map_err(|e| format!("Cannot read PDF: {e}"))?;
    if !bytes.starts_with(b"%PDF-") {
        return Err("Not a valid PDF file".to_string());
    }

    let page_texts = extract_pdf_page_texts(&bytes);
    if page_texts.is_empty() {
        return Ok(Vec::new());
    }

    let target_query = if match_case {
        q.to_string()
    } else {
        q.to_lowercase()
    };

    let results: Vec<NativeSearchMatch> = page_texts
        .par_iter()
        .enumerate()
        .flat_map(|(page_idx, text)| {
            let search_text = if match_case {
                text.clone()
            } else {
                text.to_lowercase()
            };

            let mut matches = Vec::new();
            let mut search_from = 0;
            let mut last_byte_pos = 0;
            let mut running_char_offset = 0;

            while let Some(byte_pos) = search_text[search_from..].find(&target_query) {
                let actual_byte_pos = search_from + byte_pos;
                let end_byte_pos = actual_byte_pos + target_query.len();
                running_char_offset += text[last_byte_pos..actual_byte_pos].chars().count();
                last_byte_pos = actual_byte_pos;

                if !whole_word || is_word_boundary(text, actual_byte_pos, end_byte_pos) {
                    let snippet =
                        extract_context_snippet(text, actual_byte_pos, target_query.len());

                    matches.push(NativeSearchMatch {
                        section_index: page_idx,
                        section_href: format!("page={}", page_idx + 1).into_boxed_str(),
                        snippet: snippet.into_boxed_str(),
                        match_text: q.to_string().into_boxed_str(),
                        char_offset: running_char_offset,
                    });
                }

                search_from = end_byte_pos;
                if search_from >= search_text.len() {
                    break;
                }
            }

            matches
        })
        .collect();

    Ok(results)
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

    let is_pdf = file_path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
        || {
            if let Ok(mut f) = std::fs::File::open(&file_path) {
                let mut magic = [0u8; 4];
                f.read_exact(&mut magic).is_ok() && &magic == b"%PDF"
            } else {
                false
            }
        };

    let matches = tokio::task::spawn_blocking(move || {
        if is_pdf {
            search_pdf_content(&file_path, &query, is_match_case, is_whole_word)
        } else {
            search_epub_spine(&file_path, &query, is_match_case, is_whole_word)
        }
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

    #[test]
    fn test_pdf_extract_and_search() {
        let pdf_data = b"%PDF-1.4\n\
1 0 obj\n\
<< /Type /Catalog /Pages 2 0 R >>\n\
endobj\n\
2 0 obj\n\
<< /Type /Pages /Kids [ 3 0 R ] /Count 1 >>\n\
endobj\n\
3 0 obj\n\
<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\n\
endobj\n\
4 0 obj\n\
<< /Length 55 >>\n\
stream\n\
BT\n\
/F1 12 Tf\n\
(Theorem ebook reader combines local-first SQLite persistence) Tj\n\
ET\n\
endstream\n\
endobj\n\
trailer\n\
<< /Root 1 0 R >>\n\
%%EOF\n";

        let temp_dir = tempfile::tempdir().unwrap();
        let pdf_path = temp_dir.path().join("test_sample.pdf");
        std::fs::write(&pdf_path, pdf_data).unwrap();

        let matches = search_pdf_content(&pdf_path, "SQLite persistence", false, false).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].section_index, 0);
        assert_eq!(matches[0].section_href.as_ref(), "page=1");
        assert!(matches[0].snippet.contains("SQLite persistence"));

        // Whole word test: "SQLite" matches, but "SQL" only matches when whole_word is false
        let whole_word_matches = search_pdf_content(&pdf_path, "SQL", false, true).unwrap();
        assert_eq!(whole_word_matches.len(), 0);
        let partial_matches = search_pdf_content(&pdf_path, "SQL", false, false).unwrap();
        assert_eq!(partial_matches.len(), 1);

        // Case-sensitive test: "sqlite" with match_case=true yields 0 matches
        let case_matches = search_pdf_content(&pdf_path, "sqlite", true, false).unwrap();
        assert_eq!(case_matches.len(), 0);
    }

    #[test]
    fn test_pdf_flate_compressed_search() {
        use flate2::write::ZlibEncoder;
        use flate2::Compression;
        use std::io::Write;

        let content_stream =
            b"BT /F1 12 Tf [ (Quantum) -150 (Computing) -200 (Breakthrough) ] TJ ET";
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(content_stream).unwrap();
        let compressed = encoder.finish().unwrap();

        let mut pdf_data = Vec::new();
        pdf_data
            .extend_from_slice(b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
        pdf_data
            .extend_from_slice(b"2 0 obj\n<< /Type /Pages /Kids [ 3 0 R ] /Count 1 >>\nendobj\n");
        pdf_data.extend_from_slice(
            b"3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n",
        );
        let header4 = format!(
            "4 0 obj\n<< /Filter /FlateDecode /Length {} >>\nstream\n",
            compressed.len()
        );
        pdf_data.extend_from_slice(header4.as_bytes());
        pdf_data.extend_from_slice(&compressed);
        pdf_data.extend_from_slice(b"\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");

        let temp_dir = tempfile::tempdir().unwrap();
        let pdf_path = temp_dir.path().join("test_compressed.pdf");
        std::fs::write(&pdf_path, &pdf_data).unwrap();

        let matches = search_pdf_content(&pdf_path, "Quantum Computing", false, false).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].section_index, 0);
        assert_eq!(matches[0].section_href.as_ref(), "page=1");
        assert!(matches[0].snippet.contains("Quantum Computing"));
    }

    #[test]
    fn test_real_user_book_search() {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/home/sapiens".to_string());
        let cache_dir = std::path::PathBuf::from(home)
            .join(".local/share/work.fundamentals.theorem/book-cache");

        if !cache_dir.exists() {
            println!("No book cache dir found at: {:?}", cache_dir);
            return;
        }

        let mut entries = std::fs::read_dir(&cache_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().map_or(false, |ext| ext == "book"))
            .collect::<Vec<_>>();

        entries.sort_by_key(|e| std::cmp::Reverse(e.metadata().map(|m| m.len()).unwrap_or(0)));

        let test_queries = ["the", "chapter", "history", "time", "world"];

        for entry in entries.iter().take(3) {
            let path = entry.path();
            let size_mb = path
                .metadata()
                .map(|m| m.len() as f64 / 1_048_576.0)
                .unwrap_or(0.0);

            for query in test_queries {
                let start = std::time::Instant::now();
                let res = search_epub_spine(&path, query, false, false);
                let duration = start.elapsed();

                if let Ok(matches) = res {
                    println!(
                        "🔍 Search [{:.2} MB Book: {:?}] Query: {:?} | Found {} matches in {:.2} ms",
                        size_mb,
                        path.file_name().unwrap(),
                        query,
                        matches.len(),
                        duration.as_secs_f64() * 1000.0
                    );
                }
            }
        }
    }
}
