use flate2::read::DeflateDecoder;
use memmap2::Mmap;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use tauri::{AppHandle, Manager};

/// StarDict `.ifo` metadata
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StarDictIfo {
    pub bookname: String,
    pub wordcount: u32,
    pub idxfilesize: u64,
    pub idxoffsetbits: u8, // 32 or 64
    pub sametypesequence: Option<String>,
    pub synwordcount: Option<u32>,
    pub author: Option<String>,
    pub description: Option<String>,
    pub version: Option<String>,
}

impl StarDictIfo {
    pub fn parse(content: &str) -> Self {
        let mut ifo = Self {
            bookname: "StarDict Dictionary".to_string(),
            idxoffsetbits: 32,
            ..Default::default()
        };

        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((key, val)) = line.split_once('=') {
                let key = key.trim();
                let val = val.trim();
                match key {
                    "bookname" => ifo.bookname = val.to_string(),
                    "wordcount" => ifo.wordcount = val.parse().unwrap_or(0),
                    "idxfilesize" => ifo.idxfilesize = val.parse().unwrap_or(0),
                    "idxoffsetbits" => ifo.idxoffsetbits = val.parse().unwrap_or(32),
                    "sametypesequence" => ifo.sametypesequence = Some(val.to_string()),
                    "synwordcount" => ifo.synwordcount = val.parse().ok(),
                    "author" => ifo.author = Some(val.to_string()),
                    "description" => ifo.description = Some(val.to_string()),
                    "version" => ifo.version = Some(val.to_string()),
                    _ => {}
                }
            }
        }

        ifo
    }
}

/// DictZip chunk header for `.dict.dz` files
#[derive(Debug, Clone)]
struct DictZipHeader {
    chunk_len: usize,
    chunk_offsets: Vec<u64>,
    chunk_sizes: Vec<u32>,
}

impl DictZipHeader {
    pub fn parse<R: Read + Seek>(reader: &mut R) -> Result<Self, String> {
        reader
            .seek(SeekFrom::Start(0))
            .map_err(|e| format!("Seek failed: {e}"))?;

        let mut header = [0u8; 10];
        reader
            .read_exact(&mut header)
            .map_err(|e| format!("Failed to read GZIP header: {e}"))?;

        if header[0] != 0x1f || header[1] != 0x8b || header[2] != 0x08 {
            return Err("Not a valid GZIP/DictZip file".to_string());
        }

        let flg = header[3];
        let has_extra = (flg & 0x04) != 0;
        let has_name = (flg & 0x08) != 0;
        let has_comment = (flg & 0x10) != 0;
        let has_crc = (flg & 0x02) != 0;

        if !has_extra {
            return Err("GZIP file lacks FEXTRA (not a DictZip)".to_string());
        }

        let mut xlen_buf = [0u8; 2];
        reader
            .read_exact(&mut xlen_buf)
            .map_err(|e| format!("Failed to read XLEN: {e}"))?;
        let xlen = u16::from_le_bytes(xlen_buf) as usize;

        let mut extra_data = vec![0u8; xlen];
        reader
            .read_exact(&mut extra_data)
            .map_err(|e| format!("Failed to read extra data: {e}"))?;

        // Locate 'RA' subfield inside extra_data
        let mut offset = 0;
        let mut dictzip_info = None;

        while offset + 4 <= extra_data.len() {
            let si1 = extra_data[offset];
            let si2 = extra_data[offset + 1];
            let sub_len =
                u16::from_le_bytes([extra_data[offset + 2], extra_data[offset + 3]]) as usize;
            offset += 4;

            if si1 == b'R' && si2 == b'A' && offset + sub_len <= extra_data.len() {
                let sub_data = &extra_data[offset..offset + sub_len];
                if sub_data.len() >= 6 {
                    let _ver = u16::from_le_bytes([sub_data[0], sub_data[1]]);
                    let chunk_len = u16::from_le_bytes([sub_data[2], sub_data[3]]) as usize;
                    let chunk_cnt = u16::from_le_bytes([sub_data[4], sub_data[5]]) as usize;

                    if sub_data.len() >= 6 + chunk_cnt * 2 {
                        let mut chunk_sizes = Vec::with_capacity(chunk_cnt);
                        for i in 0..chunk_cnt {
                            let idx = 6 + i * 2;
                            let sz = u16::from_le_bytes([sub_data[idx], sub_data[idx + 1]]) as u32;
                            chunk_sizes.push(sz);
                        }
                        dictzip_info = Some((chunk_len, chunk_sizes));
                    }
                }
                break;
            }
            offset += sub_len;
        }

        let (chunk_len, chunk_sizes) =
            dictzip_info.ok_or_else(|| "DictZip 'RA' extra field not found".to_string())?;

        // Skip remaining headers (FNAME, FCOMMENT, FHCRC)
        if has_name {
            let mut byte = [0u8; 1];
            while reader.read_exact(&mut byte).is_ok() && byte[0] != 0 {}
        }
        if has_comment {
            let mut byte = [0u8; 1];
            while reader.read_exact(&mut byte).is_ok() && byte[0] != 0 {}
        }
        if has_crc {
            let mut crc_buf = [0u8; 2];
            let _ = reader.read_exact(&mut crc_buf);
        }

        let data_start = reader
            .stream_position()
            .map_err(|e| format!("Stream position error: {e}"))?;

        // Compute cumulative chunk offsets
        let mut chunk_offsets = Vec::with_capacity(chunk_sizes.len());
        let mut cur_offset = data_start;
        for &sz in &chunk_sizes {
            chunk_offsets.push(cur_offset);
            cur_offset += sz as u64;
        }

        Ok(Self {
            chunk_len,
            chunk_offsets,
            chunk_sizes,
        })
    }

    pub fn read_uncompressed_range<R: Read + Seek>(
        &self,
        reader: &mut R,
        offset: u64,
        size: usize,
    ) -> Result<Vec<u8>, String> {
        if size == 0 {
            return Ok(Vec::new());
        }

        let start_chunk = (offset as usize) / self.chunk_len;
        let end_pos = (offset as usize) + size;
        let end_chunk = (end_pos - 1) / self.chunk_len;

        let mut decompressed = Vec::new();

        for chunk_idx in start_chunk..=end_chunk {
            if chunk_idx >= self.chunk_offsets.len() {
                return Err(format!("Chunk index out of bounds: {chunk_idx}"));
            }

            let comp_offset = self.chunk_offsets[chunk_idx];
            let comp_size = self.chunk_sizes[chunk_idx] as usize;

            reader
                .seek(SeekFrom::Start(comp_offset))
                .map_err(|e| format!("Seek to chunk failed: {e}"))?;

            let mut comp_data = vec![0u8; comp_size];
            reader
                .read_exact(&mut comp_data)
                .map_err(|e| format!("Failed to read chunk {chunk_idx}: {e}"))?;

            let mut decoder = DeflateDecoder::new(&comp_data[..]);
            let mut chunk_out = Vec::with_capacity(self.chunk_len);
            decoder
                .read_to_end(&mut chunk_out)
                .map_err(|e| format!("Deflate chunk {chunk_idx} failed: {e}"))?;

            decompressed.extend_from_slice(&chunk_out);
        }

        let slice_start = (offset as usize) - (start_chunk * self.chunk_len);
        let slice_end = slice_start + size;

        if slice_end > decompressed.len() {
            return Err(format!(
                "Decompressed range exceeds buffer: requested {slice_end}, have {}",
                decompressed.len()
            ));
        }

        Ok(decompressed[slice_start..slice_end].to_vec())
    }
}

/// A parsed StarDict dictionary loaded with zero-copy memory mapping
pub struct StarDict {
    pub ifo: StarDictIfo,
    idx_mmap: Mmap,
    entry_offsets: Vec<u32>,
    dict_file_path: PathBuf,
    dictzip_header: Option<DictZipHeader>,
    syn_mmap: Option<Mmap>,
    syn_offsets: Vec<u32>,
}

impl StarDict {
    pub fn open(dir: &Path) -> Result<Self, String> {
        let mut ifo_path = None;
        let mut idx_path = None;
        let mut uncompressed_dict_path = None;
        let mut compressed_dict_path = None;
        let mut syn_path = None;

        let entries = std::fs::read_dir(dir)
            .map_err(|e| format!("Failed to read dictionary directory {}: {e}", dir.display()))?;

        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                let ext_lower = ext.to_lowercase();
                let filename = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
                if ext_lower == "ifo" {
                    ifo_path = Some(path);
                } else if ext_lower == "idx" || ext_lower == "index" {
                    idx_path = Some(path);
                } else if ext_lower == "dict" {
                    uncompressed_dict_path = Some(path);
                } else if filename.ends_with(".dict.dz") || filename.ends_with(".dz") {
                    compressed_dict_path = Some(path);
                } else if ext_lower == "syn" {
                    syn_path = Some(path);
                }
            }
        }

        let ifo_file = ifo_path.ok_or_else(|| "Missing .ifo file in dictionary".to_string())?;
        let idx_file = idx_path.ok_or_else(|| "Missing .idx file in dictionary".to_string())?;

        let ifo_content = std::fs::read_to_string(&ifo_file)
            .map_err(|e| format!("Failed to read .ifo file: {e}"))?;
        let ifo = StarDictIfo::parse(&ifo_content);

        let idx_file_handle =
            File::open(&idx_file).map_err(|e| format!("Failed to open .idx file: {e}"))?;
        let idx_mmap = unsafe {
            Mmap::map(&idx_file_handle).map_err(|e| format!("Failed to mmap .idx file: {e}"))?
        };

        // Parse entry start offsets in the index
        let offset_bytes = if ifo.idxoffsetbits == 64 { 8 } else { 4 };
        let entry_tail_len = offset_bytes + 4; // offset + size
        let mut entry_offsets = Vec::with_capacity(ifo.wordcount as usize);

        let mut cursor = 0;
        while cursor < idx_mmap.len() {
            entry_offsets.push(cursor as u32);
            // Search for null-terminator of word
            if let Some(null_pos) = idx_mmap[cursor..].iter().position(|&b| b == 0) {
                cursor += null_pos + 1 + entry_tail_len;
            } else {
                break;
            }
        }

        // Determine dictionary data file (prefer uncompressed if already exists)
        let (dict_file, dictzip_header) = if let Some(uncomp) = uncompressed_dict_path {
            (uncomp, None)
        } else if let Some(comp) = compressed_dict_path {
            let mut dict_handle =
                File::open(&comp).map_err(|e| format!("Failed to open .dict.dz file: {e}"))?;

            // Check if it's GZIP
            let mut magic = [0u8; 2];
            let is_gzip = dict_handle.read_exact(&mut magic).is_ok() && magic == [0x1f, 0x8b];

            if is_gzip {
                match DictZipHeader::parse(&mut dict_handle) {
                    Ok(dz) => (comp, Some(dz)),
                    Err(_) => {
                        // Standard sequential GZIP (lacks RA chunk header) — decompress to .dict on disk
                        let uncomp_path = dir.join("dict.dict");
                        if !uncomp_path.exists() {
                            let gz_handle = File::open(&comp)
                                .map_err(|e| format!("Failed to reopen .dict.dz: {e}"))?;
                            let mut decoder = flate2::read::GzDecoder::new(gz_handle);
                            let mut out_file = File::create(&uncomp_path).map_err(|e| {
                                format!("Failed to create uncompressed dict file: {e}")
                            })?;
                            std::io::copy(&mut decoder, &mut out_file).map_err(|e| {
                                format!("Failed to decompress standard gzip dict: {e}")
                            })?;
                        }
                        (uncomp_path, None)
                    }
                }
            } else {
                (comp, None)
            }
        } else {
            return Err("Missing .dict or .dict.dz file in dictionary".to_string());
        };

        // Parse synonym index if present
        let mut syn_mmap_opt = None;
        let mut syn_offsets = Vec::new();
        if let Some(syn_f) = syn_path {
            if let Ok(handle) = File::open(&syn_f) {
                if let Ok(mmap) = unsafe { Mmap::map(&handle) } {
                    let mut syn_cur = 0;
                    while syn_cur < mmap.len() {
                        syn_offsets.push(syn_cur as u32);
                        if let Some(null_pos) = mmap[syn_cur..].iter().position(|&b| b == 0) {
                            syn_cur += null_pos + 1 + 4; // word\0 + original_word_idx(u32)
                        } else {
                            break;
                        }
                    }
                    syn_mmap_opt = Some(mmap);
                }
            }
        }

        Ok(Self {
            ifo,
            idx_mmap,
            entry_offsets,
            dict_file_path: dict_file,
            dictzip_header,
            syn_mmap: syn_mmap_opt,
            syn_offsets,
        })
    }

    /// Read index entry at given entry_index
    fn get_entry(&self, entry_index: usize) -> Option<(&str, u64, u32)> {
        if entry_index >= self.entry_offsets.len() {
            return None;
        }

        let start = self.entry_offsets[entry_index] as usize;
        let slice = &self.idx_mmap[start..];

        let null_pos = slice.iter().position(|&b| b == 0)?;
        let word_bytes = &slice[..null_pos];
        let word = std::str::from_utf8(word_bytes).ok()?;

        let num_start = null_pos + 1;
        let is_64 = self.ifo.idxoffsetbits == 64;

        let (offset, size) = if is_64 {
            if num_start + 12 > slice.len() {
                return None;
            }
            let mut off_buf = [0u8; 8];
            off_buf.copy_from_slice(&slice[num_start..num_start + 8]);
            let off = u64::from_be_bytes(off_buf);

            let mut sz_buf = [0u8; 4];
            sz_buf.copy_from_slice(&slice[num_start + 8..num_start + 12]);
            let sz = u32::from_be_bytes(sz_buf);
            (off, sz)
        } else {
            if num_start + 8 > slice.len() {
                return None;
            }
            let mut off_buf = [0u8; 4];
            off_buf.copy_from_slice(&slice[num_start..num_start + 4]);
            let off = u32::from_be_bytes(off_buf) as u64;

            let mut sz_buf = [0u8; 4];
            sz_buf.copy_from_slice(&slice[num_start + 4..num_start + 8]);
            let sz = u32::from_be_bytes(sz_buf);
            (off, sz)
        };

        Some((word, offset, size))
    }

    /// Binary search for a term in the index
    pub fn lookup_index(&self, term: &str) -> Option<(String, u64, u32)> {
        let norm_term = term.trim().to_lowercase();
        if norm_term.is_empty() || self.entry_offsets.is_empty() {
            return None;
        }

        let mut low = 0;
        let mut high = self.entry_offsets.len() - 1;

        while low <= high {
            let mid = low + (high - low) / 2;
            if let Some((word, offset, size)) = self.get_entry(mid) {
                let norm_word = word.trim().to_lowercase();
                match norm_term.cmp(&norm_word) {
                    std::cmp::Ordering::Equal => {
                        return Some((word.to_string(), offset, size));
                    }
                    std::cmp::Ordering::Less => {
                        if mid == 0 {
                            break;
                        }
                        high = mid - 1;
                    }
                    std::cmp::Ordering::Greater => {
                        low = mid + 1;
                    }
                }
            } else {
                break;
            }
        }

        // If not found in primary index, search synonym index
        if let (Some(syn_mmap), syn_offsets) = (&self.syn_mmap, &self.syn_offsets) {
            if !syn_offsets.is_empty() {
                let mut syn_low = 0;
                let mut syn_high = syn_offsets.len() - 1;
                while syn_low <= syn_high {
                    let syn_mid = syn_low + (syn_high - syn_low) / 2;
                    let start = syn_offsets[syn_mid] as usize;
                    let slice = &syn_mmap[start..];
                    if let Some(null_pos) = slice.iter().position(|&b| b == 0) {
                        if let Ok(syn_word) = std::str::from_utf8(&slice[..null_pos]) {
                            let norm_syn = syn_word.trim().to_lowercase();
                            match norm_term.cmp(&norm_syn) {
                                std::cmp::Ordering::Equal => {
                                    let num_start = null_pos + 1;
                                    if num_start + 4 <= slice.len() {
                                        let mut idx_buf = [0u8; 4];
                                        idx_buf.copy_from_slice(&slice[num_start..num_start + 4]);
                                        let orig_idx = u32::from_be_bytes(idx_buf) as usize;
                                        if let Some((w, off, sz)) = self.get_entry(orig_idx) {
                                            return Some((w.to_string(), off, sz));
                                        }
                                    }
                                    break;
                                }
                                std::cmp::Ordering::Less => {
                                    if syn_mid == 0 {
                                        break;
                                    }
                                    syn_high = syn_mid - 1;
                                }
                                std::cmp::Ordering::Greater => {
                                    syn_low = syn_mid + 1;
                                }
                            }
                        }
                    }
                }
            }
        }

        None
    }

    /// Read raw definition bytes for offset and size
    pub fn read_definition_bytes(&self, offset: u64, size: u32) -> Result<Vec<u8>, String> {
        let mut file = File::open(&self.dict_file_path)
            .map_err(|e| format!("Failed to open dict file: {e}"))?;

        if let Some(ref dz) = self.dictzip_header {
            dz.read_uncompressed_range(&mut file, offset, size as usize)
        } else {
            file.seek(SeekFrom::Start(offset))
                .map_err(|e| format!("Seek failed: {e}"))?;
            let mut buf = vec![0u8; size as usize];
            file.read_exact(&mut buf)
                .map_err(|e| format!("Read failed: {e}"))?;
            Ok(buf)
        }
    }

    /// Full lookup and parsed definitions
    pub fn lookup(&self, term: &str) -> Result<Option<StarDictEntryResult>, String> {
        let (matched_word, offset, size) = match self.lookup_index(term) {
            Some(v) => v,
            None => return Ok(None),
        };

        let raw_bytes = self.read_definition_bytes(offset, size)?;
        let parsed_meanings =
            parse_stardict_payload(&raw_bytes, self.ifo.sametypesequence.as_deref());

        Ok(Some(StarDictEntryResult {
            word: matched_word,
            dictionary_name: self.ifo.bookname.clone(),
            meanings: parsed_meanings,
        }))
    }
}

/// Meaning result returned from native StarDict
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeVocabularyMeaning {
    pub part_of_speech: String,
    pub definitions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub examples: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub synonyms: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub antonyms: Option<Vec<String>>,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StarDictEntryResult {
    pub word: String,
    pub dictionary_name: String,
    pub meanings: Vec<NativeVocabularyMeaning>,
}

/// Parse StarDict definition payload according to sametypesequence or leading type byte
fn parse_stardict_payload(
    bytes: &[u8],
    sametypesequence: Option<&str>,
) -> Vec<NativeVocabularyMeaning> {
    let mut text_segments = Vec::new();

    if let Some(types) = sametypesequence {
        // Types specified in ifo (e.g. "m" or "g" or "tm")
        let mut cursor = 0;
        let type_chars: Vec<char> = types.chars().collect();
        for (i, &t) in type_chars.iter().enumerate() {
            if cursor >= bytes.len() {
                break;
            }
            let is_last = i == type_chars.len() - 1;
            match t {
                'm' | 'g' | 'h' | 'x' | 't' | 'y' => {
                    let segment_bytes = if is_last {
                        &bytes[cursor..]
                    } else if let Some(null_idx) = bytes[cursor..].iter().position(|&b| b == 0) {
                        let seg = &bytes[cursor..cursor + null_idx];
                        cursor += null_idx + 1;
                        seg
                    } else {
                        &bytes[cursor..]
                    };
                    text_segments.push(String::from_utf8_lossy(segment_bytes).to_string());
                }
                _ => {
                    // Binary types, skip
                    break;
                }
            }
        }
    } else {
        // Each entry starts with a 1-byte type identifier followed by null-terminated string or data
        let mut cursor = 0;
        while cursor < bytes.len() {
            let type_byte = bytes[cursor] as char;
            cursor += 1;
            match type_byte {
                'm' | 'g' | 'h' | 'x' | 't' | 'y' => {
                    if let Some(null_idx) = bytes[cursor..].iter().position(|&b| b == 0) {
                        let seg = &bytes[cursor..cursor + null_idx];
                        cursor += null_idx + 1;
                        text_segments.push(String::from_utf8_lossy(seg).to_string());
                    } else {
                        text_segments.push(String::from_utf8_lossy(&bytes[cursor..]).to_string());
                        break;
                    }
                }
                _ => {
                    // Unknown/binary format, consume rest
                    text_segments.push(String::from_utf8_lossy(&bytes[cursor..]).to_string());
                    break;
                }
            }
        }
    }

    if text_segments.is_empty() {
        text_segments.push(String::from_utf8_lossy(bytes).to_string());
    }

    let full_raw_text = text_segments.join("\n");
    parse_wiktionary_text(&full_raw_text)
}

/// Parse Wiktionary/GCIDE text markup into structured definitions
fn parse_wiktionary_text(raw: &str) -> Vec<NativeVocabularyMeaning> {
    const KNOWN_POS: &[&str] = &[
        "Noun",
        "Verb",
        "Adjective",
        "Adverb",
        "Interjection",
        "Proper noun",
        "Preposition",
        "Conjunction",
        "Pronoun",
        "Determiner",
        "Article",
        "Numeral",
        "Particle",
        "Prefix",
        "Suffix",
        "Contraction",
        "Abbreviation",
        "Symbol",
        "Phrase",
        "Idiom",
    ];

    // 1. Strip comments and HTML/XML tags
    let mut cleaned = raw.replace("\r\n", "\n").replace('\r', "\n");
    while let Some(start) = cleaned.find("<!--") {
        if let Some(end) = cleaned[start..].find("-->") {
            cleaned.replace_range(start..=start + end + 2, " ");
        } else {
            break;
        }
    }
    while let Some(start) = cleaned.find('<') {
        if let Some(end) = cleaned[start..].find('>') {
            cleaned.replace_range(start..=start + end, " ");
        } else {
            break;
        }
    }

    // 2. Find all POS occurrences and their byte positions
    let mut markers: Vec<(usize, usize, &'static str)> = Vec::new(); // (start, end, pos_name)
    for &pos in KNOWN_POS {
        let patterns = [
            format!("({pos})"),
            format!("({})", pos.to_lowercase()),
            format!("[{pos}]"),
            format!("[{}]", pos.to_lowercase()),
            format!("\n{pos}\n"),
            format!("\n{pos}:"),
        ];

        for pat in &patterns {
            let mut search_from = 0;
            while let Some(rel_pos) = cleaned[search_from..].find(pat) {
                let start = search_from + rel_pos;
                let end = start + pat.len();
                markers.push((start, end, pos));
                search_from = end;
            }
        }
    }

    // Sort markers by starting index
    markers.sort_by_key(|&(s, _, _)| s);
    // Deduplicate overlapping markers
    markers.dedup_by(|a, b| a.0 == b.0);

    let mut pos_map: HashMap<String, Vec<String>> = HashMap::new();

    if markers.is_empty() {
        // No inline POS markers found, clean line by line
        let mut defs = Vec::new();
        for line in cleaned.lines() {
            let cl = clean_wiktionary_line(line);
            if !cl.is_empty() {
                defs.push(cl);
            }
        }
        if !defs.is_empty() {
            pos_map.insert("General".to_string(), defs);
        }
    } else {
        // Add content before first marker (if any) to General
        let first_start = markers[0].0;
        if first_start > 0 {
            let pre = &cleaned[..first_start];
            let mut pre_defs = Vec::new();
            for line in pre.lines() {
                let cl = clean_wiktionary_line(line);
                if !cl.is_empty() {
                    pre_defs.push(cl);
                }
            }
            if !pre_defs.is_empty() {
                pos_map.insert("General".to_string(), pre_defs);
            }
        }

        // Process segments between markers
        for i in 0..markers.len() {
            let (_, header_end, pos_name) = markers[i];
            let seg_end = if i + 1 < markers.len() {
                markers[i + 1].0
            } else {
                cleaned.len()
            };

            let seg_text = if header_end < seg_end {
                &cleaned[header_end..seg_end]
            } else {
                ""
            };

            // Split segment into lines or numbered sub-definitions
            for raw_line in seg_text.split('\n') {
                for sub_line in raw_line.split('#') {
                    let cl = clean_wiktionary_line(sub_line);
                    if !cl.is_empty() && !cl.eq_ignore_ascii_case(pos_name) {
                        pos_map.entry(pos_name.to_string()).or_default().push(cl);
                    }
                }
            }
        }
    }

    let mut results = Vec::new();
    for (pos, defs) in pos_map {
        let mut unique_defs = Vec::new();
        let mut seen = std::collections::HashSet::new();

        for d in defs {
            let d_clean = d.trim().to_string();
            if d_clean.len() >= 4 && seen.insert(d_clean.to_lowercase()) {
                unique_defs.push(d_clean);
            }
        }

        if !unique_defs.is_empty() {
            results.push(NativeVocabularyMeaning {
                part_of_speech: pos,
                definitions: unique_defs,
                examples: None,
                synonyms: None,
                antonyms: None,
                provider: "stardict".to_string(),
            });
        }
    }

    if results.is_empty() && !raw.trim().is_empty() {
        let fallback = clean_wiktionary_line(raw.trim());
        if !fallback.is_empty() {
            results.push(NativeVocabularyMeaning {
                part_of_speech: "General".to_string(),
                definitions: vec![fallback],
                examples: None,
                synonyms: None,
                antonyms: None,
                provider: "stardict".to_string(),
            });
        }
    }

    results
}

/// Helper to clean wiki markup from a definition line
fn clean_wiktionary_line(line: &str) -> String {
    let mut s = line.trim().to_string();
    if s.is_empty() {
        return String::new();
    }

    // Skip bullet-only or punctuation-only lines
    if s == "*" || s == "*:" || s == ":" || s == "." || s == "·" || s == "--" || s == "—" {
        return String::new();
    }

    // Remove leading numbering/bullets like "1. ", "* ", "*: "
    while s.starts_with('*') || s.starts_with(':') || s.starts_with('#') || s.starts_with(' ') {
        s = s[1..].trim().to_string();
    }

    if let Some(stripped) = s.strip_prefix(|c: char| c.is_ascii_digit()) {
        s = stripped
            .trim_start_matches(|c: char| c.is_ascii_digit() || c == '.' || c == ')' || c == ' ')
            .trim()
            .to_string();
    }

    // Process tokens to strip wiki link targets `target|display` -> `display`
    let mut words = Vec::new();
    for token in s.split_whitespace() {
        let clean_token = if let Some((_, display)) = token.split_once('|') {
            display
        } else if let Some(stripped) = token.strip_prefix("w:") {
            stripped
        } else {
            token
        };

        let sanitized: String = clean_token
            .chars()
            .filter(|&c| c != '[' && c != ']' && c != '{' && c != '}' && c != '"' && c != '\\')
            .collect();

        if !sanitized.is_empty() && sanitized != "*" && sanitized != ":" {
            words.push(sanitized);
        }
    }

    let joined = words.join(" ");
    let trimmed = joined.trim().to_string();
    if trimmed.len() < 3 || trimmed == "." || trimmed == ":" {
        String::new()
    } else {
        trimmed
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DICTIONARY REGISTRY & TAURI COMMANDS
// ─────────────────────────────────────────────────────────────────────────────

fn dict_cache() -> &'static RwLock<HashMap<String, Arc<StarDict>>> {
    static CACHE: std::sync::OnceLock<RwLock<HashMap<String, Arc<StarDict>>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn get_dict_dir(app: &AppHandle, dict_id: &str) -> PathBuf {
    let app_data = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    app_data.join("dictionaries").join(dict_id)
}

/// Ensure dictionary is loaded into memory map cache
fn get_or_load_dictionary(app: &AppHandle, dict_id: &str) -> Result<Arc<StarDict>, String> {
    {
        let cache = dict_cache().read().unwrap();
        if let Some(dict) = cache.get(dict_id) {
            return Ok(dict.clone());
        }
    }

    let dir = get_dict_dir(app, dict_id);
    if !dir.exists() {
        // Check if dictionary exists in SQLite blobs and export it to disk
        export_stardict_from_sqlite(app, dict_id, &dir)?;
    }

    let dict = Arc::new(StarDict::open(&dir)?);

    let mut cache = dict_cache().write().unwrap();
    cache.insert(dict_id.to_string(), dict.clone());

    Ok(dict)
}

/// Auto-migrate legacy SQLite blobs to disk folder
fn export_stardict_from_sqlite(
    app: &AppHandle,
    dict_id: &str,
    target_dir: &Path,
) -> Result<(), String> {
    let ifo_key = format!("theorem-stardict:{dict_id}:ifo");
    let idx_key = format!("theorem-stardict:{dict_id}:idx");
    let dict_key = format!("theorem-stardict:{dict_id}:dict");
    let syn_key = format!("theorem-stardict:{dict_id}:syn");

    let ifo_blob = crate::database::sqlite_get_blob(app.clone(), ifo_key)?
        .ok_or_else(|| format!("Dictionary {dict_id} not found in storage"))?;
    let idx_blob = crate::database::sqlite_get_blob(app.clone(), idx_key)?
        .ok_or_else(|| format!("Dictionary {dict_id} missing index"))?;
    let dict_blob = crate::database::sqlite_get_blob(app.clone(), dict_key)?
        .ok_or_else(|| format!("Dictionary {dict_id} missing data"))?;
    let syn_blob = crate::database::sqlite_get_blob(app.clone(), syn_key)
        .ok()
        .flatten();

    std::fs::create_dir_all(target_dir)
        .map_err(|e| format!("Failed to create dictionary folder: {e}"))?;

    let ifo_text = String::from_utf8_lossy(&ifo_blob);
    let ifo = StarDictIfo::parse(&ifo_text);
    let safe_name = ifo
        .bookname
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
        .collect::<String>();
    let base_name = if safe_name.is_empty() {
        "dict".to_string()
    } else {
        safe_name
    };

    std::fs::write(target_dir.join(format!("{base_name}.ifo")), ifo_blob)
        .map_err(|e| format!("Failed to write ifo: {e}"))?;
    std::fs::write(target_dir.join(format!("{base_name}.idx")), idx_blob)
        .map_err(|e| format!("Failed to write idx: {e}"))?;
    std::fs::write(target_dir.join(format!("{base_name}.dict.dz")), dict_blob)
        .map_err(|e| format!("Failed to write dict: {e}"))?;

    if let Some(syn) = syn_blob {
        let _ = std::fs::write(target_dir.join(format!("{base_name}.syn")), syn);
    }

    Ok(())
}

/// Lookup a term across multiple installed StarDict dictionaries in parallel
#[tauri::command]
pub async fn stardict_lookup(
    app: AppHandle,
    dictionary_ids: Vec<String>,
    term: String,
) -> Result<Vec<StarDictEntryResult>, String> {
    tokio::task::spawn_blocking(move || {
        let mut results = Vec::new();
        for id in dictionary_ids {
            if let Ok(dict) = get_or_load_dictionary(&app, &id) {
                if let Ok(Some(entry)) = dict.lookup(&term) {
                    results.push(entry);
                }
            }
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("Lookup task failed: {e}"))?
}

/// Delete an installed dictionary and clean up files
#[tauri::command]
pub async fn stardict_delete(app: AppHandle, dict_id: String) -> Result<(), String> {
    {
        let mut cache = dict_cache().write().unwrap();
        cache.remove(&dict_id);
    }

    let dir = get_dict_dir(&app, &dict_id);
    if dir.exists() {
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Also delete SQLite legacy entries if present
    let _ = crate::database::sqlite_delete_kv(
        app.clone(),
        format!("theorem-stardict:{dict_id}:manifest"),
    );
    let _ =
        crate::database::sqlite_delete_blob(app.clone(), format!("theorem-stardict:{dict_id}:ifo"));
    let _ =
        crate::database::sqlite_delete_blob(app.clone(), format!("theorem-stardict:{dict_id}:idx"));
    let _ = crate::database::sqlite_delete_blob(
        app.clone(),
        format!("theorem-stardict:{dict_id}:dict"),
    );
    let _ = crate::database::sqlite_delete_blob(app, format!("theorem-stardict:{dict_id}:syn"));

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ifo_parsing() {
        let ifo_text = r#"
StarDict's dict ifo file
version=2.4.2
bookname=English-Wiktionary
wordcount=150000
idxfilesize=3200000
sametypesequence=m
idxoffsetbits=32
author=Wiktionary Contributors
"#;
        let ifo = StarDictIfo::parse(ifo_text);
        assert_eq!(ifo.bookname, "English-Wiktionary");
        assert_eq!(ifo.wordcount, 150000);
        assert_eq!(ifo.idxfilesize, 3200000);
        assert_eq!(ifo.idxoffsetbits, 32);
        assert_eq!(ifo.sametypesequence, Some("m".to_string()));
        assert_eq!(ifo.version, Some("2.4.2".to_string()));
    }

    #[test]
    fn test_wiktionary_text_parsing() {
        let text = r#"
(Noun)
1. A moment of sudden revelation or insight.
2. An appearance or manifestation, especially of a divine being.

(Verb)
1. To experience a sudden revelation.
"#;
        let parsed = parse_wiktionary_text(text);
        assert_eq!(parsed.len(), 2);
        let noun = parsed.iter().find(|m| m.part_of_speech == "Noun").unwrap();
        assert_eq!(noun.definitions.len(), 2);
        assert!(noun.definitions[0].contains("moment of sudden revelation"));

        let verb = parsed.iter().find(|m| m.part_of_speech == "Verb").unwrap();
        assert_eq!(verb.definitions.len(), 1);
        assert!(verb.definitions[0].contains("sudden revelation"));
    }

    #[test]
    fn test_synthetic_stardict_lookup() {
        let temp_dir = tempfile::tempdir().unwrap();
        let dir_path = temp_dir.path();

        // 1. Write .ifo
        let ifo_content = "StarDict's dict ifo file\nbookname=TestDict\nwordcount=2\nsametypesequence=m\nidxoffsetbits=32\n";
        std::fs::write(dir_path.join("dict.ifo"), ifo_content).unwrap();

        // 2. Prepare .dict and .idx
        let def1 = "(Noun)\n1. A state of flourishing, thriving, or good fortune.\n";
        let def2 = "(Noun)\n1. A moment of sudden revelation or insight.\n";

        let mut dict_bytes = Vec::new();
        let off1 = dict_bytes.len() as u32;
        dict_bytes.extend_from_slice(def1.as_bytes());
        let len1 = (dict_bytes.len() as u32) - off1;

        let off2 = dict_bytes.len() as u32;
        dict_bytes.extend_from_slice(def2.as_bytes());
        let len2 = (dict_bytes.len() as u32) - off2;

        std::fs::write(dir_path.join("dict.dict"), &dict_bytes).unwrap();

        // 3. Write .idx (words must be sorted)
        // word 1: "bloom"
        // word 2: "epiphany"
        let mut idx_bytes = Vec::new();
        idx_bytes.extend_from_slice(b"bloom\0");
        idx_bytes.extend_from_slice(&off1.to_be_bytes());
        idx_bytes.extend_from_slice(&len1.to_be_bytes());

        idx_bytes.extend_from_slice(b"epiphany\0");
        idx_bytes.extend_from_slice(&off2.to_be_bytes());
        idx_bytes.extend_from_slice(&len2.to_be_bytes());

        std::fs::write(dir_path.join("dict.idx"), &idx_bytes).unwrap();

        // 4. Open and lookup
        let dict = StarDict::open(dir_path).unwrap();
        assert_eq!(dict.ifo.bookname, "TestDict");

        let res1 = dict.lookup("bloom").unwrap().unwrap();
        assert_eq!(res1.word, "bloom");
        assert_eq!(
            res1.meanings[0].definitions[0],
            "A state of flourishing, thriving, or good fortune."
        );

        // Case-insensitive lookup
        let res2 = dict.lookup("Epiphany").unwrap().unwrap();
        assert_eq!(res2.word, "epiphany");
        assert_eq!(
            res2.meanings[0].definitions[0],
            "A moment of sudden revelation or insight."
        );

        // Non-existent word
        assert!(dict.lookup("nonexistent").unwrap().is_none());
    }

    #[test]
    fn test_real_dictionary_if_present() {
        let base_dir =
            PathBuf::from("/home/sapiens/.local/share/work.fundamentals.theorem/dictionaries");
        if !base_dir.exists() {
            return;
        }

        let entries = match std::fs::read_dir(&base_dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                let start_open = std::time::Instant::now();
                let dict = match StarDict::open(&p) {
                    Ok(d) => d,
                    Err(err) => {
                        eprintln!("Failed to open dict {}: {err}", p.display());
                        continue;
                    }
                };
                let open_dur = start_open.elapsed();
                eprintln!(
                    "[Benchmark] Loaded real dictionary '{}' ({} words) in {:?}",
                    dict.ifo.bookname, dict.ifo.wordcount, open_dur
                );

                for word in &[
                    "agricultural",
                    "epiphany",
                    "book",
                    "read",
                    "computer",
                    "architecture",
                ] {
                    let start_lookup = std::time::Instant::now();
                    let res = dict.lookup(word).unwrap();
                    let lookup_dur = start_lookup.elapsed();
                    eprintln!(
                        "[Benchmark] Lookup for '{}': found = {}, duration = {:?}",
                        word,
                        res.is_some(),
                        lookup_dur
                    );
                    if let Some(r) = res {
                        eprintln!("  Definition for '{}': {} meanings", word, r.meanings.len());
                        for m in &r.meanings {
                            eprintln!(
                                "    [{}] {} definitions. First: {:?}",
                                m.part_of_speech,
                                m.definitions.len(),
                                m.definitions.first()
                            );
                        }
                    }
                }
            }
        }
    }
}
