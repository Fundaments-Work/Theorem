//! Output policy: JSON or colored text, errors and exit codes.

use super::*;

/// Shared output policy: `--json` for machine consumption, ANSI color only
/// when writing to a real terminal (piped output stays machine-parseable).
pub(super) struct Output {
    pub(super) json: bool,
    color: bool,
}

impl Output {
    pub(super) fn new(json: bool, no_color: bool) -> Self {
        // https://no-color.org: any non-empty NO_COLOR turns color off.
        let no_color_env = std::env::var_os("NO_COLOR").is_some_and(|v| !v.is_empty());
        Self {
            json,
            color: !no_color && !no_color_env && std::io::stdout().is_terminal(),
        }
    }

    pub(super) fn print_json<T: Serialize>(&self, value: &T) -> i32 {
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
    pub(super) fn note(&self, message: &str) {
        eprintln!("{}", self.dim(message));
    }

    /// Report a failure on stderr (as JSON with `--json`) and return its
    /// exit code: 3 when something asked for does not exist, else 1.
    pub(super) fn error(&self, message: &str) -> i32 {
        let code = if message.contains("not found") {
            EXIT_NOT_FOUND
        } else {
            1
        };
        self.fail(message, code)
    }

    /// A command line that does not make sense: exit code 2.
    pub(super) fn usage(&self, message: &str) -> i32 {
        self.fail(message, EXIT_USAGE)
    }

    pub(super) fn fail(&self, message: &str, code: i32) -> i32 {
        if self.json {
            eprintln!(
                "{}",
                serde_json::json!({ "error": message, "exitCode": code })
            );
        } else {
            eprintln!("{} {message}", self.red("error:"));
        }
        code
    }

    fn wrap(&self, code: &str, text: &str) -> String {
        if self.color {
            format!("\x1b[{code}m{text}\x1b[0m")
        } else {
            text.to_string()
        }
    }

    pub(super) fn dim(&self, text: &str) -> String {
        self.wrap("2", text)
    }

    pub(super) fn bold(&self, text: &str) -> String {
        self.wrap("1", text)
    }

    pub(super) fn cyan(&self, text: &str) -> String {
        self.wrap("36", text)
    }

    pub(super) fn green(&self, text: &str) -> String {
        self.wrap("32", text)
    }

    pub(super) fn red(&self, text: &str) -> String {
        self.wrap("31", text)
    }
}
