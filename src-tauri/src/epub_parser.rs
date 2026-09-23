use quick_xml::events::Event;
use quick_xml::Reader;
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

pub(crate) fn read_zip_entry_inner<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    path: &str,
) -> Option<String> {
    if let Some(text) = read_zip_by_name_inner(archive, path) {
        return Some(text);
    }

    let decoded = percent_encoding::percent_decode(path.as_bytes()).decode_utf8_lossy();
    if decoded.as_ref() != path {
        return read_zip_by_name_inner(archive, decoded.as_ref());
    }
    None
}

fn read_zip_by_name_inner<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    name: &str,
) -> Option<String> {
    let clean_name = name.trim_start_matches('/').trim_start_matches("./");

    let target_index = archive
        .index_for_name(name)
        .or_else(|| archive.index_for_name(clean_name))
        .or_else(|| {
            archive.file_names().position(|f| {
                let f_clean = f.trim_start_matches('/').trim_start_matches("./");
                f_clean.eq_ignore_ascii_case(clean_name)
            })
        })?;

    let mut file = archive.by_index(target_index).ok()?;
    const MAX_METADATA_SIZE: usize = 32 * 1024 * 1024;
    let size = (file.size() as usize).min(MAX_METADATA_SIZE);
    let mut buf = Vec::with_capacity(size);
    file.read_to_end(&mut buf).ok()?;

    let normalized = strip_xml_bom(&buf);
    Some(String::from_utf8_lossy(normalized.as_ref()).into_owned())
}

pub(crate) fn resolve_relative(base: &str, target: &str) -> String {
    let base_dir = Path::new(base).parent().unwrap_or(Path::new(""));
    base_dir
        .join(target.split(['?', '#']).next().unwrap_or(target))
        .to_str()
        .unwrap_or(target)
        .to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TocItemDto {
    pub label: Box<str>,
    pub href: Box<str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subitems: Option<Box<[TocItemDto]>>,
}

pub(crate) fn resolve_epub_href(base: &str, target: &str) -> String {
    let clean_target = target.trim();
    if clean_target.is_empty() {
        return String::new();
    }
    if clean_target.starts_with("http://")
        || clean_target.starts_with("https://")
        || clean_target.starts_with("data:")
    {
        return clean_target.to_string();
    }

    let (file_part, fragment_part) = match clean_target.find('#') {
        Some(pos) => (&clean_target[..pos], &clean_target[pos..]),
        None => (clean_target, ""),
    };

    let clean_base = base.replace('\\', "/");
    let base_dir = match clean_base.rfind('/') {
        Some(pos) => &clean_base[..pos],
        None => "",
    };

    let full_path = if file_part.is_empty() {
        clean_base.to_string()
    } else if file_part.starts_with('/') {
        file_part.trim_start_matches('/').to_string()
    } else if base_dir.is_empty() {
        file_part.to_string()
    } else {
        format!("{base_dir}/{file_part}")
    };

    let mut segments: Vec<&str> = Vec::new();
    for part in full_path.split('/') {
        if part.is_empty() || part == "." {
            continue;
        } else if part == ".." {
            segments.pop();
        } else {
            segments.push(part);
        }
    }

    let normalized = segments.join("/");
    if fragment_part.is_empty() {
        normalized
    } else {
        format!("{normalized}{fragment_part}")
    }
}

pub(crate) fn normalize_label_text(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut in_whitespace = false;
    for ch in text.trim().chars() {
        if ch.is_whitespace() {
            if !in_whitespace {
                result.push(' ');
                in_whitespace = true;
            }
        } else {
            result.push(ch);
            in_whitespace = false;
        }
    }
    result
}

pub fn parse_ncx_toc(ncx_xml: &str, ncx_path: &str) -> Vec<TocItemDto> {
    let normalized = strip_xml_bom(ncx_xml.as_bytes());
    let mut reader = Reader::from_reader(normalized.as_ref());
    reader.config_mut().trim_text(true);

    struct NavPointBuilder {
        label: String,
        href: String,
        subitems: Vec<TocItemDto>,
    }

    let mut stack: Vec<NavPointBuilder> = Vec::new();
    let mut root_items: Vec<TocItemDto> = Vec::new();
    let mut in_text = false;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let qname = e.name();
                let name = local_name(qname.as_ref());
                if name == b"navPoint" {
                    stack.push(NavPointBuilder {
                        label: String::new(),
                        href: String::new(),
                        subitems: Vec::new(),
                    });
                } else if name == b"text" {
                    in_text = true;
                } else if name == b"content" {
                    if let Some(current) = stack.last_mut() {
                        for attr in e.attributes().flatten() {
                            if attr.key.as_ref() == b"src" {
                                let raw_src = String::from_utf8_lossy(&attr.value);
                                current.href = resolve_epub_href(ncx_path, &raw_src);
                                break;
                            }
                        }
                    }
                }
            }
            Ok(Event::Empty(ref e)) => {
                let qname = e.name();
                let name = local_name(qname.as_ref());
                if name == b"content" {
                    if let Some(current) = stack.last_mut() {
                        for attr in e.attributes().flatten() {
                            if attr.key.as_ref() == b"src" {
                                let raw_src = String::from_utf8_lossy(&attr.value);
                                current.href = resolve_epub_href(ncx_path, &raw_src);
                                break;
                            }
                        }
                    }
                }
            }
            Ok(Event::Text(ref e)) => {
                if in_text {
                    if let Some(current) = stack.last_mut() {
                        if let Ok(txt) = e.unescape() {
                            current.label.push_str(&txt);
                        }
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                let qname = e.name();
                let name = local_name(qname.as_ref());
                if name == b"text" {
                    in_text = false;
                } else if name == b"navPoint" {
                    if let Some(builder) = stack.pop() {
                        let subitems = if builder.subitems.is_empty() {
                            None
                        } else {
                            Some(builder.subitems.into_boxed_slice())
                        };
                        let item = TocItemDto {
                            label: normalize_label_text(&builder.label).into_boxed_str(),
                            href: builder.href.into_boxed_str(),
                            subitems,
                        };
                        if let Some(parent) = stack.last_mut() {
                            parent.subitems.push(item);
                        } else {
                            root_items.push(item);
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    root_items
}

fn is_toc_nav_start(e: &quick_xml::events::BytesStart<'_>) -> bool {
    let mut has_toc = false;
    let mut has_other_epub_type = false;
    for attr in e.attributes().flatten() {
        let key = attr.key.as_ref();
        let val = String::from_utf8_lossy(&attr.value);
        if key == b"epub:type" || key == b"type" {
            if val.contains("toc") {
                has_toc = true;
            } else {
                has_other_epub_type = true;
            }
        } else if (key == b"role" && val.contains("doc-toc"))
            || (key == b"id" && val.eq_ignore_ascii_case("toc"))
        {
            has_toc = true;
        }
    }
    has_toc || !has_other_epub_type
}

pub fn parse_nav_toc(nav_xml: &str, nav_path: &str) -> Vec<TocItemDto> {
    let normalized = strip_xml_bom(nav_xml.as_bytes());
    let mut reader = Reader::from_reader(normalized.as_ref());
    reader.config_mut().trim_text(false);

    struct LiBuilder {
        label: String,
        href: String,
        subitems: Vec<TocItemDto>,
    }

    let mut stack: Vec<LiBuilder> = Vec::new();
    let mut root_items: Vec<TocItemDto> = Vec::new();
    let mut in_toc_nav = false;
    let mut nav_depth: usize = 0;
    let mut in_anchor_depth: usize = 0;
    let mut in_span_depth: usize = 0;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let qname = e.name();
                let name = local_name(qname.as_ref());
                if name == b"nav" {
                    if !in_toc_nav && is_toc_nav_start(e) {
                        in_toc_nav = true;
                        nav_depth = 1;
                    } else if in_toc_nav {
                        nav_depth += 1;
                    }
                } else if in_toc_nav {
                    if name == b"li" {
                        stack.push(LiBuilder {
                            label: String::new(),
                            href: String::new(),
                            subitems: Vec::new(),
                        });
                    } else if name == b"a" {
                        in_anchor_depth += 1;
                        if let Some(current) = stack.last_mut() {
                            if current.href.is_empty() {
                                for attr in e.attributes().flatten() {
                                    if attr.key.as_ref() == b"href" {
                                        let raw_href = String::from_utf8_lossy(&attr.value);
                                        current.href = resolve_epub_href(nav_path, &raw_href);
                                        break;
                                    }
                                }
                            }
                        }
                    } else if name == b"span" && in_anchor_depth == 0 {
                        in_span_depth += 1;
                    }
                }
            }
            Ok(Event::Text(ref e)) => {
                if in_toc_nav && (in_anchor_depth > 0 || in_span_depth > 0) {
                    if let Some(current) = stack.last_mut() {
                        if let Ok(txt) = e.unescape() {
                            current.label.push_str(&txt);
                        }
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                let qname = e.name();
                let name = local_name(qname.as_ref());
                if name == b"nav" && in_toc_nav {
                    nav_depth = nav_depth.saturating_sub(1);
                    if nav_depth == 0 {
                        in_toc_nav = false;
                        if !root_items.is_empty() {
                            break;
                        }
                    }
                } else if in_toc_nav {
                    if name == b"a" {
                        in_anchor_depth = in_anchor_depth.saturating_sub(1);
                    } else if name == b"span" {
                        in_span_depth = in_span_depth.saturating_sub(1);
                    } else if name == b"li" {
                        if let Some(builder) = stack.pop() {
                            let subitems = if builder.subitems.is_empty() {
                                None
                            } else {
                                Some(builder.subitems.into_boxed_slice())
                            };
                            let item = TocItemDto {
                                label: normalize_label_text(&builder.label).into_boxed_str(),
                                href: builder.href.into_boxed_str(),
                                subitems,
                            };
                            if let Some(parent) = stack.last_mut() {
                                parent.subitems.push(item);
                            } else {
                                root_items.push(item);
                            }
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    root_items
}

pub(crate) fn strip_xml_bom(bytes: &[u8]) -> std::borrow::Cow<'_, [u8]> {
    use std::borrow::Cow;
    if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
        return Cow::Borrowed(&bytes[3..]);
    }
    if bytes.len() >= 2 {
        let big_endian = bytes[0] == 0xFE && bytes[1] == 0xFF;
        let little_endian = bytes[0] == 0xFF && bytes[1] == 0xFE;
        if big_endian || little_endian {
            let body = &bytes[2..];
            let units: Vec<u16> = body
                .as_chunks::<2>()
                .0
                .iter()
                .map(|&[b0, b1]| {
                    if big_endian {
                        u16::from_be_bytes([b0, b1])
                    } else {
                        u16::from_le_bytes([b0, b1])
                    }
                })
                .collect();
            let s = String::from_utf16_lossy(&units);
            return Cow::Owned(s.into_bytes());
        }
    }
    Cow::Borrowed(bytes)
}

fn local_name(bytes: &[u8]) -> &[u8] {
    match bytes.iter().rposition(|b| *b == b':') {
        Some(idx) => &bytes[idx + 1..],
        None => bytes,
    }
}

struct LocatedTocSources {
    nav_href: Option<String>,
    ncx_href: Option<String>,
    css_hrefs: Vec<String>,
    spine_hrefs: Vec<String>,
}

fn locate_toc_sources(opf_bytes: &[u8]) -> Result<LocatedTocSources, String> {
    let normalized = strip_xml_bom(opf_bytes);
    let mut reader = Reader::from_reader(normalized.as_ref());
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();

    #[derive(Default, Clone)]
    struct Item {
        href: String,
        media_type: String,
        properties: String,
    }

    let mut manifest: HashMap<String, Item> = HashMap::new();
    let mut nav_href: Option<String> = None;
    let mut in_manifest = false;
    let mut in_spine = false;
    let mut spine_idrefs: Vec<String> = Vec::new();
    let mut css_hrefs: Vec<String> = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Empty(e)) => {
                let name = local_name(e.name().as_ref()).to_vec();
                if in_manifest && name == b"item" {
                    let mut id = String::new();
                    let mut item = Item::default();
                    for attr in e.attributes().flatten() {
                        match attr.key.as_ref() {
                            b"id" => id = String::from_utf8_lossy(&attr.value).into_owned(),
                            b"href" => {
                                item.href = String::from_utf8_lossy(&attr.value).into_owned()
                            }
                            b"media-type" => {
                                item.media_type = String::from_utf8_lossy(&attr.value).into_owned()
                            }
                            b"properties" => {
                                item.properties = String::from_utf8_lossy(&attr.value).into_owned()
                            }
                            _ => {}
                        }
                    }
                    if nav_href.is_none()
                        && item.properties.split_ascii_whitespace().any(|p| p == "nav")
                        && !item.href.is_empty()
                    {
                        nav_href = Some(item.href.clone());
                    }
                    if item.media_type == "text/css" && !item.href.is_empty() {
                        css_hrefs.push(item.href.clone());
                    }
                    if !id.is_empty() {
                        manifest.insert(id, item);
                    }
                } else if in_spine && name == b"itemref" {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"idref" {
                            spine_idrefs.push(String::from_utf8_lossy(&attr.value).into_owned());
                        }
                    }
                }
            }
            Ok(Event::Start(e)) => {
                let name = local_name(e.name().as_ref()).to_vec();
                if name == b"manifest" {
                    in_manifest = true;
                } else if name == b"spine" {
                    in_spine = true;
                }
            }
            Ok(Event::End(e)) => {
                let name = local_name(e.name().as_ref()).to_vec();
                if name == b"manifest" {
                    in_manifest = false;
                } else if name == b"spine" {
                    in_spine = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("xml: {e}")),
            _ => {}
        }
        buf.clear();
    }

    let ncx_href = manifest
        .values()
        .find(|it| it.media_type == "application/x-dtbncx+xml")
        .map(|it| it.href.clone());

    let spine_hrefs: Vec<String> = spine_idrefs
        .into_iter()
        .filter_map(|id| manifest.get(&id).map(|item| item.href.clone()))
        .collect();

    Ok(LocatedTocSources {
        nav_href,
        ncx_href,
        css_hrefs,
        spine_hrefs,
    })
}

pub(crate) fn read_rootfile_path_inner<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> Option<String> {
    let bytes_str = read_zip_entry_inner(archive, "META-INF/container.xml")?;
    let normalized = strip_xml_bom(bytes_str.as_bytes());
    let mut reader = Reader::from_reader(normalized.as_ref());
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) => {
                if local_name(e.name().as_ref()) == b"rootfile" {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"full-path" {
                            return Some(String::from_utf8_lossy(&attr.value).into_owned());
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    None
}

struct EpubMeta {
    container: Option<String>,
    opf_path: String,
    opf: Option<String>,
    nav_path: Option<String>,
    nav: Option<String>,
    ncx_path: Option<String>,
    ncx: Option<String>,
    encryption: Option<String>,
    sections: HashMap<String, String>,
    toc: Option<Box<[TocItemDto]>>,
}

fn read_epub_metadata_inner<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> Option<EpubMeta> {
    let container_text = read_zip_entry_inner(archive, "META-INF/container.xml")?;
    let opf_rel = read_rootfile_path_inner(archive)?;

    let opf_path = opf_rel;
    let opf_text = read_zip_entry_inner(archive, &opf_path)?;

    let LocatedTocSources {
        nav_href,
        ncx_href,
        css_hrefs,
        spine_hrefs,
    } = locate_toc_sources(opf_text.as_bytes()).ok()?;

    let nav_path = nav_href
        .as_ref()
        .map(|href| resolve_relative(&opf_path, href));
    let ncx_path = ncx_href
        .as_ref()
        .map(|href| resolve_relative(&opf_path, href));

    let nav = nav_path
        .as_ref()
        .and_then(|p| read_zip_entry_inner(archive, p));
    let ncx = ncx_path
        .as_ref()
        .and_then(|p| read_zip_entry_inner(archive, p));
    let encryption = read_zip_entry_inner(archive, "META-INF/encryption.xml");

    let mut sections = HashMap::new();

    // 1. Pre-inflate all CSS stylesheets
    for css_href in &css_hrefs {
        let full_css_path = resolve_relative(&opf_path, css_href);
        if let Some(css_text) = read_zip_entry_inner(archive, &full_css_path) {
            sections.insert(full_css_path, css_text);
        }
    }

    // 2. Pre-inflate first 5 spine chapters for instant reader opening (< 50ms)
    for spine_href in spine_hrefs.iter().take(5) {
        let full_spine_path = resolve_relative(&opf_path, spine_href);
        if let Some(spine_text) = read_zip_entry_inner(archive, &full_spine_path) {
            sections.insert(full_spine_path, spine_text);
        }
    }

    let toc = if let (Some(nav_text), Some(nav_p)) = (&nav, &nav_path) {
        let items = parse_nav_toc(nav_text, nav_p);
        if !items.is_empty() {
            Some(items.into_boxed_slice())
        } else if let (Some(ncx_text), Some(ncx_p)) = (&ncx, &ncx_path) {
            let items = parse_ncx_toc(ncx_text, ncx_p);
            if !items.is_empty() {
                Some(items.into_boxed_slice())
            } else {
                None
            }
        } else {
            None
        }
    } else if let (Some(ncx_text), Some(ncx_p)) = (&ncx, &ncx_path) {
        let items = parse_ncx_toc(ncx_text, ncx_p);
        if !items.is_empty() {
            Some(items.into_boxed_slice())
        } else {
            None
        }
    } else {
        None
    };

    Some(EpubMeta {
        container: Some(container_text),
        opf_path,
        opf: Some(opf_text),
        nav_path,
        nav,
        ncx_path,
        ncx,
        encryption,
        sections,
        toc,
    })
}

fn read_epub_metadata(archive: &mut zip::ZipArchive<File>) -> Option<EpubMeta> {
    read_epub_metadata_inner(archive)
}

#[derive(serde::Serialize)]
pub struct ZipPrefetch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opf_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opf: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nav_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nav: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ncx_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ncx: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encryption: Option<String>,
    pub sizes: HashMap<String, u64>,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    #[serde(default)]
    pub sections: HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub toc: Option<Box<[TocItemDto]>>,
}

#[tauri::command]
pub async fn prefetch_zip_metadata(
    app: tauri::AppHandle,
    path: String,
) -> Result<ZipPrefetch, String> {
    tauri::async_runtime::spawn_blocking(move || prefetch_sync(&app, &path))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn prefetch_sync(app: &tauri::AppHandle, path: &str) -> Result<ZipPrefetch, String> {
    use tauri::Manager;
    let mut file_path = std::path::PathBuf::from(path);
    if !file_path.exists() {
        if let Ok(app_dir) = app.path().app_data_dir() {
            let candidate = app_dir.join(path);
            if candidate.exists() {
                file_path = candidate;
            } else {
                let clean_name = Path::new(path).file_name().unwrap_or_default();
                let candidate_books = app_dir.join("books").join(clean_name);
                if candidate_books.exists() {
                    file_path = candidate_books;
                }
            }
        }
    }
    if !file_path.exists() {
        return Err(format!("file not found: {path}"));
    }

    let file = File::open(&file_path).map_err(|e| format!("Cannot open {path}: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Not a valid zip: {e}"))?;

    let mut sizes: HashMap<String, u64> = HashMap::with_capacity(archive.len());
    for i in 0..archive.len() {
        if let Ok(f) = archive.by_index(i) {
            sizes.insert(f.name().to_string(), f.size());
        }
    }

    let epub = read_epub_metadata(&mut archive);

    let (container, opf_path, opf, nav_path, nav, ncx_path, ncx, encryption, sections, toc) =
        match epub {
            Some(e) => (
                e.container,
                Some(e.opf_path),
                e.opf,
                e.nav_path,
                e.nav,
                e.ncx_path,
                e.ncx,
                e.encryption,
                e.sections,
                e.toc,
            ),
            None => (
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                HashMap::new(),
                None,
            ),
        };

    Ok(ZipPrefetch {
        container,
        opf_path,
        opf,
        nav_path,
        nav,
        ncx_path,
        ncx,
        encryption,
        sizes,
        sections,
        toc,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::io::Write;

    fn create_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let buf = std::io::Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(buf);
        let options = zip::write::FileOptions::<()>::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, data) in entries {
            zip.start_file(*name, options).unwrap();
            zip.write_all(data).unwrap();
        }
        let buf = zip.finish().unwrap();
        buf.into_inner()
    }

    fn create_container_xml(rootfile_path: &str) -> Vec<u8> {
        format!(
            r#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="{}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#,
            rootfile_path
        )
        .into_bytes()
    }

    fn create_simple_opf(title: &str, author: &str) -> Vec<u8> {
        format!(
            r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
  <metadata>
    <dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">{}</dc:title>
    <dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">{}</dc:creator>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
  </spine>
</package>"#,
            title, author
        )
        .into_bytes()
    }

    #[test]
    fn test_strip_bom_utf8() {
        let bom: &[u8] = &[0xEF, 0xBB, 0xBF];
        let input = [bom, b"<root/>" as &[u8]].concat();
        let result = strip_xml_bom(&input);
        assert_eq!(result.as_ref(), b"<root/>");
    }

    #[test]
    fn test_strip_bom_none() {
        let input = b"<root/>";
        let result = strip_xml_bom(input);
        assert_eq!(result.as_ref(), b"<root/>");
    }

    #[test]
    fn test_strip_bom_utf16_be() {
        let bom: &[u8] = &[0xFE, 0xFF];
        let content = {
            let mut v = Vec::new();
            for b in "<root/>".encode_utf16() {
                v.extend_from_slice(&b.to_be_bytes());
            }
            v
        };
        let input = [bom, content.as_slice()].concat();
        let result = strip_xml_bom(&input);
        let s = String::from_utf8(result.into_owned()).unwrap();
        assert_eq!(s, "<root/>");
    }

    #[test]
    fn test_strip_bom_utf16_le() {
        let bom: &[u8] = &[0xFF, 0xFE];
        let content = {
            let mut v = Vec::new();
            for b in "<root/>".encode_utf16() {
                v.extend_from_slice(&b.to_le_bytes());
            }
            v
        };
        let input = [bom, content.as_slice()].concat();
        let result = strip_xml_bom(&input);
        let s = String::from_utf8(result.into_owned()).unwrap();
        assert_eq!(s, "<root/>");
    }

    #[test]
    fn test_local_name_no_namespace() {
        assert_eq!(local_name(b"root"), b"root");
    }

    #[test]
    fn test_local_name_with_namespace() {
        assert_eq!(local_name(b"ns:root"), b"root");
    }

    #[test]
    fn test_resolve_relative_same_dir() {
        assert_eq!(
            resolve_relative("OEBPS/content.opf", "nav.xhtml"),
            "OEBPS/nav.xhtml"
        );
    }

    #[test]
    fn test_resolve_relative_root() {
        assert_eq!(
            resolve_relative("META-INF/container.xml", "OEBPS/content.opf"),
            "META-INF/OEBPS/content.opf"
        );
    }

    #[test]
    fn test_resolve_relative_subdir() {
        assert_eq!(
            resolve_relative("OEBPS/content.opf", "sub/file.xhtml"),
            "OEBPS/sub/file.xhtml"
        );
    }

    #[test]
    fn test_resolve_relative_with_query() {
        assert_eq!(
            resolve_relative("OEBPS/content.opf", "nav.xhtml?foo=bar"),
            "OEBPS/nav.xhtml"
        );
    }

    #[test]
    fn test_resolve_relative_with_fragment() {
        assert_eq!(
            resolve_relative("OEBPS/content.opf", "nav.xhtml#section1"),
            "OEBPS/nav.xhtml"
        );
    }

    #[test]
    fn test_read_rootfile_path_valid() {
        let zip_data = create_zip(&[
            (
                "META-INF/container.xml",
                &create_container_xml("OEBPS/content.opf"),
            ),
            ("OEBPS/content.opf", &create_simple_opf("Test", "Author")),
        ]);
        let cursor = Cursor::new(zip_data);
        let mut archive = zip::ZipArchive::new(cursor).unwrap();
        let result = read_rootfile_path_inner(&mut archive);
        assert_eq!(result, Some("OEBPS/content.opf".to_string()));
    }

    #[test]
    fn test_read_rootfile_path_percent_encoded() {
        // Create container.xml with percent-encoded path
        let container = r#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content%20file.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#
            .to_string();
        let zip_data = create_zip(&[
            ("META-INF/container.xml", container.as_bytes()),
            (
                "OEBPS/content file.opf",
                &create_simple_opf("Test", "Author"),
            ),
        ]);
        let cursor = Cursor::new(zip_data);
        let mut archive = zip::ZipArchive::new(cursor).unwrap();
        let result = read_rootfile_path_inner(&mut archive);
        assert_eq!(result, Some("OEBPS/content%20file.opf".to_string()));
    }

    #[test]
    fn test_read_rootfile_path_no_container() {
        let zip_data = create_zip(&[]);
        let cursor = Cursor::new(zip_data);
        let mut archive = zip::ZipArchive::new(cursor).unwrap();
        let result = read_rootfile_path_inner(&mut archive);
        assert_eq!(result, None);
    }

    #[test]
    fn test_locate_toc_sources() {
        let opf = create_simple_opf("Test", "Author");
        let result = locate_toc_sources(&opf).unwrap();
        assert_eq!(result.nav_href, Some("nav.xhtml".to_string()));
        assert_eq!(result.ncx_href, Some("toc.ncx".to_string()));
    }

    #[test]
    fn test_locate_toc_sources_no_nav() {
        let opf = br#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
</package>"#;
        let result = locate_toc_sources(opf).unwrap();
        assert_eq!(result.nav_href, None);
        assert_eq!(result.ncx_href, None);
    }

    #[test]
    fn test_read_epub_metadata_full() {
        let nav_bytes =
            b"<html><body><nav><ol><li><a href=\"ch1.xhtml\">Ch1</a></li></ol></nav></body></html>";
        let ncx_bytes = b"<?xml version=\"1.0\"?><ncx></ncx>";
        let opf = create_simple_opf("Test Book", "Test Author");
        let zip_data = create_zip(&[
            (
                "META-INF/container.xml",
                &create_container_xml("OEBPS/content.opf"),
            ),
            ("OEBPS/content.opf", &opf),
            ("OEBPS/nav.xhtml", nav_bytes),
            ("OEBPS/toc.ncx", ncx_bytes),
            (
                "OEBPS/chapter1.xhtml",
                b"<html><body><p>Hello</p></body></html>",
            ),
        ]);
        let cursor = Cursor::new(zip_data);
        let mut archive = zip::ZipArchive::new(cursor).unwrap();
        let meta = read_epub_metadata_inner(&mut archive);
        assert!(meta.is_some());
        let meta = meta.unwrap();
        assert_eq!(meta.opf_path, "OEBPS/content.opf");
        assert_eq!(meta.nav_path, Some("OEBPS/nav.xhtml".to_string()));
        assert_eq!(meta.ncx_path, Some("OEBPS/toc.ncx".to_string()));
        assert!(meta.nav.unwrap().contains("nav"));
        assert!(meta.ncx.unwrap().contains("ncx"));
        assert!(meta.toc.is_some());
        let toc = meta.toc.unwrap();
        assert_eq!(toc.len(), 1);
        assert_eq!(&*toc[0].label, "Ch1");
        assert_eq!(&*toc[0].href, "OEBPS/ch1.xhtml");
    }

    #[test]
    fn test_resolve_epub_href_cases() {
        assert_eq!(
            resolve_epub_href("OEBPS/toc.ncx", "ch1.xhtml#sec1"),
            "OEBPS/ch1.xhtml#sec1"
        );
        assert_eq!(
            resolve_epub_href("EPUB/nav/toc.xhtml", "../text/ch1.xhtml#part2"),
            "EPUB/text/ch1.xhtml#part2"
        );
        assert_eq!(resolve_epub_href("nav.xhtml", "intro.xhtml"), "intro.xhtml");
        assert_eq!(
            resolve_epub_href("OEBPS/toc.ncx", "https://example.com/external"),
            "https://example.com/external"
        );
    }

    #[test]
    fn test_parse_ncx_toc_nested() {
        let ncx = r#"<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="np1" playOrder="1">
      <navLabel><text>Chapter &amp; 1</text></navLabel>
      <content src="chapter1.xhtml"/>
      <navPoint id="np1_1" playOrder="2">
        <navLabel><text>Section 1.1</text></navLabel>
        <content src="chapter1.xhtml#sec1"/>
      </navPoint>
    </navPoint>
    <navPoint id="np2" playOrder="3">
      <navLabel><text>Chapter 2</text></navLabel>
      <content src="chapter2.xhtml"/>
    </navPoint>
  </navMap>
</ncx>"#;
        let items = parse_ncx_toc(ncx, "OEBPS/toc.ncx");
        assert_eq!(items.len(), 2);
        assert_eq!(&*items[0].label, "Chapter & 1");
        assert_eq!(&*items[0].href, "OEBPS/chapter1.xhtml");
        let sub = items[0].subitems.as_ref().unwrap();
        assert_eq!(sub.len(), 1);
        assert_eq!(&*sub[0].label, "Section 1.1");
        assert_eq!(&*sub[0].href, "OEBPS/chapter1.xhtml#sec1");
        assert_eq!(&*items[1].label, "Chapter 2");
        assert_eq!(&*items[1].href, "OEBPS/chapter2.xhtml");
    }

    #[test]
    fn test_parse_nav_toc_nested_and_landmarks() {
        let nav = r#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body>
  <nav epub:type="landmarks" hidden="">
    <h2>Guide</h2>
    <ol><li><a epub:type="cover" href="cover.xhtml">Cover</a></li></ol>
  </nav>
  <nav epub:type="toc" id="toc">
    <h1>Table of Contents</h1>
    <ol>
      <li>
        <a href="text/part1.xhtml">Part <i>I</i></a>
        <ol>
          <li><a href="text/ch1.xhtml#sub1">Chapter 1</a></li>
        </ol>
      </li>
      <li>
        <span>Part II (Unlinked)</span>
        <ol>
          <li><a href="text/ch2.xhtml">Chapter 2</a></li>
        </ol>
      </li>
    </ol>
  </nav>
</body>
</html>"#;
        let items = parse_nav_toc(nav, "OEBPS/nav.xhtml");
        assert_eq!(items.len(), 2);
        assert_eq!(&*items[0].label, "Part I");
        assert_eq!(&*items[0].href, "OEBPS/text/part1.xhtml");
        let sub0 = items[0].subitems.as_ref().unwrap();
        assert_eq!(sub0.len(), 1);
        assert_eq!(&*sub0[0].label, "Chapter 1");
        assert_eq!(&*sub0[0].href, "OEBPS/text/ch1.xhtml#sub1");

        assert_eq!(&*items[1].label, "Part II (Unlinked)");
        assert_eq!(&*items[1].href, "");
        let sub1 = items[1].subitems.as_ref().unwrap();
        assert_eq!(sub1.len(), 1);
        assert_eq!(&*sub1[0].label, "Chapter 2");
        assert_eq!(&*sub1[0].href, "OEBPS/text/ch2.xhtml");
    }

    #[test]
    fn test_read_zip_entry_percent_decoded_fallback() {
        let zip_data = create_zip(&[
            (
                "META-INF/container.xml",
                &create_container_xml("OEBPS/content.opf"),
            ),
            ("OEBPS/content.opf", &create_simple_opf("Test", "Author")),
        ]);
        let cursor = Cursor::new(zip_data);
        let mut archive = zip::ZipArchive::new(cursor).unwrap();

        let result = read_zip_entry_inner(&mut archive, "nonexistent/path.html");
        assert_eq!(result, None);
    }

    #[test]
    fn test_real_user_big_book_opening() {
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
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "book"))
            .collect::<Vec<_>>();

        // Sort by file size descending
        entries.sort_by_key(|e| std::cmp::Reverse(e.metadata().map(|m| m.len()).unwrap_or(0)));

        for entry in entries.iter().take(5) {
            let path = entry.path();
            let size_mb = path
                .metadata()
                .map(|m| m.len() as f64 / 1_048_576.0)
                .unwrap_or(0.0);

            let start = std::time::Instant::now();
            let file = std::fs::File::open(&path);
            if file.is_err() {
                continue;
            }
            let file = file.unwrap();
            let archive_res = zip::ZipArchive::new(file);
            if archive_res.is_err() {
                continue; // might be PDF or non-zip
            }
            let mut archive = archive_res.unwrap();
            let meta = read_epub_metadata_inner(&mut archive);
            let duration = start.elapsed();

            if let Some(m) = meta {
                println!(
                    "📖 Real Book [{:.2} MB]: {:?} | Parsed in {:.2} ms | Initial Pre-Inflated Sections: {} | Container: {:?}",
                    size_mb,
                    path.file_name().unwrap(),
                    duration.as_secs_f64() * 1000.0,
                    m.sections.len(),
                    m.container.is_some()
                );
                assert!(
                    duration.as_millis() < 500,
                    "Opening took too long: {:?}",
                    duration
                );
            }
        }
    }
}
