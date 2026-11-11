//! Streaming Ogg Opus audiobook player for desktop targets where the webview's
//! `<audio>` element cannot decode `.ogg` containers (e.g., pre-Sequoia macOS WebKit).
//!
//! Uses `ogg` + statically linked `audiopus` + `rodio` without buffering the whole
//! decoded PCM stream into memory.

use crate::error::AppError;
use crate::linux_audiobook::PlaybackSnapshot;

#[cfg(not(target_os = "android"))]
mod imp {
    use super::{AppError, PlaybackSnapshot};
    use crate::error::ErrorKind;
    use audiopus::coder::Decoder;
    use audiopus::{Channels, SampleRate};
    use ogg::reading::PacketReader;
    use rodio::{
        ChannelCount, DeviceSinkBuilder, MixerDeviceSink, Player, SampleRate as RodioRate, Source,
    };
    use std::collections::HashMap;
    use std::fs::File;
    use std::io::{BufReader, Read, Seek, SeekFrom};
    use std::num::{NonZeroU16, NonZeroU32};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
    use std::sync::{Arc, LazyLock, Mutex};
    use std::time::Duration;

    const OPUS_RATE: u32 = 48_000;
    const MAX_FRAME_SAMPLES_PER_CH: usize = 5_760; // 120ms max Opus packet at 48kHz
    const MAX_SESSIONS: usize = 32;

    #[derive(Debug, Clone, Copy)]
    pub(crate) struct OpusHeaderInfo {
        pub channels: u16,
        pub pre_skip: u64,
        pub serial: u32,
        pub duration_sec: f64,
    }

    pub(crate) fn parse_opus_stream_info(path: &Path) -> Result<OpusHeaderInfo, AppError> {
        let mut file = File::open(path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AppError::not_found(format!("Cannot open audiobook: {e}"))
            } else {
                AppError::io(format!("Cannot open audiobook: {e}"))
            }
        })?;
        if !path.is_file() {
            return Err(AppError::invalid_input("The audiobook is not a file"));
        }
        let file_len = file
            .metadata()
            .map_err(|e| AppError::io(format!("Cannot stat audiobook: {e}")))?
            .len();

        let mut reader =
            PacketReader::new(BufReader::new(file.try_clone().map_err(|e| {
                AppError::io(format!("Cannot clone audiobook handle: {e}"))
            })?));
        let head = reader
            .read_packet_expected()
            .map_err(|e| AppError::new(ErrorKind::Corrupt, format!("Invalid Ogg stream: {e}")))?;
        if head.data.len() < 19 || !head.data.starts_with(b"OpusHead") {
            return Err(AppError::new(
                ErrorKind::Corrupt,
                "Audiobook is missing an OpusHead header",
            ));
        }
        let ch = head.data[9];
        if ch == 0 || ch > 2 {
            return Err(AppError::invalid_input(format!(
                "Unsupported Opus channel count: {ch}"
            )));
        }
        let pre_skip = u16::from_le_bytes([head.data[10], head.data[11]]) as u64;
        let serial = head.stream_serial();

        // Scan the tail of the file for the final OggS page matching `serial` to read exact granule duration.
        let tail_start = file_len.saturating_sub(65_536);
        file.seek(SeekFrom::Start(tail_start))
            .map_err(|e| AppError::io(format!("Cannot seek audiobook tail: {e}")))?;
        let mut tail = Vec::new();
        file.read_to_end(&mut tail)
            .map_err(|e| AppError::io(format!("Cannot read audiobook tail: {e}")))?;

        let mut max_granule = 0u64;
        let mut i = 0usize;
        while i + 27 <= tail.len() {
            if &tail[i..i + 4] == b"OggS" {
                let page_serial =
                    u32::from_le_bytes([tail[i + 14], tail[i + 15], tail[i + 16], tail[i + 17]]);
                let granule = u64::from_le_bytes([
                    tail[i + 6],
                    tail[i + 7],
                    tail[i + 8],
                    tail[i + 9],
                    tail[i + 10],
                    tail[i + 11],
                    tail[i + 12],
                    tail[i + 13],
                ]);
                if page_serial == serial && granule != u64::MAX {
                    max_granule = max_granule.max(granule);
                }
            }
            i += 1;
        }
        let duration_samples = max_granule.saturating_sub(pre_skip);
        let duration_sec = duration_samples as f64 / f64::from(OPUS_RATE);
        if duration_sec <= 0.0 {
            return Err(AppError::new(
                ErrorKind::Corrupt,
                "Audiobook has zero duration",
            ));
        }

        Ok(OpusHeaderInfo {
            channels: u16::from(ch),
            pre_skip,
            serial,
            duration_sec,
        })
    }

    pub(crate) struct OggOpusSource {
        reader: PacketReader<BufReader<File>>,
        decoder: Decoder,
        channels: u16,
        pre_skip_rem: u64,
        pcm_buf: Vec<f32>,
        current_frame: Vec<f32>,
        cursor: usize,
        played_frames: Arc<AtomicU64>,
        finished: Arc<AtomicBool>,
        total_duration_sec: f64,
        exhausted: bool,
    }

    impl OggOpusSource {
        pub(crate) fn open(
            path: &Path,
            info: OpusHeaderInfo,
            start_sec: f64,
            played_frames: Arc<AtomicU64>,
            finished: Arc<AtomicBool>,
        ) -> Result<Self, AppError> {
            let file = File::open(path).map_err(|e| AppError::io(format!("Cannot open: {e}")))?;
            let mut reader = PacketReader::new(BufReader::new(file));
            // Consume OpusHead + OpusTags cleanly before seeking or decoding.
            let _head = reader
                .read_packet_expected()
                .map_err(|e| AppError::new(ErrorKind::Corrupt, format!("Missing OpusHead: {e}")))?;
            let _tags = reader
                .read_packet_expected()
                .map_err(|e| AppError::new(ErrorKind::Corrupt, format!("Missing OpusTags: {e}")))?;

            let start_clamped = start_sec.clamp(0.0, info.duration_sec);
            let duration_samples = (info.duration_sec * f64::from(OPUS_RATE)).round() as u64;
            let target_audio_frames = (start_clamped * f64::from(OPUS_RATE)).round() as u64;
            let mut pre_skip_rem = info.pre_skip;
            let mut exhausted = false;
            if target_audio_frames >= duration_samples {
                exhausted = true;
                finished.store(true, Ordering::Release);
            } else if target_audio_frames > 0 {
                let goal_granule = info.pre_skip.saturating_add(target_audio_frames);
                if !reader
                    .seek_absgp(Some(info.serial), goal_granule)
                    .map_err(|e| AppError::io(format!("Seek failed: {e}")))?
                {
                    exhausted = true;
                    finished.store(true, Ordering::Release);
                }
                pre_skip_rem = 0;
            }
            played_frames.store(target_audio_frames, Ordering::Relaxed);
            if !exhausted {
                finished.store(false, Ordering::Release);
            }

            let opus_channels = if info.channels == 2 {
                Channels::Stereo
            } else {
                Channels::Mono
            };
            let decoder = Decoder::new(SampleRate::Hz48000, opus_channels)
                .map_err(|e| AppError::internal(format!("Opus decoder init failed: {e}")))?;

            Ok(Self {
                reader,
                decoder,
                channels: info.channels,
                pre_skip_rem,
                pcm_buf: vec![0.0f32; MAX_FRAME_SAMPLES_PER_CH * usize::from(info.channels)],
                current_frame: Vec::new(),
                cursor: 0,
                played_frames,
                finished,
                total_duration_sec: info.duration_sec,
                exhausted,
            })
        }

        fn decode_next_packet(&mut self) -> bool {
            while let Ok(Some(pkt)) = self.reader.read_packet() {
                if pkt.data.starts_with(b"OpusHead") || pkt.data.starts_with(b"OpusTags") {
                    continue;
                }
                match self
                    .decoder
                    .decode_float(Some(&pkt.data), &mut self.pcm_buf[..], false)
                {
                    Ok(samples_per_ch) if samples_per_ch > 0 => {
                        let skip = (self.pre_skip_rem as usize).min(samples_per_ch);
                        self.pre_skip_rem = self.pre_skip_rem.saturating_sub(skip as u64);
                        let ch = usize::from(self.channels);
                        let start_idx = skip * ch;
                        let end_idx = samples_per_ch * ch;
                        if start_idx >= end_idx {
                            continue;
                        }
                        self.current_frame.clear();
                        self.current_frame
                            .extend_from_slice(&self.pcm_buf[start_idx..end_idx]);
                        self.cursor = 0;
                        return true;
                    }
                    _ => continue,
                }
            }
            self.exhausted = true;
            self.finished.store(true, Ordering::Release);
            false
        }
    }

    impl Iterator for OggOpusSource {
        type Item = f32;

        fn next(&mut self) -> Option<Self::Item> {
            if self.exhausted {
                return None;
            }
            while self.cursor >= self.current_frame.len() {
                if !self.decode_next_packet() {
                    return None;
                }
            }
            let sample = self.current_frame[self.cursor];
            self.cursor += 1;
            if self.cursor.is_multiple_of(usize::from(self.channels)) {
                self.played_frames.fetch_add(1, Ordering::Relaxed);
            }
            Some(sample)
        }
    }

    impl Source for OggOpusSource {
        fn current_span_len(&self) -> Option<usize> {
            if self.exhausted {
                Some(0)
            } else {
                None
            }
        }

        fn channels(&self) -> ChannelCount {
            NonZeroU16::new(self.channels).expect("Opus channels checked >= 1")
        }

        fn sample_rate(&self) -> RodioRate {
            NonZeroU32::new(OPUS_RATE).expect("48kHz non-zero")
        }

        fn total_duration(&self) -> Option<Duration> {
            Some(Duration::from_secs_f64(self.total_duration_sec))
        }
    }

    struct OpusAudiobookSession {
        _sink: MixerDeviceSink,
        player: Player,
        path: PathBuf,
        info: OpusHeaderInfo,
        played_frames: Arc<AtomicU64>,
        finished: Arc<AtomicBool>,
        playing: bool,
        rate: f64,
    }

    impl OpusAudiobookSession {
        fn open(path: &Path) -> Result<Self, AppError> {
            let info = parse_opus_stream_info(path)?;
            let sink = DeviceSinkBuilder::open_default_sink()
                .map_err(|e| AppError::internal(format!("No audio output device: {e}")))?;
            let player = Player::connect_new(sink.mixer());
            player.pause();
            let played_frames = Arc::new(AtomicU64::new(0));
            let finished = Arc::new(AtomicBool::new(false));
            let source =
                OggOpusSource::open(path, info, 0.0, played_frames.clone(), finished.clone())?;
            player.append(source);
            Ok(Self {
                _sink: sink,
                player,
                path: path.to_path_buf(),
                info,
                played_frames,
                finished,
                playing: false,
                rate: 1.0,
            })
        }

        fn snapshot(&self) -> PlaybackSnapshot {
            let frames = self.played_frames.load(Ordering::Relaxed);
            let pos = (frames as f64 / f64::from(OPUS_RATE)).min(self.info.duration_sec);
            let is_finished = self.finished.load(Ordering::Acquire) && self.player.empty();
            PlaybackSnapshot {
                ready: self.info.duration_sec > 0.0,
                playing: self.playing && !is_finished,
                finished: is_finished,
                position: pos,
                duration: self.info.duration_sec,
            }
        }

        fn play(&mut self) -> Result<(), AppError> {
            if self.finished.load(Ordering::Acquire) && self.player.empty() {
                self.seek(0.0)?;
            }
            self.playing = true;
            self.player.play();
            Ok(())
        }

        fn pause(&mut self) {
            self.playing = false;
            self.player.pause();
        }

        fn seek(&mut self, seconds: f64) -> Result<(), AppError> {
            if !seconds.is_finite() || seconds < 0.0 {
                return Err(AppError::invalid_input(
                    "Playback position cannot be negative",
                ));
            }
            let target = seconds.min(self.info.duration_sec);
            self.player.clear();
            let source = OggOpusSource::open(
                &self.path,
                self.info,
                target,
                self.played_frames.clone(),
                self.finished.clone(),
            )?;
            self.player.append(source);
            self.player.set_speed(self.rate as f32);
            if self.playing {
                self.player.play();
            } else {
                self.player.pause();
            }
            Ok(())
        }

        fn set_rate(&mut self, rate: f64) -> Result<(), AppError> {
            if !rate.is_finite() || rate <= 0.0 || rate > 8.0 {
                return Err(AppError::invalid_input("Unsupported playback speed"));
            }
            self.rate = rate;
            self.player.set_speed(rate as f32);
            Ok(())
        }
    }

    type SessionEntry = (Box<str>, Arc<Mutex<OpusAudiobookSession>>);
    static NEXT_SESSION: AtomicU32 = AtomicU32::new(1);
    static SESSIONS: LazyLock<Mutex<HashMap<u32, SessionEntry>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    fn next_session_id() -> Result<u32, AppError> {
        let mut current = NEXT_SESSION.load(Ordering::Relaxed);
        loop {
            let next = current
                .checked_add(1)
                .ok_or_else(|| AppError::internal("Audiobook session identifiers are exhausted"))?;
            if NEXT_SESSION
                .compare_exchange_weak(current, next, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
            {
                return Ok(current);
            }
            current = NEXT_SESSION.load(Ordering::Relaxed);
        }
    }

    fn with_session<T>(
        id: u32,
        action: impl FnOnce(&mut OpusAudiobookSession) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let entry = {
            let sessions = SESSIONS
                .lock()
                .map_err(|_| AppError::internal("Opus audiobook player is unavailable"))?;
            sessions
                .get(&id)
                .map(|(_, s)| s.clone())
                .ok_or_else(|| AppError::not_found("Audiobook session is no longer open"))?
        };
        let mut guard = entry
            .lock()
            .map_err(|_| AppError::internal("Opus audiobook session poisoned"))?;
        action(&mut guard)
    }

    pub fn open_for_window(path: String, owner_window: String) -> Result<u32, AppError> {
        let session = OpusAudiobookSession::open(Path::new(&path))?;
        let id = next_session_id()?;
        let mut sessions = SESSIONS
            .lock()
            .map_err(|_| AppError::internal("Opus audiobook player is unavailable"))?;
        if sessions.len() >= MAX_SESSIONS {
            return Err(AppError::internal("Too many audiobook sessions are open"));
        }
        sessions.insert(
            id,
            (owner_window.into_boxed_str(), Arc::new(Mutex::new(session))),
        );
        Ok(id)
    }

    pub fn snapshot(id: u32) -> Result<PlaybackSnapshot, AppError> {
        with_session(id, |s| Ok(s.snapshot()))
    }

    pub fn play(id: u32) -> Result<(), AppError> {
        with_session(id, OpusAudiobookSession::play)
    }

    pub fn pause(id: u32) -> Result<(), AppError> {
        with_session(id, |s| {
            s.pause();
            Ok(())
        })
    }

    pub fn seek(id: u32, seconds: f64) -> Result<(), AppError> {
        with_session(id, |s| s.seek(seconds))
    }

    pub fn set_rate(id: u32, rate: f64) -> Result<(), AppError> {
        with_session(id, |s| s.set_rate(rate))
    }

    pub fn close(id: u32) -> Result<(), AppError> {
        let removed = SESSIONS
            .lock()
            .map_err(|_| AppError::internal("Opus audiobook player is unavailable"))?
            .remove(&id);
        drop(removed);
        Ok(())
    }

    pub fn close_for_window(owner_window: &str) {
        let removed: Vec<SessionEntry> = if let Ok(mut sessions) = SESSIONS.lock() {
            let ids: Vec<u32> = sessions
                .iter()
                .filter_map(|(id, (label, _))| (label.as_ref() == owner_window).then_some(*id))
                .collect();
            ids.into_iter()
                .filter_map(|id| sessions.remove(&id))
                .collect()
        } else {
            Vec::new()
        };
        drop(removed);
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use audiopus::coder::Encoder;
        use audiopus::Application;
        use ogg::{PacketWriteEndInfo, PacketWriter};

        fn build_test_opus_file(duration_frames: usize) -> tempfile::NamedTempFile {
            let file = tempfile::NamedTempFile::new().unwrap();
            let mut writer = PacketWriter::new(file.reopen().unwrap());
            let mut head = b"OpusHead\x01\x01\x38\x01".to_vec(); // pre_skip = 312
            head.extend_from_slice(&48_000u32.to_le_bytes());
            head.extend_from_slice(&[0, 0, 0]);
            writer
                .write_packet(head, 99, PacketWriteEndInfo::EndPage, 0)
                .unwrap();
            writer
                .write_packet(
                    b"OpusTags\x00\x00\x00\x00\x00\x00\x00\x00".to_vec(),
                    99,
                    PacketWriteEndInfo::EndPage,
                    0,
                )
                .unwrap();

            let encoder =
                Encoder::new(SampleRate::Hz48000, Channels::Mono, Application::Audio).unwrap();
            let mut buf = vec![0u8; 4000];
            let pcm: Vec<f32> = (0..960)
                .map(|i| ((i as f32 / 48_000.0) * 440.0 * std::f32::consts::TAU).sin() * 0.2)
                .collect();
            for idx in 0..duration_frames {
                let n = encoder.encode_float(&pcm, &mut buf).unwrap();
                let granule = 312 + ((idx + 1) * 960) as u64;
                let end = if idx + 1 == duration_frames {
                    PacketWriteEndInfo::EndStream
                } else if (idx + 1).is_multiple_of(25) {
                    PacketWriteEndInfo::EndPage
                } else {
                    PacketWriteEndInfo::NormalPacket
                };
                writer
                    .write_packet(buf[..n].to_vec(), 99, end, granule)
                    .unwrap();
            }
            file
        }

        #[test]
        fn parses_duration_decodes_samples_and_seeks_ogg_opus() {
            // 150 frames * 960 samples = 144,000 samples = 3.0 seconds across 6 pages (0.5s per page)
            let file = build_test_opus_file(150);
            let info = parse_opus_stream_info(file.path()).unwrap();
            assert_eq!(info.channels, 1);
            assert_eq!(info.pre_skip, 312);
            assert!(
                (info.duration_sec - 3.0).abs() < 1e-6,
                "duration {}",
                info.duration_sec
            );

            let played = Arc::new(AtomicU64::new(0));
            let finished = Arc::new(AtomicBool::new(false));
            let mut src =
                OggOpusSource::open(file.path(), info, 0.0, played.clone(), finished.clone())
                    .unwrap();
            let samples: Vec<f32> = (&mut src).collect();
            assert!(finished.load(Ordering::Acquire));
            assert!(!samples.is_empty());

            // Seek to 1.5s cleanly across page boundary
            let played2 = Arc::new(AtomicU64::new(0));
            let finished2 = Arc::new(AtomicBool::new(false));
            let mut seek_src =
                OggOpusSource::open(file.path(), info, 1.5, played2.clone(), finished2.clone())
                    .unwrap();
            let remaining: Vec<f32> = (&mut seek_src).collect();
            assert!(
                remaining.len() < samples.len(),
                "remaining {} vs samples {}",
                remaining.len(),
                samples.len()
            );
            assert!(played2.load(Ordering::Relaxed) >= 72_000);
        }
    }
}

#[cfg(target_os = "android")]
mod imp {
    use super::{AppError, PlaybackSnapshot};

    fn unavailable() -> AppError {
        AppError::internal("Native Opus playback is only available on desktop")
    }
    pub fn open_for_window(_: String, _: String) -> Result<u32, AppError> {
        Err(unavailable())
    }
    pub fn snapshot(_: u32) -> Result<PlaybackSnapshot, AppError> {
        Err(unavailable())
    }
    pub fn play(_: u32) -> Result<(), AppError> {
        Err(unavailable())
    }
    pub fn pause(_: u32) -> Result<(), AppError> {
        Err(unavailable())
    }
    pub fn seek(_: u32, _: f64) -> Result<(), AppError> {
        Err(unavailable())
    }
    pub fn set_rate(_: u32, _: f64) -> Result<(), AppError> {
        Err(unavailable())
    }
    pub fn close(_: u32) -> Result<(), AppError> {
        Err(unavailable())
    }
    pub fn close_for_window(_: &str) {}
}

pub use imp::{close, close_for_window, open_for_window, pause, play, seek, set_rate, snapshot};
