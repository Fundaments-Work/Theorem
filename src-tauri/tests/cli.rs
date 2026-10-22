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
    assert_eq!(out.status.code(), Some(1), "a failed file makes the exit non-zero");
    let report = json(&out);
    assert_eq!(report["added"].as_array().unwrap().len(), 1, "{report}");
    assert_eq!(report["duplicates"].as_array().unwrap().len(), 1, "{report}");
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
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM books WHERE id = ?1", "gone-1"), 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM books WHERE id = ?1", APP_BOOK), 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM books WHERE id = ?1", "synced-1"), 1);
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
    assert_eq!(kv["state"]["collections"].as_array().unwrap().len(), 9, "{kv}");
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
    assert!(stderr(&refused).contains("Theorem is running"), "{}", stderr(&refused));
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
        text,
        "Opening\n\nCafé & tea—at\u{a0}noon.\n\nSecond line.\n",
        "{text:?}"
    );
}
