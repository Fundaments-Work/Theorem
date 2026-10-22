//! Desktop OS-voice plumbing (`say`, Windows `System.Speech`, `spd-say`).
//!
//! Book text is untrusted input, so it never reaches a shell or a script
//! string: macOS/Linux get it as a single argument after `--` (a page starting
//! with `-` must not be read as an option) and Windows reads it from stdin.
//! The speaking process is tracked, so stopping kills *our* narration instead
//! of every `say`/`powershell` on the machine. Argument builders are pure so
//! they are testable on every platform.
//!
//! The tracked process lives exactly as long as the speech (`spd-say -w`
//! waits for speech-dispatcher to finish), so its exit is the real end of the
//! utterance: a watcher reports it as `tts-utterance-done` (or
//! `tts-utterance-error` when the process failed). A process that was stopped
//! or replaced reports nothing.

// Linux only uses the `spd-say` builder; the macOS/Windows halves are compiled
// everywhere so their argument building stays unit-tested on any host.
#![cfg_attr(target_os = "linux", allow(dead_code))]

use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// `say` speaks ~175 words per minute at its default rate.
const MAC_BASE_WPM: f32 = 175.0;

/// How often the watcher checks whether the narration process has exited.
const WATCH_INTERVAL: Duration = Duration::from_millis(50);

fn clamp_speed(speed: Option<f32>) -> f32 {
    match speed {
        Some(s) if s.is_finite() && s > 0.0 => s.clamp(0.25, 4.0),
        _ => 1.0,
    }
}

/// Arguments for `say`: rate, optional voice, then the text after `--`.
pub fn mac_say_args(text: &str, voice: &str, speed: Option<f32>) -> Vec<String> {
    let wpm = (MAC_BASE_WPM * clamp_speed(speed))
        .round()
        .clamp(90.0, 500.0) as i32;
    let mut args = vec!["-r".to_string(), wpm.to_string()];
    if !voice.is_empty() {
        args.push("-v".into());
        args.push(voice.into());
    }
    args.push("--".into());
    args.push(text.into());
    args
}

/// A BCP 47-ish language tag fit for `spd-say -l` (`en`, `pt-BR`, `zh_TW`), or
/// `None` for anything else, so book metadata never becomes an option.
fn spd_language(lang: Option<&str>) -> Option<String> {
    let lang = lang?.trim();
    let primary_len = lang.find(['-', '_']).unwrap_or(lang.len());
    let valid = (2..=3).contains(&primary_len)
        && lang.len() <= 35
        && lang[..primary_len].chars().all(|c| c.is_ascii_alphabetic())
        && lang
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    valid.then(|| lang.replace('_', "-"))
}

/// Arguments for `spd-say`: wait for the end of speech (`-w`, so the process
/// exits when the speech does), the rate (-100 to 100 around 0), the book's
/// language when known, then the text after `--`.
pub fn spd_say_args(text: &str, speed: Option<f32>, lang: Option<&str>) -> Vec<String> {
    let rate = ((clamp_speed(speed) - 1.0) * 100.0)
        .round()
        .clamp(-100.0, 100.0) as i32;
    let mut args = vec!["-w".to_string(), "-r".into(), rate.to_string()];
    if let Some(lang) = spd_language(lang) {
        args.push("-l".into());
        args.push(lang);
    }
    args.push("--".into());
    args.push(text.into());
    args
}

/// `SpeechSynthesizer.Rate` runs from -10 to 10 around 0.
pub fn windows_rate(speed: Option<f32>) -> i32 {
    let s = clamp_speed(speed);
    let rate = if s >= 1.0 {
        (s - 1.0) * 10.0
    } else {
        (s - 1.0) * 20.0
    };
    rate.round().clamp(-10.0, 10.0) as i32
}

/// Constant script: the text comes from stdin and the voice/rate from the
/// environment, so nothing the user or a book supplies is ever parsed as code.
pub const WINDOWS_SPEECH_SCRIPT: &str = "[Console]::InputEncoding=[System.Text.Encoding]::UTF8; \
Add-Type -AssemblyName System.Speech; \
$s=New-Object System.Speech.Synthesis.SpeechSynthesizer; \
$s.Rate=[int]$env:THEOREM_TTS_RATE; \
if($env:THEOREM_TTS_VOICE){try{$s.SelectVoice($env:THEOREM_TTS_VOICE)}catch{}}; \
$s.Speak([Console]::In.ReadToEnd())";

/// How a narration process ended on its own (never reported for one that was
/// stopped or replaced).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpeechEnd {
    /// The process exited successfully: the speech is over.
    Finished,
    /// The process failed (no speech daemon, a script error, …).
    Failed,
}

/// The one narration process this app is running, if any.
pub struct Narration {
    slot: Mutex<Option<(u64, Child)>>,
    next_id: AtomicU64,
}

impl Narration {
    pub const fn new() -> Self {
        Self {
            slot: Mutex::new(None),
            next_id: AtomicU64::new(1),
        }
    }

    /// Stops the tracked narration process, if any. It reports no end.
    pub fn stop(&self) {
        let taken = self.slot.lock().ok().and_then(|mut slot| slot.take());
        if let Some((_, mut child)) = taken {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// Replaces any running narration with `cmd`, optionally feeding it
    /// `stdin_text`. `on_end` runs once, on a watcher thread, when the process
    /// exits by itself; never when it is stopped or replaced first.
    pub fn spawn(
        &'static self,
        mut cmd: Command,
        stdin_text: Option<String>,
        on_end: impl FnOnce(SpeechEnd) + Send + 'static,
    ) -> Result<(), String> {
        self.stop();
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
        cmd.stdin(if stdin_text.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        if let (Some(text), Some(mut stdin)) = (stdin_text, child.stdin.take()) {
            // A long page must not block the IPC thread while the child starts up.
            std::thread::spawn(move || {
                let _ = stdin.write_all(text.as_bytes());
            });
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        match self.slot.lock() {
            Ok(mut slot) => *slot = Some((id, child)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("narration state is unavailable".into());
            }
        }
        std::thread::spawn(move || self.watch(id, on_end));
        Ok(())
    }

    /// Waits for process `id` to exit and reports it, unless it is stopped or
    /// replaced first (then the slot no longer holds `id`).
    fn watch(&self, id: u64, on_end: impl FnOnce(SpeechEnd)) {
        loop {
            std::thread::sleep(WATCH_INTERVAL);
            let end = {
                let Ok(mut slot) = self.slot.lock() else {
                    return;
                };
                let Some((current, child)) = slot.as_mut() else {
                    return;
                };
                if *current != id {
                    return;
                }
                match child.try_wait() {
                    Ok(None) => continue,
                    Ok(Some(status)) if status.success() => SpeechEnd::Finished,
                    Ok(Some(_)) | Err(_) => SpeechEnd::Failed,
                }
            };
            if let Ok(mut slot) = self.slot.lock() {
                if slot.as_ref().is_some_and(|(current, _)| *current == id) {
                    *slot = None;
                }
            }
            on_end(end);
            return;
        }
    }
}

static NARRATION: Narration = Narration::new();

/// Stops the app's narration process, if any.
pub fn stop_tracked() {
    NARRATION.stop();
}

/// Replaces the app's narration with `cmd`; see [`Narration::spawn`].
pub fn spawn_tracked(
    cmd: Command,
    stdin_text: Option<String>,
    on_end: impl FnOnce(SpeechEnd) + Send + 'static,
) -> Result<(), String> {
    NARRATION.spawn(cmd, stdin_text, on_end)
}

/// The event name and payload that report the end of utterance
/// `utterance_id` to the reader (the same events the Android plugin sends).
pub fn utterance_end_event(
    end: SpeechEnd,
    utterance_id: Option<&str>,
) -> (&'static str, serde_json::Value) {
    let name = match end {
        SpeechEnd::Finished => "tts-utterance-done",
        SpeechEnd::Failed => "tts-utterance-error",
    };
    (name, serde_json::json!({ "utteranceId": utterance_id }))
}

/// An `on_end` for [`spawn_tracked`] that emits the utterance's end to the app.
pub fn emit_utterance_end(
    app: tauri::AppHandle,
    utterance_id: Option<String>,
) -> impl FnOnce(SpeechEnd) + Send + 'static {
    move |end| {
        use tauri::Emitter;
        let (name, payload) = utterance_end_event(end, utterance_id.as_deref());
        if let Err(e) = app.emit(name, payload) {
            log::warn!("[tts] Could not report the end of speech: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn text_is_always_after_the_option_terminator() {
        for text in ["-f /etc/passwd", "--version", "plain"] {
            let say = mac_say_args(text, "Samantha", Some(1.0));
            assert_eq!(&say[say.len() - 2..], ["--", text]);
            let spd = spd_say_args(text, None, Some("en"));
            assert_eq!(&spd[spd.len() - 2..], ["--", text]);
        }
    }

    #[test]
    fn mac_voice_is_optional_and_rate_follows_speed() {
        assert_eq!(mac_say_args("hi", "", Some(1.0)), ["-r", "175", "--", "hi"]);
        assert_eq!(
            mac_say_args("hi", "Alex", Some(2.0)),
            ["-r", "350", "-v", "Alex", "--", "hi"]
        );
        assert_eq!(mac_say_args("hi", "", Some(0.1))[1], "90"); // clamped
    }

    #[test]
    fn spd_say_waits_for_the_speech_and_speaks_the_book_language() {
        assert_eq!(
            spd_say_args("hi", Some(1.0), Some("fr")),
            ["-w", "-r", "0", "-l", "fr", "--", "hi"]
        );
        assert_eq!(
            spd_say_args("hi", None, Some("pt_BR")),
            ["-w", "-r", "0", "-l", "pt-BR", "--", "hi"]
        );
        assert_eq!(
            spd_say_args("hi", None, None),
            ["-w", "-r", "0", "--", "hi"]
        );
        // Anything that is not a language tag is dropped, never passed on.
        for bad in [
            "", " ", "-w", "--cancel", "e", "english", "en us", "en;rm", "1a",
        ] {
            assert_eq!(
                spd_say_args("hi", None, Some(bad)),
                ["-w", "-r", "0", "--", "hi"],
                "{bad:?}"
            );
        }
    }

    #[test]
    fn speeds_outside_the_sane_range_or_invalid_fall_back() {
        let rate = |speed| spd_say_args("x", speed, None)[2].clone();
        assert_eq!(rate(Some(f32::NAN)), "0");
        assert_eq!(rate(Some(-3.0)), "0");
        assert_eq!(rate(Some(1.5)), "50");
        assert_eq!(rate(Some(100.0)), "100");
        assert_eq!(windows_rate(Some(2.0)), 10);
        assert_eq!(windows_rate(Some(1.0)), 0);
        assert_eq!(windows_rate(Some(0.5)), -10);
        assert_eq!(windows_rate(None), 0);
    }

    #[test]
    fn windows_script_never_embeds_user_text() {
        assert!(WINDOWS_SPEECH_SCRIPT.contains("[Console]::In.ReadToEnd()"));
        // Voice and rate arrive through the environment, never spliced into the script.
        assert!(WINDOWS_SPEECH_SCRIPT.contains("$env:THEOREM_TTS_VOICE"));
        assert!(WINDOWS_SPEECH_SCRIPT.contains("$env:THEOREM_TTS_RATE"));
        assert!(
            !WINDOWS_SPEECH_SCRIPT.contains('\''),
            "no quoted literals to break out of"
        );
    }

    #[test]
    fn end_events_match_the_android_plugin() {
        let (name, payload) = utterance_end_event(SpeechEnd::Finished, Some("u1"));
        assert_eq!(name, "tts-utterance-done");
        assert_eq!(payload, serde_json::json!({ "utteranceId": "u1" }));
        let (name, payload) = utterance_end_event(SpeechEnd::Failed, None);
        assert_eq!(name, "tts-utterance-error");
        assert_eq!(payload, serde_json::json!({ "utteranceId": null }));
    }

    /// A narration of its own per test, so parallel tests do not replace
    /// each other's process.
    #[cfg(unix)]
    fn narration() -> &'static Narration {
        Box::leak(Box::new(Narration::new()))
    }

    #[cfg(unix)]
    fn sh(script: &str) -> Command {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", script]);
        cmd
    }

    #[cfg(unix)]
    fn end_channel() -> (
        impl FnOnce(SpeechEnd) + Send + 'static,
        mpsc::Receiver<SpeechEnd>,
    ) {
        let (tx, rx) = mpsc::channel();
        (
            move |end| {
                let _ = tx.send(end);
            },
            rx,
        )
    }

    #[cfg(unix)]
    #[test]
    fn the_end_of_the_process_is_the_end_of_speech() {
        let narration = narration();
        let (on_end, ended) = end_channel();
        let started = std::time::Instant::now();
        narration.spawn(sh("sleep 0.3"), None, on_end).unwrap();
        assert_eq!(
            ended.recv_timeout(Duration::from_secs(10)),
            Ok(SpeechEnd::Finished)
        );
        assert!(
            started.elapsed() >= Duration::from_millis(300),
            "reported before the process exited"
        );
        // Reported once.
        assert!(ended.recv_timeout(Duration::from_millis(200)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_process_is_reported_as_an_error() {
        let narration = narration();
        let (on_end, ended) = end_channel();
        narration.spawn(sh("exit 3"), None, on_end).unwrap();
        assert_eq!(
            ended.recv_timeout(Duration::from_secs(10)),
            Ok(SpeechEnd::Failed)
        );
    }

    #[cfg(unix)]
    #[test]
    fn stdin_text_reaches_the_process() {
        let narration = narration();
        let (on_end, ended) = end_channel();
        // Exits 0 only when it read exactly the page text.
        let cmd = sh(r#"read line; [ "$line" = "page text" ]"#);
        narration
            .spawn(cmd, Some("page text\n".into()), on_end)
            .unwrap();
        assert_eq!(
            ended.recv_timeout(Duration::from_secs(10)),
            Ok(SpeechEnd::Finished)
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_stopped_or_replaced_process_reports_nothing() {
        let narration = narration();
        let (stopped_end, stopped) = end_channel();
        narration.spawn(sh("sleep 30"), None, stopped_end).unwrap();
        narration.stop();
        let (replaced_end, replaced) = end_channel();
        narration.spawn(sh("sleep 30"), None, replaced_end).unwrap();
        let (last_end, last) = end_channel();
        narration.spawn(sh("exit 0"), None, last_end).unwrap();
        assert_eq!(
            last.recv_timeout(Duration::from_secs(10)),
            Ok(SpeechEnd::Finished)
        );
        // The watchers of the stopped and the replaced process ended silently
        // (dropping their callback, which closes the channel).
        assert_eq!(
            stopped.recv_timeout(Duration::from_secs(5)),
            Err(mpsc::RecvTimeoutError::Disconnected)
        );
        assert_eq!(
            replaced.recv_timeout(Duration::from_secs(5)),
            Err(mpsc::RecvTimeoutError::Disconnected)
        );
    }

    #[cfg(unix)]
    #[test]
    fn stop_kills_only_the_tracked_process() {
        let narration = narration();
        // An unrelated process with the same program name must survive.
        let mut bystander = Command::new("sleep").arg("30").spawn().unwrap();
        let mut ours = Command::new("sleep");
        ours.arg("30");
        narration.spawn(ours, None, |_| {}).unwrap();
        narration.stop();
        assert!(
            bystander.try_wait().unwrap().is_none(),
            "bystander was killed"
        );
        bystander.kill().unwrap();
        let _ = bystander.wait();
        // Stopping again is a harmless no-op.
        narration.stop();
    }
}
