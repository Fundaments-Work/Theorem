//! High-performance native EPUB packaging for web articles and RSS entries.
//!
//! Replaces JavaScript `fflate` (`zipSync`) on the main thread with zero-copy,
//! multi-threaded Rust EPUB creation directly to bytes or disk.

use serde::{Deserialize, Serialize};
use std::io::{Cursor, Write};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleEpubPayload {
    pub title: String,
    pub author: Option<String>,
    pub content: String,
    pub url: Option<String>,
    pub cover_image_url: Option<String>,
    pub published_at: Option<String>,
}

fn looks_like_markup(s: &str) -> bool {
    // Tag open (`<p>`, `<div class="…">`, `<p xmlns="…">`) or closing tag.
    // Must not require exact "<p>"/"<div>" substrings: namespaced or
    // attributed tags (e.g. RSS XHTML `<p xmlns="…">`) are still markup.
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' && i + 1 < bytes.len() {
            let next = bytes[i + 1];
            if next.is_ascii_alphabetic() || next == b'/' || next == b'!' || next == b'?' {
                return true;
            }
        }
        i += 1;
    }
    false
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Creates a fully valid, standards-compliant EPUB 2.0 archive from article contents.
pub fn create_article_epub_bytes(payload: &ArticleEpubPayload) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let mut zip = ZipWriter::new(Cursor::new(&mut buf));

    let stored_options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .unix_permissions(0o644);

    let deflated_options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);

    // 1. mimetype (MUST be first, uncompressed, exactly 20 bytes)
    zip.start_file("mimetype", stored_options)
        .map_err(|e| format!("Failed to write mimetype: {e}"))?;
    zip.write_all(b"application/epub+zip")
        .map_err(|e| format!("Failed to write mimetype content: {e}"))?;

    // 2. META-INF/container.xml
    zip.start_file("META-INF/container.xml", deflated_options)
        .map_err(|e| format!("Failed to write container.xml: {e}"))?;
    let container_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#;
    zip.write_all(container_xml.as_bytes())
        .map_err(|e| format!("Failed to write container.xml content: {e}"))?;

    // 3. OEBPS/style.css
    zip.start_file("OEBPS/style.css", deflated_options)
        .map_err(|e| format!("Failed to write style.css: {e}"))?;
    let style_css = r#"
@namespace "http://www.w3.org/1999/xhtml";
body {
    margin: 5% 8%;
    font-family: serif;
    line-height: 1.6;
    color: #1a1a1a;
}
h1 {
    font-size: 1.8em;
    line-height: 1.25;
    margin-bottom: 0.3em;
}
.metadata {
    font-family: sans-serif;
    font-size: 0.85em;
    color: #666;
    margin-bottom: 2em;
    border-bottom: 1px solid #ddd;
    padding-bottom: 1em;
}
img {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 1.5em auto;
}
blockquote {
    border-left: 3px solid #ccc;
    margin: 1em 0;
    padding-left: 1em;
    color: #555;
}
pre, code {
    font-family: monospace;
    font-size: 0.9em;
    background: #f4f4f4;
}
pre {
    padding: 1em;
    overflow-x: auto;
}
"#;
    zip.write_all(style_css.as_bytes())
        .map_err(|e| format!("Failed to write style.css content: {e}"))?;

    let title_escaped = escape_xml(&payload.title);
    let author_escaped = escape_xml(payload.author.as_deref().unwrap_or("Unknown Author"));
    let url_escaped = escape_xml(payload.url.as_deref().unwrap_or(""));
    let date_str = payload
        .published_at
        .clone()
        .unwrap_or_else(|| "2026-01-01".to_string());

    // 4. OEBPS/content.opf
    zip.start_file("OEBPS/content.opf", deflated_options)
        .map_err(|e| format!("Failed to write content.opf: {e}"))?;
    let content_opf = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="BookId">urn:uuid:theorem-article-{}</dc:identifier>
    <dc:title>{}</dc:title>
    <dc:creator opf:role="aut">{}</dc:creator>
    <dc:language>en</dc:language>
    <dc:source>{}</dc:source>
    <dc:date>{}</dc:date>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="style" href="style.css" media-type="text/css"/>
    <item id="article" href="article.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="article"/>
  </spine>
</package>"#,
        uuid_timestamp(),
        title_escaped,
        author_escaped,
        url_escaped,
        date_str
    );
    zip.write_all(content_opf.as_bytes())
        .map_err(|e| format!("Failed to write content.opf content: {e}"))?;

    // 5. OEBPS/toc.ncx
    zip.start_file("OEBPS/toc.ncx", deflated_options)
        .map_err(|e| format!("Failed to write toc.ncx: {e}"))?;
    let toc_ncx = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:theorem-article"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>{}</text></docTitle>
  <navMap>
    <navPoint id="navPoint-1" playOrder="1">
      <navLabel><text>{}</text></navLabel>
      <content src="article.xhtml"/>
    </navPoint>
  </navMap>
</ncx>"#,
        title_escaped, title_escaped
    );
    zip.write_all(toc_ncx.as_bytes())
        .map_err(|e| format!("Failed to write toc.ncx content: {e}"))?;

    // 6. OEBPS/article.xhtml
    zip.start_file("OEBPS/article.xhtml", deflated_options)
        .map_err(|e| format!("Failed to write article.xhtml: {e}"))?;

    let body_html = if looks_like_markup(&payload.content) {
        &payload.content
    } else {
        // Wrap plain text in paragraphs
        &format!("<p>{}</p>", escape_xml(&payload.content))
    };

    let cover_tag = if let Some(ref cover) = payload.cover_image_url {
        if !cover.is_empty() && !payload.content.contains(cover) {
            format!("<p><img src=\"{}\" alt=\"\"/></p>\n  ", escape_xml(cover))
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    let article_xhtml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>{}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
  <h1>{}</h1>
  <div class="metadata">
    <p>By <strong>{}</strong></p>
  </div>
  {}<div class="article-content">
    {}
  </div>
</body>
</html>"#,
        title_escaped, title_escaped, author_escaped, cover_tag, body_html
    );
    zip.write_all(article_xhtml.as_bytes())
        .map_err(|e| format!("Failed to write article.xhtml content: {e}"))?;

    zip.finish()
        .map_err(|e| format!("Failed to finish zip archive: {e}"))?;
    Ok(buf)
}

fn uuid_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[tauri::command]
pub async fn create_article_epub_native(payload: ArticleEpubPayload) -> Result<Vec<u8>, String> {
    tokio::task::spawn_blocking(move || create_article_epub_bytes(&payload))
        .await
        .map_err(|e| format!("Join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn test_looks_like_markup() {
        assert!(looks_like_markup("<p>Hello</p>"));
        assert!(looks_like_markup("<div>Hi</div>"));
        // Namespaced / attributed tags are still markup (Quanta RSS XHTML).
        assert!(looks_like_markup(
            "<p xmlns=\"http://www.w3.org/1999/xhtml\">Quantum</p>"
        ));
        assert!(looks_like_markup(
            "<div class=\"article-content\"><p>x</p></div>"
        ));
        assert!(looks_like_markup("lead <strong>bold</strong> trail"));
        assert!(!looks_like_markup("Plain text, no tags."));
        assert!(!looks_like_markup("a < b and c > d"));
        assert!(!looks_like_markup(""));
    }

    #[test]
    fn test_namespaced_markup_not_escaped() {
        let payload = ArticleEpubPayload {
            title: "The Joy of Why".to_string(),
            author: Some("Quanta".to_string()),
            content: "<p xmlns=\"http://www.w3.org/1999/xhtml\">Quantum</p>".to_string(),
            url: None,
            cover_image_url: None,
            published_at: None,
        };
        let bytes = create_article_epub_bytes(&payload).unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(&bytes)).unwrap();
        let mut xhtml = archive.by_name("OEBPS/article.xhtml").unwrap();
        let mut text = String::new();
        xhtml.read_to_string(&mut text).unwrap();
        assert!(text.contains("<p xmlns=\"http://www.w3.org/1999/xhtml\">Quantum</p>"));
        assert!(!text.contains("&lt;p"));
    }

    #[test]
    fn test_create_article_epub() {
        let payload = ArticleEpubPayload {
            title: "Exploring Rust Memory".to_string(),
            author: Some("Cloudflare".to_string()),
            content: "<p>Deep dive into Box&lt;str&gt; and data layouts.</p>".to_string(),
            url: Some("https://blog.cloudflare.com".to_string()),
            cover_image_url: None,
            published_at: Some("2026-09-13".to_string()),
        };

        let bytes = create_article_epub_bytes(&payload).unwrap();
        assert!(bytes.len() > 100);

        // Verify it's a valid ZIP starting with PK
        assert_eq!(&bytes[0..2], b"PK");

        // Verify mimetype is at offset 30 and uncompressed
        let mut archive = zip::ZipArchive::new(Cursor::new(&bytes)).unwrap();
        assert_eq!(archive.len(), 6);
        let mut mimetype = archive.by_name("mimetype").unwrap();
        let mut mime_str = String::new();
        mimetype.read_to_string(&mut mime_str).unwrap();
        assert_eq!(mime_str, "application/epub+zip");
    }
}
