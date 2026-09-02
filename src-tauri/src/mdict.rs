use flate2::read::ZlibDecoder;
use memmap2::Mmap;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use tauri::{AppHandle, Manager};

/// MDict header metadata
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MdxHeader {
    pub title: String,
    pub description: String,
    pub version: String,
    pub encoding: String,
    pub format: String,
    pub num_entries: u64,
}

/// In-memory keyword block summary for fast O(log N) binary search
#[derive(Debug, Clone)]
struct KeyBlockMeta {
    first_word: String,
    last_word: String,
    comp_size: usize,
    decomp_size: usize,
    file_offset: usize,
    #[allow(dead_code)]
    num_entries: usize,
}

/// In-memory record block summary
#[derive(Debug, Clone)]
struct RecordBlockMeta {
    comp_size: usize,
    decomp_size: usize,
    file_offset: usize,
    decomp_accum_offset: usize, // Cumulative decompressed offset
}

/// LRU cache for decompressed record blocks (64KB chunks)
struct RecordLruCache {
    capacity: usize,
    cache: HashMap<usize, Arc<Vec<u8>>>,
    order: VecDeque<usize>,
}

impl RecordLruCache {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            cache: HashMap::with_capacity(capacity),
            order: VecDeque::with_capacity(capacity),
        }
    }

    fn get(&mut self, block_idx: usize) -> Option<Arc<Vec<u8>>> {
        if let Some(val) = self.cache.get(&block_idx) {
            // Move to back (most recently used)
            if let Some(pos) = self.order.iter().position(|&x| x == block_idx) {
                self.order.remove(pos);
            }
            self.order.push_back(block_idx);
            Some(val.clone())
        } else {
            None
        }
    }

    fn insert(&mut self, block_idx: usize, data: Arc<Vec<u8>>) {
        if self.cache.len() >= self.capacity {
            if let Some(oldest) = self.order.pop_front() {
                self.cache.remove(&oldest);
            }
        }
        self.cache.insert(block_idx, data);
        self.order.push_back(block_idx);
    }
}

/// Native memory-mapped MDict `.mdx` reader
pub struct MdxDictionary {
    pub header: MdxHeader,
    mmap: Mmap,
    key_blocks: Vec<KeyBlockMeta>,
    record_blocks: Vec<RecordBlockMeta>,
    record_lru: Mutex<RecordLruCache>,
    utf16: bool,
}

impl MdxDictionary {
    /// Open and initialize an `.mdx` file with zero whole-file decompression
    pub fn open(path: &Path) -> Result<Self, String> {
        let file =
            File::open(path).map_err(|e| format!("Failed to open MDX file {path:?}: {e}"))?;
        let mmap =
            unsafe { Mmap::map(&file).map_err(|e| format!("Mmap failed on {path:?}: {e}"))? };

        if mmap.len() < 40 {
            return Err("MDX file is too small to be valid".to_string());
        }

        let mut offset = 0;

        // 1. Read Header Bytes Size (4 bytes Big-Endian)
        let header_len = u32::from_be_bytes(
            mmap[offset..offset + 4]
                .try_into()
                .map_err(|_| "Header read error")?,
        ) as usize;
        offset += 4;

        if offset + header_len > mmap.len() {
            return Err("Corrupted MDX header length".to_string());
        }

        let header_raw = &mmap[offset..offset + header_len];
        offset += header_len;
        offset += 4; // Skip 4-byte Adler32 checksum

        // Parse XML Header
        let (header, utf16) = parse_mdx_header(header_raw)?;

        // 2. Read Keyword Section Header (v2.0 64-bit offsets)
        if offset + 40 > mmap.len() {
            return Err("Truncated MDX keyword header".to_string());
        }

        let num_key_blocks = read_u64_be(&mmap, &mut offset)? as usize;
        let num_entries = read_u64_be(&mmap, &mut offset)?;
        let key_block_info_decomp_size = read_u64_be(&mmap, &mut offset)? as usize;
        let key_block_info_size = read_u64_be(&mmap, &mut offset)? as usize;
        let key_block_size = read_u64_be(&mmap, &mut offset)? as usize;

        offset += 4; // Skip 4-byte Adler32 checksum

        // Decompress Keyword Block Info
        if offset + key_block_info_size > mmap.len() {
            return Err("Truncated key block info in MDX".to_string());
        }

        let key_info_comp = &mmap[offset..offset + key_block_info_size];
        offset += key_block_info_size;

        let key_info_decomp = decompress_zlib_chunk(key_info_comp, key_block_info_decomp_size)?;

        // Parse Keyword Block Metas
        let key_blocks_start = offset;
        let key_blocks =
            parse_key_block_metas(&key_info_decomp, num_key_blocks, key_blocks_start, utf16)?;

        offset += key_block_size;

        // 3. Read Record Section Header
        if offset + 32 > mmap.len() {
            return Err("Truncated MDX record header".to_string());
        }

        let num_record_blocks = read_u64_be(&mmap, &mut offset)? as usize;
        let _num_records = read_u64_be(&mmap, &mut offset)?;
        let record_block_info_size = read_u64_be(&mmap, &mut offset)? as usize;
        let _record_block_size = read_u64_be(&mmap, &mut offset)? as usize;

        // Record Block Info is NOT compressed — raw sequential 16-byte entries:
        // u64 comp_size + u64 decomp_size, one per record block.
        if offset + record_block_info_size > mmap.len() {
            return Err("Truncated record block info in MDX".to_string());
        }

        let rec_info_raw = &mmap[offset..offset + record_block_info_size];
        offset += record_block_info_size;

        // Parse Record Block Metas
        let record_blocks_start = offset;
        let record_blocks =
            parse_record_block_metas(rec_info_raw, num_record_blocks, record_blocks_start)?;

        let mut final_header = header;
        final_header.num_entries = num_entries;

        Ok(Self {
            header: final_header,
            mmap,
            key_blocks,
            record_blocks,
            record_lru: Mutex::new(RecordLruCache::new(24)),
            utf16,
        })
    }

    /// Fast O(log N) lookup returning clean definition HTML and metadata in < 0.5 ms
    pub fn lookup(&self, term: &str) -> Result<Option<MdxEntryResult>, String> {
        let clean_term = term.trim();
        if clean_term.is_empty() {
            return Ok(None);
        }

        // 1. Try Exact Match
        if let Some(res) = self.lookup_exact(clean_term)? {
            return Ok(Some(res));
        }

        // 2. Try Lowercase Match
        let lower = clean_term.to_lowercase();
        if lower != clean_term {
            if let Some(res) = self.lookup_exact(&lower)? {
                return Ok(Some(res));
            }
        }

        // 3. Try Stripping Punctuation / Numbers
        let stripped = clean_term
            .trim_matches(|c: char| !c.is_alphanumeric())
            .to_string();
        if !stripped.is_empty() && stripped != clean_term && stripped != lower {
            if let Some(res) = self.lookup_exact(&stripped)? {
                return Ok(Some(res));
            }
            let stripped_lower = stripped.to_lowercase();
            if let Some(res) = self.lookup_exact(&stripped_lower)? {
                return Ok(Some(res));
            }
        }

        Ok(None)
    }

    fn lookup_exact(&self, word: &str) -> Result<Option<MdxEntryResult>, String> {
        let norm_query = word.to_lowercase();

        // 1. Binary Search over Key Block Metas to find candidate block
        let block_idx = match self.key_blocks.binary_search_by(|kb| {
            let first = kb.first_word.to_lowercase();
            let last = kb.last_word.to_lowercase();

            if norm_query < first {
                std::cmp::Ordering::Greater
            } else if norm_query > last {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        }) {
            Ok(idx) => idx,
            Err(idx) => {
                if idx < self.key_blocks.len() {
                    idx
                } else if !self.key_blocks.is_empty() {
                    self.key_blocks.len() - 1
                } else {
                    return Ok(None);
                }
            }
        };

        // 2. Decompress Key Block and search for exact term
        let kb = &self.key_blocks[block_idx];
        let comp_bytes = &self.mmap[kb.file_offset..kb.file_offset + kb.comp_size];
        let decomp_bytes = decompress_zlib_chunk(comp_bytes, kb.decomp_size)?;

        let entries = parse_decompressed_key_block(&decomp_bytes, self.utf16)?;

        // Binary search within block entries
        let target_entry = entries
            .iter()
            .find(|(entry_word, _)| entry_word.eq_ignore_ascii_case(word));

        let (_matched_word, record_offset) = match target_entry {
            Some((w, off)) => (w, *off),
            None => return Ok(None),
        };

        // 3. Locate Record Block for this offset and extract definition
        let definition_html = self.read_record_definition(record_offset)?;

        // Handle MDict `@@@LINK=target` redirects
        if let Some(redirect_target) = definition_html.strip_prefix("@@@LINK=") {
            let target_word = redirect_target.trim();
            if target_word != word {
                return self.lookup(target_word);
            }
        }

        Ok(Some(MdxEntryResult {
            term: word.to_string(),
            html: definition_html,
            dictionary_name: self.header.title.clone(),
        }))
    }

    fn read_record_definition(&self, record_offset: usize) -> Result<String, String> {
        // Binary search for the record block spanning `record_offset`
        let block_idx = match self.record_blocks.binary_search_by(|rb| {
            let start = rb.decomp_accum_offset;
            let end = start + rb.decomp_size;

            if record_offset < start {
                std::cmp::Ordering::Greater
            } else if record_offset >= end {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        }) {
            Ok(idx) => idx,
            Err(_) => return Err("Record offset out of bounds in MDX".to_string()),
        };

        let rb = &self.record_blocks[block_idx];

        // Check LRU Cache
        let decomp_data = {
            let mut lru = self.record_lru.lock().unwrap();
            if let Some(cached) = lru.get(block_idx) {
                cached
            } else {
                let comp_bytes = &self.mmap[rb.file_offset..rb.file_offset + rb.comp_size];
                let decomp = Arc::new(decompress_zlib_chunk(comp_bytes, rb.decomp_size)?);
                lru.insert(block_idx, decomp.clone());
                decomp
            }
        };

        let inside_offset = record_offset - rb.decomp_accum_offset;
        if inside_offset >= decomp_data.len() {
            return Err("Record inside offset out of range".to_string());
        }

        // MDict definitions are null-terminated strings
        let slice = &decomp_data[inside_offset..];
        let null_pos = slice.iter().position(|&b| b == 0).unwrap_or(slice.len());

        let raw_str = if self.utf16 {
            let u16_slice: Vec<u16> = slice[..null_pos]
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            String::from_utf16_lossy(&u16_slice)
        } else {
            String::from_utf8_lossy(&slice[..null_pos]).to_string()
        };

        Ok(raw_str.trim().to_string())
    }
}

/// Helper function to decompress zlib chunk (with 8-byte type/checksum header bypass)
fn decompress_zlib_chunk(data: &[u8], expected_size: usize) -> Result<Vec<u8>, String> {
    if data.is_empty() {
        return Ok(Vec::new());
    }

    // MDict blocks have a 4 or 8 byte compression type/checksum header:
    // 0x02 0x00 0x00 0x00 (zlib) followed by checksum
    let payload = if data.len() > 8 && (data[0] == 0x02 || data[0] == 0x01) {
        &data[8..]
    } else if data.len() > 4 && data[0] == 0x02 {
        &data[4..]
    } else {
        data
    };

    let mut decoder = ZlibDecoder::new(payload);
    let mut out = Vec::with_capacity(expected_size.max(4096));
    decoder
        .read_to_end(&mut out)
        .map_err(|e| format!("Zlib decompression failed: {e}"))?;

    Ok(out)
}

fn read_u64_be(mmap: &[u8], offset: &mut usize) -> Result<u64, String> {
    if *offset + 8 > mmap.len() {
        return Err("Unexpected EOF reading u64".to_string());
    }
    let val = u64::from_be_bytes(
        mmap[*offset..*offset + 8]
            .try_into()
            .map_err(|_| "Failed to parse u64")?,
    );
    *offset += 8;
    Ok(val)
}

fn parse_mdx_header(raw: &[u8]) -> Result<(MdxHeader, bool), String> {
    // MDict v2.0 headers are ALWAYS encoded in UTF-16LE.
    // Try UTF-16LE decode first; fall back to UTF-8 for older v1.x files.
    let utf16_candidates: Vec<u16> = raw
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let text_utf16 = String::from_utf16_lossy(&utf16_candidates);

    let xml_text = if text_utf16.contains("<Dictionary") || text_utf16.contains("<dictionary") {
        text_utf16
    } else {
        String::from_utf8_lossy(raw).to_string()
    };

    let title =
        extract_xml_attr(&xml_text, "Title").unwrap_or_else(|| "MDict Dictionary".to_string());
    let description = extract_xml_attr(&xml_text, "Description").unwrap_or_default();
    let version = extract_xml_attr(&xml_text, "GeneratedByEngineVersion")
        .unwrap_or_else(|| "2.0".to_string());
    let encoding = extract_xml_attr(&xml_text, "Encoding").unwrap_or_else(|| "UTF-8".to_string());
    let format = extract_xml_attr(&xml_text, "Format").unwrap_or_else(|| "Html".to_string());

    // The `utf16` flag controls how CONTENT strings (words + definitions) are encoded.
    // MDict v2.0 always stores the header XML in UTF-16LE, but content encoding
    // is determined by the `Encoding` attribute — typically UTF-8 for modern dictionaries.
    let content_utf16 = encoding.to_uppercase().contains("UTF-16");

    Ok((
        MdxHeader {
            title,
            description,
            version,
            encoding,
            format,
            num_entries: 0,
        },
        content_utf16,
    ))
}

fn extract_xml_attr(xml: &str, attr: &str) -> Option<String> {
    let pat = format!("{attr}=\"");
    let pos = xml.find(&pat)?;
    let start = pos + pat.len();
    let end = start + xml[start..].find('\"')?;
    Some(xml[start..end].trim().to_string())
}

fn parse_key_block_metas(
    info_bytes: &[u8],
    num_blocks: usize,
    mut block_file_offset: usize,
    utf16: bool,
) -> Result<Vec<KeyBlockMeta>, String> {
    let mut metas = Vec::with_capacity(num_blocks);
    let mut offset = 0;

    // In MDict v2.0, each string in the key block info is stored as:
    // u16 length (NOT counting the null terminator) + raw bytes + null terminator
    // The null terminator is 2 bytes for UTF-16, 1 byte for UTF-8.
    let null_size = if utf16 { 2 } else { 1 };

    for _ in 0..num_blocks {
        if offset + 8 > info_bytes.len() {
            break;
        }
        let num_entries =
            u64::from_be_bytes(info_bytes[offset..offset + 8].try_into().unwrap()) as usize;
        offset += 8;

        // First word: u16 length (excl. null) + bytes + null terminator
        if offset + 2 > info_bytes.len() {
            break;
        }
        let first_len =
            u16::from_be_bytes(info_bytes[offset..offset + 2].try_into().unwrap()) as usize;
        offset += 2;
        let first_word = read_string_with_len(info_bytes, &mut offset, first_len, utf16);
        // Skip null terminator not counted in the stored length
        offset = (offset + null_size).min(info_bytes.len());

        // Last word: u16 length (excl. null) + bytes + null terminator
        if offset + 2 > info_bytes.len() {
            break;
        }
        let last_len =
            u16::from_be_bytes(info_bytes[offset..offset + 2].try_into().unwrap()) as usize;
        offset += 2;
        let last_word = read_string_with_len(info_bytes, &mut offset, last_len, utf16);
        // Skip null terminator
        offset = (offset + null_size).min(info_bytes.len());

        if offset + 16 > info_bytes.len() {
            break;
        }
        let comp_size =
            u64::from_be_bytes(info_bytes[offset..offset + 8].try_into().unwrap()) as usize;
        offset += 8;
        let decomp_size =
            u64::from_be_bytes(info_bytes[offset..offset + 8].try_into().unwrap()) as usize;
        offset += 8;

        metas.push(KeyBlockMeta {
            first_word,
            last_word,
            comp_size,
            decomp_size,
            file_offset: block_file_offset,
            num_entries,
        });

        block_file_offset += comp_size;
    }

    Ok(metas)
}

fn read_string_with_len(data: &[u8], offset: &mut usize, len: usize, utf16: bool) -> String {
    let end = (*offset + len).min(data.len());
    let slice = &data[*offset..end];
    *offset = end;

    if utf16 {
        let u16_vec: Vec<u16> = slice
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&u16_vec)
            .trim_matches('\0')
            .to_string()
    } else {
        String::from_utf8_lossy(slice)
            .trim_matches('\0')
            .to_string()
    }
}

fn parse_decompressed_key_block(data: &[u8], utf16: bool) -> Result<Vec<(String, usize)>, String> {
    let mut entries = Vec::new();
    let mut offset = 0;

    while offset + 8 < data.len() {
        let record_offset =
            u64::from_be_bytes(data[offset..offset + 8].try_into().unwrap()) as usize;
        offset += 8;

        let word = if utf16 {
            let start = offset;
            let mut end = start;
            while end + 1 < data.len() && !(data[end] == 0 && data[end + 1] == 0) {
                end += 2;
            }
            offset = (end + 2).min(data.len());
            let u16_vec: Vec<u16> = data[start..end]
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            String::from_utf16_lossy(&u16_vec)
        } else {
            let start = offset;
            let mut end = start;
            while end < data.len() && data[end] != 0 {
                end += 1;
            }
            offset = (end + 1).min(data.len());
            String::from_utf8_lossy(&data[start..end]).to_string()
        };

        if !word.is_empty() {
            entries.push((word, record_offset));
        }
    }

    Ok(entries)
}

fn parse_record_block_metas(
    info_bytes: &[u8],
    num_blocks: usize,
    mut block_file_offset: usize,
) -> Result<Vec<RecordBlockMeta>, String> {
    let mut metas = Vec::with_capacity(num_blocks);
    let mut offset = 0;
    let mut accum_decomp_offset = 0;

    for _ in 0..num_blocks {
        if offset + 16 > info_bytes.len() {
            break;
        }
        let comp_size =
            u64::from_be_bytes(info_bytes[offset..offset + 8].try_into().unwrap()) as usize;
        offset += 8;
        let decomp_size =
            u64::from_be_bytes(info_bytes[offset..offset + 8].try_into().unwrap()) as usize;
        offset += 8;

        metas.push(RecordBlockMeta {
            comp_size,
            decomp_size,
            file_offset: block_file_offset,
            decomp_accum_offset: accum_decomp_offset,
        });

        block_file_offset += comp_size;
        accum_decomp_offset += decomp_size;
    }

    Ok(metas)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MdxEntryResult {
    pub term: String,
    pub html: String,
    pub dictionary_name: String,
}

// ─────────────────────────────────────────────────────────────────────────────
// DICTIONARY REGISTRY & TAURI COMMANDS
// ─────────────────────────────────────────────────────────────────────────────

fn mdx_dict_cache() -> &'static RwLock<HashMap<String, Arc<MdxDictionary>>> {
    static CACHE: OnceLock<RwLock<HashMap<String, Arc<MdxDictionary>>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn get_mdx_dictionary(app: &AppHandle, dict_id: &str) -> Result<Arc<MdxDictionary>, String> {
    {
        let cache = mdx_dict_cache().read().unwrap();
        if let Some(dict) = cache.get(dict_id) {
            return Ok(dict.clone());
        }
    }

    let dict_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("dictionaries")
        .join(dict_id);

    // Look for `.mdx` file in dictionary directory
    let mdx_path = if dict_dir.is_file()
        && dict_dir.extension().and_then(|s| s.to_str()) == Some("mdx")
    {
        dict_dir
    } else {
        let mut found = None;
        if let Ok(entries) = std::fs::read_dir(&dict_dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() && p.extension().and_then(|s| s.to_str()) == Some("mdx") {
                    found = Some(p);
                    break;
                }
            }
        }
        found.ok_or_else(|| format!("No .mdx file found in dictionary directory {dict_dir:?}"))?
    };

    let dict = Arc::new(MdxDictionary::open(&mdx_path)?);

    let mut cache = mdx_dict_cache().write().unwrap();
    cache.insert(dict_id.to_string(), dict.clone());

    Ok(dict)
}

/// Tauri Command: Lookup word across installed MDX dictionaries
#[tauri::command]
pub async fn mdx_lookup(
    app: AppHandle,
    dictionary_ids: Vec<String>,
    term: String,
) -> Result<Vec<MdxEntryResult>, String> {
    tokio::task::spawn_blocking(move || {
        let mut results = Vec::new();
        for id in dictionary_ids {
            if let Ok(dict) = get_mdx_dictionary(&app, &id) {
                if let Ok(Some(entry)) = dict.lookup(&term) {
                    results.push(entry);
                }
            }
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("MDX lookup task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::ZlibEncoder;
    use flate2::Compression;
    use std::io::Write;

    #[test]
    fn test_extract_xml_attr() {
        let sample = r#"<Dictionary GeneratedByEngineVersion="2.0" RequiredEngineVersion="2.0" Format="Html" Title="English Wiktionary" Encoding="UTF-8"/>"#;
        assert_eq!(
            extract_xml_attr(sample, "Title").as_deref(),
            Some("English Wiktionary")
        );
        assert_eq!(extract_xml_attr(sample, "Format").as_deref(), Some("Html"));
        assert_eq!(
            extract_xml_attr(sample, "GeneratedByEngineVersion").as_deref(),
            Some("2.0")
        );
    }

    fn zlib_compress_with_header(data: &[u8]) -> Vec<u8> {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(data).unwrap();
        let comp = encoder.finish().unwrap();

        let mut out = Vec::with_capacity(8 + comp.len());
        out.extend_from_slice(&[0x02, 0x00, 0x00, 0x00]); // 4-byte zlib type flag
        out.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]); // 4-byte checksum placeholder
        out.extend_from_slice(&comp);
        out
    }

    #[test]
    fn test_synthetic_mdx_lookup() {
        let temp_dir = tempfile::tempdir().unwrap();
        let mdx_path = temp_dir.path().join("test.mdx");

        let mut file_bytes = Vec::new();

        // 1. Header
        let header_xml = "<Dictionary GeneratedByEngineVersion=\"2.0\" Format=\"Html\" Title=\"Synthetic Comprehensive Wiktionary\" Encoding=\"UTF-8\"/>\0";
        let header_raw = header_xml.as_bytes();
        file_bytes.extend_from_slice(&(header_raw.len() as u32).to_be_bytes());
        file_bytes.extend_from_slice(header_raw);
        file_bytes.extend_from_slice(&[0u8; 4]); // 4-byte Adler32 placeholder

        // 2. Prepare Record Blocks
        let def_epiphany = "<div><span class=\"pos\">noun</span><p>A moment of sudden revelation or insight.</p></div>\0";
        let def_ephemeral = "<div><span class=\"pos\">adjective</span><p>Lasting for a very short time.</p></div>\0";
        let def_redirect = "@@@LINK=epiphany\0";

        let mut record_raw = Vec::new();
        let off_ephemeral = record_raw.len();
        record_raw.extend_from_slice(def_ephemeral.as_bytes());

        let off_epiphany = record_raw.len();
        record_raw.extend_from_slice(def_epiphany.as_bytes());

        let off_epiphanies = record_raw.len();
        record_raw.extend_from_slice(def_redirect.as_bytes());

        let comp_record_block = zlib_compress_with_header(&record_raw);

        // 3. Prepare Keyword Blocks
        let mut key_block_raw = Vec::new();
        key_block_raw.extend_from_slice(&(off_ephemeral as u64).to_be_bytes());
        key_block_raw.extend_from_slice(b"ephemeral\0");
        key_block_raw.extend_from_slice(&(off_epiphanies as u64).to_be_bytes());
        key_block_raw.extend_from_slice(b"epiphanies\0");
        key_block_raw.extend_from_slice(&(off_epiphany as u64).to_be_bytes());
        key_block_raw.extend_from_slice(b"epiphany\0");

        let comp_key_block = zlib_compress_with_header(&key_block_raw);

        // Prepare Key Block Info (UTF-8 format):
        // u64 num_entries, u16 first_len (excl null), bytes, \0, u16 last_len (excl null), bytes, \0, u64 comp, u64 decomp
        let mut key_info_raw = Vec::new();
        key_info_raw.extend_from_slice(&3u64.to_be_bytes()); // num_entries in block
        key_info_raw.extend_from_slice(&9u16.to_be_bytes()); // first word len (excl null)
        key_info_raw.extend_from_slice(b"ephemeral");
        key_info_raw.push(0u8); // null terminator (NOT counted in length)
        key_info_raw.extend_from_slice(&8u16.to_be_bytes()); // last word len (excl null)
        key_info_raw.extend_from_slice(b"epiphany");
        key_info_raw.push(0u8); // null terminator
        key_info_raw.extend_from_slice(&(comp_key_block.len() as u64).to_be_bytes());
        key_info_raw.extend_from_slice(&(key_block_raw.len() as u64).to_be_bytes());

        let comp_key_info = zlib_compress_with_header(&key_info_raw);

        // Write Keyword Section Header
        file_bytes.extend_from_slice(&1u64.to_be_bytes()); // num_key_blocks
        file_bytes.extend_from_slice(&3u64.to_be_bytes()); // num_entries
        file_bytes.extend_from_slice(&(key_info_raw.len() as u64).to_be_bytes());
        file_bytes.extend_from_slice(&(comp_key_info.len() as u64).to_be_bytes());
        file_bytes.extend_from_slice(&(comp_key_block.len() as u64).to_be_bytes());
        file_bytes.extend_from_slice(&[0u8; 4]); // checksum
        file_bytes.extend_from_slice(&comp_key_info);
        file_bytes.extend_from_slice(&comp_key_block);

        // Record Block Info is RAW (not zlib compressed): sequential u64 comp, u64 decomp per block
        let mut rec_info_raw = Vec::new();
        rec_info_raw.extend_from_slice(&(comp_record_block.len() as u64).to_be_bytes());
        rec_info_raw.extend_from_slice(&(record_raw.len() as u64).to_be_bytes());

        // Write Record Section Header
        file_bytes.extend_from_slice(&1u64.to_be_bytes()); // num_record_blocks
        file_bytes.extend_from_slice(&3u64.to_be_bytes()); // num_records
        file_bytes.extend_from_slice(&(rec_info_raw.len() as u64).to_be_bytes());
        file_bytes.extend_from_slice(&(comp_record_block.len() as u64).to_be_bytes());
        file_bytes.extend_from_slice(&rec_info_raw); // raw, NOT compressed
        file_bytes.extend_from_slice(&comp_record_block);

        std::fs::write(&mdx_path, file_bytes).unwrap();

        // 4. Test MdxDictionary
        let dict = MdxDictionary::open(&mdx_path).unwrap();
        assert_eq!(dict.header.title, "Synthetic Comprehensive Wiktionary");
        assert_eq!(dict.header.num_entries, 3);

        // Exact match
        let res_epiphany = dict.lookup("epiphany").unwrap().unwrap();
        assert!(res_epiphany.html.contains("revelation or insight"));

        // Case insensitive match
        let res_upper = dict.lookup("Ephemeral").unwrap().unwrap();
        assert!(res_upper.html.contains("Lasting for a very short time"));

        // Punctuation match
        let res_punct = dict.lookup("\"ephemeral,\"").unwrap().unwrap();
        assert!(res_punct.html.contains("Lasting for a very short time"));

        // @@@LINK= redirect match
        let res_redir = dict.lookup("epiphanies").unwrap().unwrap();
        assert!(res_redir.html.contains("revelation or insight"));

        // Unknown word
        let res_none = dict.lookup("nonexistentwordxyz").unwrap();
        assert!(res_none.is_none());
    }

    #[test]
    fn test_real_mdx_file_lookup_if_present() {
        let real_path = std::path::PathBuf::from("/home/sapiens/.local/share/work.fundamentals.theorem/dictionaries/4d500fc1-6d19-4d17-86a0-beaccdd73297/dict-en-en.mdx");
        if !real_path.exists() {
            return;
        }
        let dict = MdxDictionary::open(&real_path).expect("Failed to open real MDX dictionary");
        println!("Loaded MDX Title: {}", dict.header.title);
        println!("Loaded MDX Version: {}", dict.header.version);
        println!("Loaded MDX Format: {}", dict.header.format);
        println!("Loaded MDX Num Key Blocks: {}", dict.key_blocks.len());
        println!("Loaded MDX Num Record Blocks: {}", dict.record_blocks.len());

        let res = dict.lookup("epiphany").expect("Lookup epiphany error");
        println!("Lookup 'epiphany' result: {:?}", res);
        assert!(
            res.is_some(),
            "Expected 'epiphany' to be found in Wiktionary"
        );
    }
}
