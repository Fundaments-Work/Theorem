//! Linux audiobook playback through GStreamer without copying audio into the webview.

use crate::error::AppError;

/// Values observed from the playback pipeline, in seconds.
#[derive(Clone, Copy, Debug, serde::Serialize)]
pub struct PlaybackSnapshot {
    pub ready: bool,
    pub playing: bool,
    pub finished: bool,
    pub position: f64,
    pub duration: f64,
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{AppError, PlaybackSnapshot};
    use gst::prelude::*;
    use gstreamer as gst;
    use std::path::Path;

    /// A single streaming playback pipeline. Dropping it releases the file and sink.
    pub struct LinuxAudiobook {
        pipeline: gst::Element,
        finished: bool,
        rate: f64,
        pending_position: Option<gst::ClockTime>,
        last_position: gst::ClockTime,
    }

    impl LinuxAudiobook {
        pub fn open(path: &Path) -> Result<Self, AppError> {
            Self::open_with_sink(path, None)
        }

        fn open_with_sink(path: &Path, sink: Option<&gst::Element>) -> Result<Self, AppError> {
            gst::init()
                .map_err(|error| AppError::internal(format!("Cannot initialize audio: {error}")))?;
            let path = path.canonicalize().map_err(|error| {
                let message = format!("Cannot open audiobook: {error}");
                if error.kind() == std::io::ErrorKind::NotFound {
                    AppError::not_found(message)
                } else {
                    AppError::io(message)
                }
            })?;
            if !path.is_file() {
                return Err(AppError::invalid_input("The audiobook is not a file"));
            }
            let uri = url::Url::from_file_path(&path).map_err(|_| {
                AppError::invalid_input("The audiobook path cannot be converted to a file URI")
            })?;
            let pipeline = gst::ElementFactory::make("playbin")
                .property("uri", uri.as_str())
                .build()
                .map_err(|error| {
                    AppError::internal(format!("Cannot create audio player: {error}"))
                })?;
            if let Some(sink) = sink {
                pipeline.set_property("audio-sink", sink);
            }
            if let Ok(tempo) = gst::ElementFactory::make("scaletempo").build() {
                pipeline.set_property("audio-filter", tempo);
            }
            pipeline
                .set_state(gst::State::Paused)
                .map_err(|error| AppError::io(format!("Cannot load audiobook: {error}")))?;
            Ok(Self {
                pipeline,
                finished: false,
                rate: 1.0,
                pending_position: None,
                last_position: gst::ClockTime::ZERO,
            })
        }

        fn drain_messages(&mut self) -> Result<(), AppError> {
            let bus = self
                .pipeline
                .bus()
                .ok_or_else(|| AppError::internal("Audio player has no message bus"))?;
            while let Some(message) = bus.pop() {
                match message.view() {
                    gst::MessageView::Error(error) => {
                        return Err(AppError::io(format!(
                            "Audiobook playback failed: {}",
                            error.error()
                        )))
                    }
                    gst::MessageView::Eos(..) => self.finished = true,
                    _ => {}
                }
            }
            Ok(())
        }

        fn position(&mut self) -> Result<gst::ClockTime, AppError> {
            let (change, _, _) = self.pipeline.state(gst::ClockTime::ZERO);
            let change =
                change.map_err(|error| AppError::io(format!("Cannot query audiobook: {error}")))?;
            if change == gst::StateChangeSuccess::Async {
                return Ok(self.pending_position.unwrap_or(self.last_position));
            }
            if let Some(position) = self.pipeline.query_position::<gst::ClockTime>() {
                self.last_position = position;
                self.pending_position = None;
            }
            Ok(self.pending_position.unwrap_or(self.last_position))
        }

        pub fn snapshot(&mut self) -> Result<PlaybackSnapshot, AppError> {
            self.drain_messages()?;
            let duration = self.pipeline.query_duration::<gst::ClockTime>();
            let position = self.position()?;
            Ok(PlaybackSnapshot {
                ready: duration.is_some(),
                playing: self.pipeline.current_state() == gst::State::Playing && !self.finished,
                finished: self.finished,
                position: position.nseconds() as f64 / 1_000_000_000.0,
                duration: duration.map_or(0.0, |time| time.nseconds() as f64 / 1_000_000_000.0),
            })
        }

        pub fn play(&mut self) -> Result<(), AppError> {
            self.drain_messages()?;
            if self.finished {
                self.seek(0.0)?;
            }
            self.pipeline
                .set_state(gst::State::Playing)
                .map_err(|error| AppError::io(format!("Cannot play audiobook: {error}")))?;
            self.finished = false;
            Ok(())
        }

        pub fn pause(&mut self) -> Result<(), AppError> {
            self.drain_messages()?;
            self.pipeline
                .set_state(gst::State::Paused)
                .map_err(|error| AppError::io(format!("Cannot pause audiobook: {error}")))?;
            Ok(())
        }

        pub fn seek(&mut self, seconds: f64) -> Result<(), AppError> {
            if !seconds.is_finite() || seconds < 0.0 || seconds > u64::MAX as f64 / 1_000_000_000.0
            {
                return Err(AppError::invalid_input("Invalid audiobook position"));
            }
            let nanoseconds = (seconds * 1_000_000_000.0) as u64;
            if nanoseconds == u64::MAX {
                return Err(AppError::invalid_input("Invalid audiobook position"));
            }
            let position = gst::ClockTime::from_nseconds(nanoseconds);
            self.pipeline
                .seek(
                    self.rate,
                    gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE,
                    gst::SeekType::Set,
                    position,
                    gst::SeekType::None,
                    gst::ClockTime::NONE,
                )
                .map_err(|error| AppError::io(format!("Cannot seek audiobook: {error}")))?;
            self.finished = false;
            self.pending_position = Some(position);
            Ok(())
        }

        pub fn set_rate(&mut self, rate: f64) -> Result<(), AppError> {
            if !rate.is_finite() || !(0.25..=4.0).contains(&rate) {
                return Err(AppError::invalid_input("Invalid audiobook playback speed"));
            }
            let position = self.position()?;
            self.pipeline
                .seek(
                    rate,
                    gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE,
                    gst::SeekType::Set,
                    position,
                    gst::SeekType::None,
                    gst::ClockTime::NONE,
                )
                .map_err(|error| AppError::io(format!("Cannot change audiobook speed: {error}")))?;
            self.rate = rate;
            self.pending_position = Some(position);
            Ok(())
        }
    }

    impl Drop for LinuxAudiobook {
        fn drop(&mut self) {
            let _ = self.pipeline.set_state(gst::State::Null);
        }
    }

    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Mutex, OnceLock};

    static NEXT_SESSION: AtomicU32 = AtomicU32::new(1);
    static SESSIONS: OnceLock<Mutex<HashMap<u32, LinuxAudiobook>>> = OnceLock::new();

    fn sessions() -> &'static Mutex<HashMap<u32, LinuxAudiobook>> {
        SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub fn open(path: String) -> Result<u32, AppError> {
        let player = LinuxAudiobook::open(Path::new(&path))?;
        let id = NEXT_SESSION
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .map_err(|_| AppError::internal("Audiobook session identifiers are exhausted"))?;
        let mut sessions = sessions()
            .lock()
            .map_err(|_| AppError::internal("Audiobook player is unavailable"))?;
        if sessions.len() >= 32 {
            return Err(AppError::internal("Too many audiobook sessions are open"));
        }
        sessions.insert(id, player);
        Ok(id)
    }

    fn with_player<T>(
        id: u32,
        action: impl FnOnce(&mut LinuxAudiobook) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let mut sessions = sessions()
            .lock()
            .map_err(|_| AppError::internal("Audiobook player is unavailable"))?;
        let player = sessions
            .get_mut(&id)
            .ok_or_else(|| AppError::not_found("Audiobook session is no longer open"))?;
        action(player)
    }

    pub fn snapshot(id: u32) -> Result<PlaybackSnapshot, AppError> {
        with_player(id, LinuxAudiobook::snapshot)
    }
    pub fn play(id: u32) -> Result<(), AppError> {
        with_player(id, LinuxAudiobook::play)
    }
    pub fn pause(id: u32) -> Result<(), AppError> {
        with_player(id, LinuxAudiobook::pause)
    }
    pub fn seek(id: u32, seconds: f64) -> Result<(), AppError> {
        with_player(id, |player| player.seek(seconds))
    }
    pub fn set_rate(id: u32, rate: f64) -> Result<(), AppError> {
        with_player(id, |player| player.set_rate(rate))
    }
    pub fn close(id: u32) -> Result<(), AppError> {
        let player = sessions()
            .lock()
            .map_err(|_| AppError::internal("Audiobook player is unavailable"))?
            .remove(&id);
        drop(player);
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::io::Write;

        fn player_with(bytes: &[u8]) -> (LinuxAudiobook, tempfile::NamedTempFile) {
            gst::init().unwrap();
            let sink = gst::ElementFactory::make("fakesink")
                .property("sync", true)
                .build()
                .unwrap();
            let mut file = tempfile::NamedTempFile::new().unwrap();
            file.write_all(bytes).unwrap();
            let player = LinuxAudiobook::open_with_sink(file.path(), Some(&sink)).unwrap();
            let (state, _, _) = player.pipeline.state(gst::ClockTime::from_seconds(5));
            state.unwrap();
            (player, file)
        }

        fn player() -> (LinuxAudiobook, tempfile::NamedTempFile) {
            player_with(include_bytes!("../../tests/fixtures/audio/narration.mp3"))
        }

        #[test]
        fn streams_and_seeks_an_attached_mp3() {
            let (mut player, _file) = player();
            let initial = player.snapshot().unwrap();
            assert!(initial.ready && initial.duration >= 2.0);
            player.seek(1.0).unwrap();
            player.set_rate(1.25).unwrap();
            player.play().unwrap();
            let (state, _, _) = player.pipeline.state(gst::ClockTime::from_seconds(5));
            state.unwrap();
            let playing = player.snapshot().unwrap();
            assert!(playing.playing && playing.position >= 0.9);
            player.pause().unwrap();
        }

        #[test]
        fn opens_aac_mp4_and_generated_opus() {
            for bytes in [
                &include_bytes!("../../tests/fixtures/audio/narration.m4a")[..],
                &include_bytes!("../../tests/fixtures/audio/narration.ogg")[..],
            ] {
                let (mut player, _file) = player_with(bytes);
                let snapshot = player.snapshot().unwrap();
                assert!(snapshot.ready && snapshot.duration >= 2.0);
                player.seek(1.0).unwrap();
                player.play().unwrap();
            }
        }

        #[test]
        fn rejects_invalid_positions_and_rates() {
            let (mut player, _file) = player();
            assert!(player.seek(f64::NAN).is_err());
            assert!(player.seek(-1.0).is_err());
            assert!(player.seek(f64::INFINITY).is_err());
            assert!(player.seek(u64::MAX as f64 / 1_000_000_000.0).is_err());
            assert!(player.set_rate(f64::INFINITY).is_err());
            assert!(player.set_rate(f64::NAN).is_err());
            assert!(player.set_rate(0.0).is_err());
            assert!(player.set_rate(4.01).is_err());
        }

        #[test]
        fn opens_a_file_with_uri_delimiters_in_its_name() {
            gst::init().unwrap();
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("narration #1?.mp3");
            std::fs::write(
                &path,
                include_bytes!("../../tests/fixtures/audio/narration.mp3"),
            )
            .unwrap();
            let sink = gst::ElementFactory::make("fakesink").build().unwrap();
            let mut player = LinuxAudiobook::open_with_sink(&path, Some(&sink)).unwrap();
            let (state, _, _) = player.pipeline.state(gst::ClockTime::from_seconds(5));
            state.unwrap();
            assert!(player.snapshot().unwrap().ready);
        }

        #[test]
        fn closing_a_missing_session_is_safe_and_commands_report_it_missing() {
            assert!(play(u32::MAX).is_err());
            close(u32::MAX).unwrap();
            close(u32::MAX).unwrap();
        }

        #[test]
        fn rejects_a_missing_file() {
            let directory = tempfile::tempdir().unwrap();
            let error = match LinuxAudiobook::open(&directory.path().join("missing.mp3")) {
                Ok(_) => panic!("missing file unexpectedly opened"),
                Err(error) => error,
            };
            assert_eq!(error.kind(), crate::error::ErrorKind::NotFound);
        }

        #[test]
        fn changing_speed_immediately_after_a_backward_seek_keeps_the_new_position() {
            let (mut player, _file) = player();
            player.seek(2.0).unwrap();
            player.play().unwrap();
            let (state, _, _) = player.pipeline.state(gst::ClockTime::from_seconds(5));
            state.unwrap();
            player.pause().unwrap();
            let (state, _, _) = player.pipeline.state(gst::ClockTime::from_seconds(5));
            state.unwrap();
            player.seek(0.0).unwrap();
            player.set_rate(1.5).unwrap();
            player.play().unwrap();
            let (state, _, _) = player.pipeline.state(gst::ClockTime::from_seconds(5));
            state.unwrap();
            assert!(player.snapshot().unwrap().position < 1.0);
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod imp {
    use super::{AppError, PlaybackSnapshot};
    fn unavailable() -> AppError {
        AppError::invalid_input("Native audiobook playback is unavailable on this platform")
    }
    pub fn open(_: String) -> Result<u32, AppError> {
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
}

pub use imp::{close, open, pause, play, seek, set_rate, snapshot};
