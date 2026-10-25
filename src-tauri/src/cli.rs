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

use crate::error::{AppError, ErrorKind};
use rusqlite::OptionalExtension;

use clap::{Parser, Subcommand};
use serde::Serialize;

mod dict;
mod feeds;
mod highlights;
mod ingest;
mod library;
mod opds;
mod output;
mod read;
mod search;
mod shelf;
mod storage;
mod store;
mod sync;

use dict::*;
use feeds::*;
use highlights::*;
use ingest::*;
use library::*;
use opds::*;
use output::*;
pub(crate) use read::*;
pub(crate) use search::*;
use shelf::*;
use storage::*;
pub(crate) use store::*;
use sync::*;

// ── Logo ─────────────────────────────────────────────────────────────────────

const LOGO: &str = r"
████████╗██╗  ██╗███████╗ ██████╗ ██████╗ ███████╗███╗   ███╗
╚══██╔══╝██║  ██║██╔════╝██╔═══██╗██╔══██╗██╔════╝████╗ ████║
   ██║   ███████║█████╗  ██║   ██║██████╔╝█████╗  ██╔████╔██║
   ██║   ██╔══██║██╔══╝  ██║   ██║██╔══██╗██╔══╝  ██║╚██╔╝██║
   ██║   ██║  ██║███████╗╚██████╔╝██║  ██║███████╗██║ ╚═╝ ██║
   ╚═╝   ╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝";

// ── Exit codes ───────────────────────────────────────────────────────────────

/// Exit code for a command line that does not make sense (as clap uses).
const EXIT_USAGE: i32 = 2;
/// Exit code when a command would change the library while the app runs.
/// Exit code when the book, shelf, feed or entry asked for does not exist.
const EXIT_NOT_FOUND: i32 = 3;
/// Exit code when the network (a feed, a catalog, a download) failed.
const EXIT_NETWORK: i32 = 4;
const EXIT_APP_RUNNING: i32 = 5;

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
        /// Print at most this many results
        #[arg(long, default_value_t = 50)]
        limit: usize,
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
            LibraryCommand::List { .. }
                | LibraryCommand::Info { .. }
                | LibraryCommand::Export { .. }
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
                Command::Search {
                    query,
                    book_id,
                    limit,
                } => run_search(output, ctx, &query, book_id, limit),
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
        crate::database::run_startup_migrations_in(dir)?;
        Ok(Self {
            store: crate::database::DataStore::open(dir)?,
        })
    }

    pub(crate) fn dir(&self) -> &std::path::Path {
        self.store.dir()
    }

    fn kv_get(&self, key: &str) -> Result<Option<String>, AppError> {
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
    if let Err(e) = crate::database::run_startup_migrations_in(&dir) {
        return output.error(&e);
    }
    let app = match tauri::Builder::default().build(tauri::generate_context!()) {
        Ok(app) => app,
        Err(e) => return output.error(format!("Failed to initialize app context: {e}")),
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
                return output.error(format!("sync could not start: {e}"));
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
}
