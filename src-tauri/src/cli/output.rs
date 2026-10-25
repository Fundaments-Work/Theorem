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
    /// exit code, chosen by the error's kind (`exit_code_for`). A plain
    /// string is an `Internal` error: exit code 1.
    pub(super) fn error(&self, error: impl Into<AppError>) -> i32 {
        let error = error.into();
        let code = exit_code_for(error.kind());
        self.emit(error.message(), code, Some(error.kind()))
    }

    /// A command line that does not make sense: exit code 2.
    pub(super) fn usage(&self, message: &str) -> i32 {
        self.fail(message, EXIT_USAGE)
    }

    pub(super) fn fail(&self, message: &str, code: i32) -> i32 {
        self.emit(message, code, None)
    }

    fn emit(&self, message: &str, code: i32, kind: Option<ErrorKind>) -> i32 {
        if self.json {
            let mut error = serde_json::json!({ "error": message, "exitCode": code });
            if let Some(kind) = kind {
                error["kind"] = serde_json::json!(kind);
            }
            eprintln!("{error}");
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

/// The exit code for an error kind: 3 when something asked for does not
/// exist, 4 when the network failed, else 1.
pub(super) fn exit_code_for(kind: ErrorKind) -> i32 {
    match kind {
        ErrorKind::NotFound => EXIT_NOT_FOUND,
        ErrorKind::Network => EXIT_NETWORK,
        _ => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_codes_follow_the_kind_not_the_text() {
        assert_eq!(exit_code_for(ErrorKind::NotFound), EXIT_NOT_FOUND);
        assert_eq!(exit_code_for(ErrorKind::Network), EXIT_NETWORK);
        for kind in [
            ErrorKind::Busy,
            ErrorKind::Corrupt,
            ErrorKind::Constraint,
            ErrorKind::InvalidInput,
            ErrorKind::Io,
            ErrorKind::Internal,
        ] {
            assert_eq!(exit_code_for(kind), 1, "{kind}");
        }
        let output = Output::new(true, true);
        // A plain string mentioning "not found" is no longer guessed at.
        assert_eq!(output.error("dictionary not found"), 1);
        assert_eq!(
            output.error(AppError::not_found("book 'x' not found in library")),
            EXIT_NOT_FOUND
        );
        let owned = String::from("boom");
        assert_eq!(output.error(&owned), 1);
    }
}
