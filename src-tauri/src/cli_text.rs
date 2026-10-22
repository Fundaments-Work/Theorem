//! Block-aware HTML to plain text, for `theorem read` and the TUI reader.
//!
//! Unlike `book_search::html_to_plain_text` (whose character offsets the
//! app's in-book search depends on, and which must not change), this is made
//! for reading: `<head>`, `<style>` and `<script>` are dropped, entities are
//! decoded, paragraphs and headings are separated by blank lines, list items
//! and line breaks start new lines, and `<pre>` keeps its whitespace.
//!
//! Desktop-only, like the rest of the CLI.

/// How much space a tag puts around itself.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Break {
    None,
    Line,
    Paragraph,
}

/// Elements whose content is never shown.
const SKIPPED: &[&str] = &[
    "head", "style", "script", "noscript", "template", "title", "svg", "math",
];

fn break_for(tag: &str) -> Break {
    match tag {
        "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote" | "pre" | "figure"
        | "ul" | "ol" | "dl" | "table" | "hr" | "section" | "article" | "header" | "footer"
        | "aside" | "nav" | "main" | "address" | "figcaption" | "details" | "hgroup"
        | "body" | "html" => Break::Paragraph,
        "div" | "li" | "tr" | "dt" | "dd" | "caption" | "summary" | "br" | "thead" | "tbody"
        | "tfoot" | "fieldset" | "legend" | "center" => Break::Line,
        _ => Break::None,
    }
}

struct Writer {
    out: String,
    pending: Break,
    /// Whitespace seen since the last word, to become one space.
    space: bool,
}

impl Writer {
    fn new() -> Self {
        Self {
            out: String::new(),
            pending: Break::None,
            space: false,
        }
    }

    fn request(&mut self, kind: Break) {
        if kind > self.pending {
            self.pending = kind;
        }
    }

    /// Emit pending breaks before visible text (never at the very start).
    fn flush_breaks(&mut self) {
        if self.out.is_empty() {
            self.pending = Break::None;
            self.space = false;
            return;
        }
        match self.pending {
            Break::None => {
                if self.space && !self.out.ends_with([' ', '\n']) {
                    self.out.push(' ');
                }
            }
            Break::Line => {
                trim_trailing_spaces(&mut self.out);
                if !self.out.ends_with('\n') {
                    self.out.push('\n');
                }
            }
            Break::Paragraph => {
                trim_trailing_spaces(&mut self.out);
                while !self.out.ends_with("\n\n") {
                    self.out.push('\n');
                }
            }
        }
        self.pending = Break::None;
        self.space = false;
    }

    /// Text outside `<pre>`: runs of whitespace become one space.
    fn text(&mut self, text: &str) {
        for word_or_space in split_whitespace_runs(text) {
            match word_or_space {
                Run::Space => self.space = true,
                Run::Word(word) => {
                    self.flush_breaks();
                    self.out.push_str(word);
                }
            }
        }
    }

    /// Text inside `<pre>`: kept as written.
    fn preformatted(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.flush_breaks();
        self.out.push_str(text);
    }

    /// A literal piece of text that is not whitespace-collapsed (list bullets).
    fn marker(&mut self, text: &str) {
        self.flush_breaks();
        self.out.push_str(text);
    }

    fn finish(mut self) -> String {
        trim_trailing_spaces(&mut self.out);
        while self.out.ends_with('\n') {
            self.out.pop();
            trim_trailing_spaces(&mut self.out);
        }
        self.out
    }
}

fn trim_trailing_spaces(out: &mut String) {
    while out.ends_with(' ') || out.ends_with('\t') {
        out.pop();
    }
}

enum Run<'a> {
    Space,
    Word(&'a str),
}

fn split_whitespace_runs(text: &str) -> impl Iterator<Item = Run<'_>> {
    let mut rest = text;
    std::iter::from_fn(move || {
        if rest.is_empty() {
            return None;
        }
        let first = rest.chars().next()?;
        if is_collapsible_space(first) {
            let end = rest
                .char_indices()
                .find(|(_, c)| !is_collapsible_space(*c))
                .map(|(i, _)| i)
                .unwrap_or(rest.len());
            rest = &rest[end..];
            Some(Run::Space)
        } else {
            let end = rest
                .char_indices()
                .find(|(_, c)| is_collapsible_space(*c))
                .map(|(i, _)| i)
                .unwrap_or(rest.len());
            let word = &rest[..end];
            rest = &rest[end..];
            Some(Run::Word(word))
        }
    })
}

/// HTML collapses ASCII whitespace only; a no-break space stays a character.
fn is_collapsible_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0c')
}

struct ListState {
    ordered: bool,
    next: u32,
}

/// Convert an XHTML/HTML chapter to readable plain text.
pub fn html_to_text(html: &str) -> String {
    let mut w = Writer::new();
    let mut pre_depth = 0usize;
    let mut lists: Vec<ListState> = Vec::new();
    let bytes = html.as_bytes();
    let mut i = 0usize;
    let mut text_start = 0usize;

    let flush_text = |w: &mut Writer, raw: &str, pre: bool| {
        if raw.is_empty() {
            return;
        }
        let decoded = decode_entities(raw);
        if pre {
            w.preformatted(&decoded);
        } else {
            w.text(&decoded);
        }
    };

    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        flush_text(&mut w, &html[text_start..i], pre_depth > 0);
        let rest = &html[i..];

        if rest.starts_with("<!--") {
            i = find_from(html, i + 4, "-->").map(|e| e + 3).unwrap_or(bytes.len());
            text_start = i;
            continue;
        }
        if rest.starts_with("<![CDATA[") {
            let end = find_from(html, i + 9, "]]>").unwrap_or(bytes.len());
            let raw = &html[i + 9..end];
            if pre_depth > 0 {
                w.preformatted(raw);
            } else {
                w.text(raw);
            }
            i = (end + 3).min(bytes.len());
            text_start = i;
            continue;
        }
        if rest.starts_with("<!") || rest.starts_with("<?") {
            i = find_from(html, i + 2, ">").map(|e| e + 1).unwrap_or(bytes.len());
            text_start = i;
            continue;
        }

        let Some(tag) = parse_tag(html, i) else {
            // A lone `<` (not a tag) is text.
            i += 1;
            text_start = i - 1;
            // Keep scanning; the `<` stays in the text run.
            let next = find_from(html, i, "<").unwrap_or(bytes.len());
            flush_text(&mut w, &html[text_start..next], pre_depth > 0);
            i = next;
            text_start = next;
            continue;
        };
        i = tag.end;
        text_start = i;

        let name = tag.name.as_str();
        if !tag.closing && SKIPPED.contains(&name) {
            if !tag.self_closing {
                i = find_closing(html, i, name).unwrap_or(bytes.len());
                text_start = i;
            }
            continue;
        }

        match name {
            "pre" => {
                w.request(Break::Paragraph);
                if tag.closing {
                    pre_depth = pre_depth.saturating_sub(1);
                } else if !tag.self_closing {
                    pre_depth += 1;
                    // A newline right after <pre> is not content.
                    if html[i..].starts_with("\r\n") {
                        i += 2;
                    } else if html[i..].starts_with('\n') {
                        i += 1;
                    }
                    text_start = i;
                }
            }
            "br" => {
                if pre_depth > 0 {
                    w.preformatted("\n");
                } else {
                    // A forced line break: always a new line, even twice.
                    w.flush_breaks();
                    trim_trailing_spaces(&mut w.out);
                    w.out.push('\n');
                    w.pending = Break::None;
                }
            }
            "ul" | "ol" => {
                w.request(Break::Paragraph);
                if tag.closing {
                    lists.pop();
                } else if !tag.self_closing {
                    lists.push(ListState {
                        ordered: name == "ol",
                        next: tag.start_attr.unwrap_or(1),
                    });
                }
            }
            "li" => {
                w.request(Break::Line);
                if !tag.closing {
                    let indent = "  ".repeat(lists.len().saturating_sub(1));
                    let marker = match lists.last_mut() {
                        Some(list) if list.ordered => {
                            let n = list.next;
                            list.next += 1;
                            format!("{indent}{n}. ")
                        }
                        _ => format!("{indent}• "),
                    };
                    w.marker(&marker);
                }
            }
            "td" | "th" => {
                if !tag.closing {
                    w.space = true;
                }
            }
            "hr" => {
                w.request(Break::Paragraph);
                w.marker("* * *");
                w.request(Break::Paragraph);
            }
            "img" => {
                if let Some(alt) = tag.alt.as_deref().filter(|a| !a.trim().is_empty()) {
                    w.text(&format!(" [{}] ", decode_entities(alt.trim())));
                }
            }
            _ => w.request(break_for(name)),
        }
    }
    flush_text(&mut w, &html[text_start.min(bytes.len())..], pre_depth > 0);
    w.finish()
}

struct Tag {
    name: String,
    closing: bool,
    self_closing: bool,
    end: usize,
    alt: Option<String>,
    start_attr: Option<u32>,
}

fn find_from(haystack: &str, from: usize, needle: &str) -> Option<usize> {
    haystack.get(from..)?.find(needle).map(|p| p + from)
}

/// Parse the tag starting at `start` (which is `<`). Returns `None` when the
/// `<` does not begin a tag (for example `a < b`).
fn parse_tag(html: &str, start: usize) -> Option<Tag> {
    let bytes = html.as_bytes();
    let mut i = start + 1;
    let closing = bytes.get(i) == Some(&b'/');
    if closing {
        i += 1;
    }
    let name_start = i;
    while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || matches!(bytes[i], b':' | b'-' | b'_')) {
        i += 1;
    }
    if i == name_start || !bytes[name_start].is_ascii_alphabetic() {
        return None;
    }
    let full_name = html[name_start..i].to_ascii_lowercase();
    // `xhtml:p` and `p` are the same element.
    let name = full_name
        .rsplit(':')
        .next()
        .unwrap_or(&full_name)
        .to_string();

    // Find the end of the tag, skipping quoted attribute values.
    let attrs_start = i;
    let mut quote: Option<u8> = None;
    while i < bytes.len() {
        let b = bytes[i];
        match quote {
            Some(q) if b == q => quote = None,
            Some(_) => {}
            None if b == b'"' || b == b'\'' => quote = Some(b),
            None if b == b'>' => break,
            None => {}
        }
        i += 1;
    }
    let attrs = &html[attrs_start..i.min(bytes.len())];
    let self_closing = attrs.trim_end().ends_with('/');
    let end = (i + 1).min(bytes.len());
    let alt = if name == "img" {
        attribute(attrs, "alt")
    } else {
        None
    };
    let start_attr = if name == "ol" {
        attribute(attrs, "start").and_then(|v| v.trim().parse().ok())
    } else {
        None
    };
    Some(Tag {
        name,
        closing,
        self_closing,
        end,
        alt,
        start_attr,
    })
}

/// A quoted attribute's value (enough for `alt` and `start`).
fn attribute(attrs: &str, name: &str) -> Option<String> {
    let lower = attrs.to_ascii_lowercase();
    let mut from = 0;
    while let Some(pos) = lower[from..].find(name) {
        let at = from + pos;
        from = at + name.len();
        let before_ok = at == 0 || lower.as_bytes()[at - 1].is_ascii_whitespace();
        let rest = lower[from..].trim_start();
        if !before_ok || !rest.starts_with('=') {
            continue;
        }
        let value_start = attrs.len() - rest.len() + 1;
        let value = attrs[value_start..].trim_start();
        let quote = value.chars().next()?;
        if quote == '"' || quote == '\'' {
            let inner = &value[1..];
            return inner.find(quote).map(|e| inner[..e].to_string());
        }
        return Some(
            value
                .split(|c: char| c.is_whitespace() || c == '>' || c == '/')
                .next()
                .unwrap_or("")
                .to_string(),
        );
    }
    None
}

/// The index just past `</name ...>`, searching case-insensitively from `from`.
fn find_closing(html: &str, from: usize, name: &str) -> Option<usize> {
    let lower = html.get(from..)?.to_ascii_lowercase();
    let needle = format!("</{name}");
    let mut search = 0;
    while let Some(pos) = lower[search..].find(&needle) {
        let at = search + pos;
        let after = lower.as_bytes().get(at + needle.len()).copied();
        if matches!(after, Some(b'>') | Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r') | None) {
            let close = lower[at..].find('>').map(|e| at + e + 1).unwrap_or(lower.len());
            return Some(from + close);
        }
        search = at + needle.len();
    }
    None
}

/// Decode HTML character references. Unknown names are left as written.
pub fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        let end = after
            .char_indices()
            .take(32)
            .find(|(_, c)| *c == ';')
            .map(|(i, _)| i);
        let decoded = end.and_then(|end| decode_reference(&after[..end]).map(|c| (c, end)));
        match decoded {
            Some((replacement, end)) => {
                out.push_str(replacement.as_str());
                rest = &after[end + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn decode_reference(name: &str) -> Option<String> {
    if let Some(num) = name.strip_prefix('#') {
        let code = if let Some(hex) = num.strip_prefix(['x', 'X']) {
            u32::from_str_radix(hex, 16).ok()?
        } else {
            num.parse::<u32>().ok()?
        };
        let c = char::from_u32(code).filter(|c| *c != '\0').unwrap_or('\u{FFFD}');
        return Some(c.to_string());
    }
    let c = match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => "\u{a0}",
        "ensp" => "\u{2002}",
        "emsp" => "\u{2003}",
        "thinsp" => "\u{2009}",
        "zwnj" => "\u{200c}",
        "zwj" => "\u{200d}",
        "shy" => "\u{ad}",
        "ndash" => "–",
        "mdash" => "—",
        "hellip" => "…",
        "lsquo" => "‘",
        "rsquo" => "’",
        "sbquo" => "‚",
        "ldquo" => "“",
        "rdquo" => "”",
        "bdquo" => "„",
        "laquo" => "«",
        "raquo" => "»",
        "lsaquo" => "‹",
        "rsaquo" => "›",
        "bull" => "•",
        "middot" => "·",
        "prime" => "′",
        "Prime" => "″",
        "dagger" => "†",
        "Dagger" => "‡",
        "sect" => "§",
        "para" => "¶",
        "copy" => "©",
        "reg" => "®",
        "trade" => "™",
        "deg" => "°",
        "plusmn" => "±",
        "times" => "×",
        "divide" => "÷",
        "minus" => "−",
        "frac12" => "½",
        "frac14" => "¼",
        "frac34" => "¾",
        "sup1" => "¹",
        "sup2" => "²",
        "sup3" => "³",
        "micro" => "µ",
        "cent" => "¢",
        "pound" => "£",
        "euro" => "€",
        "yen" => "¥",
        "iexcl" => "¡",
        "iquest" => "¿",
        "ordf" => "ª",
        "ordm" => "º",
        "acute" => "´",
        "uml" => "¨",
        "cedil" => "¸",
        "macr" => "¯",
        "not" => "¬",
        "brvbar" => "¦",
        "curren" => "¤",
        "larr" => "←",
        "rarr" => "→",
        "uarr" => "↑",
        "darr" => "↓",
        "harr" => "↔",
        "Agrave" => "À",
        "Aacute" => "Á",
        "Acirc" => "Â",
        "Atilde" => "Ã",
        "Auml" => "Ä",
        "Aring" => "Å",
        "AElig" => "Æ",
        "Ccedil" => "Ç",
        "Egrave" => "È",
        "Eacute" => "É",
        "Ecirc" => "Ê",
        "Euml" => "Ë",
        "Igrave" => "Ì",
        "Iacute" => "Í",
        "Icirc" => "Î",
        "Iuml" => "Ï",
        "ETH" => "Ð",
        "Ntilde" => "Ñ",
        "Ograve" => "Ò",
        "Oacute" => "Ó",
        "Ocirc" => "Ô",
        "Otilde" => "Õ",
        "Ouml" => "Ö",
        "Oslash" => "Ø",
        "Ugrave" => "Ù",
        "Uacute" => "Ú",
        "Ucirc" => "Û",
        "Uuml" => "Ü",
        "Yacute" => "Ý",
        "THORN" => "Þ",
        "szlig" => "ß",
        "agrave" => "à",
        "aacute" => "á",
        "acirc" => "â",
        "atilde" => "ã",
        "auml" => "ä",
        "aring" => "å",
        "aelig" => "æ",
        "ccedil" => "ç",
        "egrave" => "è",
        "eacute" => "é",
        "ecirc" => "ê",
        "euml" => "ë",
        "igrave" => "ì",
        "iacute" => "í",
        "icirc" => "î",
        "iuml" => "ï",
        "eth" => "ð",
        "ntilde" => "ñ",
        "ograve" => "ò",
        "oacute" => "ó",
        "ocirc" => "ô",
        "otilde" => "õ",
        "ouml" => "ö",
        "oslash" => "ø",
        "ugrave" => "ù",
        "uacute" => "ú",
        "ucirc" => "û",
        "uuml" => "ü",
        "yacute" => "ý",
        "thorn" => "þ",
        "yuml" => "ÿ",
        "OElig" => "Œ",
        "oelig" => "œ",
        "Scaron" => "Š",
        "scaron" => "š",
        "Yuml" => "Ÿ",
        "fnof" => "ƒ",
        "circ" => "ˆ",
        "tilde" => "˜",
        "alpha" => "α",
        "beta" => "β",
        "gamma" => "γ",
        "delta" => "δ",
        "pi" => "π",
        "sigma" => "σ",
        "omega" => "ω",
        "Omega" => "Ω",
        "infin" => "∞",
        "ne" => "≠",
        "le" => "≤",
        "ge" => "≥",
        "asymp" => "≈",
        _ => return None,
    };
    Some(c.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHAPTER: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter One</title>
<style>p { color: red; } .x &gt; .y {}</style>
<script type="text/javascript">var a = "<p>not text</p>";</script></head>
<body><h1>Chapter One</h1>
<p>The keeper&#8217;s log &amp; the ships &mdash; at&nbsp;dusk.</p>
<p>Second   paragraph
   spans lines.</p><!-- a comment <p>hidden</p> -->
</body></html>"#;

    #[test]
    fn skips_head_style_script_and_comments() {
        let text = html_to_text(CHAPTER);
        assert!(!text.contains("color: red"), "{text}");
        assert!(!text.contains("not text"), "{text}");
        assert!(!text.contains("hidden"), "{text}");
        assert!(!text.contains("var a"), "{text}");
    }

    #[test]
    fn heading_appears_once_and_blocks_are_separated() {
        let text = html_to_text(CHAPTER);
        assert_eq!(text.matches("Chapter One").count(), 1, "{text}");
        assert_eq!(
            text,
            "Chapter One\n\nThe keeper’s log & the ships — at\u{a0}dusk.\n\nSecond paragraph spans lines."
        );
    }

    #[test]
    fn decodes_named_numeric_and_hex_entities() {
        assert_eq!(
            decode_entities("&lt;a&gt; &quot;q&quot; &#233; &#xE9; &eacute; &hellip;"),
            "<a> \"q\" é é é …"
        );
        // Unknown names and bare ampersands stay as written.
        assert_eq!(decode_entities("R&D &unknown; a & b"), "R&D &unknown; a & b");
        // Invalid code points do not panic.
        assert_eq!(decode_entities("&#0;&#x110000;"), "\u{FFFD}&#x110000;");
    }

    #[test]
    fn inline_markup_does_not_break_lines() {
        assert_eq!(
            html_to_text("<p>One <em>two</em> <a href='#'>three</a>four.</p>"),
            "One two threefour."
        );
    }

    #[test]
    fn line_breaks_lists_and_preformatted_text() {
        let html = "<p>a<br/>b<br>c</p><ul><li>x</li><li>y</li></ul><ol start='3'><li>p</li><li>q</li></ol><pre>\n  keep   this\n    indent</pre><p>end</p>";
        assert_eq!(
            html_to_text(html),
            "a\nb\nc\n\n• x\n• y\n\n3. p\n4. q\n\n  keep   this\n    indent\n\nend"
        );
    }

    #[test]
    fn empty_and_text_only_inputs() {
        assert_eq!(html_to_text(""), "");
        assert_eq!(html_to_text("<html><head><title>t</title></head><body></body></html>"), "");
        assert_eq!(html_to_text("plain   text"), "plain text");
        assert_eq!(html_to_text("a < b and c > d"), "a < b and c > d");
    }

    #[test]
    fn cdata_unclosed_tags_and_uppercase() {
        assert_eq!(html_to_text("<P>One<![CDATA[ & two ]]></P><DIV>Three"), "One & two\nThree");
        assert_eq!(html_to_text("<p>cut off <b"), "cut off");
        assert_eq!(html_to_text("<SCRIPT>x()</SCRIPT><p>ok</p>"), "ok");
        assert_eq!(html_to_text("<style>unterminated"), "");
    }

    #[test]
    fn table_cells_and_images() {
        assert_eq!(
            html_to_text("<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table><p><img src='x.png' alt='Map &amp; key'/></p>"),
            "a b\nc\n\n[Map & key]"
        );
    }

    #[test]
    fn multibyte_text_survives() {
        assert_eq!(
            html_to_text("<p>吾輩は猫である。</p><p>שלום 👨‍👩‍👧</p>"),
            "吾輩は猫である。\n\nשלום 👨‍👩‍👧"
        );
    }
}
