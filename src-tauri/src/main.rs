#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![allow(unknown_lints)]
#![allow(clippy::chunks_exact_to_as_chunks)]

fn main() {
    // Headless CLI fast path: `theorem <subcommand>` runs the native engines
    // and exits without creating windows. Anything else launches the GUI
    // (including bare invocation and desktop file-open paths).
    // (Desktop-only — the CLI module is not compiled on Android.)
    #[cfg(not(target_os = "android"))]
    {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if let Some(code) = theorem_lib::cli::maybe_dispatch(&args) {
            std::process::exit(code);
        }
    }

    theorem_lib::run()
}
