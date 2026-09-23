use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeExtractedArticle {
    pub title: Box<str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byline: Option<Box<str>>,
    pub content: Box<str>,
    #[serde(rename = "textContent", skip_serializing_if = "Option::is_none")]
    pub text_content: Option<Box<str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<Box<str>>,
    #[serde(rename = "siteName", skip_serializing_if = "Option::is_none")]
    pub site_name: Option<Box<str>>,
    #[serde(rename = "leadImageUrl", skip_serializing_if = "Option::is_none")]
    pub lead_image_url: Option<Box<str>>,
    #[serde(rename = "publishedTime", skip_serializing_if = "Option::is_none")]
    pub published_time: Option<Box<str>>,
}

/// Extract clean readability article from raw HTML string
pub fn extract_article_from_html(html: &str, base_url: &str) -> NativeExtractedArticle {
    let parsed_url = url::Url::parse(base_url)
        .unwrap_or_else(|_| url::Url::parse("https://example.com/article").unwrap());

    let (readability_title, readability_content, readability_text) = {
        let mut cursor = std::io::Cursor::new(html.as_bytes());
        match readability::extractor::extract(&mut cursor, &parsed_url) {
            Ok(product) => {
                let t = if !product.title.trim().is_empty() {
                    Some(product.title)
                } else {
                    None
                };
                let c = if !product.content.trim().is_empty() {
                    Some(product.content)
                } else {
                    None
                };
                let txt = if !product.text.trim().is_empty() {
                    Some(product.text)
                } else {
                    None
                };
                (t, c, txt)
            }
            Err(_) => (None, None, None),
        }
    };

    // 1. Extract metadata from <meta> and <title> tags
    let mut title =
        readability_title.unwrap_or_else(|| extract_tag_content(html, "title").unwrap_or_default());
    let og_title = extract_meta_content(html, "og:title");
    if let Some(t) = og_title {
        if !t.trim().is_empty() {
            title = t;
        }
    }

    let byline = extract_meta_content(html, "author")
        .or_else(|| extract_meta_content(html, "article:author"))
        .or_else(|| extract_meta_content(html, "twitter:creator"));

    let excerpt = extract_meta_content(html, "description")
        .or_else(|| extract_meta_content(html, "og:description"));

    let site_name = extract_meta_content(html, "og:site_name");
    let mut lead_image_url = extract_meta_content(html, "og:image")
        .or_else(|| extract_meta_content(html, "twitter:image"));

    if let Some(ref img) = lead_image_url {
        if !img.starts_with("http://") && !img.starts_with("https://") && !img.starts_with("data:")
        {
            lead_image_url = resolve_url(base_url, img);
        }
    }

    let published_time = extract_meta_content(html, "article:published_time");

    // 2. Clean HTML content
    let cleaned_body = readability_content.unwrap_or_else(|| clean_html_content(html, base_url));
    let text_content = readability_text.unwrap_or_else(|| strip_all_tags(&cleaned_body));

    NativeExtractedArticle {
        title: title.trim().to_string().into_boxed_str(),
        byline: byline.map(|s| s.into_boxed_str()),
        content: cleaned_body.into_boxed_str(),
        text_content: Some(text_content.into_boxed_str()),
        excerpt: excerpt.map(|s| s.into_boxed_str()),
        site_name: site_name.map(|s| s.into_boxed_str()),
        lead_image_url: lead_image_url.map(|s| s.into_boxed_str()),
        published_time: published_time.map(|s| s.into_boxed_str()),
    }
}

/// Strip clutter tags (<script>, <style>, <nav>, <header>, <footer>, <aside>, <form>, <iframe>)
fn clean_html_content(raw: &str, base_url: &str) -> String {
    let mut s = raw.to_string();

    const STRIP_TAGS: &[&str] = &[
        "script", "style", "nav", "header", "footer", "aside", "form", "iframe", "noscript", "svg",
    ];

    for &tag in STRIP_TAGS {
        let open_pat = format!("<{tag}");
        let close_pat = format!("</{tag}>");

        while let Some(start) = s.to_lowercase().find(&open_pat) {
            if let Some(end) = s.to_lowercase()[start..].find(&close_pat) {
                s.replace_range(start..start + end + close_pat.len(), " ");
            } else if let Some(tag_end) = s[start..].find('>') {
                s.replace_range(start..=start + tag_end, " ");
            } else {
                break;
            }
        }
    }

    // Extract main container if present (<article>, <main>, or entire body)
    let body_start = s
        .to_lowercase()
        .find("<article")
        .or_else(|| s.to_lowercase().find("<main"))
        .or_else(|| s.to_lowercase().find("<body"))
        .unwrap_or(0);

    let content_slice = &s[body_start..];

    // Normalize relative img src and a href
    resolve_relative_html_attributes(content_slice, base_url)
}

fn resolve_relative_html_attributes(html: &str, base_url: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut search_from = 0;

    while let Some(pos) = html[search_from..].find("<img") {
        let tag_start = search_from + pos;
        out.push_str(&html[search_from..tag_start]);

        if let Some(tag_end) = html[tag_start..].find('>') {
            let tag_str = &html[tag_start..=tag_start + tag_end];
            let fixed_tag = if let Some(src_pos) = tag_str.find("src=\"") {
                let val_start = src_pos + 5;
                if let Some(val_end) = tag_str[val_start..].find('\"') {
                    let raw_src = &tag_str[val_start..val_start + val_end];
                    if !raw_src.starts_with("http") && !raw_src.starts_with("data:") {
                        if let Some(abs_src) = resolve_url(base_url, raw_src) {
                            let mut t = tag_str.to_string();
                            t.replace_range(val_start..val_start + val_end, &abs_src);
                            t
                        } else {
                            tag_str.to_string()
                        }
                    } else {
                        tag_str.to_string()
                    }
                } else {
                    tag_str.to_string()
                }
            } else {
                tag_str.to_string()
            };

            out.push_str(&fixed_tag);
            search_from = tag_start + tag_end + 1;
        } else {
            break;
        }
    }

    out.push_str(&html[search_from..]);
    out
}

fn resolve_url(base: &str, relative: &str) -> Option<String> {
    if relative.starts_with("//") {
        return Some(format!("https:{relative}"));
    }
    if relative.starts_with('/') {
        if let Ok(base_parsed) = reqwest::Url::parse(base) {
            if let Some(host) = base_parsed.host_str() {
                let scheme = base_parsed.scheme();
                return Some(format!("{scheme}://{host}{relative}"));
            }
        }
    }
    if let Ok(base_parsed) = reqwest::Url::parse(base) {
        if let Ok(joined) = base_parsed.join(relative) {
            return Some(joined.to_string());
        }
    }
    Some(relative.to_string())
}

fn extract_meta_content(html: &str, property: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let pat1 = format!("name=\"{property}\"");
    let pat2 = format!("property=\"{property}\"");

    let pos = lower.find(&pat1).or_else(|| lower.find(&pat2))?;
    // Find the enclosing <meta ... > tag
    let tag_start = html[..pos].rfind("<meta")?;
    let tag_end = tag_start + html[tag_start..].find('>')?;
    let meta_tag = &html[tag_start..=tag_end];

    // Find content="..."
    let content_pos = meta_tag.to_lowercase().find("content=\"")?;
    let val_start = content_pos + 9;
    let val_end = val_start + meta_tag[val_start..].find('\"')?;
    Some(meta_tag[val_start..val_end].trim().to_string())
}

fn extract_tag_content(html: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");

    let start_tag = html.to_lowercase().find(&open)?;
    let after_tag = start_tag + html[start_tag..].find('>')? + 1;
    let end_tag = after_tag + html[after_tag..].to_lowercase().find(&close)?;
    Some(html[after_tag..end_tag].trim().to_string())
}

fn strip_all_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;

    for ch in html.chars() {
        if ch == '<' {
            in_tag = true;
            out.push(' ');
        } else if ch == '>' {
            in_tag = false;
        } else if !in_tag {
            out.push(ch);
        }
    }

    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ─────────────────────────────────────────────────────────────────────────────
// TAURI COMMANDS
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn fetch_and_extract_article_native(
    url: String,
) -> Result<NativeExtractedArticle, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| format!("Client build error: {e}"))?;

    let res = client
        .get(&url)
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .send()
        .await
        .map_err(|e| format!("Failed to fetch URL: {e}"))?;

    if !res.status().is_success() {
        return Err(format!(
            "HTTP error {}: {}",
            res.status().as_u16(),
            res.status()
        ));
    }

    let body = res
        .text()
        .await
        .map_err(|e| format!("Failed to read body: {e}"))?;
    let extracted = extract_article_from_html(&body, &url);
    Ok(extracted)
}

pub fn extract_article_from_html_native(
    html: String,
    base_url: Option<String>,
) -> Result<NativeExtractedArticle, String> {
    let base = base_url.as_deref().unwrap_or("");
    Ok(extract_article_from_html(&html, base))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_meta_tags() {
        let html = r#"
        <html>
        <head>
            <title>Quantum Computing Breakthrough</title>
            <meta name="author" content="Dr. Jane Doe" />
            <meta property="og:description" content="A new quantum algorithm achieves supremacy." />
            <meta property="og:image" content="https://example.com/cover.jpg" />
        </head>
        <body>
            <article>
                <p>Scientists have demonstrated a 100x speedup in qubit coherence.</p>
            </article>
        </body>
        </html>
        "#;

        let article = extract_article_from_html(html, "https://example.com/post");
        assert_eq!(&*article.title, "Quantum Computing Breakthrough");
        assert_eq!(article.byline.as_deref(), Some("Dr. Jane Doe"));
        assert_eq!(
            article.excerpt.as_deref(),
            Some("A new quantum algorithm achieves supremacy.")
        );
        assert_eq!(
            article.lead_image_url.as_deref(),
            Some("https://example.com/cover.jpg")
        );
        assert!(article.content.contains("Scientists have demonstrated"));
    }
}
