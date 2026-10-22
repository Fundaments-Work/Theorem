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

fn remember<C>(
    cell: &'static OnceLock<Result<C, String>>,
    kind: &str,
    build: impl FnOnce() -> reqwest::Result<C>,
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
            .user_agent(THEOREM_USER_AGENT)
            .connect_timeout(CONNECT_TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(MAX_REDIRECTS))
            .build()
    })
}

/// Large file downloads (dictionaries, the neural voice): a browser user
/// agent and a cookie store, which some download hosts need across their
/// redirects. Requests set their own (long) deadline.
pub(crate) fn download_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    remember(&CLIENT, "download", || {
        reqwest::Client::builder()
            .user_agent(BROWSER_USER_AGENT)
            .cookie_store(true)
            .connect_timeout(CONNECT_TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(MAX_REDIRECTS))
            .build()
    })
}

/// The blocking client, for synchronous commands (run off the IPC thread by
/// `offload_commands`) and the CLI. A browser user agent, cookies, and a
/// 60 s deadline unless the request sets another.
pub(crate) fn blocking_client() -> Result<&'static reqwest::blocking::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::blocking::Client, String>> = OnceLock::new();
    remember(&CLIENT, "blocking", || {
        reqwest::blocking::Client::builder()
            .user_agent(BROWSER_USER_AGENT)
            .cookie_store(true)
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(BLOCKING_TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(MAX_REDIRECTS))
            .build()
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
}
