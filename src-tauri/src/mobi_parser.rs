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
            // 2-byte distance/length pair: 11-bit distance (low 6 bits of b +
            // high 5 bits of b2), 3-bit length. (Canonical PalmDOC layout.)
            if i >= bytes.len() {
                break;
            }
            let b2 = bytes[i];
            i += 1;

            let distance = ((((b as usize) << 8) | b2 as usize) >> 3) & 0x7FF;
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

/// Extract the full plain text of a MOBI file. PalmDOC (compression 1) is
/// decompressed natively; HUFF/CDIC (compression 2) via the Huffman decoder
/// below. Malformed books that claim compression 2 without any HUFF/CDIC
/// records are actually PalmDOC-compressed — fall back to that.
pub fn extract_mobi_text(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| format!("Cannot open MOBI file: {e}"))?;

    let mut pdb_header = [0u8; 78];
    file.read_exact(&mut pdb_header)
        .map_err(|e| format!("Failed to read PDB header: {e}"))?;
    let num_records = u16::from_be_bytes([pdb_header[76], pdb_header[77]]) as usize;

    // PDB record offset table: num_records 8-byte entries (offset u32, attrs, uniqueId).
    let mut offsets = Vec::with_capacity(num_records);
    for _ in 0..num_records {
        let mut entry = [0u8; 8];
        file.read_exact(&mut entry)
            .map_err(|e| format!("Failed to read record list: {e}"))?;
        offsets.push(u32::from_be_bytes([entry[0], entry[1], entry[2], entry[3]]));
    }
    if offsets.is_empty() {
        return Err("MOBI file has no records".to_string());
    }
    let file_end = file.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;

    let rec0_offset = offsets[0] as u64;
    file.seek(SeekFrom::Start(rec0_offset))
        .map_err(|e| format!("Failed to seek to record 0: {e}"))?;
    let mut rec0_buf = [0u8; 512];
    file.read_exact(&mut rec0_buf)
        .map_err(|e| format!("Failed to read record 0: {e}"))?;
    let compression_type = u16::from_be_bytes([rec0_buf[0], rec0_buf[1]]);
    let text_length =
        u32::from_be_bytes([rec0_buf[4], rec0_buf[5], rec0_buf[6], rec0_buf[7]]) as usize;
    let record_count = u16::from_be_bytes([rec0_buf[8], rec0_buf[9]]) as usize;

    // HUFF/CDIC record pointers live at MOBI-header offsets 0x60/0x64
    // (record-0 offsets 0x70/0x74; the MOBI header starts at record0+16).
    let huff_record = u32::from_be_bytes([
        rec0_buf[0x70],
        rec0_buf[0x71],
        rec0_buf[0x72],
        rec0_buf[0x73],
    ]) as usize;
    let huff_count = u32::from_be_bytes([
        rec0_buf[0x74],
        rec0_buf[0x75],
        rec0_buf[0x76],
        rec0_buf[0x77],
    ]) as usize;

    let read_record = |file: &mut File, index: usize| -> Result<Vec<u8>, String> {
        let start = offsets[index] as u64;
        let end = if index + 1 < offsets.len() {
            offsets[index + 1] as u64
        } else {
            file_end
        };
        if end <= start {
            return Ok(Vec::new());
        }
        file.seek(SeekFrom::Start(start))
            .map_err(|e| format!("Failed to seek to record {index}: {e}"))?;
        let mut record = vec![0u8; (end - start) as usize];
        file.read_exact(&mut record)
            .map_err(|e| format!("Failed to read record {index}: {e}"))?;
        Ok(record)
    };

    let text_end = (record_count + 1).min(offsets.len());

    let mut out = String::new();
    match compression_type {
        1 => {
            for record_index in 1..text_end {
                let record = read_record(&mut file, record_index)?;
                let decompressed = decompress_palmdoc(&record)?;
                out.push_str(&String::from_utf8_lossy(&decompressed));
            }
        }
        2 if huff_record > 0 && huff_record < offsets.len() && huff_count >= 1 => {
            let huff = read_record(&mut file, huff_record)?;
            let mut cdics = Vec::with_capacity(huff_count);
            for k in 0..huff_count {
                let index = huff_record + 1 + k;
                if index >= offsets.len() {
                    break;
                }
                cdics.push(read_record(&mut file, index)?);
            }
            let decoder = HuffCdic::new(&huff, &cdics)?;
            for record_index in 1..text_end {
                let record = read_record(&mut file, record_index)?;
                let decompressed = decoder.unpack(&record)?;
                out.push_str(&String::from_utf8_lossy(&decompressed));
            }
        }
        // Compression 2 without HUFF/CDIC records: mislabeled Mobipocket
        // Creator output — the records are actually PalmDOC-compressed
        // (verified against a real library book that hits this).
        2 => {
            for record_index in 1..text_end {
                let record = read_record(&mut file, record_index)?;
                let decompressed = decompress_palmdoc(&record)?;
                out.push_str(&String::from_utf8_lossy(&decompressed));
            }
        }
        // Compression 0: uncompressed records.
        _ => {
            for record_index in 1..text_end {
                let record = read_record(&mut file, record_index)?;
                out.push_str(&String::from_utf8_lossy(&record));
            }
        }
    }

    out.truncate(
        out.char_indices()
            .nth(text_length)
            .map(|(i, _)| i)
            .unwrap_or(out.len()),
    );
    Ok(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// HUFF/CDIC Huffman decompression (compression type 2)
// ─────────────────────────────────────────────────────────────────────────────

fn be32(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}

/// Decoder for MOBI's Huffman scheme: a `HUFF` record describing the code
/// tables and one or more `CDIC` records holding the phrase dictionary.
/// Codes are Huffman codes over 32-bit words, always left-aligned: a code of
/// length `c` occupies the top `c` bits of a u32.
struct HuffCdic {
    /// Per top-byte (code >> 24) entry: (codelen, is_terminal, class_maxcode).
    dict1: [(u8, bool, u32); 256],
    /// Left-aligned smallest code per codelen (index 1..=32).
    mincode: [u32; 33],
    /// Left-aligned largest code per codelen (index 1..=32).
    maxcode: [u32; 33],
    /// Phrase dictionary: (bytes, is_literal). Non-literal phrases are
    /// themselves HUFF-packed and expand recursively.
    dictionary: Vec<(Vec<u8>, bool)>,
}

impl HuffCdic {
    fn new(huff: &[u8], cdics: &[Vec<u8>]) -> Result<Self, String> {
        if huff.len() < 16 || huff[0..8] != *b"HUFF\x00\x00\x00\x18" {
            return Err("Invalid HUFF record".to_string());
        }
        let off1 = be32(&huff[8..12]) as usize;
        let off2 = be32(&huff[12..16]) as usize;
        if off1 + 1024 > huff.len() || off2 + 256 > huff.len() {
            return Err("HUFF dictionary out of bounds".to_string());
        }

        let mut dict1 = [(0u8, false, 0u32); 256];
        for (i, slot) in dict1.iter_mut().enumerate() {
            let v = be32(&huff[off1 + i * 4..off1 + i * 4 + 4]);
            let codelen = (v & 0x1f) as u8;
            if codelen == 0 {
                return Err(format!("HUFF dict1 entry {i} has zero codelen"));
            }
            let term = v & 0x80 != 0;
            // maxcode is stored shifted right by (32 - codelen); realign and
            // mark the class end. u64 intermediate absorbs the +1 overflow.
            let raw = (v >> 8) as u64;
            let maxcode = (((raw + 1) << (32 - codelen)) - 1) as u32;
            *slot = (codelen, term, maxcode);
        }

        // dict2: 32 (mincode, maxcode) pairs for codelens 1..=32.
        let mut mincode = [0u32; 33];
        let mut maxcode = [0u32; 33];
        for codelen in 1..=32usize {
            let base = off2 + (codelen - 1) * 8;
            mincode[codelen] = be32(&huff[base..base + 4]) << (32 - codelen);
            maxcode[codelen] =
                (((be32(&huff[base + 4..base + 8]) as u64 + 1) << (32 - codelen)) - 1) as u32;
        }

        let mut dictionary = Vec::new();
        for cdic in cdics {
            load_cdic(&mut dictionary, cdic)?;
        }

        Ok(Self {
            dict1,
            mincode,
            maxcode,
            dictionary,
        })
    }

    /// Decode one HUFF-packed record. The bitstream is consumed MSB-first in
    /// 32-bit windows; each code maps to a dictionary phrase (possibly
    /// recursively expanded) appended to the output.
    fn unpack(&self, data: &[u8]) -> Result<Vec<u8>, String> {
        if data.is_empty() {
            return Ok(Vec::new());
        }
        let mut expanded: Vec<Option<Vec<u8>>> = self
            .dictionary
            .iter()
            .map(|(slice, literal)| if *literal { Some(slice.clone()) } else { None })
            .collect();
        self.unpack_into(data, &mut expanded)
    }

    /// Core bitstream loop, sharing `expanded` across recursive calls so each
    /// cross-reference phrase is only expanded once per record.
    fn unpack_into(
        &self,
        data: &[u8],
        expanded: &mut Vec<Option<Vec<u8>>>,
    ) -> Result<Vec<u8>, String> {
        if data.is_empty() {
            return Ok(Vec::new());
        }
        // The reference pads the stream with 8 zero bytes so a full u64
        // window is always readable; the padding never yields output because
        // `bitsleft` breaks the loop first.
        let mut padded = Vec::with_capacity(data.len() + 8);
        padded.extend_from_slice(data);
        padded.extend_from_slice(&[0u8; 8]);

        let mut out = Vec::new();
        let mut bitsleft = (data.len() * 8) as i64;
        let mut pos = 0usize;
        let mut x = u64::from_be_bytes(padded[0..8].try_into().unwrap());
        let mut n = 32i32;

        loop {
            if n <= 0 {
                pos += 4;
                if pos + 8 > padded.len() {
                    return Err("HUFF bitstream overrun".to_string());
                }
                x = u64::from_be_bytes(padded[pos..pos + 8].try_into().unwrap());
                n += 32;
            }
            let code = ((x >> n) & 0xffff_ffff) as u32;
            let (mut codelen, term, mut maxcode) = self.dict1[(code >> 24) as usize];
            if !term {
                while code < self.mincode[codelen as usize] {
                    codelen += 1;
                    if codelen > 32 {
                        return Err("HUFF code not found in tables".to_string());
                    }
                }
                maxcode = self.maxcode[codelen as usize];
            }
            n -= codelen as i32;
            bitsleft -= codelen as i64;
            if bitsleft < 0 {
                break;
            }
            let r = ((maxcode.wrapping_sub(code)) >> (32 - codelen)) as usize;
            if r >= expanded.len() {
                return Err(format!("HUFF phrase index {r} out of range"));
            }
            if expanded[r].is_none() {
                // Cross-reference phrase: its bytes are HUFF-packed too. The
                // pre-set empty slice guards against cyclic references.
                let raw = self.dictionary[r].0.clone();
                expanded[r] = Some(Vec::new());
                let slice = self.unpack_into(&raw, expanded)?;
                expanded[r] = Some(slice);
            }
            out.extend_from_slice(expanded[r].as_ref().unwrap());
        }
        Ok(out)
    }
}

/// Load one `CDIC` record's slices into the dictionary. Each record holds
/// `n = min(1<<bits, remaining phrases)` slices: a table of u16 offsets
/// followed by scattered (u16 length+flag, bytes) slice headers.
fn load_cdic(dictionary: &mut Vec<(Vec<u8>, bool)>, cdic: &[u8]) -> Result<(), String> {
    if cdic.len() < 16 || cdic[0..8] != *b"CDIC\x00\x00\x00\x10" {
        return Err("Invalid CDIC record".to_string());
    }
    let phrases = be32(&cdic[8..12]) as usize;
    let bits = be32(&cdic[12..16]);
    let capacity = 1u64.checked_shl(bits).unwrap_or(u64::MAX) as usize;
    let n = capacity.min(phrases.saturating_sub(dictionary.len()));
    if n == 0 {
        return Ok(());
    }
    if 16 + n * 2 > cdic.len() {
        return Err("CDIC slice table out of bounds".to_string());
    }
    let mut offsets = Vec::with_capacity(n);
    for k in 0..n {
        offsets.push(u16::from_be_bytes([cdic[16 + k * 2], cdic[17 + k * 2]]));
    }
    for off in offsets {
        let o = off as usize;
        if 16 + o + 2 > cdic.len() {
            return Err("CDIC slice header out of bounds".to_string());
        }
        let blen = u16::from_be_bytes([cdic[16 + o], cdic[17 + o]]);
        let len = (blen & 0x7fff) as usize;
        if 18 + o + len > cdic.len() {
            return Err("CDIC slice data out of bounds".to_string());
        }
        dictionary.push((cdic[18 + o..18 + o + len].to_vec(), blen & 0x8000 != 0));
    }
    Ok(())
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
        // "ABCABCABC" using a 2-byte distance/length pair
        let mut input = vec![0x03, b'A', b'B', b'C'];
        // Copy 6 bytes from distance 3: b1 = 0x80 | (dist >> 5) = 0x80,
        // b2 = ((dist & 0x1F) << 3) | (length - 3) = 0x18 | 0x03 = 0x1B
        input.push(0x80);
        input.push(0x1B);

        let decompressed = decompress_palmdoc(&input).unwrap();
        let s = String::from_utf8_lossy(&decompressed);
        assert_eq!(s, "ABCABCABC");
    }

    // ── HUFF/CDIC ────────────────────────────────────────────────────────────

    /// Build a HUFF record for a trivial canonical code: every byte b is an
    /// 8-bit terminal code (left-aligned value b << 24), which maps to
    /// dictionary phrase 255 - b. dict2 is unused because every entry is
    /// terminal (patch it in tests that exercise the mincode walk).
    fn build_huff() -> Vec<u8> {
        let mut huff = Vec::new();
        huff.extend_from_slice(b"HUFF\x00\x00\x00\x18");
        huff.extend_from_slice(&16u32.to_be_bytes());
        huff.extend_from_slice(&(16u32 + 1024).to_be_bytes());
        for _ in 0..256 {
            // codelen 8 | term 0x80 | maxcode_raw 255 → class max 0xFFFFFFFF
            huff.extend_from_slice(&0xFF88u32.to_be_bytes());
        }
        huff.extend_from_slice(&[0u8; 64 * 4]);
        huff
    }

    /// Build one CDIC record holding `slices` in order (phrase k = slices[k]).
    fn build_cdic(slices: &[(Vec<u8>, bool)]) -> Vec<u8> {
        let mut cdic = Vec::new();
        cdic.extend_from_slice(b"CDIC\x00\x00\x00\x10");
        cdic.extend_from_slice(&(slices.len() as u32).to_be_bytes());
        cdic.extend_from_slice(&8u32.to_be_bytes()); // bits → table of 256
        let table_pos = cdic.len();
        cdic.resize(table_pos + slices.len() * 2, 0);
        for (k, (data, literal)) in slices.iter().enumerate() {
            let off = (cdic.len() - 16) as u16;
            let blen = if *literal {
                0x8000 | data.len() as u16
            } else {
                data.len() as u16
            };
            cdic[table_pos + k * 2..table_pos + k * 2 + 2].copy_from_slice(&off.to_be_bytes());
            cdic.extend_from_slice(&blen.to_be_bytes());
            cdic.extend_from_slice(data);
        }
        cdic
    }

    fn literal_phrases() -> Vec<(Vec<u8>, bool)> {
        (0..256u32).map(|k| (vec![(255 - k) as u8], true)).collect()
    }

    #[test]
    fn test_huffcdic_literals_and_cross_reference() {
        let mut phrases = literal_phrases();
        // Byte 'A' (phrase 190) expands recursively from the packed "BC".
        phrases[190] = (vec![0x42, 0x43], false);
        let cdics = vec![build_cdic(&phrases)];
        let decoder = HuffCdic::new(&build_huff(), &cdics).unwrap();

        // "AAB" decodes to "BC" + "BC" + "B"
        let out = decoder.unpack(&[0x41, 0x41, 0x42]).unwrap();
        assert_eq!(out, b"BCBCB");
    }

    #[test]
    fn test_huffcdic_multilength_mincode_walk() {
        let mut huff = build_huff();
        // dict1[0x00]: codelen 8, NOT terminal — forces the mincode walk.
        huff[16..20].copy_from_slice(&0x08u32.to_be_bytes());
        // dict2: 8-bit class starts at code 1<<24; codelens 9-11 are empty;
        // the 12-bit class holds only code 0 (min 0, count 1).
        let off2 = 16 + 1024;
        let set = |h: &mut Vec<u8>, codelen: usize, min: u32, max: u32| {
            let base = off2 + (codelen - 1) * 8;
            h[base..base + 4].copy_from_slice(&min.to_be_bytes());
            h[base + 4..base + 8].copy_from_slice(&max.to_be_bytes());
        };
        set(&mut huff, 8, 1, 255);
        set(&mut huff, 9, 1, 0);
        set(&mut huff, 10, 1, 0);
        set(&mut huff, 11, 1, 0);
        set(&mut huff, 12, 0, 0);

        let mut phrases = literal_phrases();
        phrases[0] = (vec![0x00], true); // 12-bit code 0 → literal NUL
        let cdics = vec![build_cdic(&phrases)];
        let decoder = HuffCdic::new(&huff, &cdics).unwrap();

        // Stream: 12 zero bits (code 0), 8 bits 0x42 ('B'), 1111 filler so
        // the terminal bitstream check breaks on the padding window.
        let out = decoder.unpack(&[0x00, 0x04, 0x2F]).unwrap();
        assert_eq!(out, vec![0x00, 0x42]);
    }

    /// Real-book smoke test: `THEOREM_TEST_MOBI=/path/to/book.mobi cargo
    /// test --real-mobi -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn test_real_mobi_book_extracts() {
        let Ok(path) = std::env::var("THEOREM_TEST_MOBI") else {
            return;
        };
        let text = extract_mobi_text(std::path::Path::new(&path)).unwrap();
        assert!(text.chars().count() > 10_000, "extracted too little text");
        println!("extracted {} chars", text.chars().count());
        println!("preview: {:?}", &text[..180.min(text.len())]);
    }
}
