use std::io::{Cursor, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::batch_ingest::{
    downsample_cover_to_data_url, extract_xml_tag_text, parse_title_author_from_filename,
    ParsedMetadata,
};

/// Write each extracted member straight into ZIP, without retaining all pages.
struct ZipEntryWriter<W: Write + std::io::Seek>(Arc<Mutex<zip::ZipWriter<W>>>);

impl<W: Write + std::io::Seek> Write for ZipEntryWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .map_err(|_| std::io::Error::other("ZIP writer poisoned"))?
            .write(bytes)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.0
            .lock()
            .map_err(|_| std::io::Error::other("ZIP writer poisoned"))?
            .flush()
    }
}

fn convert_cbr_into<W: Write + std::io::Seek + 'static>(
    path: &Path,
    output: W,
) -> Result<W, String> {
    let archive =
        rars::ArchiveReader::read_path(path).map_err(|e| format!("Failed to open CBR: {e}"))?;
    let writer = Arc::new(Mutex::new(zip::ZipWriter::new(output)));
    let shared = writer.clone();
    let mut count = 0usize;
    archive
        .extract_to(None, |meta| {
            if meta.is_directory {
                return Ok(Box::new(std::io::sink()));
            }
            let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            shared
                .lock()
                .map_err(|_| std::io::Error::other("ZIP writer poisoned"))?
                .start_file(meta.name_lossy(), options)
                .map_err(std::io::Error::other)?;
            count += 1;
            Ok(Box::new(ZipEntryWriter(shared.clone())))
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
    Ok(convert_cbr_into(path, Cursor::new(Vec::new()))?.into_inner())
}

pub fn convert_cbr_to_cbz_file(source: &Path, dest: &Path) -> Result<(), String> {
    let output = std::fs::File::create(dest).map_err(|e| format!("Failed to create CBZ: {e}"))?;
    let output = std::io::BufWriter::with_capacity(64 * 1024, output);
    match convert_cbr_into(source, output) {
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

/// Extract metadata & cover from a CBR comic archive.
pub(crate) fn parse_cbr_native(path: &Path) -> Result<ParsedMetadata, String> {
    let archive = rars::ArchiveReader::read_path(path)
        .map_err(|e| format!("Failed to open CBR archive '{}': {}", path.display(), e))?;

    let (mut title, author) = parse_title_author_from_filename(path);
    let mut cover_data_url = None;
    let mut series = None;
    let mut series_index = None;

    // Scan members for ComicInfo.xml and candidate image files
    let mut comic_info_idx = None;
    let mut image_entries: Vec<(String, usize)> = Vec::new();

    for (idx, member) in archive.members().enumerate() {
        if member.meta.is_directory {
            continue;
        }
        let name = member.meta.name_lossy();
        let lower = name.to_lowercase();
        let base_name = lower.rsplit('/').next().unwrap_or(&lower);

        if base_name == "comicinfo.xml" {
            comic_info_idx = Some(idx);
        } else if lower.ends_with(".jpg")
            || lower.ends_with(".jpeg")
            || lower.ends_with(".png")
            || lower.ends_with(".webp")
            || lower.ends_with(".avif")
        {
            image_entries.push((name, idx));
        }
    }

    // Parse ComicInfo.xml if present
    if let Some(idx) = comic_info_idx {
        if let Ok(Some(data)) = archive.read_member_at(idx, None) {
            if let Ok(xml_str) = String::from_utf8(data) {
                if let Some(t) = extract_xml_tag_text(&xml_str, "Title") {
                    if !t.trim().is_empty() {
                        title = t;
                    }
                }
                if let Some(s) = extract_xml_tag_text(&xml_str, "Series") {
                    if !s.trim().is_empty() {
                        series = Some(s);
                    }
                }
                if let Some(num_str) = extract_xml_tag_text(&xml_str, "Number") {
                    if let Ok(parsed_num) = num_str.trim().parse::<f64>() {
                        series_index = Some(parsed_num);
                    }
                }
            }
        }
    }

    // Sort images alphabetically by filename to find the cover (first page)
    image_entries.sort_by(|a, b| a.0.cmp(&b.0));

    if let Some((name, cover_idx)) = image_entries.first() {
        let read_res = archive
            .read_member(name.as_bytes(), None)
            .or_else(|_| archive.read_member_at(*cover_idx, None));
        if let Ok(Some(img_bytes)) = read_res {
            cover_data_url = downsample_cover_to_data_url(&img_bytes);
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
}
