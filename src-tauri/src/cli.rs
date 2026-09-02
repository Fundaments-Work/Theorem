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
    /// Manage shelves (collections)
    Shelf {
        #[command(subcommand)]
        command: ShelfCommand,
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
    /// Show detailed info for one book
    Info { book_id: String },
    /// Import book files into the library (EPUB, MOBI, AZW3, FB2, PDF, CBZ)
    Add {
        /// Book files to import
        paths: Vec<String>,
    },
    /// Import every supported book file under a directory (recursive)
    Import { dir: String },
    /// Remove a book from the library (file, covers, annotations, metadata)
    Remove { book_id: String },
    /// Toggle or set a book's favorite flag
    Favorite {
        book_id: String,
        /// on | off | toggle (default: toggle)
        state: Option<String>,
    },
    /// Export the original book file to disk
    Export {
        book_id: String,
        /// Output path (default: ./<title>.<ext>)
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Rewrite title/author metadata inside an EPUB and the library index
    EditMeta {
        book_id: String,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        author: Option<String>,
    },
}

#[derive(Subcommand)]
enum ShelfCommand {
    /// List shelves with book counts
    List,
    /// Create a new shelf
    Create { name: String },
    /// Delete a shelf (by name or id)
    Delete { shelf: String },
    /// Add a book to a shelf
    Add { shelf: String, book_id: String },
    /// Remove a book from a shelf
    Remove { shelf: String, book_id: String },
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
    "shelf",
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
            Command::Shelf { command } => run_shelf(output, app, command),
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

// ── library store (zustand:theorem-library kv envelope) ─────────────────────

/// The GUI's library list persists through the zustand↔SQLite adapter as a
/// `zustand:theorem-library` kv row: `{"state": {books, collections,
/// deletionTombstones, ...}, "version": N}`. The CLI mutates the same row so
/// the GUI picks the changes up on its next launch.
const LIBRARY_KV_KEY: &str = "zustand:theorem-library";
const LIBRARY_KV_VERSION: u64 = 6;

struct LibraryKv {
    envelope: serde_json::Value,
}

impl LibraryKv {
    fn load(app: &tauri::AppHandle) -> Result<Self, String> {
        let raw = crate::database::sqlite_get_kv(app.clone(), LIBRARY_KV_KEY.to_string())?;
        let envelope = match raw {
            Some(text) => serde_json::from_str(&text)
                .map_err(|e| format!("Library store is malformed: {e}"))?,
            None => serde_json::json!({
                "state": { "books": [], "collections": [], "deletionTombstones": [] },
                "version": LIBRARY_KV_VERSION,
            }),
        };
        Ok(Self { envelope })
    }

    fn save(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let text = serde_json::to_string(&self.envelope)
            .map_err(|e| format!("Failed to serialize library store: {e}"))?;
        crate::database::sqlite_set_kv(app.clone(), LIBRARY_KV_KEY.to_string(), text)
    }

    fn state(&mut self) -> &mut serde_json::Value {
        self.envelope
            .as_object_mut()
            .expect("library envelope is an object")
            .entry("state")
            .or_insert_with(|| serde_json::json!({}))
    }

    fn books(&mut self) -> &mut Vec<serde_json::Value> {
        self.state()
            .as_object_mut()
            .expect("library state is an object")
            .entry("books")
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .expect("books is an array")
    }

    fn collections(&mut self) -> &mut Vec<serde_json::Value> {
        self.state()
            .as_object_mut()
            .expect("library state is an object")
            .entry("collections")
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .expect("collections is an array")
    }

    fn book_position(&self, book_id: &str) -> Option<usize> {
        self.envelope
            .get("state")
            .and_then(|s| s.get("books"))
            .and_then(|b| b.as_array())
            .and_then(|books| {
                books
                    .iter()
                    .position(|b| b.get("id").and_then(|v| v.as_str()) == Some(book_id))
            })
    }

    fn add_tombstone(&mut self, entity_id: &str, entity_type: &str) {
        let tombstone = serde_json::json!({
            "entityId": entity_id,
            "entityType": entity_type,
            "deletedAt": now_iso(),
        });
        self.state()
            .as_object_mut()
            .expect("library state is an object")
            .entry("deletionTombstones")
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .expect("deletionTombstones is an array")
            .push(tombstone);
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn book_str<'a>(book: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    book.get(key).and_then(|v| v.as_str())
}

fn book_title(book: &serde_json::Value) -> String {
    book_str(book, "title").unwrap_or("(untitled)").to_string()
}

fn book_author(book: &serde_json::Value) -> String {
    book_str(book, "author").unwrap_or("").to_string()
}

// ── library ──────────────────────────────────────────────────────────────────

fn run_library(output: &Output, app: &tauri::AppHandle, command: LibraryCommand) -> i32 {
    match command {
        LibraryCommand::List { format } => library_list(output, app, &format),
        LibraryCommand::Info { book_id } => library_info(output, app, &book_id),
        LibraryCommand::Add { paths } => library_add(output, app, &paths),
        LibraryCommand::Import { dir } => library_import(output, app, &dir),
        LibraryCommand::Remove { book_id } => library_remove(output, app, &book_id),
        LibraryCommand::Favorite { book_id, state } => {
            library_favorite(output, app, &book_id, state.as_deref())
        }
        LibraryCommand::Export { book_id, out } => library_export(output, app, &book_id, out),
        LibraryCommand::EditMeta {
            book_id,
            title,
            author,
        } => library_edit_meta(output, app, &book_id, title, author),
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

fn load_kv_book(
    app: &tauri::AppHandle,
    book_id: &str,
) -> Result<Option<serde_json::Value>, String> {
    let mut kv = LibraryKv::load(app)?;
    let position = match kv.book_position(book_id) {
        Some(p) => p,
        None => return Ok(None),
    };
    Ok(Some(kv.books()[position].clone()))
}

fn library_info(output: &Output, app: &tauri::AppHandle, book_id: &str) -> i32 {
    let book = match load_kv_book(app, book_id) {
        Ok(Some(book)) => book,
        Ok(None) => return output.error(&format!("book '{book_id}' not found in library")),
        Err(e) => return output.error(&e),
    };

    let annotation_count: i64 = crate::database::with_connection(app, |conn| {
        conn.query_row(
            "SELECT COUNT(*) FROM book_annotations WHERE book_id = ?1",
            rusqlite::params![book_id],
            |row| row.get(0),
        )
    })
    .unwrap_or(0);

    let materialized =
        crate::database::sqlite_get_materialized_book_path(app.clone(), book_id.to_string())
            .ok()
            .flatten();

    let info = serde_json::json!({
        "id": book_id,
        "title": book_title(&book),
        "author": book_author(&book),
        "format": book.get("format"),
        "fileSize": book.get("fileSize"),
        "progress": book.get("progress"),
        "isFavorite": book.get("isFavorite"),
        "addedAt": book.get("addedAt"),
        "lastReadAt": book.get("lastReadAt"),
        "tags": book.get("tags"),
        "annotationCount": annotation_count,
        "materializedPath": materialized,
        "filePath": book.get("filePath"),
    });

    if output.json {
        output.print_json(&info)
    } else {
        println!("{}", output.bold(&book_title(&book)));
        println!("  {}: {}", output.dim("id"), book_id);
        println!("  {}: {}", output.dim("author"), book_author(&book));
        println!(
            "  {}: {}",
            output.dim("format"),
            book.get("format").and_then(|v| v.as_str()).unwrap_or("?")
        );
        println!(
            "  {}: {}",
            output.dim("progress"),
            book.get("progress").and_then(|v| v.as_f64()).unwrap_or(0.0)
        );
        println!(
            "  {}: {}",
            output.dim("favorite"),
            book.get("isFavorite")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        );
        println!("  {}: {}", output.dim("annotations"), annotation_count);
        if let Some(path) = materialized {
            println!("  {}: {}", output.dim("file"), path);
        }
        0
    }
}

fn library_add(output: &Output, app: &tauri::AppHandle, paths: &[String]) -> i32 {
    if paths.is_empty() {
        eprintln!("usage: theorem library add <files...> | theorem library import <dir>");
        return 2;
    }
    ingest_and_register(output, app, paths)
}

fn library_import(output: &Output, app: &tauri::AppHandle, dir: &str) -> i32 {
    let walk = match std::fs::read_dir(dir) {
        Ok(walk) => walk,
        Err(e) => return output.error(&format!("Cannot read directory {dir}: {e}")),
    };

    const SUPPORTED: &[&str] = &[
        ".epub", ".mobi", ".azw", ".azw3", ".fb2", ".fbz", ".pdf", ".cbz", ".cbr",
    ];
    let mut files = Vec::new();
    let mut stack = vec![PathBuf::from(dir)];
    while let Some(current) = stack.pop() {
        let entries = match std::fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                let dotted = format!(".{}", ext.to_ascii_lowercase());
                if SUPPORTED.contains(&dotted.as_str()) {
                    files.push(path.to_string_lossy().into_owned());
                }
            }
        }
    }
    let _ = walk;

    if files.is_empty() {
        output.note(&format!("no supported book files found under {dir}"));
        return 0;
    }
    files.sort();
    ingest_and_register(output, app, &files)
}

/// Run the native parallel ingest, then register each result in the GUI's
/// persisted library store + FTS index (mirrors the frontend import flow).
fn ingest_and_register(output: &Output, app: &tauri::AppHandle, paths: &[String]) -> i32 {
    let records = match block_on(crate::batch_ingest::ingest_books_native(
        app.clone(),
        paths.to_vec(),
    )) {
        Ok(records) => records,
        Err(e) => return output.error(&e),
    };

    let mut kv = match LibraryKv::load(app) {
        Ok(kv) => kv,
        Err(e) => return output.error(&e),
    };

    let mut registered = Vec::new();
    for record in &records {
        let book = serde_json::json!({
            "id": record.id,
            "title": record.title,
            "author": record.author,
            "filePath": record.file_path,
            "storagePath": record.storage_path,
            "format": record.format,
            "contentHash": record.content_hash,
            "coverPath": record.cover_path,
            "coverExtractionDone": record.cover_extraction_done,
            "description": record.description,
            "publisher": record.publisher,
            "publishedDate": record.published_date,
            "language": record.language,
            "isbn": record.isbn,
            "fileSize": record.file_size,
            "addedAt": now_iso(),
            "progress": 0,
            "tags": [],
            "isFavorite": false,
        });
        if let Err(e) = crate::database::sqlite_index_book_fts(
            app.clone(),
            record.id.clone(),
            record.title.clone(),
            record.author.clone(),
        ) {
            output.note(&format!("FTS index failed for '{}': {e}", record.title));
        }
        registered.push(book);
    }

    kv.books().extend(registered);
    if let Err(e) = kv.save(app) {
        return output.error(&e);
    }

    if output.json {
        output.print_json(&records)
    } else {
        for record in &records {
            println!(
                "{} {}",
                output.green("added"),
                output.bold(&format!("{} — {}", record.title, record.author))
            );
        }
        output.note(&format!(
            "# {} imported, {} skipped (duplicates)",
            records.len(),
            paths.len() - records.len()
        ));
        0
    }
}

fn library_remove(output: &Output, app: &tauri::AppHandle, book_id: &str) -> i32 {
    let book = match load_kv_book(app, book_id) {
        Ok(Some(book)) => book,
        Ok(None) => return output.error(&format!("book '{book_id}' not found in library")),
        Err(e) => return output.error(&e),
    };
    let title = book_title(&book);

    // Collect annotation ids first for tombstones (the row is about to vanish).
    let annotation_ids: Vec<String> = crate::database::with_connection(app, |conn| {
        let mut stmt = conn.prepare("SELECT id FROM book_annotations WHERE book_id = ?1")?;
        let rows = stmt.query_map(rusqlite::params![book_id], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })
    .unwrap_or_default();

    // FK cascade is ON: covers, book_metadata, materialized_books and
    // book_annotations all reference books(id) ON DELETE CASCADE.
    if let Err(e) = crate::database::with_connection(app, |conn| {
        conn.execute(
            "DELETE FROM books WHERE id = ?1",
            rusqlite::params![book_id],
        )?;
        conn.execute(
            "DELETE FROM books_fts WHERE id = ?1",
            rusqlite::params![book_id],
        )?;
        Ok(())
    }) {
        return output.error(&e);
    }

    if let Ok(Some(path)) =
        crate::database::sqlite_get_materialized_book_path(app.clone(), book_id.to_string())
    {
        let _ = std::fs::remove_file(path);
    }

    let mut kv = match LibraryKv::load(app) {
        Ok(kv) => kv,
        Err(e) => return output.error(&e),
    };
    if let Some(position) = kv.book_position(book_id) {
        kv.books().remove(position);
    }
    kv.add_tombstone(book_id, "book");
    for annotation_id in &annotation_ids {
        kv.add_tombstone(annotation_id, "annotation");
    }
    if let Err(e) = kv.save(app) {
        return output.error(&e);
    }

    if output.json {
        output.print_json(&serde_json::json!({ "removed": book_id, "title": title }))
    } else {
        println!("{} {title}", output.green("removed"));
        0
    }
}

fn library_favorite(
    output: &Output,
    app: &tauri::AppHandle,
    book_id: &str,
    state: Option<&str>,
) -> i32 {
    let mut kv = match LibraryKv::load(app) {
        Ok(kv) => kv,
        Err(e) => return output.error(&e),
    };
    let position = match kv.book_position(book_id) {
        Some(p) => p,
        None => return output.error(&format!("book '{book_id}' not found in library")),
    };

    let current = kv.books()[position]
        .get("isFavorite")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let next = match state.unwrap_or("toggle") {
        "on" | "true" | "yes" => true,
        "off" | "false" | "no" => false,
        "toggle" => !current,
        other => {
            return output.error(&format!(
                "invalid state '{other}' (expected on, off or toggle)"
            ))
        }
    };
    kv.books()[position]["isFavorite"] = serde_json::Value::Bool(next);

    let title = book_title(&kv.books()[position]);
    if let Err(e) = kv.save(app) {
        return output.error(&e);
    }
    // Mirror into the metadata row the GUI reads for editing.
    let _ = crate::database::with_connection(app, |conn| {
        if let Ok(Some(mut metadata)) =
            crate::database::sqlite_get_book_metadata_inner(conn, book_id)
        {
            if let Ok(mut parsed) = serde_json::from_str::<serde_json::Value>(&metadata) {
                parsed["isFavorite"] = serde_json::Value::Bool(next);
                if let Ok(updated) = serde_json::to_string(&parsed) {
                    metadata = updated;
                    let _ =
                        crate::database::sqlite_save_book_metadata_inner(conn, book_id, &metadata);
                }
            }
        }
        Ok(())
    });

    if output.json {
        output.print_json(&serde_json::json!({ "id": book_id, "isFavorite": next }))
    } else {
        let label = if next { "favorited" } else { "unfavorited" };
        println!("{} {title}", output.green(label));
        0
    }
}

fn library_export(
    output: &Output,
    app: &tauri::AppHandle,
    book_id: &str,
    out: Option<PathBuf>,
) -> i32 {
    let book = match load_kv_book(app, book_id) {
        Ok(Some(book)) => book,
        Ok(None) => return output.error(&format!("book '{book_id}' not found in library")),
        Err(e) => return output.error(&e),
    };

    let format = book_str(&book, "format").unwrap_or("epub").to_string();
    let bytes: Vec<u8> = match crate::database::sqlite_get_materialized_book_path(
        app.clone(),
        book_id.to_string(),
    ) {
        Ok(Some(path)) => match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) => return output.error(&format!("Failed to read {path}: {e}")),
        },
        _ => match crate::database::sqlite_get_book_data(app.clone(), book_id.to_string()) {
            Ok(Some(data)) if !data.is_empty() => data,
            _ => return output.error("book file not found on disk or in storage"),
        },
    };

    let target = out.unwrap_or_else(|| {
        let title = book_title(&book)
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' {
                    c
                } else {
                    ' '
                }
            })
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join("_");
        PathBuf::from(format!("{title}.{format}"))
    });
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return output.error(&format!("Cannot create {}: {e}", parent.display()));
            }
        }
    }
    if let Err(e) = std::fs::write(&target, &bytes) {
        return output.error(&format!("Failed to write {}: {e}", target.display()));
    }

    if output.json {
        output.print_json(&serde_json::json!({
            "id": book_id,
            "path": target.display().to_string(),
            "bytes": bytes.len(),
        }))
    } else {
        println!(
            "{} {} ({} bytes)",
            output.green("exported"),
            output.bold(&target.display().to_string()),
            bytes.len()
        );
        0
    }
}

fn library_edit_meta(
    output: &Output,
    app: &tauri::AppHandle,
    book_id: &str,
    title: Option<String>,
    author: Option<String>,
) -> i32 {
    if title.is_none() && author.is_none() {
        eprintln!("usage: theorem library edit-meta <book-id> --title <title> --author <author>");
        return 2;
    }

    let book = match load_kv_book(app, book_id) {
        Ok(Some(book)) => book,
        Ok(None) => return output.error(&format!("book '{book_id}' not found in library")),
        Err(e) => return output.error(&e),
    };
    let is_epub = book_str(&book, "format")
        .map(|f| f.eq_ignore_ascii_case("epub"))
        .unwrap_or(false);

    if is_epub {
        let edit = crate::epub_rewriter::EpubMetadataEdit {
            title: title.clone(),
            author: author.clone(),
            ..Default::default()
        };
        if let Err(e) = crate::epub_rewriter::rewrite_epub_metadata(
            app.clone(),
            book_id.to_string(),
            Some(edit),
            None,
        ) {
            return output.error(&e);
        }
    } else {
        output.note("file is not an EPUB — updating the library index only");
    }

    // Update the persisted library store + metadata row + FTS index.
    let mut kv = match LibraryKv::load(app) {
        Ok(kv) => kv,
        Err(e) => return output.error(&e),
    };
    let position = match kv.book_position(book_id) {
        Some(p) => p,
        None => return output.error(&format!("book '{book_id}' not found in library")),
    };
    if let Some(t) = &title {
        kv.books()[position]["title"] = serde_json::Value::String(t.clone());
    }
    if let Some(a) = &author {
        kv.books()[position]["author"] = serde_json::Value::String(a.clone());
    }
    let updated = kv.books()[position].clone();
    let new_title = book_title(&updated);
    let new_author = book_author(&updated);
    if let Err(e) = kv.save(app) {
        return output.error(&e);
    }

    let _ = crate::database::with_connection(app, |conn| {
        if let Some(mut metadata) = crate::database::sqlite_get_book_metadata_inner(conn, book_id)?
        {
            if let Ok(mut parsed) = serde_json::from_str::<serde_json::Value>(&metadata) {
                if let Some(t) = &title {
                    parsed["title"] = serde_json::Value::String(t.clone());
                }
                if let Some(a) = &author {
                    parsed["author"] = serde_json::Value::String(a.clone());
                }
                metadata = serde_json::to_string(&parsed).unwrap_or(metadata);
                crate::database::sqlite_save_book_metadata_inner(conn, book_id, &metadata)?;
            }
        }
        Ok(())
    });
    let _ = crate::database::sqlite_index_book_fts(
        app.clone(),
        book_id.to_string(),
        new_title.clone(),
        new_author.clone(),
    );

    if output.json {
        output.print_json(&serde_json::json!({
            "id": book_id,
            "title": new_title,
            "author": new_author,
            "fileRewritten": is_epub,
        }))
    } else {
        println!("{} {}", output.green("updated"), output.bold(&new_title));
        0
    }
}

// ── shelves ──────────────────────────────────────────────────────────────────

fn run_shelf(output: &Output, app: &tauri::AppHandle, command: ShelfCommand) -> i32 {
    match command {
        ShelfCommand::List => shelf_list(output, app),
        ShelfCommand::Create { name } => shelf_create(output, app, &name),
        ShelfCommand::Delete { shelf } => shelf_delete(output, app, &shelf),
        ShelfCommand::Add { shelf, book_id } => shelf_add(output, app, &shelf, &book_id, true),
        ShelfCommand::Remove { shelf, book_id } => shelf_add(output, app, &shelf, &book_id, false),
    }
}

fn shelf_list(output: &Output, app: &tauri::AppHandle) -> i32 {
    let mut kv = match LibraryKv::load(app) {
        Ok(kv) => kv,
        Err(e) => return output.error(&e),
    };
    let collections = kv.collections().clone();

    if output.json {
        output.print_json(&collections)
    } else {
        for collection in &collections {
            let name = book_str(collection, "name")
                .unwrap_or("(unnamed)")
                .to_string();
            let id = book_str(collection, "id").unwrap_or("?").to_string();
            let count = collection
                .get("bookIds")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            println!(
                "{}  {}  {}",
                output.dim(&id),
                output.bold(&name),
                output.dim(&format!("({count} books)"))
            );
        }
        output.note(&format!("# {} shelves", collections.len()));
        0
    }
}

fn find_collection_position(collections: &[serde_json::Value], shelf: &str) -> Option<usize> {
    collections
        .iter()
        .position(|c| book_str(c, "id") == Some(shelf))
        .or_else(|| {
            collections.iter().position(|c| {
                book_str(c, "name")
                    .map(|n| n.eq_ignore_ascii_case(shelf))
                    .unwrap_or(false)
            })
        })
}

fn shelf_create(output: &Output, app: &tauri::AppHandle, name: &str) -> i32 {
    let mut kv = match LibraryKv::load(app) {
        Ok(kv) => kv,
        Err(e) => return output.error(&e),
    };
    if kv.collections().iter().any(|c| {
        book_str(c, "name")
            .map(|n| n.eq_ignore_ascii_case(name))
            .unwrap_or(false)
    }) {
        return output.error(&format!("shelf '{name}' already exists"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let collection = serde_json::json!({
        "id": id,
        "name": name,
        "bookIds": [],
        "kind": "general",
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
    });
    kv.collections().push(collection);
    if let Err(e) = kv.save(app) {
        return output.error(&e);
    }

    if output.json {
        output.print_json(&serde_json::json!({ "id": id, "name": name }))
    } else {
        println!("{} {}", output.green("created"), output.bold(name));
        0
    }
}

fn shelf_delete(output: &Output, app: &tauri::AppHandle, shelf: &str) -> i32 {
    let mut kv = match LibraryKv::load(app) {
        Ok(kv) => kv,
        Err(e) => return output.error(&e),
    };
    let position = match find_collection_position(kv.collections(), shelf) {
        Some(p) => p,
        None => return output.error(&format!("shelf '{shelf}' not found")),
    };
    let removed = kv.collections().remove(position);
    let removed_id = book_str(&removed, "id").unwrap_or("?").to_string();
    let removed_name = book_str(&removed, "name")
        .unwrap_or("(unnamed)")
        .to_string();
    kv.add_tombstone(&removed_id, "collection");
    if let Err(e) = kv.save(app) {
        return output.error(&e);
    }

    if output.json {
        output.print_json(&serde_json::json!({ "deleted": removed_id, "name": removed_name }))
    } else {
        println!("{} {removed_name}", output.green("deleted"));
        0
    }
}

fn shelf_add(
    output: &Output,
    app: &tauri::AppHandle,
    shelf: &str,
    book_id: &str,
    add: bool,
) -> i32 {
    let mut kv = match LibraryKv::load(app) {
        Ok(kv) => kv,
        Err(e) => return output.error(&e),
    };
    let position = match find_collection_position(kv.collections(), shelf) {
        Some(p) => p,
        None => return output.error(&format!("shelf '{shelf}' not found")),
    };
    if kv.book_position(book_id).is_none() {
        return output.error(&format!("book '{book_id}' not found in library"));
    }

    {
        let collection = &mut kv.collections()[position];
        let book_ids = collection
            .as_object_mut()
            .expect("collection is an object")
            .entry("bookIds")
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .expect("bookIds is an array");
        let already = book_ids.iter().any(|b| b.as_str() == Some(book_id));
        if add && !already {
            book_ids.push(serde_json::Value::String(book_id.to_string()));
        } else if !add && already {
            book_ids.retain(|b| b.as_str() != Some(book_id));
        } else {
            output.note(if add {
                "book already on shelf"
            } else {
                "book not on shelf"
            });
            return 0;
        }
        collection["updatedAt"] = serde_json::Value::String(now_iso());
    }

    if !add {
        let collection_id = book_str(&kv.collections()[position], "id")
            .unwrap_or("?")
            .to_string();
        kv.add_tombstone(&format!("{collection_id}:{book_id}"), "collection_book");
    }
    if let Err(e) = kv.save(app) {
        return output.error(&e);
    }

    if output.json {
        output.print_json(&serde_json::json!({
            "shelf": shelf,
            "bookId": book_id,
            "action": if add { "added" } else { "removed" },
        }))
    } else {
        println!(
            "{} {} {} shelf {shelf}",
            output.green(if add { "added" } else { "removed" }),
            output.bold(book_id),
            if add { "to" } else { "from" }
        );
        0
    }
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
