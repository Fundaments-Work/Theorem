use image::GenericImageView;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Cursor, Read};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use zip::ZipArchive;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeBookRecord {
    pub id: String,
    pub title: String,
    pub author: String,
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
    #[serde(rename = "fileSize")]
    pub file_size: u64,
    #[serde(rename = "addedAt")]
    pub added_at: String,
    pub progress: f64,
    #[serde(rename = "isFavorite")]
    pub is_favorite: bool,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestProgressPayload {
    pub completed: usize,
    pub total: usize,
    #[serde(rename = "currentFile")]
    pub current_file: String,
    pub book: Option<NativeBookRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Compute SHA-256 hash of a file streaming in 64KB blocks
pub fn compute_file_sha256(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];

    while let Ok(n) = file.read(&mut buffer) {
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }

    Some(hex::encode(hasher.finalize()))
}

/// Downsample image bytes to max 360x540 JPEG and convert to base64 data URL
pub fn downsample_cover_to_data_url(bytes: &[u8]) -> Option<String> {
    let img = image::load_from_memory(bytes).ok()?;
    let (width, height) = img.dimensions();

    if width == 0 || height == 0 {
        return None;
    }

    let max_w = 360;
    let max_h = 540;

    let resized = if width > max_w || height > max_h {
        img.resize(max_w, max_h, image::imageops::FilterType::Triangle)
    } else {
        img
    };

    let mut jpeg_buf = Vec::new();
    let mut cursor = Cursor::new(&mut jpeg_buf);
    resized
        .write_to(&mut cursor, image::ImageFormat::Jpeg)
        .ok()?;

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg_buf);
    Some(format!("data:image/jpeg;base64,{b64}"))
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSERS FOR INDIVIDUAL FORMATS
// ─────────────────────────────────────────────────────────────────────────────

struct ParsedMetadata {
    title: String,
    author: String,
    description: Option<String>,
    publisher: Option<String>,
    published_date: Option<String>,
    language: Option<String>,
    isbn: Option<String>,
    cover_data_url: Option<String>,
}

/// Extract metadata & cover from an EPUB file using streaming XML
fn parse_epub_native(path: &Path) -> Result<ParsedMetadata, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open EPUB: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid EPUB ZIP: {e}"))?;

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
                if entry.name().ends_with(".opf") {
                    opf_path = entry.name().to_string();
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
            href.clone()
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
                let lower = entry.name().to_lowercase();
                if (lower.ends_with(".jpg")
                    || lower.ends_with(".jpeg")
                    || lower.ends_with(".png")
                    || lower.ends_with(".webp"))
                    && (lower.contains("cover") || lower.contains("thumb"))
                {
                    candidate_cover_name = Some(entry.name().to_string());
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
    })
}

/// Extract metadata & cover from a CBZ comic archive
fn parse_cbz_native(path: &Path) -> Result<ParsedMetadata, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open CBZ: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid CBZ ZIP: {e}"))?;

    let (mut title, author) = parse_title_author_from_filename(path);
    let mut cover_data_url = None;

    // Check for ComicInfo.xml
    if let Ok(mut comic_info) = archive.by_name("ComicInfo.xml") {
        let mut xml_str = String::new();
        if comic_info.read_to_string(&mut xml_str).is_ok() {
            if let Some(t) = extract_xml_tag_text(&xml_str, "Title") {
                if !t.trim().is_empty() {
                    title = t;
                }
            }
        }
    }

    // Find first image file in alphabetical order
    let mut image_names = Vec::new();
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            let lower = entry.name().to_lowercase();
            if lower.ends_with(".jpg")
                || lower.ends_with(".jpeg")
                || lower.ends_with(".png")
                || lower.ends_with(".webp")
            {
                image_names.push(entry.name().to_string());
            }
        }
    }
    image_names.sort();

    if let Some(first_img) = image_names.first() {
        if let Ok(mut entry) = archive.by_name(first_img) {
            let mut bytes = Vec::new();
            if entry.read_to_end(&mut bytes).is_ok() {
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
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let local_name = e.local_name();
                current_tag = String::from_utf8_lossy(local_name.as_ref()).to_string();

                if local_name.as_ref() == b"meta" {
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
                    }
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
                    }
                }
            }
            Ok(Event::Text(ref e)) => {
                let text = e.unescape().unwrap_or_default().trim().to_string();
                if !text.is_empty() {
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

fn extract_xml_tag_text(xml: &str, tag: &str) -> Option<String> {
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
// TAURI COMMANDS
// ─────────────────────────────────────────────────────────────────────────────

/// Multi-threaded batch ingestion command
#[tauri::command]
pub async fn ingest_books_native(
    app: AppHandle,
    file_paths: Vec<String>,
) -> Result<Vec<NativeBookRecord>, String> {
    if file_paths.is_empty() {
        return Ok(Vec::new());
    }

    let total = file_paths.len();
    let completed_counter = Arc::new(AtomicUsize::new(0));

    let results = tokio::task::spawn_blocking(move || {
        let books: Vec<Result<NativeBookRecord, (String, String)>> = file_paths
            .par_iter()
            .map(|raw_path| {
                let path = Path::new(raw_path);
                if !path.exists() {
                    return Err((raw_path.clone(), "File does not exist".to_string()));
                }

                let ext = path
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_lowercase();

                let metadata_res = match ext.as_str() {
                    "epub" => parse_epub_native(path),
                    "cbz" => parse_cbz_native(path),
                    _ => parse_generic_native(path),
                };

                let metadata = match metadata_res {
                    Ok(m) => m,
                    Err(e) => return Err((raw_path.clone(), e)),
                };

                let file_size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                let content_hash = compute_file_sha256(path);
                let id = uuid::Uuid::new_v4().to_string();
                let now = chrono::Utc::now().to_rfc3339();

                let book = NativeBookRecord {
                    id: id.clone(),
                    title: metadata.title,
                    author: metadata.author,
                    file_path: raw_path.clone(),
                    storage_path: None,
                    format: ext,
                    content_hash,
                    cover_path: metadata.cover_data_url.clone(),
                    cover_extraction_done: metadata.cover_data_url.is_some(),
                    description: metadata.description,
                    publisher: metadata.publisher,
                    published_date: metadata.published_date,
                    language: metadata.language,
                    isbn: metadata.isbn,
                    file_size,
                    added_at: now,
                    progress: 0.0,
                    is_favorite: false,
                    tags: Vec::new(),
                };

                let count = completed_counter.fetch_add(1, Ordering::SeqCst) + 1;
                let _ = app.emit(
                    "import-batch-progress",
                    IngestProgressPayload {
                        completed: count,
                        total,
                        current_file: raw_path.clone(),
                        book: Some(book.clone()),
                        error: None,
                    },
                );

                Ok(book)
            })
            .collect();

        let mut successful_books = Vec::with_capacity(books.len());
        for b in books.into_iter().flatten() {
            successful_books.push(b);
        }
        successful_books
    })
    .await
    .map_err(|e| format!("Batch ingestion worker failed: {e}"))?;

    Ok(results)
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
}
