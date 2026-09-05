//! Native audio playback for neural TTS output — desktop only.
//!
//! The webview's audio stack proved unreliable for synthesized clips (the
//! AudioContext could stay suspended → silent "playing" state), so playback
//! runs in Rust via rodio (cpal): real output-device audio with pause,
//! resume, seek and position. The frontend drives these commands.

#[cfg(not(target_os = "android"))]
mod imp {
    use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player};
    use std::fs::File;
    use std::io::BufReader;
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    struct NativePlayer {
        /// Keeps the output stream alive; dropping it tears down audio.
        _stream: MixerDeviceSink,
        player: Player,
    }

    static PLAYER: OnceLock<Mutex<Option<NativePlayer>>> = OnceLock::new();

    fn slot() -> &'static Mutex<Option<NativePlayer>> {
        PLAYER.get_or_init(|| Mutex::new(None))
    }

    fn with_player<T>(f: impl FnOnce(&NativePlayer) -> T) -> Result<T, String> {
        let mut guard = slot().lock().map_err(|e| e.to_string())?;
        if guard.is_none() {
            let stream = DeviceSinkBuilder::open_default_sink()
                .map_err(|e| format!("No audio output device: {e}"))?;
            let player = Player::connect_new(stream.mixer());
            *guard = Some(NativePlayer {
                _stream: stream,
                player,
            });
        }
        let p = guard.as_ref().ok_or("player unavailable")?;
        Ok(f(p))
    }

    pub fn play(path: String) -> Result<(), String> {
        let file = File::open(&path).map_err(|e| format!("Cannot open {path}: {e}"))?;
        let source =
            Decoder::new(BufReader::new(file)).map_err(|e| format!("Cannot decode {path}: {e}"))?;
        with_player(|p| {
            p.player.clear();
            p.player.append(source);
            p.player.play();
        })
    }

    pub fn pause() -> Result<(), String> {
        with_player(|p| p.player.pause())
    }

    pub fn resume() -> Result<(), String> {
        with_player(|p| p.player.play())
    }

    pub fn stop() -> Result<(), String> {
        with_player(|p| p.player.stop())
    }

    pub fn seek(seconds: f64) -> Result<(), String> {
        let pos = Duration::from_secs_f64(seconds.max(0.0));
        with_player(|p| {
            p.player
                .try_seek(pos)
                .map_err(|e| format!("Seek failed: {e}"))
        })?
    }

    pub fn position() -> Result<f64, String> {
        with_player(|p| p.player.get_pos().as_secs_f64())
    }

    /// True once nothing is queued or playing (completion detection).
    pub fn finished() -> Result<bool, String> {
        with_player(|p| p.player.empty())
    }
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn tts_audio_play(path: String) -> Result<(), String> {
    imp::play(path)
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
