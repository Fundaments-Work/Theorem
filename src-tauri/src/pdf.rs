//! PDF commands: a minimal structure parser (xref, page count, MediaBox), metadata and range reads.

use serde::Serialize;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use tauri::ipc::Response;

#[derive(Serialize)]
pub(crate) struct PdfMetadata {
    title: Option<String>,
    author: Option<String>,
    pages: Option<u32>,
    creator: Option<String>,
    producer: Option<String>,
    creation_date: Option<String>,
    modification_date: Option<String>,
}

/// Lightweight PDF structure pre-fetch — reads only enough bytes from the
/// cross-reference trailer to return an accurate page count and the first
/// page's MediaBox dimensions.  Called by the frontend *before* PDF.js
/// opens the document so that all N placeholder `<div>` elements can be
/// sized and mounted immediately, giving a stable full-document scrollbar
/// from the very first frame.
#[derive(Serialize)]
pub(crate) struct PdfStructure {
    /// True total page count from the /Pages /Count dictionary entry.
    total_pages: u32,
    /// Width  of the first page's MediaBox in PDF user-space points (1 pt = 1/72 inch).
    /// Falls back to 595 (A4 portrait) when the MediaBox cannot be located.
    default_width_pt: f32,
    /// Height of the first page's MediaBox in PDF user-space points.
    /// Falls back to 842 (A4 portrait) when the MediaBox cannot be located.
    default_height_pt: f32,
    /// Raw file size in bytes — forwarded to the range transport so the
    /// frontend does not need a second IPC round-trip.
    file_size_bytes: u64,
    /// Best-effort title from the document information dictionary.
    title: Option<String>,
    /// Best-effort author from the document information dictionary.
    author: Option<String>,
}

/// Parse a PDF integer token starting at `pos` inside `bytes`.
/// Returns `(value, bytes_consumed)` or `None` on failure.
fn parse_pdf_integer(bytes: &[u8], pos: usize) -> Option<(i64, usize)> {
    let mut i = pos;
    // skip whitespace
    while i < bytes.len() && matches!(bytes[i], b' ' | b'\t' | b'\r' | b'\n') {
        i += 1;
    }
    if i >= bytes.len() {
        return None;
    }
    let neg = bytes[i] == b'-';
    if neg {
        i += 1;
    }
    if i >= bytes.len() || !bytes[i].is_ascii_digit() {
        return None;
    }
    let start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let num_str = std::str::from_utf8(&bytes[start..i]).ok()?;
    let val: i64 = num_str.parse().ok()?;
    Some((if neg { -val } else { val }, i - pos))
}

/// Scan `bytes` (a chunk ending at %%EOF) backwards for the `startxref`
/// keyword and return the byte offset it points to.
fn find_startxref_offset(bytes: &[u8]) -> Option<u64> {
    // Search within the last 1 KiB for "startxref"
    let search_start = bytes.len().saturating_sub(1024);
    let window = &bytes[search_start..];
    let key = b"startxref";
    // Find the LAST occurrence
    let rel_pos = window
        .windows(key.len())
        .enumerate()
        .filter(|(_, w)| *w == key)
        .map(|(i, _)| i)
        .next_back()?;
    let after = &window[rel_pos + key.len()..];
    let (offset, _) = parse_pdf_integer(after, 0)?;
    if offset < 0 {
        return None;
    }
    Some(offset as u64)
}

/// Read `n` bytes from `file` at absolute position `offset` into a `Vec<u8>`.
fn read_bytes_at(file: &mut fs::File, offset: u64, n: usize) -> std::io::Result<Vec<u8>> {
    file.seek(SeekFrom::Start(offset))?;
    let mut buf = vec![0u8; n];
    file.read_exact(&mut buf)?;
    Ok(buf)
}

/// Find a key like `/Count` or `/MediaBox` in a slice of PDF dictionary bytes
/// and return the raw bytes of its value token (up to 64 bytes).
fn find_dict_value<'a>(dict_bytes: &'a [u8], key: &[u8]) -> Option<&'a [u8]> {
    let pos = dict_bytes.windows(key.len()).position(|w| w == key)?;
    let after = &dict_bytes[pos + key.len()..];
    // skip whitespace
    let skip = after
        .iter()
        .take_while(|&&b| matches!(b, b' ' | b'\t' | b'\r' | b'\n'))
        .count();
    let start = skip;
    let end = (start + 64).min(after.len());
    Some(&after[start..end])
}

/// Extract `/Count` integer from a `/Pages` object body.
fn extract_page_count(object_bytes: &[u8]) -> Option<u32> {
    let value_bytes = find_dict_value(object_bytes, b"/Count")?;
    let (count, _) = parse_pdf_integer(value_bytes, 0)?;
    if count > 0 {
        Some(count as u32)
    } else {
        None
    }
}

/// Extract `/MediaBox` rectangle `[llx lly urx ury]` from an object body.
/// Returns `(width_pt, height_pt)`.
fn extract_mediabox(object_bytes: &[u8]) -> Option<(f32, f32)> {
    let value_bytes = find_dict_value(object_bytes, b"/MediaBox")?;
    // value_bytes starts with '[' or is an indirect reference — we only handle inline arrays
    let bracket_pos = value_bytes.iter().position(|&b| b == b'[')?;
    let inside = &value_bytes[bracket_pos + 1..];
    let end = inside
        .iter()
        .position(|&b| b == b']')
        .unwrap_or(inside.len());
    let array_bytes = &inside[..end];
    // Parse four numbers
    let mut nums: [f32; 4] = [0.0; 4];
    let mut offset = 0;
    for slot in &mut nums {
        while offset < array_bytes.len()
            && matches!(array_bytes[offset], b' ' | b'\t' | b'\r' | b'\n')
        {
            offset += 1;
        }
        if offset >= array_bytes.len() {
            return None;
        }
        // accept integers and simple decimals
        let start = offset;
        if array_bytes[offset] == b'-' {
            offset += 1;
        }
        while offset < array_bytes.len()
            && (array_bytes[offset].is_ascii_digit() || array_bytes[offset] == b'.')
        {
            offset += 1;
        }
        let tok = std::str::from_utf8(&array_bytes[start..offset]).ok()?;
        *slot = tok.parse::<f32>().ok()?;
    }
    let width = (nums[2] - nums[0]).abs();
    let height = (nums[3] - nums[1]).abs();
    if width > 0.0 && height > 0.0 {
        Some((width, height))
    } else {
        None
    }
}

/// Parse the cross-reference table (classic `xref` … `trailer`) that begins
/// at `xref_offset` inside the file and return every object's byte offset.
/// Returns `(offsets_map, root_obj_num, root_gen_num)`.
fn parse_xref_table(
    file: &mut fs::File,
    file_size: u64,
    xref_offset: u64,
) -> Option<(std::collections::HashMap<u32, u64>, u32)> {
    // Read up to 512 KiB starting at the xref table — enough for large docs
    let read_len = (512 * 1024).min((file_size.saturating_sub(xref_offset)) as usize);
    if read_len == 0 {
        return None;
    }
    let buf = read_bytes_at(file, xref_offset, read_len).ok()?;

    // Determine if this is a cross-reference stream (PDF 1.5+) or classic table
    let is_xref_stream = !buf.starts_with(b"xref");

    if is_xref_stream {
        // For XRef streams we fall back to returning only an empty map and
        // try to find the root object from a linearisation hint or brute-force
        // count from the metadata.  The page-count fallback in the caller
        // handles this gracefully.
        return None;
    }

    let mut offsets: std::collections::HashMap<u32, u64> = std::collections::HashMap::new();

    // Parse "xref\n<first_obj> <count>\n …"
    let text = std::str::from_utf8(&buf).ok()?;
    let mut lines = text.lines().peekable();
    // First line must be "xref"
    let first = lines.next()?;
    if first.trim() != "xref" {
        return None;
    }

    while let Some(h) = lines.next() {
        let header = h.trim();
        if header.starts_with("trailer") {
            break;
        }
        let mut parts = header.split_ascii_whitespace();
        let first_obj: u32 = parts.next()?.parse().ok()?;
        let count: u32 = parts.next()?.parse().ok()?;
        for i in 0..count {
            let entry = match lines.next() {
                Some(e) => e,
                None => break,
            };
            let mut eparts = entry.split_ascii_whitespace();
            let offset_str = eparts.next().unwrap_or("0");
            let _gen = eparts.next();
            let in_use = eparts.next().unwrap_or("f");
            if in_use == "n" {
                if let Ok(off) = offset_str.parse::<u64>() {
                    offsets.insert(first_obj + i, off);
                }
            }
        }
    }

    // Find /Root in trailer dictionary
    let trailer_pos = buf.windows(7).position(|w| w == b"trailer")?;
    let trailer_slice = &buf[trailer_pos..];
    let root_bytes = find_dict_value(trailer_slice, b"/Root")?;
    // /Root value is "<obj_num> <gen_num> R"
    let (root_obj_num, _) = parse_pdf_integer(root_bytes, 0)?;
    if root_obj_num <= 0 {
        return None;
    }

    Some((offsets, root_obj_num as u32))
}

/// Read and return the body of object `obj_num` (everything between `obj` …
/// `endobj` keywords) given a pre-built offset table.
fn read_object_body(
    file: &mut fs::File,
    offsets: &std::collections::HashMap<u32, u64>,
    obj_num: u32,
) -> Option<Vec<u8>> {
    let &offset = offsets.get(&obj_num)?;
    // Read up to 4 KiB — enough for any reasonable dictionary
    let buf = read_bytes_at(file, offset, 4096).ok()?;
    // Skip past "<obj_num> <gen> obj"
    let obj_marker = b"obj";
    let obj_pos = buf.windows(3).position(|w| w == obj_marker)?;
    let body_start = obj_pos + 3;
    let end = buf
        .windows(6)
        .position(|w| w == b"endobj")
        .unwrap_or(buf.len());
    Some(buf[body_start..end].to_vec())
}

pub(crate) fn prefetch_pdf_structure(path: String) -> Result<PdfStructure, String> {
    let clean = normalize_pdf_path(&path);
    let target = if clean.exists() {
        clean
    } else {
        PathBuf::from(&path)
    };

    let meta = fs::metadata(&target)
        .map_err(|e| format!("prefetch_pdf_structure: cannot stat '{target:?}': {e}"))?;
    let file_size = meta.len();

    let mut file = fs::File::open(&target)
        .map_err(|e| format!("prefetch_pdf_structure: cannot open '{target:?}': {e}"))?;

    // --- Step 1: Extract best-effort metadata from head + tail chunks ----------
    const HEAD: u64 = 65536;
    let head_len = HEAD.min(file_size) as usize;
    let head = read_bytes_at(&mut file, 0, head_len)
        .map_err(|e| format!("prefetch_pdf_structure: head read failed: {e}"))?;
    let head_meta = extract_pdf_metadata(&head);

    let tail_meta = if file_size > HEAD {
        let tail_start = file_size.saturating_sub(HEAD);
        let tail_len = (file_size - tail_start) as usize;
        let tail = read_bytes_at(&mut file, tail_start, tail_len)
            .map_err(|e| format!("prefetch_pdf_structure: tail read failed: {e}"))?;
        extract_pdf_metadata(&tail)
    } else {
        extract_pdf_metadata(&[])
    };

    let title = head_meta.title.or(tail_meta.title);
    let author = head_meta.author.or(tail_meta.author);

    // --- Step 2: Locate %%EOF trailer and startxref offset --------------------
    // Read the last 2 KiB to find "startxref"
    let eof_read_len = 2048.min(file_size as usize);
    let eof_start = file_size.saturating_sub(eof_read_len as u64);
    let eof_buf = read_bytes_at(&mut file, eof_start, eof_read_len)
        .map_err(|e| format!("prefetch_pdf_structure: eof read failed: {e}"))?;

    // --- Step 3: Parse XRef table for accurate page count and MediaBox --------
    let mut accurate_page_count: Option<u32> = None;
    let mut default_width_pt: f32 = 595.0; // A4 portrait fallback
    let mut default_height_pt: f32 = 842.0;

    if let Some(xref_offset) = find_startxref_offset(&eof_buf) {
        if let Some((offsets, root_obj_num)) = parse_xref_table(&mut file, file_size, xref_offset) {
            // Follow /Root → /Pages → /Count
            if let Some(catalog_body) = read_object_body(&mut file, &offsets, root_obj_num) {
                // /Pages value is "<pages_obj_num> <gen> R"
                if let Some(pages_ref_bytes) = find_dict_value(&catalog_body, b"/Pages") {
                    if let Some((pages_obj_num, _)) = parse_pdf_integer(pages_ref_bytes, 0) {
                        if let Some(pages_body) =
                            read_object_body(&mut file, &offsets, pages_obj_num as u32)
                        {
                            accurate_page_count = extract_page_count(&pages_body);
                        }
                    }
                }
            }

            // Find MediaBox from the first in-use object (obj 1 most likely is Page 1)
            // Try objects 1..=20 until we find a /MediaBox
            'mediabox: for candidate_obj in 1u32..=20 {
                if let Some(obj_body) = read_object_body(&mut file, &offsets, candidate_obj) {
                    if let Some((w, h)) = extract_mediabox(&obj_body) {
                        default_width_pt = w;
                        default_height_pt = h;
                        break 'mediabox;
                    }
                }
            }
        }
    }

    // Fall back to the heuristic page count if the XRef parse failed
    let total_pages = accurate_page_count
        .or(head_meta.pages)
        .or(tail_meta.pages)
        .filter(|&n| n > 0)
        .unwrap_or(1);

    Ok(PdfStructure {
        total_pages,
        default_width_pt,
        default_height_pt,
        file_size_bytes: file_size,
        title,
        author,
    })
}

fn normalize_pdf_path(raw: &str) -> PathBuf {
    let mut p = raw.trim();
    if let Some(stripped) = p.strip_prefix("file://") {
        p = stripped;
    }
    let decoded = percent_encoding::percent_decode_str(p)
        .decode_utf8_lossy()
        .to_string();
    let s = decoded.as_str();
    let s_clean = if s.len() >= 3 && s.starts_with('/') && s.chars().nth(2) == Some(':') {
        &s[1..]
    } else {
        s
    };
    PathBuf::from(s_clean)
}

pub(crate) fn read_pdf_file(path: String) -> Result<Response, String> {
    let clean = normalize_pdf_path(&path);
    let target = if clean.exists() {
        clean
    } else {
        PathBuf::from(&path)
    };
    let data =
        fs::read(&target).map_err(|e| format!("Failed to read PDF file '{target:?}': {e}"))?;
    Ok(Response::new(data))
}

pub(crate) fn read_pdf_file_size(path: String) -> Result<u64, String> {
    let clean = normalize_pdf_path(&path);
    let target = if clean.exists() {
        clean
    } else {
        PathBuf::from(&path)
    };
    fs::metadata(&target)
        .map(|metadata| metadata.len())
        .map_err(|e| format!("Failed to read PDF file metadata '{target:?}': {e}"))
}

pub(crate) fn read_pdf_range(path: String, offset: u64, length: u64) -> Result<Response, String> {
    if length == 0 {
        return Ok(Response::new(Vec::new()));
    }

    let clean = normalize_pdf_path(&path);
    let target = if clean.exists() {
        clean
    } else {
        PathBuf::from(&path)
    };

    let metadata = fs::metadata(&target)
        .map_err(|e| format!("Failed to read PDF file metadata '{target:?}': {e}"))?;
    let file_size = metadata.len();
    if offset >= file_size {
        return Ok(Response::new(Vec::new()));
    }

    let clamped_len = length.min(file_size.saturating_sub(offset));
    let read_len = usize::try_from(clamped_len).map_err(|_| {
        format!(
            "Requested PDF range is too large for this platform: {}",
            clamped_len
        )
    })?;

    let mut file = fs::File::open(&target)
        .map_err(|e| format!("Failed to open PDF file '{target:?}': {e}"))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("Failed to seek PDF file '{target:?}': {e}"))?;

    let mut buffer = vec![0_u8; read_len];
    file.read_exact(&mut buffer)
        .map_err(|e| format!("Failed to read PDF range from '{target:?}': {e}"))?;

    Ok(Response::new(buffer))
}

pub(crate) fn get_pdf_metadata(path: String) -> Result<PdfMetadata, String> {
    let metadata = fs::metadata(&path)
        .map_err(|e| format!("Failed to read PDF file metadata '{}': {}", path, e))?;
    let file_size = metadata.len();

    const HEAD_SIZE: u64 = 65536;
    let first_chunk_size = HEAD_SIZE.min(file_size);

    let mut file =
        fs::File::open(&path).map_err(|e| format!("Failed to open PDF file '{}': {}", path, e))?;

    let mut first_bytes = vec![0_u8; first_chunk_size as usize];
    file.read_exact(&mut first_bytes)
        .map_err(|e| format!("Failed to read PDF header from '{}': {}", path, e))?;

    let metadata = extract_pdf_metadata(&first_bytes);

    if metadata.title.is_none() && file_size > HEAD_SIZE {
        let tail_size = HEAD_SIZE.min(file_size);
        let tail_offset = file_size.saturating_sub(tail_size);

        file.seek(SeekFrom::Start(tail_offset))
            .map_err(|e| format!("Failed to seek PDF tail '{}': {}", path, e))?;

        let mut tail_bytes = vec![0_u8; tail_size as usize];
        file.read_exact(&mut tail_bytes)
            .map_err(|e| format!("Failed to read PDF tail from '{}': {}", path, e))?;

        let tail_metadata = extract_pdf_metadata(&tail_bytes);

        let title = metadata.title.or(tail_metadata.title);
        let author = metadata.author.or(tail_metadata.author);
        let creator = metadata.creator.or(tail_metadata.creator);
        let producer = metadata.producer.or(tail_metadata.producer);
        let creation_date = metadata.creation_date.or(tail_metadata.creation_date);
        let modification_date = metadata
            .modification_date
            .or(tail_metadata.modification_date);

        return Ok(PdfMetadata {
            title,
            author,
            pages: metadata.pages,
            creator,
            producer,
            creation_date,
            modification_date,
        });
    }

    Ok(metadata)
}

fn extract_pdf_metadata(bytes: &[u8]) -> PdfMetadata {
    let content = String::from_utf8_lossy(bytes);

    let pages = content
        .matches("/Type /Page")
        .count()
        .try_into()
        .ok()
        .filter(|&n: &u32| n > 0);

    let title = extract_pdf_string(&content, "/Title");
    let author = extract_pdf_string(&content, "/Author");
    let creator = extract_pdf_string(&content, "/Creator");
    let producer = extract_pdf_string(&content, "/Producer");
    let creation_date = extract_pdf_string(&content, "/CreationDate");
    let modification_date = extract_pdf_string(&content, "/ModDate");

    PdfMetadata {
        title,
        author,
        pages,
        creator,
        producer,
        creation_date,
        modification_date,
    }
}

fn extract_pdf_string(content: &str, key: &str) -> Option<String> {
    if let Some(pos) = content.find(key) {
        let after_key = &content[pos + key.len()..];
        let trimmed = after_key.trim_start();

        if let Some(rest) = trimmed.strip_prefix('(') {
            if let Some(end_pos) = find_closing_paren(rest) {
                let value = &rest[..end_pos];
                return Some(decode_pdf_string(value));
            }
        }

        if let Some(rest) = trimmed.strip_prefix('<') {
            if let Some(end_pos) = rest.find('>') {
                let hex = &rest[..end_pos];
                return decode_hex_string(hex);
            }
        }
    }
    None
}

fn find_closing_paren(s: &str) -> Option<usize> {
    let mut depth = 1;
    let mut escaped = false;

    for (i, c) in s.chars().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }

        match c {
            '\\' => escaped = true,
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

fn decode_pdf_string(s: &str) -> String {
    let mut result = String::new();
    let mut chars = s.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => result.push('\n'),
                Some('r') => result.push('\r'),
                Some('t') => result.push('\t'),
                Some('b') => result.push('\x08'),
                Some('f') => result.push('\x0c'),
                Some('\n') => {}
                Some(d) if d.is_ascii_digit() => {
                    let mut octal = String::new();
                    octal.push(d);
                    for _ in 0..2 {
                        if let Some(&next) = chars.peek() {
                            if next.is_ascii_digit() {
                                if let Some(digit) = chars.next() {
                                    octal.push(digit);
                                }
                            } else {
                                break;
                            }
                        }
                    }
                    if let Ok(val) = u8::from_str_radix(&octal, 8) {
                        result.push(val as char);
                    }
                }
                Some(c) => result.push(c),
                None => break,
            }
        } else {
            result.push(c);
        }
    }

    result
}

fn decode_hex_string(hex: &str) -> Option<String> {
    let cleaned: String = hex.chars().filter(|c| !c.is_whitespace()).collect();

    (0..cleaned.len())
        .step_by(2)
        .map(|i| {
            let byte_str = &cleaned[i..i + 2.min(cleaned.len() - i)];
            u8::from_str_radix(byte_str, 16).ok()
        })
        .collect::<Option<Vec<u8>>>()
        .and_then(|bytes| {
            if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
                let units: Vec<u16> = bytes[2..]
                    .chunks_exact(2)
                    .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
                    .collect();
                Some(String::from_utf16_lossy(&units))
            } else if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
                let units: Vec<u16> = bytes[2..]
                    .chunks_exact(2)
                    .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
                    .collect();
                Some(String::from_utf16_lossy(&units))
            } else {
                String::from_utf8(bytes.clone())
                    .ok()
                    .or_else(|| Some(String::from_utf8_lossy(&bytes).into_owned()))
            }
        })
}
