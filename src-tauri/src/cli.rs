//! Headless CLI dispatch (`theorem <subcommand>`).
//!
//! When the `theorem` binary is invoked with a recognized subcommand, it runs
//! the matching native engine directly and exits without creating windows.
//! Any other invocation (including file-open paths) falls through to the GUI.
//!
//! The engines and the SQLite pool resolve paths through an `AppHandle`, so the
//! CLI builds a bare Tauri app context (no plugins, no windows) purely for path
//! resolution, reusing the exact same app-data directory as the GUI.

use std::future::Future;
use std::io::Write as _;
use std::path::PathBuf;

const CLI_SUBCOMMANDS: &[&str] = &[
    "search",
    "read",
    "dict",
    "extract",
    "library",
    "highlights",
    "setup-cli",
    "help",
    "version",
];

/// Dispatch CLI subcommands. Returns `None` when the invocation should launch
/// the GUI (no args, unknown command, or a file path passed by the desktop).
pub fn maybe_dispatch(args: &[String]) -> Option<i32> {
    let first = args.first()?;
    if !CLI_SUBCOMMANDS.contains(&first.as_str()) {
        return None;
    }
    Some(run(args))
}

fn run(args: &[String]) -> i32 {
    match args[0].as_str() {
        "help" | "--help" | "-h" => {
            print_help();
            0
        }
        "version" | "--version" | "-V" => {
            println!("theorem {}", env!("CARGO_PKG_VERSION"));
            0
        }
        "setup-cli" => run_setup_cli(),
        "dict" => with_app(|app| run_dict(app, &args[1..])),
        "search" => with_app(|app| run_search(app, &args[1..])),
        "library" => with_app(|app| run_library(app, &args[1..])),
        "highlights" => with_app(|app| run_highlights(app, &args[1..])),
        "read" => with_app(|app| run_read(app, &args[1..])),
        "extract" => run_extract(&args[1..]),
        other => {
            eprintln!("error: unknown subcommand '{other}'");
            print_help();
            2
        }
    }
}

fn print_help() {
    println!(
        "Theorem CLI {}\n\n\
USAGE:\n    \
theorem <SUBCOMMAND>\n\n\
SUBCOMMANDS:\n    \
search \"query\"              Full-text search across the library (FTS5)\n    \
search <book-id> \"query\"   Streaming in-book search\n    \
read <book-id> [--chapter N]  Stream an EPUB chapter as plain text\n    \
dict \"term\"                Instant StarDict definition\n    \
extract <url>               Fetch a web page and print the clean article\n    \
library list [--format json]  List library books with metadata\n    \
highlights list [--book <id>]  Print annotations as JSON\n    \
setup-cli                   Symlink the executable into ~/.local/bin\n\n\
Run `theorem` with no arguments to launch the GUI.",
        env!("CARGO_PKG_VERSION")
    );
}

/// Build a bare Tauri app context so engine code can resolve app-data paths
/// exactly like the GUI does. No plugins are registered and no event loop runs.
fn headless_app() -> Result<tauri::App, String> {
    tauri::Builder::default()
        .build(tauri::generate_context!())
        .map_err(|e| format!("Failed to initialize app context: {e}"))
}

fn with_app(f: impl FnOnce(&tauri::AppHandle) -> i32) -> i32 {
    match headless_app() {
        Ok(app) => {
            let handle = app.handle().clone();
            let code = f(&handle);
            app.cleanup_before_exit();
            code
        }
        Err(err) => {
            eprintln!("error: {err}");
            1
        }
    }
}

fn block_on<T: Send + 'static>(future: impl Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("failed to build async runtime")
        .block_on(future)
}

// ── dict ─────────────────────────────────────────────────────────────────────

fn run_dict(app: &tauri::AppHandle, args: &[String]) -> i32 {
    let Some(term) = args.first() else {
        eprintln!("usage: theorem dict \"term\"");
        return 2;
    };

    let started = std::time::Instant::now();
    let results = crate::stardict::lookup_all_installed(app, term);
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;

    match serde_json::to_string_pretty(&results) {
        Ok(json) => {
            println!("{json}");
            eprintln!(
                "# {}/{} dictionaries, {:.2}ms",
                term,
                results.len(),
                elapsed
            );
            0
        }
        Err(e) => {
            eprintln!("error: {e}");
            1
        }
    }
}

// ── search ───────────────────────────────────────────────────────────────────

fn run_search(app: &tauri::AppHandle, args: &[String]) -> i32 {
    match args.len() {
        1 => library_search(app, &args[0]),
        2 => in_book_search(app, &args[0], &args[1]),
        _ => {
            eprintln!("usage: theorem search \"query\"  |  theorem search <book-id> \"query\"");
            2
        }
    }
}

fn library_search(app: &tauri::AppHandle, query: &str) -> i32 {
    match crate::database::with_connection(app, |conn| {
        crate::database::sqlite_search_books_inner(conn, query, 50)
    }) {
        Ok(rows) => match serde_json::to_string_pretty(&rows) {
            Ok(json) => {
                println!("{json}");
                0
            }
            Err(e) => {
                eprintln!("error: {e}");
                1
            }
        },
        Err(e) => {
            eprintln!("error: {e}");
            1
        }
    }
}

fn in_book_search(app: &tauri::AppHandle, book_id: &str, query: &str) -> i32 {
    let path = match resolve_book_path(app, book_id) {
        Ok(Some(path)) => path,
        Ok(None) => {
            eprintln!("error: book '{book_id}' not found in library");
            return 1;
        }
        Err(e) => {
            eprintln!("error: {e}");
            return 1;
        }
    };

    let result = crate::book_search::search_epub_spine(&path, query, false);
    match result {
        Ok(matches) => match serde_json::to_string_pretty(&matches) {
            Ok(json) => {
                println!("{json}");
                0
            }
            Err(e) => {
                eprintln!("error: {e}");
                1
            }
        },
        Err(e) => {
            eprintln!("error: {e}");
            1
        }
    }
}

fn resolve_book_path(app: &tauri::AppHandle, book_id: &str) -> Result<Option<PathBuf>, String> {
    crate::database::sqlite_get_materialized_book_path(app.clone(), book_id.to_string())
        .map(|opt| opt.map(PathBuf::from))
}

// ── library ──────────────────────────────────────────────────────────────────

fn run_library(app: &tauri::AppHandle, args: &[String]) -> i32 {
    if args.first().map(String::as_str) != Some("list") {
        eprintln!("usage: theorem library list [--format json|table]");
        return 2;
    }
    let format = args
        .iter()
        .position(|a| a == "--format")
        .and_then(|i| args.get(i + 1))
        .cloned()
        .unwrap_or_else(|| "table".to_string());

    let rows: Vec<(String, String)> = match crate::database::with_connection(app, |conn| {
        let mut stmt = conn.prepare(
            "SELECT bm.book_id, bm.metadata_json FROM book_metadata bm \
             JOIN books b ON b.id = bm.book_id ORDER BY bm.book_id",
        )?;
        let mapped = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        mapped.collect::<rusqlite::Result<Vec<_>>>()
    }) {
        Ok(rows) => rows,
        Err(e) => {
            eprintln!("error: {e}");
            return 1;
        }
    };

    match format.as_str() {
        "json" => {
            let items: Vec<serde_json::Value> = rows
                .into_iter()
                .map(|(id, metadata_json)| {
                    let mut value = serde_json::json!({ "id": id });
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&metadata_json) {
                        if let Some(title) = parsed.get("title") {
                            value["title"] = title.clone();
                        }
                        if let Some(author) = parsed.get("author") {
                            value["author"] = author.clone();
                        }
                        value["metadata"] = parsed;
                    }
                    value
                })
                .collect();
            match serde_json::to_string_pretty(&items) {
                Ok(json) => {
                    println!("{json}");
                    0
                }
                Err(e) => {
                    eprintln!("error: {e}");
                    1
                }
            }
        }
        _ => {
            for (id, metadata_json) in &rows {
                let title = serde_json::from_str::<serde_json::Value>(metadata_json)
                    .ok()
                    .and_then(|v| v.get("title").and_then(|t| t.as_str()).map(String::from))
                    .unwrap_or_else(|| "(untitled)".to_string());
                println!("{id}\t{title}");
            }
            eprintln!("# {} books", rows.len());
            0
        }
    }
}

// ── highlights ───────────────────────────────────────────────────────────────

fn run_highlights(app: &tauri::AppHandle, args: &[String]) -> i32 {
    if args.first().map(String::as_str) != Some("list") {
        eprintln!("usage: theorem highlights list [--book <id>]");
        return 2;
    }
    let book_filter = args
        .iter()
        .position(|a| a == "--book")
        .and_then(|i| args.get(i + 1))
        .cloned();

    let annotations: Vec<(String, String)> = match crate::database::with_connection(app, |conn| {
        let mut stmt = conn.prepare(
            "SELECT book_id, annotation_json FROM book_annotations \
                 WHERE (?1 IS NULL OR book_id = ?1) ORDER BY book_id, updated_at",
        )?;
        let mapped = stmt.query_map(rusqlite::params![book_filter], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        mapped.collect::<rusqlite::Result<Vec<_>>>()
    }) {
        Ok(rows) => rows,
        Err(e) => {
            eprintln!("error: {e}");
            return 1;
        }
    };

    let items: Vec<serde_json::Value> = annotations
        .into_iter()
        .filter_map(|(book_id, json)| {
            serde_json::from_str::<serde_json::Value>(&json)
                .ok()
                .map(|mut v| {
                    v["bookId"] = serde_json::Value::String(book_id);
                    v
                })
        })
        .collect();
    match serde_json::to_string_pretty(&items) {
        Ok(json) => {
            println!("{json}");
            0
        }
        Err(e) => {
            eprintln!("error: {e}");
            1
        }
    }
}

// ── read ─────────────────────────────────────────────────────────────────────

fn run_read(app: &tauri::AppHandle, args: &[String]) -> i32 {
    let Some(book_id) = args.first() else {
        eprintln!("usage: theorem read <book-id> [--chapter N]");
        return 2;
    };
    let chapter = args
        .iter()
        .position(|a| a == "--chapter")
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(1)
        .max(1);

    let path = match resolve_book_path(app, book_id) {
        Ok(Some(path)) => path,
        Ok(None) => {
            eprintln!("error: book '{book_id}' not found in library");
            return 1;
        }
        Err(e) => {
            eprintln!("error: {e}");
            return 1;
        }
    };

    match read_epub_chapter(&path, chapter) {
        Ok(text) => {
            let stdout = std::io::stdout();
            let mut out = stdout.lock();
            let _ = out.write_all(text.as_bytes());
            let _ = out.write_all(b"\n");
            0
        }
        Err(e) => {
            eprintln!("error: {e}");
            1
        }
    }
}

/// Extract the plain text of an EPUB spine chapter in spine order.
/// The materialized cache file has no extension, so the format is sniffed
/// from the file magic instead.
fn read_epub_chapter(path: &PathBuf, chapter: usize) -> Result<String, String> {
    let mut magic = [0u8; 4];
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    std::io::Read::read_exact(&mut file, &mut magic)
        .map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    drop(file);

    if &magic != b"PK\x03\x04" {
        return Err(format!(
            "read currently supports EPUB files only ({})",
            path.display()
        ));
    }

    let file =
        std::fs::File::open(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Not a valid zip: {e}"))?;

    let opf_path = crate::epub_parser::read_rootfile_path_inner(&mut archive)
        .ok_or("Missing OPF rootfile in META-INF/container.xml")?;
    let opf = crate::epub_parser::read_zip_entry_inner(&mut archive, &opf_path)
        .ok_or_else(|| format!("Missing OPF file: {opf_path}"))?;

    let spine_hrefs = parse_spine_order(&opf);

    let index = chapter - 1;
    let href = spine_hrefs.get(index).ok_or_else(|| {
        format!(
            "Chapter {chapter} out of range (book has {} chapters)",
            spine_hrefs.len()
        )
    })?;

    let section_path = crate::epub_parser::resolve_relative(&opf_path, href);
    let html = crate::epub_parser::read_zip_entry_inner(&mut archive, &section_path)
        .ok_or_else(|| format!("Missing chapter file: {section_path}"))?;

    Ok(crate::book_search::html_to_plain_text(&html))
}

/// Minimal OPF scan: manifest id→href map + ordered spine hrefs.
/// Minimal OPF scan: returns chapter hrefs in spine order.
fn parse_spine_order(opf: &str) -> Vec<String> {
    use quick_xml::events::Event;

    let mut manifest_hrefs: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let mut spine_ids: Vec<String> = Vec::new();

    let mut reader = quick_xml::Reader::from_str(opf);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let name = e.name().as_ref().to_ascii_lowercase();
                let attrs: std::collections::HashMap<String, String> = e
                    .attributes()
                    .flatten()
                    .map(|a| {
                        let key = String::from_utf8_lossy(a.key.as_ref()).into_owned();
                        let value = a
                            .unescape_value()
                            .map(|v| v.into_owned())
                            .unwrap_or_default();
                        (key, value)
                    })
                    .collect();
                match name.as_slice() {
                    b"item" => {
                        if let (Some(id), Some(href)) = (attrs.get("id"), attrs.get("href")) {
                            manifest_hrefs.insert(id.clone(), href.clone());
                        }
                    }
                    b"itemref" => {
                        if let Some(idref) = attrs.get("idref") {
                            spine_ids.push(idref.clone());
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    spine_ids
        .iter()
        .filter_map(|id| manifest_hrefs.get(id).cloned())
        .collect()
}

// ── extract ──────────────────────────────────────────────────────────────────

fn run_extract(args: &[String]) -> i32 {
    let Some(url) = args.first() else {
        eprintln!("usage: theorem extract <url>");
        return 2;
    };

    let article = match block_on(crate::article_extractor::fetch_and_extract_article_native(
        url.clone(),
    )) {
        Ok(article) => article,
        Err(e) => {
            eprintln!("error: {e}");
            return 1;
        }
    };

    println!("# {}", article.title);
    if let Some(byline) = &article.byline {
        println!("*by {byline}*");
    }
    println!();
    match &article.text_content {
        Some(text) => print!("{text}"),
        None => print!("{}", article.content),
    }
    0
}

// ── setup-cli ────────────────────────────────────────────────────────────────

fn run_setup_cli() -> i32 {
    match setup_linux_cli_symlink_inner() {
        Ok(link) => {
            println!("CLI enabled: {link}");
            0
        }
        Err(e) => {
            eprintln!("error: {e}");
            1
        }
    }
}

/// Tauri command backing the Settings → Devices & Export "Enable CLI" toggle.
#[tauri::command]
pub fn setup_linux_cli_symlink() -> Result<String, String> {
    setup_linux_cli_symlink_inner()
}

pub fn setup_linux_cli_symlink_inner() -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        let exe = std::env::current_exe()
            .map_err(|e| format!("Failed to resolve executable path: {e}"))?;
        let home = std::env::var("HOME").map_err(|_| "HOME environment variable not set")?;
        let bin_dir = PathBuf::from(home).join(".local").join("bin");
        std::fs::create_dir_all(&bin_dir)
            .map_err(|e| format!("Failed to create {}: {e}", bin_dir.display()))?;
        let link = bin_dir.join("theorem");

        match std::fs::symlink_metadata(&link) {
            Ok(meta) if meta.file_type().is_symlink() => {
                let _ = std::fs::remove_file(&link);
            }
            Ok(_) => {
                let link_target = std::fs::canonicalize(&link).ok();
                let exe_target = std::fs::canonicalize(&exe).ok();
                if link_target.is_some() && link_target == exe_target {
                    return Ok(link.display().to_string());
                }
                return Err(format!(
                    "Refusing to overwrite existing file {} (not a Theorem symlink)",
                    link.display()
                ));
            }
            Err(_) => {}
        }

        std::os::unix::fs::symlink(&exe, &link).map_err(|e| {
            format!(
                "Failed to symlink {} -> {}: {e}",
                link.display(),
                exe.display()
            )
        })?;
        Ok(link.display().to_string())
    }

    #[cfg(not(target_os = "linux"))]
    {
        Err("CLI symlink setup is only supported on Linux".to_string())
    }
}
