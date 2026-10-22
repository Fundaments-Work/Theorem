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
    make_epub_with(path, title, author, chapters, "")
}

fn make_epub_with(
    path: &Path,
    title: &str,
    author: &str,
    chapters: &[(&str, &str)],
    extra_metadata: &str,
) {
    let file = std::fs::File::create(path).expect("create epub");
    let mut zip = zip::ZipWriter::new(file);
    let stored =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("mimetype", stored).unwrap();
    zip.write_all(b"application/epub+zip").unwrap();
    zip.start_file("META-INF/container.xml", stored).unwrap();
    zip.write_all(br#"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#).unwrap();
    let manifest: String = (0..chapters.len())
        .map(|i| {
            format!(r#"<item id="c{i}" href="c{i}.xhtml" media-type="application/xhtml+xml"/>"#)
        })
        .collect();
    let spine: String = (0..chapters.len())
        .map(|i| format!(r#"<itemref idref="c{i}"/>"#))
        .collect();
    zip.start_file("OEBPS/content.opf", stored).unwrap();
    write!(
        zip,
        r#"<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf"><dc:identifier id="id">urn:test:{title}</dc:identifier><dc:title>{title}</dc:title><dc:creator>{author}</dc:creator><dc:language>en</dc:language>{extra_metadata}</metadata><manifest>{manifest}</manifest><spine>{spine}</spine></package>"#
    )
    .unwrap();
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
