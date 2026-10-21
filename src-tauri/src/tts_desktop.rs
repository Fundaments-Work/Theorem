//! Desktop OS-voice plumbing (`say`, Windows `System.Speech`, `spd-say`).
//!
//! Book text is untrusted input, so it never reaches a shell or a script
//! string: macOS/Linux get it as a single argument after `--` (a page starting
//! with `-` must not be read as an option) and Windows reads it from stdin.
//! The speaking process is tracked, so stopping kills *our* narration instead
//! of every `say`/`powershell` on the machine. Argument builders are pure so
//! they are testable on every platform.

// Linux only uses the `spd-say` builder; the macOS/Windows halves are compiled
// everywhere so their argument building stays unit-tested on any host.
#![cfg_attr(target_os = "linux", allow(dead_code))]

use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

static CHILD: Mutex<Option<Child>> = Mutex::new(None);

/// `say` speaks ~175 words per minute at its default rate.
const MAC_BASE_WPM: f32 = 175.0;

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

/// Arguments for `spd-say`: its rate runs from -100 to 100 around 0.
pub fn spd_say_args(text: &str, speed: Option<f32>) -> Vec<String> {
    let rate = ((clamp_speed(speed) - 1.0) * 100.0)
        .round()
        .clamp(-100.0, 100.0) as i32;
    vec!["-r".into(), rate.to_string(), "--".into(), text.into()]
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

/// Stops the tracked narration process, if any.
pub fn stop_tracked() {
    if let Ok(mut slot) = CHILD.lock() {
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Replaces any running narration with `cmd`, optionally feeding it `stdin_text`.
pub fn spawn_tracked(mut cmd: Command, stdin_text: Option<String>) -> Result<(), String> {
    stop_tracked();
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
    if let Ok(mut slot) = CHILD.lock() {
        *slot = Some(child);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_always_after_the_option_terminator() {
        for text in ["-f /etc/passwd", "--version", "plain"] {
            let say = mac_say_args(text, "Samantha", Some(1.0));
            assert_eq!(&say[say.len() - 2..], ["--", text]);
            let spd = spd_say_args(text, None);
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
    fn speeds_outside_the_sane_range_or_invalid_fall_back() {
        assert_eq!(spd_say_args("x", Some(f32::NAN))[1], "0");
        assert_eq!(spd_say_args("x", Some(-3.0))[1], "0");
        assert_eq!(spd_say_args("x", Some(1.5))[1], "50");
        assert_eq!(spd_say_args("x", Some(100.0))[1], "100");
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

    #[cfg(unix)]
    #[test]
    fn stop_kills_only_the_tracked_process() {
        // An unrelated process with the same program name must survive.
        let mut bystander = Command::new("sleep").arg("30").spawn().unwrap();
        let mut ours = Command::new("sleep");
        ours.arg("30");
        spawn_tracked(ours, None).unwrap();
        stop_tracked();
        assert!(
            bystander.try_wait().unwrap().is_none(),
            "bystander was killed"
        );
        bystander.kill().unwrap();
        let _ = bystander.wait();
        // Stopping again is a harmless no-op.
        stop_tracked();
    }

    #[cfg(unix)]
    #[test]
    fn spawning_replaces_the_previous_process() {
        let mut first = Command::new("sleep");
        first.arg("30");
        spawn_tracked(first, None).unwrap();
        let mut second = Command::new("sleep");
        second.arg("30");
        spawn_tracked(second, None).unwrap();
        stop_tracked();
    }
}
