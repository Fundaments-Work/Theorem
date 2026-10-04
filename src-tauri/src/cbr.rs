use std::io::{Cursor, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::batch_ingest::{
    downsample_cover_to_data_url, extract_xml_tag_text, parse_title_author_from_filename,
    ParsedMetadata,
};

/// A shared buffer writer to receive streaming uncompressed data from `rars::extract_to`.
struct BufferWriter(Arc<Mutex<Vec<u8>>>);

impl Write for BufferWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

type ArchiveEntryList = Arc<Mutex<Vec<(String, Vec<u8>)>>>;

/// Convert a CBR (RAR) archive into in-memory CBZ (ZIP) bytes.
pub fn convert_cbr_to_cbz(path: &Path) -> Result<Vec<u8>, String> {
    let archive = rars::ArchiveReader::read_path(path)
        .map_err(|e| format!("Failed to open CBR archive '{}': {}", path.display(), e))?;

    let mut zip_buffer = Cursor::new(Vec::new());
    {
        let mut zip_writer = zip::ZipWriter::new(&mut zip_buffer);
        let options: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);

        let entries_data: ArchiveEntryList = Arc::new(Mutex::new(Vec::new()));
        let entries_data_clone = entries_data.clone();

        let current_buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let current_buf_clone = current_buf.clone();
        let current_name: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let current_name_clone = current_name.clone();

        let extract_res = archive.extract_to(None, move |meta| {
            let mut name_lock = current_name_clone.lock().unwrap();
            let mut buf_lock = current_buf_clone.lock().unwrap();
            if let Some(prev_name) = name_lock.take() {
                if !buf_lock.is_empty() {
                    entries_data_clone
                        .lock()
                        .unwrap()
                        .push((prev_name, std::mem::take(&mut *buf_lock)));
                }
            }

            if meta.is_directory {
                return Ok(Box::new(std::io::sink()));
            }

            let name = meta.name_lossy();
            *name_lock = Some(name);
            buf_lock.clear();

            Ok(Box::new(BufferWriter(current_buf_clone.clone())))
        });

        // Flush the final entry if any
        {
            let mut name_lock = current_name.lock().unwrap();
            let mut buf_lock = current_buf.lock().unwrap();
            if let Some(last_name) = name_lock.take() {
                entries_data
                    .lock()
                    .unwrap()
                    .push((last_name, std::mem::take(&mut *buf_lock)));
            }
        }

        // If extract_to succeeded, write out all entries into ZIP
        let mut wrote_entries = false;
        if extract_res.is_ok() {
            let collected = entries_data.lock().unwrap();
            for (name, data) in collected.iter() {
                zip_writer
                    .start_file(name.clone(), options)
                    .map_err(|e| format!("Failed to write ZIP entry '{name}': {e}"))?;
                zip_writer
                    .write_all(data)
                    .map_err(|e| format!("Failed to write ZIP data for '{name}': {e}"))?;
                wrote_entries = true;
            }
        }

        // Fallback to read_member_at if extract_to didn't produce entries
        if !wrote_entries {
            for (idx, member) in archive.members().enumerate() {
                if member.meta.is_directory {
                    continue;
                }
                let name = member.meta.name_lossy();
                if let Ok(Some(data)) = archive.read_member_at(idx, None) {
                    zip_writer
                        .start_file(name.clone(), options)
                        .map_err(|e| format!("Failed to write ZIP entry '{name}': {e}"))?;
                    zip_writer
                        .write_all(&data)
                        .map_err(|e| format!("Failed to write ZIP data for '{name}': {e}"))?;
                }
            }
        }

        zip_writer
            .finish()
            .map_err(|e| format!("Failed to finalize ZIP: {e}"))?;
    }

    Ok(zip_buffer.into_inner())
}

/// Convert a CBR file to a CBZ file on disk.
pub fn convert_cbr_to_cbz_file(source: &Path, dest: &Path) -> Result<(), String> {
    let zip_bytes = convert_cbr_to_cbz(source)?;
    std::fs::write(dest, zip_bytes)
        .map_err(|e| format!("Failed to write CBZ file '{}': {e}", dest.display()))
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
}
