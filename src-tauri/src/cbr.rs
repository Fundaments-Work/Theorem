use std::io::{Cursor, Write};
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use crate::batch_ingest::{
    downsample_cover_to_data_url, extract_xml_tag_text, parse_title_author_from_filename,
    ParsedMetadata,
};

const MAX_CBR_EXTRACT_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_CBR_META_BYTES: u64 = 32 * 1024 * 1024;
const MAX_CBR_COVER_BYTES: u64 = 64 * 1024 * 1024;

fn sanitize_zip_entry_name(raw: &str) -> String {
    let normalized = raw.replace('\\', "/");
    let mut parts = Vec::new();
    for segment in normalized.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            continue;
        }
        parts.push(segment);
    }
    parts.join("/")
}

/// Write each extracted member straight into ZIP, without retaining all pages.
struct ZipEntryWriter<W: Write + std::io::Seek> {
    writer: Arc<Mutex<zip::ZipWriter<W>>>,
    cancel: Option<Arc<AtomicBool>>,
    total_written: Arc<std::sync::atomic::AtomicU64>,
}

impl<W: Write + std::io::Seek> Write for ZipEntryWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self
            .cancel
            .as_ref()
            .is_some_and(|cancel| cancel.load(Ordering::Relaxed))
        {
            return Err(std::io::Error::other("Archive conversion cancelled"));
        }
        let prev = self
            .total_written
            .fetch_add(bytes.len() as u64, Ordering::Relaxed);
        if prev.saturating_add(bytes.len() as u64) > MAX_CBR_EXTRACT_BYTES {
            return Err(std::io::Error::other(
                "CBR extracted size exceeds maximum limit",
            ));
        }
        self.writer
            .lock()
            .map_err(|_| std::io::Error::other("ZIP writer poisoned"))?
            .write(bytes)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.writer
            .lock()
            .map_err(|_| std::io::Error::other("ZIP writer poisoned"))?
            .flush()
    }
}

fn convert_cbr_into<W: Write + std::io::Seek + 'static>(
    path: &Path,
    output: W,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<W, String> {
    let archive =
        rars::ArchiveReader::read_path(path).map_err(|e| format!("Failed to open CBR: {e}"))?;
    let large_entries: std::collections::HashSet<Vec<u8>> = archive
        .members()
        .filter(|m| !m.meta.is_directory && m.meta.unpacked_size >= u32::MAX as u64)
        .map(|m| m.meta.name.clone())
        .collect();
    let writer = Arc::new(Mutex::new(zip::ZipWriter::new(output)));
    let shared = writer.clone();
    let total_written = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let mut count = 0usize;
    archive
        .extract_to(None, |meta| {
            if cancel
                .as_ref()
                .is_some_and(|cancel| cancel.load(Ordering::Relaxed))
            {
                return Err(std::io::Error::other("Archive conversion cancelled").into());
            }
            if meta.is_directory {
                return Ok(Box::new(std::io::sink()));
            }
            let safe_name = sanitize_zip_entry_name(&meta.name_lossy());
            if safe_name.is_empty() {
                return Ok(Box::new(std::io::sink()));
            }
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored)
                .large_file(large_entries.contains(&meta.name));
            shared
                .lock()
                .map_err(|_| std::io::Error::other("ZIP writer poisoned"))?
                .start_file(safe_name, options)
                .map_err(std::io::Error::other)?;
            count += 1;
            Ok(Box::new(ZipEntryWriter {
                writer: shared.clone(),
                cancel: cancel.clone(),
                total_written: total_written.clone(),
            }))
        })
        .map_err(|e| format!("CBR extraction failed: {e}"))?;
    if count == 0 {
        return Err("CBR contains no files".into());
    }
    drop(shared);
    Arc::try_unwrap(writer)
        .map_err(|_| "ZIP writer still in use".to_string())?
        .into_inner()
        .map_err(|_| "ZIP writer poisoned".to_string())?
        .finish()
        .map_err(|e| format!("Failed to finalize ZIP: {e}"))
}

/// Legacy binary reader response; imports use the disk-backed conversion below.
pub fn convert_cbr_to_cbz(path: &Path) -> Result<Vec<u8>, String> {
    Ok(convert_cbr_into(path, Cursor::new(Vec::new()), None)?.into_inner())
}

pub fn convert_cbr_to_cbz_file(source: &Path, dest: &Path) -> Result<(), String> {
    convert_cbr_to_cbz_file_cancellable(source, dest, None)
}

pub(crate) fn convert_cbr_to_cbz_file_cancellable(
    source: &Path,
    dest: &Path,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<(), String> {
    let output = std::fs::File::create(dest).map_err(|e| format!("Failed to create CBZ: {e}"))?;
    let output = std::io::BufWriter::with_capacity(64 * 1024, output);
    match convert_cbr_into(source, output, cancel) {
        Ok(output) => output
            .into_inner()
            .map_err(|e| format!("Failed to flush CBZ: {e}"))?
            .sync_all()
            .map_err(|e| format!("Failed to flush CBZ: {e}")),
        Err(error) => {
            let _ = std::fs::remove_file(dest);
            Err(error)
        }
    }
}

/// Sink collecting up to `max_bytes`, failing before allocating unbounded RAM on spoofed sizes.
struct BoundedBufferWriter {
    target: Arc<Mutex<Vec<u8>>>,
    max_bytes: usize,
}

impl Write for BoundedBufferWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let mut guard = self
            .target
            .lock()
            .map_err(|_| std::io::Error::other("CBR buffer mutex poisoned"))?;
        if guard.len().saturating_add(buf.len()) > self.max_bytes {
            return Err(std::io::Error::other(
                "CBR entry exceeds maximum allowed size",
            ));
        }
        guard.extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Extract metadata & cover from a CBR comic archive.
pub(crate) fn parse_cbr_native(path: &Path) -> Result<ParsedMetadata, String> {
    let archive = rars::ArchiveReader::read_path(path)
        .map_err(|e| format!("Failed to open CBR archive '{}': {}", path.display(), e))?;

    let (mut title, author) = parse_title_author_from_filename(path);
    let mut cover_data_url = None;
    let mut series = None;
    let mut series_index = None;

    // Scan members for ComicInfo.xml and candidate image files
    let mut comic_info_raw: Option<Vec<u8>> = None;
    let mut image_entries: Vec<(String, Vec<u8>, u64)> = Vec::new();

    for member in archive.members() {
        if member.meta.is_directory {
            continue;
        }
        let name = member.meta.name_lossy();
        let lower = name.to_lowercase();
        let base_name = lower.rsplit('/').next().unwrap_or(&lower);

        if base_name == "comicinfo.xml"
            && member.meta.unpacked_size <= MAX_CBR_META_BYTES
            && comic_info_raw.is_none()
        {
            comic_info_raw = Some(member.meta.name.clone());
        } else if (lower.ends_with(".jpg")
            || lower.ends_with(".jpeg")
            || lower.ends_with(".png")
            || lower.ends_with(".webp")
            || lower.ends_with(".avif"))
            && member.meta.unpacked_size <= MAX_CBR_COVER_BYTES
        {
            image_entries.push((name, member.meta.name.clone(), member.meta.unpacked_size));
        }
    }

    image_entries.sort_by(|a, b| a.0.cmp(&b.0));
    let cover_raw = image_entries.into_iter().next().map(|(_, raw, _)| raw);

    let meta_bytes = Arc::new(Mutex::new(Vec::new()));
    let cover_bytes = Arc::new(Mutex::new(Vec::new()));
    if comic_info_raw.is_some() || cover_raw.is_some() {
        let meta_buf = meta_bytes.clone();
        let cover_buf = cover_bytes.clone();
        let meta_target = comic_info_raw.clone();
        let cover_target = cover_raw.clone();
        let _ = archive.extract_to(None, |meta| {
            if meta_target.as_deref() == Some(meta.name.as_slice()) {
                return Ok(Box::new(BoundedBufferWriter {
                    target: meta_buf.clone(),
                    max_bytes: MAX_CBR_META_BYTES as usize,
                }));
            }
            if cover_target.as_deref() == Some(meta.name.as_slice()) {
                return Ok(Box::new(BoundedBufferWriter {
                    target: cover_buf.clone(),
                    max_bytes: MAX_CBR_COVER_BYTES as usize,
                }));
            }
            Ok(Box::new(std::io::sink()))
        });
    }

    if let Ok(guard) = meta_bytes.lock() {
        if !guard.is_empty() {
            if let Ok(xml_str) = std::str::from_utf8(&guard) {
                if let Some(t) = extract_xml_tag_text(xml_str, "Title") {
                    if !t.trim().is_empty() {
                        title = t;
                    }
                }
                if let Some(s) = extract_xml_tag_text(xml_str, "Series") {
                    if !s.trim().is_empty() {
                        series = Some(s);
                    }
                }
                if let Some(num_str) = extract_xml_tag_text(xml_str, "Number") {
                    if let Ok(idx) = num_str.trim().parse::<f64>() {
                        series_index = Some(idx);
                    }
                }
            }
        }
    }

    if let Ok(guard) = cover_bytes.lock() {
        if !guard.is_empty() {
            cover_data_url = downsample_cover_to_data_url(&guard);
        }
    }

    Ok(ParsedMetadata {
        title,
        author,
        description: None,
        publisher: None,
        published_date: None,
        language: None,
        isbn: None,
        cover_data_url,
        series,
        series_index,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rars::builder::Builder;
    use rars::version::ArchiveVersion;
    use std::io::Read;

    #[test]
    fn archive_writer_observes_cancellation_between_writes() {
        let writer = Arc::new(Mutex::new(zip::ZipWriter::new(Cursor::new(Vec::new()))));
        writer
            .lock()
            .unwrap()
            .start_file("page.jpg", zip::write::SimpleFileOptions::default())
            .unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let mut output = ZipEntryWriter {
            writer,
            cancel: Some(cancel.clone()),
            total_written: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        };
        output.write_all(b"first block").unwrap();
        cancel.store(true, Ordering::Relaxed);
        assert!(output.write_all(b"next block").is_err());
    }

    #[test]
    fn test_cbr_conversion_and_metadata() {
        // Create an in-memory RAR archive with ComicInfo.xml and a dummy JPEG image
        let temp_dir = tempfile::tempdir().unwrap();
        let cbr_path = temp_dir.path().join("test_comic.cbr");

        let mut builder = Builder::new(ArchiveVersion::Rar50);
        let comic_info = r#"<?xml version="1.0"?>
<ComicInfo>
    <Title>The Antigravity Hero</Title>
    <Series>Theorem Comics</Series>
    <Number>42</Number>
</ComicInfo>"#;
        builder
            .add_bytes(
                b"ComicInfo.xml".to_vec(),
                comic_info.as_bytes().to_vec(),
                None,
                None,
            )
            .unwrap();

        // Dynamically create a valid 10x10 PNG image with correct CRC
        let img = image::RgbImage::new(10, 10);
        let mut png_bytes = Vec::new();
        img.write_to(&mut Cursor::new(&mut png_bytes), image::ImageFormat::Png)
            .unwrap();

        builder
            .add_bytes(b"page_01.png".to_vec(), png_bytes.clone(), None, None)
            .unwrap();

        let rar_data = builder.to_bytes().unwrap();
        std::fs::write(&cbr_path, rar_data).unwrap();

        // Test parse_cbr_native
        let meta = parse_cbr_native(&cbr_path).unwrap();
        assert_eq!(meta.title, "The Antigravity Hero");
        assert_eq!(meta.series, Some("Theorem Comics".to_string()));
        assert_eq!(meta.series_index, Some(42.0));
        assert!(meta.cover_data_url.is_some());

        // Test convert_cbr_to_cbz
        let cbz_bytes = convert_cbr_to_cbz(&cbr_path).unwrap();
        assert!(!cbz_bytes.is_empty());

        let disk_path = temp_dir.path().join("converted.cbz");
        convert_cbr_to_cbz_file(&cbr_path, &disk_path).unwrap();
        assert_eq!(std::fs::read(&disk_path).unwrap(), cbz_bytes);

        // Verify cbz_bytes is a valid ZIP file with our entries
        let mut zip = zip::ZipArchive::new(Cursor::new(cbz_bytes)).unwrap();
        assert_eq!(zip.len(), 2);
        {
            let mut comic_entry = zip.by_name("ComicInfo.xml").unwrap();
            let mut xml_read = String::new();
            comic_entry.read_to_string(&mut xml_read).unwrap();
            assert_eq!(xml_read, comic_info);
        }
        {
            let mut img_entry = zip.by_name("page_01.png").unwrap();
            let mut img_read = Vec::new();
            img_entry.read_to_end(&mut img_read).unwrap();
            assert_eq!(img_read, png_bytes);
        }
    }
    #[test]
    fn failed_conversion_removes_partial_output() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("broken.cbr");
        let destination = directory.path().join("broken.cbz");
        std::fs::write(&source, b"not a RAR archive").unwrap();
        assert!(convert_cbr_to_cbz_file(&source, &destination).is_err());
        assert!(!destination.exists());
    }

    #[test]
    fn sanitizes_rar_entry_traversal_segments() {
        assert_eq!(
            sanitize_zip_entry_name("../evil\\..\\page_01.jpg"),
            "evil/page_01.jpg"
        );
        assert_eq!(sanitize_zip_entry_name("/abs/./02.png"), "abs/02.png");
        assert_eq!(sanitize_zip_entry_name(".."), "");
    }
}
