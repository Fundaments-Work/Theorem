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

use std::collections::HashMap;
use std::future::Future;
use std::io::{IsTerminal, Seek, SeekFrom, Write as _};
use std::path::PathBuf;

use rusqlite::OptionalExtension;

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

/// Exit code for a command line that does not make sense (as clap uses).
const EXIT_USAGE: i32 = 2;
/// Exit code when a command would change the library while the app runs.
/// Exit code when the book, shelf, feed or entry asked for does not exist.
const EXIT_NOT_FOUND: i32 = 3;
/// Exit code when the network (a feed, a catalog, a download) failed.
const EXIT_NETWORK: i32 = 4;
const EXIT_APP_RUNNING: i32 = 5;

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
    subcommand_required = true
)]
struct Cli {
    /// Emit machine-readable JSON on stdout
    #[arg(long, global = true)]
    json: bool,

    /// Disable ANSI colors (also auto-disabled when output is piped)
    #[arg(long, global = true)]
    no_color: bool,

    /// Change the library even while the Theorem app is running
    #[arg(long, global = true)]
    force: bool,

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

/// Top-level subcommand names.
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

/// An argument the desktop (or `theorem open`) hands to the app window: a
/// file to open, a URI, or the app's own `--open-book=<id>`.
fn is_gui_argument(arg: &str) -> bool {
    if arg.starts_with("--open-book=") || arg.starts_with("-psn_") {
        // `-psn_…`: the process serial number old macOS Finder versions add.
        return true;
    }
    if arg.starts_with('-') {
        return false;
    }
    if arg.contains("://") {
        return true;
    }
    std::path::Path::new(arg).exists()
}

/// Whether these arguments launch the app window rather than the CLI: no
/// arguments at all, or only files/URIs to open. A known subcommand always
/// runs the CLI, even when a file of that name exists in the folder.
fn launches_gui(args: &[String]) -> bool {
    if args.is_empty() {
        return true;
    }
    let first_positional = args.iter().find(|a| !a.starts_with('-'));
    if first_positional.is_some_and(|a| SUBCOMMANDS.contains(&a.as_str())) {
        return false;
    }
    args.iter().all(|a| is_gui_argument(a))
}

/// Run the CLI when the arguments ask for it, returning the exit code;
/// `None` means "launch the app". Anything that is not a file or URI to open
/// is a command line, so a mistyped command or a lone flag prints a usage
/// error (exit 2) instead of starting the app.
pub fn maybe_dispatch(args: &[String]) -> Option<i32> {
    if launches_gui(args) {
        return None;
    }
    attach_parent_console();
    Some(dispatch(args))
}

/// Release builds on Windows are GUI programs (no console of their own), so
/// a CLI run's output would go nowhere. Attach to the console of the shell
/// that started us; output that is already redirected keeps its target.
#[cfg(windows)]
fn attach_parent_console() {
    #[link(name = "kernel32")]
    extern "system" {
        fn AttachConsole(process_id: u32) -> i32;
    }
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
    // SAFETY: AttachConsole takes a plain integer and has no memory effects;
    // failure (no parent console, or one already attached) is harmless.
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

#[cfg(not(windows))]
fn attach_parent_console() {}

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
    // Commands that change the library refuse to run next to the app: the
    // app keeps the library in memory and would write its own copy over
    // theirs (and sync would spread the loser). `_guard` keeps the app from
    // starting until the command is done.
    let _guard = if command_writes(&cli.command) && !cli.force {
        let dir = match app_data_dir() {
            Ok(dir) => dir,
            Err(e) => return output.error(&e),
        };
        match crate::app_lock::check_from_cli(&dir) {
            Ok(crate::app_lock::AppState::NotRunning(guard)) => Some(guard),
            Ok(crate::app_lock::AppState::Running) => {
                output.error(
                    "Theorem is running. Quit the app (also from the tray) and run the \
                     command again, or add --force to change the library anyway (the app \
                     may overwrite the change).",
                );
                return EXIT_APP_RUNNING;
            }
            Err(e) => return output.error(&e),
        }
    } else {
        None
    };
    run(cli.command, &output)
}

/// Whether a command changes the library (or runs the sync engine, which
/// must not run twice).
fn command_writes(command: &Command) -> bool {
    match command {
        Command::Library { command } => !matches!(
            command,
            LibraryCommand::List { .. } | LibraryCommand::Info { .. } | LibraryCommand::Export { .. }
        ),
        Command::Shelf { command } => !matches!(command, ShelfCommand::List),
        Command::Highlights { command } => !matches!(command, HighlightsCommand::List { .. }),
        Command::Feeds { command } => !matches!(command, FeedsCommand::List),
        Command::Opds { command } => matches!(command, OpdsCommand::Download { .. }),
        Command::Storage { command } => matches!(command, StorageCommand::Cleanup),
        Command::Sync { .. } => true,
        _ => false,
    }
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
        // Sync needs the iroh engine, which runs inside a Tauri app context.
        Command::Sync { command } => with_sync_app(output, |app| run_sync(output, app, command)),
        other => {
            let ctx = match Ctx::open() {
                Ok(ctx) => ctx,
                Err(e) => return output.error(&e),
            };
            let ctx = &ctx;
            match other {
                Command::Search { query, book_id } => run_search(output, ctx, &query, book_id),
                Command::Read {
                    book_id,
                    chapter,
                    cfi,
                } => run_read(output, ctx, &book_id, chapter, cfi.as_deref()),
                Command::Dict { term, online } => run_dict(output, ctx, &term, online),
                Command::Extract { url } => run_extract(output, &url),
                Command::Library { command } => run_library(output, ctx, command),
                Command::Shelf { command } => run_shelf(output, ctx, command),
                Command::Highlights { command } => run_highlights(output, ctx, command),
                Command::Bookmarks { command } => run_bookmarks(output, ctx, command),
                Command::Feeds { command } => run_feeds(output, ctx, command),
                Command::Opds { command } => run_opds(output, ctx, command),
                Command::Storage { command } => run_storage(output, ctx, command),
                Command::Stats => run_stats(output, ctx),
                Command::Export { out } => run_export_snapshot(output, ctx, out),
                Command::Open { book_id } => run_open(output, ctx, &book_id),
                Command::Tui => crate::cli_tui::run_tui(ctx),
                Command::SetupCli | Command::Version | Command::Sync { .. } => {
                    unreachable!("handled above")
                }
            }
        }
    }
}

// ── data folder ──────────────────────────────────────────────────────────────

/// The app's bundle identifier (`identifier` in tauri.conf.json); the app
/// keeps its data in `<user data dir>/<identifier>`.
const APP_IDENTIFIER: &str = "work.fundamentals.theorem";

/// The folder the app keeps its data in, resolved the way Tauri resolves
/// `app_data_dir()` (the OS data folder plus the bundle identifier), without
/// building an app: no display is needed.
pub(crate) fn app_data_dir() -> Result<PathBuf, String> {
    dirs::data_dir()
        .map(|dir| dir.join(APP_IDENTIFIER))
        .ok_or_else(|| "Cannot find the user data folder (is HOME set?)".to_string())
}

/// What every library command works on: the app's data folder and its
/// database. Opening it needs no display and no `AppHandle`.
pub(crate) struct Ctx {
    pub(crate) store: crate::database::DataStore,
}

impl Ctx {
    fn open() -> Result<Self, String> {
        Self::open_at(&app_data_dir()?)
    }

    pub(crate) fn open_at(dir: &std::path::Path) -> Result<Self, String> {
        crate::database::run_schema_migrations_in(dir)?;
        Ok(Self {
            store: crate::database::DataStore::open(dir)?,
        })
    }

    pub(crate) fn dir(&self) -> &std::path::Path {
        self.store.dir()
    }

    fn kv_get(&self, key: &str) -> Result<Option<String>, String> {
        self.store
            .with_connection(|conn| crate::database::sqlite_get_kv_inner(conn, key))
    }

}

/// Whether a window system is reachable. Building a Tauri app without one
/// aborts the process, so sync checks first and explains instead.
fn display_available() -> bool {
    #[cfg(any(target_os = "linux", target_os = "freebsd", target_os = "openbsd"))]
    {
        ["WAYLAND_DISPLAY", "DISPLAY"]
            .iter()
            .any(|var| std::env::var_os(var).is_some_and(|v| !v.is_empty()))
    }
    #[cfg(not(any(target_os = "linux", target_os = "freebsd", target_os = "openbsd")))]
    {
        true
    }
}

/// Build a bare Tauri app (no plugins, no windows) with the sync subsystem
/// managed, so the `sync_commands` surface works headless.
fn with_sync_app(output: &Output, f: impl FnOnce(&tauri::AppHandle) -> i32) -> i32 {
    if !display_available() {
        return output.error(
            "sync commands run the sync engine inside the Theorem app, which needs a \
             graphical session (no WAYLAND_DISPLAY or DISPLAY is set). Run them from a \
             desktop session, or sync from the app.",
        );
    }
    let dir = match app_data_dir() {
        Ok(dir) => dir,
        Err(e) => return output.error(&e),
    };
    if let Err(e) = crate::database::run_schema_migrations_in(&dir) {
        return output.error(&e);
    }
    let app = match tauri::Builder::default().build(tauri::generate_context!()) {
        Ok(app) => app,
        Err(e) => return output.error(&format!("Failed to initialize app context: {e}")),
    };
    let handle = app.handle().clone();
    {
        use tauri::Manager;
        match crate::sync_commands::init_sync(dir, handle.clone()) {
            Ok(sync_state) => {
                app.manage(sync_state);
            }
            Err(e) => {
                app.cleanup_before_exit();
                return output.error(&format!("sync could not start: {e}"));
            }
        }
    }
    let code = f(&handle);
    app.cleanup_before_exit();
    code
}

/// Run a future to completion on a throwaway current-thread runtime.
/// Takes a factory so tokio time primitives (timeouts) are created inside
/// the runtime context — constructing them outside panics.
fn block_on<T, F>(future_factory: impl FnOnce() -> F) -> T
where
    T: Send + 'static,
    F: Future<Output = T>,
{
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            // Nothing can run without it; say why and stop, never panic.
            eprintln!("error: cannot start the async runtime: {e}");
            std::process::exit(1);
        }
    };
    // Enter the context BEFORE building the future: tokio time primitives
    // panic if constructed outside a runtime.
    let _guard = runtime.enter();
    let future = future_factory();
    runtime.block_on(future)
}

// ── dict ─────────────────────────────────────────────────────────────────────

fn run_dict(output: &Output, ctx: &Ctx, term: &str, online: bool) -> i32 {
    let started = std::time::Instant::now();
    let stardict_results = crate::stardict::lookup_all_installed(ctx.dir(), term);
    let mdx_results = mdx_lookup_all_installed(ctx, term);
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
fn mdx_lookup_all_installed(ctx: &Ctx, term: &str) -> Vec<crate::mdict::MdxEntryResult> {
    let mut results = Vec::new();
    for id in crate::stardict::list_installed_dict_ids(ctx.dir()) {
        let dict_dir = ctx.dir().join("dictionaries").join(&id);
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

fn run_search(output: &Output, ctx: &Ctx, query: &str, book_id: Option<String>) -> i32 {
    match book_id {
        None => library_search(output, ctx, query),
        Some(book_id) => in_book_search(output, ctx, &book_id, query),
    }
}

fn library_search(output: &Output, ctx: &Ctx, query: &str) -> i32 {
    match ctx
        .store
        .with_connection(|conn| crate::database::sqlite_search_books_inner(conn, query, 50))
    {
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

fn in_book_search(output: &Output, ctx: &Ctx, book_id: &str, query: &str) -> i32 {
    let path = match resolve_book_path(ctx, book_id) {
        Ok(Some(path)) => path,
        Ok(None) => {
            return output.error(&format!("book '{book_id}' not found in library"));
        }
        Err(e) => return output.error(&e),
    };

    match crate::book_search::search_epub_spine(&path, query, false, false) {
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

pub(crate) fn resolve_book_path(ctx: &Ctx, book_id: &str) -> Result<Option<PathBuf>, String> {
    crate::database::get_materialized_book_path_in(&ctx.store, book_id)
        .map(|opt| opt.map(PathBuf::from))
}

// ── library store ────────────────────────────────────────────────────────────
//
// Books live in SQLite, as the 1.6.0 app keeps them: one `book_metadata` row
// per book (the book record as JSON), a `books` row, the file in
// `book-cache/{id}.book`, the cover in `covers` and title/author in
// `books_fts`. Annotations are `book_annotations` rows. Only shelves
// (collections) and deletion tombstones are still in the app's persisted KV
// copy of the library store, `zustand:theorem-library`; its `books` and
// `annotations` lists are left alone (the app only keeps records there that
// are still waiting to move into SQLite).

const LIBRARY_KV_KEY: &str = "zustand:theorem-library";
/// The persisted library store's version in 1.6.0 (`libraryStore.ts`).
const LIBRARY_KV_VERSION: u64 = 11;
const LIBRARY_STORE: &str = "Library store";

fn empty_library_envelope() -> serde_json::Value {
    serde_json::json!({
        "state": {
            "books": [],
            "annotations": [],
            "collections": [],
            "deletionTombstones": [],
        },
        "version": LIBRARY_KV_VERSION,
    })
}

/// The `state` object of a persisted zustand envelope. A missing `state` is
/// created; anything that is not an object is an error, never a panic.
fn envelope_state<'a>(
    envelope: &'a mut serde_json::Value,
    store: &str,
) -> Result<&'a mut serde_json::Map<String, serde_json::Value>, String> {
    let root = envelope
        .as_object_mut()
        .ok_or_else(|| format!("{store} is malformed: it is not a JSON object"))?;
    let state = root.entry("state").or_insert_with(|| serde_json::json!({}));
    if state.is_null() {
        *state = serde_json::json!({});
    }
    state
        .as_object_mut()
        .ok_or_else(|| format!("{store} is malformed: \"state\" is not an object"))
}

/// A list field of a store's state, created when missing or null.
fn state_list<'a>(
    state: &'a mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    store: &str,
) -> Result<&'a mut Vec<serde_json::Value>, String> {
    let value = state.entry(key).or_insert_with(|| serde_json::json!([]));
    if value.is_null() {
        *value = serde_json::json!([]);
    }
    value
        .as_array_mut()
        .ok_or_else(|| format!("{store} is malformed: \"{key}\" is not a list"))
}

/// Read a KV envelope for a read-only command.
fn read_kv_envelope(
    ctx: &Ctx,
    key: &str,
    store: &str,
    empty: fn() -> serde_json::Value,
) -> Result<serde_json::Value, String> {
    match ctx.kv_get(key)? {
        Some(text) => serde_json::from_str(&text).map_err(|e| format!("{store} is malformed: {e}")),
        None => Ok(empty()),
    }
}

/// Read-modify-write a KV envelope inside one `BEGIN IMMEDIATE` transaction:
/// concurrent CLI writers queue on SQLite's write lock instead of reading the
/// same old copy and overwriting each other's changes. `f` also gets the
/// transaction's connection for checks that must see the same snapshot. When
/// `f` fails nothing is written.
fn update_kv_envelope<T>(
    ctx: &Ctx,
    key: &str,
    store: &str,
    empty: fn() -> serde_json::Value,
    f: impl FnOnce(&rusqlite::Connection, &mut serde_json::Value) -> Result<T, String>,
) -> Result<T, String> {
    ctx.store.with_connection(|conn| {
        let tx =
            rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
        let mut envelope = match crate::database::sqlite_get_kv_inner(&tx, key)? {
            Some(text) => match serde_json::from_str::<serde_json::Value>(&text) {
                Ok(value) => value,
                Err(e) => return Ok(Err(format!("{store} is malformed: {e}"))),
            },
            None => empty(),
        };
        let value = match f(&tx, &mut envelope) {
            Ok(value) => value,
            Err(e) => return Ok(Err(e)),
        };
        let text = match serde_json::to_string(&envelope) {
            Ok(text) => text,
            Err(e) => return Ok(Err(format!("Failed to serialize {store}: {e}"))),
        };
        crate::database::sqlite_set_kv_inner(&tx, key, &text)?;
        tx.commit()?;
        Ok(Ok(value))
    })?
}

fn update_library_kv<T>(
    ctx: &Ctx,
    f: impl FnOnce(&rusqlite::Connection, &mut serde_json::Value) -> Result<T, String>,
) -> Result<T, String> {
    update_kv_envelope(
        ctx,
        LIBRARY_KV_KEY,
        LIBRARY_STORE,
        empty_library_envelope,
        f,
    )
}

fn library_collections(ctx: &Ctx) -> Result<Vec<serde_json::Value>, String> {
    let mut envelope =
        read_kv_envelope(ctx, LIBRARY_KV_KEY, LIBRARY_STORE, empty_library_envelope)?;
    let state = envelope_state(&mut envelope, LIBRARY_STORE)?;
    Ok(state_list(state, "collections", LIBRARY_STORE)?.clone())
}

fn tombstone(entity_id: &str, entity_type: &str) -> serde_json::Value {
    serde_json::json!({
        "entityId": entity_id,
        "entityType": entity_type,
        "deletedAt": now_iso(),
    })
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

/// Every book in the library (`book_metadata`), sorted by title. Rows that
/// are not valid JSON objects are skipped.
pub(crate) fn load_books(ctx: &Ctx) -> Result<Vec<serde_json::Value>, String> {
    let rows = ctx
        .store
        .with_connection(crate::database::sqlite_load_all_books_inner)?;
    let mut books: Vec<serde_json::Value> = rows
        .iter()
        .filter_map(|json| serde_json::from_str::<serde_json::Value>(json).ok())
        .filter(|book| book.is_object() && book_str(book, "id").is_some())
        .collect();
    books.sort_by_cached_key(|book| book_title(book).to_lowercase());
    Ok(books)
}

/// One book's record, or `None` when the library has no such book.
fn load_book(ctx: &Ctx, book_id: &str) -> Result<Option<serde_json::Value>, String> {
    let raw = ctx
        .store
        .with_connection(|conn| crate::database::sqlite_get_book_metadata_inner(conn, book_id))?;
    match raw {
        None => Ok(None),
        Some(text) => serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .filter(|book| book.is_object())
            .map(Some)
            .ok_or_else(|| format!("book '{book_id}' has a malformed record")),
    }
}

fn book_not_found(book_id: &str) -> String {
    format!("book '{book_id}' not found in library")
}

/// The details a user edits; sync treats them as one unit
/// (`BOOK_EDITABLE_FIELDS` in `book-edit-stamp.ts`).
const BOOK_EDITABLE_FIELDS: &[&str] = &[
    "title",
    "author",
    "description",
    "publisher",
    "language",
    "isbn",
    "publishedDate",
    "category",
    "isFavorite",
    "tags",
    "rating",
    "completedAt",
    "manualCompletionState",
    "series",
    "seriesIndex",
];

/// Stamp an edit the way the app's `withMetadataStamp` does, so sync can tell
/// it from a concurrent edit on another device.
fn stamp_metadata_edit(before: &serde_json::Value, after: &mut serde_json::Value) {
    let edited = BOOK_EDITABLE_FIELDS
        .iter()
        .any(|field| before.get(*field) != after.get(*field));
    let Some(object) = after.as_object_mut() else {
        return;
    };
    if !edited {
        return;
    }
    object.remove("metadataBaseAt");
    object.insert("metadataUpdatedAt".into(), serde_json::json!(now_iso()));
    if let Some(previous) = before.get("metadataUpdatedAt").filter(|v| !v.is_null()) {
        object.insert("metadataBaseAt".into(), previous.clone());
    }
}

/// Edit one book's record inside a write transaction (no lost updates when
/// commands run in parallel). `f` returns the edited record, or an error.
fn update_book<T>(
    ctx: &Ctx,
    book_id: &str,
    f: impl FnOnce(&mut serde_json::Value) -> Result<T, String>,
) -> Result<T, String> {
    ctx.store.with_connection(|conn| {
        let tx =
            rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
        let Some(text) = crate::database::sqlite_get_book_metadata_inner(&tx, book_id)? else {
            return Ok(Err(book_not_found(book_id)));
        };
        let Some(before) = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .filter(|b| b.is_object())
        else {
            return Ok(Err(format!("book '{book_id}' has a malformed record")));
        };
        let mut after = before.clone();
        let value = match f(&mut after) {
            Ok(value) => value,
            Err(e) => return Ok(Err(e)),
        };
        stamp_metadata_edit(&before, &mut after);
        let json = match serde_json::to_string(&after) {
            Ok(json) => json,
            Err(e) => return Ok(Err(e.to_string())),
        };
        crate::database::sqlite_save_book_metadata_inner(&tx, book_id, &json)?;
        tx.commit()?;
        Ok(Ok(value))
    })?
}

// ── library ──────────────────────────────────────────────────────────────────

fn run_library(output: &Output, ctx: &Ctx, command: LibraryCommand) -> i32 {
    match command {
        LibraryCommand::List { format } => library_list(output, ctx, &format),
        LibraryCommand::Info { book_id } => library_info(output, ctx, &book_id),
        LibraryCommand::Add { paths } => library_add(output, ctx, &paths),
        LibraryCommand::Import { dir } => library_import(output, ctx, &dir),
        LibraryCommand::Remove { book_id } => library_remove(output, ctx, &book_id),
        LibraryCommand::Favorite { book_id, state } => {
            library_favorite(output, ctx, &book_id, state.as_deref())
        }
        LibraryCommand::Export { book_id, out } => library_export(output, ctx, &book_id, out),
        LibraryCommand::EditMeta {
            book_id,
            title,
            author,
        } => library_edit_meta(output, ctx, &book_id, title, author),
    }
}

fn library_list(output: &Output, ctx: &Ctx, format: &str) -> i32 {
    let books = match load_books(ctx) {
        Ok(books) => books,
        Err(e) => return output.error(&e),
    };

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

fn library_info(output: &Output, ctx: &Ctx, book_id: &str) -> i32 {
    let book = match load_book(ctx, book_id) {
        Ok(Some(book)) => book,
        Ok(None) => return output.error(&book_not_found(book_id)),
        Err(e) => return output.error(&e),
    };

    let annotation_count: i64 = ctx
        .store
        .with_connection(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM book_annotations WHERE book_id = ?1",
                rusqlite::params![book_id],
                |row| row.get(0),
            )
        })
        .unwrap_or(0);

    let materialized = crate::database::get_materialized_book_path_in(&ctx.store, book_id)
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
        "series": book.get("series"),
        "seriesIndex": book.get("seriesIndex"),
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
            book_str(&book, "format").unwrap_or("?")
        );
        if let Some(series) = book_str(&book, "series") {
            match book.get("seriesIndex").and_then(|v| v.as_f64()) {
                Some(index) => println!("  {}: {series} #{index}", output.dim("series")),
                None => println!("  {}: {series}", output.dim("series")),
            }
        }
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

fn library_add(output: &Output, ctx: &Ctx, paths: &[String]) -> i32 {
    if paths.is_empty() {
        eprintln!("usage: theorem library add <files...> | theorem library import <dir>");
        return EXIT_USAGE;
    }
    ingest_and_register(output, ctx, paths)
}

const SUPPORTED_EXTENSIONS: &[&str] = &[
    "epub", "mobi", "azw", "azw3", "fb2", "fbz", "pdf", "cbz", "cbr",
];

fn is_supported_book_file(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| SUPPORTED_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Every supported book file under `root`, recursively, sorted. Symlinked
/// folders are followed, but each real folder is visited once, so a symlink
/// loop ends instead of recursing forever.
fn collect_book_files(root: &std::path::Path) -> Result<Vec<PathBuf>, String> {
    let root = std::fs::canonicalize(root)
        .map_err(|e| format!("Cannot read directory {}: {e}", root.display()))?;
    if !root.is_dir() {
        return Err(format!("{} is not a directory", root.display()));
    }
    let mut visited = std::collections::HashSet::new();
    let mut files = Vec::new();
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        let Ok(real) = std::fs::canonicalize(&dir) else {
            continue;
        };
        if !visited.insert(real) {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // `metadata` follows symlinks: a link to a folder is a folder.
            match std::fs::metadata(&path) {
                Ok(meta) if meta.is_dir() => stack.push(path),
                Ok(meta) if meta.is_file() && is_supported_book_file(&path) => files.push(path),
                _ => {}
            }
        }
    }
    files.sort();
    files.dedup();
    Ok(files)
}

fn library_import(output: &Output, ctx: &Ctx, dir: &str) -> i32 {
    let files = match collect_book_files(std::path::Path::new(dir)) {
        Ok(files) => files,
        Err(e) => return output.error(&e),
    };
    if files.is_empty() {
        output.note(&format!("no supported book files found under {dir}"));
        if output.json {
            return output.print_json(&ImportReport::default());
        }
        return 0;
    }
    let files: Vec<String> = files
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    ingest_and_register(output, ctx, &files)
}

/// What happened to each file of an import.
#[derive(Default, Serialize)]
struct ImportReport {
    added: Vec<serde_json::Value>,
    duplicates: Vec<ImportDuplicate>,
    failed: Vec<ImportFailure>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportDuplicate {
    path: String,
    existing_id: String,
    title: String,
}

#[derive(Serialize)]
struct ImportFailure {
    path: String,
    error: String,
}

enum Ingested {
    Added(Box<crate::batch_ingest::NativeBookRecord>),
    Duplicate { existing_id: String, title: String },
}

/// The absolute form of a path given on the command line (symlinks
/// resolved), so the stored `filePath` still points at the file later.
fn absolute_path(raw: &str) -> String {
    let path = std::path::Path::new(raw);
    std::fs::canonicalize(path)
        .or_else(|_| std::env::current_dir().map(|cwd| cwd.join(path)))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| raw.to_string())
}

/// Content hashes already in the library, mapped to (book id, title).
fn library_content_hashes(ctx: &Ctx) -> Result<HashMap<String, (String, String)>, String> {
    Ok(load_books(ctx)?
        .iter()
        .filter_map(|book| {
            let hash = book_str(book, "contentHash")?.trim().to_ascii_lowercase();
            if hash.is_empty() {
                return None;
            }
            Some((
                hash,
                (
                    book_str(book, "id").unwrap_or("").to_string(),
                    book_title(book),
                ),
            ))
        })
        .collect())
}

/// Parse and copy each file into `book-cache/`, in parallel, the way the
/// app's `ingest_books_native` command does (that command reports progress
/// through an `AppHandle`, which the CLI has none of, and drops the reasons
/// files fail). A file whose content is already in the library is not
/// copied. Returns each path with its outcome, in input order.
fn ingest_files(
    ctx: &Ctx,
    paths: &[String],
    known: &HashMap<String, (String, String)>,
) -> Vec<(String, Result<Ingested, String>)> {
    use rayon::prelude::*;
    let cache_dir = ctx.dir().join("book-cache");
    let _ = std::fs::create_dir_all(&cache_dir);
    paths
        .par_iter()
        .map(|raw_path| {
            let absolute = absolute_path(raw_path);
            let outcome = ingest_file(&cache_dir, &absolute, known);
            (absolute, outcome)
        })
        .collect()
}

fn ingest_file(
    cache_dir: &std::path::Path,
    file_path: &str,
    known: &HashMap<String, (String, String)>,
) -> Result<Ingested, String> {
    let path = std::path::Path::new(file_path);
    if !path.exists() {
        return Err("file does not exist".to_string());
    }
    if !path.is_file() {
        return Err("not a file".to_string());
    }
    if !is_supported_book_file(path) {
        return Err(format!(
            "unsupported file type (supported: {})",
            SUPPORTED_EXTENSIONS.join(", ")
        ));
    }
    let content_hash = crate::batch_ingest::compute_file_sha256(path)
        .ok_or_else(|| "cannot read the file".to_string())?;
    if let Some((existing_id, title)) = known.get(&content_hash) {
        return Ok(Ingested::Duplicate {
            existing_id: existing_id.clone(),
            title: title.clone(),
        });
    }
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let metadata = match ext.as_str() {
        "epub" => crate::batch_ingest::parse_epub_native(path)?,
        "cbz" => crate::batch_ingest::parse_cbz_native(path)?,
        "cbr" => crate::cbr::parse_cbr_native(path)?,
        _ => {
            let (title, author) = crate::batch_ingest::parse_title_author_from_filename(path);
            crate::batch_ingest::ParsedMetadata {
                title,
                author,
                description: None,
                publisher: None,
                published_date: None,
                language: None,
                isbn: None,
                cover_data_url: None,
                series: None,
                series_index: None,
            }
        }
    };

    let file_size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if file_size == 0 {
        return Err("the file is empty".to_string());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let dest_path = cache_dir.join(format!("{id}.book"));
    let format = if ext == "cbr" {
        match crate::cbr::convert_cbr_to_cbz_file(path, &dest_path) {
            Ok(()) => "cbz".to_string(),
            // As the app does: keep the original archive when it cannot be
            // converted.
            Err(_) => {
                std::fs::copy(path, &dest_path)
                    .map_err(|e| format!("cannot copy the file into the library: {e}"))?;
                ext
            }
        }
    } else {
        std::fs::copy(path, &dest_path)
            .map_err(|e| format!("cannot copy the file into the library: {e}"))?;
        ext
    };

    Ok(Ingested::Added(Box::new(
        crate::batch_ingest::NativeBookRecord {
            id,
            title: metadata.title,
            author: metadata.author,
            file_path: file_path.to_string(),
            storage_path: Some(dest_path.to_string_lossy().into_owned()),
            format,
            content_hash: Some(content_hash),
            cover_extraction_done: metadata.cover_data_url.is_some(),
            cover_path: metadata.cover_data_url,
            description: metadata.description,
            publisher: metadata.publisher,
            published_date: metadata.published_date,
            language: metadata.language,
            isbn: metadata.isbn,
            series: metadata.series,
            series_index: metadata.series_index,
            file_size,
            added_at: now_iso(),
            progress: 0.0,
            is_favorite: false,
            tags: Vec::new(),
        },
    )))
}

/// Covers shorter than this stay inline in the book record (the app's
/// `INLINE_COVER_MAX_CHARS`); longer ones are served from the `covers` table,
/// and the app fills in their display address when it loads the library.
const INLINE_COVER_MAX_CHARS: usize = 5000;

/// The book record the app stores for an imported file (`importBooksIncremental`).
fn book_record_json(record: &crate::batch_ingest::NativeBookRecord) -> serde_json::Value {
    let mut book = serde_json::json!({
        "id": record.id,
        "title": record.title,
        "author": record.author,
        "filePath": record.file_path,
        "storagePath": record.storage_path,
        "format": record.format,
        "contentHash": record.content_hash,
        "coverExtractionDone": record.cover_extraction_done,
        "fileSize": record.file_size,
        "readingTime": 0,
        "addedAt": record.added_at,
        "progress": 0,
        "isFavorite": false,
        "tags": [],
    });
    let optional = [
        (
            "description",
            record.description.clone().map(serde_json::Value::from),
        ),
        (
            "publisher",
            record.publisher.clone().map(serde_json::Value::from),
        ),
        (
            "publishedDate",
            record.published_date.clone().map(serde_json::Value::from),
        ),
        (
            "language",
            record.language.clone().map(serde_json::Value::from),
        ),
        ("isbn", record.isbn.clone().map(serde_json::Value::from)),
        ("series", record.series.clone().map(serde_json::Value::from)),
        (
            "seriesIndex",
            record.series_index.map(serde_json::Value::from),
        ),
        (
            "coverPath",
            record
                .cover_path
                .clone()
                .filter(|url| url.len() < INLINE_COVER_MAX_CHARS)
                .map(serde_json::Value::from),
        ),
    ];
    if let Some(object) = book.as_object_mut() {
        for (key, value) in optional {
            if let Some(value) = value {
                object.insert(key.to_string(), value);
            }
        }
    }
    book
}

/// Register imported books exactly as the app does: the metadata row (which
/// also inserts the `books` row and the search entry), the materialized-file
/// row and the cover, all in one transaction.
fn register_books(
    ctx: &Ctx,
    records: &[&crate::batch_ingest::NativeBookRecord],
) -> Result<Vec<serde_json::Value>, String> {
    let books: Vec<serde_json::Value> = records.iter().map(|r| book_record_json(r)).collect();
    ctx.store.with_connection(|conn| {
        let tx =
            rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
        for (record, book) in records.iter().zip(&books) {
            let json = book.to_string();
            crate::database::sqlite_save_book_metadata_inner(&tx, &record.id, &json)?;
            crate::database::sqlite_register_materialized_book_inner(&tx, &record.id)?;
            if let Some(cover) = &record.cover_path {
                crate::database::sqlite_save_cover_image_inner(&tx, &record.id, cover)?;
            }
        }
        tx.commit()
    })?;
    Ok(books)
}

fn ingest_and_register(output: &Output, ctx: &Ctx, paths: &[String]) -> i32 {
    let known = match library_content_hashes(ctx) {
        Ok(known) => known,
        Err(e) => return output.error(&e),
    };
    let outcomes = ingest_files(ctx, paths, &known);

    let mut report = ImportReport::default();
    let mut seen: HashMap<String, (String, String)> = HashMap::new();
    let mut to_register = Vec::new();
    for (path, outcome) in &outcomes {
        match outcome {
            Ok(Ingested::Added(record)) => {
                let hash = record.content_hash.clone().unwrap_or_default();
                // The same content twice in one import: keep the first.
                if let Some((existing_id, title)) = seen.get(&hash) {
                    if let Some(storage) = &record.storage_path {
                        let _ = std::fs::remove_file(storage);
                    }
                    report.duplicates.push(ImportDuplicate {
                        path: path.clone(),
                        existing_id: existing_id.clone(),
                        title: title.clone(),
                    });
                    continue;
                }
                seen.insert(hash, (record.id.clone(), record.title.clone()));
                to_register.push(record.as_ref());
            }
            Ok(Ingested::Duplicate { existing_id, title }) => {
                report.duplicates.push(ImportDuplicate {
                    path: path.clone(),
                    existing_id: existing_id.clone(),
                    title: title.clone(),
                })
            }
            Err(error) => report.failed.push(ImportFailure {
                path: path.clone(),
                error: error.clone(),
            }),
        }
    }

    match register_books(ctx, &to_register) {
        Ok(books) => report.added = books,
        Err(e) => {
            // Nothing was registered: do not leave orphaned copies behind.
            for record in &to_register {
                if let Some(storage) = &record.storage_path {
                    let _ = std::fs::remove_file(storage);
                }
            }
            return output.error(&e);
        }
    }

    let code = if report.failed.is_empty() { 0 } else { 1 };
    if output.json {
        let printed = output.print_json(&report);
        return if printed != 0 { printed } else { code };
    }
    for book in &report.added {
        println!(
            "{} {}",
            output.green("added"),
            output.bold(&format!("{} — {}", book_title(book), book_author(book)))
        );
    }
    for duplicate in &report.duplicates {
        println!(
            "{} {} {}",
            output.dim("skipped"),
            duplicate.path,
            output.dim(&format!(
                "(already in the library as '{}', {})",
                duplicate.title, duplicate.existing_id
            ))
        );
    }
    for failure in &report.failed {
        eprintln!(
            "{} {}: {}",
            output.red("failed"),
            failure.path,
            failure.error
        );
    }
    output.note(&format!(
        "# {} imported, {} skipped (duplicates), {} failed",
        report.added.len(),
        report.duplicates.len(),
        report.failed.len()
    ));
    code
}

fn library_remove(output: &Output, ctx: &Ctx, book_id: &str) -> i32 {
    let book = match load_book(ctx, book_id) {
        Ok(Some(book)) => book,
        Ok(None) => return output.error(&book_not_found(book_id)),
        Err(e) => return output.error(&e),
    };
    let title = book_title(&book);

    // Collect annotation ids first for tombstones (the rows are about to go).
    let annotation_ids: Vec<String> = match ctx.store.with_connection(|conn| {
        let mut stmt = conn.prepare("SELECT id FROM book_annotations WHERE book_id = ?1")?;
        let rows = stmt.query_map(rusqlite::params![book_id], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    }) {
        Ok(ids) => ids,
        Err(e) => return output.error(&e),
    };

    // Same path as the app: removes the cached file and, in one transaction,
    // the book's covers, metadata, highlights and search row.
    if let Err(e) = crate::database::delete_book_data_in(&ctx.store, book_id) {
        return output.error(&e);
    }

    // As the app's `removeBooks`: leave every shelf, and tombstones so sync
    // removes the book and its highlights on other devices too.
    let kv = update_library_kv(ctx, |_, envelope| {
        let state = envelope_state(envelope, LIBRARY_STORE)?;
        for collection in state_list(state, "collections", LIBRARY_STORE)?.iter_mut() {
            if let Some(ids) = collection.get_mut("bookIds").and_then(|v| v.as_array_mut()) {
                ids.retain(|id| id.as_str() != Some(book_id));
            }
        }
        let tombstones = state_list(state, "deletionTombstones", LIBRARY_STORE)?;
        tombstones.push(tombstone(book_id, "book"));
        for annotation_id in &annotation_ids {
            tombstones.push(tombstone(annotation_id, "annotation"));
        }
        Ok(())
    });
    if let Err(e) = kv {
        return output.error(&e);
    }

    if output.json {
        output.print_json(&serde_json::json!({ "removed": book_id, "title": title }))
    } else {
        println!("{} {title}", output.green("removed"));
        0
    }
}

fn library_favorite(output: &Output, ctx: &Ctx, book_id: &str, state: Option<&str>) -> i32 {
    let wanted = match state.unwrap_or("toggle") {
        "on" | "true" | "yes" => Some(true),
        "off" | "false" | "no" => Some(false),
        "toggle" => None,
        other => {
            eprintln!("error: invalid state '{other}' (expected on, off or toggle)");
            return EXIT_USAGE;
        }
    };
    let result = update_book(ctx, book_id, |book| {
        let current = book
            .get("isFavorite")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let next = wanted.unwrap_or(!current);
        book["isFavorite"] = serde_json::Value::Bool(next);
        Ok((next, book_title(book)))
    });
    let (next, title) = match result {
        Ok(result) => result,
        Err(e) => return output.error(&e),
    };

    if output.json {
        output.print_json(&serde_json::json!({ "id": book_id, "isFavorite": next }))
    } else {
        let label = if next { "favorited" } else { "unfavorited" };
        println!("{} {title}", output.green(label));
        0
    }
}

fn library_export(output: &Output, ctx: &Ctx, book_id: &str, out: Option<PathBuf>) -> i32 {
    let book = match load_book(ctx, book_id) {
        Ok(Some(book)) => book,
        Ok(None) => return output.error(&book_not_found(book_id)),
        Err(e) => return output.error(&e),
    };

    let format = book_str(&book, "format").unwrap_or("epub").to_string();
    let source = match crate::database::get_materialized_book_path_in(&ctx.store, book_id) {
        Ok(Some(path)) => PathBuf::from(path),
        Ok(None) => return output.error("book file not found on disk or in storage"),
        Err(e) => return output.error(&e),
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
        let title = if title.is_empty() {
            book_id.to_string()
        } else {
            title
        };
        PathBuf::from(format!("{title}.{format}"))
    });
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return output.error(&format!("Cannot create {}: {e}", parent.display()));
            }
        }
    }
    let bytes = match std::fs::copy(&source, &target) {
        Ok(bytes) => bytes,
        Err(e) => return output.error(&format!("Failed to write {}: {e}", target.display())),
    };

    if output.json {
        output.print_json(&serde_json::json!({
            "id": book_id,
            "path": target.display().to_string(),
            "bytes": bytes,
        }))
    } else {
        println!(
            "{} {} ({} bytes)",
            output.green("exported"),
            output.bold(&target.display().to_string()),
            bytes
        );
        0
    }
}

fn library_edit_meta(
    output: &Output,
    ctx: &Ctx,
    book_id: &str,
    title: Option<String>,
    author: Option<String>,
) -> i32 {
    if title.is_none() && author.is_none() {
        eprintln!("usage: theorem library edit-meta <book-id> --title <title> --author <author>");
        return EXIT_USAGE;
    }

    let book = match load_book(ctx, book_id) {
        Ok(Some(book)) => book,
        Ok(None) => return output.error(&book_not_found(book_id)),
        Err(e) => return output.error(&e),
    };
    let is_epub = book_str(&book, "format")
        .map(|f| f.eq_ignore_ascii_case("epub"))
        .unwrap_or(false);

    let mut file_rewritten = false;
    if is_epub {
        match crate::database::get_materialized_book_path_in(&ctx.store, book_id) {
            Ok(Some(path)) => {
                let edit = crate::epub_rewriter::EpubMetadataEdit {
                    title: title.clone(),
                    author: author.clone(),
                    ..Default::default()
                };
                if let Err(e) = crate::epub_rewriter::rewrite_epub_metadata_at(
                    std::path::Path::new(&path),
                    book_id,
                    Some(edit),
                    None,
                ) {
                    return output.error(&e);
                }
                file_rewritten = true;
            }
            Ok(None) => {
                output.note("the book's file is not on this device — updating the library only")
            }
            Err(e) => return output.error(&e),
        }
    } else {
        output.note("file is not an EPUB — updating the library index only");
    }

    // The metadata save also refreshes the search entry.
    let updated = update_book(ctx, book_id, |book| {
        if let Some(t) = &title {
            book["title"] = serde_json::Value::String(t.clone());
        }
        if let Some(a) = &author {
            book["author"] = serde_json::Value::String(a.clone());
        }
        Ok((book_title(book), book_author(book)))
    });
    let (new_title, new_author) = match updated {
        Ok(updated) => updated,
        Err(e) => return output.error(&e),
    };

    if output.json {
        output.print_json(&serde_json::json!({
            "id": book_id,
            "title": new_title,
            "author": new_author,
            "fileRewritten": file_rewritten,
        }))
    } else {
        println!("{} {}", output.green("updated"), output.bold(&new_title));
        0
    }
}

// ── shelves ──────────────────────────────────────────────────────────────────

fn run_shelf(output: &Output, ctx: &Ctx, command: ShelfCommand) -> i32 {
    match command {
        ShelfCommand::List => shelf_list(output, ctx),
        ShelfCommand::Create { name } => shelf_create(output, ctx, &name),
        ShelfCommand::Delete { shelf } => shelf_delete(output, ctx, &shelf),
        ShelfCommand::Add { shelf, book_id } => shelf_add(output, ctx, &shelf, &book_id, true),
        ShelfCommand::Remove { shelf, book_id } => shelf_add(output, ctx, &shelf, &book_id, false),
    }
}

fn shelf_list(output: &Output, ctx: &Ctx) -> i32 {
    let collections = match library_collections(ctx) {
        Ok(collections) => collections,
        Err(e) => return output.error(&e),
    };

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

fn shelf_create(output: &Output, ctx: &Ctx, name: &str) -> i32 {
    let name = name.trim();
    if name.is_empty() {
        eprintln!("error: a shelf needs a name");
        return EXIT_USAGE;
    }
    let id = uuid::Uuid::new_v4().to_string();
    let created = update_library_kv(ctx, |_, envelope| {
        let state = envelope_state(envelope, LIBRARY_STORE)?;
        let collections = state_list(state, "collections", LIBRARY_STORE)?;
        if collections.iter().any(|c| {
            book_str(c, "name")
                .map(|n| n.eq_ignore_ascii_case(name))
                .unwrap_or(false)
        }) {
            return Err(format!("shelf '{name}' already exists"));
        }
        collections.push(serde_json::json!({
            "id": id,
            "name": name,
            "bookIds": [],
            "kind": "general",
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
        }));
        Ok(())
    });
    if let Err(e) = created {
        return output.error(&e);
    }

    if output.json {
        output.print_json(&serde_json::json!({ "id": id, "name": name }))
    } else {
        println!("{} {}", output.green("created"), output.bold(name));
        0
    }
}

fn shelf_delete(output: &Output, ctx: &Ctx, shelf: &str) -> i32 {
    let deleted = update_library_kv(ctx, |_, envelope| {
        let state = envelope_state(envelope, LIBRARY_STORE)?;
        let collections = state_list(state, "collections", LIBRARY_STORE)?;
        let position = find_collection_position(collections, shelf)
            .ok_or_else(|| format!("shelf '{shelf}' not found"))?;
        let removed = collections.remove(position);
        let removed_id = book_str(&removed, "id").unwrap_or("?").to_string();
        let removed_name = book_str(&removed, "name")
            .unwrap_or("(unnamed)")
            .to_string();
        state_list(state, "deletionTombstones", LIBRARY_STORE)?
            .push(tombstone(&removed_id, "collection"));
        Ok((removed_id, removed_name))
    });
    let (removed_id, removed_name) = match deleted {
        Ok(deleted) => deleted,
        Err(e) => return output.error(&e),
    };

    if output.json {
        output.print_json(&serde_json::json!({ "deleted": removed_id, "name": removed_name }))
    } else {
        println!("{} {removed_name}", output.green("deleted"));
        0
    }
}

fn book_exists(conn: &rusqlite::Connection, book_id: &str) -> Result<bool, String> {
    crate::database::sqlite_get_book_metadata_inner(conn, book_id)
        .map(|row| row.is_some())
        .map_err(|e| e.to_string())
}

fn shelf_add(output: &Output, ctx: &Ctx, shelf: &str, book_id: &str, add: bool) -> i32 {
    let changed = update_library_kv(ctx, |conn, envelope| {
        let state = envelope_state(envelope, LIBRARY_STORE)?;
        let collections = state_list(state, "collections", LIBRARY_STORE)?;
        let position = find_collection_position(collections, shelf)
            .ok_or_else(|| format!("shelf '{shelf}' not found"))?;
        if add && !book_exists(conn, book_id)? {
            return Err(book_not_found(book_id));
        }
        let collection = collections[position].as_object_mut().ok_or_else(|| {
            format!("{LIBRARY_STORE} is malformed: shelf '{shelf}' is not an object")
        })?;
        let collection_id = collection
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("?")
            .to_string();
        let book_ids = state_list(collection, "bookIds", LIBRARY_STORE)?;
        let already = book_ids.iter().any(|b| b.as_str() == Some(book_id));
        if add == already {
            return Ok(false);
        }
        if add {
            book_ids.push(serde_json::Value::String(book_id.to_string()));
        } else {
            book_ids.retain(|b| b.as_str() != Some(book_id));
        }
        collection.insert("updatedAt".into(), serde_json::json!(now_iso()));
        if !add {
            state_list(state, "deletionTombstones", LIBRARY_STORE)?.push(tombstone(
                &format!("{collection_id}:{book_id}"),
                "collection_book",
            ));
        }
        Ok(true)
    });
    match changed {
        Ok(true) => {}
        Ok(false) => {
            output.note(if add {
                "book already on shelf"
            } else {
                "book not on shelf"
            });
            if output.json {
                return output.print_json(&serde_json::json!({
                    "shelf": shelf,
                    "bookId": book_id,
                    "action": "none",
                }));
            }
            return 0;
        }
        Err(e) => return output.error(&e),
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

// ── highlights + bookmarks ───────────────────────────────────────────────────

fn run_highlights(output: &Output, ctx: &Ctx, command: HighlightsCommand) -> i32 {
    match command {
        HighlightsCommand::List { book } => highlights_list(output, ctx, book.as_deref(), false),
        HighlightsCommand::Add {
            book_id,
            text,
            note,
            r#type,
            color,
        } => highlights_add(
            output,
            ctx,
            &book_id,
            &text,
            note.as_deref(),
            &r#type,
            &color,
        ),
        HighlightsCommand::Delete { annotation_id } => {
            highlights_delete(output, ctx, &annotation_id)
        }
    }
}

/// Annotations from `book_annotations`, each with its `bookId`.
fn load_annotations(ctx: &Ctx, book: Option<&str>) -> Result<Vec<serde_json::Value>, String> {
    let rows: Vec<(String, String)> = ctx.store.with_connection(|conn| {
        let mut stmt = conn.prepare(
            "SELECT book_id, annotation_json FROM book_annotations \
             WHERE (?1 IS NULL OR book_id = ?1) ORDER BY book_id, updated_at",
        )?;
        let mapped = stmt.query_map(rusqlite::params![book], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        mapped.collect::<rusqlite::Result<Vec<_>>>()
    })?;
    Ok(rows
        .into_iter()
        .filter_map(|(book_id, json)| {
            let mut value = serde_json::from_str::<serde_json::Value>(&json).ok()?;
            value
                .as_object_mut()?
                .insert("bookId".into(), serde_json::Value::String(book_id));
            Some(value)
        })
        .collect())
}

fn highlights_list(output: &Output, ctx: &Ctx, book: Option<&str>, bookmarks: bool) -> i32 {
    match load_annotations(ctx, book) {
        Ok(items) => {
            let items: Vec<serde_json::Value> = items
                .into_iter()
                .filter(|a| !bookmarks || book_str(a, "type") == Some("bookmark"))
                .collect();
            output.print_json(&items)
        }
        Err(e) => output.error(&e),
    }
}

fn highlights_add(
    output: &Output,
    ctx: &Ctx,
    book_id: &str,
    text: &str,
    note: Option<&str>,
    annotation_type: &str,
    color: &str,
) -> i32 {
    let annotation_type = match annotation_type {
        "highlight" | "note" => annotation_type.to_string(),
        other => {
            eprintln!("error: invalid --type '{other}' (highlight or note)");
            return EXIT_USAGE;
        }
    };

    let id = uuid::Uuid::new_v4().to_string();
    let mut annotation = serde_json::json!({
        "id": id,
        "bookId": book_id,
        "type": annotation_type,
        "location": "",
        "selectedText": text,
        "color": color,
        "createdAt": now_iso(),
    });
    if let Some(note) = note {
        annotation["noteContent"] = serde_json::Value::String(note.to_string());
    }
    let json = annotation.to_string();

    // As the app's `addAnnotation`: one `book_annotations` row.
    let added = ctx.store.with_connection(|conn| {
        if crate::database::sqlite_get_book_metadata_inner(conn, book_id)?.is_none() {
            return Ok(false);
        }
        crate::database::sqlite_upsert_annotation_inner(conn, &id, book_id, &json)?;
        Ok(true)
    });
    match added {
        Ok(true) => {}
        Ok(false) => return output.error(&book_not_found(book_id)),
        Err(e) => return output.error(&e),
    }

    if output.json {
        output.print_json(&serde_json::json!({ "id": id, "bookId": book_id }))
    } else {
        println!("{} annotation {id}", output.green("added"));
        0
    }
}

fn highlights_delete(output: &Output, ctx: &Ctx, annotation_id: &str) -> i32 {
    // As the app's `removeAnnotation`: delete the row and leave a tombstone.
    let deleted = update_library_kv(ctx, |conn, envelope| {
        let exists = conn
            .query_row(
                "SELECT 1 FROM book_annotations WHERE id = ?1",
                rusqlite::params![annotation_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .is_some();
        if !exists {
            return Err(format!("annotation '{annotation_id}' not found"));
        }
        crate::database::sqlite_delete_annotation_inner(conn, annotation_id)
            .map_err(|e| e.to_string())?;
        let state = envelope_state(envelope, LIBRARY_STORE)?;
        state_list(state, "deletionTombstones", LIBRARY_STORE)?
            .push(tombstone(annotation_id, "annotation"));
        Ok(())
    });
    if let Err(e) = deleted {
        return output.error(&e);
    }

    if output.json {
        output.print_json(&serde_json::json!({ "deleted": annotation_id }))
    } else {
        println!("{} {annotation_id}", output.green("deleted"));
        0
    }
}

fn run_bookmarks(output: &Output, ctx: &Ctx, command: BookmarksCommand) -> i32 {
    let BookmarksCommand::List { book } = command;
    highlights_list(output, ctx, book.as_deref(), true)
}

// ── feeds (RSS) ──────────────────────────────────────────────────────────────

// Feeds live in SQLite (`rss_feeds`, `rss_articles`, `rss_article_content`),
// as the 1.6.0 app keeps them; parsing is the app's `rss_parser`. A removed
// feed leaves a tombstone in the library store, as the app's `removeFeed`.

/// How the app compares feed and article addresses (`normalizeUrl` in
/// `rssStore.ts`): lower case, no trailing slashes.
fn normalize_feed_url(url: &str) -> String {
    url.trim().to_lowercase().trim_end_matches('/').to_string()
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// A feed's date (RFC 2822 for RSS, RFC 3339 for Atom) in milliseconds.
fn parse_feed_date(raw: &str) -> Option<i64> {
    let raw = raw.trim();
    chrono::DateTime::parse_from_rfc2822(raw)
        .or_else(|_| chrono::DateTime::parse_from_rfc3339(raw))
        .ok()
        .map(|date| date.timestamp_millis())
}

/// Fetch and parse a feed. Network failures are `Err((EXIT_NETWORK, …))`,
/// anything that is not a feed `Err((1, …))`.
fn fetch_feed(url: &str) -> Result<crate::rss_parser::ParsedFeed, (i32, String)> {
    let client = crate::shared_http_client().map_err(|e| (EXIT_NETWORK, e))?;
    let response = client
        .get(url)
        .header(
            reqwest::header::ACCEPT,
            "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5",
        )
        .send()
        .map_err(|e| (EXIT_NETWORK, format!("cannot fetch {url}: {e}")))?;
    if !response.status().is_success() {
        return Err((EXIT_NETWORK, format!("HTTP {} for {url}", response.status())));
    }
    let bytes = response
        .bytes()
        .map_err(|e| (EXIT_NETWORK, format!("cannot read {url}: {e}")))?;
    if !crate::rss_parser::is_feed_document(&bytes) {
        return Err((1, format!("{url} is not an RSS or Atom feed")));
    }
    crate::rss_parser::parse_feed_bytes(&bytes).map_err(|e| (1, format!("{url}: {e}")))
}

/// Save the articles whose address is not in `known` (normalized); returns
/// how many were new.
fn save_new_articles(
    conn: &rusqlite::Connection,
    feed_id: &str,
    parsed: &crate::rss_parser::ParsedFeed,
    known: &mut std::collections::HashSet<String>,
    fetched_at: i64,
) -> rusqlite::Result<u32> {
    let mut added = 0;
    for article in parsed.articles.iter() {
        if !known.insert(normalize_feed_url(&article.url)) {
            continue;
        }
        let row = crate::database::RssArticleDto {
            id: uuid::Uuid::new_v4().to_string().into(),
            feed_id: feed_id.into(),
            title: article.title.clone(),
            author: article.author.clone(),
            url: article.url.clone(),
            summary: article.summary.clone(),
            content_source: None,
            image_url: article.image_url.clone(),
            published_at: article.published_at.as_deref().and_then(parse_feed_date),
            fetched_at: Some(fetched_at),
            is_read: false,
            is_favorite: false,
            is_saved: false,
            progress: None,
        };
        crate::database::sqlite_save_rss_article_inner(conn, &row, Some(&article.content), None)?;
        added += 1;
    }
    Ok(added)
}

fn article_urls(conn: &rusqlite::Connection, feed_id: Option<&str>) -> rusqlite::Result<std::collections::HashSet<String>> {
    let mut stmt =
        conn.prepare("SELECT url FROM rss_articles WHERE (?1 IS NULL OR feed_id = ?1)")?;
    let rows = stmt.query_map(rusqlite::params![feed_id], |row| row.get::<_, String>(0))?;
    rows.map(|url| url.map(|u| normalize_feed_url(&u))).collect()
}

fn unread_count(conn: &rusqlite::Connection, feed_id: &str) -> rusqlite::Result<u32> {
    conn.query_row(
        "SELECT COUNT(*) FROM rss_articles WHERE feed_id = ?1 AND is_read = 0",
        rusqlite::params![feed_id],
        |row| row.get(0),
    )
}

fn load_feeds(ctx: &Ctx) -> Result<Vec<crate::database::RssFeedDto>, String> {
    ctx.store
        .with_connection(crate::database::sqlite_get_rss_feeds_inner)
}

fn run_feeds(output: &Output, ctx: &Ctx, command: FeedsCommand) -> i32 {
    match command {
        FeedsCommand::List => feeds_list(output, ctx),
        FeedsCommand::Add { url } => feeds_add(output, ctx, &url),
        FeedsCommand::Remove { feed } => feeds_remove(output, ctx, &feed),
        FeedsCommand::Refresh => feeds_refresh(output, ctx),
    }
}

fn feeds_list(output: &Output, ctx: &Ctx) -> i32 {
    let feeds = match load_feeds(ctx) {
        Ok(feeds) => feeds,
        Err(e) => return output.error(&e),
    };
    if output.json {
        return output.print_json(&feeds);
    }
    for feed in &feeds {
        let error = feed
            .error_message
            .as_deref()
            .map(|e| format!("  error: {e}"))
            .unwrap_or_default();
        println!(
            "{}  {}  {}{}",
            output.dim(&feed.id),
            output.bold(&feed.title),
            output.dim(&format!("({} unread) {}", feed.unread_count, feed.url)),
            output.red(&error)
        );
    }
    output.note(&format!("# {} feeds", feeds.len()));
    0
}

fn feeds_add(output: &Output, ctx: &Ctx, url: &str) -> i32 {
    let url = url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        eprintln!("error: a feed address starts with http:// or https://");
        return EXIT_USAGE;
    }
    match load_feeds(ctx) {
        Ok(feeds) => {
            let wanted = normalize_feed_url(url);
            if feeds.iter().any(|f| normalize_feed_url(&f.url) == wanted) {
                return output.error(&format!("feed already subscribed: {url}"));
            }
        }
        Err(e) => return output.error(&e),
    }
    let parsed = match fetch_feed(url) {
        Ok(parsed) => parsed,
        Err((code, e)) => {
            output.error(&e);
            return code;
        }
    };

    let id = uuid::Uuid::new_v4().to_string();
    let now = now_millis();
    let saved = ctx.store.with_connection(|conn| {
        let tx =
            rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
        // As the app: an article already stored under another feed is not
        // added twice.
        let mut feed = crate::database::RssFeedDto {
            id: id.as_str().into(),
            title: parsed.title.clone(),
            url: url.into(),
            site_url: parsed.site_url.clone(),
            description: parsed.description.clone(),
            icon_url: parsed.icon_url.clone(),
            last_fetched: Some(now),
            added_at: Some(now),
            error_message: None,
            unread_count: 0,
        };
        // The feed row first: articles refer to it.
        crate::database::sqlite_save_rss_feed_inner(&tx, &feed)?;
        let mut known = article_urls(&tx, None)?;
        let added = save_new_articles(&tx, &id, &parsed, &mut known, now)?;
        feed.unread_count = added;
        crate::database::sqlite_save_rss_feed_inner(&tx, &feed)?;
        tx.commit()?;
        Ok(added)
    });
    let added = match saved {
        Ok(added) => added,
        Err(e) => return output.error(&e),
    };

    if output.json {
        output.print_json(&serde_json::json!({
            "id": id,
            "url": url,
            "title": parsed.title,
            "articles": added,
        }))
    } else {
        println!(
            "{} {} {}",
            output.green("subscribed"),
            output.bold(&parsed.title),
            output.dim(&format!("({added} articles)"))
        );
        0
    }
}

fn feeds_remove(output: &Output, ctx: &Ctx, feed: &str) -> i32 {
    let feeds = match load_feeds(ctx) {
        Ok(feeds) => feeds,
        Err(e) => return output.error(&e),
    };
    let wanted = normalize_feed_url(feed);
    let Some(found) = feeds
        .iter()
        .find(|f| &*f.id == feed)
        .or_else(|| feeds.iter().find(|f| normalize_feed_url(&f.url) == wanted))
    else {
        output.error(&format!("feed '{feed}' not found"));
        return EXIT_NOT_FOUND;
    };
    let feed_id = found.id.to_string();

    // As the app's `removeFeed`: the feed and its articles go, and a
    // tombstone tells sync to remove them on other devices.
    let removed = update_library_kv(ctx, |conn, envelope| {
        // `sqlite_delete_rss_feed_inner`'s statements, inside this transaction.
        for sql in [
            "DELETE FROM rss_article_content WHERE article_id IN \
             (SELECT id FROM rss_articles WHERE feed_id = ?1)",
            "DELETE FROM rss_articles WHERE feed_id = ?1",
            "DELETE FROM rss_feeds WHERE id = ?1",
        ] {
            conn.execute(sql, rusqlite::params![feed_id])
                .map_err(|e| e.to_string())?;
        }
        let state = envelope_state(envelope, LIBRARY_STORE)?;
        state_list(state, "deletionTombstones", LIBRARY_STORE)?.push(tombstone(&feed_id, "feed"));
        Ok(())
    });
    if let Err(e) = removed {
        return output.error(&e);
    }

    if output.json {
        output.print_json(&serde_json::json!({ "removed": feed_id, "title": found.title }))
    } else {
        println!("{} {}", output.green("unsubscribed"), found.title);
        0
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedRefresh {
    id: String,
    title: String,
    new_articles: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn feeds_refresh(output: &Output, ctx: &Ctx) -> i32 {
    let feeds = match load_feeds(ctx) {
        Ok(feeds) => feeds,
        Err(e) => return output.error(&e),
    };
    if feeds.is_empty() {
        output.note("no feeds subscribed");
        if output.json {
            return output.print_json(&Vec::<FeedRefresh>::new());
        }
        return 0;
    }

    let mut results = Vec::with_capacity(feeds.len());
    let mut code = 0;
    for feed in &feeds {
        let fetched = fetch_feed(&feed.url);
        let now = now_millis();
        let saved = ctx.store.with_connection(|conn| {
            let tx = rusqlite::Transaction::new_unchecked(
                conn,
                rusqlite::TransactionBehavior::Immediate,
            )?;
            let mut updated = feed.clone();
            let (added, error) = match &fetched {
                Ok(parsed) => {
                    let mut known = article_urls(&tx, Some(&feed.id))?;
                    let added = save_new_articles(&tx, &feed.id, parsed, &mut known, now)?;
                    if !parsed.title.is_empty() {
                        updated.title = parsed.title.clone();
                    }
                    updated.last_fetched = Some(now);
                    updated.error_message = None;
                    (added, None)
                }
                Err((_, e)) => {
                    updated.error_message = Some(e.as_str().into());
                    (0, Some(e.clone()))
                }
            };
            updated.unread_count = unread_count(&tx, &feed.id)?;
            crate::database::sqlite_save_rss_feed_inner(&tx, &updated)?;
            tx.commit()?;
            Ok((updated.title.to_string(), added, error))
        });
        match saved {
            Ok((title, new_articles, error)) => {
                if let Err((failure, _)) = &fetched {
                    code = if code == 0 { *failure } else { code };
                }
                results.push(FeedRefresh {
                    id: feed.id.to_string(),
                    title,
                    new_articles,
                    error,
                });
            }
            Err(e) => return output.error(&e),
        }
    }

    if output.json {
        let printed = output.print_json(&results);
        return if printed != 0 { printed } else { code };
    }
    let mut total = 0;
    for result in &results {
        total += result.new_articles;
        match &result.error {
            None => println!(
                "{} {} {}",
                output.green("refreshed"),
                output.bold(&result.title),
                output.dim(&format!("({} new)", result.new_articles))
            ),
            Some(e) => eprintln!("{} {}: {e}", output.red("failed"), result.title),
        }
    }
    output.note(&format!("# {total} new articles across {} feeds", results.len()));
    code
}

// ── opds ─────────────────────────────────────────────────────────────────────

fn run_opds(output: &Output, ctx: &Ctx, command: OpdsCommand) -> i32 {
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
        output.error(&format!(
            "entry '{entry_selector}' not found among the catalog's books"
        ));
        return EXIT_NOT_FOUND;
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
    let code = ingest_and_register(output, ctx, &[downloaded.path.clone()]);
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

fn run_storage(output: &Output, ctx: &Ctx, command: StorageCommand) -> i32 {
    match command {
        StorageCommand::Stats => match crate::database::get_storage_stats_in(&ctx.store) {
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
            // The library is `book_metadata`, as the app's store sees it.
            // `books` rows only exist for files on this device, so using
            // them deleted the covers of books synced from other devices.
            let existing_ids: Vec<String> = match ctx.store.with_connection(|conn| {
                let mut stmt = conn.prepare("SELECT book_id FROM book_metadata")?;
                let rows = stmt
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            }) {
                Ok(ids) => ids,
                // Never clean up against an empty list: that deletes everything.
                Err(e) => return output.error(&e),
            };
            match crate::database::cleanup_orphaned_storage_in(&ctx.store, existing_ids) {
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

/// Minutes as "2 h 05 min" / "45 min".
fn format_minutes(minutes: f64) -> String {
    let total = if minutes.is_finite() && minutes > 0.0 {
        minutes.round() as u64
    } else {
        0
    };
    if total >= 60 {
        format!("{} h {:02} min", total / 60, total % 60)
    } else {
        format!("{total} min")
    }
}

fn plural(count: i64, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

fn run_stats(output: &Output, ctx: &Ctx) -> i32 {
    let raw = match ctx.kv_get("zustand:theorem-settings") {
        Ok(raw) => raw,
        Err(e) => return output.error(&e),
    };
    let stats = match raw.as_deref().map(serde_json::from_str::<serde_json::Value>) {
        None => None,
        Some(Ok(envelope)) => envelope.get("state").and_then(|s| s.get("stats")).cloned(),
        Some(Err(e)) => return output.error(&format!("Settings store is malformed: {e}")),
    };
    // Nothing read yet is not an error: the app starts from zero too.
    let stats = match stats {
        Some(stats) if stats.is_object() => stats,
        None | Some(serde_json::Value::Null) => serde_json::json!({}),
        Some(_) => return output.error("Settings store is malformed: \"stats\" is not an object"),
    };
    if output.json {
        return output.print_json(&stats);
    }
    let number = |key: &str| stats.get(key).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let count = |key: &str| number(key).max(0.0).round() as i64;
    // The app counts reading time and the daily goal in minutes.
    println!(
        "  {}: {}",
        output.dim("total reading time"),
        format_minutes(number("totalReadingTime"))
    );
    println!(
        "  {}: {}",
        output.dim("current streak"),
        plural(count("currentStreak"), "day", "days")
    );
    println!(
        "  {}: {}",
        output.dim("longest streak"),
        plural(count("longestStreak"), "day", "days")
    );
    println!(
        "  {}: {}",
        output.dim("books completed"),
        count("booksCompleted")
    );
    println!(
        "  {}: {} a day",
        output.dim("daily goal"),
        format_minutes(number("dailyGoal"))
    );
    0
}

fn run_export_snapshot(output: &Output, ctx: &Ctx, out: Option<PathBuf>) -> i32 {
    let books = match load_books(ctx) {
        Ok(books) => books,
        Err(e) => return output.error(&e),
    };
    let annotations = match load_annotations(ctx, None) {
        Ok(annotations) => annotations,
        Err(e) => return output.error(&e),
    };
    let mut library =
        match read_kv_envelope(ctx, LIBRARY_KV_KEY, LIBRARY_STORE, empty_library_envelope) {
            Ok(envelope) => envelope,
            Err(e) => return output.error(&e),
        };
    let (collections, tombstones) =
        match envelope_state(&mut library, LIBRARY_STORE).and_then(|state| {
            Ok((
                state_list(state, "collections", LIBRARY_STORE)?.clone(),
                state_list(state, "deletionTombstones", LIBRARY_STORE)?.clone(),
            ))
        }) {
            Ok(lists) => lists,
            Err(e) => return output.error(&e),
        };

    let rss = ctx.store.with_connection(|conn| {
        Ok((
            crate::database::sqlite_get_rss_feeds_inner(conn)?,
            crate::database::sqlite_get_rss_articles_inner(conn, None, Some(u32::MAX), None)?,
        ))
    });
    let (feeds, articles) = match rss {
        Ok(rss) => rss,
        Err(e) => return output.error(&e),
    };

    let snapshot = serde_json::json!({
        "exportedAt": now_iso(),
        "version": env!("CARGO_PKG_VERSION"),
        "books": books,
        "collections": collections,
        "tombstones": tombstones,
        "annotations": annotations,
        "feeds": feeds,
        "rssArticles": articles,
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

fn run_open(output: &Output, ctx: &Ctx, book_id: &str) -> i32 {
    match load_book(ctx, book_id) {
        Ok(Some(_)) => {}
        Ok(None) => return output.error(&book_not_found(book_id)),
        Err(e) => return output.error(&e),
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
    ctx: &Ctx,
    book_id: &str,
    chapter: Option<usize>,
    cfi: Option<&str>,
) -> i32 {
    if let Some(cfi) = cfi {
        return run_read_cfi(output, ctx, book_id, cfi);
    }
    let chapter = chapter.unwrap_or(1).max(1);

    let path = match resolve_book_path(ctx, book_id) {
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
fn run_read_cfi(output: &Output, ctx: &Ctx, book_id: &str, cfi: &str) -> i32 {
    let location = match crate::epubcfi::parse(cfi) {
        Ok(location) => location,
        Err(e) => return output.error(&format!("invalid CFI: {e}")),
    };

    let path = match resolve_book_path(ctx, book_id) {
        Ok(Some(path)) => path,
        Ok(None) => return output.error(&format!("book '{book_id}' not found in library")),
        Err(e) => return output.error(&e),
    };

    let result = (|| -> Result<String, String> {
        let file = std::fs::File::open(&path)
            .map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
        let mut archive =
            crate::zip_util::open_zip_archive(file).map_err(|e| format!("Not a valid zip: {e}"))?;
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
            Ok(crate::cli_text::html_to_text(&html))
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
    let mut archive =
        crate::zip_util::open_zip_archive(file).map_err(|e| format!("Not a valid zip: {e}"))?;

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

    Ok(crate::cli_text::html_to_text(&html))
}

/// Count EPUB spine chapters without loading their content.
pub(crate) fn epub_chapter_count(path: &PathBuf) -> Result<usize, String> {
    let file =
        std::fs::File::open(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    let mut archive =
        crate::zip_util::open_zip_archive(file).map_err(|e| format!("Not a valid zip: {e}"))?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn only_no_arguments_or_files_launch_the_app() {
        let dir = tempfile::tempdir().unwrap();
        let book = dir.path().join("book.epub");
        std::fs::write(&book, b"x").unwrap();
        let book = book.to_string_lossy().into_owned();

        assert!(launches_gui(&[]));
        assert!(launches_gui(&args(&[&book])));
        assert!(launches_gui(&args(&["file:///tmp/a.epub"])));
        assert!(launches_gui(&args(&["--open-book=abc"])));

        assert!(!launches_gui(&args(&["library", "list"])));
        assert!(!launches_gui(&args(&["--json", "library", "list"])));
        assert!(!launches_gui(&args(&["help"])));
        // Typos, flags alone and missing files are usage errors, not the app.
        assert!(!launches_gui(&args(&["libary"])));
        assert!(!launches_gui(&args(&["--json"])));
        assert!(!launches_gui(&args(&["--verbose"])));
        assert!(!launches_gui(&args(&["/no/such/book.epub"])));
        assert!(!launches_gui(&args(&[&book, "--json"])));
    }

    #[test]
    fn reading_time_is_shown_in_hours_and_minutes() {
        // The app stores minutes.
        assert_eq!(format_minutes(0.0), "0 min");
        assert_eq!(format_minutes(45.4), "45 min");
        assert_eq!(format_minutes(60.0), "1 h 00 min");
        assert_eq!(format_minutes(725.0), "12 h 05 min");
        assert_eq!(format_minutes(-3.0), "0 min");
        assert_eq!(format_minutes(f64::NAN), "0 min");
        assert_eq!(plural(1, "day", "days"), "1 day");
        assert_eq!(plural(0, "day", "days"), "0 days");
    }
}
