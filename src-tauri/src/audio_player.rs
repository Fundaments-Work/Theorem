//! Native audio playback for neural TTS output — desktop only.
//!
//! The webview's audio stack proved unreliable for synthesized clips (the
//! AudioContext could stay suspended → silent "playing" state), so playback
//! runs in Rust via rodio (cpal): real output-device audio with pause,
//! resume, seek and position. The frontend drives these commands.
//!
//! Streaming sessions queue one WAV per sentence chunk. rodio's `get_pos()`
//! resets per queued source, so this module tracks per-chunk durations and
//! keeps position/seek absolute over the whole page: the number of finished
//! sources is `appended - queued`, and seek re-queues from the target chunk.

#[derive(serde::Serialize, Clone, Debug)]
pub struct AudioPlayerStatus {
    pub position: f64,
    pub duration: f64,
    pub chunk_index: usize,
    pub finished: bool,
}

#[cfg(not(target_os = "android"))]
mod imp {
    use super::AudioPlayerStatus;
    use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player};
    use std::fs::File;
    use std::io::{BufReader, Read};
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    /// Duration of a synthesized WAV, read from its 44-byte canonical header
    /// (files are written by `supertonic::write_wav` — 16-bit PCM). Returns 0
    /// for anything unparseable; a 0-length chunk only skews mapping slightly.
    fn wav_duration(path: &str) -> f64 {
        let Ok(mut file) = File::open(path) else {
            return 0.0;
        };
        let mut header = [0u8; 44];
        if file.read_exact(&mut header).is_err() {
            return 0.0;
        }
        let channels = u16::from_le_bytes([header[22], header[23]]) as f64;
        let rate = u32::from_le_bytes([header[24], header[25], header[26], header[27]]) as f64;
        let bits = u16::from_le_bytes([header[34], header[35]]) as f64;
        let data_len = file
            .metadata()
            .map(|m| m.len())
            .unwrap_or(0)
            .saturating_sub(44) as f64;
        let bytes_per_frame = (channels * bits / 8.0).max(1.0);
        if rate <= 0.0 {
            return 0.0;
        }
        data_len / bytes_per_frame / rate
    }

    fn open_source(path: &str) -> Result<Decoder<BufReader<File>>, String> {
        let file = File::open(path).map_err(|e| format!("Cannot open {path}: {e}"))?;
        Decoder::new(BufReader::new(file)).map_err(|e| format!("Cannot decode {path}: {e}"))
    }

    struct NativePlayer {
        /// Keeps the output stream alive; dropping it tears down audio.
        _stream: MixerDeviceSink,
        player: Player,
        /// Per-chunk durations in append order; cumulative sums give the
        /// absolute start of each chunk (seek target → chunk index).
        durations: Vec<f64>,
        /// Chunk file paths in append order (seek re-queues from the target).
        paths: Vec<String>,
        paused: bool,
    }

    impl NativePlayer {
        fn total_duration(&self) -> f64 {
            self.durations.iter().sum()
        }

        /// Absolute session position: seconds of fully-played sources plus
        /// the offset inside the current one. Stays linear across queue
        /// underruns (a drained queue reports the end of synthesized audio
        /// instead of resetting to 0 when the next chunk arrives).
        fn absolute_position(&self) -> f64 {
            let total = self.total_duration();
            if self.durations.is_empty() {
                return 0.0;
            }
            if self.player.empty() {
                return total;
            }
            let finished = self.durations.len().saturating_sub(self.player.len());
            let base: f64 = self.durations.iter().take(finished).sum();
            (base + self.player.get_pos().as_secs_f64()).min(total)
        }

        fn chunk_index(&self) -> usize {
            if self.durations.is_empty() || self.player.empty() {
                self.durations.len().saturating_sub(1)
            } else {
                self.durations.len().saturating_sub(self.player.len())
            }
        }
    }

    static PLAYER: OnceLock<Mutex<Option<NativePlayer>>> = OnceLock::new();

    fn slot() -> &'static Mutex<Option<NativePlayer>> {
        PLAYER.get_or_init(|| Mutex::new(None))
    }

    fn with_player<T>(f: impl FnOnce(&mut NativePlayer) -> T) -> Result<T, String> {
        let mut guard = slot().lock().map_err(|e| e.to_string())?;
        if guard.is_none() {
            let stream = DeviceSinkBuilder::open_default_sink()
                .map_err(|e| format!("No audio output device: {e}"))?;
            let player = Player::connect_new(stream.mixer());
            *guard = Some(NativePlayer {
                _stream: stream,
                player,
                durations: Vec::new(),
                paths: Vec::new(),
                paused: false,
            });
        }
        let p = guard.as_mut().ok_or("player unavailable")?;
        Ok(f(p))
    }

    /// Append to the queue without clearing — used for streamed chunks. If
    /// the queue drained while this chunk was still synthesizing (underrun),
    /// appending here is what resumes playback.
    pub fn append(path: String) -> Result<(), String> {
        let duration = wav_duration(&path);
        let source = open_source(&path)?;
        with_player(|p| {
            p.durations.push(duration);
            p.paths.push(path);
            p.player.append(source);
            if !p.paused {
                p.player.play();
            }
        })
    }

    pub fn play(path: String) -> Result<(), String> {
        let duration = wav_duration(&path);
        let source = open_source(&path)?;
        with_player(|p| {
            p.paused = false;
            p.player.clear();
            p.durations.clear();
            p.durations.push(duration);
            p.paths.clear();
            p.paths.push(path);
            p.player.append(source);
            p.player.play();
        })
    }

    pub fn pause() -> Result<(), String> {
        with_player(|p| {
            p.paused = true;
            p.player.pause();
        })
    }

    pub fn resume() -> Result<(), String> {
        with_player(|p| {
            p.paused = false;
            p.player.play();
        })
    }

    pub fn stop() -> Result<(), String> {
        with_player(|p| {
            p.paused = false;
            p.player.clear();
            p.durations.clear();
            p.paths.clear();
        })
    }

    /// Seek to an absolute position within the whole streamed session: clear
    /// the queue and re-queue every chunk from the target onward, then seek
    /// inside the first re-queued source. Preserves pause state.
    pub fn seek(seconds: f64) -> Result<(), String> {
        with_player(|p| {
            if p.durations.is_empty() {
                return Ok(());
            }
            let target = seconds.max(0.0).min(p.total_duration());
            let mut idx = 0;
            let mut chunk_start = 0.0;
            for (i, duration) in p.durations.iter().enumerate() {
                if target < chunk_start + *duration || i == p.durations.len() - 1 {
                    idx = i;
                    break;
                }
                chunk_start += *duration;
            }
            let offset = (target - chunk_start).max(0.0);
            let was_paused = p.paused;
            p.player.clear();
            for path in &p.paths[idx..] {
                let source = open_source(path)?;
                p.player.append(source);
            }
            if was_paused {
                p.player.pause();
            } else {
                p.player.play();
            }
            p.player
                .try_seek(Duration::from_secs_f64(offset))
                .map_err(|e| format!("Seek failed: {e}"))
        })?
    }

    pub fn position() -> Result<f64, String> {
        with_player(|p| p.absolute_position())
    }

    /// True once nothing is queued or playing (completion detection).
    pub fn finished() -> Result<bool, String> {
        with_player(|p| p.player.empty())
    }

    pub fn status() -> Result<AudioPlayerStatus, String> {
        with_player(|p| AudioPlayerStatus {
            position: p.absolute_position(),
            duration: p.total_duration(),
            chunk_index: p.chunk_index(),
            finished: p.player.empty(),
        })
    }
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn tts_audio_status() -> Result<AudioPlayerStatus, String> {
    imp::status()
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn tts_audio_play(path: String) -> Result<(), String> {
    imp::play(path)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn tts_audio_append(path: String) -> Result<(), String> {
    imp::append(path)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn tts_audio_pause() -> Result<(), String> {
    imp::pause()
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn tts_audio_resume() -> Result<(), String> {
    imp::resume()
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn tts_audio_stop() -> Result<(), String> {
    imp::stop()
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn tts_audio_seek(seconds: f64) -> Result<(), String> {
    imp::seek(seconds)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn tts_audio_position() -> Result<f64, String> {
    imp::position()
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn tts_audio_finished() -> Result<bool, String> {
    imp::finished()
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn tts_audio_play(_path: String) -> Result<(), String> {
    Err("Native playback is desktop-only".to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn tts_audio_append(_path: String) -> Result<(), String> {
    Err("Native playback is desktop-only".to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn tts_audio_pause() -> Result<(), String> {
    Err("Native playback is desktop-only".to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn tts_audio_resume() -> Result<(), String> {
    Err("Native playback is desktop-only".to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn tts_audio_stop() -> Result<(), String> {
    Err("Native playback is desktop-only".to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn tts_audio_seek(_seconds: f64) -> Result<(), String> {
    Err("Native playback is desktop-only".to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn tts_audio_position() -> Result<f64, String> {
    Err("Native playback is desktop-only".to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn tts_audio_finished() -> Result<bool, String> {
    Err("Native playback is desktop-only".to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn tts_audio_status() -> Result<AudioPlayerStatus, String> {
    Err("Native playback is desktop-only".to_string())
}
