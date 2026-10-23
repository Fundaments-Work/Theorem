//! End-to-end tests of the `theorem` command line.
//!
//! Each test runs the real binary in a throwaway home folder with a cleared
//! environment: no display (so a Tauri app cannot be built, and nothing can
//! reach a running Theorem through the single-instance plugin) and no access
//! to the user's real library.
#![cfg(target_os = "linux")]

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const APP_ID: &str = "work.fundamentals.theorem";

struct Sandbox {
    home: tempfile::TempDir,
}

impl Sandbox {
    fn new() -> Self {
        Self {
            home: tempfile::tempdir().expect("temp home"),
        }
    }

    fn path(&self) -> &Path {
        self.home.path()
    }

    fn data_dir(&self) -> PathBuf {
        self.path().join(".local/share").join(APP_ID)
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_theorem"));
        cmd.args(args)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", self.path())
            .env("XDG_DATA_HOME", self.path().join(".local/share"))
            .env("XDG_CONFIG_HOME", self.path().join(".config"))
            .env("XDG_CACHE_HOME", self.path().join(".cache"))
            .env("LANG", "C.UTF-8")
            .current_dir(self.path());
        cmd
    }

    fn run(&self, args: &[&str]) -> Output {
        self.command(args).output().expect("run theorem")
    }

    fn db(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.data_dir().join("theorem.db")).expect("open db")
    }
}

fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

fn json(out: &Output) -> serde_json::Value {
    serde_json::from_slice(&out.stdout).unwrap_or_else(|e| {
        panic!(
            "stdout is not JSON ({e}): {}\nstderr: {}",
            stdout(out),
            stderr(out)
        )
    })
}

#[track_caller]
fn assert_ok(out: &Output) {
    assert!(
        out.status.success(),
        "expected success, got {:?}\nstdout: {}\nstderr: {}",
        out.status.code(),
        stdout(out),
        stderr(out)
    );
}

#[track_caller]
fn assert_no_panic(out: &Output) {
    let err = stderr(out);
    assert!(!err.contains("panicked"), "the CLI panicked: {err}");
    // A panic under `panic = "abort"` or a signal leaves no exit code.
    assert!(out.status.code().is_some(), "killed by a signal: {err}");
}

/// Write a minimal EPUB 3 with the given chapters (title, body HTML).
fn make_epub(path: &Path, title: &str, author: &str, chapters: &[(&str, &str)]) {
    make_epub_with(path, title, author, chapters, "", None)
}

/// A small PNG, for EPUB covers.
fn png_bytes() -> Vec<u8> {
    let image = image::RgbImage::from_pixel(8, 12, image::Rgb([200, 40, 40]));
    let mut bytes = Vec::new();
    image
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .unwrap();
    bytes
}

fn make_epub_with(
    path: &Path,
    title: &str,
    author: &str,
    chapters: &[(&str, &str)],
    extra_metadata: &str,
    cover_png: Option<&[u8]>,
) {
    let file = std::fs::File::create(path).expect("create epub");
    let mut zip = zip::ZipWriter::new(file);
    let stored =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("mimetype", stored).unwrap();
    zip.write_all(b"application/epub+zip").unwrap();
    zip.start_file("META-INF/container.xml", stored).unwrap();
    zip.write_all(br#"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#).unwrap();
    let mut manifest: String = (0..chapters.len())
        .map(|i| {
            format!(r#"<item id="c{i}" href="c{i}.xhtml" media-type="application/xhtml+xml"/>"#)
        })
        .collect();
    if cover_png.is_some() {
        manifest.push_str(
            r#"<item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>"#,
        );
    }
    let spine: String = (0..chapters.len())
        .map(|i| format!(r#"<itemref idref="c{i}"/>"#))
        .collect();
    zip.start_file("OEBPS/content.opf", stored).unwrap();
    write!(
        zip,
        r#"<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf"><dc:identifier id="id">urn:test:{title}</dc:identifier><dc:title>{title}</dc:title><dc:creator>{author}</dc:creator><dc:language>en</dc:language>{extra_metadata}</metadata><manifest>{manifest}</manifest><spine>{spine}</spine></package>"#
    )
    .unwrap();
    if let Some(png) = cover_png {
        zip.start_file("OEBPS/cover.png", stored).unwrap();
        zip.write_all(png).unwrap();
    }
    for (i, (heading, body)) in chapters.iter().enumerate() {
        zip.start_file(format!("OEBPS/c{i}.xhtml"), stored).unwrap();
        write!(
            zip,
            r#"<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>{heading}</title></head><body><h1>{heading}</h1>{body}</body></html>"#
        )
        .unwrap();
    }
    zip.finish().unwrap();
}

fn sha256_hex(path: &Path) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(std::fs::read(path).unwrap()))
}

fn count(conn: &rusqlite::Connection, sql: &str, id: &str) -> i64 {
    conn.query_row(sql, [id], |r| r.get(0)).unwrap()
}

fn library_kv(sb: &Sandbox) -> Option<serde_json::Value> {
    sb.db()
        .query_row(
            "SELECT value FROM kv_store WHERE key = 'zustand:theorem-library'",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .map(|text| serde_json::from_str(&text).unwrap())
}

const APP_BOOK: &str = "app-book-1";
const APP_ANNOTATION: &str = "app-annotation-1";

/// A library in the shape the 1.6.0 app leaves it: the book in SQLite
/// (`book_metadata`, `books`, its file in `book-cache/`, search entry), a
/// highlight in `book_annotations`, and the persisted KV copy at version 11
/// with empty `books`/`annotations` and one shelf holding the book.
fn seed_app_library(sb: &Sandbox) {
    // Let the CLI create the schema first.
    assert_ok(&sb.run(&["library", "list"]));
    let source = sb.path().join("app-source.epub");
    make_epub(
        &source,
        "Sample Field Guide",
        "Ada Example",
        &[
            (
                "Chapter One",
                "<p>The lighthouse keeper counted the ships at dusk.</p>",
            ),
            (
                "Chapter Two",
                "<p>Morning came, and the keeper wrote the log.</p>",
            ),
        ],
    );
    let cache = sb.data_dir().join("book-cache");
    std::fs::create_dir_all(&cache).unwrap();
    std::fs::copy(&source, cache.join(format!("{APP_BOOK}.book"))).unwrap();
    let book = serde_json::json!({
        "id": APP_BOOK,
        "title": "Sample Field Guide",
        "author": "Ada Example",
        "format": "epub",
        "filePath": source.to_string_lossy(),
        "contentHash": sha256_hex(&source),
        "fileSize": std::fs::metadata(&source).unwrap().len(),
        "progress": 0.25,
        "isFavorite": false,
        "tags": ["sea"],
        "addedAt": "2026-10-01T10:00:00.000Z",
    });
    let annotation = serde_json::json!({
        "id": APP_ANNOTATION,
        "bookId": APP_BOOK,
        "type": "highlight",
        "location": "epubcfi(/6/2!/4/2,/1:4,/1:14)",
        "selectedText": "lighthouse",
        "color": "yellow",
        "createdAt": "2026-10-01T10:05:00.000Z",
    });
    let kv = serde_json::json!({
        "state": {
            "books": [],
            "annotations": [],
            "collections": [{
                "id": "shelf-1", "name": "Sea", "bookIds": [APP_BOOK], "kind": "general",
                "createdAt": "2026-10-01T10:00:00.000Z", "updatedAt": "2026-10-01T10:00:00.000Z",
            }],
            "deletionTombstones": [],
            "recentBooksCache": [],
        },
        "version": 11,
    });
    let conn = sb.db();
    conn.execute(
        "INSERT INTO books(id, data, updated_at) VALUES(?1, X'', unixepoch())",
        [APP_BOOK],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO materialized_books(book_id, source_updated_at) VALUES(?1, unixepoch())",
        [APP_BOOK],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO book_metadata(book_id, metadata_json) VALUES(?1, ?2)",
        [APP_BOOK, &book.to_string()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO books_fts(id, title, author) VALUES(?1, 'Sample Field Guide', 'Ada Example')",
        [APP_BOOK],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO book_annotations(id, book_id, annotation_json) VALUES(?1, ?2, ?3)",
        [APP_ANNOTATION, APP_BOOK, &annotation.to_string()],
    )
    .unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO kv_store(key, value) VALUES('zustand:theorem-library', ?1)",
        [kv.to_string()],
    )
    .unwrap();
}

// ── A1: no display ──────────────────────────────────────────────────────────

#[test]
fn runs_without_a_display() {
    let sb = Sandbox::new();
    let out = sb.run(&["--json", "library", "list"]);
    assert_no_panic(&out);
    assert_ok(&out);
    assert_eq!(json(&out), serde_json::json!([]));
    // The CLI used the app's data folder in the sandbox home.
    assert!(sb.data_dir().join("theorem.db").is_file());
}

#[test]
fn sync_without_a_display_fails_with_a_message() {
    let sb = Sandbox::new();
    let out = sb.run(&["sync", "status"]);
    assert_no_panic(&out);
    assert!(!out.status.success());
    assert!(
        stderr(&out).contains("graphical session"),
        "unexpected message: {}",
        stderr(&out)
    );
}

// ── A2: the 1.6.0 library model ─────────────────────────────────────────────

#[test]
fn app_made_books_and_highlights_are_listed_and_readable() {
    let sb = Sandbox::new();
    seed_app_library(&sb);

    let list = sb.run(&["--json", "library", "list"]);
    assert_ok(&list);
    let books = json(&list);
    assert_eq!(books.as_array().unwrap().len(), 1, "{books}");
    assert_eq!(books[0]["id"], APP_BOOK);
    assert_eq!(books[0]["title"], "Sample Field Guide");

    let info = sb.run(&["--json", "library", "info", APP_BOOK]);
    assert_ok(&info);
    assert_eq!(json(&info)["annotationCount"], 1);

    let highlights = sb.run(&["--json", "highlights", "list", "--book", APP_BOOK]);
    assert_ok(&highlights);
    let highlights = json(&highlights);
    assert_eq!(highlights[0]["id"], APP_ANNOTATION);
    assert_eq!(highlights[0]["bookId"], APP_BOOK);

    let read = sb.run(&["read", APP_BOOK, "--chapter", "1"]);
    assert_ok(&read);
    assert!(stdout(&read).contains("lighthouse keeper"));

    let search = sb.run(&["--json", "search", "Field"]);
    assert_ok(&search);
    assert_eq!(json(&search)[0]["book_id"], APP_BOOK);

    let shelves = sb.run(&["--json", "shelf", "list"]);
    assert_ok(&shelves);
    assert_eq!(json(&shelves)[0]["bookIds"][0], APP_BOOK);
}

#[test]
fn app_made_books_are_editable() {
    let sb = Sandbox::new();
    seed_app_library(&sb);

    assert_ok(&sb.run(&["library", "favorite", APP_BOOK, "on"]));
    assert_ok(&sb.run(&["library", "edit-meta", APP_BOOK, "--title", "Renamed Guide"]));

    let conn = sb.db();
    let meta: String = conn
        .query_row(
            "SELECT metadata_json FROM book_metadata WHERE book_id = ?1",
            [APP_BOOK],
            |r| r.get(0),
        )
        .unwrap();
    let meta: serde_json::Value = serde_json::from_str(&meta).unwrap();
    assert_eq!(meta["isFavorite"], true);
    assert_eq!(meta["title"], "Renamed Guide");
    // Untouched fields stay; the edit is stamped for sync like the app does.
    assert_eq!(meta["progress"], 0.25);
    assert_eq!(meta["tags"][0], "sea");
    assert!(meta["metadataUpdatedAt"].is_string());
    assert!(
        meta["metadataBaseAt"].is_string(),
        "the second edit names the first as its base"
    );

    // The search entry and the EPUB itself follow the new title.
    let search = sb.run(&["--json", "search", "Renamed"]);
    assert_eq!(json(&search)[0]["book_id"], APP_BOOK);
    let file = sb.data_dir().join(format!("book-cache/{APP_BOOK}.book"));
    let mut archive = zip::ZipArchive::new(std::fs::File::open(file).unwrap()).unwrap();
    let mut opf = String::new();
    std::io::Read::read_to_string(&mut archive.by_name("OEBPS/content.opf").unwrap(), &mut opf)
        .unwrap();
    assert!(opf.contains("Renamed Guide"), "{opf}");

    // The CLI never puts books back into the KV copy.
    let kv = library_kv(&sb).unwrap();
    assert_eq!(kv["state"]["books"], serde_json::json!([]));
    assert_eq!(kv["version"], 11);
}

#[test]
fn app_made_books_and_highlights_are_deletable() {
    let sb = Sandbox::new();
    seed_app_library(&sb);

    // Adding a highlight to an app-made book works (it used to hit a
    // FOREIGN KEY error on CLI-imported books).
    let added = sb.run(&[
        "--json",
        "highlights",
        "add",
        APP_BOOK,
        "--text",
        "the ships",
        "--note",
        "count",
    ]);
    assert_ok(&added);
    let new_id = json(&added)["id"].as_str().unwrap().to_string();
    let row: String = sb
        .db()
        .query_row(
            "SELECT annotation_json FROM book_annotations WHERE id = ?1",
            [&new_id],
            |r| r.get(0),
        )
        .unwrap();
    let row: serde_json::Value = serde_json::from_str(&row).unwrap();
    assert_eq!(row["noteContent"], "count");
    assert_eq!(row["bookId"], APP_BOOK);

    assert_ok(&sb.run(&["highlights", "delete", APP_ANNOTATION]));
    let conn = sb.db();
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM book_annotations WHERE id = ?1",
            APP_ANNOTATION
        ),
        0
    );
    let missing = sb.run(&["highlights", "delete", APP_ANNOTATION]);
    assert!(!missing.status.success());

    assert_ok(&sb.run(&["library", "remove", APP_BOOK]));
    for sql in [
        "SELECT COUNT(*) FROM book_metadata WHERE book_id = ?1",
        "SELECT COUNT(*) FROM books WHERE id = ?1",
        "SELECT COUNT(*) FROM book_annotations WHERE book_id = ?1",
        "SELECT COUNT(*) FROM materialized_books WHERE book_id = ?1",
        "SELECT COUNT(*) FROM books_fts WHERE id = ?1",
    ] {
        assert_eq!(count(&conn, sql, APP_BOOK), 0, "{sql}");
    }
    assert!(!sb
        .data_dir()
        .join(format!("book-cache/{APP_BOOK}.book"))
        .exists());

    let kv = library_kv(&sb).unwrap();
    let tombstones = kv["state"]["deletionTombstones"].as_array().unwrap();
    for (id, kind) in [
        (APP_ANNOTATION, "annotation"),
        (APP_BOOK, "book"),
        (new_id.as_str(), "annotation"),
    ] {
        assert!(
            tombstones
                .iter()
                .any(|t| t["entityId"] == id && t["entityType"] == kind),
            "missing {kind} tombstone for {id}: {tombstones:?}"
        );
    }
    assert_eq!(
        kv["state"]["collections"][0]["bookIds"],
        serde_json::json!([])
    );
    assert_eq!(kv["state"]["books"], serde_json::json!([]));

    let list = sb.run(&["--json", "library", "list"]);
    assert_eq!(json(&list), serde_json::json!([]));
}

#[test]
fn imports_register_books_like_the_app() {
    let sb = Sandbox::new();
    std::fs::create_dir_all(sb.path().join("books")).unwrap();
    let png = png_bytes();
    make_epub_with(
        &sb.path().join("books/dune.epub"),
        "Dune Messiah",
        "Frank Herbert",
        &[("One", "<p>Text.</p>")],
        r#"<meta name="calibre:series" content="Dune"/><meta name="calibre:series_index" content="2.5"/>"#,
        Some(&png),
    );
    // A relative path, from the sandbox home as working directory.
    let out = sb.run(&["--json", "library", "add", "books/dune.epub"]);
    assert_ok(&out);
    let report = json(&out);
    let book = &report["added"][0];
    let id = book["id"].as_str().unwrap().to_string();
    assert_eq!(book["title"], "Dune Messiah");

    let conn = sb.db();
    let meta: String = conn
        .query_row(
            "SELECT metadata_json FROM book_metadata WHERE book_id = ?1",
            [&id],
            |r| r.get(0),
        )
        .unwrap();
    let meta: serde_json::Value = serde_json::from_str(&meta).unwrap();
    let absolute = std::fs::canonicalize(sb.path().join("books/dune.epub")).unwrap();
    assert_eq!(meta["filePath"], absolute.to_string_lossy().as_ref());
    assert_eq!(meta["series"], "Dune");
    assert_eq!(meta["seriesIndex"], 2.5);
    assert_eq!(meta["format"], "epub");
    assert_eq!(meta["contentHash"], sha256_hex(&absolute));
    assert_eq!(meta["progress"], 0);
    assert_eq!(meta["isFavorite"], false);
    for sql in [
        "SELECT COUNT(*) FROM books WHERE id = ?1",
        "SELECT COUNT(*) FROM materialized_books WHERE book_id = ?1",
        "SELECT COUNT(*) FROM covers WHERE book_id = ?1 AND data IS NOT NULL",
        "SELECT COUNT(*) FROM books_fts WHERE id = ?1",
    ] {
        assert_eq!(count(&conn, sql, &id), 1, "{sql}");
    }
    assert!(sb
        .data_dir()
        .join(format!("book-cache/{id}.book"))
        .is_file());
    // Nothing is written to the KV copy's book list.
    if let Some(kv) = library_kv(&sb) {
        assert_eq!(kv["state"]["books"], serde_json::json!([]));
    }

    // A highlight on a CLI-imported book works (FOREIGN KEY error before).
    assert_ok(&sb.run(&["highlights", "add", &id, "--text", "Text"]));
    let read = sb.run(&["read", &id]);
    assert_ok(&read);
    assert!(stdout(&read).contains("Text."));
}

// ── A8: imports report every file ───────────────────────────────────────────

#[test]
fn imports_report_failures_and_duplicates_and_survive_symlink_loops() {
    let sb = Sandbox::new();
    let dir = sb.path().join("shelf");
    std::fs::create_dir_all(dir.join("nested")).unwrap();
    make_epub(&dir.join("one.epub"), "Book One", "A", &[("I", "<p>x</p>")]);
    // The same content under another name is a duplicate.
    std::fs::copy(dir.join("one.epub"), dir.join("nested/copy.epub")).unwrap();
    // A symlink back to the root must not loop forever.
    std::os::unix::fs::symlink(&dir, dir.join("nested/loop")).unwrap();
    // An empty "book" fails with a reason.
    std::fs::write(dir.join("empty.epub"), b"").unwrap();

    let out = sb.run(&["--json", "library", "import", "shelf"]);
    assert_no_panic(&out);
    assert_eq!(
        out.status.code(),
        Some(1),
        "a failed file makes the exit non-zero"
    );
    let report = json(&out);
    assert_eq!(report["added"].as_array().unwrap().len(), 1, "{report}");
    assert_eq!(
        report["duplicates"].as_array().unwrap().len(),
        1,
        "{report}"
    );
    let failed = report["failed"].as_array().unwrap();
    assert_eq!(failed.len(), 1, "{report}");
    assert!(failed[0]["path"].as_str().unwrap().ends_with("empty.epub"));
    assert!(!failed[0]["error"].as_str().unwrap().is_empty());

    // Importing again finds everything already there (matched by content).
    let again = sb.run(&["--json", "library", "add", "shelf/one.epub", "missing.epub"]);
    assert_eq!(again.status.code(), Some(1));
    let again = json(&again);
    assert_eq!(again["added"], serde_json::json!([]));
    assert_eq!(again["duplicates"][0]["title"], "Book One");
    assert_eq!(again["failed"][0]["error"], "file does not exist");

    let list = sb.run(&["--json", "library", "list"]);
    assert_eq!(json(&list).as_array().unwrap().len(), 1);
}

// ── A3: storage cleanup goes by the library's records ───────────────────────

#[test]
fn storage_cleanup_keeps_synced_books_and_removes_real_leftovers() {
    let sb = Sandbox::new();
    seed_app_library(&sb);
    let conn = sb.db();
    // A book synced from another device: a record and a cover, no file yet.
    conn.execute(
        "INSERT INTO books(id, data, updated_at) VALUES('synced-1', X'', unixepoch())",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO book_metadata(book_id, metadata_json) VALUES('synced-1', '{\"id\":\"synced-1\",\"title\":\"Synced\"}')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO covers(book_id, data_url, data, mime) VALUES('synced-1', '', X'89504E47', 'image/png')",
        [],
    )
    .unwrap();
    // A real leftover: a book row and cover with no library record.
    conn.execute(
        "INSERT INTO books(id, data, updated_at) VALUES('gone-1', X'', unixepoch())",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO covers(book_id, data_url, data, mime) VALUES('gone-1', '', X'89504E47', 'image/png')",
        [],
    )
    .unwrap();

    let out = sb.run(&["--json", "storage", "cleanup"]);
    assert_ok(&out);
    let cover = "SELECT COUNT(*) FROM covers WHERE book_id = ?1";
    assert_eq!(count(&conn, cover, "synced-1"), 1);
    assert_eq!(count(&conn, cover, "gone-1"), 0);
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM books WHERE id = ?1", "gone-1"),
        0
    );
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM books WHERE id = ?1", APP_BOOK),
        1
    );
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM books WHERE id = ?1",
            "synced-1"
        ),
        1
    );
}

// ── A4: no lost updates, and no writes behind the running app ───────────────

#[test]
fn parallel_writes_are_not_lost() {
    let sb = Sandbox::new();
    seed_app_library(&sb);
    let children: Vec<_> = (0..8)
        .map(|i| {
            sb.command(&["shelf", "create", &format!("Shelf {i}")])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap()
        })
        .collect();
    for child in children {
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "{}", stderr(&out));
    }
    let kv = library_kv(&sb).unwrap();
    // The seeded shelf plus all eight.
    assert_eq!(
        kv["state"]["collections"].as_array().unwrap().len(),
        9,
        "{kv}"
    );
}

#[test]
fn writes_are_refused_while_the_app_runs() {
    let sb = Sandbox::new();
    seed_app_library(&sb);
    // Hold the lock the way the running app does.
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(sb.data_dir().join("theorem-app.lock"))
        .unwrap();
    lock.try_lock().unwrap();

    let refused = sb.run(&["shelf", "create", "Blocked"]);
    assert_no_panic(&refused);
    assert_eq!(refused.status.code(), Some(5));
    assert!(
        stderr(&refused).contains("Theorem is running"),
        "{}",
        stderr(&refused)
    );
    let kv = library_kv(&sb).unwrap();
    assert_eq!(kv["state"]["collections"].as_array().unwrap().len(), 1);

    // Reading is fine while the app runs.
    assert_ok(&sb.run(&["library", "list"]));
    // --force writes anyway.
    assert_ok(&sb.run(&["--force", "shelf", "create", "Forced"]));
    drop(lock);
    assert_ok(&sb.run(&["shelf", "create", "After"]));
    let kv = library_kv(&sb).unwrap();
    assert_eq!(kv["state"]["collections"].as_array().unwrap().len(), 3);
}

// ── A9: chapters read as text ────────────────────────────────────────────────

#[test]
fn read_prints_clean_paragraphs() {
    let sb = Sandbox::new();
    let book = sb.path().join("styled.epub");
    make_epub(
        &book,
        "Styled",
        "B",
        &[(
            "Opening",
            "<style>p { margin: 0 }</style><script>var x = 1;</script><p>Caf&eacute; &amp; tea&#8212;at&nbsp;noon.</p><p>Second line.</p>",
        )],
    );
    let added = sb.run(&["--json", "library", "add", "styled.epub"]);
    assert_ok(&added);
    let id = json(&added)["added"][0]["id"].as_str().unwrap().to_string();
    let read = sb.run(&["read", &id]);
    assert_ok(&read);
    let text = stdout(&read);
    assert_eq!(
        text, "Opening\n\nCafé & tea—at\u{a0}noon.\n\nSecond line.\n",
        "{text:?}"
    );
}

// ── A10/A12: help, and usage errors never start the app ─────────────────────

#[test]
fn help_works_and_bad_command_lines_are_usage_errors() {
    let sb = Sandbox::new();
    let help = sb.run(&["help"]);
    assert_ok(&help);
    assert!(
        stdout(&help).contains("Usage: theorem"),
        "{}",
        stdout(&help)
    );
    let sub = sb.run(&["help", "library"]);
    assert_ok(&sub);
    assert!(
        stdout(&sub).contains("Usage: theorem library"),
        "{}",
        stdout(&sub)
    );

    // Without a display the app would abort; a usage error exits 2 cleanly.
    for line in [
        &["libary"][..],
        &["--json"],
        &["--frobnicate"],
        &["missing.epub"],
    ] {
        let out = sb.run(line);
        assert_no_panic(&out);
        assert_eq!(out.status.code(), Some(2), "{line:?}: {}", stderr(&out));
    }
}

// ── A5: corrupt or legacy stores are errors, not panics ─────────────────────

#[test]
fn corrupt_library_store_is_an_error_not_a_panic() {
    for bad in [
        "not json",
        "[]",
        r#"{"state": 5}"#,
        r#"{"state": {"collections": {"a": 1}, "deletionTombstones": "x"}}"#,
        r#"{"state": {"collections": [7, {"id": "s", "name": "S", "bookIds": "nope"}]}}"#,
    ] {
        let sb = Sandbox::new();
        seed_app_library(&sb);
        sb.db()
            .execute(
                "UPDATE kv_store SET value = ?1 WHERE key = 'zustand:theorem-library'",
                [bad],
            )
            .unwrap();
        for line in [
            &["shelf", "list"][..],
            &["shelf", "create", "New"],
            &["shelf", "add", "S", APP_BOOK],
            &["shelf", "remove", "S", APP_BOOK],
            &["shelf", "delete", "S"],
            &["highlights", "delete", APP_ANNOTATION],
            &["library", "remove", APP_BOOK],
            &["export"],
            &["--json", "export"],
            &["library", "list"],
            &["stats"],
            &["feeds", "list"],
        ] {
            let out = sb.run(line);
            assert_no_panic(&out);
            assert!(
                matches!(out.status.code(), Some(0..=3)),
                "{bad} {line:?}: {:?} {}",
                out.status.code(),
                stderr(&out)
            );
        }
    }
}

#[test]
fn corrupt_settings_and_rss_stores_are_errors_not_panics() {
    let sb = Sandbox::new();
    seed_app_library(&sb);
    let conn = sb.db();
    for (key, value) in [
        ("zustand:theorem-settings", r#"{"state": {"stats": "x"}}"#),
        ("zustand:theorem-rss", r#"{"state": []}"#),
    ] {
        conn.execute(
            "INSERT OR REPLACE INTO kv_store(key, value) VALUES(?1, ?2)",
            [key, value],
        )
        .unwrap();
    }
    for line in [
        &["stats"][..],
        &["feeds", "list"],
        &["feeds", "remove", "x"],
        &["export"],
    ] {
        let out = sb.run(line);
        assert_no_panic(&out);
    }
}

/// Path -> (content type, body), shared with the server thread.
type Pages = std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, (String, Vec<u8>)>>>;

/// Serve fixed documents over HTTP on localhost: path -> (content type, body).
/// The body of a path can be swapped while the server runs.
struct Server {
    port: u16,
    pages: Pages,
}

impl Server {
    fn start() -> Self {
        use std::io::{BufRead, BufReader};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let pages: Pages = Default::default();
        let shared = pages.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                if reader.read_line(&mut request).is_err() {
                    continue;
                }
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                }
                let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
                let page = shared.lock().unwrap().get(&path).cloned();
                let (status, kind, body) = match page {
                    Some((kind, body)) => ("200 OK", kind, body),
                    None => (
                        "404 Not Found",
                        "text/plain".to_string(),
                        b"missing".to_vec(),
                    ),
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(&body);
            }
        });
        Self { port, pages }
    }

    fn put(&self, path: &str, kind: &str, body: impl Into<Vec<u8>>) {
        self.pages
            .lock()
            .unwrap()
            .insert(path.to_string(), (kind.to_string(), body.into()));
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }
}

// ── A6: feeds in SQLite, parsed like the app ────────────────────────────────

const RSS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Channel Title Blog</title><link>https://example.org/</link>
<item><title>First Post</title><link>https://example.org/1</link><pubDate>Thu, 01 Jan 2026 00:00:00 GMT</pubDate><description><![CDATA[<p>Café — 日本語 “quotes”</p>]]></description></item>
<item><title>Second &amp; Post</title><link>https://example.org/2</link><description>plain</description></item>
</channel></rss>"#;

const ATOM: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Feed Name</title><link href="https://example.com/"/>
<entry><title>Atom Entry</title><link rel="enclosure" href="https://example.com/a.mp3"/><link rel="alternate" href="https://example.com/a"/><updated>2026-01-02T03:04:05Z</updated><summary>Sum</summary></entry>
</feed>"#;

fn feed_articles(sb: &Sandbox, feed_id: &str) -> Vec<(String, String, Option<i64>, String)> {
    let conn = sb.db();
    let mut stmt = conn
        .prepare(
            "SELECT a.title, a.url, a.published_at, COALESCE(c.content, '') FROM rss_articles a \
             LEFT JOIN rss_article_content c ON c.article_id = a.id WHERE a.feed_id = ?1 ORDER BY a.url",
        )
        .unwrap();
    let rows = stmt
        .query_map([feed_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .unwrap();
    rows.map(|r| r.unwrap()).collect()
}

#[test]
fn feeds_are_stored_like_the_app_stores_them() {
    let sb = Sandbox::new();
    let server = Server::start();
    server.put("/rss.xml", "application/rss+xml", RSS);
    server.put("/atom.xml", "application/atom+xml", ATOM);
    server.put(
        "/page.html",
        "text/html",
        "<!DOCTYPE html><html><body><p>hi</p></body></html>",
    );

    let added = sb.run(&["--json", "feeds", "add", &server.url("/rss.xml")]);
    assert_ok(&added);
    let added = json(&added);
    assert_eq!(
        added["title"], "Channel Title Blog",
        "the channel's title, not an item's"
    );
    assert_eq!(added["articles"], 2);
    let rss_id = added["id"].as_str().unwrap().to_string();
    let articles = feed_articles(&sb, &rss_id);
    assert_eq!(articles[0].0, "First Post");
    assert_eq!(articles[0].2, Some(1_767_225_600_000), "pubDate in ms");
    assert!(
        articles[0].3.contains("Café — 日本語 “quotes”"),
        "{:?}",
        articles[0].3
    );
    assert_eq!(articles[1].0, "Second & Post");

    let atom = sb.run(&["--json", "feeds", "add", &server.url("/atom.xml")]);
    assert_ok(&atom);
    let atom = json(&atom);
    assert_eq!(atom["title"], "Atom Feed Name");
    let atom_articles = feed_articles(&sb, atom["id"].as_str().unwrap());
    assert_eq!(
        atom_articles[0].1, "https://example.com/a",
        "rel=alternate, not the enclosure"
    );
    assert_eq!(atom_articles[0].2, Some(1_767_323_045_000));

    // Not a feed, a missing page, and a duplicate are refused.
    let page = sb.run(&["feeds", "add", &server.url("/page.html")]);
    assert_eq!(page.status.code(), Some(1));
    assert!(
        stderr(&page).contains("not an RSS or Atom feed"),
        "{}",
        stderr(&page)
    );
    let missing = sb.run(&["feeds", "add", &server.url("/nope.xml")]);
    assert_eq!(missing.status.code(), Some(4));
    let again = sb.run(&["feeds", "add", &format!("{}/", server.url("/rss.xml"))]);
    assert!(!again.status.success());

    let list = sb.run(&["--json", "feeds", "list"]);
    assert_ok(&list);
    assert_eq!(json(&list).as_array().unwrap().len(), 2);

    // Refresh adds only new items and keeps the unread count right.
    server.put(
        "/rss.xml",
        "application/rss+xml",
        RSS.replace(
            "</channel>",
            "<item><title>Third</title><link>https://example.org/3</link></item></channel>",
        ),
    );
    let refreshed = sb.run(&["--json", "feeds", "refresh"]);
    assert_ok(&refreshed);
    let refreshed = json(&refreshed);
    let rss_result = refreshed
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == rss_id.as_str())
        .unwrap();
    assert_eq!(rss_result["newArticles"], 1);
    assert_eq!(feed_articles(&sb, &rss_id).len(), 3);
    let unread: i64 = sb
        .db()
        .query_row(
            "SELECT unread_count FROM rss_feeds WHERE id = ?1",
            [&rss_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(unread, 3);

    // Removing deletes the articles and leaves a tombstone for sync.
    assert_ok(&sb.run(&["feeds", "remove", &rss_id]));
    assert!(feed_articles(&sb, &rss_id).is_empty());
    let kv = library_kv(&sb).unwrap();
    assert!(kv["state"]["deletionTombstones"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["entityId"] == rss_id.as_str() && t["entityType"] == "feed"));
    let gone = sb.run(&["feeds", "remove", &rss_id]);
    assert_eq!(gone.status.code(), Some(3));
}

// ── A7: OPDS downloads use the app's download and import path ───────────────

#[test]
fn opds_download_imports_books_and_refuses_web_pages() {
    let sb = Sandbox::new();
    let server = Server::start();
    let book = sb.path().join("served.epub");
    make_epub(
        &book,
        "Good Book",
        "Ann Author",
        &[("One", "<p>Served text.</p>")],
    );
    server.put(
        "/book.epub",
        "application/epub+zip",
        std::fs::read(&book).unwrap(),
    );
    server.put(
        "/page.html",
        "text/html",
        "<!DOCTYPE html><html><body>Sign in</body></html>",
    );
    server.put(
        "/opds.xml",
        "application/atom+xml;profile=opds-catalog",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><id>urn:test</id><title>Local Test Catalog</title><updated>2026-01-01T00:00:00Z</updated>
<entry><title>Good Book</title><id>urn:1</id><updated>2026-01-01T00:00:00Z</updated><author><name>Ann Author</name></author>
<link rel="http://opds-spec.org/acquisition" href="/book.epub" type="application/epub+zip"/></entry>
<entry><title>Fake Book</title><id>urn:2</id><updated>2026-01-01T00:00:00Z</updated>
<link rel="http://opds-spec.org/acquisition" href="/page.html" type="application/epub+zip"/></entry>
<entry><title>Paid Book</title><id>urn:3</id><updated>2026-01-01T00:00:00Z</updated>
<link rel="http://opds-spec.org/acquisition/buy" href="/buy" type="text/html"/></entry>
</feed>"#,
    );
    let catalog = server.url("/opds.xml");

    let good = sb.run(&["--json", "opds", "download", &catalog, "Good"]);
    assert_ok(&good);
    let report = json(&good);
    assert_eq!(report["added"][0]["title"], "Good Book");
    let id = report["added"][0]["id"].as_str().unwrap().to_string();
    let read = sb.run(&["read", &id]);
    assert!(stdout(&read).contains("Served text."), "{}", stdout(&read));

    let fake = sb.run(&["opds", "download", &catalog, "Fake"]);
    assert_no_panic(&fake);
    assert_eq!(fake.status.code(), Some(1));
    // Refused by its content type (or, when that lies, by its content).
    let err = stderr(&fake);
    assert!(
        err.contains("text/html") || err.contains("web page"),
        "{err}"
    );

    let paid = sb.run(&["opds", "download", &catalog, "Paid"]);
    assert!(!paid.status.success());
    let missing = sb.run(&["opds", "download", &catalog, "Nothing like this"]);
    assert_eq!(missing.status.code(), Some(3));

    let list = sb.run(&["--json", "library", "list"]);
    assert_eq!(json(&list).as_array().unwrap().len(), 1);
}

// ── A11: stats in the units the app uses ────────────────────────────────────

#[test]
fn stats_show_minutes_as_the_app_counts_them() {
    let sb = Sandbox::new();
    // A fresh library has no statistics yet: zeros, not an error.
    let empty = sb.run(&["stats"]);
    assert_ok(&empty);
    assert!(stdout(&empty).contains("0 min"), "{}", stdout(&empty));

    sb.db()
        .execute(
            "INSERT OR REPLACE INTO kv_store(key, value) VALUES('zustand:theorem-settings', ?1)",
            [r#"{"state":{"stats":{"totalReadingTime":125,"currentStreak":1,"longestStreak":4,"booksCompleted":2,"dailyGoal":30}},"version":1}"#],
        )
        .unwrap();
    let out = sb.run(&["stats"]);
    assert_ok(&out);
    let text = stdout(&out);
    assert!(text.contains("total reading time: 2 h 05 min"), "{text}");
    assert!(text.contains("current streak: 1 day\n"), "{text}");
    assert!(text.contains("longest streak: 4 days"), "{text}");
    assert!(text.contains("daily goal: 30 min a day"), "{text}");
}

// ── quick wins: search syntax, prefixes, limits ─────────────────────────────

#[test]
fn library_search_takes_any_text_and_matches_word_starts() {
    let sb = Sandbox::new();
    seed_app_library(&sb);
    let prefix = sb.run(&["--json", "search", "Fie"]);
    assert_ok(&prefix);
    assert_eq!(json(&prefix)[0]["book_id"], APP_BOOK);
    let two_words = sb.run(&["--json", "search", "ada guide"]);
    assert_eq!(json(&two_words)[0]["book_id"], APP_BOOK);
    // FTS5 syntax characters used to fail with "fts5: syntax error".
    for text in ["\"", "field-guide", "(", "AND", "a:b", "*"] {
        let out = sb.run(&["--json", "search", text]);
        assert_no_panic(&out);
        assert_ok(&out);
    }
    let limited = sb.run(&["--json", "search", "--limit", "0", "Field"]);
    assert_eq!(json(&limited), serde_json::json!([]));
}

// ── quick wins: exit codes and JSON errors ──────────────────────────────────

#[test]
fn errors_have_exit_codes_and_json_form() {
    let sb = Sandbox::new();
    seed_app_library(&sb);
    for line in [
        &["library", "info", "nope"][..],
        &["read", "nope"],
        &["library", "favorite", "nope"],
        &["shelf", "delete", "No Such Shelf"],
        &["highlights", "delete", "nope"],
        &["feeds", "remove", "nope"],
    ] {
        let out = sb.run(line);
        assert_eq!(out.status.code(), Some(3), "{line:?}: {}", stderr(&out));
    }
    let usage = sb.run(&["library", "favorite", APP_BOOK, "sideways"]);
    assert_eq!(usage.status.code(), Some(2));

    let out = sb.run(&["--json", "library", "info", "nope"]);
    assert_eq!(out.status.code(), Some(3));
    assert!(out.stdout.is_empty(), "errors never go to stdout");
    let error: serde_json::Value = serde_json::from_slice(&out.stderr).unwrap();
    assert_eq!(error["exitCode"], 3);
    assert!(error["error"].as_str().unwrap().contains("nope"));
}
