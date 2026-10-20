//! Small shared helpers: URL resolution, media-type and rel handling, acquisition ranking.

use super::model::{Acquisition, AcquisitionKind};
use url::Url;

/// Resolve `href` against `base`. `data:` URIs and already-absolute URLs pass through.
/// An unparseable `base` leaves a relative `href` untouched rather than failing the feed.
pub fn resolve(base: &str, href: &str) -> String {
    let href = href.trim();
    if href.is_empty() {
        return String::new();
    }
    if href.starts_with("data:") {
        return href.to_string();
    }
    match Url::parse(base) {
        Ok(b) => b
            .join(href)
            .map(|u| u.to_string())
            .unwrap_or_else(|_| href.to_string()),
        Err(_) => href.to_string(),
    }
}

/// The lowercased `type` of a media type, without parameters.
pub fn essence(mime: &str) -> String {
    mime.split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

/// A parameter of a media type (`profile=opds-catalog` -> `opds-catalog`).
pub fn mime_param(mime: &str, name: &str) -> Option<String> {
    mime.split(';').skip(1).find_map(|part| {
        let (k, v) = part.split_once('=')?;
        (k.trim().eq_ignore_ascii_case(name))
            .then(|| v.trim().trim_matches('"').to_ascii_lowercase())
    })
}

/// Does a (possibly space separated, possibly IANA-URI) `rel` contain `want`?
pub fn rel_is(rel: &str, want: &str) -> bool {
    rel.split_whitespace().any(|r| {
        let r = r.to_ascii_lowercase();
        r == want
            || r.strip_prefix("http://www.iana.org/assignments/relation/") == Some(want)
            || r.strip_prefix("https://www.iana.org/assignments/relation/") == Some(want)
    })
}

pub fn rel_has_prefix(rel: &str, prefix: &str) -> bool {
    rel.split_whitespace()
        .any(|r| r.to_ascii_lowercase().starts_with(prefix))
}

/// An OPDS catalog (feed or navigation target), as opposed to a book file or web page.
pub fn is_catalog_mime(mime: &str) -> bool {
    let e = essence(mime);
    e == "application/opds+json"
        || e == "application/opds-publication+json"
        || (e == "application/atom+xml" && !mime.to_ascii_lowercase().contains("type=entry"))
        || (e == "application/xml" && mime.to_ascii_lowercase().contains("opds"))
}

pub fn is_entry_mime(mime: &str) -> bool {
    let lower = mime.to_ascii_lowercase();
    (essence(mime) == "application/atom+xml" && lower.contains("type=entry"))
        || essence(mime) == "application/opds-publication+json"
}

const DRM_TYPES: &[&str] = &[
    "application/vnd.adobe.adept+xml",
    "application/vnd.readium.lcp.license.v1.0+json",
    "application/vnd.readium.license.status.v1.0+json",
    "application/vnd.librarysimplified.bearer-token+json",
    "application/vnd.librarysimplified.axisnow+json",
    "application/vnd.adobe.drm+xml",
    "application/x-ibooks+zip",
];

pub fn is_drm_type(mime: &str) -> bool {
    let e = essence(mime);
    DRM_TYPES.contains(&e.as_str())
}

/// Importable format for a media type or file name.
pub fn format_of(mime: &str, href: &str) -> Option<&'static str> {
    let t = essence(mime);
    let path = href
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let by_type = match t.as_str() {
        "application/epub+zip" => Some("epub"),
        "application/pdf" => Some("pdf"),
        "application/x-cbz" | "application/vnd.comicbook+zip" | "application/x-cb7" => Some("cbz"),
        "application/x-cbr" | "application/vnd.comicbook-rar" => Some("cbr"),
        "application/x-mobipocket-ebook"
        | "application/x-mobi8-ebook"
        | "application/vnd.amazon.ebook"
        | "application/vnd.amazon.mobi8-ebook"
        | "application/octet-stream+mobi" => Some("mobi"),
        "application/x-fictionbook+xml"
        | "application/fb2+xml"
        | "application/x-zip-compressed-fb2"
        | "application/fb2+zip" => Some("fb2"),
        _ => None,
    };
    if by_type.is_some() {
        return by_type;
    }
    // Servers that answer with a generic type: fall back to the extension.
    if t.is_empty()
        || t == "application/octet-stream"
        || t == "application/zip"
        || t == "binary/octet-stream"
    {
        for (ext, f) in [
            (".epub", "epub"),
            (".pdf", "pdf"),
            (".cbz", "cbz"),
            (".cbr", "cbr"),
            (".mobi", "mobi"),
            (".azw3", "mobi"),
            (".azw", "mobi"),
            (".prc", "mobi"),
            (".fb2", "fb2"),
            (".fb2.zip", "fb2"),
        ] {
            if path.ends_with(ext) {
                return Some(f);
            }
        }
    }
    // Some catalogs (Gutenberg) end the path in `.epub.images` / `.kindle.noimages`.
    if path.contains(".epub") {
        return Some("epub");
    }
    if path.contains(".kindle") {
        return Some("mobi");
    }
    None
}

pub fn kind_of_rel(rel: &str) -> Option<AcquisitionKind> {
    let rel = rel.split_whitespace().find(|r| {
        r.to_ascii_lowercase()
            .starts_with("http://opds-spec.org/acquisition")
    })?;
    let rest = rel.to_ascii_lowercase();
    let rest = rest.trim_start_matches("http://opds-spec.org/acquisition");
    Some(match rest.trim_start_matches('/') {
        "open-access" => AcquisitionKind::OpenAccess,
        "borrow" => AcquisitionKind::Borrow,
        "buy" => AcquisitionKind::Buy,
        "sample" | "preview" => AcquisitionKind::Sample,
        "subscribe" => AcquisitionKind::Subscribe,
        _ => AcquisitionKind::Generic,
    })
}

/// Fill the derived fields (`format`, `drm`, `downloadable`) of an acquisition.
pub fn finish_acquisition(a: &mut Acquisition) {
    let final_mime = a.indirect.last().cloned().unwrap_or_else(|| a.mime.clone());
    a.drm = is_drm_type(&a.mime) || a.indirect.iter().any(|m| is_drm_type(m));
    // For an indirect chain the file we end up with is the last type in it.
    let candidate = if a.indirect.is_empty() {
        a.mime.as_str()
    } else {
        final_mime.as_str()
    };
    a.format = format_of(candidate, &a.href).or_else(|| format_of(&a.mime, &a.href));
    let direct_kind = matches!(
        a.kind,
        AcquisitionKind::Generic | AcquisitionKind::OpenAccess | AcquisitionKind::Sample
    );
    // A direct file we can import: no DRM, no purchase/loan step, no HTML landing page in between.
    a.downloadable = !a.drm
        && direct_kind
        && a.format.is_some()
        && a.indirect.is_empty()
        && essence(&a.mime) != "text/html";
}

/// Higher is better. Used to pick the single "Download" action of an entry.
fn rank(a: &Acquisition) -> i32 {
    let mut score = match a.format {
        Some("epub") => 60,
        Some("pdf") => 50,
        Some("cbz") => 45,
        Some("cbr") => 44,
        Some("mobi") => 40,
        Some("fb2") => 35,
        _ => 0,
    };
    score += match a.kind {
        AcquisitionKind::OpenAccess => 8,
        AcquisitionKind::Generic => 6,
        AcquisitionKind::Sample => -30,
        _ => 0,
    };
    let hay = format!("{} {}", a.title.as_deref().unwrap_or(""), a.href).to_ascii_lowercase();
    // Prefer the illustrated edition and the newer EPUB generation when a catalog offers several.
    if hay.contains("noimages") || hay.contains("no images") {
        score -= 5;
    }
    // Kobo's KEPUB and "advanced" EPUBs are variants of the plain file; only choose them when nothing else exists.
    if hay.contains("kepub") {
        score -= 20;
    }
    if hay.contains("advanced") {
        score -= 3;
    }
    if hay.contains("recommended") || hay.contains("compatible") {
        score += 3;
    }
    if hay.contains("epub3") {
        score += 2;
    }
    score
}

pub fn pick_primary(acqs: &[Acquisition]) -> Option<usize> {
    acqs.iter()
        .enumerate()
        // A sample is never "the book"; it is offered separately.
        .filter(|(_, a)| a.downloadable && a.kind != AcquisitionKind::Sample)
        .max_by_key(|(i, a)| (rank(a), -(*i as i32)))
        .map(|(i, _)| i)
}

/// Decode a response body. UTF-8 (with or without BOM) first; otherwise honour the
/// declared charset for the legacy encodings catalogs actually use.
pub fn decode_body(bytes: &[u8], content_type: &str) -> String {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(bytes);
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(200)]).to_ascii_lowercase();
    let declared = mime_param(content_type, "charset")
        .or_else(|| {
            head.split("encoding=").nth(1).map(|r| {
                r.trim_start_matches(['"', '\''])
                    .split(['"', '\''])
                    .next()
                    .unwrap_or("")
                    .to_string()
            })
        })
        .unwrap_or_default();
    match declared.as_str() {
        "iso-8859-1" | "latin1" | "latin-1" | "windows-1252" | "cp1252" | "us-ascii" => {
            bytes.iter().map(|&b| b as char).collect()
        }
        _ => String::from_utf8_lossy(bytes).into_owned(),
    }
}

pub fn strip_html_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
