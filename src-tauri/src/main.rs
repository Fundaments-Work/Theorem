#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Headless CLI fast path: `theorem <subcommand>` runs the native engines
    // and exits without creating windows. Anything else launches the GUI
    // (including bare invocation and desktop file-open paths).
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(code) = theorem_lib::cli::maybe_dispatch(&args) {
        std::process::exit(code);
    }

    theorem_lib::run()
}
