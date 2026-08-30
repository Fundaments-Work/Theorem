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
                    if !id.is_empty() {
                        manifest.insert(id, item);
                    }
                }
            }
            Ok(Event::Start(e)) => {
                let name = local_name(e.name().as_ref()).to_vec();
                if name == b"manifest" {
                    in_manifest = true;
                }
            }
            Ok(Event::End(e)) => {
                let name = local_name(e.name().as_ref()).to_vec();
                if name == b"manifest" {
                    in_manifest = false;
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

    Ok(LocatedTocSources { nav_href, ncx_href })
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
}

fn read_epub_metadata_inner<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> Option<EpubMeta> {
    let container_text = read_zip_entry_inner(archive, "META-INF/container.xml")?;
    let opf_rel = read_rootfile_path_inner(archive)?;

    let opf_path = opf_rel;
    let opf_text = read_zip_entry_inner(archive, &opf_path)?;

    let LocatedTocSources { nav_href, ncx_href } = locate_toc_sources(opf_text.as_bytes()).ok()?;

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

    Some(EpubMeta {
        container: Some(container_text),
        opf_path,
        opf: Some(opf_text),
        nav_path,
        nav,
        ncx_path,
        ncx,
        encryption,
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

fn prefetch_sync(_app: &tauri::AppHandle, path: &str) -> Result<ZipPrefetch, String> {
    let file_path = Path::new(path);
    if !file_path.exists() {
        return Err(format!("file not found: {path}"));
    }

    let file = File::open(file_path).map_err(|e| format!("Cannot open {path}: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Not a valid zip: {e}"))?;

    let mut sizes: HashMap<String, u64> = HashMap::with_capacity(archive.len());
    for i in 0..archive.len() {
        if let Ok(f) = archive.by_index(i) {
            sizes.insert(f.name().to_string(), f.size());
        }
    }

    let epub = read_epub_metadata(&mut archive);

    Ok(ZipPrefetch {
        container: epub.as_ref().and_then(|e| e.container.clone()),
        opf_path: epub.as_ref().map(|e| e.opf_path.clone()),
        opf: epub.as_ref().and_then(|e| e.opf.clone()),
        nav_path: epub.as_ref().and_then(|e| e.nav_path.clone()),
        nav: epub.as_ref().and_then(|e| e.nav.clone()),
        ncx_path: epub.as_ref().and_then(|e| e.ncx_path.clone()),
        ncx: epub.as_ref().and_then(|e| e.ncx.clone()),
        encryption: epub.as_ref().and_then(|e| e.encryption.clone()),
        sizes,
        sections: HashMap::new(),
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
            zip.start_file(*name, options.clone()).unwrap();
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
        let container = format!(
            r#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content%20file.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#
        );
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
}
