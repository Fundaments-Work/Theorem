//! The app's HTTP clients: one pooled client per kind of use, built once.
//!
//! Every client was once built per request (or per module), which threw away
//! connection pools and TLS sessions and let timeouts and user agents drift.
//! Clients carry only settings that suit every request of their kind; a
//! request that needs a different deadline or user agent sets it on the
//! request (`RequestBuilder::timeout`, a `User-Agent` header), which wins over
//! the client default.
//!
//! Building a client can fail (no usable TLS backend). That is returned to
//! the caller as an error, never a panic, and remembered, so each request
//! does not retry the build.

use futures::StreamExt;
use std::io::Read;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::OnceLock;
use std::time::Duration;

/// A desktop browser's user agent, for sites that refuse unknown clients
/// (article pages, feeds, dictionary downloads).
pub(crate) const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

/// Theorem's own user agent, for services that should know who is asking
/// (catalogs, feeds, the dictionary API, model downloads).
pub(crate) const THEOREM_USER_AGENT: &str = concat!(
    "Theorem/",
    env!("CARGO_PKG_VERSION"),
    " (+https://theorem.fundaments.work)"
);

/// Time to establish a connection, for every client.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Redirects followed before giving up, for every client.
const MAX_REDIRECTS: usize = 10;
/// Whole-request deadline of the blocking client (requests may set a shorter one).
const BLOCKING_TIMEOUT: Duration = Duration::from_secs(60);

fn is_ipv4_private_or_local(ip: Ipv4Addr) -> bool {
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
}

fn is_ipv6_link_local(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xffc0) == 0xfe80
}

fn is_ipv6_private_or_local(ip: Ipv6Addr) -> bool {
    let segs = ip.segments();
    ip.is_loopback()
        || ip.is_unspecified()
        || is_ipv6_link_local(ip)
        || (segs[0] & 0xfe00) == 0xfc00
        || ip.to_ipv4_mapped().is_some_and(is_ipv4_private_or_local)
}

fn is_metadata_or_unspecified_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => v4.is_link_local() || v4.is_unspecified(),
        std::net::IpAddr::V6(v6) => {
            let segs = v6.segments();
            v6.is_unspecified()
                || is_ipv6_link_local(v6)
                || (segs[0] == 0xfd00 && segs[1] == 0x0ec2)
                || v6
                    .to_ipv4_mapped()
                    .is_some_and(|v4| v4.is_link_local() || v4.is_unspecified())
        }
    }
}

fn is_private_or_local_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => is_ipv4_private_or_local(v4),
        std::net::IpAddr::V6(v6) => is_ipv6_private_or_local(v6),
    }
}

fn is_local_domain(domain: &str) -> bool {
    let lower = domain.to_ascii_lowercase();
    lower == "localhost"
        || lower.ends_with(".localhost")
        || lower.ends_with(".local")
        || lower.ends_with(".internal")
}

fn is_metadata_or_unspecified_url(url: &reqwest::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(domain)) => {
            domain.eq_ignore_ascii_case("metadata.google.internal")
                || domain.eq_ignore_ascii_case("metadata.goog")
        }
        Some(url::Host::Ipv4(ip)) => is_metadata_or_unspecified_ip(std::net::IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => is_metadata_or_unspecified_ip(std::net::IpAddr::V6(ip)),
        None => true,
    }
}

fn is_local_or_private_url(url: &reqwest::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(domain)) => is_local_domain(domain),
        Some(url::Host::Ipv4(ip)) => is_ipv4_private_or_local(ip),
        Some(url::Host::Ipv6(ip)) => is_ipv6_private_or_local(ip),
        None => true,
    }
}

#[derive(Debug, Clone, Default)]
struct SafeDnsResolver;

impl reqwest::dns::Resolve for SafeDnsResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let local_domain = is_local_domain(&host);
            let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host.as_str(), 0))
                .await
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?
                .filter(|addr| {
                    let ip = addr.ip();
                    if is_metadata_or_unspecified_ip(ip) {
                        return false;
                    }
                    if !local_domain && is_private_or_local_ip(ip) {
                        return false;
                    }
                    true
                })
                .collect();
            if addrs.is_empty() {
                return Err(Box::new(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "Blocked resolution to restricted or private IP address",
                ))
                    as Box<dyn std::error::Error + Send + Sync>);
            }
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

pub(crate) fn validate_http_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|e| format!("Invalid URL '{}': {e}", url.trim()))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!(
            "Only http and https URLs are supported (got {}:)",
            parsed.scheme()
        ));
    }
    if is_metadata_or_unspecified_url(&parsed) {
        return Err("Refused request to restricted host address".to_string());
    }
    Ok(parsed)
}

fn safe_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() > MAX_REDIRECTS {
            return attempt.error("Too many redirects");
        }
        if !matches!(attempt.url().scheme(), "http" | "https") {
            return attempt.error("Blocked redirect to unsupported URL scheme");
        }
        if is_metadata_or_unspecified_url(attempt.url()) {
            return attempt.error("Blocked redirect to restricted host address");
        }
        let started_local = attempt
            .previous()
            .first()
            .is_some_and(is_local_or_private_url);
        if !started_local && is_local_or_private_url(attempt.url()) {
            return attempt.error("Blocked redirect from public origin to private address");
        }
        attempt.follow()
    })
}

pub(crate) async fn read_response_bytes_bounded(
    resp: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    if let Some(len) = resp.content_length() {
        if len > max_bytes as u64 {
            return Err(format!(
                "Response exceeds maximum allowed size ({max_bytes} bytes)"
            ));
        }
    }
    let mut body = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Failed to read response stream: {e}"))?;
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return Err(format!(
                "Response exceeds maximum allowed size ({max_bytes} bytes)"
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

pub(crate) async fn read_response_text_bounded(
    resp: reqwest::Response,
    max_bytes: usize,
) -> Result<String, String> {
    let bytes = read_response_bytes_bounded(resp, max_bytes).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub(crate) fn read_blocking_bytes_bounded(
    resp: reqwest::blocking::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    if let Some(len) = resp.content_length() {
        if len > max_bytes as u64 {
            return Err(format!(
                "Response exceeds maximum allowed size ({max_bytes} bytes)"
            ));
        }
    }
    let mut bytes = Vec::new();
    resp.take((max_bytes as u64).saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read response: {e}"))?;
    if bytes.len() > max_bytes {
        return Err(format!(
            "Response exceeds maximum allowed size ({max_bytes} bytes)"
        ));
    }
    Ok(bytes)
}

pub(crate) fn read_blocking_text_bounded(
    resp: reqwest::blocking::Response,
    max_bytes: usize,
) -> Result<String, String> {
    let bytes = read_blocking_bytes_bounded(resp, max_bytes)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// The TLS setup every client uses: rustls on the ring provider, verifying
/// against the bundled Mozilla roots (webpki-roots), TLS 1.2 and 1.3, and
/// HTTP/1.1 only (HTTP/2 is not compiled in). This is what reqwest 0.12 built
/// itself; reqwest 0.13 would instead verify through the OS trust store
/// (rustls-platform-verifier), which needs JNI set-up on Android, and would
/// fail without a process-wide crypto provider (the CLI and tests have none).
fn tls_config() -> Result<rustls::ClientConfig, String> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(rustls::ALL_VERSIONS)
        .map_err(|e| e.to_string())?
        .with_root_certificates(roots)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(config)
}

fn remember<C>(
    cell: &'static OnceLock<Result<C, String>>,
    kind: &str,
    build: impl FnOnce() -> Result<C, String>,
) -> Result<&'static C, String> {
    cell.get_or_init(|| {
        build().map_err(|e| {
            log::error!("[http] Failed to build the {kind} HTTP client: {e}");
            format!("Could not start the network client: {e}")
        })
    })
    .as_ref()
    .map_err(Clone::clone)
}

/// Short requests: catalogs, feeds, articles, definitions. Theorem's user
/// agent and no cookies. There is no whole-request deadline on the client:
/// every request sets its own (`RequestBuilder::timeout`), because a feed and
/// a streamed book download need very different ones.
pub(crate) fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    remember(&CLIENT, "shared", || {
        reqwest::Client::builder()
            .tls_backend_preconfigured(tls_config()?)
            .user_agent(THEOREM_USER_AGENT)
            .connect_timeout(CONNECT_TIMEOUT)
            .dns_resolver(std::sync::Arc::new(SafeDnsResolver))
            .redirect(safe_redirect_policy())
            .build()
            .map_err(|e| e.to_string())
    })
}

/// Large file downloads (dictionaries, the neural voice): a browser user
/// agent and a cookie store, which some download hosts need across their
/// redirects. Requests set their own (long) deadline.
pub(crate) fn download_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    remember(&CLIENT, "download", || {
        reqwest::Client::builder()
            .tls_backend_preconfigured(tls_config()?)
            .user_agent(BROWSER_USER_AGENT)
            .cookie_store(true)
            .connect_timeout(CONNECT_TIMEOUT)
            .dns_resolver(std::sync::Arc::new(SafeDnsResolver))
            .redirect(safe_redirect_policy())
            .build()
            .map_err(|e| e.to_string())
    })
}

/// The blocking client, for synchronous commands (run off the IPC thread by
/// `offload_commands`) and the CLI. A browser user agent, cookies, and a
/// 60 s deadline unless the request sets another.
pub(crate) fn blocking_client() -> Result<&'static reqwest::blocking::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::blocking::Client, String>> = OnceLock::new();
    remember(&CLIENT, "blocking", || {
        reqwest::blocking::Client::builder()
            .tls_backend_preconfigured(tls_config()?)
            .user_agent(BROWSER_USER_AGENT)
            .cookie_store(true)
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(BLOCKING_TIMEOUT)
            .dns_resolver(std::sync::Arc::new(SafeDnsResolver))
            .redirect(safe_redirect_policy())
            .build()
            .map_err(|e| e.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    /// A one-shot HTTP server that answers 200 and hands back the request's
    /// `User-Agent`.
    fn echo_user_agent_once() -> (String, std::thread::JoinHandle<Option<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (stream, _) = listener.accept().ok()?;
            let mut reader = BufReader::new(stream.try_clone().ok()?);
            let mut user_agent = None;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).ok()? == 0 || line == "\r\n" {
                    break;
                }
                if let Some((name, value)) = line.split_once(':') {
                    if name.eq_ignore_ascii_case("user-agent") {
                        user_agent = Some(value.trim().to_string());
                    }
                }
            }
            let mut stream = stream;
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
            user_agent
        });
        (url, handle)
    }

    #[test]
    fn clients_are_built_once_and_shared() {
        assert!(std::ptr::eq(client().unwrap(), client().unwrap()));
        assert!(std::ptr::eq(
            download_client().unwrap(),
            download_client().unwrap()
        ));
        assert!(std::ptr::eq(
            blocking_client().unwrap(),
            blocking_client().unwrap()
        ));
    }

    #[test]
    fn theorem_user_agent_names_the_running_version() {
        assert!(THEOREM_USER_AGENT.starts_with(&format!("Theorem/{} ", env!("CARGO_PKG_VERSION"))));
    }

    #[tokio::test]
    async fn the_shared_client_sends_theorem_user_agent_unless_a_request_overrides_it() {
        let (url, server) = echo_user_agent_once();
        let response = client().unwrap().get(&url).send().await.unwrap();
        assert!(response.status().is_success());
        assert_eq!(server.join().unwrap().as_deref(), Some(THEOREM_USER_AGENT));

        let (url, server) = echo_user_agent_once();
        client()
            .unwrap()
            .get(&url)
            .header(reqwest::header::USER_AGENT, BROWSER_USER_AGENT)
            .send()
            .await
            .unwrap();
        assert_eq!(server.join().unwrap().as_deref(), Some(BROWSER_USER_AGENT));
    }

    #[test]
    fn the_blocking_client_sends_a_browser_user_agent() {
        let (url, server) = echo_user_agent_once();
        let response = blocking_client().unwrap().get(&url).send().unwrap();
        assert!(response.status().is_success());
        assert_eq!(server.join().unwrap().as_deref(), Some(BROWSER_USER_AGENT));
    }

    #[tokio::test]
    async fn a_request_deadline_applies_on_a_client_without_one() {
        // Accepts but never answers.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let started = std::time::Instant::now();
        let error = client()
            .unwrap()
            .get(&url)
            .timeout(Duration::from_millis(300))
            .send()
            .await
            .unwrap_err();
        assert!(error.is_timeout(), "{error}");
        assert!(started.elapsed() < Duration::from_secs(5));
        drop(listener);
    }

    /// The clients keep reqwest 0.12's TLS: the ring provider (no process-wide
    /// provider needed, as in the CLI and these tests), the bundled roots, TLS
    /// 1.2 allowed and HTTP/1.1 only.
    #[test]
    fn tls_config_is_ring_with_bundled_roots_and_http1() {
        let config = tls_config().expect("TLS config builds without a default provider");
        assert_eq!(config.alpn_protocols, vec![b"http/1.1".to_vec()]);
        assert!(config.enable_sni);
        assert!(config
            .crypto_provider()
            .cipher_suites
            .iter()
            .any(|s| s.version() == &rustls::version::TLS12));
        assert!(client().is_ok());
        assert!(download_client().is_ok());
        assert!(blocking_client().is_ok());
    }
}
