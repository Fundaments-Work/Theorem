use image::GenericImageView;
use std::fs::File;
use std::io::{Cursor, Read};
use std::path::Path;

pub(super) const COVER_MAX_W: u32 = 360;
pub(super) const COVER_MAX_H: u32 = 540;
const COVER_JPEG_QUALITY: u8 = 75;

/// The largest size within `max_w` x `max_h` with the image's aspect ratio
/// (never upscaled, never zero).
pub(super) fn fit_within(width: u32, height: u32, max_w: u32, max_h: u32) -> (u32, u32) {
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
pub(super) fn box_downscale_rgb(
    src: &[u8],
    width: u32,
    height: u32,
    out_w: u32,
    out_h: u32,
) -> Vec<u8> {
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
        container = crate::zip_util::read_zip_entry_string_bounded(
            &mut entry,
            1024 * 1024,
            "META-INF/container.xml",
        )
        .unwrap_or_default();
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
        if let Ok(content) = crate::zip_util::read_zip_entry_string_bounded(
            &mut container,
            1024 * 1024,
            "META-INF/container.xml",
        ) {
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
        let buf = crate::zip_util::read_zip_entry_string_bounded(
            &mut opf_entry,
            16 * 1024 * 1024,
            &opf_path,
        )?;
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
        const MAX_COVER_ENTRY_BYTES: usize = 32 * 1024 * 1024;
        if let Ok(cover_entry) = archive.by_name(&norm_path) {
            let mut cover_bytes = Vec::new();
            if cover_entry
                .take((MAX_COVER_ENTRY_BYTES as u64).saturating_add(1))
                .read_to_end(&mut cover_bytes)
                .is_ok()
                && cover_bytes.len() <= MAX_COVER_ENTRY_BYTES
            {
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
            const MAX_COVER_ENTRY_BYTES: usize = 32 * 1024 * 1024;
            if let Ok(cover_entry) = archive.by_name(&name) {
                let mut bytes = Vec::new();
                if cover_entry
                    .take((MAX_COVER_ENTRY_BYTES as u64).saturating_add(1))
                    .read_to_end(&mut bytes)
                    .is_ok()
                    && bytes.len() <= MAX_COVER_ENTRY_BYTES
                {
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
        if let Ok(xml_str) = crate::zip_util::read_zip_entry_string_bounded(
            &mut comic_info,
            1024 * 1024,
            "ComicInfo.xml",
        ) {
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
            if let Ok(bytes) = crate::zip_util::read_zip_entry_bytes_bounded(
                &mut entry,
                32 * 1024 * 1024,
                first_img,
            ) {
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
pub(super) fn parse_generic_native(path: &Path) -> Result<ParsedMetadata, String> {
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

pub(super) fn extract_opf_path_from_container(xml: &str) -> String {
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
pub(super) struct RawOpfMetadata {
    pub(super) title: String,
    pub(super) author: String,
    pub(super) description: Option<String>,
    pub(super) publisher: Option<String>,
    pub(super) published_date: Option<String>,
    pub(super) language: Option<String>,
    pub(super) isbn: Option<String>,
    pub(super) cover_href: Option<String>,
    pub(super) series: Option<String>,
    pub(super) series_index: Option<f64>,
}

pub(super) fn parse_opf_xml(xml: &str) -> RawOpfMetadata {
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
