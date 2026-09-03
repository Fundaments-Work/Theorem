//! Save-as-Audiobook generation (desktop): batch-synthesizes section texts
//! through the Supertonic engine and encodes the whole book into a single
//! Ogg Opus file with chapter marks (audiobook plan, section 0.4).
//!
//! The Opus encoder runs at 48kHz — Supertonic outputs 44.1kHz, so samples
//! are resampled (linear) before encoding. Generation runs as a detached task
//! emitting `audiobook-gen-progress` / `audiobook-gen-done` events, cancellable
//! per book via [`generate_audiobook_cancel`].

pub mod engine {
    use crate::supertonic::desktop;
    use audiopus::{Application, Bitrate, Channels, SampleRate};
    use serde::{Deserialize, Serialize};
    use std::collections::HashMap;
    use std::io::Write;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Arc, LazyLock, Mutex};
    use tauri::{AppHandle, Emitter, Manager};

    /// Opus only accepts 8/12/16/24/48kHz input.
    const TARGET_SAMPLE_RATE: u32 = 48_000;
    /// 20ms Opus frames at 48kHz.
    const FRAME_SAMPLES: usize = 960;
    /// Mono speech at 36kbps: ~16MB per finished hour.
    const BITRATE_BPS: u32 = 36_000;
    /// Silence joined between sentence chunks, in source samples.
    const CHUNK_GAP_SRC_SAMPLES: usize = (0.3 * 44_100.0) as usize;
    const PROGRESS_EVENT: &str = "audiobook-gen-progress";
    const DONE_EVENT: &str = "audiobook-gen-done";

    #[derive(Deserialize)]
    pub struct GenSection {
        pub id: String,
        pub title: String,
        pub text: String,
    }

    #[derive(Serialize, Clone)]
    pub struct GenChapter {
        pub id: String,
        pub title: String,
        pub start_sec: f64,
        pub end_sec: f64,
    }

    #[derive(Serialize, Clone)]
    pub struct GenDonePayload {
        pub book_id: String,
        pub path: Option<String>,
        pub duration_sec: f64,
        pub chapters: Vec<GenChapter>,
        pub error: Option<String>,
    }

    static CANCEL_FLAGS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    static SERIAL_COUNTER: AtomicU32 = AtomicU32::new(1);

    // ── Ogg page muxer (hand-rolled: no ogg crate, packets ≤ 1275B) ─────────────

    fn crc32_ogg(data: &[u8]) -> u32 {
        let mut table = [0u32; 256];
        for (i, slot) in table.iter_mut().enumerate() {
            let mut crc = i as u32;
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    0x04c1_1db7 ^ (crc >> 1)
                } else {
                    crc >> 1
                };
            }
            *slot = crc;
        }
        let mut crc = 0u32;
        for &b in data {
            crc = (crc << 8) ^ table[(((crc >> 24) as u8) ^ b) as usize];
        }
        crc
    }

    /// Appends whole packets into Ogg pages (page boundary only between packets,
    /// which is valid since Opus packets never exceed 1275 bytes).
    struct OggWriter<W: Write> {
        out: W,
        serial: u32,
        seq: u32,
        /// Segment table + payloads accumulated for the current page.
        segments: Vec<u8>,
        payload: Vec<u8>,
        packet_count: u32,
        /// Granule of the last packet added to the current page.
        granule: u64,
        wrote_bos: bool,
    }

    impl<W: Write> OggWriter<W> {
        fn new(out: W, serial: u32) -> Self {
            Self {
                out,
                serial,
                seq: 0,
                segments: Vec::new(),
                payload: Vec::new(),
                packet_count: 0,
                granule: 0,
                wrote_bos: false,
            }
        }

        fn add_packet(&mut self, data: &[u8], granule: u64) {
            let full_segments = data.len() / 255;
            for _ in 0..full_segments {
                self.segments.push(255);
            }
            self.segments.push((data.len() % 255) as u8);
            self.payload.extend_from_slice(data);
            self.packet_count += 1;
            self.granule = granule;
        }

        fn flush_page(&mut self, eos: bool) -> std::io::Result<()> {
            if self.packet_count == 0 {
                return Ok(());
            }
            let mut header_type = 0u8;
            if !self.wrote_bos {
                header_type |= 0x02;
                self.wrote_bos = true;
            }
            if eos {
                header_type |= 0x04;
            }

            let mut page = Vec::with_capacity(27 + self.segments.len() + self.payload.len());
            page.extend_from_slice(b"OggS");
            page.push(0);
            page.push(header_type);
            page.extend_from_slice(&self.granule.to_le_bytes());
            page.extend_from_slice(&self.serial.to_le_bytes());
            page.extend_from_slice(&self.seq.to_le_bytes());
            page.extend_from_slice(&[0, 0, 0, 0]);
            page.push(self.segments.len() as u8);
            page.extend_from_slice(&self.segments);
            page.extend_from_slice(&self.payload);
            let crc = crc32_ogg(&page);
            page[22..26].copy_from_slice(&crc.to_le_bytes());
            self.out.write_all(&page)?;

            self.seq += 1;
            self.segments.clear();
            self.payload.clear();
            self.packet_count = 0;
            Ok(())
        }

        /// Page is flushed every ~1s of audio (48 packets) or on demand.
        fn maybe_flush(&mut self) -> std::io::Result<()> {
            if self.packet_count >= 48 {
                self.flush_page(false)?;
            }
            Ok(())
        }
    }

    // ── Audio helpers ────────────────────────────────────────────────────────────

    /// Linear 44.1k→48k resampler — adequate for speech at this ratio.
    fn resample_to_48k(input: &[f32], from: u32) -> Vec<f32> {
        if input.is_empty() || from == TARGET_SAMPLE_RATE {
            return input.to_vec();
        }
        let ratio = TARGET_SAMPLE_RATE as f64 / from as f64;
        let out_len = ((input.len() as f64) * ratio).floor() as usize;
        let mut out = Vec::with_capacity(out_len);
        for i in 0..out_len {
            let pos = i as f64 / ratio;
            let i0 = (pos as usize).min(input.len() - 1);
            let i1 = (i0 + 1).min(input.len() - 1);
            let frac = (pos - i0 as f64) as f32;
            out.push(input[i0] * (1.0 - frac) + input[i1] * frac);
        }
        out
    }

    /// Read a canonical 44-byte-header 16-bit mono WAV back to normalized f32.
    fn read_wav_mono(path: &std::path::Path) -> Result<(Vec<f32>, u32), String> {
        let bytes = std::fs::read(path).map_err(|e| format!("Failed to read WAV: {e}"))?;
        if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
            return Err("Unexpected WAV layout".to_string());
        }
        let mut pos = 12usize;
        let (mut sample_rate, mut bits) = (0u32, 0u16);
        let mut data: Option<&[u8]> = None;
        while pos + 8 <= bytes.len() {
            let id = &bytes[pos..pos + 4];
            let size =
                u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap_or([0; 4])) as usize;
            let end = (pos + 8 + size).min(bytes.len());
            match id {
                b"fmt " => {
                    sample_rate =
                        u32::from_le_bytes(bytes[pos + 12..pos + 16].try_into().unwrap_or([0; 4]));
                    bits =
                        u16::from_le_bytes(bytes[pos + 22..pos + 24].try_into().unwrap_or([0; 2]));
                }
                b"data" => data = Some(&bytes[pos + 8..end]),
                _ => {}
            }
            pos += 8 + size + (size & 1);
        }
        let data = data.ok_or("WAV has no data chunk")?;
        if bits != 16 {
            return Err(format!("Unsupported WAV bit depth: {bits}"));
        }
        let samples = data
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
            .collect();
        Ok((samples, sample_rate))
    }

    // ── Generation task ──────────────────────────────────────────────────────────

    async fn run_generation(
        app: &AppHandle,
        book_id: &str,
        sections: Vec<GenSection>,
        voice: &str,
        speed: f32,
        lang: &str,
        cancel: Arc<AtomicBool>,
    ) -> Result<GenDonePayload, String> {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("No app data dir: {e}"))?
            .join("audiobooks");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let final_path = dir.join(format!("{}.ogg", book_id));
        let part_path = dir.join(format!("{}.ogg.part", book_id));

        let serial = SERIAL_COUNTER.fetch_add(1, Ordering::SeqCst);
        let file = std::fs::File::create(&part_path)
            .map_err(|e| format!("Failed to create output: {e}"))?;
        let mut ogg = OggWriter::new(std::io::BufWriter::new(file), serial);

        // OpusHead + OpusTags identification headers.
        let mut opus_head = Vec::with_capacity(19);
        opus_head.extend_from_slice(b"OpusHead");
        opus_head.extend_from_slice(&[1, 1]);
        opus_head.extend_from_slice(&0u16.to_le_bytes());
        opus_head.extend_from_slice(&TARGET_SAMPLE_RATE.to_le_bytes());
        opus_head.extend_from_slice(&0i16.to_le_bytes());
        opus_head.push(0);
        ogg.add_packet(&opus_head, 0);
        ogg.flush_page(false).map_err(|e| e.to_string())?;

        let mut opus_tags = Vec::new();
        opus_tags.extend_from_slice(b"OpusTags");
        opus_tags.extend_from_slice(&4u32.to_le_bytes());
        opus_tags.extend_from_slice(b"Theo");
        ogg.add_packet(&opus_tags, 0);
        ogg.flush_page(false).map_err(|e| e.to_string())?;

        let mut encoder =
            audiopus::coder::Encoder::new(SampleRate::Hz48000, Channels::Mono, Application::Audio)
                .map_err(|e| format!("Opus encoder init failed: {e}"))?;
        encoder
            .set_bitrate(Bitrate::BitsPerSecond(BITRATE_BPS as i32))
            .map_err(|e| format!("Opus bitrate failed: {e}"))?;

        let mut chapters: Vec<GenChapter> = Vec::with_capacity(sections.len());
        let mut granule: u64 = 0;
        let total = sections.len();
        let mut packet_buf = vec![0u8; 4000];

        for (index, section) in sections.into_iter().enumerate() {
            if cancel.load(Ordering::SeqCst) {
                drop(ogg);
                let _ = std::fs::remove_file(&part_path);
                return Err("cancelled".to_string());
            }

            let chunk_start_sec = granule as f64 / TARGET_SAMPLE_RATE as f64;
            for (chunk_idx, chunk) in desktop::chunk_text(&section.text, 300)
                .into_iter()
                .enumerate()
            {
                if chunk_idx > 0 {
                    // Sentence gap (source-rate silence, resampled below).
                    let gap = resample_to_48k(&vec![0.0f32; CHUNK_GAP_SRC_SAMPLES], 44_100);
                    push_pcm(&mut ogg, &encoder, &gap, &mut granule, &mut packet_buf)?;
                }
                let result = desktop::tts_synthesize_impl(
                    app.clone(),
                    chunk,
                    voice.to_string(),
                    speed,
                    lang.to_string(),
                )
                .await
                .map_err(|e| format!("Synthesis failed: {e}"))?;
                let (samples, wav_rate) = read_wav_mono(std::path::Path::new(&result.path))
                    .map_err(|e| format!("Failed to read synthesized chunk: {e}"))?;
                let samples = if wav_rate != TARGET_SAMPLE_RATE {
                    resample_to_48k(&samples, wav_rate)
                } else {
                    samples
                };
                push_pcm(&mut ogg, &encoder, &samples, &mut granule, &mut packet_buf)?;
            }

            let end_sec = granule as f64 / TARGET_SAMPLE_RATE as f64;
            chapters.push(GenChapter {
                id: section.id,
                title: section.title,
                start_sec: chunk_start_sec,
                end_sec,
            });
            let _ = app.emit(
                PROGRESS_EVENT,
                serde_json::json!({ "bookId": book_id, "current": index + 1, "total": total }),
            );
        }

        ogg.flush_page(true).map_err(|e| e.to_string())?;
        drop(ogg);
        std::fs::rename(&part_path, &final_path).map_err(|e| format!("Failed to finalize: {e}"))?;

        Ok(GenDonePayload {
            book_id: book_id.to_string(),
            path: Some(final_path.display().to_string()),
            duration_sec: granule as f64 / TARGET_SAMPLE_RATE as f64,
            chapters,
            error: None,
        })
    }

    /// Encode one f32 buffer (already at 48kHz) into 20ms Opus frames.
    fn push_pcm<W: Write>(
        ogg: &mut OggWriter<W>,
        encoder: &audiopus::coder::Encoder,
        pcm: &[f32],
        granule: &mut u64,
        packet_buf: &mut [u8],
    ) -> Result<(), String> {
        let mut pos = 0usize;
        while pos < pcm.len() {
            let frame_end = (pos + FRAME_SAMPLES).min(pcm.len());
            let frame = &pcm[pos..frame_end];
            let written = if frame.len() == FRAME_SAMPLES {
                encoder
                    .encode_float(frame, packet_buf)
                    .map_err(|e| format!("Opus encode failed: {e}"))?
            } else {
                // Tail frame: zero-pad to a full frame; granule keeps real time.
                let mut padded = vec![0.0f32; FRAME_SAMPLES];
                padded[..frame.len()].copy_from_slice(frame);
                encoder
                    .encode_float(&padded, packet_buf)
                    .map_err(|e| format!("Opus encode failed: {e}"))?
            };
            *granule += frame.len() as u64;
            ogg.add_packet(&packet_buf[..written], *granule);
            ogg.maybe_flush().map_err(|e| e.to_string())?;
            pos = frame_end;
        }
        Ok(())
    }
    pub async fn generate_audiobook_impl(
        app: AppHandle,
        book_id: String,
        sections: Vec<GenSection>,
        voice: String,
        speed: f32,
        lang: String,
    ) -> Result<(), String> {
        if sections.is_empty() {
            return Err("No sections to narrate".to_string());
        }
        let flag = Arc::new(AtomicBool::new(false));
        {
            let mut flags = CANCEL_FLAGS.lock().map_err(|e| e.to_string())?;
            if flags.contains_key(&book_id) {
                return Err("Audiobook generation already running for this book".to_string());
            }
            flags.insert(book_id.clone(), flag.clone());
        }

        let task_book_id = book_id.clone();
        tokio::spawn(async move {
            let result =
                run_generation(&app, &task_book_id, sections, &voice, speed, &lang, flag).await;
            CANCEL_FLAGS
                .lock()
                .map(|mut flags| flags.remove(&task_book_id))
                .ok();
            let payload = match result {
                Ok(done) => done,
                Err(e) => GenDonePayload {
                    book_id: task_book_id.clone(),
                    path: None,
                    duration_sec: 0.0,
                    chapters: Vec::new(),
                    error: Some(e),
                },
            };
            let _ = app.emit(DONE_EVENT, payload);
        });
        Ok(())
    }

    pub fn generate_audiobook_cancel_impl(book_id: String) -> Result<(), String> {
        if let Ok(flags) = CANCEL_FLAGS.lock() {
            if let Some(flag) = flags.get(&book_id) {
                flag.store(true, Ordering::SeqCst);
            }
        }
        Ok(())
    }
    #[cfg(all(test, not(target_os = "android")))]
    mod tests {
        use super::*;

        #[test]
        fn writes_parseable_opus_pages() {
            let mut ogg = OggWriter::new(Vec::new(), 0x12345678);
            ogg.add_packet(b"OpusHead-xxxxxxxxxxxxxxxxxxxx", 0);
            ogg.flush_page(false).unwrap();
            let pcm = vec![0.1f32; FRAME_SAMPLES * 2];
            let mut encoder = audiopus::coder::Encoder::new(
                SampleRate::Hz48000,
                Channels::Mono,
                Application::Audio,
            )
            .unwrap();
            let mut buf = vec![0u8; 4000];
            let mut granule = 0u64;
            push_pcm(&mut ogg, &encoder, &pcm, &mut granule, &mut buf).unwrap();
            ogg.flush_page(true).unwrap();

            let OggWriter { out, .. } = ogg;
            // First page: BOS flag set, OpusHead packet, correct serial.
            assert_eq!(&out[0..4], b"OggS");
            assert_eq!(out[5] & 0x02, 0x02);
            assert_eq!(&out[14..18], &0x12345678u32.to_le_bytes());
            // Last page: EOS flag set near the end of the stream.
            let last = out.len() - 27;
            let eos_page = out[..last]
                .windows(4)
                .rev()
                .find(|w| *w == b"OggS")
                .unwrap();
            let eos_off = eos_page.as_ptr() as usize - out.as_ptr() as usize;
            assert_eq!(out[eos_off + 5] & 0x04, 0x04);
            // Granule of the last page reflects the encoded sample count.
            let granule_bytes: [u8; 8] = out[eos_off + 6..eos_off + 14].try_into().unwrap();
            assert_eq!(u64::from_le_bytes(granule_bytes), granule);
        }
    }
}

// ── Tauri commands (real on desktop, stubs on Android) ──────────────────────

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn generate_audiobook(
    app: tauri::AppHandle,
    book_id: String,
    sections: Vec<engine::GenSection>,
    voice: String,
    speed: f32,
    lang: String,
) -> Result<(), String> {
    engine::generate_audiobook_impl(app, book_id, sections, voice, speed, lang).await
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn generate_audiobook_cancel(book_id: String) -> Result<(), String> {
    engine::generate_audiobook_cancel_impl(book_id)
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn generate_audiobook(
    _app: tauri::AppHandle,
    _book_id: String,
    _sections: Vec<serde_json::Value>,
    _voice: String,
    _speed: f32,
    _lang: String,
) -> Result<(), String> {
    Err("Audiobook generation is desktop-only for now".to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn generate_audiobook_cancel(_book_id: String) -> Result<(), String> {
    Err("Audiobook generation is desktop-only for now".to_string())
}
