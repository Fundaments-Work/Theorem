//! Scan Folder end to end on the desktop: the walker's output goes straight
//! into the native ingest, as `scanBookFolder` + `ingest_books_native` do in
//! the app. Every file the walk finds must come back exactly once, as
//! imported, failed with a reason, or a duplicate.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use theorem_lib::batch_ingest::{ingest_files, IngestItem, IngestSummary, KnownBook};
use theorem_lib::folder_walk::walk_book_folder;

fn fixture(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures")
        .join(rel)
}

fn put(root: &Path, rel: &str, bytes: &[u8]) -> PathBuf {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, bytes).unwrap();
    path
}

/// A PDF whose bytes differ per `n`, so each one is a distinct book.
fn pdf_variant(base: &[u8], n: usize) -> Vec<u8> {
    let mut bytes = base.to_vec();
    bytes.extend_from_slice(format!("\n%variant {n}\n").as_bytes());
    bytes
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Outcome {
    Imported,
    Failed,
    Duplicate,
}

struct Run {
    summary: IngestSummary,
    outcomes: HashMap<String, Outcome>,
    reasons: HashMap<String, String>,
    known: Vec<KnownBook>,
}

fn ingest(paths: &[String], cache: &Path, known: &[KnownBook], cancel: &AtomicBool) -> Run {
    let items = Mutex::new(Vec::new());
    let summary = ingest_files(paths, cache, known, cancel, &|item| {
        items.lock().unwrap().push(item)
    });
    let mut outcomes = HashMap::new();
    let mut reasons = HashMap::new();
    let mut new_known = Vec::new();
    for item in items.into_inner().unwrap() {
        let (path, outcome) = match item {
            IngestItem::Imported { path, book } => {
                assert!(
                    Path::new(book.storage_path.as_deref().unwrap()).is_file(),
                    "imported book has its file"
                );
                new_known.push(KnownBook {
                    size: book.file_size,
                    hash: book.content_hash.clone().unwrap().into(),
                });
                (path, Outcome::Imported)
            }
            IngestItem::Failed { path, reason } => {
                assert!(!reason.trim().is_empty());
                reasons.insert(path.to_string(), reason.to_string());
                (path, Outcome::Failed)
            }
            IngestItem::Duplicate { path, .. } => (path, Outcome::Duplicate),
        };
        assert!(
            outcomes.insert(path.to_string(), outcome).is_none(),
            "{path} reported twice"
        );
    }
    Run {
        summary,
        outcomes,
        reasons,
        known: new_known,
    }
}

fn books_in(cache: &Path) -> usize {
    std::fs::read_dir(cache)
        .map(|it| {
            it.flatten()
                .filter(|e| e.path().extension().is_some_and(|x| x == "book"))
                .count()
        })
        .unwrap_or(0)
}

fn parts_in(cache: &Path) -> usize {
    std::fs::read_dir(cache)
        .map(|it| {
            it.flatten()
                .filter(|e| e.path().extension().is_some_and(|x| x == "part"))
                .count()
        })
        .unwrap_or(0)
}

struct Library {
    _dir: tempfile::TempDir,
    root: PathBuf,
    cache: PathBuf,
    distinct: usize,
}

/// A messy library folder: nested 8 levels, odd and non-ASCII names, two
/// copies of one book, damaged and empty books, junk, hidden folders.
fn messy_library() -> Library {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("Books ü");
    let cache = dir.path().join("app/book-cache");
    let epub = std::fs::read(fixture("epub/multi-chapter.epub")).unwrap();
    let pdf = std::fs::read(fixture("pdf/page-labels.pdf")).unwrap();

    let names = [
        "Ünïcödé – 書名 📚",
        "Война и мир",
        "quote's \"double\"",
        "hash#percent%20",
        "-leading",
        "50%25 off",
    ];
    let mut distinct = 0;
    for n in 0..60 {
        let depth = n % 9;
        let sub: Vec<String> = (0..depth).map(|d| format!("level {d}")).collect();
        let name = names[n % names.len()];
        let rel = if sub.is_empty() {
            format!("{name} {n}.pdf")
        } else {
            format!("{}/{name} {n}.pdf", sub.join("/"))
        };
        put(&root, &rel, &pdf_variant(&pdf, n));
        distinct += 1;
    }
    put(&root, "Fiction/Novel.EPUB", &epub);
    put(&root, "Fiction/again/Novel (copy).epub", &epub);
    distinct += 1;
    put(&root, "Junk/notes.txt", b"not a book");
    put(&root, "Junk/cover.jpg", b"\xff\xd8\xff");
    put(&root, "Junk/damaged.epub", b"PK\x03\x04 nothing else");
    put(&root, "Junk/empty.pdf", b"");
    put(&root, ".Trash/deleted.epub", &epub);
    put(&root, "Junk/._Novel.epub", b"resource fork");
    Library {
        _dir: dir,
        root,
        cache,
        distinct,
    }
}

fn paths(root: &Path) -> Vec<String> {
    let scan = walk_book_folder(root, &AtomicBool::new(false)).unwrap();
    assert!(!scan.cancelled);
    scan.files.iter().map(|f| f.path.to_string()).collect()
}

#[test]
fn a_folder_import_handles_every_file_once_and_a_rescan_adds_nothing() {
    let lib = messy_library();
    let found = paths(&lib.root);
    // 60 PDFs, two copies of the novel, damaged and empty: no junk, nothing hidden.
    assert_eq!(found.len(), 64, "{found:#?}");
    assert!(found
        .iter()
        .all(|p| !p.contains(".Trash") && !p.contains("._")));

    let first = ingest(&found, &lib.cache, &[], &AtomicBool::new(false));
    assert_eq!(first.outcomes.len(), found.len(), "every file reported");
    assert_eq!(first.summary.imported, lib.distinct);
    assert_eq!(first.summary.duplicates, 1, "the second copy of the novel");
    assert_eq!(first.summary.failed, 2);
    assert!(!first.summary.cancelled);
    assert_eq!(books_in(&lib.cache), lib.distinct);
    assert_eq!(parts_in(&lib.cache), 0);
    let empty = found.iter().find(|p| p.ends_with("empty.pdf")).unwrap();
    assert_eq!(first.reasons[empty], "The file is empty");
    let damaged = found.iter().find(|p| p.ends_with("damaged.epub")).unwrap();
    assert!(first.reasons[damaged].starts_with("Could not read this book"));

    // Rescan with the library known: nothing new is copied.
    let again = ingest(
        &paths(&lib.root),
        &lib.cache,
        &first.known,
        &AtomicBool::new(false),
    );
    assert_eq!(again.summary.imported, 0);
    assert_eq!(again.summary.duplicates, lib.distinct + 1);
    assert_eq!(again.summary.failed, 2);
    assert_eq!(books_in(&lib.cache), lib.distinct);
}

#[test]
fn a_file_removed_between_scan_and_import_is_reported() {
    let lib = messy_library();
    let found = paths(&lib.root);
    let gone = found.iter().find(|p| p.contains("Война")).unwrap().clone();
    std::fs::remove_file(&gone).unwrap();
    let run = ingest(&found, &lib.cache, &[], &AtomicBool::new(false));
    assert_eq!(run.outcomes[&gone], Outcome::Failed);
    assert_eq!(run.reasons[&gone], "The file is no longer there");
    assert_eq!(run.outcomes.len(), found.len());
    assert_eq!(books_in(&lib.cache), lib.distinct - 1);
}

#[cfg(unix)]
#[test]
fn unreadable_books_and_folders_and_link_loops_are_reported() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let lib = messy_library();
    let locked_dir = lib.root.join("Locked");
    put(&locked_dir, "inside.pdf", b"%PDF-1.4 locked");
    let locked_file = put(&lib.root, "Private/secret.pdf", b"%PDF-1.4 secret");
    symlink(&lib.root, lib.root.join("Fiction/back to top")).unwrap();
    std::fs::set_permissions(&locked_dir, std::fs::Permissions::from_mode(0o000)).unwrap();
    std::fs::set_permissions(&locked_file, std::fs::Permissions::from_mode(0o000)).unwrap();
    // Running as root reads everything; there is nothing to report then.
    let root_user = std::fs::read_dir(&locked_dir).is_ok();

    let scan = walk_book_folder(&lib.root, &AtomicBool::new(false));
    let found: Vec<String> = scan
        .as_ref()
        .map(|s| s.files.iter().map(|f| f.path.to_string()).collect())
        .unwrap_or_default();
    let run = ingest(&found, &lib.cache, &[], &AtomicBool::new(false));
    std::fs::set_permissions(&locked_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::set_permissions(&locked_file, std::fs::Permissions::from_mode(0o644)).unwrap();
    let scan = scan.unwrap();

    let issues: Vec<String> = scan
        .issues
        .iter()
        .map(|i| format!("{}: {}", i.path, i.reason))
        .collect();
    assert!(
        issues
            .iter()
            .any(|i| i.contains("back to top") && i.contains("loops back")),
        "{issues:#?}"
    );
    if root_user {
        return;
    }
    assert!(
        issues
            .iter()
            .any(|i| i.ends_with("Locked: Permission denied")),
        "{issues:#?}"
    );
    let secret = locked_file.to_string_lossy().into_owned();
    assert_eq!(run.outcomes[&secret], Outcome::Failed);
    assert!(
        run.reasons[&secret].contains("Permission denied"),
        "{}",
        run.reasons[&secret]
    );
    assert_eq!(parts_in(&lib.cache), 0);
}

#[test]
fn stopping_an_import_keeps_finished_books_and_leaves_no_partial_files() {
    let lib = messy_library();
    let found = paths(&lib.root);
    let cancel = AtomicBool::new(false);
    let seen = std::sync::atomic::AtomicUsize::new(0);
    let items = Mutex::new(Vec::new());
    let summary = ingest_files(&found, &lib.cache, &[], &cancel, &|item| {
        if seen.fetch_add(1, Ordering::SeqCst) == 9 {
            cancel.store(true, Ordering::SeqCst);
        }
        items.lock().unwrap().push(item);
    });
    let items = items.into_inner().unwrap();
    assert!(summary.cancelled);
    assert!(items.len() < found.len(), "stopped early: {}", items.len());
    let imported = items
        .iter()
        .filter(|i| matches!(i, IngestItem::Imported { .. }))
        .count();
    assert_eq!(books_in(&lib.cache), imported, "finished books stay");
    assert_eq!(parts_in(&lib.cache), 0);

    // The rest comes in on the next scan, without the finished ones again.
    let known: Vec<KnownBook> = items
        .iter()
        .filter_map(|i| match i {
            IngestItem::Imported { book, .. } => Some(KnownBook {
                size: book.file_size,
                hash: book.content_hash.clone().unwrap().into(),
            }),
            _ => None,
        })
        .collect();
    let rest = ingest(&found, &lib.cache, &known, &AtomicBool::new(false));
    assert_eq!(rest.summary.imported + imported, lib.distinct);
    assert_eq!(books_in(&lib.cache), lib.distinct);
}

#[test]
fn a_cancelled_scan_stops_walking() {
    let lib = messy_library();
    let scan = walk_book_folder(&lib.root, &AtomicBool::new(true)).unwrap();
    assert!(scan.cancelled);
    assert!(scan.files.is_empty());
}

/// Walk speed on a 2,000-book tree: `cargo test --release --test
/// folder_import -- --ignored --nocapture`.
#[test]
#[ignore]
fn walking_two_thousand_books_is_fast() {
    let dir = tempfile::tempdir().unwrap();
    for n in 0..2000 {
        let mut folder = dir.path().to_path_buf();
        for d in 0..(n % 8) {
            folder.push(format!("d{d}-{}", n % 5));
        }
        put(&folder, &format!("book {n}.epub"), b"x");
        put(&folder, &format!("notes {n}.txt"), b"x");
    }
    let start = std::time::Instant::now();
    let scan = walk_book_folder(dir.path(), &AtomicBool::new(false)).unwrap();
    let elapsed = start.elapsed();
    println!("walked {} books in {elapsed:?}", scan.files.len());
    assert_eq!(scan.files.len(), 2000);
    assert!(elapsed < std::time::Duration::from_secs(1), "{elapsed:?}");
}
