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

/// Read up to `n` bytes from `file` starting at `offset`, stopping cleanly at EOF.
fn read_up_to(file: &mut fs::File, offset: u64, n: usize) -> std::io::Result<Vec<u8>> {
    file.seek(SeekFrom::Start(offset))?;
    let mut buf = Vec::new();
    file.take(n as u64).read_to_end(&mut buf)?;
    Ok(buf)
}

/// Locate a PDF dictionary value by key (`key` such as `b"/Count"`),
/// ensuring the key ends on a PDF delimiter/whitespace boundary so `/Page`
/// never matches `/Pages`.
fn find_dict_value<'a>(dict_bytes: &'a [u8], key: &[u8]) -> Option<&'a [u8]> {
    let mut search_from = 0;
    while let Some(rel) = dict_bytes[search_from..]
        .windows(key.len())
        .position(|w| w == key)
    {
        let pos = search_from + rel;
        let after = &dict_bytes[pos + key.len()..];
        let boundary = after.first().copied().is_none_or(|b| {
            matches!(
                b,
                b' ' | b'\t' | b'\r' | b'\n' | b'/' | b'[' | b'<' | b'(' | b'>' | b']'
            )
        });
        if boundary {
            let skip = after
                .iter()
                .take_while(|&&b| matches!(b, b' ' | b'\t' | b'\r' | b'\n'))
                .count();
            let start = skip;
            let end = (start + 128).min(after.len());
            return Some(&after[start..end]);
        }
        search_from = pos + key.len();
    }
    None
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

const MAX_XREF_BYTES: u64 = 16 * 1024 * 1024;
const MAX_OBJSTM_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Copy)]
enum ObjLoc {
    Offset(u64),
    Compressed { stream_obj: u32, obj_index: u32 },
}

fn parse_pdf_int_array(bytes: &[u8]) -> Option<Vec<i64>> {
    let start = bytes.iter().position(|&b| b == b'[')?;
    let rest = &bytes[start + 1..];
    let end = rest.iter().position(|&b| b == b']')?;
    let mut vals = Vec::new();
    let mut i = 0;
    let slice = &rest[..end];
    while i < slice.len() {
        while i < slice.len() && matches!(slice[i], b' ' | b'\t' | b'\r' | b'\n') {
            i += 1;
        }
        if i >= slice.len() {
            break;
        }
        let (v, consumed) = parse_pdf_integer(slice, i)?;
        vals.push(v);
        i += consumed;
    }
    Some(vals)
}

fn read_be_u64(bytes: &[u8]) -> u64 {
    let mut v = 0u64;
    for &b in bytes {
        v = (v << 8) | u64::from(b);
    }
    v
}

fn unfilter_png_rows(raw: &[u8], row_len: usize) -> Option<Vec<u8>> {
    if row_len == 0 {
        return None;
    }
    let stride = row_len.checked_add(1)?;
    if raw.is_empty() || !raw.len().is_multiple_of(stride) {
        return None;
    }
    let row_count = raw.len() / stride;
    let mut out = Vec::with_capacity(row_count.saturating_mul(row_len));
    let mut prev = vec![0u8; row_len];
    for r in 0..row_count {
        let row_slice = &raw[r * stride..(r + 1) * stride];
        let filter = row_slice[0];
        let src = &row_slice[1..];
        let mut cur = vec![0u8; row_len];
        for i in 0..row_len {
            let a = if i > 0 { cur[i - 1] } else { 0 };
            let b = prev[i];
            let c = if i > 0 { prev[i - 1] } else { 0 };
            let recon = match filter {
                0 => src[i],
                1 => src[i].wrapping_add(a),
                2 => src[i].wrapping_add(b),
                3 => src[i].wrapping_add(((u16::from(a) + u16::from(b)) / 2) as u8),
                4 => {
                    let p = i32::from(a) + i32::from(b) - i32::from(c);
                    let pa = (p - i32::from(a)).abs();
                    let pb = (p - i32::from(b)).abs();
                    let pc = (p - i32::from(c)).abs();
                    let pr = if pa <= pb && pa <= pc {
                        a
                    } else if pb <= pc {
                        b
                    } else {
                        c
                    };
                    src[i].wrapping_add(pr)
                }
                _ => return None,
            };
            cur[i] = recon;
        }
        out.extend_from_slice(&cur);
        prev = cur;
    }
    Some(out)
}

fn decode_pdf_stream(header: &[u8], payload: &[u8], max_decoded: u64) -> Option<Vec<u8>> {
    let raw = if let Some(filter) = find_dict_value(header, b"/Filter") {
        let trimmed = filter.trim_ascii_start();
        if trimmed.starts_with(b"/FlateDecode") {
            let mut decoder = flate2::read::ZlibDecoder::new(payload);
            let mut decoded = Vec::new();
            let mut limited = (&mut decoder).take(max_decoded.saturating_add(1));
            limited.read_to_end(&mut decoded).ok()?;
            if decoded.len() as u64 > max_decoded {
                return None;
            }
            decoded
        } else {
            return None;
        }
    } else {
        payload.to_vec()
    };

    if let Some(pred_bytes) = find_dict_value(header, b"/Predictor") {
        if let Some((pred, _)) = parse_pdf_integer(pred_bytes, 0) {
            if pred >= 10 {
                let cols = find_dict_value(header, b"/Columns")
                    .and_then(|v| parse_pdf_integer(v, 0))
                    .map(|(n, _)| n)
                    .unwrap_or(1);
                if cols <= 0 {
                    return None;
                }
                return unfilter_png_rows(&raw, cols as usize);
            }
        }
    }
    Some(raw)
}

fn extract_stream_slices(buf: &[u8]) -> Option<(&[u8], &[u8])> {
    let stream_pos = buf.windows(6).position(|w| w == b"stream")?;
    let header = &buf[..stream_pos];
    let mut data_start = stream_pos + 6;
    if buf.get(data_start) == Some(&b'\r') && buf.get(data_start + 1) == Some(&b'\n') {
        data_start += 2;
    } else if matches!(buf.get(data_start), Some(&b'\n' | &b'\r')) {
        data_start += 1;
    }
    let payload_after_kw = &buf[data_start..];
    let declared_len = find_dict_value(header, b"/Length")
        .and_then(|v| parse_pdf_integer(v, 0))
        .and_then(|(n, _)| (n >= 0).then_some(n as usize));
    if let Some(len) = declared_len {
        if len <= payload_after_kw.len() {
            return Some((header, &payload_after_kw[..len]));
        }
    }
    let end_rel = payload_after_kw
        .windows(9)
        .position(|w| w == b"endstream")?;
    let trimmed = payload_after_kw[..end_rel]
        .strip_suffix(b"\r\n")
        .or_else(|| payload_after_kw[..end_rel].strip_suffix(b"\n"))
        .or_else(|| payload_after_kw[..end_rel].strip_suffix(b"\r"))
        .unwrap_or(&payload_after_kw[..end_rel]);
    Some((header, trimmed))
}

fn parse_xref_stream_section(
    buf: &[u8],
    offsets: &mut std::collections::HashMap<u32, ObjLoc>,
) -> Option<(Option<u32>, Option<u64>)> {
    let (header, stream_payload) = extract_stream_slices(buf)?;
    let typ = find_dict_value(header, b"/Type")?;
    if !typ.trim_ascii_start().starts_with(b"/XRef") {
        return None;
    }

    let w_vals = parse_pdf_int_array(find_dict_value(header, b"/W")?)?;
    if w_vals.len() != 3 || w_vals.iter().any(|&w| !(0..=8).contains(&w)) {
        return None;
    }
    let w0 = w_vals[0] as usize;
    let w1 = w_vals[1] as usize;
    let w2 = w_vals[2] as usize;
    let entry_size = w0 + w1 + w2;
    if entry_size == 0 || entry_size > 24 {
        return None;
    }

    let size = find_dict_value(header, b"/Size")
        .and_then(|v| parse_pdf_integer(v, 0))
        .and_then(|(n, _)| (n >= 0).then_some(n))?;
    let index_pairs = find_dict_value(header, b"/Index")
        .and_then(parse_pdf_int_array)
        .unwrap_or_else(|| vec![0, size]);
    if !index_pairs.len().is_multiple_of(2) {
        return None;
    }

    let decoded = decode_pdf_stream(header, stream_payload, MAX_XREF_BYTES)?;
    let mut pos = 0usize;
    for pair in index_pairs.chunks_exact(2) {
        let Ok(first_obj) = u32::try_from(pair[0]) else {
            return None;
        };
        let Ok(count) = u32::try_from(pair[1]) else {
            return None;
        };
        for idx in 0..count {
            let end = pos.checked_add(entry_size)?;
            if end > decoded.len() {
                break;
            }
            let row = &decoded[pos..end];
            pos = end;
            let entry_type = if w0 == 0 { 1 } else { read_be_u64(&row[..w0]) };
            let field1 = read_be_u64(&row[w0..w0 + w1]);
            let field2 = read_be_u64(&row[w0 + w1..w0 + w1 + w2]);
            let obj_num = first_obj.saturating_add(idx);
            match entry_type {
                1 => {
                    offsets.entry(obj_num).or_insert(ObjLoc::Offset(field1));
                }
                2 => {
                    if let (Ok(stream_obj), Ok(obj_index)) =
                        (u32::try_from(field1), u32::try_from(field2))
                    {
                        offsets.entry(obj_num).or_insert(ObjLoc::Compressed {
                            stream_obj,
                            obj_index,
                        });
                    }
                }
                _ => {}
            }
        }
    }

    let root_obj = find_dict_value(header, b"/Root")
        .and_then(|v| parse_pdf_integer(v, 0))
        .and_then(|(n, _)| u32::try_from(n).ok().filter(|&id| id > 0));
    let prev_off = find_dict_value(header, b"/Prev")
        .and_then(|v| parse_pdf_integer(v, 0))
        .and_then(|(n, _)| u64::try_from(n).ok());

    Some((root_obj, prev_off))
}

/// Parse the cross-reference table (`xref` … `trailer`) or PDF 1.5+ `/Type /XRef`
/// stream starting at `xref_offset` and follow up to 8 `/Prev` revisions.
fn parse_xref_table(
    file: &mut fs::File,
    file_size: u64,
    xref_offset: u64,
) -> Option<(std::collections::HashMap<u32, ObjLoc>, u32)> {
    let mut offsets: std::collections::HashMap<u32, ObjLoc> = std::collections::HashMap::new();
    let mut root_obj_num: Option<u32> = None;
    let mut current_off = Some(xref_offset);

    for _hop in 0..8 {
        let Some(off) = current_off else { break };
        if off >= file_size {
            break;
        }
        let read_len = file_size.saturating_sub(off).min(1024 * 1024) as usize;
        if read_len == 0 {
            break;
        }
        let buf = read_up_to(file, off, read_len).ok()?;

        if !buf.starts_with(b"xref") {
            let (root_opt, prev_opt) = parse_xref_stream_section(&buf, &mut offsets)?;
            if root_obj_num.is_none() {
                root_obj_num = root_opt;
            }
            current_off = prev_opt;
            continue;
        }

        let text = std::str::from_utf8(&buf).ok()?;
        let mut lines = text.lines();
        if lines.next()?.trim() != "xref" {
            return None;
        }

        while let Some(h) = lines.next() {
            let header = h.trim();
            if header.starts_with("trailer") {
                break;
            }
            let mut parts = header.split_ascii_whitespace();
            let Some(first_s) = parts.next() else {
                continue;
            };
            let Some(count_s) = parts.next() else {
                continue;
            };
            let first_obj: u32 = first_s.parse().ok()?;
            let count: u32 = count_s.parse().ok()?;
            for i in 0..count {
                let Some(entry) = lines.next() else { break };
                let mut eparts = entry.split_ascii_whitespace();
                let offset_str = eparts.next().unwrap_or("0");
                let _gen = eparts.next();
                let in_use = eparts.next().unwrap_or("f");
                if in_use == "n" {
                    if let Ok(obj_off) = offset_str.parse::<u64>() {
                        offsets
                            .entry(first_obj + i)
                            .or_insert(ObjLoc::Offset(obj_off));
                    }
                }
            }
        }

        let trailer_pos = buf.windows(7).position(|w| w == b"trailer")?;
        let trailer_slice = &buf[trailer_pos..];
        if root_obj_num.is_none() {
            root_obj_num = find_dict_value(trailer_slice, b"/Root")
                .and_then(|v| parse_pdf_integer(v, 0))
                .and_then(|(n, _)| u32::try_from(n).ok().filter(|&id| id > 0));
        }
        current_off = find_dict_value(trailer_slice, b"/Prev")
            .and_then(|v| parse_pdf_integer(v, 0))
            .and_then(|(n, _)| u64::try_from(n).ok());
    }

    root_obj_num.map(|root| (offsets, root))
}

/// Read and return the body of object `obj_num` (classic offset or PDF 1.5+ `/ObjStm`).
fn read_object_body(
    file: &mut fs::File,
    offsets: &std::collections::HashMap<u32, ObjLoc>,
    obj_num: u32,
) -> Option<Vec<u8>> {
    match *offsets.get(&obj_num)? {
        ObjLoc::Offset(offset) => {
            let buf = read_up_to(file, offset, 8192).ok()?;
            let obj_pos = buf.windows(3).position(|w| w == b"obj")?;
            let body_start = obj_pos + 3;
            let body_slice = &buf[body_start..];
            let end_rel = body_slice
                .windows(6)
                .position(|w| w == b"endobj")
                .unwrap_or(body_slice.len());
            Some(body_slice[..end_rel].to_vec())
        }
        ObjLoc::Compressed {
            stream_obj,
            obj_index,
        } => {
            let ObjLoc::Offset(stm_off) = *offsets.get(&stream_obj)? else {
                return None;
            };
            let stm_buf = read_up_to(file, stm_off, 512 * 1024).ok()?;
            let (header, stream_payload) = extract_stream_slices(&stm_buf)?;
            let n = find_dict_value(header, b"/N")
                .and_then(|v| parse_pdf_integer(v, 0))
                .and_then(|(v, _)| u32::try_from(v).ok())?;
            let first = find_dict_value(header, b"/First")
                .and_then(|v| parse_pdf_integer(v, 0))
                .and_then(|(v, _)| usize::try_from(v).ok())?;
            if obj_index >= n {
                return None;
            }
            let decoded = decode_pdf_stream(header, stream_payload, MAX_OBJSTM_BYTES)?;
            if first > decoded.len() {
                return None;
            }
            let header_slice = &decoded[..first];
            let mut cur = 0usize;
            let mut entries = Vec::with_capacity(n as usize);
            for _ in 0..n {
                while cur < header_slice.len()
                    && matches!(header_slice[cur], b' ' | b'\t' | b'\r' | b'\n')
                {
                    cur += 1;
                }
                let (_id, c1) = parse_pdf_integer(header_slice, cur)?;
                cur += c1;
                while cur < header_slice.len()
                    && matches!(header_slice[cur], b' ' | b'\t' | b'\r' | b'\n')
                {
                    cur += 1;
                }
                let (rel_off, c2) = parse_pdf_integer(header_slice, cur)?;
                cur += c2;
                entries.push(usize::try_from(rel_off).ok()?);
            }
            let start = first.checked_add(*entries.get(obj_index as usize)?)?;
            let end = if (obj_index as usize + 1) < entries.len() {
                first
                    .checked_add(entries[obj_index as usize + 1])?
                    .min(decoded.len())
            } else {
                decoded.len()
            };
            if start >= end || end > decoded.len() {
                return None;
            }
            Some(decoded[start..end].to_vec())
        }
    }
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
    let head = read_up_to(&mut file, 0, head_len)
        .map_err(|e| format!("prefetch_pdf_structure: head read failed: {e}"))?;
    let head_meta = extract_pdf_metadata(&head);

    let tail_meta = if file_size > HEAD {
        let tail_start = file_size.saturating_sub(HEAD);
        let tail_len = (file_size - tail_start) as usize;
        let tail = read_up_to(&mut file, tail_start, tail_len)
            .map_err(|e| format!("prefetch_pdf_structure: tail read failed: {e}"))?;
        extract_pdf_metadata(&tail)
    } else {
        extract_pdf_metadata(&[])
    };

    let title = head_meta.title.or(tail_meta.title);
    let author = head_meta.author.or(tail_meta.author);

    // --- Step 2: Locate %%EOF trailer and startxref offset --------------------
    // Read the last 2 KiB to find "startxref"
    let eof_read_len = file_size.min(2048) as usize;
    let eof_start = file_size.saturating_sub(eof_read_len as u64);
    let eof_buf = read_up_to(&mut file, eof_start, eof_read_len)
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
        .match_indices("/Type /Page")
        .filter(|&(idx, _)| !content[idx..].starts_with("/Type /Pages"))
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

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::ZlibEncoder;
    use flate2::Compression;
    use std::io::Write;

    #[test]
    fn xref_stream_with_png_predictor_and_objstm_resolves_exact_page_count() {
        // Object 1 (/Catalog -> /Pages 2 0 R) and Object 2 (/Pages -> /Count 42)
        // live inside compressed /ObjStm object 3; Object 4 is the /Type /XRef stream.
        let stm_header = b"1 0 2 34 ";
        let obj1 = b"<< /Type /Catalog /Pages 2 0 R >>\n";
        let obj2 = b"<< /Type /Pages /Count 42 >>\n";
        let mut objstm_plain = Vec::new();
        objstm_plain.extend_from_slice(stm_header);
        objstm_plain.extend_from_slice(obj1);
        objstm_plain.extend_from_slice(obj2);

        let mut pdf = b"%PDF-1.5\n%\xE2\xE3\xCF\xD3\n".to_vec();
        let obj3_off = pdf.len();
        pdf.extend_from_slice(
            format!(
                "3 0 obj\n<< /Type /ObjStm /N 2 /First {} /Length {} >>\nstream\n",
                stm_header.len(),
                objstm_plain.len()
            )
            .as_bytes(),
        );
        pdf.extend_from_slice(&objstm_plain);
        pdf.extend_from_slice(b"\nendstream\nendobj\n");

        // XRef rows for objs 0..=4 with W = [1 4 2] (row_len = 7) encoded with PNG Up filter (0x02)
        let xref_rows: [[u8; 7]; 5] = [
            [0, 0, 0, 0, 0, 255, 255],
            [2, 0, 0, 0, 3, 0, 0], // obj 1 -> compressed in obj 3 index 0
            [2, 0, 0, 0, 3, 0, 1], // obj 2 -> compressed in obj 3 index 1
            [
                1,
                ((obj3_off >> 24) & 0xff) as u8,
                ((obj3_off >> 16) & 0xff) as u8,
                ((obj3_off >> 8) & 0xff) as u8,
                (obj3_off & 0xff) as u8,
                0,
                0,
            ],
            [0, 0, 0, 0, 0, 0, 0],
        ];
        let mut unfiltered = Vec::new();
        let mut prev = [0u8; 7];
        for row in xref_rows {
            unfiltered.push(2); // PNG Up filter byte
            for i in 0..7 {
                unfiltered.push(row[i].wrapping_sub(prev[i]));
            }
            prev = row;
        }
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
        enc.write_all(&unfiltered).unwrap();
        let xref_compressed = enc.finish().unwrap();

        let xref_off = pdf.len();
        pdf.extend_from_slice(
            format!(
                "4 0 obj\n<< /Type /XRef /Size 5 /W [1 4 2] /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 7 >> /Root 1 0 R /Length {} >>\nstream\n",
                xref_compressed.len()
            )
            .as_bytes(),
        );
        pdf.extend_from_slice(&xref_compressed);
        pdf.extend_from_slice(
            format!("\nendstream\nendobj\nstartxref\n{xref_off}\n%%EOF\n").as_bytes(),
        );

        let tmp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(tmp.path(), &pdf).unwrap();
        let structure = prefetch_pdf_structure(tmp.path().to_string_lossy().into_owned()).unwrap();
        assert_eq!(structure.total_pages, 42);
    }
}
