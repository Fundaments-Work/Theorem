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
//!
//! Includes pitch-preserving WSOLA time-stretching for clean playback across
//! speeds (0.5x to 3.0x) without the "chipmunk effect".

#[derive(serde::Serialize, Clone, Debug)]
pub struct AudioPlayerStatus {
    pub position: f64,
    pub duration: f64,
    pub chunk_index: usize,
    pub finished: bool,
}

/// Time-stretch mono audio samples using WSOLA (Waveform Similarity Overlap-Add)
/// to preserve pitch perfectly while changing playback speed/duration.
pub fn wsola_stretch_mono(input: &[f32], speed: f32, sample_rate: u32) -> Vec<f32> {
    if (speed - 1.0).abs() < 0.02 || input.is_empty() || speed <= 0.1 {
        return input.to_vec();
    }

    let win_size = (((sample_rate as f32) * 0.025).round() as usize)
        .max(64)
        .min(input.len());
    let hop_size = (win_size / 2).max(1);
    let search_range = (hop_size / 2).max(1);

    if input.len() <= win_size + search_range {
        return input.to_vec();
    }

    let expected_len = ((input.len() as f32) / speed).round() as usize + win_size;
    let mut output = Vec::with_capacity(expected_len);

    let mut prev_tail = input[..win_size].to_vec();
    output.extend_from_slice(&prev_tail[..hop_size]);

    let mut current_input_pos = 0.0f32;

    while (current_input_pos as usize) + win_size + search_range < input.len() {
        current_input_pos += (hop_size as f32) * speed;
        let nominal_pos = current_input_pos.round() as usize;
        let start_search = nominal_pos.saturating_sub(search_range);
        let end_search = (nominal_pos + search_range).min(input.len() - win_size);

        let target_template = &prev_tail[hop_size..win_size];
        let mut best_pos = nominal_pos.min(input.len() - win_size);
        let mut best_score = f32::MIN;

        for pos in start_search..=end_search {
            let candidate = &input[pos..pos + target_template.len()];
            let mut dot = 0.0f32;
            let mut norm = 0.0f32;
            for i in 0..target_template.len() {
                dot += target_template[i] * candidate[i];
                norm += candidate[i] * candidate[i];
            }
            let score = if norm > 1e-6 {
                dot / norm.sqrt()
            } else {
                -dot.abs()
            };
            if score > best_score {
                best_score = score;
                best_pos = pos;
            }
        }

        let best_frame = &input[best_pos..best_pos + win_size];
        for i in 0..hop_size {
            let ramp = (i as f32) / (hop_size as f32);
            let sample = (1.0 - ramp) * prev_tail[hop_size + i] + ramp * best_frame[i];
            output.push(sample);
        }

        prev_tail.copy_from_slice(best_frame);
    }

    if win_size > hop_size {
        output.extend_from_slice(&prev_tail[hop_size..win_size]);
    }

    output
}

/// Time-stretch multi-channel audio samples using WSOLA.
pub fn wsola_stretch(input: &[f32], speed: f32, sample_rate: u32, channels: u16) -> Vec<f32> {
    if (speed - 1.0).abs() < 0.02 || input.is_empty() || speed <= 0.1 {
        return input.to_vec();
    }

    let channels = (channels as usize).max(1);
    if channels == 1 {
        return wsola_stretch_mono(input, speed, sample_rate);
    }

    let num_frames = input.len() / channels;
    if num_frames == 0 {
        return input.to_vec();
    }

    let mut mono = Vec::with_capacity(num_frames);
    for f in 0..num_frames {
        let mut sum = 0.0f32;
        for c in 0..channels {
            sum += input[f * channels + c];
        }
        mono.push(sum / (channels as f32));
    }

    let win_size = (((sample_rate as f32) * 0.025).round() as usize)
        .max(64)
        .min(num_frames);
    let hop_size = (win_size / 2).max(1);
    let search_range = (hop_size / 2).max(1);

    if num_frames <= win_size + search_range {
        return input.to_vec();
    }

    let expected_frames = ((num_frames as f32) / speed).round() as usize + win_size;
    let mut output = Vec::with_capacity(expected_frames * channels);

    for f in 0..hop_size {
        for c in 0..channels {
            output.push(input[f * channels + c]);
        }
    }

    let mut prev_tail = vec![0.0f32; win_size * channels];
    prev_tail.copy_from_slice(&input[..win_size * channels]);

    let mut current_pos = 0.0f32;

    while (current_pos as usize) + win_size + search_range < num_frames {
        current_pos += (hop_size as f32) * speed;
        let nominal_pos = current_pos.round() as usize;
        let start_search = nominal_pos.saturating_sub(search_range);
        let end_search = (nominal_pos + search_range).min(num_frames - win_size);

        let target_template = &mono[hop_size..win_size];
        let mut best_pos = nominal_pos.min(num_frames - win_size);
        let mut best_score = f32::MIN;

        for pos in start_search..=end_search {
            let candidate = &mono[pos..pos + target_template.len()];
            let mut dot = 0.0f32;
            let mut norm = 0.0f32;
            for i in 0..target_template.len() {
                dot += target_template[i] * candidate[i];
                norm += candidate[i] * candidate[i];
            }
            let score = if norm > 1e-6 {
                dot / norm.sqrt()
            } else {
                -dot.abs()
            };
            if score > best_score {
                best_score = score;
                best_pos = pos;
            }
        }

        let best_frame = &input[best_pos * channels..(best_pos + win_size) * channels];
        for i in 0..hop_size {
            let ramp = (i as f32) / (hop_size as f32);
            for c in 0..channels {
                let prev_sample = prev_tail[(hop_size + i) * channels + c];
                let next_sample = best_frame[i * channels + c];
                output.push((1.0 - ramp) * prev_sample + ramp * next_sample);
            }
        }

        prev_tail.copy_from_slice(best_frame);
    }

    if win_size > hop_size {
        for f in hop_size..win_size {
            for c in 0..channels {
                output.push(prev_tail[f * channels + c]);
            }
        }
    }

    output
}

#[cfg(not(target_os = "android"))]
mod imp {
    use super::{wsola_stretch, AudioPlayerStatus};
    use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player, Source};
    use std::fs::File;
    use std::io::{BufReader, Read};
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    pub enum PlayableSource {
        Decoder(Decoder<BufReader<File>>),
        Stretched(rodio::buffer::SamplesBuffer),
    }

    impl Iterator for PlayableSource {
        type Item = f32;
        fn next(&mut self) -> Option<Self::Item> {
            match self {
                Self::Decoder(d) => d.next(),
                Self::Stretched(s) => s.next(),
            }
        }
    }

    impl rodio::Source for PlayableSource {
        fn current_span_len(&self) -> Option<usize> {
            match self {
                Self::Decoder(d) => d.current_span_len(),
                Self::Stretched(s) => s.current_span_len(),
            }
        }
        fn channels(&self) -> std::num::NonZero<u16> {
            match self {
                Self::Decoder(d) => d.channels(),
                Self::Stretched(s) => s.channels(),
            }
        }
        fn sample_rate(&self) -> std::num::NonZero<u32> {
            match self {
                Self::Decoder(d) => d.sample_rate(),
                Self::Stretched(s) => s.sample_rate(),
            }
        }
        fn total_duration(&self) -> Option<Duration> {
            match self {
                Self::Decoder(d) => d.total_duration(),
                Self::Stretched(s) => s.total_duration(),
            }
        }
    }

    /// Duration of a synthesized WAV, read from its 44-byte canonical header.
    fn wav_duration(path: &str, speed: f32) -> f64 {
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
        let raw_duration = data_len / bytes_per_frame / rate;
        if speed > 0.05 {
            raw_duration / (speed as f64)
        } else {
            raw_duration
        }
    }

    fn open_source_with_speed(path: &str, speed: f32) -> Result<PlayableSource, String> {
        let file = File::open(path).map_err(|e| format!("Cannot open {path}: {e}"))?;
        let decoder =
            Decoder::new(BufReader::new(file)).map_err(|e| format!("Cannot decode {path}: {e}"))?;

        if (speed - 1.0).abs() < 0.02 || speed <= 0.1 {
            Ok(PlayableSource::Decoder(decoder))
        } else {
            let channels = decoder.channels();
            let sample_rate = decoder.sample_rate();
            let samples: Vec<f32> = decoder.collect();
            let stretched = wsola_stretch(&samples, speed, sample_rate.get(), channels.get());
            let buf = rodio::buffer::SamplesBuffer::new(channels, sample_rate, stretched);
            Ok(PlayableSource::Stretched(buf))
        }
    }

    struct NativePlayer {
        /// Keeps the output stream alive; dropping it tears down audio.
        _stream: MixerDeviceSink,
        player: Player,
        durations: Vec<f64>,
        paths: Vec<String>,
        paused: bool,
        speed: f32,
        volume: f32,
    }

    impl NativePlayer {
        fn total_duration(&self) -> f64 {
            self.durations.iter().sum()
        }

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
                speed: 1.0,
                volume: 1.0,
            });
        }
        let p = guard.as_mut().ok_or("player unavailable")?;
        Ok(f(p))
    }

    pub fn append(path: String) -> Result<(), String> {
        with_player(|p| {
            let speed = p.speed;
            let duration = wav_duration(&path, speed);
            let source = open_source_with_speed(&path, speed)?;
            p.durations.push(duration);
            p.paths.push(path);
            p.player.append(source);
            if !p.paused {
                p.player.play();
            }
            Ok(())
        })?
    }

    pub fn play(path: String) -> Result<(), String> {
        with_player(|p| {
            let speed = p.speed;
            let duration = wav_duration(&path, speed);
            let source = open_source_with_speed(&path, speed)?;
            p.paused = false;
            p.player.clear();
            p.durations.clear();
            p.durations.push(duration);
            p.paths.clear();
            p.paths.push(path);
            p.player.append(source);
            p.player.play();
            Ok(())
        })?
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
                let source = open_source_with_speed(path, p.speed)?;
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

    pub fn set_speed(speed: f32) -> Result<(), String> {
        with_player(|p| {
            let clamped = speed.clamp(0.25, 4.0);
            p.speed = clamped;
            for (i, path) in p.paths.iter().enumerate() {
                if i < p.durations.len() {
                    p.durations[i] = wav_duration(path, clamped);
                }
            }
            if !p.paths.is_empty() && !p.player.empty() {
                let current_pos = p.absolute_position();
                let _ = seek(current_pos);
            }
            Ok(())
        })?
    }

    pub fn get_speed() -> Result<f32, String> {
        with_player(|p| p.speed)
    }

    pub fn set_volume(volume: f32) -> Result<(), String> {
        with_player(|p| {
            let clamped = volume.clamp(0.0, 2.0);
            p.volume = clamped;
            p.player.set_volume(clamped);
        })
    }

    pub fn get_volume() -> Result<f32, String> {
        with_player(|p| p.volume)
    }

    pub fn position() -> Result<f64, String> {
        with_player(|p| p.absolute_position())
    }

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
pub fn tts_audio_set_speed(speed: f32) -> Result<(), String> {
    imp::set_speed(speed)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn tts_audio_get_speed() -> Result<f32, String> {
    imp::get_speed()
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn tts_audio_set_volume(volume: f32) -> Result<(), String> {
    imp::set_volume(volume)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn tts_audio_get_volume() -> Result<f32, String> {
    imp::get_volume()
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
pub fn tts_audio_set_speed(_speed: f32) -> Result<(), String> {
    Err("Native playback is desktop-only".to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn tts_audio_get_speed() -> Result<f32, String> {
    Err("Native playback is desktop-only".to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn tts_audio_set_volume(_volume: f32) -> Result<(), String> {
    Err("Native playback is desktop-only".to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn tts_audio_get_volume() -> Result<f32, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wsola_identity_at_unit_speed() {
        let sample_rate = 24000;
        let mut input = Vec::with_capacity(sample_rate as usize);
        for i in 0..sample_rate {
            let t = (i as f32) / (sample_rate as f32);
            input.push((t * 440.0 * 2.0 * std::f32::consts::PI).sin());
        }

        let output = wsola_stretch(&input, 1.0, sample_rate, 1);
        assert_eq!(input.len(), output.len());
        assert_eq!(input, output);
    }

    #[test]
    fn test_wsola_stretch_faster_preserves_pitch() {
        let sample_rate = 24000;
        let mut input = Vec::with_capacity(sample_rate as usize);
        for i in 0..sample_rate {
            let t = (i as f32) / (sample_rate as f32);
            input.push((t * 440.0 * 2.0 * std::f32::consts::PI).sin());
        }

        let speed = 1.5;
        let output = wsola_stretch(&input, speed, sample_rate, 1);

        // Duration should be scaled inversely by speed (within 10% boundary)
        let expected_len = (input.len() as f32 / speed).round() as usize;
        let diff = (output.len() as isize - expected_len as isize).abs();
        assert!(
            diff < (sample_rate as isize / 10),
            "Expected len around {expected_len}, got {}",
            output.len()
        );

        // Count zero crossings per second to verify frequency (pitch) is preserved around 440Hz * 2 = 880 crossings/sec
        let mut input_crossings = 0;
        for i in 1..input.len() {
            if (input[i - 1] >= 0.0 && input[i] < 0.0) || (input[i - 1] < 0.0 && input[i] >= 0.0) {
                input_crossings += 1;
            }
        }
        let input_rate = (input_crossings as f32) / (input.len() as f32 / sample_rate as f32);

        let mut output_crossings = 0;
        for i in 1..output.len() {
            if (output[i - 1] >= 0.0 && output[i] < 0.0)
                || (output[i - 1] < 0.0 && output[i] >= 0.0)
            {
                output_crossings += 1;
            }
        }
        let output_rate = (output_crossings as f32) / (output.len() as f32 / sample_rate as f32);

        // The frequency / zero-crossing rate should be within 5% of original (pitch preserved!)
        assert!(
            (input_rate - output_rate).abs() / input_rate < 0.05,
            "Input crossing rate {input_rate} vs output {output_rate} diverged by > 5%"
        );
    }

    #[test]
    fn test_wsola_stretch_slower() {
        let sample_rate = 24000;
        let mut input = Vec::with_capacity(sample_rate as usize / 2);
        for i in 0..(sample_rate / 2) {
            let t = (i as f32) / (sample_rate as f32);
            input.push((t * 220.0 * 2.0 * std::f32::consts::PI).sin());
        }

        let speed = 0.8;
        let output = wsola_stretch(&input, speed, sample_rate, 1);
        assert!(output.len() > input.len());
    }

    #[test]
    fn test_wsola_stereo_stretch() {
        let sample_rate = 24000;
        let frames = sample_rate as usize / 2;
        let mut input = Vec::with_capacity(frames * 2);
        for i in 0..frames {
            let t = (i as f32) / (sample_rate as f32);
            input.push((t * 440.0 * 2.0 * std::f32::consts::PI).sin()); // Left
            input.push((t * 880.0 * 2.0 * std::f32::consts::PI).sin()); // Right
        }

        let speed = 1.25;
        let output = wsola_stretch(&input, speed, sample_rate, 2);
        assert_eq!(output.len() % 2, 0, "Stereo output must have even length");
        assert!(output.len() < input.len());
    }
}
