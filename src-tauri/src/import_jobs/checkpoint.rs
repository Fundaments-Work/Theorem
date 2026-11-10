//! Versioned, device-local import recovery; metadata and acknowledgment commit together.
use crate::error::{AppError, ErrorKind};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub(super) const KEY: &str = "native-import-job:v1";
const VERSION: u32 = 1;

fn database_error(error: rusqlite::Error) -> AppError {
    AppError::from_sqlite("Import checkpoint operation failed", &error)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub source: Box<str>,
    pub name: Box<str>,
    pub format: Box<str>,
    pub source_folder: Option<SourceFolder>,
}

impl Request {
    fn validate(&self) -> Result<(), AppError> {
        if self.source.is_empty()
            || self.name.is_empty()
            || !matches!(
                &*self.format,
                "epub" | "pdf" | "cbz" | "cbr" | "mobi" | "azw" | "azw3" | "fb2"
            )
        {
            return Err(AppError::invalid_input("Invalid import request"));
        }
        if let Some(folder) = &self.source_folder {
            let path = &folder.relative_path;
            if folder.root.is_empty()
                || path.is_empty()
                || path.starts_with('/')
                || path.contains('\\')
                || path
                    .as_bytes()
                    .get(..2)
                    .is_some_and(|prefix| prefix[0].is_ascii_alphabetic() && prefix[1] == b':')
                || path.split('/').any(|part| matches!(part, "" | "." | ".."))
            {
                return Err(AppError::invalid_input("Invalid source-folder location"));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceFolder {
    pub root: Box<str>,
    pub root_name: Box<str>,
    pub relative_path: Box<str>,
}

// Empty struct variants enforce unknown-field rejection; Serde's internally
// tagged unit visitor intentionally ignores remaining map entries.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase", deny_unknown_fields)]
pub enum Outcome {
    Pending {},
    Running {},
    Saved {},
    Duplicate { book_id: Box<str> },
    Failed { message: Box<str> },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub book_id: Box<str>,
    pub request: Request,
    pub outcome: Outcome,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Checkpoint {
    pub version: u32,
    pub id: Box<str>,
    pub entries: Box<[Entry]>,
}

impl Checkpoint {
    pub fn new(requests: Vec<Request>) -> Result<Self, AppError> {
        if requests.is_empty() {
            return Err(AppError::invalid_input(
                "Choose at least one book to import",
            ));
        }
        let mut sources = std::collections::HashSet::new();
        let mut entries = Vec::with_capacity(requests.len());
        for request in requests {
            request.validate()?;
            if sources.insert(request.source.clone()) {
                entries.push(Entry {
                    book_id: uuid::Uuid::new_v4().to_string().into_boxed_str(),
                    request,
                    outcome: Outcome::Pending {},
                });
            }
        }
        Ok(Self {
            version: VERSION,
            id: uuid::Uuid::new_v4().to_string().into_boxed_str(),
            entries: entries.into_boxed_slice(),
        })
    }

    pub fn acknowledge_duplicate(
        &mut self,
        connection: &Connection,
        index: usize,
        book_id: &str,
    ) -> Result<(), AppError> {
        let entry = self
            .entries
            .get(index)
            .ok_or_else(|| AppError::invalid_input("Invalid import entry"))?;
        if matches!(entry.outcome, Outcome::Saved {} | Outcome::Duplicate { .. }) {
            return Ok(());
        }
        let old = entry.outcome.clone();
        let folder = entry.request.source_folder.clone();
        let transaction = connection.unchecked_transaction().map_err(database_error)?;
        let result = (|| {
            let json: String = transaction
                .query_row(
                    "SELECT metadata_json FROM book_metadata WHERE book_id=?1",
                    [book_id],
                    |row| row.get(0),
                )
                .map_err(database_error)?;
            if let Some(folder) = folder {
                let mut metadata: serde_json::Value = serde_json::from_str(&json)
                    .map_err(|error| AppError::new(ErrorKind::Corrupt, error.to_string()))?;
                let folders = metadata
                    .as_object_mut()
                    .ok_or_else(|| AppError::new(ErrorKind::Corrupt, "Invalid book metadata"))?
                    .entry("sourceFolders")
                    .or_insert_with(|| serde_json::json!([]))
                    .as_array_mut()
                    .ok_or_else(|| {
                        AppError::new(ErrorKind::Corrupt, "Invalid source-folder metadata")
                    })?;
                let exists = folders.iter().any(|value| {
                    value["root"].as_str() == Some(&folder.root)
                        && value["relativePath"].as_str() == Some(&folder.relative_path)
                });
                if !exists {
                    folders.push(serde_json::json!({ "root": folder.root, "name": folder.root_name, "relativePath": folder.relative_path }));
                    let updated = serde_json::to_string(&metadata)
                        .map_err(|error| AppError::internal(error.to_string()))?;
                    crate::database::sqlite_save_book_metadata_inner(
                        &transaction,
                        book_id,
                        &updated,
                    )
                    .map_err(database_error)?;
                }
            }
            self.entries[index].outcome = Outcome::Duplicate {
                book_id: book_id.into(),
            };
            self.save(&transaction)?;
            transaction.commit().map_err(database_error)?;
            Ok::<_, AppError>(())
        })();
        if result.is_err() {
            self.entries[index].outcome = old;
        }
        result
    }

    /// Checks the stable identity before any source I/O during recovery.
    pub fn existing_metadata(
        &self,
        connection: &Connection,
        index: usize,
    ) -> Result<Option<String>, AppError> {
        let entry = self
            .entries
            .get(index)
            .ok_or_else(|| AppError::invalid_input("Invalid import entry"))?;
        connection
            .query_row(
                "SELECT metadata_json FROM book_metadata WHERE book_id=?1",
                [&*entry.book_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)
    }

    pub fn next_pending(&self) -> Option<usize> {
        self.entries
            .iter()
            .position(|entry| matches!(entry.outcome, Outcome::Pending {} | Outcome::Running {}))
    }

    /// Loads valid recovery data; malformed and future versions remain untouched.
    pub fn load(connection: &Connection) -> Result<Option<Self>, AppError> {
        let json: Option<String> = connection
            .query_row("SELECT value FROM kv_store WHERE key = ?1", [KEY], |row| {
                row.get(0)
            })
            .optional()
            .map_err(database_error)?;
        let Some(json) = json else { return Ok(None) };
        #[derive(Deserialize)]
        struct VersionHeader {
            version: u32,
        }
        let version = serde_json::from_str::<VersionHeader>(&json)
            .ok()
            .map(|header| header.version);
        if version.is_some_and(|version| version != VERSION) {
            return Err(AppError::invalid_input(
                "This import checkpoint version is not supported; the data has been retained",
            ));
        }
        let checkpoint: Self = serde_json::from_str(&json).map_err(|error| {
            AppError::new(
                ErrorKind::Corrupt,
                format!("Import recovery data is damaged and has been retained: {error}"),
            )
        })?;
        if checkpoint.version != VERSION {
            return Err(AppError::invalid_input(
                "This import checkpoint version is not supported; the data has been retained",
            ));
        }
        if uuid::Uuid::parse_str(&checkpoint.id).is_err() || checkpoint.entries.is_empty() {
            return Err(AppError::new(ErrorKind::Corrupt, "Import recovery contains an invalid job identity or empty queue; the data has been retained"));
        }
        let mut ids = std::collections::HashSet::new();
        let mut sources = std::collections::HashSet::new();
        for entry in &checkpoint.entries {
            entry.request.validate().map_err(|error| {
                AppError::new(
                    ErrorKind::Corrupt,
                    format!("Import recovery is invalid and has been retained: {error}"),
                )
            })?;
            if !sources.insert(&entry.request.source)
                || matches!(&entry.outcome, Outcome::Duplicate { book_id } if book_id.is_empty())
            {
                return Err(AppError::new(
                    ErrorKind::Corrupt,
                    "Import recovery contains inconsistent entries; the data has been retained",
                ));
            }
            if uuid::Uuid::parse_str(&entry.book_id).is_err() || !ids.insert(&entry.book_id) {
                return Err(AppError::new(ErrorKind::Corrupt, "Import recovery contains invalid or duplicate book identities; the data has been retained"));
            }
        }
        Ok(Some(checkpoint))
    }

    /// Persists the current journal inside the caller’s transaction when supplied.
    pub fn save(&self, connection: &Connection) -> Result<(), AppError> {
        let json =
            serde_json::to_string(self).map_err(|error| AppError::internal(error.to_string()))?;
        crate::database::sqlite_set_kv_inner(connection, KEY, &json).map_err(database_error)?;
        Ok(())
    }

    /// A failed metadata write or checkpoint write leaves both records unchanged.
    /// A saved entry is never written again, preserving edits made after import.
    pub fn acknowledge(
        &mut self,
        connection: &Connection,
        index: usize,
        metadata: &str,
    ) -> Result<(), AppError> {
        let entry = self
            .entries
            .get(index)
            .ok_or_else(|| AppError::invalid_input("Invalid import entry"))?;
        if matches!(entry.outcome, Outcome::Saved {} | Outcome::Duplicate { .. }) {
            return Ok(());
        }
        let id = entry.book_id.clone();
        let old = entry.outcome.clone();
        let transaction = connection.unchecked_transaction().map_err(database_error)?;
        let result = (|| {
            // Stable IDs make replay idempotent even if metadata already exists.
            let exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM book_metadata WHERE book_id = ?1)",
                    [&*id],
                    |row| row.get(0),
                )
                .map_err(database_error)?;
            if !exists {
                crate::database::sqlite_save_book_metadata_inner(&transaction, &id, metadata)
                    .map_err(database_error)?;
            }
            self.entries[index].outcome = Outcome::Saved {};
            self.save(&transaction)?;
            transaction.commit().map_err(database_error)?;
            Ok::<_, AppError>(())
        })();
        if result.is_err() {
            self.entries[index].outcome = old;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE kv_store(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE books(id TEXT PRIMARY KEY, data BLOB, updated_at INTEGER); CREATE TABLE book_metadata(book_id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL, updated_at INTEGER);").unwrap();
        connection
    }

    fn request(source: &str) -> Request {
        Request {
            source: source.into(),
            name: "Book.epub".into(),
            format: "epub".into(),
            source_folder: None,
        }
    }

    #[test]
    fn empty_and_invalid_requests_are_refused_and_repeated_sources_are_deduplicated() {
        assert_eq!(
            Checkpoint::new(vec![]).unwrap_err().kind(),
            ErrorKind::InvalidInput
        );
        assert!(Checkpoint::new(vec![request("")]).is_err());
        let checkpoint = Checkpoint::new(vec![
            request("a.epub"),
            request("a.epub"),
            request("b.epub"),
        ])
        .unwrap();
        assert_eq!(checkpoint.entries.len(), 2);
        assert_ne!(checkpoint.entries[0].book_id, checkpoint.entries[1].book_id);
    }

    #[test]
    fn source_folder_paths_follow_the_existing_relative_path_contract() {
        for path in [
            "/absolute.epub",
            "../outside.epub",
            "Series/../outside.epub",
            "Series//book.epub",
            "C:book.epub",
            "Series\\book.epub",
        ] {
            let mut input = request("book.epub");
            input.source_folder = Some(SourceFolder {
                root: "root".into(),
                root_name: "Root".into(),
                relative_path: path.into(),
            });
            assert!(Checkpoint::new(vec![input]).is_err(), "{path}");
        }
        let mut input = request("book.epub");
        input.source_folder = Some(SourceFolder {
            root: "root".into(),
            root_name: "Root".into(),
            relative_path: "Series/Part: One.epub".into(),
        });
        assert!(Checkpoint::new(vec![input]).is_ok());
    }

    #[test]
    fn interrupted_entry_retains_its_identity_and_source_options_after_restart() {
        let connection = db();
        let mut input = request("content://documents/book");
        input.source_folder = Some(SourceFolder {
            root: "content://documents/tree".into(),
            root_name: "My books".into(),
            relative_path: "Series/Book.epub".into(),
        });
        let mut checkpoint = Checkpoint::new(vec![input]).unwrap();
        checkpoint.entries[0].outcome = Outcome::Running {};
        checkpoint.save(&connection).unwrap();
        let loaded = Checkpoint::load(&connection).unwrap().unwrap();
        assert_eq!(loaded.id, checkpoint.id);
        assert_eq!(loaded.entries[0].book_id, checkpoint.entries[0].book_id);
        assert_eq!(loaded.next_pending(), Some(0));
        assert_eq!(
            &*loaded.entries[0]
                .request
                .source_folder
                .as_ref()
                .unwrap()
                .relative_path,
            "Series/Book.epub"
        );
    }

    #[test]
    fn corrupt_or_future_checkpoints_are_retained_instead_of_replaced() {
        let connection = db();
        for json in ["{broken", r#"{"version":99,"id":"job","entries":[]}"#] {
            crate::database::sqlite_set_kv_inner(&connection, KEY, json).unwrap();
            assert!(Checkpoint::load(&connection).is_err());
            assert_eq!(
                crate::database::sqlite_get_kv_inner(&connection, KEY)
                    .unwrap()
                    .as_deref(),
                Some(json)
            );
        }
    }

    #[test]
    fn malformed_recovery_identities_and_requests_are_retained() {
        let connection = db();
        let valid = Checkpoint::new(vec![request("a.epub")]).unwrap();
        let mut cases = Vec::new();
        let mut value = serde_json::to_value(&valid).unwrap();
        value["id"] = "invalid".into();
        cases.push(value);
        let mut value = serde_json::to_value(&valid).unwrap();
        value["entries"] = serde_json::json!([]);
        cases.push(value);
        let mut value = serde_json::to_value(&valid).unwrap();
        value["entries"][0]["request"]["format"] = "unknown".into();
        cases.push(value);
        let mut value = serde_json::to_value(&valid).unwrap();
        value["entries"][0]["outcome"] = serde_json::json!({ "state":"saved", "book_id":"other" });
        cases.push(value);
        for value in cases {
            let json = serde_json::to_string(&value).unwrap();
            crate::database::sqlite_set_kv_inner(&connection, KEY, &json).unwrap();
            assert_eq!(
                Checkpoint::load(&connection).unwrap_err().kind(),
                ErrorKind::Corrupt
            );
            assert_eq!(
                crate::database::sqlite_get_kv_inner(&connection, KEY)
                    .unwrap()
                    .as_deref(),
                Some(&*json)
            );
        }
    }

    #[test]
    fn duplicate_folder_update_and_acknowledgment_roll_back_together() {
        let connection = db();
        let original = r#"{"title":"Edited","progress":0.7}"#;
        crate::database::sqlite_save_book_metadata_inner(&connection, "existing", original)
            .unwrap();
        let mut input = request("content://provider/document");
        input.source_folder = Some(SourceFolder {
            root: "root".into(),
            root_name: "Root".into(),
            relative_path: "book.epub".into(),
        });
        let mut checkpoint = Checkpoint::new(vec![input]).unwrap();
        checkpoint.save(&connection).unwrap();
        connection.execute_batch("CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON kv_store BEGIN SELECT RAISE(ABORT,'checkpoint refused'); END;").unwrap();
        assert!(checkpoint
            .acknowledge_duplicate(&connection, 0, "existing")
            .is_err());
        assert_eq!(checkpoint.entries[0].outcome, Outcome::Pending {});
        let json: String = connection
            .query_row(
                "SELECT metadata_json FROM book_metadata WHERE book_id='existing'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(json, original);
    }

    #[test]
    fn metadata_failure_does_not_acknowledge_the_entry() {
        let connection = db();
        let mut checkpoint = Checkpoint::new(vec![request("a.epub")]).unwrap();
        checkpoint.save(&connection).unwrap();
        connection.execute_batch("CREATE TRIGGER reject_metadata BEFORE INSERT ON book_metadata BEGIN SELECT RAISE(ABORT,'write refused'); END;").unwrap();
        assert!(checkpoint
            .acknowledge(&connection, 0, r#"{"title":"Book"}"#)
            .is_err());
        assert_eq!(checkpoint.entries[0].outcome, Outcome::Pending {});
        assert_eq!(
            Checkpoint::load(&connection)
                .unwrap()
                .unwrap()
                .next_pending(),
            Some(0)
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM books", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn checkpoint_failure_rolls_back_the_book_and_in_memory_acknowledgment() {
        let connection = db();
        let mut checkpoint = Checkpoint::new(vec![request("a.epub")]).unwrap();
        checkpoint.save(&connection).unwrap();
        connection.execute_batch("CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON kv_store BEGIN SELECT RAISE(ABORT,'checkpoint refused'); END;").unwrap();
        assert!(checkpoint
            .acknowledge(&connection, 0, r#"{"title":"Book"}"#)
            .is_err());
        assert_eq!(checkpoint.entries[0].outcome, Outcome::Pending {});
        assert_eq!(
            Checkpoint::load(&connection)
                .unwrap()
                .unwrap()
                .next_pending(),
            Some(0)
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM book_metadata", [], |row| row
                    .get::<_, u32>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn duplicate_acknowledgment_preserves_edits_and_adds_source_folder_once() {
        let connection = db();
        crate::database::sqlite_save_book_metadata_inner(&connection, "existing", r#"{"title":"Edited","progress":0.7,"tags":["mine"],"sourceFolders":[{"root":"old","name":"Old","relativePath":"Old.epub"}]}"#).unwrap();
        let mut input = request("content://documents/new");
        input.source_folder = Some(SourceFolder {
            root: "new".into(),
            root_name: "New".into(),
            relative_path: "Series/Book.epub".into(),
        });
        let mut checkpoint = Checkpoint::new(vec![input]).unwrap();
        checkpoint
            .acknowledge_duplicate(&connection, 0, "existing")
            .unwrap();
        checkpoint
            .acknowledge_duplicate(&connection, 0, "existing")
            .unwrap();
        let json: String = connection
            .query_row(
                "SELECT metadata_json FROM book_metadata WHERE book_id='existing'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let metadata: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(metadata["title"], "Edited");
        assert_eq!(metadata["progress"], 0.7);
        assert_eq!(metadata["tags"], serde_json::json!(["mine"]));
        assert_eq!(metadata["sourceFolders"].as_array().unwrap().len(), 2);
        assert!(Checkpoint::load(&connection)
            .unwrap()
            .unwrap()
            .next_pending()
            .is_none());
    }

    #[test]
    fn an_existing_stable_identity_is_acknowledged_without_replacing_metadata() {
        let connection = db();
        let mut checkpoint = Checkpoint::new(vec![request("missing.epub")]).unwrap();
        let id = checkpoint.entries[0].book_id.clone();
        let original = r#"{"title":"Edited","progress":0.8,"currentLocation":"saved"}"#;
        crate::database::sqlite_save_book_metadata_inner(&connection, &id, original).unwrap();
        let metadata = checkpoint
            .existing_metadata(&connection, 0)
            .unwrap()
            .unwrap();
        checkpoint.acknowledge(&connection, 0, &metadata).unwrap();
        assert_eq!(
            checkpoint
                .existing_metadata(&connection, 0)
                .unwrap()
                .as_deref(),
            Some(original)
        );
        assert!(checkpoint.next_pending().is_none());
    }

    #[test]
    fn completed_books_are_skipped_and_their_edits_survive_replay() {
        let connection = db();
        let mut checkpoint = Checkpoint::new(vec![request("a.epub"), request("b.epub")]).unwrap();
        checkpoint
            .acknowledge(&connection, 0, r#"{"title":"Original","progress":0}"#)
            .unwrap();
        let id = &*checkpoint.entries[0].book_id;
        crate::database::sqlite_save_book_metadata_inner(
            &connection,
            id,
            r#"{"title":"Edited","progress":0.7}"#,
        )
        .unwrap();
        let mut resumed = Checkpoint::load(&connection).unwrap().unwrap();
        resumed
            .acknowledge(&connection, 0, r#"{"title":"Original","progress":0}"#)
            .unwrap();
        assert_eq!(resumed.next_pending(), Some(1));
        let json: String = connection
            .query_row(
                "SELECT metadata_json FROM book_metadata WHERE book_id=?1",
                [id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(json, r#"{"title":"Edited","progress":0.7}"#);
    }
}
