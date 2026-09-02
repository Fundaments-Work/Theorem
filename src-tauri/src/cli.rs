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
use std::io::{IsTerminal, Seek, SeekFrom, Write as _};
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
        /// EPUB CFI anchor — prints text from the resolved element
        #[arg(long)]
        cfi: Option<String>,
    },
    /// Look up a term in installed dictionaries (StarDict + MDict)
    Dict {
        /// Term to define
        term: String,
        /// Also query the Free Dictionary API (network)
        #[arg(long)]
        online: bool,
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
    /// List bookmarks (annotations of type bookmark)
    Bookmarks {
        #[command(subcommand)]
        command: BookmarksCommand,
    },
    /// Manage RSS feeds
    Feeds {
        #[command(subcommand)]
        command: FeedsCommand,
    },
    /// Browse and download OPDS catalogs
    Opds {
        #[command(subcommand)]
        command: OpdsCommand,
    },
    /// Manage P2P device sync
    Sync {
        #[command(subcommand)]
        command: SyncCommand,
    },
    /// Storage usage and cleanup
    Storage {
        #[command(subcommand)]
        command: StorageCommand,
    },
    /// Print a reading statistics snapshot
    Stats,
    /// Export a full JSON snapshot of the library
    Export {
        /// Write to a file instead of stdout
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Open a book in the Theorem GUI (bridge for rendering/TTS features)
    Open { book_id: String },
    /// Interactive terminal UI: browse the library and read as text
    Tui,
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
    /// Add a note or highlight annotation
    Add {
        book_id: String,
        /// Highlighted text (or the note itself for --type note)
        #[arg(long)]
        text: String,
        /// Note content attached to the annotation
        #[arg(long)]
        note: Option<String>,
        /// highlight | note
        #[arg(long, default_value = "highlight")]
        r#type: String,
        /// Highlight color
        #[arg(long, default_value = "yellow")]
        color: String,
    },
    /// Delete an annotation by id
    Delete { annotation_id: String },
}

#[derive(Subcommand)]
enum BookmarksCommand {
    /// List bookmarks, optionally for one book
    List {
        #[arg(long)]
        book: Option<String>,
    },
}

#[derive(Subcommand)]
enum FeedsCommand {
    /// List feeds with unread counts
    List,
    /// Subscribe to a new feed
    Add { url: String },
    /// Unsubscribe from a feed (by url or id)
    Remove { feed: String },
    /// Fetch every feed and merge new articles into the library
    Refresh,
}

#[derive(Subcommand)]
enum SyncCommand {
    /// Show device identity and paired devices
    Status,
    /// Pair with another device using its pairing code
    Pair { code: String },
    /// Unpair a device by id
    Unpair { device_id: String },
    /// Run a sync round now (all paired devices, or one)
    Now {
        #[arg(long)]
        device: Option<String>,
    },
}

#[derive(Subcommand)]
enum StorageCommand {
    /// Show SQLite storage usage
    Stats,
    /// Remove orphaned covers, blobs, and cache files
    Cleanup,
}

#[derive(Subcommand)]
enum OpdsCommand {
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
    "bookmarks",
    "feeds",
    "opds",
    "sync",
    "storage",
    "stats",
    "export",
    "open",
    "tui",
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
        // Sync needs the sync subsystem state managed in the headless context.
        Command::Sync { command } => with_app_ex(true, |app| run_sync(output, app, command)),
        other => with_app_ex(false, |app| match other {
            Command::Search { query, book_id } => run_search(output, app, &query, book_id),
            Command::Read {
                book_id,
                chapter,
                cfi,
            } => run_read(output, app, &book_id, chapter, cfi.as_deref()),
            Command::Dict { term, online } => run_dict(output, app, &term, online),
            Command::Extract { url } => run_extract(output, &url),
            Command::Library { command } => run_library(output, app, command),
            Command::Shelf { command } => run_shelf(output, app, command),
            Command::Highlights { command } => run_highlights(output, app, command),
            Command::Bookmarks { command } => run_bookmarks(output, app, command),
            Command::Feeds { command } => run_feeds(output, app, command),
            Command::Opds { command } => run_opds(output, app, command),
            Command::Storage { command } => run_storage(output, app, command),
            Command::Stats => run_stats(output, app),
            Command::Export { out } => run_export_snapshot(output, app, out),
            Command::Open { book_id } => run_open(output, app, &book_id),
            Command::Tui => crate::cli_tui::run_tui(app),
            Command::SetupCli | Command::Version | Command::Sync { .. } => {
                unreachable!("handled above")
            }
        }),
    }
}

/// With `with_sync`, the sync subsystem state is initialized so the
/// `sync_commands` surface works headless (the iroh node starts on demand).
fn headless_app_with_sync(with_sync: bool) -> Result<tauri::App, String> {
    let app = tauri::Builder::default()
        .build(tauri::generate_context!())
        .map_err(|e| format!("Failed to initialize app context: {e}"))?;

    let handle = app.handle().clone();
    if let Err(e) = crate::database::run_schema_migrations(&handle) {
        eprintln!("[cli] schema migration warning: {e}");
    }
    if with_sync {
        use tauri::Manager;
        let device_name = std::env::var("HOSTNAME")
            .or_else(|_| std::env::var("COMPUTERNAME"))
            .unwrap_or_else(|_| "Theorem Device".to_string());
        match crate::sync_commands::init_sync(app_data_dir(&handle), device_name, handle.clone()) {
            Ok(sync_state) => {
                app.manage(sync_state);
            }
            Err(e) => eprintln!("[cli] sync init failed: {e}"),
        }
    }
    Ok(app)
}

fn app_data_dir(handle: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn with_app_ex(with_sync: bool, f: impl FnOnce(&tauri::AppHandle) -> i32) -> i32 {
    match headless_app_with_sync(with_sync) {
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

/// Run a future to completion on a throwaway current-thread runtime.
/// Takes a factory so tokio time primitives (timeouts) are created inside
/// the runtime context — constructing them outside panics.
fn block_on<T, F>(future_factory: impl FnOnce() -> F) -> T
where
    T: Send + 'static,
    F: Future<Output = T>,
{
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("failed to build async runtime");
    // Enter the context BEFORE building the future: tokio time primitives
    // panic if constructed outside a runtime.
    let _guard = runtime.enter();
    let future = future_factory();
    runtime.block_on(future)
}

// ── dict ─────────────────────────────────────────────────────────────────────

fn run_dict(output: &Output, app: &tauri::AppHandle, term: &str, online: bool) -> i32 {
    let started = std::time::Instant::now();
    let stardict_results = crate::stardict::lookup_all_installed(app, term);
    let mdx_results = mdx_lookup_all_installed(app, term);
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;

    let online_result = if online {
        match block_on(|| crate::fetch_online_definition(term.to_string())) {
            Ok(value) => Some(value),
            Err(e) => {
                output.note(&format!("online lookup failed: {e}"));
                None
            }
        }
    } else {
        None
    };

    let stardict_len = stardict_results.len();
    let mdx_len = mdx_results.len();

    if output.json {
        return output.print_json(&serde_json::json!({
            "term": term,
            "stardict": stardict_results,
            "mdx": mdx_results,
            "online": online_result,
            "elapsedMs": elapsed,
        }));
    }

    if stardict_len == 0 && mdx_len == 0 && online_result.is_none() {
        output.note(&format!(
            "no definitions for '{term}' in {} installed dictionaries",
            stardict_len + mdx_len
        ));
        return 1;
    }

    for entry in &stardict_results {
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
    for entry in &mdx_results {
        println!(
            "{} {}",
            output.bold(&entry.term),
            output.dim(&format!("({})", entry.dictionary_name))
        );
        let text = crate::book_search::html_to_plain_text(&entry.html);
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            println!("    {}", line.trim());
        }
        println!();
    }
    if let Some(value) = online_result {
        println!("{} {}", output.bold(term), output.dim("(online)"));
        if let Some(text) = value.get("textContent").and_then(|v| v.as_str()) {
            for line in text.lines().take(30) {
                println!("    {line}");
            }
        } else {
            println!("    {value}");
        }
    }
    output.note(&format!("({:.2}ms)", elapsed));
    0
}

/// Look up a term in every installed MDict (.mdx) dictionary.
fn mdx_lookup_all_installed(
    app: &tauri::AppHandle,
    term: &str,
) -> Vec<crate::mdict::MdxEntryResult> {
    use tauri::Manager;

    let mut results = Vec::new();
    for id in crate::stardict::list_installed_dict_ids(app) {
        let dict_dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("dictionaries")
            .join(&id);
        let mdx_path = match std::fs::read_dir(&dict_dir) {
            Ok(entries) => entries.flatten().map(|e| e.path()).find(|p| {
                p.extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.eq_ignore_ascii_case("mdx"))
                    .unwrap_or(false)
            }),
            Err(_) => None,
        };
        let Some(mdx_path) = mdx_path else { continue };
        let dict = match crate::mdict::MdxDictionary::open(&mdx_path) {
            Ok(dict) => dict,
            Err(_) => continue,
        };
        if let Ok(Some(entry)) = dict.lookup(term) {
            results.push(entry);
        }
    }
    results
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

pub(crate) fn resolve_book_path(
    app: &tauri::AppHandle,
    book_id: &str,
) -> Result<Option<PathBuf>, String> {
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

pub(crate) struct LibraryKv {
    envelope: serde_json::Value,
}

impl LibraryKv {
    pub(crate) fn load(app: &tauri::AppHandle) -> Result<Self, String> {
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

    pub(crate) fn books(&mut self) -> &mut Vec<serde_json::Value> {
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

pub(crate) fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub(crate) fn book_str<'a>(book: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    book.get(key).and_then(|v| v.as_str())
}

pub(crate) fn book_title(book: &serde_json::Value) -> String {
    book_str(book, "title").unwrap_or("(untitled)").to_string()
}

pub(crate) fn book_author(book: &serde_json::Value) -> String {
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
    // The GUI's persisted books array is the authoritative library list; the
    // book_metadata SQL table is only written on metadata edits.
    let mut kv = match LibraryKv::load(app) {
        Ok(kv) => kv,
        Err(e) => return output.error(&e),
    };
    let mut books = kv.books().clone();
    books.sort_by(|a, b| {
        let ta = book_title(a).to_lowercase();
        let tb = book_title(b).to_lowercase();
        ta.cmp(&tb)
    });

    if output.json || format == "json" {
        return output.print_json(&books);
    }
    for book in &books {
        let title = book_title(book);
        let author = book_author(book);
        let progress = book.get("progress").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let favorite = if book
            .get("isFavorite")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            " *"
        } else {
            ""
        };
        println!(
            "{}  {}  {}{}",
            output.dim(book_str(book, "id").unwrap_or("?")),
            output.bold(&title),
            output.dim(&format!("{:.0}% {}", progress * 100.0, author)),
            favorite
        );
    }
    output.note(&format!("# {} books", books.len()));
    0
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
    let records =
        match block_on(|| crate::batch_ingest::ingest_books_native(app.clone(), paths.to_vec())) {
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

// ── highlights add/delete + bookmarks ────────────────────────────────────────

fn run_highlights(output: &Output, app: &tauri::AppHandle, command: HighlightsCommand) -> i32 {
    match command {
        HighlightsCommand::List { book } => highlights_list(output, app, book.as_deref()),
        HighlightsCommand::Add {
            book_id,
            text,
            note,
            r#type,
            color,
        } => highlights_add(
            output,
            app,
            &book_id,
            &text,
            note.as_deref(),
            &r#type,
            &color,
        ),
        HighlightsCommand::Delete { annotation_id } => {
            highlights_delete(output, app, &annotation_id)
        }
    }
}

fn load_annotations_rows(
    app: &tauri::AppHandle,
    book_id: &str,
) -> Result<Vec<serde_json::Value>, String> {
    crate::database::with_connection(app, |conn| {
        let mut stmt = conn.prepare(
            "SELECT annotation_json FROM book_annotations WHERE book_id = ?1 ORDER BY updated_at",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![book_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows
            .iter()
            .filter_map(|j| serde_json::from_str::<serde_json::Value>(j).ok())
            .collect())
    })
}

fn highlights_list(output: &Output, app: &tauri::AppHandle, book: Option<&str>) -> i32 {
    let annotations: Vec<(String, String)> = match crate::database::with_connection(app, |conn| {
        let mut stmt = conn.prepare(
            "SELECT book_id, annotation_json FROM book_annotations \
             WHERE (?1 IS NULL OR book_id = ?1) ORDER BY book_id, updated_at",
        )?;
        let mapped = stmt.query_map(rusqlite::params![book], |row| {
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

fn highlights_add(
    output: &Output,
    app: &tauri::AppHandle,
    book_id: &str,
    text: &str,
    note: Option<&str>,
    annotation_type: &str,
    color: &str,
) -> i32 {
    let annotation_type = match annotation_type {
        "highlight" | "note" => annotation_type.to_string(),
        other => return output.error(&format!("invalid --type '{other}' (highlight or note)")),
    };

    let mut kv = match LibraryKv::load(app) {
        Ok(kv) => kv,
        Err(e) => return output.error(&e),
    };
    if kv.book_position(book_id).is_none() {
        return output.error(&format!("book '{book_id}' not found in library"));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    let annotation = serde_json::json!({
        "id": id,
        "bookId": book_id,
        "type": annotation_type,
        "location": "",
        "selectedText": text,
        "noteContent": note,
        "color": color,
        "createdAt": now,
    });

    // Append to the per-book rows (the table stores one JSON per row).
    let mut rows = match load_annotations_rows(app, book_id) {
        Ok(rows) => rows,
        Err(e) => return output.error(&e),
    };
    rows.push(annotation.clone());
    let serialized: Vec<String> = rows
        .iter()
        .map(|v| serde_json::to_string(v).unwrap_or_default())
        .collect();
    if let Err(e) =
        crate::database::sqlite_save_book_annotations(app.clone(), book_id.to_string(), serialized)
    {
        return output.error(&e);
    }

    // Mirror into the GUI's persisted annotations array.
    let state = kv.state();
    state
        .as_object_mut()
        .expect("library state is an object")
        .entry("annotations")
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
        .expect("annotations is an array")
        .push(annotation);
    if let Err(e) = kv.save(app) {
        return output.error(&e);
    }

    if output.json {
        output.print_json(&serde_json::json!({ "id": id, "bookId": book_id }))
    } else {
        println!("{} annotation {id}", output.green("added"));
        0
    }
}

fn highlights_delete(output: &Output, app: &tauri::AppHandle, annotation_id: &str) -> i32 {
    // Locate the annotation in the GUI store to find its book.
    let mut kv = match LibraryKv::load(app) {
        Ok(kv) => kv,
        Err(e) => return output.error(&e),
    };
    let state = kv.state();
    let annotations = state
        .as_object_mut()
        .expect("library state is an object")
        .entry("annotations")
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
        .expect("annotations is an array");

    let position = annotations
        .iter()
        .position(|a| a.get("id").and_then(|v| v.as_str()) == Some(annotation_id));
    let Some(position) = position else {
        return output.error(&format!("annotation '{annotation_id}' not found"));
    };
    let removed = annotations.remove(position);
    let book_id = removed
        .get("bookId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if let Err(e) = kv.save(app) {
        return output.error(&e);
    }

    if !book_id.is_empty() {
        let mut rows = load_annotations_rows(app, &book_id).unwrap_or_default();
        rows.retain(|a| a.get("id").and_then(|v| v.as_str()) != Some(annotation_id));
        let serialized: Vec<String> = rows
            .iter()
            .map(|v| serde_json::to_string(v).unwrap_or_default())
            .collect();
        let _ =
            crate::database::sqlite_save_book_annotations(app.clone(), book_id.clone(), serialized);
    }

    let mut kv = LibraryKv::load(app).ok().unwrap_or_else(|| LibraryKv {
        envelope: serde_json::json!({"state": {}, "version": LIBRARY_KV_VERSION}),
    });
    kv.add_tombstone(annotation_id, "annotation");
    let _ = kv.save(app);

    if output.json {
        output.print_json(&serde_json::json!({ "deleted": annotation_id }))
    } else {
        println!("{} {annotation_id}", output.green("deleted"));
        0
    }
}

fn run_bookmarks(output: &Output, app: &tauri::AppHandle, command: BookmarksCommand) -> i32 {
    let BookmarksCommand::List { book } = command;

    let annotations: Vec<(String, String)> = match crate::database::with_connection(app, |conn| {
        let mut stmt = conn.prepare(
            "SELECT book_id, annotation_json FROM book_annotations \
             WHERE (?1 IS NULL OR book_id = ?1) ORDER BY book_id, updated_at",
        )?;
        let mapped = stmt.query_map(rusqlite::params![book], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        mapped.collect::<rusqlite::Result<Vec<_>>>()
    }) {
        Ok(rows) => rows,
        Err(e) => return output.error(&e),
    };

    let bookmarks: Vec<serde_json::Value> = annotations
        .into_iter()
        .filter_map(|(book_id, json)| {
            serde_json::from_str::<serde_json::Value>(&json)
                .ok()
                .filter(|a| a.get("type").and_then(|v| v.as_str()) == Some("bookmark"))
                .map(|mut v| {
                    v["bookId"] = serde_json::Value::String(book_id);
                    v
                })
        })
        .collect();
    output.print_json(&bookmarks)
}

// ── feeds (RSS) ──────────────────────────────────────────────────────────────

const RSS_KV_KEY: &str = "zustand:theorem-rss";

struct RssKv {
    envelope: serde_json::Value,
}

impl RssKv {
    fn load(app: &tauri::AppHandle) -> Result<Self, String> {
        let raw = crate::database::sqlite_get_kv(app.clone(), RSS_KV_KEY.to_string())?;
        let envelope = match raw {
            Some(text) => {
                serde_json::from_str(&text).map_err(|e| format!("RSS store is malformed: {e}"))?
            }
            None => serde_json::json!({
                "state": { "feeds": [], "articles": [] },
                "version": 1,
            }),
        };
        Ok(Self { envelope })
    }

    fn save(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let text = serde_json::to_string(&self.envelope)
            .map_err(|e| format!("Failed to serialize RSS store: {e}"))?;
        crate::database::sqlite_set_kv(app.clone(), RSS_KV_KEY.to_string(), text)
    }

    fn feeds(&mut self) -> &mut Vec<serde_json::Value> {
        self.state()
            .as_object_mut()
            .expect("rss state is an object")
            .entry("feeds")
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .expect("feeds is an array")
    }

    fn articles(&mut self) -> &mut Vec<serde_json::Value> {
        self.state()
            .as_object_mut()
            .expect("rss state is an object")
            .entry("articles")
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .expect("articles is an array")
    }

    fn state(&mut self) -> &mut serde_json::Value {
        self.envelope
            .as_object_mut()
            .expect("rss envelope is an object")
            .entry("state")
            .or_insert_with(|| serde_json::json!({}))
    }

    fn add_tombstone(&mut self, entity_id: &str, entity_type: &str) {
        self.state()
            .as_object_mut()
            .expect("rss state is an object")
            .entry("deletionTombstones")
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .expect("deletionTombstones is an array")
            .push(serde_json::json!({
                "entityId": entity_id,
                "entityType": entity_type,
                "deletedAt": now_iso(),
            }));
    }
}

/// Minimal RSS 2.0 / Atom item extraction (title, link, date, summary).
#[derive(Clone)]
struct FeedItem {
    title: String,
    link: String,
    published: Option<String>,
    summary: Option<String>,
}

fn parse_feed_items(xml: &str) -> Vec<FeedItem> {
    use quick_xml::events::Event;

    #[derive(Clone, Copy, PartialEq)]
    enum Mode {
        Rss,
        Atom,
    }
    let mut mode: Option<Mode> = None;
    let mut items: Vec<FeedItem> = Vec::new();
    let mut current: Option<FeedItem> = None;
    let mut field: Option<String> = None;
    let mut text = String::new();
    let mut link_href: Option<String> = None;

    let mut reader = quick_xml::Reader::from_str(xml);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let name = e.name().as_ref().to_ascii_lowercase();
                match name.as_slice() {
                    b"rss" => mode = Some(Mode::Rss),
                    b"feed" => mode = Some(Mode::Atom),
                    b"item" if mode == Some(Mode::Rss) => {
                        current = Some(FeedItem {
                            title: String::new(),
                            link: String::new(),
                            published: None,
                            summary: None,
                        });
                    }
                    b"entry" if mode == Some(Mode::Atom) => {
                        current = Some(FeedItem {
                            title: String::new(),
                            link: String::new(),
                            published: None,
                            summary: None,
                        });
                    }
                    b"title" | b"description" | b"summary" | b"content" | b"pubdate"
                    | b"published" | b"updated" | b"link"
                        if current.is_some() =>
                    {
                        if name.as_slice() == b"link" {
                            for attr in e.attributes().flatten() {
                                if attr.key.as_ref() == b"href" {
                                    link_href = Some(
                                        attr.unescape_value()
                                            .map(|v| v.into_owned())
                                            .unwrap_or_default(),
                                    );
                                }
                            }
                        }
                        field = Some(String::from_utf8_lossy(&name).into_owned());
                        text.clear();
                        continue;
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(t)) => {
                if field.is_some() {
                    text.push_str(&t.unescape().unwrap_or_default());
                }
            }
            Ok(Event::CData(t)) => {
                if field.is_some() {
                    text.push_str(
                        &t.into_inner()
                            .iter()
                            .map(|&b| b as char)
                            .collect::<String>(),
                    );
                }
            }
            Ok(Event::End(ref e)) => {
                let name = e.name().as_ref().to_ascii_lowercase();
                let done_field = field.take();
                if let Some(_field_name) = done_field {
                    if let Some(item) = current.as_mut() {
                        let value = text.trim().to_string();
                        match name.as_slice() {
                            b"title" => item.title = value,
                            b"description" | b"summary" | b"content" => {
                                if item.summary.is_none() {
                                    item.summary = Some(value);
                                }
                            }
                            b"pubdate" | b"published" | b"updated" => item.published = Some(value),
                            b"link" => {
                                if let Some(href) = link_href.take() {
                                    item.link = href;
                                } else if !value.is_empty() {
                                    item.link = value;
                                }
                            }
                            _ => {}
                        }
                    }
                } else if name.as_slice() == b"item" || name.as_slice() == b"entry" {
                    if let Some(mut item) = current.take() {
                        if item.link.is_empty() {
                            if let Some(href) = link_href.take() {
                                item.link = href;
                            }
                        }
                        items.push(item);
                    }
                }
                text.clear();
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    items
}

fn fetch_url_blocking(url: &str) -> Result<String, String> {
    let response = crate::shared_http_client()
        .get(url)
        .send()
        .map_err(|e| format!("Failed to fetch {url}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {} for {url}", response.status()));
    }
    response
        .text()
        .map_err(|e| format!("Failed to read body of {url}: {e}"))
}

fn run_feeds(output: &Output, app: &tauri::AppHandle, command: FeedsCommand) -> i32 {
    match command {
        FeedsCommand::List => feeds_list(output, app),
        FeedsCommand::Add { url } => feeds_add(output, app, &url),
        FeedsCommand::Remove { feed } => feeds_remove(output, app, &feed),
        FeedsCommand::Refresh => feeds_refresh(output, app),
    }
}

fn feeds_list(output: &Output, app: &tauri::AppHandle) -> i32 {
    let mut kv = match RssKv::load(app) {
        Ok(kv) => kv,
        Err(e) => return output.error(&e),
    };
    let feeds = kv.feeds().clone();
    if output.json {
        return output.print_json(&feeds);
    }
    for feed in &feeds {
        let id = book_str(feed, "id").unwrap_or("?").to_string();
        let title = book_str(feed, "title").unwrap_or("(untitled)").to_string();
        let url = book_str(feed, "url").unwrap_or("").to_string();
        let unread = feed
            .get("unreadCount")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        println!(
            "{}  {}  {}",
            output.dim(&id),
            output.bold(&title),
            output.dim(&format!("({unread} unread) {url}"))
        );
    }
    output.note(&format!("# {} feeds", feeds.len()));
    0
}

fn feeds_add(output: &Output, app: &tauri::AppHandle, url: &str) -> i32 {
    let mut kv = match RssKv::load(app) {
        Ok(kv) => kv,
        Err(e) => return output.error(&e),
    };
    if kv.feeds().iter().any(|f| book_str(f, "url") == Some(url)) {
        return output.error(&format!("feed already subscribed: {url}"));
    }

    let xml = match fetch_url_blocking(url) {
        Ok(xml) => xml,
        Err(e) => return output.error(&e.to_string()),
    };
    let items = parse_feed_items(&xml);
    let title = items
        .first()
        .map(|item| item.title.clone())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| url.to_string());

    let id = uuid::Uuid::new_v4().to_string();
    let feed = serde_json::json!({
        "id": id,
        "title": title,
        "url": url,
        "addedAt": now_iso(),
        "lastFetched": now_iso(),
        "unreadCount": 0,
    });
    kv.feeds().push(feed);
    if let Err(e) = kv.save(app) {
        return output.error(&e);
    }

    if output.json {
        output.print_json(&serde_json::json!({ "id": id, "url": url, "title": title }))
    } else {
        println!("{} {title}", output.green("subscribed"));
        0
    }
}

fn feeds_remove(output: &Output, app: &tauri::AppHandle, feed: &str) -> i32 {
    let mut kv = match RssKv::load(app) {
        Ok(kv) => kv,
        Err(e) => return output.error(&e),
    };
    let position = kv
        .feeds()
        .iter()
        .position(|f| book_str(f, "id") == Some(feed) || book_str(f, "url") == Some(feed));
    let Some(position) = position else {
        return output.error(&format!("feed '{feed}' not found"));
    };
    let removed = kv.feeds().remove(position);
    let removed_id = book_str(&removed, "id").unwrap_or("?").to_string();
    let removed_title = book_str(&removed, "name")
        .or_else(|| book_str(&removed, "title"))
        .unwrap_or("(untitled)")
        .to_string();

    kv.articles()
        .retain(|a| a.get("feedId").and_then(|v| v.as_str()) != Some(removed_id.as_str()));
    kv.add_tombstone(&removed_id, "feed");
    if let Err(e) = kv.save(app) {
        return output.error(&e);
    }

    if output.json {
        output.print_json(&serde_json::json!({ "removed": removed_id }))
    } else {
        println!("{} {removed_title}", output.green("unsubscribed"));
        0
    }
}

fn feeds_refresh(output: &Output, app: &tauri::AppHandle) -> i32 {
    let mut kv = match RssKv::load(app) {
        Ok(kv) => kv,
        Err(e) => return output.error(&e),
    };
    let feeds = kv.feeds().clone();
    if feeds.is_empty() {
        output.note("no feeds subscribed");
        return 0;
    }

    let mut total_new = 0usize;
    for feed in &feeds {
        let feed_id = book_str(feed, "id").unwrap_or("").to_string();
        let url = book_str(feed, "url").unwrap_or("").to_string();
        let xml = match fetch_url_blocking(&url) {
            Ok(xml) => xml,
            Err(e) => {
                output.note(&format!("refresh failed for {url}: {e}"));
                continue;
            }
        };
        let items = parse_feed_items(&xml);
        let mut new_count = 0usize;
        {
            let articles = kv.articles();
            for item in items {
                let article_key = format!("{feed_id}:{}", item.link);
                let exists = articles
                    .iter()
                    .any(|a| a.get("url").and_then(|v| v.as_str()) == Some(item.link.as_str()));
                if exists {
                    continue;
                }
                articles.push(serde_json::json!({
                    "id": uuid::Uuid::new_v4().to_string(),
                    "feedId": feed_id,
                    "title": item.title,
                    "url": item.link,
                    "content": item.summary.unwrap_or_default(),
                    "contentSource": "feed",
                    "publishedAt": item.published,
                    "fetchedAt": now_iso(),
                    "isRead": false,
                    "isFavorite": false,
                    "_key": article_key,
                }));
                new_count += 1;
            }
        }
        total_new += new_count;
        if let Some(f) = kv
            .feeds()
            .iter_mut()
            .find(|f| f.get("id").and_then(|v| v.as_str()) == Some(feed_id.as_str()))
        {
            f["lastFetched"] = serde_json::Value::String(now_iso());
            let unread = f.get("unreadCount").and_then(|v| v.as_i64()).unwrap_or(0);
            f["unreadCount"] = serde_json::json!(unread + new_count as i64);
        }
    }
    if let Err(e) = kv.save(app) {
        return output.error(&e);
    }

    if output.json {
        output.print_json(&serde_json::json!({ "newArticles": total_new }))
    } else {
        println!(
            "{} {} new articles across {} feeds",
            output.green("refreshed"),
            total_new,
            feeds.len()
        );
        0
    }
}

// ── opds ─────────────────────────────────────────────────────────────────────

fn run_opds(output: &Output, app: &tauri::AppHandle, command: OpdsCommand) -> i32 {
    match command {
        OpdsCommand::Browse { url } => opds_browse(output, &url),
        OpdsCommand::Download { url, entry } => opds_download(output, app, &url, &entry),
    }
}

fn opds_browse(output: &Output, url: &str) -> i32 {
    let feed = match block_on(|| crate::opds_parser::fetch_and_parse_opds_native(url.to_string())) {
        Ok(feed) => feed,
        Err(e) => return output.error(&e),
    };

    if output.json {
        return output.print_json(&feed);
    }
    println!("{}", output.bold(&feed.title));
    for (index, entry) in feed.entries.iter().enumerate() {
        let kind = if entry.is_navigation || entry.nav_url.is_some() {
            "nav"
        } else {
            "book"
        };
        println!(
            "{}  {} {}",
            output.dim(&format!("{:>3}", index + 1)),
            output.bold(&entry.title),
            output.dim(&format!(
                "[{kind}]{}",
                entry
                    .author
                    .as_ref()
                    .map(|a| format!(" by {a}"))
                    .unwrap_or_default()
            ))
        );
    }
    output.note(&format!("# {} entries", feed.entries.len()));
    0
}

fn opds_download(output: &Output, app: &tauri::AppHandle, url: &str, entry_selector: &str) -> i32 {
    let feed = match block_on(|| crate::opds_parser::fetch_and_parse_opds_native(url.to_string())) {
        Ok(feed) => feed,
        Err(e) => return output.error(&e),
    };

    let entry = match entry_selector.parse::<usize>() {
        Ok(index) if index >= 1 && index <= feed.entries.len() => Some(&feed.entries[index - 1]),
        _ => feed.entries.iter().find(|e| {
            e.title
                .to_lowercase()
                .contains(&entry_selector.to_lowercase())
        }),
    };
    let Some(entry) = entry else {
        return output.error(&format!("entry '{entry_selector}' not found in catalog"));
    };
    let Some(download_url) = entry.download_url.as_ref() else {
        return output.error(&format!(
            "entry '{}' has no acquisition link (navigation entry?)",
            entry.title
        ));
    };

    output.note(&format!("downloading '{}'...", entry.title));
    let bytes = {
        let response = match crate::shared_http_client().get(download_url).send() {
            Ok(response) => response,
            Err(e) => return output.error(&e.to_string()),
        };
        if !response.status().is_success() {
            return output.error(&format!("HTTP {} for {download_url}", response.status()));
        }
        match response.bytes() {
            Ok(bytes) => bytes.to_vec(),
            Err(e) => return output.error(&e.to_string()),
        }
    };

    let extension = entry
        .download_format
        .as_deref()
        .and_then(|f| f.split('/').next_back())
        .unwrap_or("epub")
        .to_ascii_lowercase();
    let temp_dir = match tempfile::tempdir() {
        Ok(dir) => dir,
        Err(e) => return output.error(&e.to_string()),
    };
    let temp_file = temp_dir.path().join(format!("opds-download.{extension}"));
    if let Err(e) = std::fs::write(&temp_file, &bytes) {
        return output.error(&e.to_string());
    }

    ingest_and_register(output, app, &[temp_file.display().to_string()])
}

// ── sync ─────────────────────────────────────────────────────────────────────

const SYNC_COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
const SYNC_ROUND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

fn run_sync(output: &Output, app: &tauri::AppHandle, command: SyncCommand) -> i32 {
    match command {
        SyncCommand::Status => sync_status(output, app),
        SyncCommand::Pair { code } => sync_pair(output, app, &code),
        SyncCommand::Unpair { device_id } => sync_unpair(output, app, &device_id),
        SyncCommand::Now { device } => sync_now(output, app, device.as_deref()),
    }
}

fn sync_status(output: &Output, app: &tauri::AppHandle) -> i32 {
    let identity = match block_on(|| {
        tokio::time::timeout(
            SYNC_COMMAND_TIMEOUT,
            crate::sync_commands::get_device_identity(app.clone()),
        )
    }) {
        Ok(Ok(identity)) => identity,
        Ok(Err(e)) => return output.error(&e),
        Err(_) => return output.error("device identity lookup timed out"),
    };
    let devices = match block_on(|| {
        tokio::time::timeout(
            SYNC_COMMAND_TIMEOUT,
            crate::sync_commands::get_paired_devices(app.clone()),
        )
    }) {
        Ok(Ok(devices)) => devices,
        Ok(Err(e)) => return output.error(&e),
        Err(_) => return output.error("paired device lookup timed out"),
    };

    if output.json {
        return output.print_json(&serde_json::json!({
            "identity": identity,
            "pairedDevices": devices,
        }));
    }
    println!(
        "{}: {} ({})",
        output.dim("this device"),
        output.bold(&identity.device_name),
        output.dim(&identity.fingerprint)
    );
    for device in &devices {
        println!(
            "  {}  {}  {}",
            output.dim(&device.device_id),
            output.bold(&device.device_name),
            output.dim(&device.fingerprint)
        );
    }
    output.note(&format!("# {} paired devices", devices.len()));
    0
}

fn sync_pair(output: &Output, app: &tauri::AppHandle, code: &str) -> i32 {
    let future = crate::sync_commands::submit_pairing_code(app.clone(), code.to_string());
    match block_on(|| tokio::time::timeout(SYNC_COMMAND_TIMEOUT, future)) {
        Ok(Ok(device)) => {
            if output.json {
                output.print_json(&device)
            } else {
                println!(
                    "{} {}",
                    output.green("paired with"),
                    output.bold(&device.device_name)
                );
                0
            }
        }
        Ok(Err(e)) => output.error(&e),
        Err(_) => output.error("pairing timed out (is the other device online and pairing?)"),
    }
}

fn sync_unpair(output: &Output, app: &tauri::AppHandle, device_id: &str) -> i32 {
    let future = crate::sync_commands::unpair_device(app.clone(), device_id.to_string());
    match block_on(|| tokio::time::timeout(SYNC_COMMAND_TIMEOUT, future)) {
        Ok(Ok(())) => {
            if output.json {
                output.print_json(&serde_json::json!({ "unpaired": device_id }))
            } else {
                println!("{} {device_id}", output.green("unpaired"));
                0
            }
        }
        Ok(Err(e)) => output.error(&e),
        Err(_) => output.error("unpair timed out"),
    }
}

fn sync_now(output: &Output, app: &tauri::AppHandle, device: Option<&str>) -> i32 {
    let devices = match block_on(|| {
        tokio::time::timeout(
            SYNC_COMMAND_TIMEOUT,
            crate::sync_commands::get_paired_devices(app.clone()),
        )
    }) {
        Ok(Ok(devices)) => devices,
        Ok(Err(e)) => return output.error(&e),
        Err(_) => return output.error("paired device lookup timed out"),
    };

    let targets: Vec<String> = match device {
        Some(id) => {
            if !devices.iter().any(|d| d.device_id == id) {
                return output.error(&format!("device '{id}' is not paired"));
            }
            vec![id.to_string()]
        }
        None => devices.iter().map(|d| d.device_id.clone()).collect(),
    };
    if targets.is_empty() {
        output.note("no paired devices to sync with");
        return 0;
    }

    let started = std::time::Instant::now();
    let mut results = Vec::new();
    for device_id in targets {
        let future = crate::sync_commands::docs_sync_now(app.clone(), device_id.clone());
        let outcome = match block_on(|| tokio::time::timeout(SYNC_ROUND_TIMEOUT, future)) {
            Ok(Ok(())) => "ok".to_string(),
            Ok(Err(e)) => format!("failed: {e}"),
            Err(_) => "timed out".to_string(),
        };
        results.push(serde_json::json!({
            "deviceId": device_id,
            "result": outcome,
        }));
    }

    let ok_count = results.iter().filter(|r| r["result"] == "ok").count();
    if output.json {
        return output.print_json(&serde_json::json!({
            "elapsedMs": started.elapsed().as_secs_f64() * 1000.0,
            "devices": results,
        }));
    }
    for r in &results {
        let status = if r["result"] == "ok" {
            output.green("ok")
        } else {
            output.red(r["result"].as_str().unwrap_or("?"))
        };
        println!(
            "{}  {}",
            output.dim(r["deviceId"].as_str().unwrap_or("?")),
            status
        );
    }
    if ok_count == results.len() {
        0
    } else {
        1
    }
}

// ── storage / stats / export snapshot ────────────────────────────────────────

fn run_storage(output: &Output, app: &tauri::AppHandle, command: StorageCommand) -> i32 {
    match command {
        StorageCommand::Stats => match crate::database::sqlite_get_storage_stats(app.clone()) {
            Ok(stats) => {
                if output.json {
                    output.print_json(&stats)
                } else {
                    println!("  {}: {}", output.dim("total books"), stats.total_books);
                    println!(
                        "  {}: {} MB",
                        output.dim("binaries"),
                        stats.binaries_size / (1024 * 1024)
                    );
                    println!(
                        "  {}: {} MB",
                        output.dim("covers"),
                        stats.covers_size / (1024 * 1024)
                    );
                    println!(
                        "  {}: {} ({} MB)",
                        output.dim("blob entries"),
                        stats.blob_entries,
                        stats.blob_size / (1024 * 1024)
                    );
                    0
                }
            }
            Err(e) => output.error(&e),
        },
        StorageCommand::Cleanup => {
            let existing_ids: Vec<String> = crate::database::with_connection(app, |conn| {
                let mut stmt = conn.prepare("SELECT id FROM books")?;
                let rows = stmt
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .unwrap_or_default();
            match crate::database::sqlite_cleanup_orphaned_storage(app.clone(), existing_ids) {
                Ok(result) => {
                    if output.json {
                        output.print_json(&result)
                    } else {
                        println!(
                            "{} removed {} books, {} covers, {} metadata rows",
                            output.green("cleanup"),
                            result.removed_books,
                            result.removed_covers,
                            result.removed_metadata
                        );
                        0
                    }
                }
                Err(e) => output.error(&e),
            }
        }
    }
}

fn run_stats(output: &Output, app: &tauri::AppHandle) -> i32 {
    let raw =
        match crate::database::sqlite_get_kv(app.clone(), "zustand:theorem-settings".to_string()) {
            Ok(raw) => raw,
            Err(e) => return output.error(&e),
        };
    let stats = raw
        .as_deref()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .and_then(|envelope| envelope.get("state")?.get("stats").cloned());

    let Some(stats) = stats else {
        return output.error("no reading statistics found");
    };
    if output.json {
        return output.print_json(&stats);
    }
    println!(
        "  {}: {} min",
        output.dim("total reading time"),
        stats
            .get("totalReadingTime")
            .and_then(|v| v.as_f64())
            .map(|m| (m / 60.0).round())
            .unwrap_or(0.0)
    );
    println!(
        "  {}: {}",
        output.dim("current streak"),
        stats
            .get("currentStreak")
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
    );
    println!(
        "  {}: {}",
        output.dim("longest streak"),
        stats
            .get("longestStreak")
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
    );
    println!(
        "  {}: {}",
        output.dim("books completed"),
        stats
            .get("booksCompleted")
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
    );
    println!(
        "  {}: {}",
        output.dim("daily goal"),
        stats.get("dailyGoal").and_then(|v| v.as_i64()).unwrap_or(0)
    );
    0
}

fn run_export_snapshot(output: &Output, app: &tauri::AppHandle, out: Option<PathBuf>) -> i32 {
    let library =
        crate::database::sqlite_get_kv(app.clone(), "zustand:theorem-library".to_string())
            .ok()
            .flatten()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .and_then(|envelope| envelope.get("state").cloned())
            .unwrap_or_else(|| serde_json::json!({}));

    let rss = crate::database::sqlite_get_kv(app.clone(), "zustand:theorem-rss".to_string())
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|envelope| envelope.get("state").cloned())
        .unwrap_or_else(|| serde_json::json!({}));

    let annotations: Vec<serde_json::Value> = crate::database::with_connection(app, |conn| {
        let mut stmt = conn.prepare(
            "SELECT book_id, annotation_json FROM book_annotations ORDER BY book_id, updated_at",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let collected = rows
            .collect::<rusqlite::Result<Vec<_>>>()?
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
        Ok(collected)
    })
    .unwrap_or_default();

    let snapshot = serde_json::json!({
        "exportedAt": now_iso(),
        "version": env!("CARGO_PKG_VERSION"),
        "books": library.get("books"),
        "collections": library.get("collections"),
        "tombstones": library.get("deletionTombstones"),
        "annotations": annotations,
        "feeds": rss.get("feeds"),
        "rssArticles": rss.get("articles"),
    });

    let text = match serde_json::to_string_pretty(&snapshot) {
        Ok(text) => text,
        Err(e) => return output.error(&e.to_string()),
    };
    match out {
        Some(path) => {
            if let Some(parent) = path.parent() {
                if !parent.as_os_str().is_empty() {
                    let _ = std::fs::create_dir_all(parent);
                }
            }
            if let Err(e) = std::fs::write(&path, &text) {
                return output.error(&format!("Failed to write {}: {e}", path.display()));
            }
            if output.json {
                output.print_json(&serde_json::json!({
                    "path": path.display().to_string(),
                    "bytes": text.len(),
                }))
            } else {
                println!(
                    "{} {} ({} bytes)",
                    output.green("exported"),
                    output.bold(&path.display().to_string()),
                    text.len()
                );
                0
            }
        }
        None => {
            println!("{text}");
            0
        }
    }
}

// ── open (GUI bridge) ────────────────────────────────────────────────────────

fn run_open(output: &Output, app: &tauri::AppHandle, book_id: &str) -> i32 {
    if load_kv_book(app, book_id).ok().flatten().is_none() {
        return output.error(&format!("book '{book_id}' not found in library"));
    }
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(e) => return output.error(&format!("Failed to resolve executable: {e}")),
    };
    match std::process::Command::new(exe)
        .arg(format!("--open-book={book_id}"))
        .spawn()
    {
        Ok(_) => {
            if output.json {
                output.print_json(&serde_json::json!({ "opened": book_id }))
            } else {
                println!("{} {book_id}", output.green("opening in GUI"));
                0
            }
        }
        Err(e) => output.error(&format!("Failed to launch GUI: {e}")),
    }
}

// ── read ─────────────────────────────────────────────────────────────────────

fn run_read(
    output: &Output,
    app: &tauri::AppHandle,
    book_id: &str,
    chapter: Option<usize>,
    cfi: Option<&str>,
) -> i32 {
    if let Some(cfi) = cfi {
        return run_read_cfi(output, app, book_id, cfi);
    }
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

/// Resolve an EPUB CFI and print the plain text at the anchored location.
fn run_read_cfi(output: &Output, app: &tauri::AppHandle, book_id: &str, cfi: &str) -> i32 {
    let location = match crate::epubcfi::parse(cfi) {
        Ok(location) => location,
        Err(e) => return output.error(&format!("invalid CFI: {e}")),
    };

    let path = match resolve_book_path(app, book_id) {
        Ok(Some(path)) => path,
        Ok(None) => return output.error(&format!("book '{book_id}' not found in library")),
        Err(e) => return output.error(&e),
    };

    let result = (|| -> Result<String, String> {
        let file = std::fs::File::open(&path)
            .map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
        let mut archive =
            zip::ZipArchive::new(file).map_err(|e| format!("Not a valid zip: {e}"))?;
        let opf_path = crate::epub_parser::read_rootfile_path_inner(&mut archive)
            .ok_or("Missing OPF rootfile in META-INF/container.xml")?;
        let opf = crate::epub_parser::read_zip_entry_inner(&mut archive, &opf_path)
            .ok_or_else(|| format!("Missing OPF file: {opf_path}"))?;
        let spine_hrefs = parse_spine_order(&opf);
        let href = spine_hrefs
            .get(location.spine_index)
            .ok_or_else(|| format!("CFI spine index {} out of range", location.spine_index))?;
        let section_path = crate::epub_parser::resolve_relative(&opf_path, href);
        let html = crate::epub_parser::read_zip_entry_inner(&mut archive, &section_path)
            .ok_or_else(|| format!("Missing chapter file: {section_path}"))?;
        let tree = crate::epubcfi::build_tree(&html);
        let text = crate::epubcfi::resolve_text(&tree, &location)?;
        if text.is_empty() {
            // Fall back to the whole chapter so the anchor context is visible.
            Ok(crate::book_search::html_to_plain_text(&html))
        } else {
            Ok(text)
        }
    })();

    match result {
        Ok(text) => {
            if output.json {
                output.print_json(&serde_json::json!({
                    "bookId": book_id,
                    "cfi": cfi,
                    "spineIndex": location.spine_index,
                    "text": text,
                }))
            } else {
                println!("{text}");
                0
            }
        }
        Err(e) => output.error(&e),
    }
}

/// Extract the plain text of an EPUB spine chapter in spine order.
/// The materialized cache file has no extension, so the format is sniffed
/// from the file magic instead.
pub(crate) fn read_epub_chapter(path: &PathBuf, chapter: usize) -> Result<String, String> {
    let mut magic = [0u8; 4];
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    std::io::Read::read_exact(&mut file, &mut magic)
        .map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    drop(file);

    if &magic != b"PK\x03\x04" {
        // MOBI/AZW: the PDB signature "BOOKMOBI" sits at offset 60.
        let mut pdb_magic = [0u8; 8];
        let mut file = std::fs::File::open(path)
            .map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
        file.seek(SeekFrom::Start(60))
            .map_err(|e| format!("Cannot seek {}: {e}", path.display()))?;
        std::io::Read::read_exact(&mut file, &mut pdb_magic)
            .map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
        if &pdb_magic == b"BOOKMOBI" {
            return crate::mobi_parser::extract_mobi_text(path);
        }
        return Err(format!(
            "read supports EPUB and MOBI files only ({})",
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

/// Count EPUB spine chapters without loading their content.
pub(crate) fn epub_chapter_count(path: &PathBuf) -> Result<usize, String> {
    let file =
        std::fs::File::open(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Not a valid zip: {e}"))?;
    let opf_path = crate::epub_parser::read_rootfile_path_inner(&mut archive)
        .ok_or("Missing OPF rootfile in META-INF/container.xml")?;
    let opf = crate::epub_parser::read_zip_entry_inner(&mut archive, &opf_path)
        .ok_or_else(|| format!("Missing OPF file: {opf_path}"))?;
    Ok(parse_spine_order(&opf).len().max(1))
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
    let article = match block_on(|| {
        crate::article_extractor::fetch_and_extract_article_native(url.to_string())
    }) {
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
