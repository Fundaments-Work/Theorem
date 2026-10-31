//! HTTP fetches for feeds, article pages and binary downloads.

//! Failures are `Network` errors (`Internal` when the HTTP client cannot be
//! built, `InvalidInput` for a malformed URL); the messages are unchanged.

use crate::error::AppError;
use crate::shared_http_client;
use tauri::ipc::Response;

pub(crate) fn fetch_rss_feed(url: String) -> Result<String, AppError> {
    let response = shared_http_client()?
        .get(&url)
        .timeout(std::time::Duration::from_secs(30))
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .header("Accept", "application/atom+xml;profile=opds-catalog, application/atom+xml, application/rss+xml, application/xml, text/xml, */*")
        .send()
        .map_err(|e| AppError::network(format!("Failed to fetch feed: {}", e)))?;

    if !response.status().is_success() {
        return Err(AppError::network(format!(
            "HTTP error: {} {}",
            response.status(),
            response.status().canonical_reason().unwrap_or("Unknown")
        )));
    }

    response
        .text()
        .map_err(|e| AppError::network(format!("Failed to read response: {}", e)))
}

pub(crate) fn fetch_url_content(url: String) -> Result<String, AppError> {
    let parsed_url = reqwest::Url::parse(&url)
        .map_err(|e| AppError::invalid_input(format!("Invalid URL '{}': {}", url, e)))?;
    let referer = {
        let mut origin = parsed_url.clone();
        origin.set_path("/");
        origin.set_query(None);
        origin.set_fragment(None);
        origin.to_string()
    };

    let user_agents = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:134.0) Gecko/20100101 Firefox/134.0",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
    ];

    let client = shared_http_client()?;
    let mut last_error: Option<String> = None;
    for (attempt, user_agent) in user_agents.iter().enumerate() {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(150));
        }

        let response = client
            .get(parsed_url.clone())
            .timeout(std::time::Duration::from_secs(8))
            .header("User-Agent", *user_agent)
            .header(
                "Accept",
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            )
            .header("Accept-Language", "en-US,en;q=0.9")
            .header("Referer", &referer)
            .header("Upgrade-Insecure-Requests", "1")
            .header("DNT", "1")
            .send();

        let response = match response {
            Ok(response) => response,
            Err(error) => {
                last_error = Some(format!("Failed to fetch URL content: {}", error));
                continue;
            }
        };

        if response.status().is_success() {
            return response
                .text()
                .map_err(|e| AppError::network(format!("Failed to read response: {}", e)));
        }

        let status = response.status();
        let status_code = status.as_u16();

        if status_code == 429 || status_code == 403 {
            if status_code == 429 {
                let retry_after = response
                    .headers()
                    .get("Retry-After")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(3)
                    .clamp(2, 8);
                std::thread::sleep(std::time::Duration::from_secs(retry_after));
            }
            last_error = Some(format!(
                "HTTP error: {} {}",
                status,
                status.canonical_reason().unwrap_or(if status_code == 429 {
                    "Too Many Requests"
                } else {
                    "Forbidden"
                })
            ));
            continue;
        }

        return Err(AppError::network(format!(
            "HTTP error: {} {}",
            status,
            status.canonical_reason().unwrap_or("Unknown")
        )));
    }

    Err(AppError::network(last_error.unwrap_or_else(|| {
        "Failed to fetch URL content".to_string()
    })))
}

pub(crate) fn fetch_binary_content(url: String) -> Result<Response, AppError> {
    let parsed_url = reqwest::Url::parse(&url)
        .map_err(|e| AppError::invalid_input(format!("Invalid URL '{}': {}", url, e)))?;
    let referer = {
        let mut origin = parsed_url.clone();
        origin.set_path("/");
        origin.set_query(None);
        origin.set_fragment(None);
        origin.to_string()
    };

    let response = shared_http_client()?
        .get(parsed_url)
        .timeout(std::time::Duration::from_secs(90))
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
        )
        .header("Accept", "application/pdf,application/octet-stream,*/*")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Referer", &referer)
        .send()
        .map_err(|e| AppError::network(format!("Failed to fetch binary content: {}", e)))?;

    if !response.status().is_success() {
        return Err(AppError::network(format!(
            "HTTP error: {} {}",
            response.status(),
            response.status().canonical_reason().unwrap_or("Unknown")
        )));
    }

    let bytes = response
        .bytes()
        .map_err(|e| AppError::network(format!("Failed to read binary response: {}", e)))?;
    Ok(Response::new(bytes.to_vec()))
}

/// Fetch cover bytes outside WebView CORS, then validate and normalize in Rust.
pub(crate) fn fetch_cover_image(url: String) -> Result<Box<str>, AppError> {
    use std::io::Read;
    let parsed = reqwest::Url::parse(&url)
        .map_err(|_| AppError::invalid_input("Enter a complete HTTP or HTTPS image URL"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::invalid_input(
            "Only HTTP and HTTPS image URLs are supported",
        ));
    }
    let referer = format!("{}/", parsed.origin().ascii_serialization());
    let response = shared_http_client()?
        .get(parsed)
        .timeout(std::time::Duration::from_secs(30))
        .header("User-Agent", crate::http::BROWSER_USER_AGENT)
        .header("Referer", referer)
        .header("Accept", "image/*")
        .send()
        .map_err(|e| AppError::network(format!("Could not download cover: {e}")))?;
    if !response.status().is_success() {
        return Err(AppError::network(format!(
            "Cover download returned HTTP {}",
            response.status()
        )));
    }
    let mut bytes = Vec::new();
    response
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| AppError::network(format!("Could not read cover: {e}")))?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(AppError::invalid_input("Cover image must be at most 8 MB"));
    }
    crate::batch_ingest::downsample_cover_to_data_url(&bytes)
        .map(String::into_boxed_str)
        .ok_or_else(|| AppError::invalid_input("URL did not return a supported image"))
}

#[cfg(test)]
mod cover_download_tests {
    use super::*;
    use crate::error::ErrorKind;
    use std::io::{Read, Write};

    fn serve(status: u16, body: Vec<u8>) -> (String, std::thread::JoinHandle<()>) {
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let task = std::thread::spawn(move || {
            let (mut socket, _) = server.accept().unwrap();
            let mut request = [0; 4096];
            let _ = socket.read(&mut request);
            let header = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            let _ = socket.write_all(header.as_bytes());
            let _ = socket.write_all(&body);
        });
        (format!("http://{address}/cover"), task)
    }

    #[test]
    fn downloads_and_decodes_image_without_cors_or_image_content_type() {
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 3)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let (url, task) = serve(200, png.into_inner());
        let cover = fetch_cover_image(url).unwrap();
        task.join().unwrap();
        assert!(cover.starts_with("data:image/jpeg;base64,"));
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(cover.split_once(',').unwrap().1)
            .unwrap();
        assert_eq!(image::load_from_memory(&bytes).unwrap().width(), 2);
    }

    #[test]
    fn rejects_non_http_schemes_and_bad_responses() {
        for url in ["javascript:alert(1)", "file:///tmp/cover.png", "not a url"] {
            assert_eq!(
                fetch_cover_image(url.into()).unwrap_err().kind(),
                ErrorKind::InvalidInput
            );
        }
        for (status, body, kind) in [
            (
                200,
                b"<html>not a cover</html>".to_vec(),
                ErrorKind::InvalidInput,
            ),
            (404, Vec::new(), ErrorKind::Network),
            (200, vec![0; 8 * 1024 * 1024 + 1], ErrorKind::InvalidInput),
        ] {
            let (url, task) = serve(status, body);
            assert_eq!(fetch_cover_image(url).unwrap_err().kind(), kind);
            task.join().unwrap();
        }
    }
}
