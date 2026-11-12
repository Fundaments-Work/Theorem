use super::metadata::*;
use super::*;
use image::GenericImageView;
use std::io::Cursor;

#[test]
fn test_parse_title_author_patterns() {
    let p1 = Path::new("/path/to/Frank Herbert - Dune.epub");
    let (t1, a1) = parse_title_author_from_filename(p1);
    assert_eq!(t1, "Dune");
    assert_eq!(a1, "Frank Herbert");

    let p2 = Path::new("Foundation (Isaac Asimov).epub");
    let (t2, a2) = parse_title_author_from_filename(p2);
    assert_eq!(t2, "Foundation");
    assert_eq!(a2, "Isaac Asimov");

    let p3 = Path::new("Simple_Book_Title.pdf");
    let (t3, a3) = parse_title_author_from_filename(p3);
    assert_eq!(t3, "Simple Book Title");
    assert_eq!(a3, "Unknown Author");
}

#[test]
fn test_sha256_computation() {
    let temp_dir = tempfile::tempdir().unwrap();
    let file_path = temp_dir.path().join("test.txt");
    std::fs::write(&file_path, b"Hello World").unwrap();

    let hash = compute_file_sha256(&file_path).unwrap();
    assert_eq!(
        hash,
        "a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e"
    );
}

#[test]
fn test_opf_parsing() {
    let container_xml = r#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
</rootfiles>
</container>"#;
    let opf_path = extract_opf_path_from_container(container_xml);
    assert_eq!(opf_path, "OEBPS/content.opf");

    let opf_xml = r#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Neuromancer</dc:title>
    <dc:creator>William Gibson</dc:creator>
    <dc:description>The sky above the port was the color of television...</dc:description>
    <dc:publisher>Ace</dc:publisher>
    <dc:language>en</dc:language>
    <meta name="cover" content="cover-image-id"/>
</metadata>
<manifest>
    <item id="cover-image-id" href="images/cover.jpg" media-type="image/jpeg"/>
</manifest>
</package>"#;
    let meta = parse_opf_xml(opf_xml);
    assert_eq!(meta.title, "Neuromancer");
    assert_eq!(meta.author, "William Gibson");
    assert!(meta.description.unwrap().contains("The sky above the port"));
    assert_eq!(meta.publisher, Some("Ace".to_string()));
    assert_eq!(meta.language, Some("en".to_string()));
    assert_eq!(meta.cover_href, Some("images/cover.jpg".to_string()));
}

#[test]
fn test_opf_series_parsing() {
    let calibre_opf = r#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Fellowship of the Ring</dc:title>
    <dc:creator>J.R.R. Tolkien</dc:creator>
    <meta name="calibre:series" content="The Lord of the Rings"/>
    <meta name="calibre:series_index" content="1.0"/>
</metadata>
</package>"#;
    let meta1 = parse_opf_xml(calibre_opf);
    assert_eq!(meta1.series, Some("The Lord of the Rings".to_string()));
    assert_eq!(meta1.series_index, Some(1.0));

    let epub3_opf = r#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Two Towers</dc:title>
    <meta property="belongs-to-collection">The Lord of the Rings</meta>
    <meta property="group-position">2</meta>
</metadata>
</package>"#;
    let meta2 = parse_opf_xml(epub3_opf);
    assert_eq!(meta2.series, Some("The Lord of the Rings".to_string()));
    assert_eq!(meta2.series_index, Some(2.0));
}

#[test]
fn test_cbz_comic_info_and_cover_parsing() {
    use std::io::Write;

    let temp_dir = tempfile::tempdir().unwrap();
    let cbz_path = temp_dir.path().join("Saga 001.cbz");

    let comic_info = r#"<?xml version="1.0"?>
<ComicInfo>
<Title>Chapter One</Title>
<Series>Saga</Series>
<Number>1</Number>
</ComicInfo>"#;

    let img = image::RgbImage::new(10, 10);
    let mut png_bytes = Vec::new();
    img.write_to(&mut Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .unwrap();

    {
        let file = std::fs::File::create(&cbz_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);

        zip.start_file("ComicInfo.xml", options).unwrap();
        zip.write_all(comic_info.as_bytes()).unwrap();

        zip.start_file("001_cover.png", options).unwrap();
        zip.write_all(&png_bytes).unwrap();

        zip.finish().unwrap();
    }

    let parsed = parse_cbz_native(&cbz_path).unwrap();
    assert_eq!(parsed.title, "Chapter One");
    assert_eq!(parsed.series, Some("Saga".to_string()));
    assert_eq!(parsed.series_index, Some(1.0));
    assert!(parsed.cover_data_url.is_some());
}

#[test]
fn epub_check_accepts_real_epubs_and_rejects_damaged_ones() {
    let dir = tempfile::tempdir().unwrap();
    let good = fixture("epub/multi-chapter.epub");
    assert_eq!(check_epub_readable(&good), Ok(()));
    let junk = put(dir.path(), "junk.epub", b"this is not a zip archive at all");
    assert!(check_epub_readable(Path::new(&junk))
        .unwrap_err()
        .starts_with("Could not read this book"));
    let bytes = std::fs::read(&good).unwrap();
    let truncated = put(dir.path(), "cut.epub", &bytes[..bytes.len() / 2]);
    assert!(check_epub_readable(Path::new(&truncated)).is_err());
    // A ZIP that is not an EPUB (no package document).
    let mut zip = Vec::new();
    {
        let mut writer = zip::ZipWriter::new(Cursor::new(&mut zip));
        writer
            .start_file("notes.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        std::io::Write::write_all(&mut writer, b"hello").unwrap();
        writer.finish().unwrap();
    }
    let plain = put(dir.path(), "plain.epub", &zip);
    assert!(check_epub_readable(Path::new(&plain))
        .unwrap_err()
        .contains("OPF"));
    assert!(check_epub_readable(&dir.path().join("gone.epub")).is_err());
}

// ── Cover thumbnails ────────────────────────────────────────────────────

fn encode_png(img: &image::DynamicImage) -> Vec<u8> {
    let mut out = Vec::new();
    img.write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
        .unwrap();
    out
}

fn decode_data_url(url: &str) -> image::DynamicImage {
    use base64::Engine;
    let b64 = url.strip_prefix("data:image/jpeg;base64,").expect(url);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .unwrap();
    image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg).unwrap()
}

fn close(a: image::Rgb<u8>, b: [u8; 3]) -> bool {
    a.0.iter().zip(b).all(|(x, y)| x.abs_diff(y) <= 12)
}

#[test]
fn cover_thumbnails_fit_the_box_and_average_the_pixels() {
    // Top half red, bottom half blue: a box filter keeps both colours.
    let tall = image::RgbImage::from_fn(1200, 1800, |_, y| {
        if y < 900 {
            image::Rgb([220, 20, 20])
        } else {
            image::Rgb([20, 20, 220])
        }
    });
    let thumb = decode_data_url(&downsample_cover_to_data_url(&encode_png(&tall.into())).unwrap())
        .to_rgb8();
    assert_eq!(thumb.dimensions(), (360, 540));
    assert!(close(*thumb.get_pixel(180, 100), [220, 20, 20]));
    assert!(close(*thumb.get_pixel(180, 440), [20, 20, 220]));

    // A fine checkerboard averages to grey rather than aliasing.
    let checker = image::RgbImage::from_fn(1080, 1620, |x, y| {
        if (x + y) % 2 == 0 {
            image::Rgb([255, 255, 255])
        } else {
            image::Rgb([0, 0, 0])
        }
    });
    let thumb =
        decode_data_url(&downsample_cover_to_data_url(&encode_png(&checker.into())).unwrap())
            .to_rgb8();
    assert_eq!(thumb.dimensions(), (360, 540));
    assert!(close(*thumb.get_pixel(100, 100), [128, 128, 128]));
}

#[test]
fn cover_thumbnails_keep_the_aspect_ratio_of_odd_shapes() {
    let cases = [
        ((2000, 500), (360, 90)),
        ((100, 150), (100, 150)),
        ((5000, 1), (360, 1)),
        ((1, 5000), (1, 540)),
        ((361, 541), (360, 540)),
    ];
    for ((w, h), expected) in cases {
        let img = image::DynamicImage::ImageRgb8(image::RgbImage::new(w, h));
        let url =
            downsample_cover_to_data_url(&encode_png(&img)).unwrap_or_else(|| panic!("{w}x{h}"));
        let (tw, th) = decode_data_url(&url).dimensions();
        assert_eq!((tw, th), expected, "{w}x{h}");
    }
}

#[test]
fn cover_thumbnails_accept_transparency_and_reject_garbage() {
    let rgba = image::RgbaImage::from_pixel(800, 1200, image::Rgba([10, 200, 10, 128]));
    let url = downsample_cover_to_data_url(&encode_png(&rgba.into())).unwrap();
    assert_eq!(decode_data_url(&url).dimensions(), (360, 540));
    assert!(downsample_cover_to_data_url(b"not an image").is_none());
    assert!(downsample_cover_to_data_url(&[]).is_none());
}

// ── Batch ingest ────────────────────────────────────────────────────────

fn fixture(rel: &str) -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures")
        .join(rel)
}

fn put(dir: &Path, name: &str, bytes: &[u8]) -> String {
    let path = dir.join(name);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, bytes).unwrap();
    path.to_string_lossy().into_owned()
}

fn run(
    paths: &[String],
    cache: &Path,
    known: &[KnownBook],
    cancel: &AtomicBool,
) -> (IngestSummary, Vec<IngestItem>) {
    let items = std::sync::Mutex::new(Vec::new());
    let summary = ingest_files(paths, cache, known, cancel, &|item| {
        items.lock().unwrap().push(item)
    });
    (summary, items.into_inner().unwrap())
}

fn cache_files(cache: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(cache)
        .map(|it| {
            it.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

fn item_path(item: &IngestItem) -> &str {
    match item {
        IngestItem::Imported { path, .. }
        | IngestItem::Failed { path, .. }
        | IngestItem::Duplicate { path, .. } => path,
    }
}

fn reason_for<'a>(items: &'a [IngestItem], path: &str) -> &'a str {
    items
        .iter()
        .find_map(|item| match item {
            IngestItem::Failed { path: p, reason } if &**p == path => Some(&**reason),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no failure for {path}: {items:?}"))
}

#[test]
fn native_job_retains_the_checkpointed_identity_and_reports_measured_bytes() {
    let source = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let bytes = std::fs::read(fixture("epub/multi-chapter.epub")).unwrap();
    let path = put(source.path(), "book.epub", &bytes);
    let id = uuid::Uuid::new_v4().to_string();
    let reports = std::sync::Mutex::new(Vec::new());
    let item = ingest_job_file(
        &path,
        cache.path(),
        &id,
        &[],
        false,
        &Arc::new(AtomicBool::new(false)),
        &|stage, completed, total| {
            reports.lock().unwrap().push((stage, completed, total));
        },
    )
    .unwrap()
    .unwrap();
    let IngestItem::Imported { book, .. } = item else {
        panic!("expected imported book")
    };
    assert_eq!(&*book.id, id);
    assert_eq!(
        std::fs::read(cache.path().join(format!("{id}.book"))).unwrap(),
        bytes
    );
    let reports = reports.lock().unwrap();
    for stage in [ImportStage::Checking, ImportStage::Copying] {
        let completed = reports
            .iter()
            .rfind(|(actual, _, _)| {
                std::mem::discriminant(actual) == std::mem::discriminant(&stage)
            })
            .unwrap();
        assert_eq!(completed.1, bytes.len() as u64);
        assert_eq!(completed.2, Some(bytes.len() as u64));
    }
    assert!(matches!(
        reports.last(),
        Some((ImportStage::Saving, 0, None))
    ));
}

#[test]
fn native_job_cancellation_during_copy_removes_partial_and_final_files() {
    let source = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let bytes = vec![b'x'; 1024 * 1024];
    let path = put(source.path(), "large.pdf", &bytes);
    let cancel = Arc::new(AtomicBool::new(false));
    let id = uuid::Uuid::new_v4().to_string();
    let item = ingest_job_file(
        &path,
        cache.path(),
        &id,
        &[],
        false,
        &cancel,
        &|stage, completed, _| {
            if matches!(stage, ImportStage::Copying) && completed > 0 {
                cancel.store(true, Ordering::Relaxed);
            }
        },
    )
    .unwrap();
    assert!(item.is_none());
    assert!(cache_files(cache.path()).is_empty());
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[test]
fn native_job_moves_only_sources_explicitly_owned_by_the_materializer() {
    let bytes = std::fs::read(fixture("epub/multi-chapter.epub")).unwrap();
    for move_source in [false, true] {
        let source = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let folder = source.path().join("theorem_import");
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join("book.epub");
        std::fs::write(&path, &bytes).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let item = ingest_job_file(
            path.to_str().unwrap(),
            cache.path(),
            &id,
            &[],
            move_source,
            &Arc::new(AtomicBool::new(false)),
            &|_, _, _| {},
        )
        .unwrap()
        .unwrap();
        assert!(matches!(item, IngestItem::Imported { .. }));
        assert_eq!(path.exists(), !move_source);
        assert_eq!(
            std::fs::read(cache.path().join(format!("{id}.book"))).unwrap(),
            bytes
        );
    }
}

#[test]
fn native_job_detects_existing_bytes_without_copying_or_replacing_them() {
    let source = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let bytes = std::fs::read(fixture("epub/multi-chapter.epub")).unwrap();
    let path = put(source.path(), "book.epub", &bytes);
    let hash = compute_file_sha256(Path::new(&path)).unwrap();
    let known = [KnownBook {
        size: bytes.len() as u64,
        hash: hash.clone().into(),
    }];
    let item = ingest_job_file(
        &path,
        cache.path(),
        &uuid::Uuid::new_v4().to_string(),
        &known,
        false,
        &Arc::new(AtomicBool::new(false)),
        &|_, _, _| {},
    )
    .unwrap()
    .unwrap();
    assert!(matches!(item, IngestItem::Duplicate { content_hash, .. } if *content_hash == hash));
    assert!(cache_files(cache.path()).is_empty());
}

#[test]
fn every_file_is_imported_or_reported_with_a_reason() {
    let src = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let cache = cache.path().join("book-cache");
    let epub = std::fs::read(fixture("epub/multi-chapter.epub")).unwrap();
    let pdf = std::fs::read(fixture("pdf/page-labels.pdf")).unwrap();
    let good_epub = put(src.path(), "deep/a/b/c/d/e/f/Good – Ünï 書.epub", &epub);
    let good_pdf = put(src.path(), "Author - Paper.pdf", &pdf);
    let fb2zip = put(src.path(), "Tale.fb2.zip", b"zip-ish fb2 bytes");
    let empty = put(src.path(), "empty.epub", b"");
    let corrupt = put(
        src.path(),
        "corrupt.epub",
        b"this is not a zip archive at all",
    );
    let unsupported = put(src.path(), "notes.txt", b"hello");
    let missing = src.path().join("gone.epub").to_string_lossy().into_owned();
    std::fs::create_dir_all(src.path().join("folder.epub")).unwrap();
    let folder = src
        .path()
        .join("folder.epub")
        .to_string_lossy()
        .into_owned();

    let paths = vec![
        good_epub.clone(),
        good_pdf.clone(),
        fb2zip.clone(),
        empty.clone(),
        corrupt.clone(),
        unsupported.clone(),
        missing.clone(),
        folder.clone(),
        good_pdf.clone(), // listed twice: handled once
    ];
    let (summary, items) = run(&paths, &cache, &[], &AtomicBool::new(false));

    assert_eq!(
        summary,
        IngestSummary {
            total: 8,
            imported: 3,
            failed: 5,
            duplicates: 0,
            cancelled: false
        }
    );
    let mut reported: Vec<&str> = items.iter().map(item_path).collect();
    reported.sort();
    let mut expected: Vec<&str> = paths[..8].iter().map(String::as_str).collect();
    expected.sort();
    assert_eq!(reported, expected, "each path exactly once");

    assert_eq!(reason_for(&items, &empty), "The file is empty");
    assert!(reason_for(&items, &corrupt).starts_with("Could not read this book"));
    assert_eq!(
        reason_for(&items, &unsupported),
        "This kind of file is not supported"
    );
    assert_eq!(reason_for(&items, &missing), "The file is no longer there");
    assert_eq!(reason_for(&items, &folder), "Not a file");

    let mut stored = Vec::new();
    for item in &items {
        if let IngestItem::Imported { path, book } = item {
            let storage = book.storage_path.as_deref().expect("stored");
            assert!(Path::new(storage).is_file());
            assert_eq!(
                std::fs::read(storage).unwrap(),
                std::fs::read(&**path).unwrap()
            );
            assert_eq!(
                book.content_hash.as_deref(),
                compute_file_sha256(Path::new(&**path)).as_deref()
            );
            assert_eq!(book.file_size, std::fs::metadata(&**path).unwrap().len());
            stored.push(format!("{}.book", book.id));
            if **path == *fb2zip {
                assert_eq!(&*book.format, "fb2");
            }
            if **path == *good_epub {
                assert_eq!(&*book.format, "epub");
            }
        }
    }
    stored.sort();
    assert_eq!(cache_files(&cache), stored, "no partial or orphan files");
}

#[test]
fn duplicates_are_found_before_copying() {
    let src = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let epub = std::fs::read(fixture("epub/multi-chapter.epub")).unwrap();
    let pdf = std::fs::read(fixture("pdf/page-labels.pdf")).unwrap();
    let in_library = put(src.path(), "already.epub", &epub);
    let first = put(src.path(), "one/paper.pdf", &pdf);
    let second = put(src.path(), "two/paper copy.pdf", &pdf);
    let known = vec![KnownBook {
        size: epub.len() as u64,
        hash: compute_file_sha256(Path::new(&in_library)).unwrap().into(),
    }];

    let (summary, items) = run(
        &[in_library.clone(), first.clone(), second.clone()],
        cache.path(),
        &known,
        &AtomicBool::new(false),
    );
    assert_eq!(
        (summary.imported, summary.duplicates, summary.failed),
        (1, 2, 0)
    );
    assert!(items.iter().any(|i| matches!(i,
        IngestItem::Duplicate { path, content_hash } if **path == *in_library && *content_hash == known[0].hash)));
    assert_eq!(cache_files(cache.path()).len(), 1, "only one copy stored");
}

#[test]
fn a_rescan_with_the_library_known_imports_nothing() {
    let src = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let epub = std::fs::read(fixture("epub/multi-chapter.epub")).unwrap();
    let pdf = std::fs::read(fixture("pdf/links-paper.pdf")).unwrap();
    let paths = vec![
        put(src.path(), "a.epub", &epub),
        put(src.path(), "b.pdf", &pdf),
    ];
    let (first, items) = run(&paths, cache.path(), &[], &AtomicBool::new(false));
    assert_eq!(first.imported, 2);
    let known: Vec<KnownBook> = items
        .iter()
        .filter_map(|item| match item {
            IngestItem::Imported { book, .. } => Some(KnownBook {
                size: book.file_size,
                hash: book.content_hash.clone()?,
            }),
            _ => None,
        })
        .collect();
    let before = cache_files(cache.path());
    let (again, _) = run(&paths, cache.path(), &known, &AtomicBool::new(false));
    assert_eq!((again.imported, again.duplicates), (0, 2));
    assert_eq!(cache_files(cache.path()), before);
}

#[test]
fn a_cancelled_import_handles_nothing_more_and_leaves_nothing_behind() {
    let src = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let pdf = std::fs::read(fixture("pdf/page-labels.pdf")).unwrap();
    let paths: Vec<String> = (0..20)
        .map(|i| {
            put(
                src.path(),
                &format!("p{i}.pdf"),
                &[pdf.as_slice(), &[i as u8][..]].concat(),
            )
        })
        .collect();
    let (summary, items) = run(&paths, cache.path(), &[], &AtomicBool::new(true));
    assert!(summary.cancelled);
    assert!(items.is_empty());
    assert!(cache_files(cache.path()).is_empty());

    // Cancelled during a copy: the partial copy is removed.
    let big = put(src.path(), "big.pdf", &vec![b'x'; 3 * 1024 * 1024]);
    let part = cache.path().join("x.part");
    let cancel = AtomicBool::new(true);
    assert!(matches!(
        copy_with_hash(Path::new(&big), &part, None, &cancel),
        Err(FileError::Cancelled)
    ));
    let batch = Batch {
        known_hashes: Default::default(),
        shared_sizes: Default::default(),
        claimed: Default::default(),
        cache_dir: cache.path(),
        cancel: &cancel,
    };
    assert!(matches!(
        ingest_one(&big, 3 * 1024 * 1024, &batch),
        Err(FileError::Cancelled)
    ));
    std::fs::remove_file(&part).ok();
    assert!(cache_files(cache.path()).is_empty());
}

#[cfg(unix)]
#[test]
fn a_failed_copy_is_reported_and_leaves_no_book() {
    use std::os::unix::fs::PermissionsExt;
    let src = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let pdf = std::fs::read(fixture("pdf/page-labels.pdf")).unwrap();
    let path = put(src.path(), "paper.pdf", &pdf);
    std::fs::set_permissions(cache.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
    let writable_anyway = std::fs::write(cache.path().join("probe"), b"").is_ok();
    let (summary, items) = run(
        std::slice::from_ref(&path),
        cache.path(),
        &[],
        &AtomicBool::new(false),
    );
    std::fs::set_permissions(cache.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    if writable_anyway {
        return; // running as root
    }
    assert_eq!(summary.failed, 1);
    assert!(
        reason_for(&items, &path).contains("Could not save the book"),
        "{items:?}"
    );
    assert!(cache_files(cache.path()).is_empty());
}

#[cfg(unix)]
#[test]
fn unreadable_files_are_reported_and_nothing_is_stored() {
    use std::os::unix::fs::PermissionsExt;
    let src = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let pdf = put(
        src.path(),
        "locked.pdf",
        &std::fs::read(fixture("pdf/page-labels.pdf")).unwrap(),
    );
    let epub = put(
        src.path(),
        "locked.epub",
        &std::fs::read(fixture("epub/multi-chapter.epub")).unwrap(),
    );
    for path in [&pdf, &epub] {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o000)).unwrap();
    }
    let readable_anyway = std::fs::read(&pdf).is_ok();
    let (summary, items) = run(
        &[pdf.clone(), epub.clone()],
        cache.path(),
        &[],
        &AtomicBool::new(false),
    );
    for path in [&pdf, &epub] {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o644)).unwrap();
    }
    if readable_anyway {
        return; // running as root
    }
    assert_eq!(summary.failed, 2);
    assert_eq!(reason_for(&items, &pdf), "Permission denied");
    assert!(
        reason_for(&items, &epub).contains("Permission denied"),
        "{items:?}"
    );
    assert!(cache_files(cache.path()).is_empty());
}

#[test]
fn stale_partial_copies_are_swept_and_fresh_ones_kept() {
    let cache = tempfile::tempdir().unwrap();
    let stale = cache.path().join("old.part");
    let fresh = cache.path().join("new.part");
    std::fs::write(&stale, b"x").unwrap();
    std::fs::write(&fresh, b"x").unwrap();
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 60 * 60);
    std::fs::File::options()
        .write(true)
        .open(&stale)
        .unwrap()
        .set_modified(old)
        .unwrap();
    run(&[], cache.path(), &[], &AtomicBool::new(false));
    assert_eq!(cache_files(cache.path()), vec!["new.part".to_string()]);
}

#[test]
fn progress_is_batched_and_done_comes_last() {
    let sent = std::sync::Mutex::new(Vec::new());
    let batcher = ProgressBatcher::new(10, 4, std::time::Duration::from_secs(60), |m| {
        sent.lock().unwrap().push(m)
    });
    for i in 0..10 {
        batcher.push(IngestItem::failed(&format!("p{i}"), "x"));
    }
    batcher.finish(IngestSummary {
        total: 10,
        failed: 10,
        ..Default::default()
    });
    let sent = sent.into_inner().unwrap();
    let shape: Vec<(usize, usize)> = sent
        .iter()
        .filter_map(|m| match m {
            IngestMessage::Progress {
                completed, items, ..
            } => Some((*completed, items.len())),
            IngestMessage::Done { .. } => None,
        })
        .collect();
    assert_eq!(shape, vec![(4, 4), (8, 4), (10, 2)]);
    assert!(matches!(sent.last(), Some(IngestMessage::Done { .. })));
    let json = serde_json::to_value(&sent[0]).unwrap();
    assert_eq!(json["kind"], "progress");
    assert_eq!(json["items"][0]["status"], "failed");
    assert_eq!(json["items"][0]["reason"], "x");
    let done = serde_json::to_value(sent.last().unwrap()).unwrap();
    assert_eq!(done["kind"], "done");
    assert_eq!(done["summary"]["failed"], 10);
}

#[test]
fn extensionless_file_uses_format_or_mime_hint() {
    let src = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let epub_bytes = std::fs::read(fixture("epub/multi-chapter.epub")).unwrap();
    let path = put(src.path(), "extensionless-upload", &epub_bytes);
    let id = uuid::Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    let item = ingest_job_file_with_hint(
        &path,
        cache.path(),
        &id,
        &[],
        false,
        Some("application/epub+zip"),
        &cancel,
        &|_, _, _| {},
    )
    .unwrap()
    .unwrap();
    match item {
        IngestItem::Imported { book, .. } => assert_eq!(&*book.format, "epub"),
        other => panic!("expected extensionless MIME-matched epub to import, got {other:?}"),
    }
}

#[test]
fn move_or_copy_falls_back_on_cross_device_link() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("source.book");
    let dst = dir.path().join("dest.book");
    std::fs::write(&src, b"cross-device-payload").unwrap();

    let res = move_or_copy_with_rename(&src, &dst, |_, _| {
        Err(std::io::Error::from_raw_os_error(18))
    });
    assert!(res.is_ok(), "EXDEV must fall back to copy+remove: {res:?}");
    assert!(!src.exists(), "source must be removed after fallback copy");
    assert_eq!(std::fs::read(&dst).unwrap(), b"cross-device-payload");
}

#[test]
fn sparse_file_above_u32_max_does_not_truncate_to_empty() {
    let dir = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let path = dir.path().join("huge.epub");
    let file = std::fs::File::create(&path).unwrap();
    let over_4gb = (u32::MAX as u64) + 4096;
    file.set_len(over_4gb).unwrap();
    drop(file);

    let batch = Batch {
        known_hashes: std::collections::HashSet::new(),
        shared_sizes: std::collections::HashSet::new(),
        claimed: Default::default(),
        cache_dir: cache.path(),
        cancel: &AtomicBool::new(false),
    };
    let err = match ingest_one(path.to_str().unwrap(), over_4gb, &batch) {
        Ok(_) => panic!("sparse zero file is not a valid epub"),
        Err(FileError::Failed(msg)) => msg,
        Err(FileError::Cancelled) => panic!("not cancelled"),
    };
    assert!(
        !err.contains("empty") && !err.contains("too large"),
        "4 GiB+ file should pass empty and <=8 GiB bounds and reach parser, got: {err}"
    );
}
