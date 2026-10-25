//! HTTP fetches for feeds, article pages and binary downloads.

use crate::shared_http_client;
use tauri::ipc::Response;

pub(crate) fn fetch_rss_feed(url: String) -> Result<String, String> {
    let response = shared_http_client()?
        .get(&url)
        .timeout(std::time::Duration::from_secs(30))
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .header("Accept", "application/atom+xml;profile=opds-catalog, application/atom+xml, application/rss+xml, application/xml, text/xml, */*")
        .send()
        .map_err(|e| format!("Failed to fetch feed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "HTTP error: {} {}",
            response.status(),
            response.status().canonical_reason().unwrap_or("Unknown")
        ));
    }

    response
        .text()
        .map_err(|e| format!("Failed to read response: {}", e))
}

pub(crate) fn fetch_url_content(url: String) -> Result<String, String> {
    let parsed_url =
        reqwest::Url::parse(&url).map_err(|e| format!("Invalid URL '{}': {}", url, e))?;
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
                .map_err(|e| format!("Failed to read response: {}", e));
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

        return Err(format!(
            "HTTP error: {} {}",
            status,
            status.canonical_reason().unwrap_or("Unknown")
        ));
    }

    Err(last_error.unwrap_or_else(|| "Failed to fetch URL content".to_string()))
}

pub(crate) fn fetch_binary_content(url: String) -> Result<Response, String> {
    let parsed_url =
        reqwest::Url::parse(&url).map_err(|e| format!("Invalid URL '{}': {}", url, e))?;
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
        .map_err(|e| format!("Failed to fetch binary content: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "HTTP error: {} {}",
            response.status(),
            response.status().canonical_reason().unwrap_or("Unknown")
        ));
    }

    let bytes = response
        .bytes()
        .map_err(|e| format!("Failed to read binary response: {}", e))?;
    Ok(Response::new(bytes.to_vec()))
}
