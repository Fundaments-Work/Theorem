//! OPDS catalog parsing: Atom/OPDS 1.x, OPDS 2.0 JSON, OpenSearch and HTML discovery,
//! normalised into one model (`model::Feed`). No I/O; the Tauri layer fetches and calls in.

pub mod atom;
pub mod model;
pub mod opds2;
pub mod search;
pub mod util;
pub mod xml;

use model::Outcome;
use util::{decode_body, essence, resolve};

/// Classify and parse a fetched document.
///
/// `content_type` is the response header (may be empty); `base_url` is the *final* URL after
/// redirects, which is what relative links must resolve against.
pub fn parse_catalog(body: &[u8], content_type: &str, base_url: &str) -> Outcome {
    let text = decode_body(body, content_type);
    let trimmed = text.trim_start();
    if trimmed.is_empty() {
        return Outcome::Unsupported {
            reason: "The server returned an empty response.".into(),
        };
    }

    if trimmed.starts_with('{')
        || trimmed.starts_with('[')
        || essence(content_type).ends_with("json")
    {
        return match serde_json::from_str::<serde_json::Value>(trimmed) {
            Ok(doc) => {
                if let Some(auth) = opds2::as_authentication(&doc) {
                    return auth;
                }
                if doc.get("readingOrder").is_some() && doc.get("publications").is_none() {
                    return Outcome::Unsupported {
                        reason: "This is a publication manifest, not a catalog.".into(),
                    };
                }
                if doc.get("metadata").is_none()
                    && doc.get("navigation").is_none()
                    && doc.get("publications").is_none()
                    && doc.get("groups").is_none()
                    && doc.get("links").is_none()
                {
                    return Outcome::Unsupported {
                        reason: "This JSON document is not an OPDS catalog.".into(),
                    };
                }
                match opds2::parse(&doc, base_url) {
                    Ok(feed) => Outcome::Feed {
                        feed: Box::new(feed),
                    },
                    Err(reason) => Outcome::Unsupported { reason },
                }
            }
            Err(e) => Outcome::Unsupported {
                reason: format!("Invalid JSON: {e}"),
            },
        };
    }

    if trimmed.starts_with('<') {
        let head = trimmed
            .chars()
            .take(400)
            .collect::<String>()
            .to_ascii_lowercase();
        let looks_html = head.contains("<!doctype html") || head.contains("<html");
        let ct = essence(content_type);
        if looks_html || ct == "text/html" {
            // XHTML served as XML is still HTML for our purposes: look for an advertised feed.
            return match discover(&text, base_url) {
                Some((href, mime)) => Outcome::Discovery { href, mime },
                None => Outcome::Unsupported {
                    reason: "This address is a web page and does not advertise an OPDS catalog."
                        .into(),
                },
            };
        }
        return match xml::parse(&text) {
            Ok(root) => match root.local.as_str() {
                "feed" | "entry" => match atom::parse(&root, base_url) {
                    Ok(feed) => Outcome::Feed {
                        feed: Box::new(feed),
                    },
                    Err(reason) => Outcome::Unsupported { reason },
                },
                "opensearchdescription" => Outcome::OpenSearch {
                    templates: search::parse_description(&root, base_url),
                },
                other => Outcome::Unsupported {
                    reason: format!(
                        "Unrecognised document (<{other}>). Is this an OPDS catalog address?"
                    ),
                },
            },
            Err(reason) => Outcome::Unsupported { reason },
        };
    }
    Outcome::Unsupported {
        reason: "The server did not return a catalog.".into(),
    }
}

/// Find an OPDS link advertised by an HTML page (`<link rel="alternate" type="...opds...">`).
fn discover(html: &str, base: &str) -> Option<(String, String)> {
    let lower = html.to_ascii_lowercase();
    let mut best: Option<(i32, String, String)> = None;
    let mut pos = 0;
    while let Some(i) = lower[pos..].find("<link") {
        let start = pos + i;
        let Some(len) = lower[start..].find('>') else {
            break;
        };
        let tag = &html[start..start + len];
        pos = start + len;
        let attr = |name: &str| -> Option<String> {
            let l = tag.to_ascii_lowercase();
            let idx = l.find(&format!("{name}="))?;
            let rest = &tag[idx + name.len() + 1..];
            let quote = rest.chars().next()?;
            if quote == '"' || quote == '\'' {
                let inner = &rest[1..];
                Some(inner[..inner.find(quote)?].to_string())
            } else {
                Some(
                    rest.split(|c: char| c.is_whitespace() || c == '>' || c == '/')
                        .next()?
                        .to_string(),
                )
            }
        };
        let (Some(href), Some(mime)) = (attr("href"), attr("type")) else {
            continue;
        };
        let e = essence(&mime);
        let score = if e == "application/opds+json"
            || (e == "application/atom+xml" && mime.to_ascii_lowercase().contains("opds"))
        {
            3
        } else if e == "application/atom+xml" {
            1
        } else {
            continue;
        };
        if best.as_ref().map(|(s, _, _)| score > *s).unwrap_or(true) {
            best = Some((score, resolve(base, &href), mime));
        }
    }
    best.map(|(_, h, m)| (h, m))
}

#[cfg(test)]
mod tests;
