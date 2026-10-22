use image::GenericImageView;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::File;
use std::io::{Cursor, Read};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeBookRecord {
    pub id: String,
    pub title: String,
    pub author: String,
    #[serde(rename = "filePath")]
    pub file_path: String,
    #[serde(rename = "storagePath", skip_serializing_if = "Option::is_none")]
    pub storage_path: Option<String>,
    pub format: String,
    #[serde(rename = "contentHash", skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    #[serde(rename = "coverPath", skip_serializing_if = "Option::is_none")]
    pub cover_path: Option<String>,
    #[serde(rename = "coverExtractionDone")]
    pub cover_extraction_done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(rename = "publishedDate", skip_serializing_if = "Option::is_none")]
    pub published_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isbn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series: Option<String>,
    #[serde(rename = "seriesIndex", skip_serializing_if = "Option::is_none")]
    pub series_index: Option<f64>,
    #[serde(rename = "fileSize")]
    pub file_size: u64,
    #[serde(rename = "addedAt")]
    pub added_at: String,
    pub progress: f64,
    #[serde(rename = "isFavorite")]
    pub is_favorite: bool,
    pub tags: Vec<String>,
}

/// Compute SHA-256 hash of a file streaming in 64KB blocks
pub fn compute_file_sha256(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];

    // A read error must not yield the hash of half a file.
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => hasher.update(&buffer[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return None,
        }
    }

    Some(hex::encode(hasher.finalize()))
}

const COVER_MAX_W: u32 = 360;
const COVER_MAX_H: u32 = 540;
const COVER_JPEG_QUALITY: u8 = 75;

/// The largest size within `max_w` x `max_h` with the image's aspect ratio
/// (never upscaled, never zero).
fn fit_within(width: u32, height: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    if width <= max_w && height <= max_h {
        return (width, height);
    }
    let (w, h, mw, mh) = (width as u64, height as u64, max_w as u64, max_h as u64);
    // Compare max_w / w with max_h / h without floating point.
    if mw * h <= mh * w {
        (max_w, ((h * mw + w / 2) / w).clamp(1, mh) as u32)
    } else {
        (((w * mh + h / 2) / h).clamp(1, mw) as u32, max_h)
    }
}

/// Area-average (box filter) downscale of packed RGB8 pixels. One pass over
/// the source with integer sums: several times faster than the `image`
/// crate's generic float resampler, and the same result at thumbnail size.
fn box_downscale_rgb(src: &[u8], width: u32, height: u32, out_w: u32, out_h: u32) -> Vec<u8> {
    let (w, h, ow, oh) = (
        width as usize,
        height as usize,
        out_w as usize,
        out_h as usize,
    );
    // Source column span of each output column.
    let x_bounds: Vec<(usize, usize)> = (0..ow)
        .map(|ox| {
            let x0 = ox * w / ow;
            let x1 = ((ox + 1) * w / ow).max(x0 + 1);
            (x0, x1)
        })
        .collect();
    let mut out = vec![0u8; ow * oh * 3];
    let mut sums = vec![0u32; ow * 3];
    for oy in 0..oh {
        let y0 = oy * h / oh;
        let y1 = ((oy + 1) * h / oh).max(y0 + 1);
        sums.fill(0);
        for row in src[y0 * w * 3..y1 * w * 3].chunks_exact(w * 3) {
            for (ox, &(x0, x1)) in x_bounds.iter().enumerate() {
                let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
                for px in row[x0 * 3..x1 * 3].chunks_exact(3) {
                    r += px[0] as u32;
                    g += px[1] as u32;
                    b += px[2] as u32;
                }
                let s = &mut sums[ox * 3..ox * 3 + 3];
                s[0] += r;
                s[1] += g;
                s[2] += b;
            }
        }
        let rows = (y1 - y0) as u32;
        let dst = &mut out[oy * ow * 3..(oy + 1) * ow * 3];
        for (ox, &(x0, x1)) in x_bounds.iter().enumerate() {
            let n = rows * (x1 - x0) as u32;
            for c in 0..3 {
                dst[ox * 3 + c] = ((sums[ox * 3 + c] + n / 2) / n) as u8;
            }
        }
    }
    out
}

/// Downsample image bytes to fit 360x540 and return a JPEG data URL.
pub fn downsample_cover_to_data_url(bytes: &[u8]) -> Option<String> {
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let img = reader.decode().ok()?;
    let (width, height) = img.dimensions();
    if width == 0 || height == 0 {
        return None;
    }

    let (out_w, out_h) = fit_within(width, height, COVER_MAX_W, COVER_MAX_H);
    let rgb = img.into_rgb8();
    let pixels = if (out_w, out_h) == (width, height) {
        rgb.into_raw()
    } else {
        box_downscale_rgb(rgb.as_raw(), width, height, out_w, out_h)
    };

    // jpeg-encoder is several times faster than the `image` crate's encoder.
    let mut jpeg_buf = Vec::with_capacity(pixels.len() / 8);
    jpeg_encoder::Encoder::new(&mut jpeg_buf, COVER_JPEG_QUALITY)
        .encode(
            &pixels,
            u16::try_from(out_w).ok()?,
            u16::try_from(out_h).ok()?,
            jpeg_encoder::ColorType::Rgb,
        )
        .ok()?;

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg_buf);
    Some(format!("data:image/jpeg;base64,{b64}"))
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSERS FOR INDIVIDUAL FORMATS
// ─────────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ParsedMetadata {
    pub(crate) title: String,
    pub(crate) author: String,
    pub(crate) description: Option<String>,
    pub(crate) publisher: Option<String>,
    pub(crate) published_date: Option<String>,
    pub(crate) language: Option<String>,
    pub(crate) isbn: Option<String>,
    pub(crate) cover_data_url: Option<String>,
    pub(crate) series: Option<String>,
    pub(crate) series_index: Option<f64>,
}

/// Check that `path` is an EPUB a reader can open: a ZIP archive with an OPF
/// package. Cheap (no cover decode), for importers that do not parse
/// metadata natively; the error reads like the desktop importer's.
pub(crate) fn check_epub_readable(path: &Path) -> Result<(), String> {
    let fail = |reason: String| format!("Could not read this book: {reason}");
    let file = File::open(path).map_err(|e| fail(format!("Failed to open EPUB: {e}")))?;
    let mut archive = crate::zip_util::open_zip_archive(file)
        .map_err(|e| fail(format!("Invalid EPUB ZIP: {e}")))?;
    let mut container = String::new();
    if let Ok(mut entry) = archive.by_name("META-INF/container.xml") {
        let _ = entry.read_to_string(&mut container);
    }
    let opf = extract_opf_path_from_container(&container);
    if !opf.is_empty() && archive.by_name(&opf).is_ok() {
        return Ok(());
    }
    let has_opf = (0..archive.len()).any(|i| {
        archive
            .by_index(i)
            .ok()
            .and_then(|entry| entry.name().ok().map(|n| n.ends_with(".opf")))
            .unwrap_or(false)
    });
    if has_opf {
        Ok(())
    } else {
        Err(fail("OPF rootfile not found in EPUB".to_string()))
    }
}

/// Extract metadata & cover from an EPUB file using streaming XML
pub(crate) fn parse_epub_native(path: &Path) -> Result<ParsedMetadata, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open EPUB: {e}"))?;
    let mut archive =
        crate::zip_util::open_zip_archive(file).map_err(|e| format!("Invalid EPUB ZIP: {e}"))?;

    // 1. Locate rootfile from META-INF/container.xml
    let mut opf_path = String::new();
    if let Ok(mut container) = archive.by_name("META-INF/container.xml") {
        let mut content = String::new();
        if container.read_to_string(&mut content).is_ok() {
            opf_path = extract_opf_path_from_container(&content);
        }
    }

    if opf_path.is_empty() {
        // Fallback: search for any .opf file in the archive
        for i in 0..archive.len() {
            if let Ok(entry) = archive.by_index(i) {
                let Ok(name) = entry.name() else { continue };
                if name.ends_with(".opf") {
                    opf_path = name.to_string();
                    break;
                }
            }
        }
    }

    if opf_path.is_empty() {
        return Err("OPF rootfile not found in EPUB".to_string());
    }

    // 2. Read and parse OPF content
    let (opf_content, opf_dir) = {
        let mut opf_entry = archive
            .by_name(&opf_path)
            .map_err(|e| format!("Failed to read OPF '{opf_path}': {e}"))?;
        let mut buf = String::new();
        opf_entry
            .read_to_string(&mut buf)
            .map_err(|e| format!("Failed to read OPF string: {e}"))?;
        let dir = Path::new(&opf_path)
            .parent()
            .unwrap_or(Path::new(""))
            .to_string_lossy()
            .to_string();
        (buf, dir)
    };

    let opf_meta = parse_opf_xml(&opf_content);
    let mut title = opf_meta.title;
    let mut author = opf_meta.author;
    let description = opf_meta.description;
    let publisher = opf_meta.publisher;
    let published_date = opf_meta.published_date;
    let language = opf_meta.language;
    let isbn = opf_meta.isbn;
    let cover_href = opf_meta.cover_href;
    let series = opf_meta.series;
    let series_index = opf_meta.series_index;

    // Fallback title / author from filename if missing or empty
    if title.trim().is_empty() || title.eq_ignore_ascii_case("unknown") {
        let (fname_title, fname_author) = parse_title_author_from_filename(path);
        title = fname_title;
        if author.trim().is_empty() || author.eq_ignore_ascii_case("unknown") {
            author = fname_author;
        }
    }
    if author.trim().is_empty() {
        author = "Unknown Author".to_string();
    }

    // 3. Extract cover image if found
    let mut cover_data_url = None;
    if let Some(href) = cover_href {
        let full_cover_path = if opf_dir.is_empty() {
            href
        } else {
            format!("{opf_dir}/{href}")
        };

        // Normalize path
        let norm_path = full_cover_path.replace('\\', "/");
        if let Ok(mut cover_entry) = archive.by_name(&norm_path) {
            let mut cover_bytes = Vec::new();
            if cover_entry.read_to_end(&mut cover_bytes).is_ok() {
                cover_data_url = downsample_cover_to_data_url(&cover_bytes);
            }
        }
    }

    // If still no cover, search for files named cover.jpg, cover.png, etc.
    if cover_data_url.is_none() {
        let mut candidate_cover_name = None;
        for i in 0..archive.len() {
            if let Ok(entry) = archive.by_index(i) {
                let Ok(name) = entry.name() else { continue };
                let lower = name.to_lowercase();
                if (lower.ends_with(".jpg")
                    || lower.ends_with(".jpeg")
                    || lower.ends_with(".png")
                    || lower.ends_with(".webp"))
                    && (lower.contains("cover") || lower.contains("thumb"))
                {
                    candidate_cover_name = Some(name.to_string());
                    break;
                }
            }
        }

        if let Some(name) = candidate_cover_name {
            if let Ok(mut cover_entry) = archive.by_name(&name) {
                let mut bytes = Vec::new();
                if cover_entry.read_to_end(&mut bytes).is_ok() {
                    cover_data_url = downsample_cover_to_data_url(&bytes);
                }
            }
        }
    }

    Ok(ParsedMetadata {
        title,
        author,
        description,
        publisher,
        published_date,
        language,
        isbn,
        cover_data_url,
        series,
        series_index,
    })
}

/// Extract metadata & cover from a CBZ comic archive
pub(crate) fn parse_cbz_native(path: &Path) -> Result<ParsedMetadata, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open CBZ: {e}"))?;
    let mut archive =
        crate::zip_util::open_zip_archive(file).map_err(|e| format!("Invalid CBZ ZIP: {e}"))?;

    let (mut title, author) = parse_title_author_from_filename(path);
    let mut cover_data_url = None;
    let mut series = None;
    let mut series_index = None;

    // Check for ComicInfo.xml
    if let Ok(mut comic_info) = archive.by_name("ComicInfo.xml") {
        let mut xml_str = String::new();
        if comic_info.size() <= 1024 * 1024 && comic_info.read_to_string(&mut xml_str).is_ok() {
            if let Some(t) = extract_xml_tag_text(&xml_str, "Title") {
                if !t.trim().is_empty() {
                    title = t;
                }
            }
            if let Some(s) = extract_xml_tag_text(&xml_str, "Series") {
                if !s.trim().is_empty() {
                    series = Some(s);
                }
            }
            if let Some(num_str) = extract_xml_tag_text(&xml_str, "Number") {
                if let Ok(idx) = num_str.trim().parse::<f64>() {
                    series_index = Some(idx);
                }
            }
        }
    }

    // Find first image file in alphabetical order
    let mut image_names = Vec::new();
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            let Ok(name) = entry.name() else { continue };
            let lower = name.to_lowercase();
            if lower.ends_with(".jpg")
                || lower.ends_with(".jpeg")
                || lower.ends_with(".png")
                || lower.ends_with(".webp")
            {
                image_names.push(name.to_string());
            }
        }
    }
    image_names.sort();

    if let Some(first_img) = image_names.first() {
        if let Ok(mut entry) = archive.by_name(first_img) {
            let mut bytes = Vec::new();
            if entry.size() <= 32 * 1024 * 1024 && entry.read_to_end(&mut bytes).is_ok() {
                cover_data_url = downsample_cover_to_data_url(&bytes);
            }
        }
    }

    Ok(ParsedMetadata {
        title,
        author,
        description: None,
        publisher: None,
        published_date: None,
        language: None,
        isbn: None,
        cover_data_url,
        series,
        series_index,
    })
}

/// Parse generic book metadata from filename
fn parse_generic_native(path: &Path) -> Result<ParsedMetadata, String> {
    let (title, author) = parse_title_author_from_filename(path);
    Ok(ParsedMetadata {
        title,
        author,
        description: None,
        publisher: None,
        published_date: None,
        language: None,
        isbn: None,
        cover_data_url: None,
        series: None,
        series_index: None,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// XML & STRING HELPERS
// ─────────────────────────────────────────────────────────────────────────────

fn extract_opf_path_from_container(xml: &str) -> String {
    use quick_xml::events::Event;
    use quick_xml::reader::Reader;

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

#[derive(Default)]
struct RawOpfMetadata {
    title: String,
    author: String,
    description: Option<String>,
    publisher: Option<String>,
    published_date: Option<String>,
    language: Option<String>,
    isbn: Option<String>,
    cover_href: Option<String>,
    series: Option<String>,
    series_index: Option<f64>,
}

fn parse_opf_xml(xml: &str) -> RawOpfMetadata {
    use quick_xml::events::Event;
    use quick_xml::reader::Reader;

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut meta = RawOpfMetadata::default();

    let mut cover_item_id = None;
    let mut manifest_items: Vec<(String, String, Option<String>)> = Vec::new(); // (id, href, properties)

    let mut current_tag = String::new();
    let mut current_meta_is_series = false;
    let mut current_meta_is_series_index = false;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let local_name = e.local_name();
                current_tag = String::from_utf8_lossy(local_name.as_ref()).to_string();

                if local_name.as_ref() == b"meta" {
                    let mut name_val = String::new();
                    let mut content_val = String::new();
                    let mut is_series_prop = false;
                    let mut is_pos_prop = false;
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"name" {
                            name_val = String::from_utf8_lossy(&attr.value).to_string();
                        } else if attr.key.as_ref() == b"content" {
                            content_val = String::from_utf8_lossy(&attr.value).to_string();
                        } else if attr.key.as_ref() == b"property" {
                            let prop = String::from_utf8_lossy(&attr.value);
                            if prop == "belongs-to-collection" {
                                is_series_prop = true;
                            } else if prop == "group-position" {
                                is_pos_prop = true;
                            }
                        }
                    }
                    if name_val.eq_ignore_ascii_case("cover") && !content_val.is_empty() {
                        cover_item_id = Some(content_val);
                    } else if name_val.eq_ignore_ascii_case("calibre:series")
                        && !content_val.is_empty()
                    {
                        meta.series = Some(content_val);
                    } else if name_val.eq_ignore_ascii_case("calibre:series_index")
                        && !content_val.is_empty()
                    {
                        if let Ok(idx) = content_val.parse::<f64>() {
                            meta.series_index = Some(idx);
                        }
                    }
                    current_meta_is_series = is_series_prop;
                    current_meta_is_series_index = is_pos_prop;
                }
            }
            Ok(Event::Empty(ref e)) => {
                let local_name = e.local_name();
                if local_name.as_ref() == b"item" {
                    let mut id = String::new();
                    let mut href = String::new();
                    let mut props = None;
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"id" {
                            id = String::from_utf8_lossy(&attr.value).to_string();
                        } else if attr.key.as_ref() == b"href" {
                            href = String::from_utf8_lossy(&attr.value).to_string();
                        } else if attr.key.as_ref() == b"properties" {
                            props = Some(String::from_utf8_lossy(&attr.value).to_string());
                        }
                    }
                    if !id.is_empty() && !href.is_empty() {
                        manifest_items.push((id, href, props));
                    }
                } else if local_name.as_ref() == b"meta" {
                    let mut name_val = String::new();
                    let mut content_val = String::new();
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"name" {
                            name_val = String::from_utf8_lossy(&attr.value).to_string();
                        } else if attr.key.as_ref() == b"content" {
                            content_val = String::from_utf8_lossy(&attr.value).to_string();
                        }
                    }
                    if name_val.eq_ignore_ascii_case("cover") && !content_val.is_empty() {
                        cover_item_id = Some(content_val);
                    } else if name_val.eq_ignore_ascii_case("calibre:series")
                        && !content_val.is_empty()
                    {
                        meta.series = Some(content_val);
                    } else if name_val.eq_ignore_ascii_case("calibre:series_index")
                        && !content_val.is_empty()
                    {
                        if let Ok(idx) = content_val.parse::<f64>() {
                            meta.series_index = Some(idx);
                        }
                    }
                }
            }
            Ok(Event::Text(ref e)) => {
                let text = e.unescape().unwrap_or_default().trim().to_string();
                if !text.is_empty() {
                    if current_meta_is_series && meta.series.is_none() {
                        meta.series = Some(text.clone());
                    } else if current_meta_is_series_index && meta.series_index.is_none() {
                        if let Ok(idx) = text.parse::<f64>() {
                            meta.series_index = Some(idx);
                        }
                    }
                    match current_tag.as_str() {
                        "title" if meta.title.is_empty() => meta.title = text,
                        "creator" if meta.author.is_empty() => meta.author = text,
                        "description" if meta.description.is_none() => {
                            meta.description = Some(text)
                        }
                        "publisher" if meta.publisher.is_none() => meta.publisher = Some(text),
                        "date" if meta.published_date.is_none() => meta.published_date = Some(text),
                        "language" if meta.language.is_none() => meta.language = Some(text),
                        "identifier" if meta.isbn.is_none() => meta.isbn = Some(text),
                        _ => {}
                    }
                }
            }
            Ok(Event::End(_)) => {
                current_tag.clear();
                current_meta_is_series = false;
                current_meta_is_series_index = false;
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    // Resolve cover href from manifest
    let mut cover_href = None;

    // Check properties="cover-image"
    for (_, href, props) in &manifest_items {
        if let Some(p) = props {
            if p.contains("cover-image") {
                cover_href = Some(href.clone());
                break;
            }
        }
    }

    // Check cover_item_id
    if cover_href.is_none() {
        if let Some(ref cid) = cover_item_id {
            for (id, href, _) in &manifest_items {
                if id == cid {
                    cover_href = Some(href.clone());
                    break;
                }
            }
        }
    }

    // Fallback: check item id or href containing 'cover'
    if cover_href.is_none() {
        for (id, href, _) in &manifest_items {
            let lower_id = id.to_lowercase();
            let lower_href = href.to_lowercase();
            if (lower_id.contains("cover") || lower_href.contains("cover"))
                && (lower_href.ends_with(".jpg")
                    || lower_href.ends_with(".jpeg")
                    || lower_href.ends_with(".png")
                    || lower_href.ends_with(".webp"))
            {
                cover_href = Some(href.clone());
                break;
            }
        }
    }

    meta.cover_href = cover_href;
    meta
}

pub(crate) fn extract_xml_tag_text(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(xml[start..end].trim().to_string())
}

/// Parse clean Title and Author from filename e.g. "George Orwell - 1984.epub"
pub fn parse_title_author_from_filename(path: &Path) -> (String, String) {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown");

    let clean = stem.replace('_', " ").trim().to_string();

    // Check "Author - Title" pattern
    if let Some((part1, part2)) = clean.split_once(" - ") {
        let p1 = part1.trim();
        let p2 = part2.trim();
        if !p1.is_empty() && !p2.is_empty() {
            return (p2.to_string(), p1.to_string());
        }
    }

    // Check "Title (Author)" pattern
    if clean.ends_with(')') {
        if let Some(paren_start) = clean.rfind('(') {
            let title_part = clean[..paren_start].trim();
            let author_part = clean[paren_start + 1..clean.len() - 1].trim();
            if !title_part.is_empty() && !author_part.is_empty() {
                return (title_part.to_string(), author_part.to_string());
            }
        }
    }

    (clean, "Unknown Author".to_string())
}

// ─────────────────────────────────────────────────────────────────────────────
// BATCH INGEST
// ─────────────────────────────────────────────────────────────────────────────

/// Larger files are not books (a disk image or video given a book name).
pub const MAX_BOOK_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// Half-written copies older than this are left over from a crash.
const STALE_PART_AGE: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// A book already in the library, so a file with the same bytes is skipped
/// before anything is copied.
#[derive(Debug, Clone, Deserialize)]
pub struct KnownBook {
    pub size: u64,
    pub hash: Box<str>,
}

/// What happened to one file.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum IngestItem {
    Imported {
        path: Box<str>,
        book: Box<NativeBookRecord>,
    },
    Failed {
        path: Box<str>,
        reason: Box<str>,
    },
    /// The same bytes are already in the library or earlier in this batch.
    Duplicate {
        path: Box<str>,
        #[serde(rename = "contentHash")]
        content_hash: Box<str>,
    },
}

impl IngestItem {
    fn failed(path: &str, reason: impl Into<String>) -> Self {
        IngestItem::Failed {
            path: path.into(),
            reason: reason.into().into_boxed_str(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IngestSummary {
    pub total: usize,
    pub imported: usize,
    pub failed: usize,
    pub duplicates: usize,
    /// Stopped before every file was handled; unhandled files are untouched.
    pub cancelled: bool,
}

/// Messages on the progress channel. Items arrive in batches so a large
/// import does not flood the webview; `done` is always the last message.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum IngestMessage {
    Progress {
        completed: usize,
        total: usize,
        items: Vec<IngestItem>,
    },
    Done {
        summary: IngestSummary,
    },
}

enum FileError {
    Cancelled,
    Failed(String),
}

impl From<String> for FileError {
    fn from(reason: String) -> Self {
        FileError::Failed(reason)
    }
}

fn describe_io(error: &std::io::Error) -> String {
    crate::folder_walk::describe_io_error(error)
}

/// Copy `source` to `dest`, returning its SHA-256 (computed first, unless
/// `known_hash` already has it). The copy itself is done by the kernel
/// (`copy_file_range`/reflink where available), which is much faster than
/// copying through a buffer.
fn copy_with_hash(
    source: &Path,
    dest: &Path,
    known_hash: Option<&str>,
    cancel: &AtomicBool,
) -> Result<String, FileError> {
    let hash = match known_hash {
        Some(hash) => hash.to_string(),
        None => hash_file(source, cancel)?,
    };
    if cancel.load(Ordering::Relaxed) {
        return Err(FileError::Cancelled);
    }
    std::fs::copy(source, dest).map_err(|e| {
        // The source vanishing (drive unplugged) reads differently from a
        // failed write into the library.
        if source.exists() {
            format!("Could not save the book: {}", describe_io(&e))
        } else {
            describe_io(&e)
        }
    })?;
    Ok(hash)
}

/// SHA-256 of a file, checking `cancel` between blocks.
fn hash_file(path: &Path, cancel: &AtomicBool) -> Result<String, FileError> {
    let mut input = File::open(path).map_err(|e| describe_io(&e))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(FileError::Cancelled);
        }
        match input.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => hasher.update(&buffer[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(format!("Reading stopped: {}", describe_io(&e)).into()),
        }
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Remove `*.part` files a crashed import left behind. Recent ones may belong
/// to an import that is still running, so they stay.
fn sweep_stale_parts(cache_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(cache_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "part") {
            let stale = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > STALE_PART_AGE);
            if stale {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

struct Batch<'a> {
    known_hashes: std::collections::HashSet<&'a str>,
    /// Sizes that occur more than once across the library and this batch:
    /// only these files need hashing before they are copied.
    shared_sizes: std::collections::HashSet<u64>,
    /// Hashes claimed by files of this batch, so the second copy of the same
    /// book is reported as a duplicate instead of imported twice.
    claimed: std::sync::Mutex<std::collections::HashSet<String>>,
    cache_dir: &'a Path,
    cancel: &'a AtomicBool,
}

fn ingest_one(raw_path: &str, size: u64, batch: &Batch) -> Result<IngestItem, FileError> {
    let path = Path::new(raw_path);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or_default();
    let Some(format) = crate::folder_walk::book_format_for_name(&name) else {
        return Err("This kind of file is not supported".to_string().into());
    };
    if size == 0 {
        return Err("The file is empty".to_string().into());
    }
    if size > MAX_BOOK_BYTES {
        return Err(format!(
            "The file is too large to be a book ({} GB)",
            size / (1024 * 1024 * 1024)
        )
        .into());
    }

    // Duplicates are found before anything is copied. Only a file whose size
    // matches another book can have the same bytes, so only those are hashed.
    let mut content_hash = None;
    if batch.shared_sizes.contains(&size) {
        let hash = hash_file(path, batch.cancel)?;
        if batch.known_hashes.contains(hash.as_str()) {
            return Ok(IngestItem::Duplicate {
                path: raw_path.into(),
                content_hash: hash.into_boxed_str(),
            });
        }
        let first = batch
            .claimed
            .lock()
            .map_err(|_| "Import state was lost".to_string())?
            .insert(hash.clone());
        if !first {
            return Ok(IngestItem::Duplicate {
                path: raw_path.into(),
                content_hash: hash.into_boxed_str(),
            });
        }
        content_hash = Some(hash);
    }

    if batch.cancel.load(Ordering::Relaxed) {
        return Err(FileError::Cancelled);
    }
    let metadata = match format {
        "epub" => parse_epub_native(path),
        "cbz" => parse_cbz_native(path),
        "cbr" => crate::cbr::parse_cbr_native(path),
        _ => parse_generic_native(path),
    }
    .map_err(|e| format!("Could not read this book: {e}"))?;

    let id = uuid::Uuid::new_v4().to_string();
    let part = batch.cache_dir.join(format!("{id}.part"));
    let dest = batch.cache_dir.join(format!("{id}.book"));
    let written = (|| -> Result<(String, String), FileError> {
        let final_format = if format == "cbr" {
            if batch.cancel.load(Ordering::Relaxed) {
                return Err(FileError::Cancelled);
            }
            match crate::cbr::convert_cbr_to_cbz_file(path, &part) {
                Ok(()) => {
                    if content_hash.is_none() {
                        content_hash = Some(hash_file(path, batch.cancel)?);
                    }
                    "cbz"
                }
                Err(error) => {
                    log::warn!("[batch_ingest] CBR to CBZ failed for '{raw_path}': {error}");
                    content_hash = Some(copy_with_hash(
                        path,
                        &part,
                        content_hash.as_deref(),
                        batch.cancel,
                    )?);
                    "cbr"
                }
            }
        } else {
            content_hash = Some(copy_with_hash(
                path,
                &part,
                content_hash.as_deref(),
                batch.cancel,
            )?);
            format
        };
        std::fs::rename(&part, &dest)
            .map_err(|e| format!("Could not save the book: {}", describe_io(&e)))?;
        Ok((
            content_hash.clone().unwrap_or_default(),
            final_format.to_string(),
        ))
    })();
    let (content_hash, final_format) = match written {
        Ok(done) => done,
        Err(error) => {
            let _ = std::fs::remove_file(&part);
            let _ = std::fs::remove_file(&dest);
            return Err(error);
        }
    };

    let cover_extraction_done = metadata.cover_data_url.is_some();
    Ok(IngestItem::Imported {
        path: raw_path.into(),
        book: Box::new(NativeBookRecord {
            id,
            title: metadata.title,
            author: metadata.author,
            file_path: raw_path.to_string(),
            storage_path: Some(dest.to_string_lossy().into_owned()),
            format: final_format,
            content_hash: Some(content_hash),
            cover_path: metadata.cover_data_url,
            cover_extraction_done,
            description: metadata.description,
            publisher: metadata.publisher,
            published_date: metadata.published_date,
            language: metadata.language,
            isbn: metadata.isbn,
            series: metadata.series,
            series_index: metadata.series_index,
            file_size: size,
            added_at: chrono::Utc::now().to_rfc3339(),
            progress: 0.0,
            is_favorite: false,
            tags: Vec::new(),
        }),
    })
}

/// Import `paths` into `cache_dir` (`book-cache`) in parallel.
///
/// Every path is reported to `sink` exactly once, as imported, failed with a
/// reason, or a duplicate, unless the import is cancelled first. A failed or
/// cancelled file leaves nothing behind in `cache_dir`.
pub fn ingest_files(
    paths: &[String],
    cache_dir: &Path,
    known: &[KnownBook],
    cancel: &AtomicBool,
    sink: &(dyn Fn(IngestItem) + Sync),
) -> IngestSummary {
    let mut summary = IngestSummary {
        total: paths.len(),
        ..IngestSummary::default()
    };
    if let Err(error) = std::fs::create_dir_all(cache_dir) {
        let reason = format!("Could not save the book: {}", describe_io(&error));
        for path in paths {
            sink(IngestItem::failed(path, reason.clone()));
        }
        summary.failed = paths.len();
        return summary;
    }
    sweep_stale_parts(cache_dir);

    // One stat per file up front: sizes decide which files need hashing.
    let mut seen_paths = std::collections::HashSet::new();
    let mut sized = Vec::with_capacity(paths.len());
    for path in paths {
        if !seen_paths.insert(path.as_str()) {
            continue;
        }
        match std::fs::metadata(path) {
            Ok(m) if m.is_file() => sized.push((path, m.len())),
            Ok(_) => sink(IngestItem::failed(path, "Not a file")),
            Err(e) => sink(IngestItem::failed(path, describe_io(&e))),
        }
    }
    let unreadable = seen_paths.len() - sized.len();
    summary.total = seen_paths.len();

    let mut size_counts: HashMap<u64, usize> = HashMap::new();
    for book in known {
        *size_counts.entry(book.size).or_default() += 1;
    }
    for (_, size) in &sized {
        *size_counts.entry(*size).or_default() += 1;
    }
    let batch = Batch {
        known_hashes: known.iter().map(|b| &*b.hash).collect(),
        shared_sizes: size_counts
            .into_iter()
            .filter(|(_, n)| *n > 1)
            .map(|(size, _)| size)
            .collect(),
        claimed: Default::default(),
        cache_dir,
        cancel,
    };

    let imported = AtomicUsize::new(0);
    let failed = AtomicUsize::new(unreadable);
    let duplicates = AtomicUsize::new(0);
    sized.par_iter().for_each(|(path, size)| {
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        let item = match ingest_one(path, *size, &batch) {
            Ok(item) => item,
            Err(FileError::Cancelled) => return,
            Err(FileError::Failed(reason)) => IngestItem::failed(path, reason),
        };
        match &item {
            IngestItem::Imported { .. } => &imported,
            IngestItem::Failed { .. } => &failed,
            IngestItem::Duplicate { .. } => &duplicates,
        }
        .fetch_add(1, Ordering::Relaxed);
        sink(item);
    });

    summary.imported = imported.into_inner();
    summary.failed = failed.into_inner();
    summary.duplicates = duplicates.into_inner();
    summary.cancelled = summary.imported + summary.failed + summary.duplicates < summary.total;
    summary
}

/// Collects items and sends them in batches: at most every `interval`, or as
/// soon as `max_items` are waiting.
pub struct ProgressBatcher<F: Fn(IngestMessage)> {
    send: F,
    total: usize,
    max_items: usize,
    interval: std::time::Duration,
    state: std::sync::Mutex<(Vec<IngestItem>, usize, std::time::Instant)>,
}

impl<F: Fn(IngestMessage)> ProgressBatcher<F> {
    pub fn new(total: usize, max_items: usize, interval: std::time::Duration, send: F) -> Self {
        Self {
            send,
            total,
            max_items,
            interval,
            state: std::sync::Mutex::new((Vec::new(), 0, std::time::Instant::now())),
        }
    }

    pub fn push(&self, item: IngestItem) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.0.push(item);
        state.1 += 1;
        if state.0.len() >= self.max_items || state.2.elapsed() >= self.interval {
            self.flush_locked(&mut state);
        }
    }

    fn flush_locked(&self, state: &mut (Vec<IngestItem>, usize, std::time::Instant)) {
        state.2 = std::time::Instant::now();
        if state.0.is_empty() {
            return;
        }
        (self.send)(IngestMessage::Progress {
            completed: state.1,
            total: self.total,
            items: std::mem::take(&mut state.0),
        });
    }

    /// Send whatever is waiting, then `done`.
    pub fn finish(&self, summary: IngestSummary) {
        if let Ok(mut state) = self.state.lock() {
            self.flush_locked(&mut state);
        }
        (self.send)(IngestMessage::Done { summary });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TAURI COMMANDS
// ─────────────────────────────────────────────────────────────────────────────

/// Multi-threaded batch ingestion. Results stream over `on_progress`; the
/// returned summary is the same as the final `done` message. `job_id` lets
/// `cancel_import_job` stop it; `known` lists the library's books so
/// duplicates are skipped before copying.
#[tauri::command]
pub async fn ingest_books_native(
    app: AppHandle,
    file_paths: Vec<String>,
    job_id: Option<String>,
    known: Option<Vec<KnownBook>>,
    on_progress: tauri::ipc::Channel<IngestMessage>,
) -> Result<IngestSummary, String> {
    let cache_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {e}"))?
        .join("book-cache");
    let job = crate::folder_walk::register_job(job_id);

    tokio::task::spawn_blocking(move || {
        let batcher = ProgressBatcher::new(
            file_paths.len(),
            64,
            std::time::Duration::from_millis(150),
            |message| {
                let _ = on_progress.send(message);
            },
        );
        let summary = ingest_files(
            &file_paths,
            &cache_dir,
            known.as_deref().unwrap_or_default(),
            &job.flag,
            &|item| batcher.push(item),
        );
        batcher.finish(summary.clone());
        summary
    })
    .await
    .map_err(|e| format!("Batch ingestion worker failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_title_author_patterns() {
        let p1 = Path::new("/path/to/Frank Herbert - Dune.epub");
        let (t1, a1) = parse_title_author_from_filename(p1);
        assert_eq!(t1, "Dune");
        assert_eq!(a1, "Frank Herbert");

        let p2 = Path::new("Foundation (Isaac Asimov).epub");
        let (t2, a2) = parse_title_author_from_filename(p2);
        assert_eq!(t2, "Foundation");
        assert_eq!(a2, "Isaac Asimov");

        let p3 = Path::new("Simple_Book_Title.pdf");
        let (t3, a3) = parse_title_author_from_filename(p3);
        assert_eq!(t3, "Simple Book Title");
        assert_eq!(a3, "Unknown Author");
    }

    #[test]
    fn test_sha256_computation() {
        let temp_dir = tempfile::tempdir().unwrap();
        let file_path = temp_dir.path().join("test.txt");
        std::fs::write(&file_path, b"Hello World").unwrap();

        let hash = compute_file_sha256(&file_path).unwrap();
        assert_eq!(
            hash,
            "a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e"
        );
    }

    #[test]
    fn test_opf_parsing() {
        let container_xml = r#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
    <rootfiles>
        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
    </rootfiles>
</container>"#;
        let opf_path = extract_opf_path_from_container(container_xml);
        assert_eq!(opf_path, "OEBPS/content.opf");

        let opf_xml = r#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:title>Neuromancer</dc:title>
        <dc:creator>William Gibson</dc:creator>
        <dc:description>The sky above the port was the color of television...</dc:description>
        <dc:publisher>Ace</dc:publisher>
        <dc:language>en</dc:language>
        <meta name="cover" content="cover-image-id"/>
    </metadata>
    <manifest>
        <item id="cover-image-id" href="images/cover.jpg" media-type="image/jpeg"/>
    </manifest>
</package>"#;
        let meta = parse_opf_xml(opf_xml);
        assert_eq!(meta.title, "Neuromancer");
        assert_eq!(meta.author, "William Gibson");
        assert!(meta.description.unwrap().contains("The sky above the port"));
        assert_eq!(meta.publisher, Some("Ace".to_string()));
        assert_eq!(meta.language, Some("en".to_string()));
        assert_eq!(meta.cover_href, Some("images/cover.jpg".to_string()));
    }

    #[test]
    fn test_opf_series_parsing() {
        let calibre_opf = r#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:title>The Fellowship of the Ring</dc:title>
        <dc:creator>J.R.R. Tolkien</dc:creator>
        <meta name="calibre:series" content="The Lord of the Rings"/>
        <meta name="calibre:series_index" content="1.0"/>
    </metadata>
</package>"#;
        let meta1 = parse_opf_xml(calibre_opf);
        assert_eq!(meta1.series, Some("The Lord of the Rings".to_string()));
        assert_eq!(meta1.series_index, Some(1.0));

        let epub3_opf = r#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:title>The Two Towers</dc:title>
        <meta property="belongs-to-collection">The Lord of the Rings</meta>
        <meta property="group-position">2</meta>
    </metadata>
</package>"#;
        let meta2 = parse_opf_xml(epub3_opf);
        assert_eq!(meta2.series, Some("The Lord of the Rings".to_string()));
        assert_eq!(meta2.series_index, Some(2.0));
    }

    #[test]
    fn test_cbz_comic_info_and_cover_parsing() {
        use std::io::Write;

        let temp_dir = tempfile::tempdir().unwrap();
        let cbz_path = temp_dir.path().join("Saga 001.cbz");

        let comic_info = r#"<?xml version="1.0"?>
<ComicInfo>
    <Title>Chapter One</Title>
    <Series>Saga</Series>
    <Number>1</Number>
</ComicInfo>"#;

        let img = image::RgbImage::new(10, 10);
        let mut png_bytes = Vec::new();
        img.write_to(&mut Cursor::new(&mut png_bytes), image::ImageFormat::Png)
            .unwrap();

        {
            let file = std::fs::File::create(&cbz_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);

            zip.start_file("ComicInfo.xml", options).unwrap();
            zip.write_all(comic_info.as_bytes()).unwrap();

            zip.start_file("001_cover.png", options).unwrap();
            zip.write_all(&png_bytes).unwrap();

            zip.finish().unwrap();
        }

        let parsed = parse_cbz_native(&cbz_path).unwrap();
        assert_eq!(parsed.title, "Chapter One");
        assert_eq!(parsed.series, Some("Saga".to_string()));
        assert_eq!(parsed.series_index, Some(1.0));
        assert!(parsed.cover_data_url.is_some());
    }

    #[test]
    fn epub_check_accepts_real_epubs_and_rejects_damaged_ones() {
        let dir = tempfile::tempdir().unwrap();
        let good = fixture("epub/multi-chapter.epub");
        assert_eq!(check_epub_readable(&good), Ok(()));
        let junk = put(dir.path(), "junk.epub", b"this is not a zip archive at all");
        assert!(check_epub_readable(Path::new(&junk))
            .unwrap_err()
            .starts_with("Could not read this book"));
        let bytes = std::fs::read(&good).unwrap();
        let truncated = put(dir.path(), "cut.epub", &bytes[..bytes.len() / 2]);
        assert!(check_epub_readable(Path::new(&truncated)).is_err());
        // A ZIP that is not an EPUB (no package document).
        let mut zip = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(Cursor::new(&mut zip));
            writer
                .start_file("notes.txt", zip::write::SimpleFileOptions::default())
                .unwrap();
            std::io::Write::write_all(&mut writer, b"hello").unwrap();
            writer.finish().unwrap();
        }
        let plain = put(dir.path(), "plain.epub", &zip);
        assert!(check_epub_readable(Path::new(&plain))
            .unwrap_err()
            .contains("OPF"));
        assert!(check_epub_readable(&dir.path().join("gone.epub")).is_err());
    }

    // ── Cover thumbnails ────────────────────────────────────────────────────

    fn encode_png(img: &image::DynamicImage) -> Vec<u8> {
        let mut out = Vec::new();
        img.write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    fn decode_data_url(url: &str) -> image::DynamicImage {
        use base64::Engine;
        let b64 = url.strip_prefix("data:image/jpeg;base64,").expect(url);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap();
        image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg).unwrap()
    }

    fn close(a: image::Rgb<u8>, b: [u8; 3]) -> bool {
        a.0.iter().zip(b).all(|(x, y)| x.abs_diff(y) <= 12)
    }

    #[test]
    fn cover_thumbnails_fit_the_box_and_average_the_pixels() {
        // Top half red, bottom half blue: a box filter keeps both colours.
        let tall = image::RgbImage::from_fn(1200, 1800, |_, y| {
            if y < 900 {
                image::Rgb([220, 20, 20])
            } else {
                image::Rgb([20, 20, 220])
            }
        });
        let thumb =
            decode_data_url(&downsample_cover_to_data_url(&encode_png(&tall.into())).unwrap())
                .to_rgb8();
        assert_eq!(thumb.dimensions(), (360, 540));
        assert!(close(*thumb.get_pixel(180, 100), [220, 20, 20]));
        assert!(close(*thumb.get_pixel(180, 440), [20, 20, 220]));

        // A fine checkerboard averages to grey rather than aliasing.
        let checker = image::RgbImage::from_fn(1080, 1620, |x, y| {
            if (x + y) % 2 == 0 {
                image::Rgb([255, 255, 255])
            } else {
                image::Rgb([0, 0, 0])
            }
        });
        let thumb =
            decode_data_url(&downsample_cover_to_data_url(&encode_png(&checker.into())).unwrap())
                .to_rgb8();
        assert_eq!(thumb.dimensions(), (360, 540));
        assert!(close(*thumb.get_pixel(100, 100), [128, 128, 128]));
    }

    #[test]
    fn cover_thumbnails_keep_the_aspect_ratio_of_odd_shapes() {
        let cases = [
            ((2000, 500), (360, 90)),
            ((100, 150), (100, 150)),
            ((5000, 1), (360, 1)),
            ((1, 5000), (1, 540)),
            ((361, 541), (360, 540)),
        ];
        for ((w, h), expected) in cases {
            let img = image::DynamicImage::ImageRgb8(image::RgbImage::new(w, h));
            let url = downsample_cover_to_data_url(&encode_png(&img))
                .unwrap_or_else(|| panic!("{w}x{h}"));
            let (tw, th) = decode_data_url(&url).dimensions();
            assert_eq!((tw, th), expected, "{w}x{h}");
        }
    }

    #[test]
    fn cover_thumbnails_accept_transparency_and_reject_garbage() {
        let rgba = image::RgbaImage::from_pixel(800, 1200, image::Rgba([10, 200, 10, 128]));
        let url = downsample_cover_to_data_url(&encode_png(&rgba.into())).unwrap();
        assert_eq!(decode_data_url(&url).dimensions(), (360, 540));
        assert!(downsample_cover_to_data_url(b"not an image").is_none());
        assert!(downsample_cover_to_data_url(&[]).is_none());
    }

    // ── Batch ingest ────────────────────────────────────────────────────────

    fn fixture(rel: &str) -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures")
            .join(rel)
    }

    fn put(dir: &Path, name: &str, bytes: &[u8]) -> String {
        let path = dir.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, bytes).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn run(
        paths: &[String],
        cache: &Path,
        known: &[KnownBook],
        cancel: &AtomicBool,
    ) -> (IngestSummary, Vec<IngestItem>) {
        let items = std::sync::Mutex::new(Vec::new());
        let summary = ingest_files(paths, cache, known, cancel, &|item| {
            items.lock().unwrap().push(item)
        });
        (summary, items.into_inner().unwrap())
    }

    fn cache_files(cache: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(cache)
            .map(|it| {
                it.flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    fn item_path(item: &IngestItem) -> &str {
        match item {
            IngestItem::Imported { path, .. }
            | IngestItem::Failed { path, .. }
            | IngestItem::Duplicate { path, .. } => path,
        }
    }

    fn reason_for<'a>(items: &'a [IngestItem], path: &str) -> &'a str {
        items
            .iter()
            .find_map(|item| match item {
                IngestItem::Failed { path: p, reason } if &**p == path => Some(&**reason),
                _ => None,
            })
            .unwrap_or_else(|| panic!("no failure for {path}: {items:?}"))
    }

    #[test]
    fn every_file_is_imported_or_reported_with_a_reason() {
        let src = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let cache = cache.path().join("book-cache");
        let epub = std::fs::read(fixture("epub/multi-chapter.epub")).unwrap();
        let pdf = std::fs::read(fixture("pdf/page-labels.pdf")).unwrap();
        let good_epub = put(src.path(), "deep/a/b/c/d/e/f/Good – Ünï 書.epub", &epub);
        let good_pdf = put(src.path(), "Author - Paper.pdf", &pdf);
        let fb2zip = put(src.path(), "Tale.fb2.zip", b"zip-ish fb2 bytes");
        let empty = put(src.path(), "empty.epub", b"");
        let corrupt = put(
            src.path(),
            "corrupt.epub",
            b"this is not a zip archive at all",
        );
        let unsupported = put(src.path(), "notes.txt", b"hello");
        let missing = src.path().join("gone.epub").to_string_lossy().into_owned();
        std::fs::create_dir_all(src.path().join("folder.epub")).unwrap();
        let folder = src
            .path()
            .join("folder.epub")
            .to_string_lossy()
            .into_owned();

        let paths = vec![
            good_epub.clone(),
            good_pdf.clone(),
            fb2zip.clone(),
            empty.clone(),
            corrupt.clone(),
            unsupported.clone(),
            missing.clone(),
            folder.clone(),
            good_pdf.clone(), // listed twice: handled once
        ];
        let (summary, items) = run(&paths, &cache, &[], &AtomicBool::new(false));

        assert_eq!(
            summary,
            IngestSummary {
                total: 8,
                imported: 3,
                failed: 5,
                duplicates: 0,
                cancelled: false
            }
        );
        let mut reported: Vec<&str> = items.iter().map(item_path).collect();
        reported.sort();
        let mut expected: Vec<&str> = paths[..8].iter().map(String::as_str).collect();
        expected.sort();
        assert_eq!(reported, expected, "each path exactly once");

        assert_eq!(reason_for(&items, &empty), "The file is empty");
        assert!(reason_for(&items, &corrupt).starts_with("Could not read this book"));
        assert_eq!(
            reason_for(&items, &unsupported),
            "This kind of file is not supported"
        );
        assert_eq!(reason_for(&items, &missing), "The file is no longer there");
        assert_eq!(reason_for(&items, &folder), "Not a file");

        let mut stored = Vec::new();
        for item in &items {
            if let IngestItem::Imported { path, book } = item {
                let storage = book.storage_path.as_deref().expect("stored");
                assert!(Path::new(storage).is_file());
                assert_eq!(
                    std::fs::read(storage).unwrap(),
                    std::fs::read(&**path).unwrap()
                );
                assert_eq!(
                    book.content_hash.as_deref(),
                    compute_file_sha256(Path::new(&**path)).as_deref()
                );
                assert_eq!(book.file_size, std::fs::metadata(&**path).unwrap().len());
                stored.push(format!("{}.book", book.id));
                if **path == *fb2zip {
                    assert_eq!(book.format, "fb2");
                }
                if **path == *good_epub {
                    assert_eq!(book.format, "epub");
                }
            }
        }
        stored.sort();
        assert_eq!(cache_files(&cache), stored, "no partial or orphan files");
    }

    #[test]
    fn duplicates_are_found_before_copying() {
        let src = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let epub = std::fs::read(fixture("epub/multi-chapter.epub")).unwrap();
        let pdf = std::fs::read(fixture("pdf/page-labels.pdf")).unwrap();
        let in_library = put(src.path(), "already.epub", &epub);
        let first = put(src.path(), "one/paper.pdf", &pdf);
        let second = put(src.path(), "two/paper copy.pdf", &pdf);
        let known = vec![KnownBook {
            size: epub.len() as u64,
            hash: compute_file_sha256(Path::new(&in_library)).unwrap().into(),
        }];

        let (summary, items) = run(
            &[in_library.clone(), first.clone(), second.clone()],
            cache.path(),
            &known,
            &AtomicBool::new(false),
        );
        assert_eq!(
            (summary.imported, summary.duplicates, summary.failed),
            (1, 2, 0)
        );
        assert!(items.iter().any(|i| matches!(i,
            IngestItem::Duplicate { path, content_hash } if **path == *in_library && *content_hash == known[0].hash)));
        assert_eq!(cache_files(cache.path()).len(), 1, "only one copy stored");
    }

    #[test]
    fn a_rescan_with_the_library_known_imports_nothing() {
        let src = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let epub = std::fs::read(fixture("epub/multi-chapter.epub")).unwrap();
        let pdf = std::fs::read(fixture("pdf/links-paper.pdf")).unwrap();
        let paths = vec![
            put(src.path(), "a.epub", &epub),
            put(src.path(), "b.pdf", &pdf),
        ];
        let (first, items) = run(&paths, cache.path(), &[], &AtomicBool::new(false));
        assert_eq!(first.imported, 2);
        let known: Vec<KnownBook> = items
            .iter()
            .filter_map(|item| match item {
                IngestItem::Imported { book, .. } => Some(KnownBook {
                    size: book.file_size,
                    hash: book.content_hash.clone()?.into(),
                }),
                _ => None,
            })
            .collect();
        let before = cache_files(cache.path());
        let (again, _) = run(&paths, cache.path(), &known, &AtomicBool::new(false));
        assert_eq!((again.imported, again.duplicates), (0, 2));
        assert_eq!(cache_files(cache.path()), before);
    }

    #[test]
    fn a_cancelled_import_handles_nothing_more_and_leaves_nothing_behind() {
        let src = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let pdf = std::fs::read(fixture("pdf/page-labels.pdf")).unwrap();
        let paths: Vec<String> = (0..20)
            .map(|i| {
                put(
                    src.path(),
                    &format!("p{i}.pdf"),
                    &[pdf.as_slice(), &[i as u8][..]].concat(),
                )
            })
            .collect();
        let (summary, items) = run(&paths, cache.path(), &[], &AtomicBool::new(true));
        assert!(summary.cancelled);
        assert!(items.is_empty());
        assert!(cache_files(cache.path()).is_empty());

        // Cancelled during a copy: the partial copy is removed.
        let big = put(src.path(), "big.pdf", &vec![b'x'; 3 * 1024 * 1024]);
        let part = cache.path().join("x.part");
        let cancel = AtomicBool::new(true);
        assert!(matches!(
            copy_with_hash(Path::new(&big), &part, None, &cancel),
            Err(FileError::Cancelled)
        ));
        let batch = Batch {
            known_hashes: Default::default(),
            shared_sizes: Default::default(),
            claimed: Default::default(),
            cache_dir: cache.path(),
            cancel: &cancel,
        };
        assert!(matches!(
            ingest_one(&big, 3 * 1024 * 1024, &batch),
            Err(FileError::Cancelled)
        ));
        std::fs::remove_file(&part).ok();
        assert!(cache_files(cache.path()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_copy_is_reported_and_leaves_no_book() {
        use std::os::unix::fs::PermissionsExt;
        let src = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let pdf = std::fs::read(fixture("pdf/page-labels.pdf")).unwrap();
        let path = put(src.path(), "paper.pdf", &pdf);
        std::fs::set_permissions(cache.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
        let writable_anyway = std::fs::write(cache.path().join("probe"), b"").is_ok();
        let (summary, items) = run(
            std::slice::from_ref(&path),
            cache.path(),
            &[],
            &AtomicBool::new(false),
        );
        std::fs::set_permissions(cache.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        if writable_anyway {
            return; // running as root
        }
        assert_eq!(summary.failed, 1);
        assert!(
            reason_for(&items, &path).contains("Could not save the book"),
            "{items:?}"
        );
        assert!(cache_files(cache.path()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_files_are_reported_and_nothing_is_stored() {
        use std::os::unix::fs::PermissionsExt;
        let src = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let pdf = put(
            src.path(),
            "locked.pdf",
            &std::fs::read(fixture("pdf/page-labels.pdf")).unwrap(),
        );
        let epub = put(
            src.path(),
            "locked.epub",
            &std::fs::read(fixture("epub/multi-chapter.epub")).unwrap(),
        );
        for path in [&pdf, &epub] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o000)).unwrap();
        }
        let readable_anyway = std::fs::read(&pdf).is_ok();
        let (summary, items) = run(
            &[pdf.clone(), epub.clone()],
            cache.path(),
            &[],
            &AtomicBool::new(false),
        );
        for path in [&pdf, &epub] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        if readable_anyway {
            return; // running as root
        }
        assert_eq!(summary.failed, 2);
        assert_eq!(reason_for(&items, &pdf), "Permission denied");
        assert!(
            reason_for(&items, &epub).contains("Permission denied"),
            "{items:?}"
        );
        assert!(cache_files(cache.path()).is_empty());
    }

    #[test]
    fn stale_partial_copies_are_swept_and_fresh_ones_kept() {
        let cache = tempfile::tempdir().unwrap();
        let stale = cache.path().join("old.part");
        let fresh = cache.path().join("new.part");
        std::fs::write(&stale, b"x").unwrap();
        std::fs::write(&fresh, b"x").unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 60 * 60);
        std::fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(old)
            .unwrap();
        run(&[], cache.path(), &[], &AtomicBool::new(false));
        assert_eq!(cache_files(cache.path()), vec!["new.part".to_string()]);
    }

    #[test]
    fn progress_is_batched_and_done_comes_last() {
        let sent = std::sync::Mutex::new(Vec::new());
        let batcher = ProgressBatcher::new(10, 4, std::time::Duration::from_secs(60), |m| {
            sent.lock().unwrap().push(m)
        });
        for i in 0..10 {
            batcher.push(IngestItem::failed(&format!("p{i}"), "x"));
        }
        batcher.finish(IngestSummary {
            total: 10,
            failed: 10,
            ..Default::default()
        });
        let sent = sent.into_inner().unwrap();
        let shape: Vec<(usize, usize)> = sent
            .iter()
            .filter_map(|m| match m {
                IngestMessage::Progress {
                    completed, items, ..
                } => Some((*completed, items.len())),
                IngestMessage::Done { .. } => None,
            })
            .collect();
        assert_eq!(shape, vec![(4, 4), (8, 4), (10, 2)]);
        assert!(matches!(sent.last(), Some(IngestMessage::Done { .. })));
        let json = serde_json::to_value(&sent[0]).unwrap();
        assert_eq!(json["kind"], "progress");
        assert_eq!(json["items"][0]["status"], "failed");
        assert_eq!(json["items"][0]["reason"], "x");
        let done = serde_json::to_value(sent.last().unwrap()).unwrap();
        assert_eq!(done["kind"], "done");
        assert_eq!(done["summary"]["failed"], 10);
    }
}
