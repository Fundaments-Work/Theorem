//! Helpers for opening ZIP archives without paying for offset detection.
//!
//! `zip` 9 changed the default archive-offset strategy to `ArchiveOffset::Detect`.
//! Detection scans the reader from byte 0 to the end-of-central-directory record
//! looking for the first central-directory header. On a 96 MB EPUB that costs
//! ~560 ms per open, versus ~7 ms when the offset is known to be zero.
//!
//! Archives that begin with a ZIP signature are at offset zero by definition.
//! Everything else (for example a self-extracting archive with a prepended
//! executable) keeps the detection path.

use std::io::{Read, Seek, SeekFrom};

use zip::read::{ArchiveOffset, Config};
use zip::result::ZipResult;
use zip::ZipArchive;

/// Open a ZIP archive, using the fast path when the archive starts at offset 0.
pub(crate) fn open_zip_archive<R: Read + Seek>(mut reader: R) -> ZipResult<ZipArchive<R>> {
    let mut magic = [0u8; 4];
    let starts_at_zero = reader.read_exact(&mut magic).is_ok()
        && (magic == *b"PK\x03\x04" || magic == *b"PK\x05\x06");
    reader.seek(SeekFrom::Start(0))?;

    if starts_at_zero {
        let config = Config {
            archive_offset: ArchiveOffset::Known(0),
        };
        if let Ok(archive) = ZipArchive::with_config(config, &mut reader) {
            let metadata = archive.metadata();
            drop(archive);
            // SAFETY: the metadata was just produced from this same reader and
            // only describes offsets within it, which is exactly the contract
            // `unsafe_new_with_metadata` requires.
            return Ok(unsafe { ZipArchive::unsafe_new_with_metadata(reader, metadata) });
        }
    }

    // Prepended data, a malformed central directory, or a reader shorter than
    // four bytes: let zip detect the offset and surface the real error.
    ZipArchive::new(reader)
}

/// Read up to `max_bytes` from a ZIP entry, rejecting both oversized declared
/// lengths and compressed entries whose inflated stream exceeds the limit.
pub(crate) fn read_zip_entry_bytes_bounded<R: Read>(
    entry: &mut zip::read::ZipFile<'_, R>,
    max_bytes: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    if entry.size() > max_bytes as u64 {
        return Err(format!(
            "ZIP entry '{label}' exceeds maximum allowed size ({max_bytes} bytes)"
        ));
    }
    let mut buf = Vec::with_capacity((entry.size() as usize).min(max_bytes));
    entry
        .take((max_bytes as u64).saturating_add(1))
        .read_to_end(&mut buf)
        .map_err(|e| format!("Failed to read ZIP entry '{label}': {e}"))?;
    if buf.len() > max_bytes {
        return Err(format!(
            "ZIP entry '{label}' exceeds maximum allowed size ({max_bytes} bytes)"
        ));
    }
    Ok(buf)
}

/// Read a UTF-8 string entry up to `max_bytes` from a ZIP archive.
pub(crate) fn read_zip_entry_string_bounded<R: Read>(
    entry: &mut zip::read::ZipFile<'_, R>,
    max_bytes: usize,
    label: &str,
) -> Result<String, String> {
    let bytes = read_zip_entry_bytes_bounded(entry, max_bytes, label)?;
    String::from_utf8(bytes).map_err(|e| format!("ZIP entry '{label}' is not valid UTF-8: {e}"))
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Read, Write};

    use super::open_zip_archive;

    fn zip_bytes() -> Vec<u8> {
        let mut buffer = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            writer
                .start_file("hello.txt", zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"hello").unwrap();
            writer.finish().unwrap();
        }
        buffer.into_inner()
    }

    #[test]
    fn opens_archive_at_offset_zero() {
        let mut archive = open_zip_archive(Cursor::new(zip_bytes())).unwrap();
        assert_eq!(archive.len(), 1);
        let mut contents = String::new();
        archive
            .by_name("hello.txt")
            .unwrap()
            .read_to_string(&mut contents)
            .unwrap();
        assert_eq!(contents, "hello");
    }

    #[test]
    fn falls_back_to_detection_for_prepended_data() {
        let mut bytes = b"#!/bin/sh\nexit 0\n".to_vec();
        bytes.extend_from_slice(&zip_bytes());
        let mut archive = open_zip_archive(Cursor::new(bytes)).unwrap();
        assert_eq!(archive.len(), 1);
        let mut contents = String::new();
        archive
            .by_name("hello.txt")
            .unwrap()
            .read_to_string(&mut contents)
            .unwrap();
        assert_eq!(contents, "hello");
    }

    #[test]
    fn rejects_too_short_input() {
        assert!(open_zip_archive(Cursor::new(b"PK".to_vec())).is_err());
    }

    #[test]
    fn bounded_zip_reader_rejects_oversized_entries() {
        let mut archive = open_zip_archive(Cursor::new(zip_bytes())).unwrap();
        let mut entry = archive.by_name("hello.txt").unwrap();
        assert!(super::read_zip_entry_bytes_bounded(&mut entry, 4, "hello.txt").is_err());
        drop(entry);
        let mut entry2 = archive.by_name("hello.txt").unwrap();
        assert_eq!(
            super::read_zip_entry_string_bounded(&mut entry2, 5, "hello.txt").unwrap(),
            "hello"
        );
    }
}
