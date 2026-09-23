use std::io::{Cursor, Read, Write};

use crate::database;
use crate::epub_parser::{
    read_rootfile_path_inner, read_zip_entry_inner, resolve_relative, strip_xml_bom,
};

#[derive(serde::Deserialize, Default)]
#[serde(default)]
pub struct EpubMetadataEdit {
    pub title: Option<String>,
    pub author: Option<String>,
    pub description: Option<String>,
    pub publisher: Option<String>,
    pub published_date: Option<String>,
    pub language: Option<String>,
    pub isbn: Option<String>,
    pub category: Option<String>,
}

#[derive(serde::Serialize)]
pub struct RewriteResult {
    pub size: u64,
}

fn find_ci(haystack: &str, needle: &str) -> Option<usize> {
    let needle_bytes = needle.as_bytes();
    if needle_bytes.is_empty() {
        return Some(0);
    }
    haystack
        .as_bytes()
        .windows(needle_bytes.len())
        .position(|window| window.eq_ignore_ascii_case(needle_bytes))
}

fn escape_xml_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn find_metadata_span(opf: &str) -> Result<(usize, usize), String> {
    let start = find_ci(opf, "<metadata").ok_or("metadata element not found in OPF")?;
    let tag_end_rel = opf[start..]
        .find('>')
        .ok_or("metadata start tag is not closed")?;
    let tag_end = start + tag_end_rel;
    let after_open = tag_end + 1;
    let close_rel =
        find_ci(&opf[after_open..], "</metadata").ok_or("</metadata> closing tag not found")?;
    let close_start = after_open + close_rel;
    Ok((after_open, close_start))
}

fn find_dc_element_range(metadata: &str, field: &str) -> Option<(usize, usize)> {
    let open_tag = format!("<dc:{field}");
    let open_rel = find_ci(metadata, &open_tag)?;
    let after_open = &metadata[open_rel..];
    let gt_rel = after_open.find('>')?;
    let content_start = open_rel + gt_rel + 1;

    let close_tag = format!("</dc:{field}");
    let tail = &metadata[content_start..];
    let close_rel = find_ci(tail, &close_tag)?;
    let close_start = content_start + close_rel;

    Some((content_start, close_start))
}

fn replace_or_insert_dc(metadata: &str, field: &str, value: &str) -> String {
    let escaped = escape_xml_text(value);
    if let Some((start, end)) = find_dc_element_range(metadata, field) {
        let mut out = String::with_capacity(metadata.len() + escaped.len());
        out.push_str(&metadata[..start]);
        out.push_str(&escaped);
        out.push_str(&metadata[end..]);
        out
    } else {
        let fragment = format!(
            "    <dc:{field} xmlns:dc=\"http://purl.org/dc/elements/1.1/\">{}</dc:{field}>\n  ",
            escaped
        );
        let mut out = String::with_capacity(metadata.len() + fragment.len());
        out.push_str(&fragment);
        out.push_str(metadata);
        out
    }
}

fn extract_attr(tag: &str, attr: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let attr_lower = attr.to_ascii_lowercase();
    let mut search_from = 0;
    while let Some(rel) = lower[search_from..].find(&attr_lower) {
        let idx = search_from + rel;
        let before_ok = idx == 0
            || lower.as_bytes()[idx - 1].is_ascii_whitespace()
            || matches!(lower.as_bytes()[idx - 1], b'<' | b'/');
        let after = lower[idx + attr_lower.len()..].trim_start();
        if before_ok && after.starts_with('=') {
            let rest = after[1..].trim_start();
            let (delim, value) = if let Some(v) = rest.strip_prefix('"') {
                ('"', v)
            } else if let Some(v) = rest.strip_prefix('\'') {
                ('\'', v)
            } else {
                search_from = idx + attr_lower.len();
                continue;
            };
            let end = value.find(delim)?;
            return Some(value[..end].to_string());
        }
        search_from = idx + attr_lower.len();
    }
    None
}

fn find_tags<'a>(xml: &'a str, name: &str) -> Vec<&'a str> {
    let lower = xml.to_ascii_lowercase();
    let needle = format!("<{name}");
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(rel) = lower[from..].find(&needle) {
        let start = from + rel;
        if let Some(gt_rel) = xml[start..].find('>') {
            let end = start + gt_rel + 1;
            out.push(&xml[start..end]);
            from = end;
        } else {
            break;
        }
    }
    out
}

fn has_cover_meta(opf: &str) -> bool {
    for meta in find_tags(opf, "meta") {
        if extract_attr(meta, "name")
            .map(|n| n.eq_ignore_ascii_case("cover"))
            .unwrap_or(false)
        {
            return true;
        }
    }
    false
}

fn find_cover_href_by_property(opf: &str) -> Option<String> {
    for item in find_tags(opf, "item") {
        let props = extract_attr(item, "properties")?;
        if props
            .split_ascii_whitespace()
            .any(|p| p.eq_ignore_ascii_case("cover-image"))
        {
            return extract_attr(item, "href");
        }
    }
    None
}

fn find_cover_href_by_meta(opf: &str) -> Option<String> {
    for meta in find_tags(opf, "meta") {
        if extract_attr(meta, "name")
            .map(|n| n.eq_ignore_ascii_case("cover"))
            .unwrap_or(false)
        {
            let content = extract_attr(meta, "content")?;
            for item in find_tags(opf, "item") {
                if extract_attr(item, "id").as_deref() == Some(content.as_str()) {
                    return extract_attr(item, "href");
                }
            }
        }
    }
    None
}

const COVER_ITEM_ID: &str = "theorem-cover";

fn insert_cover_manifest_item(opf: &str, href: &str) -> String {
    let close = match find_ci(opf, "</manifest") {
        Some(close) => close,
        None => return opf.to_string(),
    };
    let item = format!(
        "    <item id=\"{COVER_ITEM_ID}\" href=\"{href}\" media-type=\"image/png\" properties=\"cover-image\"/>\n  "
    );
    let mut out = String::with_capacity(opf.len() + item.len());
    out.push_str(&opf[..close]);
    out.push_str(&item);
    out.push_str(&opf[close..]);
    out
}

fn insert_cover_meta(opf: &str) -> String {
    if has_cover_meta(opf) {
        return opf.to_string();
    }
    let (start, end) = match find_metadata_span(opf) {
        Ok(span) => span,
        Err(_) => return opf.to_string(),
    };
    let meta = format!("    <meta name=\"cover\" content=\"{COVER_ITEM_ID}\"/>\n  ");
    let mut out = String::with_capacity(opf.len() + meta.len());
    out.push_str(&opf[..start]);
    out.push_str(&meta);
    out.push_str(&opf[start..end]);
    out.push_str(&opf[end..]);
    out
}

fn normalize_entry_name(name: &str) -> String {
    name.replace('\\', "/")
}

fn rewrite_zip(
    input: &[u8],
    opf_path: &str,
    new_opf: &str,
    cover_path: Option<&str>,
    cover_bytes: Option<&[u8]>,
    add_cover_entry: Option<(String, &[u8])>,
) -> Result<Vec<u8>, String> {
    let reader = Cursor::new(input);
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| format!("Not a valid zip: {e}"))?;

    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::FileOptions::<()>::default()
        .compression_method(zip::CompressionMethod::Deflated);

    for i in 0..archive.len() {
        let (name, is_dir) = {
            let entry = archive
                .by_index(i)
                .map_err(|e| format!("Failed to read zip entry {i}: {e}"))?;
            (normalize_entry_name(entry.name()), entry.is_dir())
        };

        let target_opf = normalize_entry_name(opf_path);
        let mut buf: Vec<u8> = Vec::new();
        if name == target_opf {
            buf.extend_from_slice(new_opf.as_bytes());
        } else if let Some(cover_path) = cover_path {
            let target_cover = normalize_entry_name(cover_path);
            if name == target_cover {
                if let Some(cover_bytes) = cover_bytes {
                    buf.extend_from_slice(cover_bytes);
                } else {
                    let mut entry = archive
                        .by_index(i)
                        .map_err(|e| format!("Failed to read zip entry {i}: {e}"))?;
                    entry
                        .read_to_end(&mut buf)
                        .map_err(|e| format!("Failed to read entry {i}: {e}"))?;
                }
            } else {
                let mut entry = archive
                    .by_index(i)
                    .map_err(|e| format!("Failed to read zip entry {i}: {e}"))?;
                entry
                    .read_to_end(&mut buf)
                    .map_err(|e| format!("Failed to read entry {i}: {e}"))?;
            }
        } else {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("Failed to read zip entry {i}: {e}"))?;
            entry
                .read_to_end(&mut buf)
                .map_err(|e| format!("Failed to read entry {i}: {e}"))?;
        }

        if is_dir {
            let dir = name.clone();
            writer
                .add_directory(name, options)
                .map_err(|e| format!("Failed to write directory {dir}: {e}"))?;
        } else {
            let entry = name.clone();
            writer
                .start_file(name.clone(), options)
                .map_err(|e| format!("Failed to write entry {entry}: {e}"))?;
            writer
                .write_all(&buf)
                .map_err(|e| format!("Failed to write entry {entry}: {e}"))?;
        }
    }

    if let Some((name, bytes)) = add_cover_entry {
        let entry = name.clone();
        writer
            .start_file(name, options)
            .map_err(|e| format!("Failed to write entry {entry}: {e}"))?;
        writer
            .write_all(bytes)
            .map_err(|e| format!("Failed to write entry {entry}: {e}"))?;
    }

    writer
        .finish()
        .map(|cursor| cursor.into_inner())
        .map_err(|e| format!("Failed to finalize zip: {e}"))
}

fn rewrite_epub_bytes(
    input: &[u8],
    meta: &EpubMetadataEdit,
    cover: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    let reader = Cursor::new(input);
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| format!("Not a valid zip: {e}"))?;

    if archive.by_name("META-INF/encryption.xml").is_ok() {
        return Err("Encrypted EPUBs cannot be rewritten.".to_string());
    }

    let opf_path =
        read_rootfile_path_inner(&mut archive).ok_or("Could not locate the OPF (content.opf).")?;
    let opf_bytes = read_zip_entry_inner(&mut archive, &opf_path)
        .ok_or_else(|| format!("Could not read the OPF at '{opf_path}'."))?;
    let normalized_opf = strip_xml_bom(opf_bytes.as_bytes());
    let opf = String::from_utf8_lossy(&normalized_opf).into_owned();

    let mut new_opf = opf;
    let meta_fields: Vec<(&str, &str)> = meta
        .title
        .as_deref()
        .map(|v| ("title", v))
        .into_iter()
        .chain(meta.author.as_deref().map(|v| ("creator", v)))
        .chain(meta.description.as_deref().map(|v| ("description", v)))
        .chain(meta.publisher.as_deref().map(|v| ("publisher", v)))
        .chain(meta.published_date.as_deref().map(|v| ("date", v)))
        .chain(meta.language.as_deref().map(|v| ("language", v)))
        .chain(meta.isbn.as_deref().map(|v| ("identifier", v)))
        .chain(meta.category.as_deref().map(|v| ("subject", v)))
        .collect();

    if !meta_fields.is_empty() {
        match find_metadata_span(&new_opf) {
            Ok((start, end)) => {
                let mut meta_block = new_opf[start..end].to_string();
                for (field, value) in &meta_fields {
                    meta_block = replace_or_insert_dc(&meta_block, field, value);
                }
                new_opf = format!("{}{}{}", &new_opf[..start], meta_block, &new_opf[end..]);
            }
            Err(err) => return Err(err),
        }
    }

    let mut cover_path: Option<String> = None;
    let mut add_cover_entry: Option<(String, &[u8])> = None;

    if let Some(cover_bytes) = cover {
        match find_cover_href_by_property(&new_opf).or_else(|| find_cover_href_by_meta(&new_opf)) {
            Some(href) => {
                cover_path = Some(resolve_relative(&opf_path, &href));
            }
            None => {
                let href = "cover.png";
                let entry_path = resolve_relative(&opf_path, href);
                new_opf = insert_cover_manifest_item(&new_opf, href);
                new_opf = insert_cover_meta(&new_opf);
                cover_path = Some(entry_path.clone());
                add_cover_entry = Some((entry_path, cover_bytes));
            }
        }
    }

    rewrite_zip(
        input,
        &opf_path,
        &new_opf,
        cover_path.as_deref(),
        cover,
        add_cover_entry,
    )
}

pub fn rewrite_epub_metadata(
    app: tauri::AppHandle,
    book_id: String,
    metadata: Option<EpubMetadataEdit>,
    cover: Option<Vec<u8>>,
) -> Result<RewriteResult, String> {
    let path = database::materialized_book_path(&app, &book_id)?;
    // The file is replaced in place; close cached archives (Windows keeps
    // open files locked, and the cache must not serve the old central directory).
    crate::epub_entries::clear_cache();
    let bytes = std::fs::read(&path)
        .map_err(|e| format!("Failed to read stored book file for '{book_id}': {e}"))?;

    let new_bytes = rewrite_epub_bytes(&bytes, &metadata.unwrap_or_default(), cover.as_deref())?;
    let size = new_bytes.len() as u64;

    let tmp_path = path.with_extension(format!("rewrite-tmp-{}", std::process::id()));
    std::fs::write(&tmp_path, &new_bytes)
        .map_err(|e| format!("Failed to write rewritten EPUB: {e}"))?;
    std::fs::rename(&tmp_path, &path)
        .map_err(|e| format!("Failed to replace stored book file: {e}"))?;

    Ok(RewriteResult { size })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::FileOptions::<()>::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, data) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(data).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn container_xml() -> &'static [u8] {
        br#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#
    }

    fn opf_xml() -> &'static [u8] {
        br#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata>
    <dc:title>Old Title</dc:title>
    <dc:creator>Old Author</dc:creator>
    <dc:identifier id="uid">urn:uuid:00000000-0000-0000-0000-000000000000</dc:identifier>
  </metadata>
  <manifest>
    <item id="cover" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>"#
    }

    fn read_zip_text(bytes: &[u8], name: &str) -> String {
        let reader = Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(reader).unwrap();
        let mut file = archive.by_name(name).unwrap();
        let mut buf = String::new();
        file.read_to_string(&mut buf).unwrap();
        buf
    }

    fn read_zip_bytes(bytes: &[u8], name: &str) -> Vec<u8> {
        let reader = Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(reader).unwrap();
        let mut file = archive.by_name(name).unwrap();
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).unwrap();
        buf
    }

    fn meta_edit(title: Option<&str>, author: Option<&str>) -> EpubMetadataEdit {
        EpubMetadataEdit {
            title: title.map(String::from),
            author: author.map(String::from),
            description: Some("A great book <&> more".to_string()),
            publisher: Some("Acme Press".to_string()),
            published_date: Some("2024-05-01".to_string()),
            language: Some("en".to_string()),
            isbn: Some("978-3-16-148410-0".to_string()),
            category: Some("Science".to_string()),
        }
    }

    #[test]
    fn rewrites_existing_metadata_fields() {
        let epub = create_zip(&[
            ("META-INF/container.xml", container_xml()),
            ("OEBPS/content.opf", opf_xml()),
            ("OEBPS/images/cover.jpg", b"old-cover-bytes"),
            (
                "OEBPS/chapter1.xhtml",
                b"<html><body><p>Hi</p></body></html>",
            ),
        ]);
        let result = rewrite_epub_bytes(
            &epub,
            &meta_edit(Some("New Title"), Some("New Author")),
            None,
        )
        .unwrap();
        let opf = read_zip_text(&result, "OEBPS/content.opf");
        assert!(opf.contains("<dc:title>New Title</dc:title>"));
        assert!(opf.contains("<dc:creator>New Author</dc:creator>"));
        assert!(!opf.contains("Old Title"));
        assert!(!opf.contains("Old Author"));
        assert!(opf.contains("<dc:description xmlns:dc=\"http://purl.org/dc/elements/1.1/\">A great book &lt;&amp;&gt; more</dc:description>"));
        assert!(opf.contains(
            "<dc:publisher xmlns:dc=\"http://purl.org/dc/elements/1.1/\">Acme Press</dc:publisher>"
        ));
        assert!(opf.contains(
            "<dc:date xmlns:dc=\"http://purl.org/dc/elements/1.1/\">2024-05-01</dc:date>"
        ));
        assert!(opf.contains(
            "<dc:language xmlns:dc=\"http://purl.org/dc/elements/1.1/\">en</dc:language>"
        ));
        assert!(opf.contains(
            "<dc:subject xmlns:dc=\"http://purl.org/dc/elements/1.1/\">Science</dc:subject>"
        ));
        assert!(opf.contains("978-3-16-148410-0"));
    }

    #[test]
    fn inserts_missing_metadata_fields() {
        let epub = create_zip(&[
            ("META-INF/container.xml", container_xml()),
            (
                "OEBPS/content.opf",
                br#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
  <metadata>
    <dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">Only Title</dc:title>
  </metadata>
  <manifest>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>"#,
            ),
            (
                "OEBPS/chapter1.xhtml",
                b"<html><body><p>Hi</p></body></html>",
            ),
        ]);
        let result =
            rewrite_epub_bytes(&epub, &meta_edit(None, Some("Inserted Author")), None).unwrap();
        let opf = read_zip_text(&result, "OEBPS/content.opf");
        assert!(opf.contains("Only Title"));
        assert!(opf.contains("<dc:creator xmlns:dc=\"http://purl.org/dc/elements/1.1/\">Inserted Author</dc:creator>"));
        assert!(opf.contains(
            "<dc:publisher xmlns:dc=\"http://purl.org/dc/elements/1.1/\">Acme Press</dc:publisher>"
        ));
    }

    #[test]
    fn replaces_existing_cover_image() {
        let epub = create_zip(&[
            ("META-INF/container.xml", container_xml()),
            ("OEBPS/content.opf", opf_xml()),
            ("OEBPS/images/cover.jpg", b"old-cover-bytes"),
            (
                "OEBPS/chapter1.xhtml",
                b"<html><body><p>Hi</p></body></html>",
            ),
        ]);
        let result = rewrite_epub_bytes(
            &epub,
            &EpubMetadataEdit::default(),
            Some(b"new-cover-bytes"),
        )
        .unwrap();
        let cover = read_zip_bytes(&result, "OEBPS/images/cover.jpg");
        assert_eq!(cover, b"new-cover-bytes");
        let chapter = read_zip_bytes(&result, "OEBPS/chapter1.xhtml");
        assert_eq!(chapter, b"<html><body><p>Hi</p></body></html>");
    }

    #[test]
    fn adds_cover_when_missing() {
        let epub = create_zip(&[
            ("META-INF/container.xml", container_xml()),
            (
                "OEBPS/content.opf",
                br#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata>
    <dc:title>No Cover</dc:title>
  </metadata>
  <manifest>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>"#,
            ),
            ("OEBPS/chapter1.xhtml", b"<html><body><p>Hi</p></body></html>"),
        ]);
        let result =
            rewrite_epub_bytes(&epub, &EpubMetadataEdit::default(), Some(b"new-cover-png"))
                .unwrap();
        let opf = read_zip_text(&result, "OEBPS/content.opf");
        assert!(opf.contains("id=\"theorem-cover\""));
        assert!(opf.contains("name=\"cover\" content=\"theorem-cover\""));
        let cover = read_zip_bytes(&result, "OEBPS/cover.png");
        assert_eq!(cover, b"new-cover-png");
    }

    #[test]
    fn rejects_encrypted_epub() {
        let epub = create_zip(&[
            ("META-INF/container.xml", container_xml()),
            ("META-INF/encryption.xml", b"<encryption/>"),
            ("OEBPS/content.opf", opf_xml()),
        ]);
        assert!(rewrite_epub_bytes(&epub, &EpubMetadataEdit::default(), None).is_err());
    }
}
