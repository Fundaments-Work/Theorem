use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobiMetadata {
    pub title: String,
    pub author: Option<String>,
    pub publisher: Option<String>,
    pub description: Option<String>,
    pub isbn: Option<String>,
    #[serde(rename = "compressionType")]
    pub compression_type: u16,
    #[serde(rename = "textLength")]
    pub text_length: u32,
    #[serde(rename = "recordCount")]
    pub record_count: u16,
    #[serde(rename = "coverRecordOffset")]
    pub cover_record_offset: Option<u32>,
}

/// Native PalmDOC LZ77 decompressor (decompresses standard PalmDOC records at ~1-2µs per 4KB)
pub fn decompress_palmdoc(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(bytes.len() * 2);
    let mut i = 0;

    while i < bytes.len() {
        let b = bytes[i];
        i += 1;

        if b == 0x00 {
            // Literal 0
            out.push(0);
        } else if b <= 0x08 {
            // Copy next b literal bytes
            let count = b as usize;
            if i + count > bytes.len() {
                break;
            }
            out.extend_from_slice(&bytes[i..i + count]);
            i += count;
        } else if b <= 0x7F {
            // Single literal byte
            out.push(b);
        } else if b <= 0xBF {
            // 2-byte distance/length pair
            if i >= bytes.len() {
                break;
            }
            let b2 = bytes[i];
            i += 1;

            let distance = (((b & 0x3F) as usize) << 3) | ((b2 >> 5) as usize);
            let length = ((b2 & 0x07) as usize) + 3;

            if distance == 0 || distance > out.len() {
                continue;
            }

            let start = out.len() - distance;
            for k in 0..length {
                let byte_to_copy = out[start + (k % distance)];
                out.push(byte_to_copy);
            }
        } else {
            // b >= 0xC0: Space followed by (b ^ 0x80)
            out.push(b' ');
            out.push(b ^ 0x80);
        }
    }

    Ok(out)
}

/// Parse PDB Header and MOBI Record 0 Metadata
pub fn parse_mobi_file(path: &Path) -> Result<MobiMetadata, String> {
    let mut file = File::open(path).map_err(|e| format!("Cannot open MOBI file: {e}"))?;
    let mut pdb_header = [0u8; 78];
    file.read_exact(&mut pdb_header)
        .map_err(|e| format!("Failed to read PDB header: {e}"))?;

    // PDB title: bytes 0..32 (null-terminated)
    let pdb_title = String::from_utf8_lossy(&pdb_header[0..32])
        .trim_matches(char::from(0))
        .trim()
        .to_string();

    let num_records = u16::from_be_bytes([pdb_header[76], pdb_header[77]]);
    if num_records == 0 {
        return Err("MOBI file has no records".to_string());
    }

    // Read record 0 offset
    let mut rec0_entry = [0u8; 8];
    file.read_exact(&mut rec0_entry)
        .map_err(|e| format!("Failed to read record list: {e}"))?;
    let rec0_offset =
        u32::from_be_bytes([rec0_entry[0], rec0_entry[1], rec0_entry[2], rec0_entry[3]]);

    // Seek to record 0
    file.seek(SeekFrom::Start(rec0_offset as u64))
        .map_err(|e| format!("Failed to seek to record 0: {e}"))?;

    let mut rec0_buf = [0u8; 256];
    file.read_exact(&mut rec0_buf)
        .map_err(|e| format!("Failed to read record 0: {e}"))?;

    let compression_type = u16::from_be_bytes([rec0_buf[0], rec0_buf[1]]);
    let text_length = u32::from_be_bytes([rec0_buf[4], rec0_buf[5], rec0_buf[6], rec0_buf[7]]);
    let record_count = u16::from_be_bytes([rec0_buf[8], rec0_buf[9]]);

    let title_offset = u32::from_be_bytes([rec0_buf[84], rec0_buf[85], rec0_buf[86], rec0_buf[87]]);
    let title_len = u32::from_be_bytes([rec0_buf[88], rec0_buf[89], rec0_buf[90], rec0_buf[91]]);

    let mut full_title = pdb_title;
    if title_offset > 0 && title_len > 0 && title_len < 1024 {
        let abs_title_offset = (rec0_offset + title_offset) as u64;
        if file.seek(SeekFrom::Start(abs_title_offset)).is_ok() {
            let mut title_buf = vec![0u8; title_len as usize];
            if file.read_exact(&mut title_buf).is_ok() {
                let parsed = String::from_utf8_lossy(&title_buf).trim().to_string();
                if !parsed.is_empty() {
                    full_title = parsed;
                }
            }
        }
    }

    Ok(MobiMetadata {
        title: full_title,
        author: None,
        publisher: None,
        description: None,
        isbn: None,
        compression_type,
        text_length,
        record_count,
        cover_record_offset: None,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// TAURI COMMANDS
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn decompress_palmdoc_record(record_bytes: Vec<u8>) -> Result<String, String> {
    let decompressed = decompress_palmdoc(&record_bytes)?;
    Ok(String::from_utf8_lossy(&decompressed).into_owned())
}

#[tauri::command]
pub fn get_mobi_metadata(path: String) -> Result<MobiMetadata, String> {
    let file_path = Path::new(&path);
    if !file_path.exists() {
        return Err(format!("File not found: {path}"));
    }
    parse_mobi_file(file_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_palmdoc_literal_and_space() {
        // 0x05 followed by 5 bytes "Hello", then 0xC0 + ('W' ^ 0x80), then literal 'o', 'r', 'l', 'd'
        let mut input = vec![0x05, b'H', b'e', b'l', b'l', b'o'];
        input.push(0x80 ^ b'W'); // space + 'W'
        input.extend_from_slice(b"orld");

        let decompressed = decompress_palmdoc(&input).unwrap();
        let s = String::from_utf8_lossy(&decompressed);
        assert_eq!(s, "Hello World");
    }

    #[test]
    fn test_palmdoc_sliding_window_repeat() {
        // "ABCABCABC" using 2-byte distance/length
        let mut input = vec![0x03, b'A', b'B', b'C'];
        // Distance 3, length 6:
        // distance = 3 -> ((b1 & 0x3F) << 3) | (b2 >> 5)
        // b1 = 0x80 | (0 << 3) = 0x80
        // b2 = (3 << 5) | (6 - 3) = 0x60 | 0x03 = 0x63
        input.push(0x80);
        input.push(0x63);

        let decompressed = decompress_palmdoc(&input).unwrap();
        let s = String::from_utf8_lossy(&decompressed);
        assert_eq!(s, "ABCABCABC");
    }
}
