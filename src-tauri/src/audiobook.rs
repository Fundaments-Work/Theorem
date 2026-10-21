//! Companion audiobook metadata parser — durations and chapter markers for
//! DRM-free `.m4b`/`.m4a` and `.mp3` files attached to books (audiobook plan,
//! section 3).
//!
//! M4B chapters live in a QuickTime *chapter text track* referenced from the
//! audio track's `udta.chap` atom; mp4ameta doesn't expose that track, so
//! [`chapters_from_moov`] walks the sample tables directly. Nothing is
//! decoded — only box metadata and small text samples are read.

use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};

#[derive(Serialize)]
pub struct AudiobookChapter {
    pub id: Box<str>,
    pub title: Box<str>,
    pub start_sec: f64,
    pub end_sec: f64,
}

#[derive(Serialize)]
pub struct AudiobookMetadata {
    pub format: Box<str>,
    /// Total duration in seconds (0 when the container doesn't report one;
    /// the frontend corrects it from the decoded audio element)
    pub duration_sec: f64,
    pub title: Option<Box<str>>,
    pub author: Option<Box<str>>,
    /// Cover art as a data URL, when the file embeds any
    pub cover_data_url: Option<Box<str>>,
    pub chapters: Box<[AudiobookChapter]>,
}

/// std-only base64 (no extra crate): covers are at most a few MB and this
/// runs once per attach.
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

// ── Minimal QuickTime box walking ────────────────────────────────────────────

/// Recursively find the first descendant box with `kind` under `moov`.
fn find_box(data: &[u8], path: &[&str]) -> Option<(usize, usize)> {
    let (kind, rest) = path.split_first()?;
    let mut pos = 0usize;
    while pos + 8 <= data.len() {
        let size = u32::from_be_bytes(data[pos..pos + 4].try_into().ok()?) as usize;
        let box_kind = &data[pos + 4..pos + 8];
        let (body_start, body_end) = match size {
            0 => (pos + 8, data.len()),
            1 => {
                if pos + 16 > data.len() {
                    break;
                }
                let large = u64::from_be_bytes(data[pos + 8..pos + 16].try_into().ok()?) as usize;
                (pos + 16, pos + large.min(data.len() - pos))
            }
            s => (pos + 8, pos + s),
        };
        if body_start > body_end || body_end > data.len() {
            break;
        }
        if box_kind == kind.as_bytes() {
            return if rest.is_empty() {
                Some((body_start, body_end))
            } else {
                find_box(&data[body_start..body_end], rest)
                    .map(|(s, e)| (body_start + s, body_start + e))
            };
        }
        pos = body_end;
    }
    None
}

/// Iterate direct child boxes of a container atom body.
fn child_boxes(data: &[u8]) -> Vec<(&[u8], usize, usize)> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos + 8 <= data.len() {
        let size = u32::from_be_bytes(data[pos..pos + 4].try_into().unwrap_or([0; 4])) as usize;
        let kind = &data[pos + 4..pos + 8];
        let (body_start, body_end) = match size {
            0 => (pos + 8, data.len()),
            1 => {
                if pos + 16 > data.len() {
                    break;
                }
                let large = u64::from_be_bytes(data[pos + 8..pos + 16].try_into().unwrap_or([0; 8]))
                    as usize;
                (pos + 16, (pos + large).min(data.len()))
            }
            s => (pos + 8, pos + s),
        };
        if body_start > body_end || body_end > data.len() {
            break;
        }
        out.push((kind, body_start, body_end));
        pos = body_end;
    }
    out
}

fn be_u32(data: &[u8], off: usize) -> Option<u32> {
    data.get(off..off + 4)
        .and_then(|b| b.try_into().ok())
        .map(u32::from_be_bytes)
}

fn be_u64(data: &[u8], off: usize) -> Option<u64> {
    data.get(off..off + 8)
        .and_then(|b| b.try_into().ok())
        .map(u64::from_be_bytes)
}

/// Extract track id from a `tkhd` body (v0 and v1 share the id position).
fn tkhd_track_id(data: &[u8]) -> Option<u32> {
    be_u32(data, 12)
}

/// Timescale + duration from an `mdhd` body.
fn mdhd_timescale_duration(data: &[u8]) -> (u32, u64) {
    let version = data.first().copied().unwrap_or(0);
    if version == 1 {
        (be_u32(data, 20).unwrap_or(0), be_u64(data, 24).unwrap_or(0))
    } else {
        (
            be_u32(data, 12).unwrap_or(0),
            u64::from(be_u32(data, 16).unwrap_or(0)),
        )
    }
}

/// One entry of the sample table: absolute file offset + size + start time.
struct SampleEntry {
    offset: u64,
    size: u64,
    start: u64,
}

/// Expand stts/stsc/stsz/stco/co64 into per-sample (offset, size, start).
fn expand_sample_table(
    stts: &[u8],
    stsc: &[u8],
    stsz: &[u8],
    stco: &[u8],
    co64: &[u8],
) -> Vec<SampleEntry> {
    // Time-to-sample: cumulative start per sample.
    let stts_entries = be_u32(stts, 4).unwrap_or(0) as usize;
    let mut starts: Vec<u64> = Vec::new();
    let mut t: u64 = 0;
    for i in 0..stts_entries {
        let base = 8 + i * 8;
        let count = be_u32(stts, base).unwrap_or(0);
        let delta = be_u32(stts, base + 4).unwrap_or(0);
        for _ in 0..count {
            starts.push(t);
            t += u64::from(delta);
        }
    }

    // Sample sizes (uniform or table).
    let uniform = be_u32(stsz, 4).unwrap_or(0);
    let sample_count = be_u32(stsz, 8).unwrap_or(0) as usize;
    let sizes: Vec<u64> = if uniform != 0 {
        vec![u64::from(uniform); sample_count]
    } else {
        (0..sample_count)
            .map(|i| u64::from(be_u32(stsz, 12 + i * 4).unwrap_or(0)))
            .collect()
    };

    // Chunk offsets.
    let is_co64 = co64.len() >= 8;
    let (offset_box, off_base) = if is_co64 { (co64, 8) } else { (stco, 8) };
    let chunk_count = be_u32(offset_box, 4).unwrap_or(0) as usize;
    let chunk_offsets: Vec<u64> = (0..chunk_count)
        .map(|i| {
            if is_co64 {
                be_u64(offset_box, off_base + i * 8).unwrap_or(0)
            } else {
                u64::from(be_u32(offset_box, off_base + i * 4).unwrap_or(0))
            }
        })
        .collect();

    // Sample-to-chunk: walk runs of (first_chunk, samples_per_chunk).
    let stsc_entries = be_u32(stsc, 4).unwrap_or(0) as usize;
    let mut samples_per_chunk: Vec<u64> = vec![0; chunk_count.max(1)];
    for i in 0..stsc_entries {
        let base = 8 + i * 12;
        let first_chunk = be_u32(stsc, base).unwrap_or(1).max(1) as usize;
        let spc = u64::from(be_u32(stsc, base + 4).unwrap_or(0));
        let last_chunk = stsc_entries
            .checked_sub(i + 1)
            .and_then(|_| be_u32(stsc, base + 12).map(|v| (v as usize).saturating_sub(1)))
            .unwrap_or(chunk_count);
        for c in first_chunk.saturating_sub(1)..last_chunk.min(chunk_count) {
            if samples_per_chunk.get(c).map(|v| *v == 0).unwrap_or(true) {
                if let Some(slot) = samples_per_chunk.get_mut(c) {
                    *slot = spc;
                }
            }
        }
    }

    // Walk chunks, assigning (offset, size, start) per sample.
    let mut out = Vec::with_capacity(sizes.len());
    let mut sample_idx = 0usize;
    for (chunk_idx, &chunk_offset) in chunk_offsets.iter().enumerate() {
        let spc = samples_per_chunk.get(chunk_idx).copied().unwrap_or(0);
        let mut cursor = chunk_offset;
        for _ in 0..spc {
            if sample_idx >= sizes.len() || sample_idx >= starts.len() {
                return out;
            }
            out.push(SampleEntry {
                offset: cursor,
                size: sizes[sample_idx],
                start: starts[sample_idx],
            });
            cursor += sizes[sample_idx];
            sample_idx += 1;
        }
    }
    out
}

/// Decode one QuickTime text sample: 2-byte big-endian length prefix, then
/// UTF-8 text (often with a BOM and/or trailing NUL).
fn chapter_title_from_sample(bytes: &[u8]) -> Option<String> {
    let mut text = if bytes.len() >= 2 {
        let len = u16::from_be_bytes([bytes[0], bytes[1]]) as usize;
        let end = (2 + len).min(bytes.len());
        &bytes[2..end]
    } else {
        return None;
    };
    text = text.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(text);
    let end = text.iter().position(|&b| b == 0).unwrap_or(text.len());
    let title = String::from_utf8_lossy(&text[..end]).trim().to_string();
    if title.is_empty() {
        None
    } else {
        Some(title)
    }
}

/// Walk the `moov` box for the chapter track referenced by `udta.chap` and
/// read its sample table. Returns chapters in file order.
fn chapters_from_moov(file: &mut std::fs::File, audio_duration_sec: f64) -> Vec<AudiobookChapter> {
    let mut chapters = Vec::new();
    let moov = match read_top_box(file, b"moov") {
        Some(m) => m,
        None => return chapters,
    };

    // Locate the audio track's `chap` reference (chapter track id).
    let mut chapter_track_id: Option<u32> = None;
    let mut text_track_fallback: Option<u32> = None;
    for (kind, s, e) in child_boxes(&moov) {
        if kind != b"trak" {
            continue;
        }
        let trak = &moov[s..e];
        let handler = find_box(trak, &["mdia", "hdlr"]).and_then(|(s, e)| {
            trak.get(s..e)
                .and_then(|b| b.get(8..12))
                .map(|h| h.to_vec())
        });
        let track_id = find_box(trak, &["tkhd"])
            .and_then(|(s, e)| trak.get(s..e))
            .and_then(tkhd_track_id);
        if handler.as_deref() == Some(b"soun".as_slice()) {
            if track_id.is_some() {
                if let Some((cs, ce)) = find_box(trak, &["udta", "chap"]) {
                    if let Some(bytes) = trak.get(cs..ce) {
                        if bytes.len() >= 4 {
                            chapter_track_id =
                                Some(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]));
                        }
                    }
                }
            }
        } else if track_id.is_some()
            && text_track_fallback.is_none()
            && matches!(handler.as_deref(), Some(h) if h == b"text" || h == b"sbtl")
        {
            text_track_fallback = track_id;
        }
    }
    let chapter_track_id = chapter_track_id.or(text_track_fallback);
    let Some(chapter_track_id) = chapter_track_id else {
        return chapters;
    };

    // Parse the chapter track's sample table.
    let mut timescale = 600u64;
    let mut tables: Option<Vec<SampleEntry>> = None;
    for (kind, s, e) in child_boxes(&moov) {
        if kind != b"trak" {
            continue;
        }
        let trak = &moov[s..e];
        let track_id = find_box(trak, &["tkhd"])
            .and_then(|(s, e)| trak.get(s..e))
            .and_then(tkhd_track_id);
        if track_id != Some(chapter_track_id) {
            continue;
        }
        if let Some((s, e)) = find_box(trak, &["mdia", "mdhd"]) {
            if let Some(mdhd) = trak.get(s..e) {
                let (ts, _dur) = mdhd_timescale_duration(mdhd);
                if ts > 0 {
                    timescale = u64::from(ts);
                }
            }
        }
        let stbl = find_box(trak, &["mdia", "minf", "stbl"])
            .and_then(|(s, e)| trak.get(s..e).map(|b| b.to_vec()));
        if let Some(stbl) = stbl {
            let grab = |name: &str| -> Vec<u8> {
                find_box(&stbl, &[name])
                    .and_then(|(s, e)| stbl.get(s..e).map(|b| b.to_vec()))
                    .unwrap_or_default()
            };
            let stts = grab("stts");
            let stsc = grab("stsc");
            let stsz = grab("stsz");
            let stco = grab("stco");
            let co64 = grab("co64");
            tables = Some(expand_sample_table(&stts, &stsc, &stsz, &stco, &co64));
        }
        break;
    }
    let Some(samples) = tables else {
        return chapters;
    };

    // Read each text sample from the file and turn it into a chapter.
    for (idx, sample) in samples.iter().enumerate() {
        if sample.size == 0 || sample.size > 4096 {
            continue;
        }
        let mut buf = vec![0u8; sample.size as usize];
        if file.seek(SeekFrom::Start(sample.offset)).is_err() || file.read_exact(&mut buf).is_err()
        {
            continue;
        }
        let title =
            chapter_title_from_sample(&buf).unwrap_or_else(|| format!("Chapter {}", idx + 1));
        let start_sec = sample.start as f64 / timescale as f64;
        // End = next chapter's start; last chapter ends with the audio.
        let end_sec = samples
            .get(idx + 1)
            .map(|next| next.start as f64 / timescale as f64)
            .filter(|end| *end > start_sec)
            .unwrap_or(audio_duration_sec.max(start_sec + 1.0));
        chapters.push(AudiobookChapter {
            id: format!("ch-{idx:03}").into_boxed_str(),
            title: title.into_boxed_str(),
            start_sec,
            end_sec,
        });
    }

    chapters
}

/// Read the body of a top-level box by kind, seeking through the file. The
/// moov box is small relative to the audio data, so buffering it is fine.
fn read_top_box(file: &mut std::fs::File, kind: &[u8; 4]) -> Option<Vec<u8>> {
    let file_len = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(0)).ok()?;
    let mut pos = 0u64;
    loop {
        if pos + 8 > file_len {
            return None;
        }
        file.seek(SeekFrom::Start(pos)).ok()?;
        let mut header = [0u8; 8];
        file.read_exact(&mut header).ok()?;
        let size = u32::from_be_bytes(header[..4].try_into().ok()?) as u64;
        let box_kind: [u8; 4] = header[4..].try_into().ok()?;
        let (body_start, body_size) = match size {
            0 => (pos + 8, file_len - pos - 8),
            1 => {
                let mut large = [0u8; 8];
                file.read_exact(&mut large).ok()?;
                let s = u64::from_be_bytes(large);
                (pos + 16, s.checked_sub(16)?)
            }
            // A size below the 8-byte header is corrupt; bail out instead of wrapping.
            s => (pos + 8, s.checked_sub(8)?),
        };
        if &box_kind == kind {
            if body_size > 64 * 1024 * 1024 {
                return None;
            }
            file.seek(SeekFrom::Start(body_start)).ok()?;
            let mut buf = vec![0u8; body_size as usize];
            file.read_exact(&mut buf).ok()?;
            return Some(buf);
        }
        pos = if size == 0 {
            file_len
        } else {
            body_start + body_size
        };
    }
}

fn parse_m4b(path: &str) -> Result<AudiobookMetadata, String> {
    let tagged = mp4ameta::Tag::read_from_path(path)
        .map_err(|e| format!("Failed to read M4B atoms: {e}"))?;

    let duration_sec = tagged.duration().as_secs_f64();
    let cover_data_url = tagged.artwork().map(|img| {
        let mime = if img.fmt.is_png() {
            "image/png"
        } else if img.fmt.is_bmp() {
            "image/bmp"
        } else {
            "image/jpeg"
        };
        format!("data:{mime};base64,{}", base64_encode(img.data))
    });

    let mut file = std::fs::File::open(path).map_err(|e| format!("Failed to open file: {e}"))?;
    let chapters = chapters_from_moov(&mut file, duration_sec);

    Ok(AudiobookMetadata {
        format: "m4b".into(),
        duration_sec,
        title: tagged.title().map(|s| s.to_string().into_boxed_str()),
        author: tagged.artist().map(|s| s.to_string().into_boxed_str()),
        cover_data_url: cover_data_url.map(|s| s.into_boxed_str()),
        chapters: chapters.into_boxed_slice(),
    })
}

fn parse_mp3(path: &str) -> Result<AudiobookMetadata, String> {
    use id3::TagLike;

    // Untagged MP3s are common; only a genuinely unreadable file is an error.
    let tag = match id3::Tag::read_from_path(path) {
        Ok(tag) => tag,
        Err(e) if matches!(e.kind, id3::ErrorKind::NoTag) => id3::Tag::new(),
        Err(e) => return Err(format!("Failed to read ID3 tags: {e}")),
    };

    // ID3v2 chapters arrive as CHAP frames (times in milliseconds).
    let chapters: Vec<AudiobookChapter> = tag
        .chapters()
        .enumerate()
        .map(|(idx, chap)| AudiobookChapter {
            id: format!("ch-{idx:03}").into_boxed_str(),
            title: chap.element_id.trim().to_string().into_boxed_str(),
            start_sec: ms_to_sec(u64::from(chap.start_time)),
            end_sec: ms_to_sec(u64::from(chap.end_time)),
        })
        .collect();

    // Prefer the real stream length (Xing/VBRI frame count, else constant-bitrate
    // estimate); fall back to the last chapter end. The player still corrects it
    // from the decoded audio element.
    let duration_sec = mp3_duration_sec(path)
        .or_else(|| chapters.last().map(|c| c.end_sec))
        .unwrap_or(0.0);

    let cover_data_url = tag.pictures().next().map(|pic| {
        format!("data:{};base64,{}", pic.mime_type, base64_encode(&pic.data)).into_boxed_str()
    });

    Ok(AudiobookMetadata {
        format: "mp3".into(),
        duration_sec,
        title: tag.title().map(|s| s.to_string().into_boxed_str()),
        author: tag.artist().map(|s| s.to_string().into_boxed_str()),
        cover_data_url,
        chapters: chapters.into_boxed_slice(),
    })
}

const MPEG1_BITRATES: [[u32; 14]; 3] = [
    [
        32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448,
    ],
    [
        32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384,
    ],
    [
        32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
    ],
];
const MPEG2_BITRATES: [[u32; 14]; 3] = [
    [
        32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256,
    ],
    [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
];

/// Duration of an MP3 stream without decoding it: the Xing/Info or VBRI frame
/// count when present, otherwise `audio bytes * 8 / bitrate` for constant bitrate.
fn mp3_duration_sec(path: &str) -> Option<f64> {
    let mut file = std::fs::File::open(path).ok()?;
    let file_len = file.metadata().ok()?.len();
    let mut head = [0u8; 10];
    file.read_exact(&mut head).ok()?;
    let mut start = 0u64;
    if &head[..3] == b"ID3" {
        let size = head[6..10]
            .iter()
            .fold(0u64, |acc, b| (acc << 7) | u64::from(b & 0x7f));
        start = 10 + size + if head[5] & 0x10 != 0 { 10 } else { 0 };
    }
    // Skip padding/garbage up to the first valid frame header (bounded scan).
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut window = vec![0u8; 64 * 1024];
    let read = file.read(&mut window).ok()?;
    let window = &window[..read];
    let (offset, header) = (0..window.len().saturating_sub(4)).find_map(|i| {
        let h = u32::from_be_bytes(window[i..i + 4].try_into().ok()?);
        Mp3Header::parse(h).map(|parsed| (i, parsed))
    })?;
    let frame_start = start + offset as u64;

    let side_info = match (header.mpeg1, header.mono) {
        (true, false) => 32,
        (true, true) | (false, false) => 17,
        (false, true) => 9,
    };
    let crc = if header.protected { 2 } else { 0 };
    let xing_at = offset + 4 + crc + side_info;
    let vbri_at = offset + 4 + 32;
    let frames = window
        .get(xing_at..xing_at + 12)
        .filter(|b| &b[..4] == b"Xing" || &b[..4] == b"Info")
        .and_then(|b| (b[7] & 1 != 0).then(|| u32::from_be_bytes([b[8], b[9], b[10], b[11]])))
        .or_else(|| {
            window
                .get(vbri_at..vbri_at + 18)
                .filter(|b| &b[..4] == b"VBRI")
                .map(|b| u32::from_be_bytes([b[14], b[15], b[16], b[17]]))
        });
    if let Some(frames) = frames.filter(|f| *f > 0) {
        return Some(
            f64::from(frames) * f64::from(header.samples_per_frame) / f64::from(header.sample_rate),
        );
    }

    // Constant bitrate: trim a trailing ID3v1 tag from the audio length.
    let mut audio_end = file_len;
    if file_len >= 128 {
        let mut tail = [0u8; 3];
        file.seek(SeekFrom::Start(file_len - 128)).ok()?;
        file.read_exact(&mut tail).ok()?;
        if &tail == b"TAG" {
            audio_end -= 128;
        }
    }
    let audio_bytes = audio_end.checked_sub(frame_start)?;
    Some(audio_bytes as f64 * 8.0 / (f64::from(header.bitrate_kbps) * 1000.0))
}

struct Mp3Header {
    mpeg1: bool,
    mono: bool,
    protected: bool,
    bitrate_kbps: u32,
    sample_rate: u32,
    samples_per_frame: u32,
}

impl Mp3Header {
    /// Validates a 4-byte MPEG audio frame header; `None` when it is not one.
    fn parse(h: u32) -> Option<Self> {
        if h >> 21 != 0x7ff {
            return None;
        }
        let version = (h >> 19) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
        let layer = (h >> 17) & 3; // 3 = I, 2 = II, 1 = III
        let bitrate_idx = ((h >> 12) & 15) as usize;
        let rate_idx = ((h >> 10) & 3) as usize;
        if version == 1 || layer == 0 || bitrate_idx == 0 || bitrate_idx == 15 || rate_idx == 3 {
            return None;
        }
        let mpeg1 = version == 3;
        let layer_row = (3 - layer) as usize;
        let table = if mpeg1 {
            &MPEG1_BITRATES
        } else {
            &MPEG2_BITRATES
        };
        let sample_rate = match (version, rate_idx) {
            (3, 0) => 44_100,
            (3, 1) => 48_000,
            (3, _) => 32_000,
            (2, 0) => 22_050,
            (2, 1) => 24_000,
            (2, _) => 16_000,
            (_, 0) => 11_025,
            (_, 1) => 12_000,
            _ => 8_000,
        };
        let samples_per_frame = match (layer, mpeg1) {
            (3, _) => 384,
            (1, false) => 576,
            _ => 1152,
        };
        Some(Self {
            mpeg1,
            mono: (h >> 6) & 3 == 3,
            protected: (h >> 16) & 1 == 0,
            bitrate_kbps: table[layer_row][bitrate_idx - 1],
            sample_rate,
            samples_per_frame,
        })
    }
}

fn ms_to_sec(ms: u64) -> f64 {
    ms as f64 / 1000.0
}

pub fn extract_audiobook_metadata(path: String) -> Result<AudiobookMetadata, String> {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".m4b") || lower.ends_with(".m4a") {
        parse_m4b(&path)
    } else if lower.ends_with(".mp3") {
        parse_mp3(&path)
    } else {
        Err("Unsupported audiobook format — use .m4b, .m4a or .mp3".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn be32(v: u32) -> [u8; 4] {
        v.to_be_bytes()
    }

    #[test]
    fn expands_uniform_chunks() {
        // 2 samples in chunk 1, 1 sample in chunk 2; delta 100; uniform size 10.
        let mut stts = Vec::new();
        stts.extend_from_slice(&be32(0)); // version/flags
        stts.extend_from_slice(&be32(1)); // entry count
        stts.extend_from_slice(&be32(3)); // sample count
        stts.extend_from_slice(&be32(100)); // delta

        let mut stsc = Vec::new();
        stsc.extend_from_slice(&be32(0));
        stsc.extend_from_slice(&be32(1)); // one run
        stsc.extend_from_slice(&be32(1)); // first chunk
        stsc.extend_from_slice(&be32(2)); // samples per chunk
        stsc.extend_from_slice(&be32(2)); // sample description id

        let mut stsz = Vec::new();
        stsz.extend_from_slice(&be32(0));
        stsz.extend_from_slice(&be32(10)); // uniform size
        stsz.extend_from_slice(&be32(3)); // sample count

        let mut stco = Vec::new();
        stco.extend_from_slice(&be32(0));
        stco.extend_from_slice(&be32(2)); // chunks
        stco.extend_from_slice(&be32(1000));
        stco.extend_from_slice(&be32(2000));

        let samples = expand_sample_table(&stts, &stsc, &stsz, &stco, &[]);
        assert_eq!(samples.len(), 3);
        assert_eq!(samples[0].offset, 1000);
        assert_eq!(samples[0].start, 0);
        assert_eq!(samples[1].offset, 1010);
        assert_eq!(samples[1].start, 100);
        assert_eq!(samples[2].offset, 2000);
        assert_eq!(samples[2].start, 200);
    }

    #[test]
    fn decodes_chapter_title_sample() {
        let mut sample = vec![0u8, 12]; // length prefix
        sample.extend_from_slice(b"A Short Rest");
        assert_eq!(
            chapter_title_from_sample(&sample).as_deref(),
            Some("A Short Rest")
        );

        let mut bom = vec![0u8, 12];
        bom.extend_from_slice("\u{feff}Chapter 1\u{0}".as_bytes());
        assert_eq!(
            chapter_title_from_sample(&bom).as_deref(),
            Some("Chapter 1")
        );

        assert_eq!(chapter_title_from_sample(&[0, 0]), None);
    }

    fn temp_mp3(name: &str, bytes: &[u8]) -> String {
        let path =
            std::env::temp_dir().join(format!("theorem-audiobook-{}-{name}", std::process::id()));
        std::fs::write(&path, bytes).unwrap();
        path.display().to_string()
    }

    // MPEG1 Layer III, 128 kbps, 44.1 kHz, stereo.
    const CBR_HEADER: [u8; 4] = [0xff, 0xfb, 0x90, 0x00];

    #[test]
    fn cbr_mp3_duration_comes_from_bitrate() {
        let mut bytes = CBR_HEADER.to_vec();
        bytes.resize(160_000, 0); // 128 kbps = 16 000 B/s
        let path = temp_mp3("cbr.mp3", &bytes);
        let secs = mp3_duration_sec(&path).unwrap();
        assert!((secs - 10.0).abs() < 0.01, "got {secs}");
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn vbr_mp3_duration_uses_xing_frame_count() {
        let mut bytes = CBR_HEADER.to_vec();
        bytes.resize(36, 0); // 4 header + 32 side info (MPEG1 stereo)
        bytes.extend_from_slice(b"Xing");
        bytes.extend_from_slice(&1u32.to_be_bytes()); // frames flag
        bytes.extend_from_slice(&1000u32.to_be_bytes());
        bytes.resize(4096, 0);
        let path = temp_mp3("vbr.mp3", &bytes);
        let secs = mp3_duration_sec(&path).unwrap();
        assert!(
            (secs - 1000.0 * 1152.0 / 44_100.0).abs() < 0.001,
            "got {secs}"
        );
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn id3v2_prefix_and_id3v1_suffix_are_not_counted_as_audio() {
        let mut bytes = b"ID3\x03\x00\x00".to_vec();
        bytes.extend_from_slice(&[0, 0, 0, 20]); // syncsafe size 20
        bytes.resize(30, 0);
        bytes.extend_from_slice(&CBR_HEADER);
        bytes.resize(30 + 160_000, 0);
        bytes.extend_from_slice(b"TAG");
        bytes.resize(30 + 160_000 + 128, 0);
        let path = temp_mp3("tagged.mp3", &bytes);
        let secs = mp3_duration_sec(&path).unwrap();
        assert!((secs - 10.0).abs() < 0.01, "got {secs}");
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn untagged_mp3_attaches_instead_of_failing() {
        let mut bytes = CBR_HEADER.to_vec();
        bytes.resize(32_000, 0);
        let path = temp_mp3("untagged.mp3", &bytes);
        let meta = parse_mp3(&path).expect("an MP3 without ID3 is valid");
        assert!(meta.title.is_none());
        assert!(meta.chapters.is_empty());
        assert!((meta.duration_sec - 2.0).abs() < 0.01);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn non_audio_and_empty_files_have_no_duration() {
        let path = temp_mp3("junk.mp3", &[0u8; 2048]);
        assert!(mp3_duration_sec(&path).is_none());
        let empty = temp_mp3("empty.mp3", &[]);
        assert!(mp3_duration_sec(&empty).is_none());
        std::fs::remove_file(path).ok();
        std::fs::remove_file(empty).ok();
    }

    #[test]
    fn rejects_reserved_mpeg_headers() {
        assert!(Mp3Header::parse(0xfffb_9000).is_some());
        assert!(Mp3Header::parse(0xffeb_9000).is_none()); // reserved version
        assert!(Mp3Header::parse(0xfff9_9000).is_none()); // reserved layer
        assert!(Mp3Header::parse(0xfffb_f000).is_none()); // bad bitrate
        assert!(Mp3Header::parse(0xfffb_9c00).is_none()); // bad sample rate
    }

    #[test]
    fn corrupt_top_box_size_does_not_wrap() {
        let mut bytes = vec![0, 0, 0, 4]; // size below the 8-byte header
        bytes.extend_from_slice(b"moov");
        bytes.resize(64, 0);
        let path = temp_mp3("corrupt.m4b", &bytes);
        let mut file = std::fs::File::open(&path).unwrap();
        assert!(read_top_box(&mut file, b"moov").is_none());
        std::fs::remove_file(path).ok();
    }
}
