//! OpenSearch description documents and search URL templates.

use super::model::SearchTemplate;
use super::util::*;
use super::xml;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};

/// RFC 3986 unreserved characters stay literal; everything else is percent-encoded.
const QUERY: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// Templates from an OpenSearch description, best first (OPDS before generic Atom; HTML is ignored).
pub fn parse_description(root: &xml::Node, base: &str) -> Vec<SearchTemplate> {
    let mut out: Vec<(i32, SearchTemplate)> = Vec::new();
    for u in root.children.iter().filter(|c| c.local == "url") {
        let (Some(t), mime) = (u.attr("template"), u.attr("type").unwrap_or("")) else {
            continue;
        };
        let e = essence(mime);
        let score = if e == "application/opds+json"
            || (e == "application/atom+xml" && mime.to_ascii_lowercase().contains("opds"))
        {
            3
        } else if e == "application/atom+xml" {
            2
        } else {
            continue;
        };
        if u.attr("rel")
            .map(|r| r.contains("suggestions"))
            .unwrap_or(false)
        {
            continue;
        }
        out.push((
            score,
            SearchTemplate {
                template: super::atom::resolve_template(base, t),
                mime: mime.to_string(),
            },
        ));
    }
    out.sort_by_key(|(s, _)| -s);
    out.into_iter().map(|(_, t)| t).collect()
}

fn enc(q: &str) -> String {
    utf8_percent_encode(q, QUERY).to_string()
}

/// Fill a search URL template with `query`.
///
/// Understands OpenSearch (`{searchTerms}`, optional `{startPage?}`) and RFC 6570 forms used by
/// OPDS 2.0 (`{?query}`, `{&q,title}`, `{query}`). Parameters other than the search terms are
/// dropped when optional and given their OpenSearch defaults when required.
pub fn expand(template: &str, query: &str) -> String {
    let mut out = String::with_capacity(template.len() + query.len());
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let Some(end) = rest[start..].find('}') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let inner = &rest[start + 1..start + end];
        rest = &rest[start + end + 1..];

        let (op, vars) = match inner.chars().next() {
            Some(c @ ('?' | '&' | '#' | '+' | '/' | '.' | ';')) => (Some(c), &inner[1..]),
            _ => (None, inner),
        };
        let mut produced: Vec<String> = Vec::new();
        let mut dropped_required = false;
        for var in vars.split(',') {
            let optional = var.ends_with('?');
            let name = var
                .trim_end_matches('?')
                .trim_end_matches('*')
                .split(':')
                .next()
                .unwrap_or("")
                .trim();
            let lname = name.to_ascii_lowercase();
            let value = match lname.as_str() {
                "searchterms" | "query" | "q" | "search" | "term" | "terms" | "keywords" => {
                    Some(enc(query))
                }
                "startpage" => (!optional).then(|| "1".to_string()),
                "startindex" => (!optional).then(|| "1".to_string()),
                "language" => Some("*".to_string()),
                "inputencoding" | "outputencoding" => Some("UTF-8".to_string()),
                // Other parameters (title, author, count, ...) are left unset.
                _ => None,
            };
            if value.is_none() && op.is_none() {
                dropped_required = true;
            }
            if let Some(v) = value {
                match op {
                    Some('?') | Some('&') => produced.push(format!("{name}={v}")),
                    _ => produced.push(v),
                }
            }
        }
        match op {
            Some('?') if !produced.is_empty() => {
                out.push(if out.contains('?') { '&' } else { '?' });
                out.push_str(&produced.join("&"));
            }
            Some('&') if !produced.is_empty() => {
                out.push(if out.contains('?') { '&' } else { '?' });
                out.push_str(&produced.join("&"));
            }
            Some('?') | Some('&') => {}
            _ => {
                // `&p={startPage?}` that expands to nothing: drop the whole `p=` pair.
                if produced.is_empty() && dropped_required && out.ends_with('=') {
                    out.pop();
                    while out
                        .chars()
                        .last()
                        .map(|c| c != '&' && c != '?')
                        .unwrap_or(false)
                    {
                        out.pop();
                    }
                    if out.ends_with('&') {
                        out.pop();
                    }
                }
                out.push_str(&produced.join(","));
            }
        }
    }
    out.push_str(rest);
    // `?&` or trailing separators left by dropped optional parameters.
    out = out.replace("?&", "?").replace("&&", "&");
    while out.ends_with('&') || out.ends_with('?') {
        out.pop();
    }
    out
}
