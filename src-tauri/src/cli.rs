//! Headless CLI (`theorem <subcommand>`).
//!
//! Layered for two kinds of users:
//! - **Agents & scripts**: one-shot subcommands with `--json`, stable exit
//!   codes, TTY detection (no ANSI when piped), and fail-fast errors.
//! - **Humans**: the same commands render colored tables, and `theorem tui`
//!   offers an interactive terminal interface.
//!
//! When the `theorem` binary is invoked with a recognized subcommand, it runs
//! the matching native engine directly and exits without creating windows.
//! Any other invocation (including file-open paths) falls through to the GUI.
//!
//! The engines and the SQLite pool resolve paths through an `AppHandle`, so the
//! CLI builds a bare Tauri app context (no plugins, no windows) purely for path
//! resolution, reusing the exact same app-data directory as the GUI.
//!
//! This module is desktop-only: on Android the GUI is the only surface, and
//! keeping the CLI out of the build preserves the 0 MB APK footprint.

use std::future::Future;
use std::io::{IsTerminal, Write as _};
use std::path::PathBuf;

use clap::{Parser, Subcommand};
use serde::Serialize;

// ── Logo ─────────────────────────────────────────────────────────────────────

const LOGO: &str = r"
████████╗██╗  ██╗███████╗ ██████╗ ██████╗ ███████╗███╗   ███╗
╚══██╔══╝██║  ██║██╔════╝██╔═══██╗██╔══██╗██╔════╝████╗ ████║
   ██║   ███████║█████╗  ██║   ██║██████╔╝█████╗  ██╔████╔██║
   ██║   ██╔══██║██╔══╝  ██║   ██║██╔══██╗██╔══╝  ██║╚██╔╝██║
   ██║   ██║  ██║███████╗╚██████╔╝██║  ██║███████╗██║ ╚═╝ ██║
   ╚═╝   ╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝";

// ── Output ───────────────────────────────────────────────────────────────────

/// Shared output policy: `--json` for machine consumption, ANSI color only
/// when writing to a real terminal (piped output stays machine-parseable).
struct Output {
    json: bool,
    color: bool,
}

impl Output {
    fn new(json: bool, no_color: bool) -> Self {
        Self {
            json,
            color: !no_color && std::io::stdout().is_terminal(),
        }
    }

    fn print_json<T: Serialize>(&self, value: &T) -> i32 {
        match serde_json::to_string_pretty(value) {
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

    /// Human-only note on stderr (never pollutes piped stdout).
    fn note(&self, message: &str) {
        eprintln!("{}", self.dim(message));
    }

    fn error(&self, message: &str) -> i32 {
        eprintln!("{} {message}", self.red("error:"));
        1
    }

    fn wrap(&self, code: &str, text: &str) -> String {
        if self.color {
            format!("\x1b[{code}m{text}\x1b[0m")
        } else {
            text.to_string()
        }
    }

    fn dim(&self, text: &str) -> String {
        self.wrap("2", text)
    }

    fn bold(&self, text: &str) -> String {
        self.wrap("1", text)
    }

    fn cyan(&self, text: &str) -> String {
        self.wrap("36", text)
    }

    fn green(&self, text: &str) -> String {
        self.wrap("32", text)
    }

    fn red(&self, text: &str) -> String {
        self.wrap("31", text)
    }
}

// ── Argument definition ──────────────────────────────────────────────────────

#[derive(Parser)]
#[command(
    name = "theorem",
    version,
    after_help = LOGO.trim(),
    disable_help_subcommand = true,
    subcommand_required = true
)]
struct Cli {
    /// Emit machine-readable JSON on stdout
    #[arg(long, global = true)]
    json: bool,

    /// Disable ANSI colors (also auto-disabled when output is piped)
    #[arg(long, global = true)]
    no_color: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Full-text search across the library, or within one book
    Search {
        /// Search query
        query: String,
        /// Restrict to a book id (in-book streaming search)
        book_id: Option<String>,
    },
    /// Stream an EPUB chapter as plain text
    Read {
        book_id: String,
        /// 1-based chapter index in spine order (default: 1)
        #[arg(long)]
        chapter: Option<usize>,
    },
    /// Look up a term in installed StarDict dictionaries
    Dict {
        /// Term to define
        term: String,
    },
    /// Fetch a web page and print the clean article text
    Extract { url: String },
    /// Library management
    Library {
        #[command(subcommand)]
        command: LibraryCommand,
    },
    /// Print highlights and annotations as JSON
    Highlights {
        #[command(subcommand)]
        command: HighlightsCommand,
    },
    /// Install or inspect the `theorem` symlink in ~/.local/bin
    SetupCli,
    /// Print version information
    Version,
}

#[derive(Subcommand)]
enum LibraryCommand {
    /// List library books with metadata
    List {
        /// Output format
        #[arg(long, default_value = "table")]
        format: String,
    },
}

#[derive(Subcommand)]
enum HighlightsCommand {
    /// List annotations, optionally for one book
    List {
        #[arg(long)]
        book: Option<String>,
    },
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/// Top-level subcommand names. Anything else (notably file paths handed to the
/// GUI by the desktop) falls through to `theorem_lib::run()`.
const SUBCOMMANDS: &[&str] = &[
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

pub fn maybe_dispatch(args: &[String]) -> Option<i32> {
    // Find the first positional argument, skipping global flags (`--json`,
    // `--no-color` — none take values). That argument must be a known
    // subcommand; anything else (notably file paths handed to the GUI by the
    // desktop) falls through to `theorem_lib::run()`.
    let first = args
        .iter()
        .find(|a| !a.starts_with('-'))
        .filter(|a| SUBCOMMANDS.contains(&a.as_str()))?;
    let _ = first;
    Some(dispatch(args))
}

fn dispatch(args: &[String]) -> i32 {
    let cli = match Cli::try_parse_from(
        std::iter::once("theorem".to_string()).chain(args.iter().cloned()),
    ) {
        Ok(cli) => cli,
        Err(e) => {
            let _ = e.print();
            return if e.use_stderr() { e.exit_code() } else { 0 };
        }
    };
    let output = Output::new(cli.json, cli.no_color);
    run(cli.command, &output)
}

fn run(command: Command, output: &Output) -> i32 {
    match command {
        Command::SetupCli => match crate::setup_linux_cli_symlink_inner() {
            Ok(link) => {
                if output.json {
                    output.print_json(&serde_json::json!({ "link": link }))
                } else {
                    println!("CLI enabled: {}", output.green(&link));
                    0
                }
            }
            Err(e) => output.error(&e),
        },
        Command::Version => {
            if output.json {
                output.print_json(&serde_json::json!({
                    "name": "theorem",
                    "version": env!("CARGO_PKG_VERSION"),
                }))
            } else {
                println!("theorem {}", env!("CARGO_PKG_VERSION"));
                0
            }
        }
        other => with_app(|app| match other {
            Command::Search { query, book_id } => run_search(output, app, &query, book_id),
            Command::Read { book_id, chapter } => run_read(output, app, &book_id, chapter),
            Command::Dict { term } => run_dict(output, app, &term),
            Command::Extract { url } => run_extract(output, &url),
            Command::Library { command } => run_library(output, app, command),
            Command::Highlights { command } => run_highlights(output, app, command),
            Command::SetupCli | Command::Version => unreachable!("handled without app context"),
        }),
    }
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

fn run_dict(output: &Output, app: &tauri::AppHandle, term: &str) -> i32 {
    let started = std::time::Instant::now();
    let results = crate::stardict::lookup_all_installed(app, term);
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;

    if output.json {
        output.print_json(&results)
    } else {
        if results.is_empty() {
            output.note(&format!(
                "no definitions for '{term}' in {} installed dictionaries",
                crate::stardict::list_installed_dict_ids(app).len()
            ));
            return 1;
        }
        for entry in &results {
            println!(
                "{} {}",
                output.bold(&entry.word),
                output.dim(&format!("({})", entry.dictionary_name))
            );
            for meaning in &entry.meanings {
                if !meaning.part_of_speech.is_empty() {
                    println!("  {}", output.cyan(&meaning.part_of_speech));
                }
                for definition in &meaning.definitions {
                    println!("    {definition}");
                }
            }
            println!();
        }
        output.note(&format!("({:.2}ms)", elapsed));
        0
    }
}

// ── search ───────────────────────────────────────────────────────────────────

fn run_search(
    output: &Output,
    app: &tauri::AppHandle,
    query: &str,
    book_id: Option<String>,
) -> i32 {
    match book_id {
        None => library_search(output, app, query),
        Some(book_id) => in_book_search(output, app, &book_id, query),
    }
}

fn library_search(output: &Output, app: &tauri::AppHandle, query: &str) -> i32 {
    match crate::database::with_connection(app, |conn| {
        crate::database::sqlite_search_books_inner(conn, query, 50)
    }) {
        Ok(rows) => {
            if output.json {
                output.print_json(&rows)
            } else if rows.is_empty() {
                output.note("no results");
                0
            } else {
                for row in &rows {
                    println!("{}\t{}", output.dim(&row.book_id), row.title);
                }
                output.note(&format!("# {} results", rows.len()));
                0
            }
        }
        Err(e) => output.error(&e),
    }
}

fn in_book_search(output: &Output, app: &tauri::AppHandle, book_id: &str, query: &str) -> i32 {
    let path = match resolve_book_path(app, book_id) {
        Ok(Some(path)) => path,
        Ok(None) => {
            return output.error(&format!("book '{book_id}' not found in library"));
        }
        Err(e) => return output.error(&e),
    };

    match crate::book_search::search_epub_spine(&path, query, false) {
        Ok(matches) => {
            if output.json {
                output.print_json(&matches)
            } else {
                for m in &matches {
                    println!(
                        "{}:{}\t{}",
                        output.bold(&m.section_index.to_string()),
                        m.char_offset,
                        m.snippet
                    );
                }
                output.note(&format!("# {} matches", matches.len()));
                0
            }
        }
        Err(e) => output.error(&e),
    }
}

fn resolve_book_path(app: &tauri::AppHandle, book_id: &str) -> Result<Option<PathBuf>, String> {
    crate::database::sqlite_get_materialized_book_path(app.clone(), book_id.to_string())
        .map(|opt| opt.map(PathBuf::from))
}

// ── library ──────────────────────────────────────────────────────────────────

fn run_library(output: &Output, app: &tauri::AppHandle, command: LibraryCommand) -> i32 {
    match command {
        LibraryCommand::List { format } => library_list(output, app, &format),
    }
}

fn library_list(output: &Output, app: &tauri::AppHandle, format: &str) -> i32 {
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
        Err(e) => return output.error(&e),
    };

    if output.json || format == "json" {
        library_list_json(output, rows)
    } else {
        for (id, metadata_json) in &rows {
            let title = serde_json::from_str::<serde_json::Value>(metadata_json)
                .ok()
                .and_then(|v| v.get("title").and_then(|t| t.as_str()).map(String::from))
                .unwrap_or_else(|| "(untitled)".to_string());
            println!("{}\t{}", output.dim(id), output.bold(&title));
        }
        output.note(&format!("# {} books", rows.len()));
        0
    }
}

fn library_list_json(output: &Output, rows: Vec<(String, String)>) -> i32 {
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
    output.print_json(&items)
}

// ── highlights ───────────────────────────────────────────────────────────────

fn run_highlights(output: &Output, app: &tauri::AppHandle, command: HighlightsCommand) -> i32 {
    let HighlightsCommand::List { book } = command;
    let book_filter = book;

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
        Err(e) => return output.error(&e),
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
    output.print_json(&items)
}

// ── read ─────────────────────────────────────────────────────────────────────

fn run_read(output: &Output, app: &tauri::AppHandle, book_id: &str, chapter: Option<usize>) -> i32 {
    let chapter = chapter.unwrap_or(1).max(1);

    let path = match resolve_book_path(app, book_id) {
        Ok(Some(path)) => path,
        Ok(None) => {
            return output.error(&format!("book '{book_id}' not found in library"));
        }
        Err(e) => return output.error(&e),
    };

    match read_epub_chapter(&path, chapter) {
        Ok(text) => {
            if output.json {
                output.print_json(&serde_json::json!({
                    "bookId": book_id,
                    "chapter": chapter,
                    "text": text,
                }))
            } else {
                let stdout = std::io::stdout();
                let mut out = stdout.lock();
                let _ = out.write_all(text.as_bytes());
                let _ = out.write_all(b"\n");
                0
            }
        }
        Err(e) => output.error(&e),
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

fn run_extract(output: &Output, url: &str) -> i32 {
    let article = match block_on(crate::article_extractor::fetch_and_extract_article_native(
        url.to_string(),
    )) {
        Ok(article) => article,
        Err(e) => return output.error(&e),
    };

    if output.json {
        output.print_json(&article)
    } else {
        println!("{}", output.bold(&article.title));
        if let Some(byline) = &article.byline {
            println!("{}", output.dim(&format!("by {byline}")));
        }
        println!();
        match &article.text_content {
            Some(text) => print!("{text}"),
            None => print!("{}", article.content),
        }
        0
    }
}
