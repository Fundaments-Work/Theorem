use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpdsLinkDto {
    pub rel: String,
    pub href: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpdsEntryDto {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nav_url: Option<String>,
    pub is_navigation: bool,
    pub links: Vec<OpdsLinkDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpdsFeedDto {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub self_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prev_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub up_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_url_template: Option<String>,
    pub entries: Vec<OpdsEntryDto>,
    pub duration_ms: f64,
}

fn resolve_url(relative_or_absolute: &str, base_url: &str) -> String {
    if relative_or_absolute.starts_with("http://")
        || relative_or_absolute.starts_with("https://")
        || relative_or_absolute.starts_with("data:")
    {
        return relative_or_absolute.to_string();
    }

    if let Ok(base) = reqwest::Url::parse(base_url) {
        if let Ok(joined) = base.join(relative_or_absolute) {
            return joined.to_string();
        }
    }

    relative_or_absolute.to_string()
}

fn get_local_name(name: &[u8]) -> &str {
    let s = std::str::from_utf8(name).unwrap_or("");
    if let Some(pos) = s.rfind(':') {
        &s[pos + 1..]
    } else {
        s
    }
}

pub fn parse_opds_xml(xml: &str, base_url: &str) -> Result<OpdsFeedDto, String> {
    let start_time = Instant::now();
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut feed_id = String::new();
    let mut feed_title = String::new();
    let mut feed_subtitle: Option<String> = None;
    let mut feed_icon: Option<String> = None;
    let mut feed_updated: Option<String> = None;
    let mut self_url: Option<String> = None;
    let mut next_url: Option<String> = None;
    let mut prev_url: Option<String> = None;
    let mut up_url: Option<String> = None;
    let mut start_url: Option<String> = None;
    let mut search_url_template: Option<String> = None;

    let mut entries: Vec<OpdsEntryDto> = Vec::new();

    // Entry parsing state
    let mut in_entry = false;
    let mut cur_entry_id = String::new();
    let mut cur_entry_title = String::new();
    let mut cur_entry_author: Option<String> = None;
    let mut cur_entry_summary: Option<String> = None;
    let mut cur_entry_content: Option<String> = None;
    let mut cur_entry_updated: Option<String> = None;
    let mut cur_entry_published: Option<String> = None;
    let mut cur_entry_language: Option<String> = None;
    let mut cur_entry_publisher: Option<String> = None;
    let mut cur_entry_cover_url: Option<String> = None;
    let mut cur_entry_thumbnail_url: Option<String> = None;
    let mut cur_entry_download_url: Option<String> = None;
    let mut cur_entry_download_format: Option<String> = None;
    let mut cur_entry_nav_url: Option<String> = None;
    let mut cur_entry_is_nav = false;
    let mut cur_entry_links: Vec<OpdsLinkDto> = Vec::new();

    // Field capture state
    let mut current_tag = String::new();
    let mut inside_author_tag = false;

    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let local = get_local_name(e.name().as_ref()).to_lowercase();
                current_tag = local.clone();

                if local == "entry" {
                    in_entry = true;
                    cur_entry_id.clear();
                    cur_entry_title.clear();
                    cur_entry_author = None;
                    cur_entry_summary = None;
                    cur_entry_content = None;
                    cur_entry_updated = None;
                    cur_entry_published = None;
                    cur_entry_language = None;
                    cur_entry_publisher = None;
                    cur_entry_cover_url = None;
                    cur_entry_thumbnail_url = None;
                    cur_entry_download_url = None;
                    cur_entry_download_format = None;
                    cur_entry_nav_url = None;
                    cur_entry_is_nav = false;
                    cur_entry_links.clear();
                } else if local == "author" || local == "creator" {
                    inside_author_tag = true;
                }
            }
            Ok(Event::Empty(ref e)) => {
                let local = get_local_name(e.name().as_ref()).to_lowercase();
                if local == "link" {
                    let mut href = String::new();
                    let mut rel = String::new();
                    let mut mime_type = String::new();
                    let mut title = String::new();

                    for attr in e.attributes().flatten() {
                        let key = get_local_name(attr.key.as_ref()).to_lowercase();
                        let val = attr
                            .decode_and_unescape_value(reader.decoder())
                            .unwrap_or_default()
                            .to_string();

                        match key.as_str() {
                            "href" => href = val,
                            "rel" => rel = val,
                            "type" => mime_type = val,
                            "title" => title = val,
                            _ => {}
                        }
                    }

                    if !href.is_empty() {
                        let resolved = resolve_url(&href, base_url);
                        let rel_lower = rel.to_lowercase();
                        let mime_lower = mime_type.to_lowercase();

                        if in_entry {
                            let link_dto = OpdsLinkDto {
                                rel: rel.clone(),
                                href: resolved.clone(),
                                r#type: if mime_type.is_empty() {
                                    None
                                } else {
                                    Some(mime_type.clone())
                                },
                                title: if title.is_empty() {
                                    None
                                } else {
                                    Some(title.clone())
                                },
                            };
                            cur_entry_links.push(link_dto);

                            // Acquisition link
                            if (rel_lower.contains("acquisition")
                                || rel_lower == "http://opds-spec.org/acquisition"
                                || rel_lower.contains("open-access")
                                || mime_lower.contains("epub")
                                || mime_lower.contains("pdf")
                                || mime_lower.contains("mobi")
                                || mime_lower.contains("comicbook"))
                                && (cur_entry_download_url.is_none() || mime_lower.contains("epub"))
                            {
                                cur_entry_download_url = Some(resolved.clone());
                                if mime_lower.contains("pdf") {
                                    cur_entry_download_format = Some("pdf".to_string());
                                } else if mime_lower.contains("mobi")
                                    || mime_lower.contains("mobipocket")
                                {
                                    cur_entry_download_format = Some("mobi".to_string());
                                } else if mime_lower.contains("comic") || mime_lower.contains("cbz")
                                {
                                    cur_entry_download_format = Some("cbz".to_string());
                                } else {
                                    cur_entry_download_format = Some("epub".to_string());
                                }
                            }

                            // Cover images
                            if rel_lower == "http://opds-spec.org/image"
                                || rel_lower == "http://opds-spec.org/cover"
                                || rel_lower == "cover"
                                || rel_lower == "image"
                            {
                                cur_entry_cover_url = Some(resolved.clone());
                            } else if rel_lower == "http://opds-spec.org/image/thumbnail"
                                || rel_lower == "http://opds-spec.org/thumbnail"
                                || rel_lower == "thumbnail"
                            {
                                cur_entry_thumbnail_url = Some(resolved.clone());
                            }

                            // Navigation
                            if rel_lower == "subsection"
                                || mime_lower.contains("profile=opds-catalog")
                                || rel_lower == "http://opds-spec.org/facet"
                            {
                                cur_entry_nav_url = Some(resolved.clone());
                                cur_entry_is_nav = true;
                            }
                        } else {
                            // Feed level links
                            if rel_lower == "self" {
                                self_url = Some(resolved.clone());
                            } else if rel_lower == "next" {
                                next_url = Some(resolved.clone());
                            } else if rel_lower == "prev" || rel_lower == "previous" {
                                prev_url = Some(resolved.clone());
                            } else if rel_lower == "up" {
                                up_url = Some(resolved.clone());
                            } else if rel_lower == "start" {
                                start_url = Some(resolved.clone());
                            } else if rel_lower == "search" {
                                search_url_template = Some(resolved.clone());
                            }
                        }
                    }
                }
            }
            Ok(Event::Text(ref e)) => {
                let text = e.unescape().unwrap_or_default().trim().to_string();
                if !text.is_empty() {
                    if in_entry {
                        match current_tag.as_str() {
                            "id" => {
                                if cur_entry_id.is_empty() {
                                    cur_entry_id = text;
                                }
                            }
                            "title" => {
                                if cur_entry_title.is_empty() {
                                    cur_entry_title = text;
                                }
                            }
                            "name" => {
                                if inside_author_tag && cur_entry_author.is_none() {
                                    cur_entry_author = Some(text);
                                }
                            }
                            "creator" | "author" => {
                                if cur_entry_author.is_none() {
                                    cur_entry_author = Some(text);
                                }
                            }
                            "summary" => {
                                if cur_entry_summary.is_none() {
                                    cur_entry_summary = Some(text);
                                }
                            }
                            "content" => {
                                if cur_entry_content.is_none() {
                                    cur_entry_content = Some(text);
                                }
                            }
                            "updated" => cur_entry_updated = Some(text),
                            "published" | "issued" => cur_entry_published = Some(text),
                            "language" => cur_entry_language = Some(text),
                            "publisher" => cur_entry_publisher = Some(text),
                            _ => {}
                        }
                    } else {
                        match current_tag.as_str() {
                            "id" => {
                                if feed_id.is_empty() {
                                    feed_id = text;
                                }
                            }
                            "title" => {
                                if feed_title.is_empty() {
                                    feed_title = text;
                                }
                            }
                            "subtitle" => feed_subtitle = Some(text),
                            "icon" => feed_icon = Some(resolve_url(&text, base_url)),
                            "updated" => feed_updated = Some(text),
                            _ => {}
                        }
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                let local = get_local_name(e.name().as_ref()).to_lowercase();
                if local == "entry" {
                    in_entry = false;

                    if cur_entry_thumbnail_url.is_none() && cur_entry_cover_url.is_some() {
                        cur_entry_thumbnail_url = cur_entry_cover_url.clone();
                    }

                    if !cur_entry_title.is_empty() || !cur_entry_id.is_empty() {
                        entries.push(OpdsEntryDto {
                            id: if cur_entry_id.is_empty() {
                                cur_entry_title.clone()
                            } else {
                                cur_entry_id.clone()
                            },
                            title: cur_entry_title.clone(),
                            author: cur_entry_author.clone(),
                            summary: cur_entry_summary.clone(),
                            content: cur_entry_content.clone(),
                            updated: cur_entry_updated.clone(),
                            published: cur_entry_published.clone(),
                            language: cur_entry_language.clone(),
                            publisher: cur_entry_publisher.clone(),
                            cover_url: cur_entry_cover_url.clone(),
                            thumbnail_url: cur_entry_thumbnail_url.clone(),
                            download_url: cur_entry_download_url.clone(),
                            download_format: cur_entry_download_format.clone(),
                            nav_url: cur_entry_nav_url.clone(),
                            is_navigation: cur_entry_is_nav,
                            links: std::mem::take(&mut cur_entry_links),
                        });
                    }
                } else if local == "author" || local == "creator" {
                    inside_author_tag = false;
                }
                current_tag.clear();
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("XML parse error in OPDS feed: {e}")),
            _ => {}
        }
        buf.clear();
    }

    let duration_ms = start_time.elapsed().as_secs_f64() * 1000.0;

    Ok(OpdsFeedDto {
        id: if feed_id.is_empty() {
            base_url.to_string()
        } else {
            feed_id
        },
        title: if feed_title.is_empty() {
            "OPDS Catalog".to_string()
        } else {
            feed_title
        },
        subtitle: feed_subtitle,
        icon: feed_icon,
        updated: feed_updated,
        self_url,
        next_url,
        prev_url,
        up_url,
        start_url,
        search_url_template,
        entries,
        duration_ms,
    })
}

#[tauri::command]
pub async fn fetch_and_parse_opds_native(url: String) -> Result<OpdsFeedDto, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| format!("Client build error: {e}"))?;

    let res = client
        .get(&url)
        .header(
            "Accept",
            "application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8",
        )
        .send()
        .await
        .map_err(|e| format!("Network request failed for OPDS feed {url}: {e}"))?;

    if !res.status().is_success() {
        return Err(format!(
            "OPDS feed responded with HTTP status {}",
            res.status()
        ));
    }

    let xml = res
        .text()
        .await
        .map_err(|e| format!("Failed to decode OPDS XML text: {e}"))?;

    tokio::task::spawn_blocking(move || parse_opds_xml(&xml, &url))
        .await
        .map_err(|e| format!("Thread task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_standard_ebooks_atom() {
        let sample = r#"<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opds="http://opds-spec.org/2010/catalog">
    <id>https://standardebooks.org/feeds/atom/new-releases</id>
    <title>Standard Ebooks - New Releases</title>
    <updated>2026-08-30T12:00:00Z</updated>
    <link rel="self" href="https://standardebooks.org/feeds/atom/new-releases" type="application/atom+xml"/>
    <link rel="next" href="https://standardebooks.org/feeds/atom/new-releases?page=2" type="application/atom+xml"/>
    <entry>
        <id>https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice</id>
        <title>Pride and Prejudice</title>
        <author><name>Jane Austen</name></author>
        <summary>A classic novel of manners and romance.</summary>
        <updated>2026-08-29T10:00:00Z</updated>
        <dc:language>en</dc:language>
        <link rel="http://opds-spec.org/image" href="/ebooks/jane-austen/pride-and-prejudice/dist/cover.jpg" type="image/jpeg"/>
        <link rel="http://opds-spec.org/acquisition" href="/ebooks/jane-austen/pride-and-prejudice/dist/jane-austen_pride-and-prejudice.epub" type="application/epub+zip"/>
    </entry>
</feed>"#;

        let res =
            parse_opds_xml(sample, "https://standardebooks.org/feeds/atom/new-releases").unwrap();
        assert_eq!(res.title, "Standard Ebooks - New Releases");
        assert_eq!(res.entries.len(), 1);

        let entry = &res.entries[0];
        assert_eq!(entry.title, "Pride and Prejudice");
        assert_eq!(entry.author.as_deref(), Some("Jane Austen"));
        assert_eq!(entry.download_format.as_deref(), Some("epub"));
        assert!(entry
            .download_url
            .as_ref()
            .unwrap()
            .starts_with("https://standardebooks.org/"));
        assert!(entry
            .cover_url
            .as_ref()
            .unwrap()
            .starts_with("https://standardebooks.org/"));
    }

    #[test]
    fn test_parse_gutenberg_opds() {
        let sample = r#"<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
    <title>Project Gutenberg Downloads</title>
    <entry>
        <title>The Great Gatsby</title>
        <dc:creator>F. Scott Fitzgerald</dc:creator>
        <link rel="http://opds-spec.org/acquisition" href="https://www.gutenberg.org/ebooks/64317.epub.images" type="application/epub+zip"/>
    </entry>
</feed>"#;

        let res = parse_opds_xml(sample, "https://www.gutenberg.org/").unwrap();
        assert_eq!(res.entries.len(), 1);
        let entry = &res.entries[0];
        assert_eq!(entry.title, "The Great Gatsby");
        assert_eq!(entry.author.as_deref(), Some("F. Scott Fitzgerald"));
        assert_eq!(entry.download_format.as_deref(), Some("epub"));
    }

    #[test]
    fn test_opds_streaming_benchmark() {
        let mut xml = String::from(
            r#"<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opds="http://opds-spec.org/2010/catalog">
    <title>Massive Benchmark Catalog</title>
"#,
        );

        for i in 0..1000 {
            xml.push_str(&format!(
                r#"<entry>
    <id>urn:book:{}</id>
    <title>Book Title Number {}</title>
    <author><name>Author Name {}</name></author>
    <summary>This is a detailed description summary for book number {} in the benchmark catalog.</summary>
    <dc:language>en</dc:language>
    <dc:publisher>Public Domain Press</dc:publisher>
    <link rel="http://opds-spec.org/image" href="/covers/{}.jpg" type="image/jpeg"/>
    <link rel="http://opds-spec.org/acquisition" href="/epubs/{}.epub" type="application/epub+zip"/>
</entry>"#,
                i, i, i, i, i, i
            ));
        }
        xml.push_str("</feed>");

        let start = std::time::Instant::now();
        let feed = parse_opds_xml(&xml, "https://catalog.example.com").unwrap();
        let elapsed = start.elapsed();

        println!(
            "⚡ Parsed {} OPDS entries in {:.2} ms ({:.2} µs/entry)",
            feed.entries.len(),
            elapsed.as_secs_f64() * 1000.0,
            (elapsed.as_secs_f64() * 1_000_000.0) / feed.entries.len() as f64
        );

        assert_eq!(feed.entries.len(), 1000);
        assert_eq!(feed.entries[999].title, "Book Title Number 999");
    }
}
