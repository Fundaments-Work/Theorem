//! `theorem opds`: browse and download from catalogs.

use super::*;

#[derive(Subcommand)]
pub(super) enum OpdsCommand {
    /// Browse an OPDS catalog feed (lists entries or navigation links)
    Browse { url: String },
    /// Download an entry from a catalog and import it into the library
    Download {
        /// Catalog feed URL
        url: String,
        /// Entry title (or index shown by `opds browse`)
        entry: String,
    },
}

pub(super) fn run_opds(output: &Output, ctx: &Ctx, command: OpdsCommand) -> i32 {
    match command {
        OpdsCommand::Browse { url } => opds_browse(output, &url),
        OpdsCommand::Download { url, entry } => opds_download(output, ctx, &url, &entry),
    }
}

fn opds_load_feed(output: &Output, url: &str) -> Result<theorem_core::opds::model::Feed, i32> {
    use theorem_core::opds::model::Outcome;
    match block_on(|| crate::opds_net::load(url, None)) {
        Ok(loaded) => match loaded.outcome {
            Outcome::Feed { feed } => Ok(*feed),
            Outcome::Unsupported { reason } => Err(output.error(&reason)),
            Outcome::Authentication { title, .. } => Err(output.error(&format!(
                "{title}: this catalog requires a sign-in, which the CLI does not support yet"
            ))),
            _ => Err(output.error("the address did not return a catalog")),
        },
        Err(e) => {
            output.error(&e.to_string());
            Err(opds_error_code(&e))
        }
    }
}

fn opds_browse(output: &Output, url: &str) -> i32 {
    let feed = match opds_load_feed(output, url) {
        Ok(feed) => feed,
        Err(code) => return code,
    };

    if output.json {
        return output.print_json(&feed);
    }
    println!("{}", output.bold(&feed.title));
    let mut index = 0;
    for nav in &feed.navigation {
        index += 1;
        println!(
            "{}  {} {}",
            output.dim(&format!("{index:>3}")),
            output.bold(&nav.title),
            output.dim("[nav]")
        );
    }
    for entry in &feed.entries {
        index += 1;
        let by = if entry.authors.is_empty() {
            String::new()
        } else {
            format!(" by {}", entry.authors.join(", "))
        };
        let kind = if entry.primary.is_some() {
            "book"
        } else {
            "info"
        };
        println!(
            "{}  {} {}",
            output.dim(&format!("{index:>3}")),
            output.bold(&entry.title),
            output.dim(&format!("[{kind}]{by}"))
        );
    }
    output.note(&format!(
        "# {} navigation links, {} books",
        feed.navigation.len(),
        feed.entries.len()
    ));
    0
}

fn opds_download(output: &Output, ctx: &Ctx, url: &str, entry_selector: &str) -> i32 {
    let feed = match opds_load_feed(output, url) {
        Ok(feed) => feed,
        Err(code) => return code,
    };

    // Numbering matches `opds browse`: navigation links first, then books.
    let nav_count = feed.navigation.len();
    let entry = match entry_selector.parse::<usize>() {
        Ok(index) if index > nav_count && index - nav_count <= feed.entries.len() => {
            Some(&feed.entries[index - nav_count - 1])
        }
        Ok(_) => None,
        Err(_) => feed.entries.iter().find(|e| {
            e.title
                .to_lowercase()
                .contains(&entry_selector.to_lowercase())
        }),
    };
    let Some(entry) = entry else {
        return output.error(AppError::not_found(format!(
            "entry '{entry_selector}' not found among the catalog's books"
        )));
    };
    let Some(acquisition) = entry.primary.and_then(|i| entry.acquisitions.get(i)) else {
        return output.error(&format!(
            "entry '{}' has no direct download (borrow, purchase or DRM-protected)",
            entry.title
        ));
    };
    let download_url = acquisition.href.to_string();

    output.note(&format!("downloading '{}'...", entry.title));
    // The app's download path: size cap, refuses login/"buy" pages served
    // instead of a book, names the file by its real type.
    let downloaded = match block_on(|| crate::opds_net::download(&download_url, None, |_, _| {})) {
        Ok(file) => file,
        Err(e) => {
            output.error(&e.to_string());
            return opds_error_code(&e);
        }
    };
    let path = std::path::PathBuf::from(&downloaded.path);
    let code = ingest_and_register(output, ctx, std::slice::from_ref(&downloaded.path));
    // The library has its own copy now; remove the download folder.
    if let Some(dir) = path.parent() {
        if dir.starts_with(std::env::temp_dir().join("theorem-opds")) {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
    code
}

/// The exit code for a catalog error: 4 when the network failed.
fn opds_error_code(e: &crate::opds_net::OpdsError) -> i32 {
    use crate::opds_net::OpdsError;
    match e {
        OpdsError::Network { .. } | OpdsError::Timeout | OpdsError::Http { .. } => EXIT_NETWORK,
        OpdsError::NotFound => EXIT_NOT_FOUND,
        _ => 1,
    }
}
