//! Markdown parsing and rendering using pulldown-cmark.

use pulldown_cmark::{html, Event, Options, Parser, Tag, TagEnd};

/// Renders Markdown to sanitized HTML without JavaScript execution or unsafe protocols.
pub fn markdown_to_html(markdown: &str) -> String {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);

    let parser = Parser::new_ext(markdown, options);
    let safe_parser = parser.filter_map(|event| match event {
        // Convert raw HTML events into plain text events so push_html escapes them safely
        Event::Html(raw) | Event::InlineHtml(raw) => Some(Event::Text(raw)),
        Event::Start(Tag::Link {
            link_type,
            dest_url,
            title,
            id,
        }) => {
            if is_safe_url(&dest_url) {
                Some(Event::Start(Tag::Link {
                    link_type,
                    dest_url,
                    title,
                    id,
                }))
            } else {
                Some(Event::Text("[blocked link]".into()))
            }
        }
        Event::End(TagEnd::Link) => Some(Event::End(TagEnd::Link)),
        other => Some(other),
    });

    let mut output = String::new();
    html::push_html(&mut output, safe_parser);
    output
}

fn is_safe_url(url: &str) -> bool {
    let trimmed = url.trim().to_ascii_lowercase();
    !(trimmed.starts_with("javascript:")
        || trimmed.starts_with("data:")
        || trimmed.starts_with("vbscript:"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_markdown_to_html_basic() {
        let md = "# Title\n\nThis is **bold** and *italic*.";
        let html = markdown_to_html(md);
        assert!(html.contains("<h1>Title</h1>"));
        assert!(html.contains("<strong>bold</strong>"));
        assert!(html.contains("<em>italic</em>"));
    }

    #[test]
    fn test_markdown_neutralizes_raw_html() {
        let md = "Hello <script>alert(1)</script> world";
        let html = markdown_to_html(md);
        assert!(!html.contains("<script>"));
        assert!(html.contains("&lt;script&gt;"));
    }

    #[test]
    fn test_markdown_blocks_javascript_urls() {
        let md = "[Click me](javascript:alert(1))";
        let html = markdown_to_html(md);
        assert!(!html.contains("javascript:alert(1)"));
        assert!(html.contains("[blocked link]"));
    }
}
