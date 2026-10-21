//! Network side of OPDS browsing: content-negotiated fetching with HTTP Basic auth, typed
//! errors, OpenSearch resolution, and streamed book downloads. Parsing lives in
//! `theorem_core::opds`; this module never interprets catalog documents itself.

use futures::StreamExt;
use reqwest::header::{
    ACCEPT, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE, RETRY_AFTER, WWW_AUTHENTICATE,
};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::Emitter;
use theorem_core::opds::model::{Outcome, SearchKind};
use theorem_core::opds::util::{essence, format_of};
use theorem_core::opds::{parse_catalog, search};

/// Largest catalog document accepted. Real feeds are tens of KB; this only stops a hostile or
/// misconfigured server from filling memory.
const MAX_FEED_BYTES: usize = 25 * 1024 * 1024;
const MAX_BOOK_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_HOPS: usize = 3;

const ACCEPT_CATALOG: &str =
    "application/opds+json, application/atom+xml;profile=opds-catalog;q=0.95, \
    application/atom+xml;q=0.9, application/xml;q=0.8, text/xml;q=0.8, text/html;q=0.5, */*;q=0.1";

#[derive(Debug, Clone, Deserialize)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OpdsError {
    InvalidUrl {
        message: String,
    },
    Network {
        message: String,
    },
    Timeout,
    NotFound,
    Forbidden,
    RateLimited {
        retry_after: Option<u64>,
    },
    Http {
        status: u16,
    },
    /// 401. `hint` is the server's OPDS Authentication Document when it sent one.
    AuthRequired {
        realm: Option<String>,
        scheme: Option<String>,
        hint: Option<Outcome>,
    },
    TooLarge {
        limit: u64,
    },
    Unsupported {
        message: String,
    },
    Io {
        message: String,
    },
}

impl std::fmt::Display for OpdsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpdsError::InvalidUrl { message }
            | OpdsError::Network { message }
            | OpdsError::Unsupported { message }
            | OpdsError::Io { message } => {
                write!(f, "{message}")
            }
            OpdsError::Timeout => write!(f, "The catalog took too long to respond."),
            OpdsError::NotFound => write!(f, "Not found (HTTP 404)."),
            OpdsError::Forbidden => write!(f, "Access denied (HTTP 403)."),
            OpdsError::RateLimited { .. } => write!(
                f,
                "The catalog is rate limiting requests. Try again shortly."
            ),
            OpdsError::Http { status } => write!(f, "The catalog answered with HTTP {status}."),
            OpdsError::AuthRequired { .. } => write!(f, "This catalog requires a sign-in."),
            OpdsError::TooLarge { .. } => {
                write!(f, "The response is larger than Theorem will accept.")
            }
        }
    }
}

fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .user_agent(concat!(
                "Theorem/",
                env!("CARGO_PKG_VERSION"),
                " (+https://theorem.fundaments.work)"
            ))
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::limited(8))
            .build()
            .expect("failed to build OPDS HTTP client")
    })
}

fn check_url(url: &str) -> Result<reqwest::Url, OpdsError> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|e| OpdsError::InvalidUrl {
        message: format!("Not a valid address: {e}"),
    })?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        other => Err(OpdsError::InvalidUrl {
            message: format!("Only http and https catalogs are supported (got {other}:)."),
        }),
    }
}

fn map_send_error(e: reqwest::Error) -> OpdsError {
    if e.is_timeout() {
        OpdsError::Timeout
    } else {
        // reqwest's Display for connect errors is terse; the source chain has the useful part.
        let mut msg = e.to_string();
        let mut src = std::error::Error::source(&e);
        while let Some(s) = src {
            msg = format!("{msg}: {s}");
            src = s.source();
        }
        OpdsError::Network { message: msg }
    }
}

fn request(url: reqwest::Url, auth: Option<&Credentials>, accept: &str) -> reqwest::RequestBuilder {
    let mut req = client().get(url).header(ACCEPT, accept);
    if let Some(c) = auth {
        req = req.basic_auth(&c.username, Some(&c.password));
    }
    req
}

struct Fetched {
    final_url: String,
    content_type: String,
    body: Vec<u8>,
}

fn parse_www_authenticate(h: &str) -> (Option<String>, Option<String>) {
    let scheme = h.split_whitespace().next().map(|s| s.to_string());
    let realm = h
        .split("realm=")
        .nth(1)
        .map(|r| {
            r.trim_start_matches('"')
                .split('"')
                .next()
                .unwrap_or("")
                .to_string()
        })
        .filter(|r| !r.is_empty());
    (scheme, realm)
}

async fn fetch_document(url: &str, auth: Option<&Credentials>) -> Result<Fetched, OpdsError> {
    let parsed = check_url(url)?;
    let resp = request(parsed, auth, ACCEPT_CATALOG)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(map_send_error)?;
    let status = resp.status();
    let final_url = resp.url().to_string();
    let content_type = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let www = resp
        .headers()
        .get(WWW_AUTHENTICATE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let retry_after = resp
        .headers()
        .get(RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok());

    if let Some(len) = resp
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
    {
        if len as usize > MAX_FEED_BYTES {
            return Err(OpdsError::TooLarge {
                limit: MAX_FEED_BYTES as u64,
            });
        }
    }
    let mut body: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(map_send_error)?;
        if body.len() + chunk.len() > MAX_FEED_BYTES {
            return Err(OpdsError::TooLarge {
                limit: MAX_FEED_BYTES as u64,
            });
        }
        body.extend_from_slice(&chunk);
    }

    match status {
        s if s.is_success() => Ok(Fetched {
            final_url,
            content_type,
            body,
        }),
        StatusCode::UNAUTHORIZED => {
            let (scheme, realm) = www
                .as_deref()
                .map(parse_www_authenticate)
                .unwrap_or((None, None));
            let hint = match parse_catalog(&body, &content_type, &final_url) {
                o @ Outcome::Authentication { .. } => Some(o),
                _ => None,
            };
            Err(OpdsError::AuthRequired {
                realm,
                scheme,
                hint,
            })
        }
        StatusCode::FORBIDDEN => Err(OpdsError::Forbidden),
        StatusCode::NOT_FOUND | StatusCode::GONE => Err(OpdsError::NotFound),
        StatusCode::TOO_MANY_REQUESTS => Err(OpdsError::RateLimited { retry_after }),
        s => Err(OpdsError::Http { status: s.as_u16() }),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    /// Where the document actually came from (after redirects and HTML discovery).
    pub final_url: String,
    pub outcome: Outcome,
}

pub async fn load(url: &str, auth: Option<&Credentials>) -> Result<Loaded, OpdsError> {
    let mut current = url.trim().to_string();
    let mut seen: Vec<String> = Vec::new();
    for _ in 0..=MAX_HOPS {
        if seen.contains(&current) {
            break;
        }
        seen.push(current.clone());
        let fetched = fetch_document(&current, auth).await?;
        let final_url = fetched.final_url.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            parse_catalog(&fetched.body, &fetched.content_type, &fetched.final_url)
        })
        .await
        .map_err(|e| OpdsError::Io {
            message: e.to_string(),
        })?;
        match outcome {
            Outcome::Discovery { href, .. } => current = href,
            other => {
                return Ok(Loaded {
                    final_url,
                    outcome: other,
                })
            }
        }
    }
    Err(OpdsError::Unsupported {
        message: "This address does not lead to an OPDS catalog.".into(),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub href: String,
    pub kind: SearchKind,
}

#[tauri::command]
pub async fn opds_load(url: String, auth: Option<Credentials>) -> Result<Loaded, OpdsError> {
    load(&url, auth.as_ref()).await
}

#[tauri::command]
pub async fn opds_search(
    search_ref: SearchRequest,
    query: String,
    auth: Option<Credentials>,
) -> Result<Loaded, OpdsError> {
    let template = match search_ref.kind {
        SearchKind::Template => search_ref.href,
        SearchKind::Description => match load(&search_ref.href, auth.as_ref()).await?.outcome {
            Outcome::OpenSearch { templates } => templates
                .into_iter()
                .next()
                .map(|t| t.template)
                .ok_or_else(|| OpdsError::Unsupported {
                message: "This catalog's search description has no usable search address.".into(),
            })?,
            _ => {
                return Err(OpdsError::Unsupported {
                    message: "This catalog's search description could not be read.".into(),
                })
            }
        },
    };
    load(&search::expand(&template, query.trim()), auth.as_ref()).await
}

// ── downloads ────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedFile {
    pub path: String,
    pub filename: String,
    pub mime: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    id: &'a str,
    received: u64,
    total: Option<u64>,
}

fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim().to_string();
    let cleaned: String = cleaned.chars().take(120).collect();
    if cleaned.is_empty() {
        "book".into()
    } else {
        cleaned
    }
}

fn filename_from_disposition(h: &str) -> Option<String> {
    // RFC 5987 `filename*=UTF-8''...` wins over plain `filename=`.
    if let Some(rest) = h.split("filename*=").nth(1) {
        let v = rest.split(';').next().unwrap_or("").trim();
        if let Some((_, enc)) = v.split_once("''") {
            return Some(percent_decode(enc.trim_matches('"')));
        }
    }
    let rest = h.split("filename=").nth(1)?;
    Some(rest.split(';').next()?.trim().trim_matches('"').to_string()).filter(|s| !s.is_empty())
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn ext_for(format: &str) -> &'static str {
    match format {
        "epub" => "epub",
        "pdf" => "pdf",
        "cbz" => "cbz",
        "cbr" => "cbr",
        "mobi" => "mobi",
        "fb2" => "fb2",
        _ => "bin",
    }
}

/// Does the start of the file look like what its type claims? Catches login and "buy" pages that
/// answer 200 OK with HTML where a book should be.
fn looks_like_html(head: &[u8]) -> bool {
    let s = String::from_utf8_lossy(&head[..head.len().min(512)]).to_ascii_lowercase();
    let s = s.trim_start();
    s.starts_with("<!doctype html")
        || s.starts_with("<html")
        || s.starts_with("<?xml") && s.contains("<html")
}

#[tauri::command]
pub async fn opds_download(
    app: tauri::AppHandle,
    id: String,
    url: String,
    auth: Option<Credentials>,
) -> Result<DownloadedFile, OpdsError> {
    let parsed = check_url(&url)?;
    let resp = request(
        parsed,
        auth.as_ref(),
        "application/epub+zip, application/pdf, application/octet-stream, */*;q=0.5",
    )
    .timeout(Duration::from_secs(600))
    .send()
    .await
    .map_err(map_send_error)?;
    let status = resp.status();
    match status {
        s if s.is_success() => {}
        StatusCode::UNAUTHORIZED => {
            let www = resp
                .headers()
                .get(WWW_AUTHENTICATE)
                .and_then(|v| v.to_str().ok())
                .map(parse_www_authenticate)
                .unwrap_or((None, None));
            return Err(OpdsError::AuthRequired {
                realm: www.1,
                scheme: www.0,
                hint: None,
            });
        }
        StatusCode::FORBIDDEN => return Err(OpdsError::Forbidden),
        StatusCode::NOT_FOUND | StatusCode::GONE => return Err(OpdsError::NotFound),
        s => return Err(OpdsError::Http { status: s.as_u16() }),
    }

    let final_url = resp.url().to_string();
    let mime = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let total = resp
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if total.map(|t| t > MAX_BOOK_BYTES).unwrap_or(false) {
        return Err(OpdsError::TooLarge {
            limit: MAX_BOOK_BYTES,
        });
    }
    let disposition_name = resp
        .headers()
        .get(CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .and_then(filename_from_disposition);
    let url_name = reqwest::Url::parse(&final_url).ok().and_then(|u| {
        u.path_segments()
            .and_then(|mut s| s.rfind(|p| !p.is_empty()).map(percent_decode))
    });
    let mut filename = sanitize_filename(
        &disposition_name
            .or(url_name)
            .unwrap_or_else(|| "book".into()),
    );

    // Make sure the name carries an extension the importer recognises.
    let format = format_of(&mime, &filename)
        .or_else(|| format_of(&mime, &final_url))
        .or_else(|| format_of(&mime, &url));
    let has_known_ext = [
        ".epub", ".pdf", ".cbz", ".cbr", ".mobi", ".azw3", ".azw", ".prc", ".fb2", ".fb2.zip",
    ]
    .iter()
    .any(|e| filename.to_ascii_lowercase().ends_with(e));
    if !has_known_ext {
        match format {
            Some(f) => filename = format!("{filename}.{}", ext_for(f)),
            None => {
                let kind = essence(&mime);
                let kind = if kind.is_empty() {
                    "unknown".to_string()
                } else {
                    kind
                };
                return Err(OpdsError::Unsupported {
                    message: format!("Theorem cannot open this file type ({kind})."),
                });
            }
        }
    }

    let dir: PathBuf = std::env::temp_dir()
        .join("theorem-opds")
        .join(uuid::Uuid::new_v4().to_string());
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| OpdsError::Io {
            message: e.to_string(),
        })?;
    let path = dir.join(&filename);
    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|e| OpdsError::Io {
            message: e.to_string(),
        })?;

    use tokio::io::AsyncWriteExt;
    let mut received: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let mut first = true;
    let mut stream = resp.bytes_stream();
    let result: Result<(), OpdsError> = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(map_send_error)?;
            if first {
                first = false;
                if looks_like_html(&chunk) {
                    return Err(OpdsError::Unsupported {
                        message: "The server returned a web page instead of a book. Signing in or completing a loan/purchase may be required.".into(),
                    });
                }
            }
            received += chunk.len() as u64;
            if received > MAX_BOOK_BYTES {
                return Err(OpdsError::TooLarge { limit: MAX_BOOK_BYTES });
            }
            file.write_all(&chunk).await.map_err(|e| OpdsError::Io { message: e.to_string() })?;
            if last_emit.elapsed() >= Duration::from_millis(120) {
                last_emit = std::time::Instant::now();
                let _ = app.emit("opds-download-progress", Progress { id: &id, received, total });
            }
        }
        file.flush().await.map_err(|e| OpdsError::Io { message: e.to_string() })
    }
    .await;

    if let Err(e) = result {
        drop(file);
        let _ = tokio::fs::remove_dir_all(&dir).await;
        return Err(e);
    }
    let _ = app.emit(
        "opds-download-progress",
        Progress {
            id: &id,
            received,
            total: Some(received),
        },
    );
    if received == 0 {
        let _ = tokio::fs::remove_dir_all(&dir).await;
        return Err(OpdsError::Unsupported {
            message: "The download was empty.".into(),
        });
    }
    Ok(DownloadedFile {
        path: path.to_string_lossy().into_owned(),
        filename,
        mime,
        size: received,
    })
}

/// Remove a finished download's temp folder.
#[tauri::command]
pub async fn opds_cleanup_download(path: String) -> Result<(), OpdsError> {
    let p = PathBuf::from(&path);
    let in_tmp = std::env::temp_dir().join("theorem-opds");
    if !p.starts_with(&in_tmp) {
        return Err(OpdsError::Io {
            message: "Refusing to delete a path outside the download folder.".into(),
        });
    }
    if let Some(dir) = p.parent() {
        if dir != in_tmp {
            let _ = tokio::fs::remove_dir_all(dir).await;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disposition_prefers_rfc5987_and_decodes() {
        assert_eq!(
            filename_from_disposition("attachment; filename=\"a.epub\"").as_deref(),
            Some("a.epub")
        );
        assert_eq!(
            filename_from_disposition(
                "attachment; filename=\"a.epub\"; filename*=UTF-8''Caf%C3%A9.epub"
            )
            .as_deref(),
            Some("Café.epub")
        );
        assert_eq!(filename_from_disposition("inline"), None);
    }

    #[test]
    fn filenames_are_sanitised() {
        assert_eq!(sanitize_filename("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(sanitize_filename("a:b*c?.epub"), "a_b_c_.epub");
        assert_eq!(sanitize_filename("   "), "book");
        assert_eq!(sanitize_filename("..."), "book");
        assert!(sanitize_filename(&"x".repeat(500)).len() <= 120);
    }

    #[test]
    fn only_http_urls_are_accepted() {
        assert!(check_url("https://example.org/opds").is_ok());
        assert!(check_url("http://192.168.1.2:8080/opds").is_ok());
        assert!(matches!(
            check_url("file:///etc/passwd"),
            Err(OpdsError::InvalidUrl { .. })
        ));
        assert!(matches!(
            check_url("javascript:alert(1)"),
            Err(OpdsError::InvalidUrl { .. })
        ));
        assert!(matches!(
            check_url("not a url"),
            Err(OpdsError::InvalidUrl { .. })
        ));
    }

    #[test]
    fn html_bodies_are_detected_before_they_become_books() {
        assert!(looks_like_html(b"<!DOCTYPE html><html>"));
        assert!(looks_like_html(b"  \n<html lang=en>"));
        assert!(!looks_like_html(b"PK\x03\x04epub"));
        assert!(!looks_like_html(b"%PDF-1.7"));
    }

    // ---- a tiny HTTP server so the network paths are tested without the internet ----------

    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[derive(Clone)]
    struct Reply {
        status: u16,
        headers: Vec<(&'static str, String)>,
        body: Vec<u8>,
    }

    fn reply(status: u16, ct: &str, body: &str) -> Reply {
        Reply {
            status,
            headers: vec![("Content-Type", ct.to_string())],
            body: body.as_bytes().to_vec(),
        }
    }

    /// Serves `routes` (path-with-query -> reply). Records each request's Authorization header.
    async fn serve(
        routes: HashMap<&'static str, Reply>,
    ) -> (String, Arc<Mutex<Vec<(String, Option<String>)>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen: Arc<Mutex<Vec<(String, Option<String>)>>> = Arc::new(Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        let base = format!("http://{addr}");
        let routes: HashMap<String, Reply> = routes
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let routes = routes.clone();
                let seen = seen2.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let auth = req
                        .lines()
                        .find(|l| l.to_ascii_lowercase().starts_with("authorization:"))
                        .map(|l| l.split_once(':').unwrap().1.trim().to_string());
                    seen.lock().unwrap().push((path.clone(), auth));
                    let r = routes
                        .get(&path)
                        .cloned()
                        .unwrap_or_else(|| reply(404, "text/plain", "nope"));
                    let mut head = format!(
                        "HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n",
                        r.status,
                        r.body.len()
                    );
                    for (k, v) in &r.headers {
                        head.push_str(&format!("{k}: {v}\r\n"));
                    }
                    head.push_str("\r\n");
                    let _ = sock.write_all(head.as_bytes()).await;
                    let _ = sock.write_all(&r.body).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        (base, seen)
    }

    const FEED: &str = r#"<feed xmlns="http://www.w3.org/2005/Atom"><id>i</id><title>Mock</title>
        <link rel="search" type="application/atom+xml" href="/search?q={searchTerms}"/>
        <entry><id>e</id><title>Book</title><author><name>A</name></author>
        <link rel="http://opds-spec.org/acquisition" type="application/epub+zip" href="/book.epub"/></entry></feed>"#;

    fn feed_of(l: Loaded) -> theorem_core::opds::model::Feed {
        match l.outcome {
            Outcome::Feed { feed } => *feed,
            o => panic!("{o:?}"),
        }
    }

    #[tokio::test]
    async fn loads_a_feed_and_resolves_links_against_the_final_url() {
        let mut routes = HashMap::new();
        routes.insert(
            "/opds",
            reply(200, "application/atom+xml;profile=opds-catalog", FEED),
        );
        let (base, _) = serve(routes).await;
        let f = feed_of(load(&format!("{base}/opds"), None).await.unwrap());
        assert_eq!(
            f.entries[0].acquisitions[0].href,
            format!("{base}/book.epub")
        );
        assert_eq!(
            f.search.unwrap().href,
            format!("{base}/search?q={{searchTerms}}")
        );
    }

    #[tokio::test]
    async fn basic_auth_is_required_then_sent() {
        let mut routes = HashMap::new();
        routes.insert(
            "/private",
            Reply {
                status: 401,
                headers: vec![("WWW-Authenticate", "Basic realm=\"My Library\"".into())],
                body: b"".to_vec(),
            },
        );
        let (base, seen) = serve(routes).await;
        match load(&format!("{base}/private"), None).await {
            Err(OpdsError::AuthRequired { realm, scheme, .. }) => {
                assert_eq!(realm.as_deref(), Some("My Library"));
                assert_eq!(scheme.as_deref(), Some("Basic"));
            }
            other => panic!("{other:?}"),
        }
        let creds = Credentials {
            username: "reader".into(),
            password: "s3cret".into(),
        };
        let _ = load(&format!("{base}/private"), Some(&creds)).await;
        let log = seen.lock().unwrap();
        assert_eq!(log[0].1, None, "no credentials before the challenge");
        // base64("reader:s3cret")
        assert_eq!(log[1].1.as_deref(), Some("Basic cmVhZGVyOnMzY3JldA=="));
    }

    #[tokio::test]
    async fn authentication_document_on_401_is_surfaced() {
        let doc = r#"{"id":"a","title":"Library card","authentication":[{"type":"http://opds-spec.org/auth/basic"}]}"#;
        let mut routes = HashMap::new();
        routes.insert(
            "/x",
            Reply {
                status: 401,
                headers: vec![(
                    "Content-Type",
                    "application/vnd.opds.authentication.v1.0+json".into(),
                )],
                body: doc.as_bytes().to_vec(),
            },
        );
        let (base, _) = serve(routes).await;
        match load(&format!("{base}/x"), None).await {
            Err(OpdsError::AuthRequired {
                hint: Some(Outcome::Authentication { title, .. }),
                ..
            }) => assert_eq!(title, "Library card"),
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn redirects_are_followed_and_relative_links_use_the_target() {
        let mut routes = HashMap::new();
        routes.insert(
            "/old",
            Reply {
                status: 302,
                headers: vec![("Location", "/new/feed".into())],
                body: vec![],
            },
        );
        routes.insert("/new/feed", reply(200, "application/atom+xml", FEED));
        let (base, _) = serve(routes).await;
        let l = load(&format!("{base}/old"), None).await.unwrap();
        assert_eq!(l.final_url, format!("{base}/new/feed"));
    }

    #[tokio::test]
    async fn html_page_with_an_opds_link_is_followed() {
        let page = r#"<html><head><link rel="alternate" type="application/atom+xml;profile=opds-catalog" href="/opds"></head></html>"#;
        let mut routes = HashMap::new();
        routes.insert("/", reply(200, "text/html", page));
        routes.insert("/opds", reply(200, "application/atom+xml", FEED));
        let (base, _) = serve(routes).await;
        let l = load(&format!("{base}/"), None).await.unwrap();
        assert_eq!(l.final_url, format!("{base}/opds"));
        assert_eq!(feed_of(l).title, "Mock");
    }

    #[tokio::test]
    async fn html_page_without_a_link_is_a_clear_error_not_a_hang() {
        let mut routes = HashMap::new();
        routes.insert(
            "/",
            reply(200, "text/html", "<html><body>hello</body></html>"),
        );
        let (base, _) = serve(routes).await;
        match load(&format!("{base}/"), None).await.unwrap().outcome {
            Outcome::Unsupported { reason } => assert!(reason.contains("web page")),
            o => panic!("{o:?}"),
        }
    }

    #[tokio::test]
    async fn discovery_loops_terminate() {
        let page = r#"<html><head><link rel="alternate" type="application/atom+xml;profile=opds-catalog" href="/loop"></head></html>"#;
        let mut routes = HashMap::new();
        routes.insert("/loop", reply(200, "text/html", page));
        let (base, _) = serve(routes).await;
        assert!(matches!(
            load(&format!("{base}/loop"), None).await,
            Err(OpdsError::Unsupported { .. })
        ));
    }

    #[tokio::test]
    async fn status_codes_map_to_typed_errors() {
        let mut routes = HashMap::new();
        routes.insert("/403", reply(403, "text/plain", ""));
        routes.insert("/404", reply(404, "text/plain", ""));
        routes.insert("/500", reply(500, "text/plain", ""));
        routes.insert(
            "/429",
            Reply {
                status: 429,
                headers: vec![("Retry-After", "7".into())],
                body: vec![],
            },
        );
        let (base, _) = serve(routes).await;
        assert!(matches!(
            load(&format!("{base}/403"), None).await,
            Err(OpdsError::Forbidden)
        ));
        assert!(matches!(
            load(&format!("{base}/404"), None).await,
            Err(OpdsError::NotFound)
        ));
        assert!(matches!(
            load(&format!("{base}/500"), None).await,
            Err(OpdsError::Http { status: 500 })
        ));
        assert!(matches!(
            load(&format!("{base}/429"), None).await,
            Err(OpdsError::RateLimited {
                retry_after: Some(7)
            })
        ));
    }

    #[tokio::test]
    async fn oversized_documents_are_refused() {
        let big = "x".repeat(MAX_FEED_BYTES + 10);
        let mut routes = HashMap::new();
        routes.insert("/big", reply(200, "application/atom+xml", &big));
        let (base, _) = serve(routes).await;
        assert!(matches!(
            load(&format!("{base}/big"), None).await,
            Err(OpdsError::TooLarge { .. })
        ));
    }

    #[tokio::test]
    async fn unreachable_hosts_and_bad_urls_are_typed() {
        assert!(matches!(
            load("http://127.0.0.1:1/opds", None).await,
            Err(OpdsError::Network { .. })
        ));
        assert!(matches!(
            load("ftp://example.org/x", None).await,
            Err(OpdsError::InvalidUrl { .. })
        ));
        assert!(matches!(
            load("", None).await,
            Err(OpdsError::InvalidUrl { .. })
        ));
    }

    // ---- live catalogs: `cargo test live_ -- --ignored` ------------------------------------

    #[tokio::test]
    #[ignore]
    async fn live_gutenberg_and_opds2_reference_catalog() {
        let g = feed_of(
            load("https://www.gutenberg.org/ebooks.opds/", None)
                .await
                .unwrap(),
        );
        assert!(g.navigation.len() >= 3);
        let search_ref = g.search.expect("gutenberg advertises search");
        let results = feed_of(opds_search_inner(search_ref, "dracula").await);
        assert!(results
            .navigation
            .iter()
            .any(|n| n.title.contains("Dracula")));
        let o2 = feed_of(
            load("https://test.opds.io/2.0/publications.json", None)
                .await
                .unwrap(),
        );
        assert_eq!(o2.entries.len(), 14);
        assert_eq!(
            o2.entries.iter().filter(|e| e.primary.is_some()).count(),
            10
        );
    }

    async fn opds_search_inner(
        search_ref: theorem_core::opds::model::SearchRef,
        q: &str,
    ) -> Loaded {
        let req = SearchRequest {
            href: search_ref.href,
            kind: search_ref.kind,
        };
        let template = match req.kind {
            SearchKind::Template => req.href,
            SearchKind::Description => match load(&req.href, None).await.unwrap().outcome {
                Outcome::OpenSearch { templates } => templates[0].template.clone(),
                o => panic!("{o:?}"),
            },
        };
        load(&search::expand(&template, q), None).await.unwrap()
    }

    #[test]
    fn www_authenticate_is_parsed() {
        assert_eq!(
            parse_www_authenticate("Basic realm=\"Library\""),
            (Some("Basic".into()), Some("Library".into()))
        );
        assert_eq!(
            parse_www_authenticate("Bearer"),
            (Some("Bearer".into()), None)
        );
    }
}
