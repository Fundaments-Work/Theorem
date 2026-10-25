//! Typed errors with a stable, machine-readable kind.
//!
//! `AppError` is a kind plus the human message. Commands return it the same
//! way they return `String`: on the wire it **serializes as the plain
//! message**, so every webview call site that reads errors as strings
//! (`String(e)`, `typeof e === "string"`, `.includes(...)`) sees exactly the
//! text it saw before. Rust callers (the CLI, sync, and later the plugin API)
//! read the kind with [`AppError::kind`]; [`AppError::to_structured`] gives the
//! `{ kind, message }` object for consumers that want it.
//!
//! The webview recovers the kind from the message with `errorKind()` in
//! `src/core/lib/error-kind.ts`: SQLite errors keep the text SQLite itself
//! defines for each result code (`sqlite3_errstr`, stable across versions),
//! and the tests below pin that contract.
//!
//! A `Result<_, String>` function can `?` an `AppError` (it converts to its
//! message), and a `String` converts to `AppError` as `Internal`.

use serde::{Serialize, Serializer};
use std::fmt;

/// What went wrong, independent of the wording. Serialized in snake_case
/// (`"not_found"`), which is the stable name for external consumers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// The database is locked by another connection or process; retrying later can work.
    Busy,
    /// The database file is damaged or is not a database.
    Corrupt,
    /// A uniqueness, foreign-key, NOT NULL or CHECK constraint refused a write.
    Constraint,
    /// The thing asked for does not exist.
    NotFound,
    /// The request itself does not make sense.
    InvalidInput,
    /// A file system operation failed.
    Io,
    /// A network request failed.
    Network,
    /// Anything else.
    Internal,
}

impl ErrorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Busy => "busy",
            Self::Corrupt => "corrupt",
            Self::Constraint => "constraint",
            Self::NotFound => "not_found",
            Self::InvalidInput => "invalid_input",
            Self::Io => "io",
            Self::Network => "network",
            Self::Internal => "internal",
        }
    }
}

impl fmt::Display for ErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct AppError {
    kind: ErrorKind,
    message: Box<str>,
}

/// `{ kind, message }`, for consumers that read the kind as data.
#[derive(Debug, Clone, Serialize)]
pub struct StructuredError<'a> {
    pub kind: ErrorKind,
    pub message: &'a str,
}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into().into_boxed_str(),
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::NotFound, message)
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::InvalidInput, message)
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Network, message)
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Io, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Internal, message)
    }

    pub fn kind(&self) -> ErrorKind {
        self.kind
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    /// The same error with `context: ` in front of its message.
    pub fn context(self, context: impl fmt::Display) -> Self {
        Self::new(self.kind, format!("{context}: {}", self.message))
    }

    pub fn to_structured(&self) -> StructuredError<'_> {
        StructuredError {
            kind: self.kind,
            message: &self.message,
        }
    }

    /// A rusqlite error with `prefix: ` before SQLite's own text.
    pub fn from_sqlite(prefix: &str, error: &rusqlite::Error) -> Self {
        Self::new(sqlite_error_kind(error), format!("{prefix}: {error}"))
    }
}

/// The kind of a rusqlite error, from SQLite's primary result code.
pub fn sqlite_error_kind(error: &rusqlite::Error) -> ErrorKind {
    use rusqlite::ErrorCode;
    match error {
        rusqlite::Error::SqliteFailure(failure, _) => match failure.code {
            ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => ErrorKind::Busy,
            ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase => ErrorKind::Corrupt,
            ErrorCode::ConstraintViolation => ErrorKind::Constraint,
            ErrorCode::CannotOpen
            | ErrorCode::SystemIoFailure
            | ErrorCode::DiskFull
            | ErrorCode::ReadOnly
            | ErrorCode::PermissionDenied => ErrorKind::Io,
            ErrorCode::NotFound => ErrorKind::NotFound,
            ErrorCode::TooBig | ErrorCode::ParameterOutOfRange => ErrorKind::InvalidInput,
            _ => ErrorKind::Internal,
        },
        rusqlite::Error::QueryReturnedNoRows => ErrorKind::NotFound,
        rusqlite::Error::InvalidParameterName(_)
        | rusqlite::Error::InvalidParameterCount(_, _)
        | rusqlite::Error::InvalidPath(_)
        | rusqlite::Error::NulError(_) => ErrorKind::InvalidInput,
        _ => ErrorKind::Internal,
    }
}

/// The kind of a connection-pool error. r2d2 keeps only the text of the
/// error that failed to open or prepare a connection, which is SQLite's
/// result-code text when SQLite refused; a pool that ran out of connections
/// times out, which is a busy database too.
pub fn pool_error_kind(error: &r2d2::Error) -> ErrorKind {
    let text = error.to_string();
    if text.contains("file is not a database") || text.contains("disk image is malformed") {
        ErrorKind::Corrupt
    } else if text.contains("is locked") || text.contains("timed out") {
        ErrorKind::Busy
    } else {
        ErrorKind::Internal
    }
}

impl Serialize for AppError {
    /// The plain message, exactly as a `Result<_, String>` command sent it.
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.message)
    }
}

impl From<String> for AppError {
    fn from(message: String) -> Self {
        Self::internal(message)
    }
}

impl From<&str> for AppError {
    fn from(message: &str) -> Self {
        Self::internal(message)
    }
}

impl From<&String> for AppError {
    fn from(message: &String) -> Self {
        Self::internal(message.as_str())
    }
}

impl From<&AppError> for AppError {
    fn from(error: &AppError) -> Self {
        error.clone()
    }
}

impl From<AppError> for String {
    fn from(error: AppError) -> Self {
        error.message.into_string()
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        let kind = match error.kind() {
            std::io::ErrorKind::NotFound => ErrorKind::NotFound,
            std::io::ErrorKind::InvalidInput | std::io::ErrorKind::InvalidData => {
                ErrorKind::InvalidInput
            }
            _ => ErrorKind::Io,
        };
        Self::new(kind, error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{Connection, TransactionBehavior};

    fn open(path: &std::path::Path) -> Connection {
        let connection = Connection::open(path).unwrap();
        connection.busy_timeout(std::time::Duration::ZERO).unwrap();
        connection
    }

    #[test]
    fn a_write_lock_held_by_another_connection_is_busy() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("busy.db");
        let mut holder = open(&path);
        holder.execute_batch("CREATE TABLE t(x)").unwrap();
        let tx = holder
            .transaction_with_behavior(TransactionBehavior::Exclusive)
            .unwrap();
        let other = open(&path);
        let error = other.execute("INSERT INTO t VALUES (1)", []).unwrap_err();
        assert_eq!(sqlite_error_kind(&error), ErrorKind::Busy);
        let app = AppError::from_sqlite("SQLite operation failed", &error);
        assert_eq!(app.kind(), ErrorKind::Busy);
        // The webview's errorKind() reads this text.
        assert!(app.message().contains("database is locked"), "{app}");
        drop(tx);
    }

    #[test]
    fn a_duplicate_key_is_a_constraint() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE t(id TEXT PRIMARY KEY); INSERT INTO t VALUES ('a');")
            .unwrap();
        let error = connection
            .execute("INSERT INTO t VALUES ('a')", [])
            .unwrap_err();
        let app = AppError::from_sqlite("SQLite operation failed", &error);
        assert_eq!(app.kind(), ErrorKind::Constraint);
        assert!(app.message().contains("constraint failed"), "{app}");
    }

    #[test]
    fn a_garbage_file_is_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("garbage.db");
        std::fs::write(&path, vec![0x5au8; 8192]).unwrap();
        let connection = open(&path);
        let error = connection
            .query_row("SELECT COUNT(*) FROM sqlite_master", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap_err();
        let app = AppError::from_sqlite("SQLite operation failed", &error);
        assert_eq!(app.kind(), ErrorKind::Corrupt);
        assert!(app.message().contains("file is not a database"), "{app}");
    }

    #[test]
    fn no_rows_is_not_found() {
        let connection = Connection::open_in_memory().unwrap();
        let error = connection
            .query_row("SELECT 1 WHERE 0", [], |r| r.get::<_, i64>(0))
            .unwrap_err();
        assert_eq!(sqlite_error_kind(&error), ErrorKind::NotFound);
    }

    #[test]
    fn a_syntax_error_is_internal() {
        let connection = Connection::open_in_memory().unwrap();
        let error = connection.execute_batch("SELEC nonsense").unwrap_err();
        assert_eq!(sqlite_error_kind(&error), ErrorKind::Internal);
    }

    #[test]
    fn serializes_as_the_plain_message() {
        let error = AppError::new(
            ErrorKind::Busy,
            "SQLite operation failed: database is locked",
        );
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!("SQLite operation failed: database is locked")
        );
        assert_eq!(
            serde_json::to_value(error.to_structured()).unwrap(),
            serde_json::json!({ "kind": "busy", "message": "SQLite operation failed: database is locked" })
        );
    }

    #[test]
    fn kind_names_are_stable() {
        for kind in [
            ErrorKind::Busy,
            ErrorKind::Corrupt,
            ErrorKind::Constraint,
            ErrorKind::NotFound,
            ErrorKind::InvalidInput,
            ErrorKind::Io,
            ErrorKind::Network,
            ErrorKind::Internal,
        ] {
            assert_eq!(
                serde_json::to_value(kind).unwrap(),
                serde_json::json!(kind.as_str())
            );
        }
        assert_eq!(ErrorKind::NotFound.as_str(), "not_found");
    }

    #[test]
    fn converts_to_and_from_strings_without_changing_the_text() {
        let from: AppError = String::from("boom").into();
        assert_eq!(from.kind(), ErrorKind::Internal);
        let back: String = AppError::not_found("book 'x' not found").into();
        assert_eq!(back, "book 'x' not found");
        fn legacy() -> Result<(), String> {
            Err(AppError::network("offline"))?;
            Ok(())
        }
        assert_eq!(legacy().unwrap_err(), "offline");
    }

    #[test]
    fn context_keeps_the_kind() {
        let error = AppError::not_found("no such book").context("export");
        assert_eq!(error.kind(), ErrorKind::NotFound);
        assert_eq!(error.message(), "export: no such book");
    }

    #[test]
    fn io_errors_map_by_kind() {
        let missing = std::fs::read("/definitely/not/here").unwrap_err();
        assert_eq!(AppError::from(missing).kind(), ErrorKind::NotFound);
    }
}
